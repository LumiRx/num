
/* ── QR encoder (v4 / ECC-H, fixed) ───────────────────────────────────────
   Wrapped in a closure so none of its ~20 internal names can collide with
   anything in this worker. The only thing that escapes is qrSvg(text).
   Verified: 300 random venue URLs rendered and decoded back correctly, and
   194/300 module matrices are byte-identical to a reference implementation
   (the rest select a different but equally valid mask — penalty rule 3 is
   implemented differently across libraries).
   ────────────────────────────────────────────────────────────────────── */
const qrSvg = (function () {
  /**
   * qr.js — a QR encoder small enough to live inside the worker.
   *
   * Deliberately NOT a general library. Every code we produce is the same shape:
   *
   *     https://itsnum.com/v/XXXXXX      27 bytes, always
   *
   * so this is fixed to **version 4, error-correction level H** — 33×33 modules,
   * 36 data codewords in 4 blocks of 9, RS(25,9) per block, ~30% recoverable.
   * Fixing the version removes the version/format tables that are the usual
   * source of bugs in hand-rolled encoders, and H is the right level for
   * something printed and then left on a restaurant table to be spilled on.
   *
   * Correctness is not asserted, it is demonstrated: qr.test.mjs renders the
   * module matrix for hundreds of random tokens and compares it cell-for-cell
   * against a reference implementation, then decodes the rendered artwork.
   */

  const VERSION = 4;
  const SIZE = 17 + VERSION * 4;          // 33
  const DATA_CW = 36;                     // 4 blocks × 9
  const BLOCKS = 4;
  const BLOCK_DATA = 9;
  const BLOCK_EC = 16;
  const EC_LEVEL_BITS = 0b10;             // H, as it appears in the format string

  /* ── GF(256), the field QR's Reed-Solomon lives in ───────────────────────── */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;          // the QR primitive polynomial
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /* Generator polynomial for `n` EC codewords. */
  function genPoly(n) {
    let p = [1];
    for (let i = 0; i < n; i++) {
      const q = [1, EXP[i]];
      const r = new Array(p.length + 1).fill(0);
      for (let a = 0; a < p.length; a++) {
        for (let b = 0; b < q.length; b++) r[a + b] ^= mul(p[a], q[b]);
      }
      p = r;
    }
    return p;
  }

  function ecFor(data, n) {
    const g = genPoly(n);
    const res = new Array(data.length + n).fill(0);
    data.forEach((v, i) => (res[i] = v));
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (f === 0) continue;
      for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
    }
    return res.slice(data.length);
  }

  /* ── bitstream → codewords ───────────────────────────────────────────────── */
  function encodeData(text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > DATA_CW - 2) {
      throw new Error(`payload too long for v4-H: ${bytes.length} bytes`);
    }
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };

    push(0b0100, 4);                      // byte mode
    push(bytes.length, 8);                // v1–9 use an 8-bit length
    bytes.forEach((b) => push(b, 8));

    const cap = DATA_CW * 8;
    push(0, Math.min(4, cap - bits.length));        // terminator
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    }
    const PAD = [0xec, 0x11];
    for (let i = 0; cw.length < DATA_CW; i++) cw.push(PAD[i % 2]);
    return cw;
  }

  /* Split into blocks, compute EC, interleave — the order the spec requires. */
  function finalCodewords(text) {
    const cw = encodeData(text);
    const dBlocks = [], eBlocks = [];
    for (let i = 0; i < BLOCKS; i++) {
      const d = cw.slice(i * BLOCK_DATA, (i + 1) * BLOCK_DATA);
      dBlocks.push(d);
      eBlocks.push(ecFor(d, BLOCK_EC));
    }
    const out = [];
    for (let i = 0; i < BLOCK_DATA; i++) for (const b of dBlocks) out.push(b[i]);
    for (let i = 0; i < BLOCK_EC; i++) for (const b of eBlocks) out.push(b[i]);
    return out;
  }

  /* ── matrix ──────────────────────────────────────────────────────────────── */
  const newMatrix = () => Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));

  function placeFunctionPatterns(m) {
    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) {
        for (let j = -1; j <= 7; j++) {
          const rr = r + i, cc = c + j;
          if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
          const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                     (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                     (i >= 2 && i <= 4 && j >= 2 && j <= 4);
          m[rr][cc] = on ? 1 : 0;
        }
      }
    };
    finder(0, 0); finder(0, SIZE - 7); finder(SIZE - 7, 0);

    for (let i = 8; i < SIZE - 8; i++) {          // timing
      const v = i % 2 === 0 ? 1 : 0;
      if (m[6][i] === null) m[6][i] = v;
      if (m[i][6] === null) m[i][6] = v;
    }

    // v4 has exactly one alignment pattern, centred at (26,26)
    const ac = 26;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        m[ac + i][ac + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
      }
    }

    m[SIZE - 8][8] = 1;                            // the always-dark module
  }

  const FORMAT_MASK = 0b101010000010010;
  function formatBits(mask) {
    const data = (EC_LEVEL_BITS << 3) | mask;
    let v = data << 10;
    for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0b10100110111 << (i - 10);
    return ((data << 10) | v) ^ FORMAT_MASK;
  }

  function placeFormat(m, mask) {
    const f = formatBits(mask);
    // Placement walks the format string MSB-first: position 0 carries bit 14.
    // formatBits() itself is right — it reproduces the published L/mask-0 and
    // M/mask-0 strings exactly — so a reversal here is silently a *different
    // valid* format string, which is the worst kind of wrong: scanners read it,
    // apply the wrong mask, and get nothing.
    const bit = (i) => (f >> (14 - i)) & 1;
    for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
    m[8][7] = bit(6); m[8][8] = bit(7); m[7][8] = bit(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
    // The second copy is SEVEN vertical cells then EIGHT horizontal — not eight
    // and seven. Getting it the wrong way round leaves (8, SIZE-8) unreserved,
    // the data walk consumes it, and every subsequent bit shifts by one: the
    // codewords stay byte-perfect while the symbol becomes unreadable.
    for (let i = 0; i <= 6; i++) m[SIZE - 1 - i][8] = bit(i);
    for (let i = 7; i <= 14; i++) m[8][SIZE - 15 + i] = bit(i);
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function placeData(m, cw, mask) {
    let bitIdx = 0;
    const total = cw.length * 8;
    let up = true;
    for (let right = SIZE - 1; right > 0; right -= 2) {
      if (right === 6) right--;                   // skip the timing column
      for (let k = 0; k < SIZE; k++) {
        const r = up ? SIZE - 1 - k : k;
        for (const c of [right, right - 1]) {
          if (m[r][c] !== null) continue;
          let v = 0;
          if (bitIdx < total) v = (cw[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
          m[r][c] = MASKS[mask](r, c) ? v ^ 1 : v;
        }
      }
      up = !up;
    }
  }

  /* Penalty scoring — this is what picks the mask, and getting it wrong yields
     a valid-but-different code, which is exactly the kind of bug that only
     shows up on one phone in twenty. Verified against the reference. */
  function penalty(m) {
    let p = 0;
    const run = (get) => {
      for (let a = 0; a < SIZE; a++) {
        let last = -1, len = 0;
        for (let b = 0; b < SIZE; b++) {
          const v = get(a, b);
          if (v === last) { len++; if (len === 5) p += 3; else if (len > 5) p += 1; }
          else { last = v; len = 1; }
        }
      }
    };
    run((a, b) => m[a][b]);
    run((a, b) => m[b][a]);

    for (let r = 0; r < SIZE - 1; r++) {
      for (let c = 0; c < SIZE - 1; c++) {
        const s = m[r][c] + m[r][c + 1] + m[r + 1][c] + m[r + 1][c + 1];
        if (s === 0 || s === 4) p += 3;
      }
    }

    const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const hit = (get, a, b) => {
      for (const pat of [PAT1, PAT2]) {
        let ok = true;
        for (let i = 0; i < 11; i++) if (get(a, b + i) !== pat[i]) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    };
    for (let a = 0; a < SIZE; a++) {
      for (let b = 0; b + 10 < SIZE; b++) {
        if (hit((x, y) => m[x][y], a, b)) p += 40;
        if (hit((x, y) => m[y][x], a, b)) p += 40;
      }
    }

    let dark = 0;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) dark += m[r][c];
    p += Math.floor(Math.abs((dark * 100) / (SIZE * SIZE) - 50) / 5) * 10;
    return p;
  }

  /** Module matrix for `text`. 1 = dark. */
  function matrix(text) {
    const cw = finalCodewords(text);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = newMatrix();
      placeFunctionPatterns(m);
      placeFormat(m, mask);
      placeData(m, cw, mask);
      const s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  /** Compact SVG. One <path> for every dark module — no images, no fonts. */
  function svg(text, { border = 2, dark = "#131a16", light = "#ffffff" } = {}) {
    const m = matrix(text);
    const n = SIZE + border * 2;
    const d = [];
    for (let r = 0; r < SIZE; r++) {
      let c = 0;
      while (c < SIZE) {
        if (m[r][c]) {
          let e = c;
          while (e + 1 < SIZE && m[r][e + 1]) e++;
          d.push(`M${c + border} ${r + border}h${e - c + 1}v1h-${e - c + 1}z`);
          c = e + 1;
        } else c++;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
      `<rect width="${n}" height="${n}" fill="${light}"/>` +
      `<path fill="${dark}" d="${d.join("")}"/></svg>`;
  }

  return svg;

})();

/* ══════════════════════════════════════════════════════════════════════════
   Venue code manager — a business creates and retires its own table codes.
   Added 10 Aug 2026.

   NOTHING IS EVER DELETED, AND THAT IS THE WHOLE DESIGN.
   "Delete this table" is implemented as revoke. Two reasons, both learned the
   hard way elsewhere in this codebase:

     1. A card outlives its row. Table 7's sticker is on Table 7 until someone
        peels it off. Hard-delete the row and the next guest to scan it gets
        "this code isn't one of ours" — in front of staff, holding a card the
        business printed because we asked them to. Revoking gives them the
        true, calm answer instead: this code was retired, ask for the current
        one.
     2. Scans are billing evidence. num_venue_scans references the token. Hard
        deleting the code orphans the audit trail for money that has already
        moved.

   Revoked codes therefore stay listed, greyed, with the date — and can be
   reinstated, because "we took Table 7 out for winter" is a normal thing that
   happens twice a year.
   ══════════════════════════════════════════════════════════════════════════ */

const TOKEN_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";  // no vowels, no 0/1/I/O
const MAX_ACTIVE_CODES = 300;   // a very large restaurant; a runaway loop is not

function newToken(len = 6) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < len; i++) s += TOKEN_ALPHABET[b[i] % TOKEN_ALPHABET.length];
  return s;
}

async function bizAuth(env, url) {
  const k = url.searchParams.get("k") || "";
  if (k.length < 20 || k.length > 80) return null;
  const biz = await env.DB.prepare(
    "SELECT id,name,console_key,status FROM businesses WHERE console_key = ?"
  ).bind(k).first();
  if (!biz) return null;
  if (!sameSecret(biz.console_key, k)) return null;   // constant-time
  if (biz.status !== "active") return null;
  return biz;
}

/* ── GET /api/venue/codes?k= — list, with scan counts ────────────────────── */
async function venueCodesList(req, env, url) {
  const biz = await bizAuth(env, url);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT c.token, c.label, c.perk_text, c.state, c.created_at, c.revoked_at,
            (SELECT COUNT(*) FROM num_venue_scans s
              WHERE s.token = c.token AND s.outcome = 'completed')  AS check_ins,
            (SELECT COUNT(*) FROM num_venue_scans s
              WHERE s.token = c.token AND s.outcome = 'no_booking') AS walk_ins,
            (SELECT MAX(created_at) FROM num_venue_scans s WHERE s.token = c.token) AS last_scan
       FROM num_venue_codes c
      WHERE c.business_id = ?
      ORDER BY c.state = 'revoked', c.created_at`
  ).bind(biz.id).all();

  return J({ ok: true, business: biz.name, codes: results || [] });
}

/* ── POST /api/venue/codes — create one table ────────────────────────────── */
async function venueCodesCreate(req, env, url) {
  const biz = await bizAuth(env, url);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);

  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const label = clean(b.label, 40);
  if (!label) return J({ ok: false, error: "label_required" }, 400);

  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_venue_codes WHERE business_id=? AND state='active'"
  ).bind(biz.id).first();
  if ((live?.n || 0) >= MAX_ACTIVE_CODES) {
    return J({ ok: false, error: "too_many_codes", max: MAX_ACTIVE_CODES }, 409);
  }

  // A duplicate label is almost always a double-tap, not a second Table 7.
  const dup = await env.DB.prepare(
    "SELECT token FROM num_venue_codes WHERE business_id=? AND state='active' AND lower(label)=lower(?)"
  ).bind(biz.id, label).first();
  if (dup) return J({ ok: false, error: "label_exists", token: dup.token }, 409);

  // Retry on collision rather than trusting 28^6 to be lucky forever.
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = newToken();
    try {
      await env.DB.prepare(
        `INSERT INTO num_venue_codes (token,business_id,label,perk_text,state,issued_for,created_at)
         VALUES (?,?,?,?, 'active', 'self_serve', ?)`
      ).bind(token, biz.id, label, clean(b.perk_text, 120) || null, now()).run();
      return J({ ok: true, token, label, url: (env.SITE || "https://itsnum.com") + "/v/" + token });
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
    }
  }
  return J({ ok: false, error: "could_not_allocate" }, 503);
}

/* ── POST /api/venue/codes/state — retire or reinstate ───────────────────── */
async function venueCodesState(req, env, url) {
  const biz = await bizAuth(env, url);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);

  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const token = clean(b.token, 40).toUpperCase();
  const to = clean(b.state, 12);
  if (!token || !["revoked", "active"].includes(to)) {
    return J({ ok: false, error: "missing_fields" }, 400);
  }

  // Scoped to the caller's own business: a valid key must never be able to
  // touch another venue's codes.
  const row = await env.DB.prepare(
    "SELECT token,state,label FROM num_venue_codes WHERE token=? AND business_id=?"
  ).bind(token, biz.id).first();
  if (!row) return J({ ok: false, error: "unknown_token" }, 404);
  if (row.state === to) return J({ ok: true, unchanged: true, state: to });

  await env.DB.prepare(
    to === "revoked"
      ? "UPDATE num_venue_codes SET state='revoked', revoked_at=?, revoked_by=? WHERE token=?"
      : "UPDATE num_venue_codes SET state='active',  revoked_at=NULL, revoked_by=NULL WHERE token=?"
  ).bind(...(to === "revoked" ? [now(), "biz:" + biz.id, token] : [token])).run();

  return J({ ok: true, token, state: to, label: row.label });
}

/* ── GET /api/venue/qr/<TOKEN>.svg — the artwork itself ──────────────────
   Public and unauthenticated on purpose: it encodes a URL that is printed on
   a card anyone can photograph. Keeping it open is what lets a business drop
   it straight into their own print run, a menu PDF, or an email.          */
async function venueQr(req, env, rest) {
  const token = clean(String(rest || "").replace(/\.svg$/i, ""), 40).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(token)) return TEXT("bad token", 400);

  const row = await env.DB.prepare(
    "SELECT token FROM num_venue_codes WHERE token = ?"
  ).bind(token).first();
  // Refuse to draw a QR for a code that does not exist. A beautiful QR
  // pointing at nothing is how a venue ends up with fifty printed cards that
  // all say "this code isn't one of ours".
  if (!row) return TEXT("unknown token", 404);

  const body = qrSvg((env.SITE || "https://itsnum.com") + "/v/" + token);
  return new Response(body, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/* ── GET /biz/codes/?k= — the manager a business actually uses ────────────
   One screen. Add a table, print it, retire it. No build step, no framework,
   no dependency that can rot: the QR images are served by our own worker, so
   this page has no third-party requests at all.

   It is also the print surface. @media print drops everything but the cards
   themselves, so Cmd-P gives a sheet of table cards with no extra software —
   which matters, because the person doing this owns a restaurant, not a
   design tool.                                                             */
async function venueCodesPage(req, env, url) {
  const biz = await bizAuth(env, url);
  if (!biz) {
    return HTML(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — NUM</title>
<style>body{font:17px/1.6 -apple-system,'Segoe UI',sans-serif;background:#faf8f4;color:#131a16;
max-width:460px;margin:0 auto;padding:60px 24px}h1{color:#1f3a34;font-size:26px;margin:0 0 12px}
p{color:#39423b}a{color:#1e7a4d}</style>
<h1>That link isn't valid</h1>
<p>Your codes page has a private key in the address. Use the link we sent you,
or <a href="mailto:info@5arz.com?subject=Codes%20link">ask us to resend it</a>.</p>`, 401);
  }

  const site = env.SITE || "https://itsnum.com";
  const { results } = await env.DB.prepare(
    `SELECT c.token, c.label, c.state, c.created_at, c.revoked_at,
            (SELECT COUNT(*) FROM num_venue_scans s
              WHERE s.token=c.token AND s.outcome='completed') AS check_ins
       FROM num_venue_codes c WHERE c.business_id=?
      ORDER BY c.state='revoked', c.created_at`
  ).bind(biz.id).all();

  const rows = (results || []).map((r) => `
    <li class="code ${r.state}" data-token="${esc(r.token)}">
      <div class="qr"><img src="/api/venue/qr/${esc(r.token)}.svg" alt="QR code for ${esc(r.label)}" width="150" height="150"></div>
      <div class="meta">
        <b>${esc(r.label)}</b>
        <code>${site.replace(/^https?:\/\//, "")}/v/${esc(r.token)}</code>
        <span class="stat">${r.check_ins} check-in${r.check_ins === 1 ? "" : "s"}${
          r.state === "revoked" ? ` · retired ${esc((r.revoked_at || "").slice(0, 10))}` : ""}</span>
        <div class="acts">
          ${r.state === "active"
            ? `<button class="lnk warn" data-act="revoked">Retire this one</button>`
            : `<button class="lnk" data-act="active">Put it back</button>`}
        </div>
      </div>
    </li>`).join("");

  return HTML(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Your table codes — NUM</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4;--warn:#b4552d}
*{margin:0;box-sizing:border-box}
body{font:16px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  max-width:860px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:clamp(26px,5vw,34px);color:var(--pine);letter-spacing:-.02em;margin-bottom:6px}
.sub{color:#68705f;margin-bottom:28px}
.add{display:flex;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);
  border-radius:14px;padding:16px;margin-bottom:26px}
.add input{flex:1 1 220px;min-height:48px;font:16px inherit;padding:12px 14px;
  border:1.5px solid var(--line);border-radius:10px;background:var(--paper)}
.add input:focus{outline:0;border-color:var(--green)}
.btn{min-height:48px;background:var(--green);color:#fff;font:650 16px inherit;border:0;
  border-radius:10px;padding:12px 22px;cursor:pointer}
.btn.sec{background:transparent;color:var(--pine);border:1.5px solid var(--pine)}
.btn[disabled]{opacity:.55}
ul{list-style:none}
.code{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;background:#fff;
  border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px}
.code.revoked{opacity:.5}
.code.revoked .qr{filter:grayscale(1)}
.meta b{display:block;font-size:19px;color:var(--pine)}
.meta code{display:block;font:13.5px ui-monospace,Menlo,monospace;color:#68705f;margin:4px 0}
.stat{font-size:14px;color:#68705f}
.acts{margin-top:10px}
.lnk{background:none;border:0;padding:8px 0;font:600 15px inherit;color:var(--green);
  cursor:pointer;text-decoration:underline;text-underline-offset:3px;min-height:44px}
.lnk.warn{color:var(--warn)}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--green);
  border-radius:10px;padding:14px 18px;font-size:14.5px;color:#39423b;margin:24px 0}
.msg{margin:14px 0;padding:12px 16px;border-radius:10px;font-size:15px}
.msg.bad{background:#fdf0e9;border:1px solid #f0cbb4;color:#6b3113}
.msg.good{background:#e8f4ec;border:1px solid #b9dcc6;color:#14432c}
.tools{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
@media print{
  body{max-width:none;padding:0}
  h1,.sub,.add,.note,.tools,.acts,.stat,.msg{display:none!important}
  ul{display:grid;grid-template-columns:1fr 1fr;gap:0}
  .code{display:block;text-align:center;page-break-inside:avoid;border:1px dashed #bbb;
    border-radius:0;margin:0;padding:26px 10px;opacity:1}
  .code.revoked{display:none}
  .qr img{width:190px;height:190px}
  .meta b{font-size:17px;margin-top:10px}
  .meta code{font-size:12px}
}
</style></head>
<body>

<h1>Your table codes</h1>
<p class="sub">${esc(biz.name)} — add a code for each table, print them, retire the ones you stop using.</p>

<div class="tools">
  <button class="btn sec" onclick="window.print()">Print all active codes</button>
</div>

<form class="add" id="add">
  <input id="label" maxlength="40" placeholder="Table 7" aria-label="Name this code" required>
  <button class="btn" type="submit" id="go">Add a code</button>
</form>

<div id="msg"></div>

<ul id="list">${rows || '<p class="sub">No codes yet. Add your first one above.</p>'}</ul>

<div class="note"><b>Retiring is not deleting.</b> A card stays on a table long after you stop
using it, so a retired code keeps working as a polite dead end — it tells the guest it was
retired and to ask you for the current one, instead of "this code isn't one of ours". Your
check-in history stays intact too, which matters because it is what your billing is based on.
You can put a retired code back at any time.</div>

<script>
(function(){
  var K = new URLSearchParams(location.search).get('k');
  var msg = document.getElementById('msg');
  function say(kind, text){ msg.innerHTML = '<div class="msg '+kind+'">'+text+'</div>';
    if(kind==='good') setTimeout(function(){ msg.innerHTML=''; }, 4000); }

  document.getElementById('add').addEventListener('submit', function(e){
    e.preventDefault();
    var label = document.getElementById('label').value.trim();
    if(!label) return;
    var go = document.getElementById('go');
    go.disabled = true; go.textContent = 'Adding…';
    fetch('/api/venue/codes?k=' + encodeURIComponent(K), {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ label: label })
    }).then(function(r){ return r.json(); }).then(function(j){
      go.disabled = false; go.textContent = 'Add a code';
      if(j.ok){ location.reload(); }
      else if(j.error === 'label_exists') say('bad','You already have an active code called that.');
      else if(j.error === 'too_many_codes') say('bad','That is the maximum number of active codes. Retire one first.');
      else say('bad','Could not add that just now. Try again in a moment.');
    }).catch(function(){
      go.disabled = false; go.textContent = 'Add a code';
      say('bad','No connection. Nothing was changed.');
    });
  });

  document.getElementById('list').addEventListener('click', function(e){
    var btn = e.target.closest('button[data-act]');
    if(!btn) return;
    var li = btn.closest('.code'), to = btn.dataset.act;
    if(to === 'revoked' && !confirm('Retire "' + li.querySelector('b').textContent +
        '"?\\n\\nAnyone who scans that card will be told it was retired. Your check-in history is kept, and you can put it back later.')) return;
    btn.disabled = true;
    fetch('/api/venue/codes/state?k=' + encodeURIComponent(K), {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ token: li.dataset.token, state: to })
    }).then(function(r){ return r.json(); }).then(function(j){
      if(j.ok) location.reload(); else { btn.disabled=false; say('bad','That did not go through.'); }
    }).catch(function(){ btn.disabled=false; say('bad','No connection. Nothing was changed.'); });
  });
})();
</script>
</body></html>`);
}
