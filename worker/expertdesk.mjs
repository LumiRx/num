/**
 * NUM · the paperwork desk — where a person accepts an NDA and a W-9.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `review()` in expertdocs.mjs has been there since the docs shipped, and
 * nothing could reach it: the endpoint was admin-gated with the arguments
 * reversed (see worker/adminargs.test.mjs), and even once that was fixed there
 * was no way to LIST what was waiting and no way to LOOK at the uploaded form.
 * An accept button with nothing to accept and no document to read is not a
 * review flow.
 *
 * So: a queue, a viewer, and two buttons. Nothing else. This is the last thing
 * standing between an Expert who has done the work and an Expert who can be
 * paid, and on 18 Sep 2026 it had two real people waiting in it.
 *
 * ── THE FILE HAS SOMEBODY'S SSN IN IT ─────────────────────────────────────
 *
 * receiveW9 puts the bytes in object storage under an unguessable key and
 * writes only that key to the database, with a comment saying never to put a
 * URL there because a URL gets pasted into a browser. This file honours that:
 *
 *   · the bytes are streamed through an admin-gated endpoint, never redirected
 *     to and never signed into a shareable link;
 *   · the object key is never sent to the browser, so what the page holds is a
 *     scout id and nothing that survives being copied out of it;
 *   · every response here is no-store, so it does not sit in a disk cache on
 *     whatever laptop did the review;
 *   · Content-Disposition is inline with a boring filename, and the type is
 *     re-asserted from the allow-list rather than echoed from the upload.
 */
import { isAdmin } from './console.mjs';
import { ALLOWED_TYPES } from './expertdocs.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const H = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Everyone with paperwork that is not finished, newest first.
 *
 * Deliberately shows accepted rows too, greyed out on the page: a desk that
 * only shows work makes it impossible to confirm you did any.
 */
export async function queue(env) {
  const { results = [] } = await env.DB.prepare(
    `SELECT s.id, s.name, s.code, s.email, s.country, s.created_at,
            n.state AS nda_state, n.signed_name, n.signed_at, n.reject_reason AS nda_reason,
            w.state AS w9_state, w.uploaded_at, w.content_type, w.bytes,
            w.reject_reason AS w9_reason,
            (SELECT COUNT(*) FROM num_scout_places p
              WHERE p.scout_id = s.id AND p.state <> 'void') AS introduced
       FROM num_scouts s
       LEFT JOIN num_expert_docs n ON n.scout_id = s.id AND n.kind = 'nda'
       LEFT JOIN num_expert_docs w ON w.scout_id = s.id AND w.kind = 'w9'
      WHERE s.status = 'active'
        AND (n.id IS NOT NULL OR w.id IS NOT NULL)
      ORDER BY s.created_at DESC LIMIT 200`,
  ).all().catch(() => ({ results: [] }));

  const waiting = results.filter(
    (r) => r.nda_state === 'signed' || r.w9_state === 'uploaded',
  ).length;

  return { ok: true, waiting, people: results };
}

/**
 * Stream the uploaded W-9 to the reviewer.
 *
 * Takes a scout id, not an object key — the key never leaves the worker, so
 * nothing the page can copy is a durable handle on a tax form.
 */
export async function serveW9(env, scoutId) {
  const row = await env.DB.prepare(
    "SELECT object_key, content_type FROM num_expert_docs WHERE scout_id=?1 AND kind='w9'",
  ).bind(scoutId).first().catch(() => null);
  if (!row?.object_key) return json({ error: 'no form on file' }, 404);
  if (!env.PHOTOS) return json({ error: 'uploads are not configured' }, 503);

  const obj = await env.PHOTOS.get(row.object_key);
  if (!obj) return json({ error: 'the file is missing from storage' }, 404);

  // Re-asserted from the allow-list rather than trusted from the row: a
  // content type that came in with the upload is attacker-controlled, and
  // text/html here would run in the reviewer's session.
  const type = ALLOWED_TYPES.includes(row.content_type) ? row.content_type : 'application/octet-stream';

  return new Response(obj.body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': 'inline; filename="w9.pdf"',
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      // The reviewer's browser should not be talked into rendering this
      // anywhere but here.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; object-src 'none'; sandbox",
    },
  });
}

const WORD = Object.freeze({
  pending: 'waiting on them',
  signed: 'SIGNED — needs you',
  uploaded: 'UPLOADED — needs you',
  accepted: 'accepted',
  rejected: 'rejected',
});

