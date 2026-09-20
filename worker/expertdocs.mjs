/**
 * NUM · the paperwork a Num Expert does once, before anybody is paid.
 *
 * ── THE CORRECTION THAT SHAPES THIS WHOLE FILE ───────────────────────────
 *
 * The ask was "they get a 1099 and an NDA, auto filled out, they just sign and
 * upload". Two of those three are right, and the third is worth getting
 * straight because it changes what gets built:
 *
 *   · A **W-9** is what THEY fill in, now, so NUM is able to pay them. It
 *     carries their name, address and taxpayer number.
 *   · A **1099-NEC** is what NUM sends THEM, in January, reporting what it
 *     paid. Nobody signs a 1099. You issue it.
 *
 * So the pack is an NDA and a W-9. The 1099 is a thing NUM does later, and for
 * tax years beginning after 2025 the reporting threshold is **$2,000**, not
 * the $600 everybody remembers — raised by the One Big Beautiful Bill and
 * confirmed in the December 2026 revision of the 1099-MISC/NEC instructions.
 *
 * ── THE SSN NEVER ENTERS NUM ─────────────────────────────────────────────
 *
 * A W-9 contains a social security number. Nothing in this file parses one,
 * stores one, or renders one back. The uploaded form is an opaque object in
 * storage behind admin access, and `num_expert_docs` has no column for it.
 *
 * Holding SSNs for a small team is a bad trade: useless day to day, and it
 * turns any ordinary incident into a notifiable breach in most US states. The
 * better architecture — worth doing before this programme has fifty people —
 * is a payer-of-record such as Stripe Connect, which collects the W-9,
 * verifies the number and files the 1099s, so it never touches NUM at all.
 *
 * ── AND NUM DOES NOT COPY THE IRS FORM ───────────────────────────────────
 *
 * The W-9 is linked from irs.gov and nowhere else. NUM does not host a
 * lookalike, does not "helpfully" reproduce the fields, and does not put its
 * own branding on a government form — the same rule traveldocs.mjs applies to
 * visas, for the same reason: a convincing copy of an official form is
 * indistinguishable from the thing it is protecting people from.
 *
 * The NDA is different. NUM wrote it, so NUM can fill it in and have it signed
 * in the browser. Under the ESIGN Act that is a valid signature where there is
 * intent, consent, and a retained record tying the signature to the exact
 * document — which is what `body_sha256` is for.
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/** The official form, from the only place it may come from. */
export const W9_URL = 'https://www.irs.gov/pub/irs-pdf/fw9.pdf';
export const W9_ABOUT = 'https://www.irs.gov/forms-pubs/about-form-w-9';
export const NEC_ABOUT = 'https://www.irs.gov/forms-pubs/about-form-1099-nec';

/**
 * The 1099-NEC reporting threshold, for tax years beginning after 2025.
 *
 * Everybody, including most accountants' muscle memory, will say $600. It was
 * raised to $2,000 and the figure is here rather than in prose so the page and
 * the terms cannot drift apart from each other.
 */
export const NEC_THRESHOLD_USD = 2000;

export const NDA_VERSION = 'v1';

/**
 * The NDA, with the two blanks NUM can fill itself.
 *
 * Deliberately short and in plain words. A contractor who is about to walk a
 * street signing shops up will read four paragraphs; they will not read four
 * pages, and an agreement nobody read is not much of an agreement.
 */
export function ndaBody({ name, date }) {
  return `MUTUAL NON-DISCLOSURE AGREEMENT — Num Expert programme (${NDA_VERSION})

Between 5arz Inc., which operates Num, and ${name}, agreed on ${date}.

1. What is confidential
Anything either side shares that is not already public: Num's unreleased
features, pricing not yet published, business lists, member data, commission
terms specific to you, and anything a business tells you in the course of
introducing them to Num.

2. What you do with it
Use it only to do the work of a Num Expert. Do not publish it, sell it, or pass
it to anyone else, including another company you work with. Take reasonable
care of it — do not leave lists of businesses in a shared folder or a group
chat.

3. What is not covered
Information you already had, information that becomes public without you
breaking this agreement, and anything you are legally required to disclose. If
you are required to disclose something, tell us first if you are allowed to.

4. Member and business data
Anything you learn about an individual — a phone number, an address, a booking
— is theirs, not ours and not yours. Do not copy it, keep it after you stop
being an Expert, or use it to contact them for anything other than Num.

5. How long
Three years from the day this is signed, except for anything about an
identifiable person, which has no expiry.

6. When you stop
Delete or return what you hold. You may keep your own record of which
businesses you introduced, because that is what you are paid on.

7. Ordinary terms
This is governed by the laws of the State of California. It does not make you
an employee, and it does not oblige either side to do business with the other.

Signed electronically by typing a name below. Under the US ESIGN Act that
counts as a signature.`;
}

