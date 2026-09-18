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
 * ── HOW IT AUTHENTICATES, AND WHY IT IS BUILT THIS WAY ────────────────────
 *
 * The ops console at app.itsnum.com/ops/ keeps its session in sessionStorage
 * under `num_ops` and sends it as an `X-Admin-Session` header. It never sets
 * the `num_ops_session` cookie.
 *
 * So a page that expected a cookie was unreachable: typing this URL into a
 * browser sends no header and no cookie, and every navigation would have been
 * a 403 — a review desk nobody can open. The first version of this file had
 * exactly that bug, found before anybody tried to use it.
 *
 * The shell below therefore carries NO DATA and needs no auth to fetch. Every
 * byte that matters arrives through /queue and /file, which are admin-only and
 * called from JavaScript that can set the header. Same origin as /ops/, so the
 * session in sessionStorage is already there.
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
 *   · the form is fetched with the header and shown from a blob URL, which
 *     belongs to that one document and dies with the tab — better than an
 *     <img src> could have been, which is the one good thing to come out of
 *     the cookie mistake;
 *   · every response is no-store, so nothing sits in a disk cache afterwards;
 *   · the content type is re-asserted from the allow-list rather than echoed
 *     from the upload, because text/html here would run in the session.
 */
import { isAdmin } from './console.mjs';
import { ALLOWED_TYPES } from './expertdocs.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * Everyone with paperwork that is not finished, newest first.
 *
 * Shows accepted rows too, so it is possible to confirm you did the work.
 */