function row(p) {
  const needs = p.nda_state === 'signed' || p.w9_state === 'uploaded';
  const cls = needs ? 'card need' : 'card';
  const w9 = p.w9_state
    ? `<div class="doc">
         <b>W-9</b> <span class="st ${p.w9_state}">${H(WORD[p.w9_state] ?? p.w9_state)}</span>
         ${p.w9_reason ? `<div class="why">${H(p.w9_reason)}</div>` : ''}
         ${p.w9_state === 'uploaded' || p.w9_state === 'accepted'
    ? `<div class="actions">
                <a class="btn ghost" href="/api/expert-docs/file?scout=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Open the form</a>
                ${p.w9_state === 'uploaded'
      ? `<button class="btn" data-act data-scout="${H(p.id)}" data-kind="w9" data-ok="1">Accept</button>
                     <button class="btn warn" data-act data-scout="${H(p.id)}" data-kind="w9">Reject</button>` : ''}
              </div>` : ''}
       </div>`
    : '<div class="doc"><b>W-9</b> <span class="st">not started</span></div>';

  const nda = p.nda_state
    ? `<div class="doc">
         <b>NDA</b> <span class="st ${p.nda_state}">${H(WORD[p.nda_state] ?? p.nda_state)}</span>
         ${p.signed_name ? `<div class="why">signed “${H(p.signed_name)}” · ${H(String(p.signed_at ?? '').slice(0, 16))}</div>` : ''}
         ${p.nda_reason ? `<div class="why">${H(p.nda_reason)}</div>` : ''}
         ${p.nda_state === 'signed'
    ? `<div class="actions">
                <button class="btn" data-act data-scout="${H(p.id)}" data-kind="nda" data-ok="1">Accept</button>
                <button class="btn warn" data-act data-scout="${H(p.id)}" data-kind="nda">Reject</button>
              </div>` : ''}
       </div>`
    : '<div class="doc"><b>NDA</b> <span class="st">not started</span></div>';

  return `<div class="${cls}">
    <div class="who">
      <b>${H(p.name)}</b> <span class="code">${H(p.code)}</span>
      <div class="meta">${H(p.email)} · ${H(p.country ?? '—')} · ${p.introduced} introduced</div>
    </div>
    ${nda}
    ${w9}
  </div>`;
}

export function deskPage(q) {
  const cards = q.people.length
    ? q.people.map(row).join('')
    : '<p class="empty">Nobody has started their paperwork yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Expert paperwork</title>
<style>
:root{--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e3e0d8;--mute:#6a7570;--warn:#8a3a2a}
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
 color:var(--ink);background:#f6f5f0;padding:24px 16px 60px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:23px;font-weight:800;color:var(--pine);letter-spacing:-.02em}
.lede{color:var(--mute);margin-top:6px;font-size:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:15px 16px;margin-top:14px}
.card.need{border-color:var(--green);box-shadow:0 0 0 3px rgba(30,122,77,.08)}
.who b{font-size:16px}
.code{font-weight:800;letter-spacing:.1em;color:var(--green);font-size:13px;margin-left:6px}
.meta{color:var(--mute);font-size:12.5px;margin-top:2px}
.doc{border-top:1px solid var(--line);margin-top:11px;padding-top:10px}
.doc b{font-size:13px}
.st{font-size:12px;color:var(--mute);margin-left:6px}
.st.signed,.st.uploaded{color:var(--green);font-weight:800}
.st.rejected{color:var(--warn);font-weight:700}
.why{color:var(--mute);font-size:12.5px;margin-top:3px}
.actions{margin-top:9px;display:flex;gap:8px;flex-wrap:wrap}
.btn{min-height:44px;padding:0 15px;border:0;border-radius:9px;background:var(--green);color:#fff;
 font:700 13px/44px inherit;cursor:pointer;text-decoration:none;display:inline-block}
.btn.ghost{background:#eceae3;color:var(--pine)}
.btn.warn{background:var(--warn)}
.empty{color:var(--mute);margin-top:18px}
.note{margin-top:22px;color:var(--mute);font-size:12.5px;border-top:1px solid var(--line);padding-top:12px}
.err{color:var(--warn);font-weight:700;margin-top:12px}
</style></head><body><div class="wrap">
<h1>Expert paperwork</h1>
<p class="lede">${q.waiting
    ? `${q.waiting} ${q.waiting === 1 ? 'packet needs' : 'packets need'} you. Earnings accrue while this is outstanding — nothing is lost — but nobody can be PAID until both documents are accepted.`
    : 'Nothing is waiting. Earnings become payable as soon as both documents are accepted.'}</p>
<div id="err" class="err" hidden></div>
${cards}
<p class="note">The W-9 has someone's SSN on it. It is streamed through this page and never given a shareable link, so do not save a copy anywhere else.</p>
</div>
<script>
document.querySelectorAll('[data-act]').forEach(function (b) {
  b.addEventListener('click', function () {
    var accept = b.dataset.ok === '1';
    var reason = null;
    if (!accept) {
      // A rejection with no reason is a person told "no" and left guessing.
      reason = window.prompt('Why is it being rejected? They will see this.');
      if (!reason) return;
    }
    b.disabled = true;
    fetch('/api/expert-docs/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ scout_id: b.dataset.scout, kind: b.dataset.kind, accept: accept, reason: reason })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j.ok) {
          b.disabled = false;
          var e = document.getElementById('err');
          e.textContent = (res.j && (res.j.why || res.j.error)) || 'That did not go through.';
          e.hidden = false;
          return;
        }
        location.reload();
      })
      .catch(function () { b.disabled = false; });
  });
});
</script>
</body></html>`;
}

/** Routes `/queue`, `/file` and `/desk`. Every one of them admin-only. */
export async function handleDesk(request, env, p) {
  // (env, request). See worker/adminargs.test.mjs for why that order is
  // written out rather than left to memory.
  if (!await isAdmin(env, request)) {
    return p === '/desk'
      ? new Response('<p style="font:15px system-ui;padding:24px">Sign in to the ops console first.</p>', {
        status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
      : json({ error: 'not allowed' }, 403);
  }

  if (p === '/queue') return json(await queue(env));

  if (p === '/file') {
    const scoutId = new URL(request.url).searchParams.get('scout');
    if (!scoutId) return json({ error: 'which Expert?' }, 400);
    return serveW9(env, scoutId);
  }

  return new Response(deskPage(await queue(env)), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