/** SHA-256 of the exact text somebody was shown, hex. */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the Expert still has to do. */
export async function packFor(env, scoutId) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  const scout = await env.DB.prepare('SELECT id, name, country FROM num_scouts WHERE id=?1').bind(scoutId).first();
  if (!scout) return { ok: false, why: 'not a Num Expert' };

  const { results = [] } = await env.DB.prepare(
    'SELECT kind, state, reject_reason, signed_at, uploaded_at, reviewed_at FROM num_expert_docs WHERE scout_id=?1',
  ).bind(scoutId).all();
  const by = Object.fromEntries(results.map((r) => [r.kind, r]));

  // Only US persons file a W-9. Everybody else files a W-8 series form, which
  // is a different form and a different conversation — so rather than hand a
  // Kenyan Expert the wrong document, it says so.
  const isUs = String(scout.country || '').toUpperCase() === 'US';

  return {
    ok: true,
    scout: { id: scout.id, name: scout.name, country: scout.country },
    nda: {
      kind: 'nda',
      state: by.nda?.state ?? 'pending',
      version: NDA_VERSION,
      how: 'Read it and type your name. That is the signature — nothing to print.',
      rejectReason: by.nda?.reject_reason ?? null,
    },
    tax: isUs
      ? {
        kind: 'w9',
        state: by.w9?.state ?? 'pending',
        form: 'W-9',
        url: W9_URL,
        about: W9_ABOUT,
        how: 'Download the form from the IRS, fill it in, sign it, and upload it back here. '
          + 'Num does not host its own copy of this form and never will.',
        why: `This is how Num is able to pay you. It is not the 1099 — that is what Num sends `
          + `you in January if it paid you $${NEC_THRESHOLD_USD} or more during the year.`,
        privacy: 'Your form is stored as a file that only a person at Num can open. The number on '
          + 'it is never copied into Num’s database and never shown in the app.',
        rejectReason: by.w9?.reject_reason ?? null,
      }
      : {
        kind: 'w9',
        state: 'pending',
        form: null,
        url: null,
        how: 'You are outside the US, so the W-9 is the wrong form for you. Num will send you '
          + 'the right one — get in touch and it will be sorted before anything is paid.',
        why: null,
      },
    payable: await docsComplete(env, scoutId),
  };
}

/**
 * Can this Expert be paid?
 *
 * The real enforcement point. Earnings still ACCRUE while paperwork is
 * outstanding — the work was done and the claim is real — but nothing becomes
 * payable until both documents are accepted. Blocking accrual instead would
 * punish somebody for a form, and blocking payment is what the form is
 * actually for.
 */
export async function docsComplete(env, scoutId) {
  if (!env?.DB) return false;
  const { results = [] } = await env.DB.prepare(
    "SELECT kind FROM num_expert_docs WHERE scout_id=?1 AND state='accepted'",
  ).bind(scoutId).all();
  const done = new Set(results.map((r) => r.kind));
  return done.has('nda') && done.has('w9');
}

/** Sign the NDA. The typed name is the signature. */
export async function signNda(env, { scoutId, typedName, ip = null, ua = null, now = new Date() } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  const scout = await env.DB.prepare('SELECT id, name FROM num_scouts WHERE id=?1').bind(scoutId).first();
  if (!scout) return { ok: false, why: 'not a Num Expert' };

  const typed = clip(String(typedName || '').trim(), 80);
  if (!typed) return { ok: false, why: 'type your name to sign' };

  // A signature that is not the signer's name is not a signature. Compared
  // loosely — punctuation and case differ, people do not — but it has to be
  // theirs.
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  if (norm(typed) !== norm(scout.name)) {
    return { ok: false, why: `sign with the name on your account: ${scout.name}` };
  }

  const date = now.toISOString().slice(0, 10);
  const body = ndaBody({ name: scout.name, date });
  const hash = await sha256Hex(body);

  await env.DB.prepare(
    `INSERT INTO num_expert_docs
       (id, scout_id, kind, state, doc_version, body_sha256, signed_name, signed_at, signed_ip, signed_ua)
     VALUES (?1,?2,'nda','signed',?3,?4,?5,?6,?7,?8)
     ON CONFLICT(scout_id, kind) DO UPDATE SET
       state='signed', doc_version=?3, body_sha256=?4, signed_name=?5,
       signed_at=?6, signed_ip=?7, signed_ua=?8, reject_reason=NULL`,
  ).bind(uid('doc'), scoutId, NDA_VERSION, hash, typed, now.toISOString(), clip(ip, 64), clip(ua, 200)).run();

  return { ok: true, state: 'signed', version: NDA_VERSION, hash };
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);

/**
 * Take the completed W-9.
 *
 * The bytes go to object storage under a key nobody can guess and the database
 * learns only that a file exists. Nothing here opens the file, and nothing
 * here ever should.
 */