export async function queue(env) {
  const { results = [] } = await env.DB.prepare(
    `SELECT s.id, s.name, s.code, s.email, s.country,
            n.state AS nda_state, n.signed_name, n.signed_at, n.reject_reason AS nda_reason,
            w.state AS w9_state, w.uploaded_at, w.bytes, w.reject_reason AS w9_reason,
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

  const type = ALLOWED_TYPES.includes(row.content_type) ? row.content_type : 'application/octet-stream';

  return new Response(obj.body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': 'inline; filename="w9"',
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; object-src 'none'; sandbox",
    },
  });
}

/**
 * The shell. No data, no auth — everything real is fetched with the header.
 *
 * Kept as a constant string rather than templated from the queue, because the
 * moment this function takes data it becomes a page that must be
 * authenticated, and that is the mistake this file already made once.
 */
export function deskShell() {
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
.btn[disabled]{opacity:.5;cursor:default}
.msg{margin-top:18px;color:var(--mute)}
.msg.bad{color:var(--warn);font-weight:700}
.note{margin-top:22px;color:var(--mute);font-size:12.5px;border-top:1px solid var(--line);padding-top:12px}
a{color:var(--green)}
</style></head><body><div class="wrap">
<h1>Expert paperwork</h1>
<p class="lede" id="lede">Reading the queue&hellip;</p>
<div id="list"></div>
<p class="note">The W-9 has someone&rsquo;s SSN on it. It is fetched into this tab only and never given a
shareable link, so do not save a copy anywhere else.</p>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var H = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };

  // Same origin as /ops/, so its session is already here. Nothing on this page
  // works without it, and that is the point: the shell carries no data.
  var token = null;
  try { token = sessionStorage.getItem('num_ops'); } catch (e) { token = null; }

  function auth(extra) {
    var h = extra || {};
    h['X-Admin-Session'] = token;
    return h;
  }

  function fail(msg) { $('lede').className = 'lede msg bad'; $('lede').textContent = msg; }

  if (!token) {
    $('lede').className = 'lede msg bad';
    $('lede').innerHTML = 'Sign in at <a href="/ops/">NUM Ops</a> first, then reload this page. '
      + 'That session lives in this browser tab group, so it has to be the same browser.';
    return;
  }

  var WORD = { pending: 'waiting on them', signed: 'SIGNED \\u2014 needs you',
    uploaded: 'UPLOADED \\u2014 needs you', accepted: 'accepted', rejected: 'rejected' };

  function docBlock(p, kind, state, reason, extraHtml) {
    var label = kind === 'nda' ? 'NDA' : 'W-9';
    if (!state) return '<div class="doc"><b>' + label + '</b> <span class="st">not started</span></div>';
    var acts = '';
    if (kind === 'w9' && (state === 'uploaded' || state === 'accepted')) {
      acts += '<button class="btn ghost" data-open="' + H(p.id) + '">Open the form</button>';
    }
    if (state === 'signed' || state === 'uploaded') {
      acts += '<button class="btn" data-act data-scout="' + H(p.id) + '" data-kind="' + kind + '" data-ok="1">Accept</button>'
        + '<button class="btn warn" data-act data-scout="' + H(p.id) + '" data-kind="' + kind + '">Reject</button>';
    }
    return '<div class="doc"><b>' + label + '</b> <span class="st ' + H(state) + '">' + H(WORD[state] || state) + '</span>'
      + (extraHtml || '')
      + (reason ? '<div class="why">' + H(reason) + '</div>' : '')
      + (acts ? '<div class="actions">' + acts + '</div>' : '')
      + '</div>';
  }

  function render(q) {
    $('lede').className = 'lede';
    $('lede').textContent = q.waiting
      ? q.waiting + (q.waiting === 1 ? ' packet needs' : ' packets need') + ' you. Earnings accrue while this is '
        + 'outstanding \\u2014 nothing is lost \\u2014 but nobody can be PAID until both documents are accepted.'
      : 'Nothing is waiting. Earnings become payable as soon as both documents are accepted.';

    if (!q.people.length) { $('list').innerHTML = '<p class="msg">Nobody has started their paperwork yet.</p>'; return; }

    $('list').innerHTML = q.people.map(function (p) {
      var need = p.nda_state === 'signed' || p.w9_state === 'uploaded';
      var signed = p.signed_name
        ? '<div class="why">signed &ldquo;' + H(p.signed_name) + '&rdquo; \\u00b7 ' + H(String(p.signed_at || '').slice(0, 16)) + '</div>' : '';
      return '<div class="' + (need ? 'card need' : 'card') + '">'
        + '<div class="who"><b>' + H(p.name) + '</b><span class="code">' + H(p.code) + '</span>'
        + '<div class="meta">' + H(p.email) + ' \\u00b7 ' + H(p.country || '\\u2014') + ' \\u00b7 ' + p.introduced + ' introduced</div></div>'
        + docBlock(p, 'nda', p.nda_state, p.nda_reason, signed)
        + docBlock(p, 'w9', p.w9_state, p.w9_reason, '')
        + '</div>';
    }).join('');
    wire();
  }

  function load() {
    fetch('/api/expert-docs/queue', { headers: auth() })
      .then(function (r) {
        if (r.status === 403) { fail('That session is not an admin one. Sign in again at /ops/.'); return null; }
        return r.json();
      })
      .then(function (q) { if (q && q.ok) render(q); })
      .catch(function () { fail('Could not read the queue.'); });
  }

  function wire() {
    // The form: fetched with the header, shown from a blob that belongs to
    // this tab and dies with it. An <img src> could not have sent the header,
    // and a signed URL would have been a link to a tax form.
    document.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        fetch('/api/expert-docs/file?scout=' + encodeURIComponent(b.dataset.open), { headers: auth() })
          .then(function (r) { if (!r.ok) throw new Error('no'); return r.blob(); })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            window.open(u, '_blank', 'noopener');
            // Revoked once the new tab has taken it, so the handle does not
            // outlive the look.
            setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
            b.disabled = false;
          })
          .catch(function () { b.disabled = false; fail('Could not open that form.'); });
      });
    });

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
          headers: auth({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ scout_id: b.dataset.scout, kind: b.dataset.kind, accept: accept, reason: reason })
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok || !res.j.ok) { b.disabled = false; fail((res.j && (res.j.why || res.j.error)) || 'That did not go through.'); return; }
            load();
          })
          .catch(function () { b.disabled = false; });
      });
    });
  }

  load();
})();
</script>
</body></html>`;
}

/**
 * Routes `/desk`, `/queue` and `/file`.
 *
 * The shell is open because it holds nothing. The two that carry data are
 * admin-only, and they are what the shell calls with the header.
 */
export async function handleDesk(request, env, p) {
  if (p === '/desk') {
    return new Response(deskShell(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // (env, request). See worker/adminargs.test.mjs for why that order is
  // written out rather than left to memory.
  if (!await isAdmin(env, request)) return json({ error: 'not allowed' }, 403);

  if (p === '/queue') return json(await queue(env));

  const scoutId = new URL(request.url).searchParams.get('scout');
  if (!scoutId) return json({ error: 'which Expert?' }, 400);
  return serveW9(env, scoutId);
}
