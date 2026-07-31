/* NUM — site config.
   Loaded before site.js on every page.

   ⚠️  This file MUST be published. If it 404s, window.NUM_API_BASE is
   undefined, site.js falls back to API='' and every form silently stops
   sending. That is exactly what happened before 27 Jul 2026 — /signup and
   /start showed success screens for submissions that reached no server.
   site.js now hard-codes the same fallback so a missing config.js can never
   cause that again, but publish this file anyway. */

/* Claims / content API — the num-ai worker. Absolute URL is fine here:
   these are unauthenticated POSTs, no cookie involved. */
window.NUM_API_BASE = 'https://itsnum.com';

/* ── AUTH ─────────────────────────────────────────────────────────────────
   There is NO auth base URL, and that is deliberate.

   Sign-in uses the existing NUM account system at /api/accounts/* — the same
   one the operator console uses, already live, already holding real accounts.
   Its session is an HttpOnly `num_session` cookie scoped to Path=/ on
   itsnum.com, so every auth call must be a RELATIVE, same-origin request.
   Pointing auth at an absolute worker URL would silently stop the cookie
   being sent and break sign-in.

   A second auth worker was deployed on
   2026-07-28 before we discovered this one already existed. It is NOT used
   by the site and should be deleted — running two account systems on one
   domain is how you end up with a customer who "has an account" in the one
   nobody is looking at.
   ───────────────────────────────────────────────────────────────────────── */

/* Sign-in is email-link only. The accounts system has no Google flow, so no
   client ID is configured — a Google button here would promise something the
   backend cannot do. */