export async function receiveW9(env, { scoutId, bytes, contentType, now = new Date() } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  const scout = await env.DB.prepare('SELECT id FROM num_scouts WHERE id=?1').bind(scoutId).first();
  if (!scout) return { ok: false, why: 'not a Num Expert' };

  const size = bytes?.byteLength ?? bytes?.length ?? 0;
  if (!size) return { ok: false, why: 'the file was empty' };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, why: 'that file is too big — 10MB is the limit' };
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) {
    return { ok: false, why: 'send a PDF or a photo of the signed form' };
  }

  if (!env.PHOTOS) {
    // Better to refuse than to record that a form arrived when it did not.
    return { ok: false, why: 'uploads are not configured — tell Num and it will be fixed' };
  }

  // Unguessable, and namespaced so it is obvious what it is and never served
  // from a public path by accident.
  const key = `expert-tax/${scoutId}/${crypto.randomUUID()}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });

  await env.DB.prepare(
    `INSERT INTO num_expert_docs (id, scout_id, kind, state, object_key, bytes, content_type, uploaded_at)
     VALUES (?1,?2,'w9','uploaded',?3,?4,?5,?6)
     ON CONFLICT(scout_id, kind) DO UPDATE SET
       state='uploaded', object_key=?3, bytes=?4, content_type=?5, uploaded_at=?6, reject_reason=NULL`,
  ).bind(uid('doc'), scoutId, key, size, type, now.toISOString()).run();

  return { ok: true, state: 'uploaded', note: 'Got it. Someone at Num will check it and you will be paid once it clears.' };
}

/** A person at NUM accepts or rejects a document. */
export async function review(env, { scoutId, kind, accept, reason = null, by = null, now = new Date() } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  if (!['nda', 'w9'].includes(kind)) return { ok: false, why: 'unknown document' };
  const state = accept ? 'accepted' : 'rejected';
  const res = await env.DB.prepare(
    `UPDATE num_expert_docs SET state=?3, reject_reason=?4, reviewed_by=?5, reviewed_at=?6
      WHERE scout_id=?1 AND kind=?2`,
  ).bind(scoutId, kind, state, accept ? null : clip(reason, 200), clip(by, 80), now.toISOString()).run();
  if (!res?.meta?.changes) return { ok: false, why: 'nothing to review' };
  return { ok: true, state, payable: await docsComplete(env, scoutId) };
}

export async function handleExpertDocs(request, env, path) {
  const p = path || '/';

  // ── WHO THIS IS, AND WHY IT IS NO LONGER THE CODE ──────────────────────
  //
  // This used to resolve the Expert from `?code=`, the same way the dashboard
  // did. On the dashboard that was a disclosure bug. HERE IT WAS WORSE: `/nda`
  // takes a POST that SIGNS A LEGAL DOCUMENT, and `/w9` takes a POST that
  // files a tax form. Both were reachable by anybody holding a referral code —
  // which is printed on an NFC card, read aloud across counters, and public at
  // `itsnum.com/s/FARMER`.
  //
  // An electronic signature under the ESIGN Act is valid on intent, consent
  // and a retained record. A signature captured this way would have carried
  // the contractor's name on a document they never saw. That is not a
  // disclosure problem, it is a forgery surface.
  //
  // It is the signed Expert session now, and only that. The session is minted
  // two ways: by the emailed sign-in link, and at enrolment — because somebody
  // who has just filled the form in is at the keyboard, and their paperwork is
  // the very next thing they do.
  const { expertFromRequest } = await import('./scoutmagic.mjs');
  const sid = await expertFromRequest(env, request);
  const scout = sid
    ? await env.DB.prepare('SELECT id, name, country FROM num_scouts WHERE id=?1').bind(sid).first().catch(() => null)
    : null;

  if (p === '/' || p === '/pack') {
    if (!scout) return json({ ok: false, why: 'not a Num Expert' }, 404);
    return json(await packFor(env, scout.id));
  }

  if (p === '/nda') {
    if (!scout) return json({ ok: false, why: 'not a Num Expert' }, 404);
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const r = await signNda(env, {
        scoutId: scout.id,
        typedName: body.name,
        ip: request.headers.get('cf-connecting-ip'),
        ua: request.headers.get('user-agent'),
      });
      return json(r, r.ok ? 200 : 400);
    }
    // The exact text they will be asked to sign.
    return json({
      ok: true,
      version: NDA_VERSION,
      body: ndaBody({ name: scout.name, date: new Date().toISOString().slice(0, 10) }),
    });
  }

  if (p === '/w9' && request.method === 'POST') {
    if (!scout) return json({ ok: false, why: 'not a Num Expert' }, 404);
    const type = request.headers.get('content-type') || '';
    const bytes = new Uint8Array(await request.arrayBuffer());
    const r = await receiveW9(env, { scoutId: scout.id, bytes, contentType: type });
    return json(r, r.ok ? 200 : 400);
  }

  if (p === '/review' && request.method === 'POST') {
    const { isAdmin } = await import('./console.mjs');
    if (!await isAdmin(request, env)) return json({ error: 'not allowed' }, 403);
    const body = await request.json().catch(() => ({}));
    const r = await review(env, {
      scoutId: body.scout_id, kind: body.kind, accept: !!body.accept, reason: body.reason, by: body.by,
    });
    return json(r, r.ok ? 200 : 400);
  }

  return json({ error: 'not found' }, 404);
}
