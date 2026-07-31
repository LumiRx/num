// num-agents — the public agentic-AI platform for itsnum.com.
//
// An AI agent signs up, gets a key, and can create business profiles for the
// businesses it represents, post promotions/specials/events/ads, and submit
// information about businesses it does NOT represent. Reads of the directory are
// metered on the same tiers as the business dashboards; writes are free.
//
// The contract this file implements is PUBLISHED at https://itsnum.com/agents/.
// If you change a field name here, change it there in the same commit, or the
// site is lying to the agents reading it.
//
// Nothing here writes to `places` or `businesses`. Submissions land in
// num_ai_submissions with status 'pending' and stay invisible to travellers
// until a person at 5arz approves them. Agent-submitted, human-verified.

const SITE = "https://itsnum.com";

// reads per UTC day. Mirrors the dashboard tiers on /pricing/.
const QUOTA = { free: 100, bundle: 2000, pro: 20000, full: 200000 };

const RELATIONSHIPS = ["owner", "authorized_agent", "third_party"];
const KINDS = ["promo", "special", "event", "ad"];

// Accepted at submission time. Wider than num_business_profiles.vertical, which
// is missing 'cafe' and several others; the mapping happens at approval, by a
// person, so a legitimate cafe is not rejected at the door by a stale CHECK.
const VERTICALS = [
  "restaurant", "cafe", "bar", "hotel", "guesthouse", "hostel", "spa", "massage",
  "boat", "tour", "market", "shop", "transport", "taxi", "event", "clinic",
  "salon", "gym", "attraction", "nightclub", "other",
];

// The specific failure mode named in the published rules: an agent that does not
// represent a business guessing its address book from the domain name.
const GENERIC_LOCALPARTS = new Set([
  "info", "hello", "contact", "admin", "mail", "email", "enquiries", "enquiry",
  "inquiries", "sales", "office", "support", "team", "hi", "bookings", "reservations",
]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function err(code, message, status = 400, extra = {}) {
  // Every error names the field and says what to do instead. An agent cannot ask
  // a support desk what went wrong, so the response body is the documentation.
  return json({ error: code, message, docs: SITE + "/agents/", ...extra }, status);
}

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function newId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + "_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function newKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "numa_live_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function str(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(s.trim());
}

function hostOf(u) {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- auth + quota

async function authenticate(req, env) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(numa_live_[a-f0-9]{48})$/i);
  if (!m) return { error: err("unauthorized", "Send Authorization: Bearer numa_live_... Get a key from POST " + SITE + "/api/agent/signup", 401) };
  const hash = await sha256(m[1]);
  const a = await env.DB.prepare(
    "SELECT id, agent_name, operator_name, operator_email, homepage, key_prefix, tier, status, " +
    "created_at, last_seen_at, rotated_at FROM num_ai_agents WHERE key_hash=?1"
  ).bind(hash).first();
  if (!a) return { error: err("unauthorized", "That key is not recognised. Keys are shown once at signup; if it is lost, sign up again.", 401) };
  if (a.status === "banned") return { error: err("forbidden", "This agent has been suspended for breaking the submission rules at " + SITE + "/agents/. Contact info@5arz.com.", 403) };
  if (a.status === "paused") return { error: err("forbidden", "This agent is paused. Contact info@5arz.com.", 403) };

  // last_seen_at is worth having for spotting abandoned keys, but not worth an
  // extra round trip in front of every response — so it goes out afterwards,
  // and only when the stamp is more than an hour stale.
  if (env.__ctx) {
    const t = now();
    env.__ctx.waitUntil(env.DB.prepare(
      "UPDATE num_ai_agents SET last_seen_at=?1 WHERE id=?2 AND (last_seen_at IS NULL OR last_seen_at < ?3)"
    ).bind(t, a.id, t - 3600).run());
  }
  return { agent: a };
}

// Reads are metered, writes are not. Returns {ok, remaining, limit} and does the
// increment in the same statement so two concurrent requests cannot both pass on
// the last unit of quota.
async function meterRead(env, agent, cost = 1) {
  const limit = QUOTA[agent.tier] ?? QUOTA.free;
  const d = today();
  await env.DB.prepare(
    "INSERT INTO num_ai_usage (agent_id, day, reads, writes) VALUES (?1,?2,?3,0) " +
    "ON CONFLICT(agent_id, day) DO UPDATE SET reads = reads + ?3"
  ).bind(agent.id, d, cost).run();
  const row = await env.DB.prepare("SELECT reads FROM num_ai_usage WHERE agent_id=?1 AND day=?2")
    .bind(agent.id, d).first();
  const used = row ? row.reads : cost;
  return { ok: used <= limit, remaining: Math.max(0, limit - used), limit, used };
}

async function countWrite(env, agentId) {
  await env.DB.prepare(
    "INSERT INTO num_ai_usage (agent_id, day, reads, writes) VALUES (?1,?2,0,1) " +
    "ON CONFLICT(agent_id, day) DO UPDATE SET writes = writes + 1"
  ).bind(agentId, today()).run();
}

async function remainingHeader(env, agent) {
  const limit = QUOTA[agent.tier] ?? QUOTA.free;
  const row = await env.DB.prepare("SELECT reads FROM num_ai_usage WHERE agent_id=?1 AND day=?2")
    .bind(agent.id, today()).first();
  return {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(Math.max(0, limit - (row ? row.reads : 0))),
    "x-ratelimit-reset": String(Math.floor(Date.parse(today() + "T00:00:00Z") / 1000) + 86400),
  };
}

function quotaExceeded(limit) {
  return err(
    "quota_exceeded",
    "This agent has used its " + limit + " directory reads for today (UTC). Writing is always free — only reads are metered. " +
    "Higher read quotas are on the same tiers as the business dashboards: 2,000/day at $9.99, 20,000/day at $19.99, 200,000/day at $50. See " + SITE + "/pricing/",
    429,
    { limit, resets: "00:00 UTC" }
  );
}

// -------------------------------------------------------------------- signup

async function handleSignup(req, env) {
  let b;
  try { b = await req.json(); } catch { return err("bad_json", "Body must be JSON."); }

  const agent_name = str(b.agent_name, 120);
  const operator_name = str(b.operator_name, 160);
  const operator_email = str(b.operator_email, 160);
  const homepage = str(b.homepage, 300);
  const purpose = str(b.purpose, 600);

  if (!agent_name) return err("missing_field", "agent_name is required — the name of the agent itself, e.g. \"Acme Listings Bot\".");
  if (!operator_name) return err("missing_field", "operator_name is required — the human or company accountable for this agent.");
  if (!isEmail(operator_email)) return err("bad_field", "operator_email must be a working email address for a person who can answer questions about this agent's submissions.");
  if (!purpose || purpose.length < 12) return err("bad_field", "purpose is required and must actually describe what this agent will do, in at least a dozen characters.");

  // Signup guard. The IP is hashed with a salt so this table never holds an
  // address; without the salt a hash cannot be walked back to an IP.
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const salt = env.VISITOR_SALT || "num-agents-unsalted";
  const ipHash = await sha256(salt + "|agent-signup|" + ip);
  const g = await env.DB.prepare("SELECT count FROM num_ai_signup_guard WHERE ip_hash=?1 AND day=?2")
    .bind(ipHash, today()).first();
  if (g && g.count >= 5) {
    return err("rate_limited", "Too many agent signups from this address today. One key per agent is enough — reuse it, or rotate it at POST /api/agent/me/rotate.", 429);
  }

  const key = newKey();
  const id = newId("agent");
  await env.DB.prepare(
    "INSERT INTO num_ai_agents (id, key_hash, key_prefix, agent_name, operator_name, operator_email, homepage, purpose, tier, status, signup_ip_hash, created_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'free','active',?9,?10)"
  ).bind(id, await sha256(key), key.slice(0, 14), agent_name, operator_name, operator_email, homepage, purpose, ipHash, now()).run();
  await env.DB.prepare(
    "INSERT INTO num_ai_signup_guard (ip_hash, day, count) VALUES (?1,?2,1) " +
    "ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1"
  ).bind(ipHash, today()).run();

  return json({
    agent_id: id,
    api_key: key,
    key_shown_once: true,
    tier: "free",
    read_quota_per_day: QUOTA.free,
    writes: "unlimited",
    next: {
      submit_a_business: "POST " + SITE + "/api/agent/business",
      post_a_promotion: "POST " + SITE + "/api/agent/promo",
      search_the_directory: "GET " + SITE + "/api/agent/search?q=&city=&country=&limit=",
      mcp_server: SITE + "/mcp",
    },
    rules: SITE + "/agents/",
    note: "Store this key now. It is not recoverable. Every submission you make is reviewed by a person at 5arz before any traveller sees it.",
  }, 201);
}

/* -------------------------------------------------------------------------- *
 * POST /api/agent/business — submit a business.
 *
 * This is the heart of the contract published at /agents/. An agent may submit
 * for a business it owns, one it has been engaged by, or one it merely knows
 * about. All three land in num_ai_submissions with status 'pending'. None of
 * them touch `places` or `businesses`. A person at 5arz promotes a submission
 * across; until that happens no traveller sees it. That is the whole trust
 * model, and it is enforced here rather than promised in prose.
 * -------------------------------------------------------------------------- */
async function handleBusiness(req, env) {
  const a = await authenticate(req, env);
  if (a.error) return a.error;
  const agent = a.agent;

  let b;
  try { b = await req.json(); } catch { return err("bad_json", "Body must be JSON.", 400); }
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    return err("bad_json", "Body must be a JSON object.", 400);
  }

  const relationship = (str(b.relationship, 32) || "").toLowerCase();
  if (!RELATIONSHIPS.includes(relationship)) {
    return err("bad_relationship",
      "relationship must be one of: " + RELATIONSHIPS.join(", ") + ". Use 'owner' if you run this business, " +
      "'authorized_agent' if the owner engaged you, 'third_party' if you are adding a business you know of " +
      "but do not represent.", 400);
  }

  const name = str(b.name, 160);
  if (!name || name.length < 2) {
    return err("missing_name", "name is required — the trading name a traveller would see on the door.", 400);
  }

  const country = str(b.country, 64);
  const city = str(b.city, 80);
  if (!country) return err("missing_country", "country is required. Country name or ISO code, e.g. 'Thailand' or 'TH'.", 400);
  if (!city) return err("missing_city", "city is required — the city or town, e.g. 'Phuket' or 'Edinburgh'.", 400);

  let vertical = (str(b.vertical, 32) || "").toLowerCase();
  if (vertical && !VERTICALS.includes(vertical)) {
    return err("bad_vertical", "vertical '" + vertical + "' is not recognised. Use one of: " + VERTICALS.join(", ") + ".", 400);
  }
  if (!vertical) vertical = "other";

  const email = str(b.email, 160);
  if (email && !isEmail(email)) {
    return err("bad_email", "email is not a valid address. Leave the field out rather than guessing.", 400);
  }

  const website = str(b.website, 300);
  if (website && !hostOf(website)) {
    return err("bad_website", "website must be an absolute URL, e.g. https://example.com.", 400);
  }

  // The published rule reads: do not invent contact details, and specifically do
  // not guess an email address from a domain name. Enforced at the one place it
  // can actually be checked — an agent that does not represent the business
  // supplying info@<that business's own domain> is nearly always guessing.
  if (relationship === "third_party" && email && website) {
    const local = email.split("@")[0].toLowerCase();
    const eHost = (email.split("@")[1] || "").toLowerCase().replace(/^www\./, "");
    const wHost = (hostOf(website) || "").toLowerCase().replace(/^www\./, "");
    if (GENERIC_LOCALPARTS.has(local) && eHost && eHost === wHost) {
      return err("guessed_email",
        "'" + email + "' looks derived from the website domain rather than observed. On a third_party submission, " +
        "send the business without an email and NUM will contact the owner directly. Supply an email only if the " +
        "business has published it.", 422);
    }
  }

  const external_ref = str(b.external_ref, 120);
  const callback_url = str(b.callback_url, 300);
  if (callback_url && !hostOf(callback_url)) {
    return err("bad_callback_url", "callback_url must be an absolute https URL.", 400);
  }
  // The whole body is kept verbatim. Fields NUM does not model yet (hours,
  // languages, price_range, anything an agent invents) are not silently dropped;
  // the reviewer sees exactly what was sent.
  const payload = JSON.stringify(b);
  const ts = now();

  if (external_ref) {
    const prior = await env.DB.prepare(
      "SELECT id, status FROM num_ai_submissions WHERE agent_id=?1 AND external_ref=?2"
    ).bind(agent.id, external_ref).first();
    if (prior) {
      // Idempotent by (agent, external_ref): re-sending the same reference edits
      // the pending record rather than creating a second one. Once a person has
      // decided on it, it is frozen — an agent cannot quietly rewrite an
      // approved listing by replaying the reference.
      if (prior.status !== "pending") {
        return json({
          submission_id: prior.id,
          status: prior.status,
          duplicate: true,
          visible_to_travellers: prior.status === "approved",
          message: "This external_ref has already been reviewed. Send a new external_ref to propose a change.",
        }, 200, await remainingHeader(env, agent));
      }
      await env.DB.prepare(
        "UPDATE num_ai_submissions SET relationship=?1, name=?2, vertical=?3, country=?4, city=?5, " +
        "payload=?6, callback_url=?7, updated_at=?8 WHERE id=?9"
      ).bind(relationship, name, vertical, country, city, payload, callback_url || null, ts, prior.id).run();
      await countWrite(env, agent.id);
      return json({
        submission_id: prior.id,
        status: "pending_review",
        visible_to_travellers: false,
        updated: true,
        check: SITE + "/api/agent/submissions",
      }, 200, await remainingHeader(env, agent));
    }
  }

  const id = newId("sub");
  await env.DB.prepare(
    "INSERT INTO num_ai_submissions (id, agent_id, external_ref, relationship, name, vertical, country, city, " +
    "payload, status, callback_url, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',?10,?11,?12)"
  ).bind(id, agent.id, external_ref || null, relationship, name, vertical, country, city,
         payload, callback_url || null, ts, ts).run();
  await countWrite(env, agent.id);

  return json({
    submission_id: id,
    status: "pending_review",
    visible_to_travellers: false,
    relationship,
    review: "A person at 5arz reviews this. Most submissions are decided within one working day.",
    check: SITE + "/api/agent/submissions",
    callback: callback_url ? "NUM will POST the decision to " + callback_url : null,
  }, 201, await remainingHeader(env, agent));
}

// Accepts "2026-08-01" or a full ISO timestamp. Returns unix seconds, or null.
// A bare date is read as 00:00 UTC, which is what an agent writing "starts_at":
// "2026-08-01" means, and it keeps the comparison with ends_at honest.
function parseTime(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(v + "T00:00:00Z");
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/* -------------------------------------------------------------------------- *
 * POST /api/agent/promo — post a promotion, special, event or ad.
 *
 * A promotion has to hang off a business the same agent already submitted.
 * That is deliberate: it means every promo on NUM traces back to a named
 * operator and a reviewed business, and an agent cannot advertise into the
 * directory without first standing behind a venue.
 * -------------------------------------------------------------------------- */
async function handlePromo(req, env) {
  const a = await authenticate(req, env);
  if (a.error) return a.error;
  const agent = a.agent;

  let b;
  try { b = await req.json(); } catch { return err("bad_json", "Body must be JSON.", 400); }
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    return err("bad_json", "Body must be a JSON object.", 400);
  }

  // Find the business this promotion belongs to: either the submission_id NUM
  // returned, or the external_ref the agent used when it submitted the business.
  const submission_id = str(b.submission_id, 64);
  const external_ref = str(b.external_ref, 120);
  if (!submission_id && !external_ref) {
    return err("missing_business",
      "Send either submission_id (the id returned by POST /api/agent/business) or external_ref " +
      "(your own reference for that business). A promotion has to belong to a business you submitted.", 400);
  }

  const sub = submission_id
    ? await env.DB.prepare("SELECT id, status, business_id, name FROM num_ai_submissions WHERE id=?1 AND agent_id=?2")
        .bind(submission_id, agent.id).first()
    : await env.DB.prepare("SELECT id, status, business_id, name FROM num_ai_submissions WHERE external_ref=?1 AND agent_id=?2")
        .bind(external_ref, agent.id).first();

  if (!sub) {
    return err("unknown_business",
      "No business of yours matches that reference. Submit the business first with POST " + SITE +
      "/api/agent/business, then post the promotion against the submission_id it returns.", 404);
  }
  if (sub.status === "rejected" || sub.status === "withdrawn") {
    return err("business_not_live",
      "That business submission was " + sub.status + ", so a promotion cannot hang off it.", 409);
  }

  const kind = (str(b.kind, 16) || "promo").toLowerCase();
  if (!KINDS.includes(kind)) {
    return err("bad_kind", "kind must be one of: " + KINDS.join(", ") + ".", 400);
  }

  const title = str(b.title, 120);
  if (!title || title.length < 3) {
    return err("missing_title", "title is required — the one line a traveller reads, e.g. 'Two-for-one on the sunset boat, weekdays'.", 400);
  }
  const detail = str(b.detail, 1200);

  const starts_at = parseTime(b.starts_at);
  const ends_at = parseTime(b.ends_at);
  if (b.starts_at && starts_at === null) {
    return err("bad_starts_at", "starts_at could not be read as a date. Use 2026-08-01 or 2026-08-01T18:00:00Z.", 400);
  }
  if (b.ends_at && ends_at === null) {
    return err("bad_ends_at", "ends_at could not be read as a date. Use 2026-08-01 or 2026-08-01T18:00:00Z.", 400);
  }
  if (starts_at !== null && ends_at !== null && ends_at <= starts_at) {
    return err("bad_window", "ends_at must be after starts_at.", 400);
  }
  if (ends_at !== null && ends_at < now()) {
    return err("already_ended", "ends_at is in the past. NUM does not publish a promotion that has already closed.", 400);
  }

  let discount_pct = null;
  if (b.discount_pct !== undefined && b.discount_pct !== null && b.discount_pct !== "") {
    discount_pct = Number(b.discount_pct);
    if (!Number.isFinite(discount_pct) || discount_pct < 0 || discount_pct > 90) {
      // Capped at 90 on purpose. A number above that is nearly always a typo or
      // a headline that the venue will not honour, and NUM carries the
      // complaint, not the agent.
      return err("bad_discount", "discount_pct must be a number between 0 and 90.", 400);
    }
    discount_pct = Math.round(discount_pct);
  }

  const promo_ref = str(b.promo_ref, 120) || null;
  const ts = now();

  if (promo_ref) {
    const prior = await env.DB.prepare(
      "SELECT id, status FROM num_ai_promos WHERE agent_id=?1 AND external_ref=?2"
    ).bind(agent.id, promo_ref).first();
    if (prior && prior.status !== "pending") {
      return json({
        promo_id: prior.id, status: prior.status, duplicate: true,
        message: "This promo_ref has already been reviewed. Send a new promo_ref to propose a change.",
      }, 200, await remainingHeader(env, agent));
    }
    if (prior) {
      await env.DB.prepare(
        "UPDATE num_ai_promos SET kind=?1, title=?2, detail=?3, starts_at=?4, ends_at=?5, discount_pct=?6, " +
        "terms=?7, payload=?8, updated_at=?9 WHERE id=?10"
      ).bind(kind, title, detail || null, starts_at, ends_at, discount_pct, str(b.terms, 600) || null,
             JSON.stringify(b), ts, prior.id).run();
      await countWrite(env, agent.id);
      return json({ promo_id: prior.id, status: "pending_review", visible_to_travellers: false, updated: true },
        200, await remainingHeader(env, agent));
    }
  }

  const id = newId("promo");
  await env.DB.prepare(
    "INSERT INTO num_ai_promos (id, agent_id, submission_id, external_ref, business_id, kind, title, detail, " +
    "starts_at, ends_at, discount_pct, terms, payload, status, created_at, updated_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'pending',?14,?15)"
  ).bind(id, agent.id, sub.id, promo_ref, sub.business_id || null, kind, title, detail || null,
         starts_at, ends_at, discount_pct, str(b.terms, 600) || null, JSON.stringify(b), ts, ts).run();
  await countWrite(env, agent.id);

  return json({
    promo_id: id,
    submission_id: sub.id,
    business: sub.name,
    status: "pending_review",
    visible_to_travellers: false,
    review: "A person at 5arz reviews this. Most are decided within one working day.",
    check: SITE + "/api/agent/submissions",
  }, 201, await remainingHeader(env, agent));
}

/* -------------------------------------------------------------------------- *
 * GET /api/agent/submissions — what did I send, and what happened to it.
 *
 * Listing your own submissions is free. Charging an agent to find out whether
 * its own work was accepted would be a tax on doing the right thing.
 * -------------------------------------------------------------------------- */
async function handleSubmissions(req, env, url) {
  const a = await authenticate(req, env);
  if (a.error) return a.error;
  const agent = a.agent;

  const status = (str(url.searchParams.get("status"), 16) || "").toLowerCase();
  const STATUSES = ["pending", "approved", "rejected", "duplicate", "withdrawn"];
  if (status && !STATUSES.includes(status)) {
    return err("bad_status", "status must be one of: " + STATUSES.join(", ") + ".", 400);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  const where = status ? "WHERE agent_id=?1 AND status=?2" : "WHERE agent_id=?1";
  const binds = status ? [agent.id, status, limit, offset] : [agent.id, limit, offset];
  const n = status ? 3 : 2;

  const subs = await env.DB.prepare(
    "SELECT id, external_ref, relationship, name, vertical, country, city, status, business_id, place_id, " +
    "review_note, reviewed_at, created_at, updated_at FROM num_ai_submissions " + where +
    " ORDER BY created_at DESC LIMIT ?" + n + " OFFSET ?" + (n + 1)
  ).bind(...binds).all();

  const promos = await env.DB.prepare(
    "SELECT id, submission_id, external_ref, kind, title, starts_at, ends_at, discount_pct, status, " +
    "review_note, reviewed_at, created_at FROM num_ai_promos WHERE agent_id=?1 ORDER BY created_at DESC LIMIT 200"
  ).bind(agent.id).all();

  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM num_ai_submissions WHERE agent_id=?1 GROUP BY status"
  ).bind(agent.id).all();
  const tally = {};
  for (const r of counts.results || []) tally[r.status] = r.n;

  return json({
    agent_id: agent.id,
    counts: tally,
    businesses: (subs.results || []).map((r) => ({
      submission_id: r.id,
      external_ref: r.external_ref,
      relationship: r.relationship,
      name: r.name,
      vertical: r.vertical,
      country: r.country,
      city: r.city,
      status: r.status,
      visible_to_travellers: r.status === "approved",
      place_id: r.place_id,
      review_note: r.review_note,
      reviewed_at: r.reviewed_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    promotions: (promos.results || []).map((r) => ({
      promo_id: r.id,
      submission_id: r.submission_id,
      promo_ref: r.external_ref,
      kind: r.kind,
      title: r.title,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      discount_pct: r.discount_pct,
      status: r.status,
      visible_to_travellers: r.status === "approved",
      review_note: r.review_note,
      reviewed_at: r.reviewed_at,
      created_at: r.created_at,
    })),
    limit, offset,
  }, 200, await remainingHeader(env, agent));
}

/* -------------------------------------------------------------------------- *
 * GET  /api/agent/me         — who am I, what tier, how much quota is left.
 * POST /api/agent/me/rotate  — issue a new key and kill the old one.
 * -------------------------------------------------------------------------- */
async function handleMe(req, env) {
  const a = await authenticate(req, env);
  if (a.error) return a.error;
  const agent = a.agent;

  const u = await env.DB.prepare(
    "SELECT reads, writes FROM num_ai_usage WHERE agent_id=?1 AND day=?2"
  ).bind(agent.id, today()).first();
  const limit = QUOTA[agent.tier] || QUOTA.free;
  const reads = (u && u.reads) || 0;

  return json({
    agent_id: agent.id,
    agent_name: agent.agent_name,
    operator: { name: agent.operator_name, email: agent.operator_email, homepage: agent.homepage },
    key_prefix: agent.key_prefix,
    tier: agent.tier,
    status: agent.status,
    today: { reads, read_quota: limit, reads_remaining: Math.max(limit - reads, 0), writes: (u && u.writes) || 0 },
    writes: "unlimited",
    created_at: agent.created_at,
    last_seen_at: agent.last_seen_at,
    rotated_at: agent.rotated_at,
    upgrade: SITE + "/pricing/",
    rules: SITE + "/agents/",
  }, 200, await remainingHeader(env, agent));
}

async function handleRotate(req, env) {
  const a = await authenticate(req, env);
  if (a.error) return a.error;
  const agent = a.agent;

  // The old key stops working the moment this returns. There is no grace
  // window, because a grace window is exactly the thing you do not want when
  // the reason you are rotating is that the old key leaked.
  const key = newKey();
  await env.DB.prepare(
    "UPDATE num_ai_agents SET key_hash=?1, key_prefix=?2, rotated_at=?3 WHERE id=?4"
  ).bind(await sha256(key), key.slice(0, 14), now(), agent.id).run();

  return json({
    agent_id: agent.id,
    api_key: key,
    key_shown_once: true,
    old_key: "revoked",
    note: "Store this key now. It is not recoverable, and the previous key stopped working when this response was sent.",
  }, 200);
}

/* -------------------------------------------------------------------------- *
 * GET /api/agent/search — read the directory. This is the metered half.
 *
 * Free to write, paid to read. Writing improves the directory for everybody;
 * reading it at volume is the thing worth money.
 * -------------------------------------------------------------------------- */
async function handleSearch(req, env, url) {
  const a = await authenticate(req, env);
  if (a.error) return a.error;
  const agent = a.agent;

  const q = str(url.searchParams.get("q"), 80);
  const city = str(url.searchParams.get("city"), 80);
  const country = str(url.searchParams.get("country"), 64);
  const category = str(url.searchParams.get("category"), 60);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 50);

  if (!q && !city && !country && !category) {
    return err("no_filter",
      "Give at least one of q, city, country or category. An unfiltered read of 567,793 places is not a search.", 400);
  }

  const meter = await meterRead(env, agent, 1);
  if (!meter.ok) return quotaExceeded(meter.limit);

  // dest is a slug ('phuket', 'edinburgh'); country is ISO-2 ('GB', 'TH').
  // Agents write city names in prose, so normalise rather than reject.
  const where = [];
  const binds = [];
  if (q) { binds.push("%" + q + "%"); where.push("(name LIKE ?" + binds.length + " COLLATE NOCASE)"); }
  if (city) {
    binds.push(city.toLowerCase().replace(/[\s_]+/g, "-"));
    binds.push("%" + city + "%");
    where.push("(dest = ?" + (binds.length - 1) + " OR area LIKE ?" + binds.length + " COLLATE NOCASE)");
  }
  if (country) {
    binds.push(country.length === 2 ? country.toUpperCase() : country);
    where.push("(country = ?" + binds.length + ")");
  }
  if (category) { binds.push("%" + category + "%"); where.push("(category LIKE ?" + binds.length + " COLLATE NOCASE)"); }

  binds.push(limit);
  const rows = await env.DB.prepare(
    "SELECT id, name, category, dest, area, country, address, phone, website, lat, lng, rating, reviews, status " +
    "FROM places WHERE " + where.join(" AND ") +
    " ORDER BY (reviews IS NULL), reviews DESC LIMIT ?" + binds.length
  ).bind(...binds).all();

  return json({
    query: { q: q || null, city: city || null, country: country || null, category: category || null, limit },
    count: (rows.results || []).length,
    places: (rows.results || []).map((r) => ({
      place_id: r.id,
      name: r.name,
      category: r.category,
      destination: r.dest,
      area: r.area,
      country: r.country,
      address: r.address,
      phone: r.phone,
      website: r.website,
      lat: r.lat,
      lng: r.lng,
      rating: r.rating,
      reviews: r.reviews,
      claimed: r.status === "claimed",
      url: SITE + "/" + r.dest + "/",
    })),
    attribution: "NUM, by 5arz — " + SITE,
    quota: { limit: meter.limit, used: meter.used, remaining: meter.remaining },
  }, 200, await remainingHeader(env, agent));
}

/* -------------------------------------------------------------------------- *
 * GET /api/agent/business/{id} — one place, in full.
 * -------------------------------------------------------------------------- */
async function handleBusinessGet(req, env, id) {
  const a = await authenticate(req, env);
  if (a.error) return a.error;
  const agent = a.agent;

  const meter = await meterRead(env, agent, 1);
  if (!meter.ok) return quotaExceeded(meter.limit);

  const r = await env.DB.prepare(
    "SELECT id, name, name_local, category, cuisine, dest, area, country, region, address, phone, website, " +
    "email, hours, lat, lng, rating, reviews, status FROM places WHERE id=?1"
  ).bind(id).first();
  if (!r) return err("not_found", "No place with id '" + id + "'.", 404);

  return json({
    place_id: r.id,
    name: r.name,
    name_local: r.name_local,
    category: r.category,
    cuisine: r.cuisine,
    destination: r.dest,
    area: r.area,
    country: r.country,
    region: r.region,
    address: r.address,
    phone: r.phone,
    website: r.website,
    email: r.email,
    hours: r.hours,
    lat: r.lat,
    lng: r.lng,
    rating: r.rating,
    reviews: r.reviews,
    claimed: r.status === "claimed",
    url: SITE + "/" + r.dest + "/",
    attribution: "NUM, by 5arz — " + SITE,
  }, 200, await remainingHeader(env, agent));
}

/* -------------------------------------------------------------------------- *
 * /mcp — Model Context Protocol, JSON-RPC 2.0 over streamable HTTP.
 *
 * The five tools published at /agents/. Each one dispatches into the same HTTP
 * handler above rather than reimplementing the validation, so the MCP surface
 * and the REST surface cannot drift apart — there is exactly one set of rules.
 * -------------------------------------------------------------------------- */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const MCP_TOOLS = [
  {
    name: "num_search_places",
    description:
      "Search NUM's directory of 567,793 verified places across 77 destinations in 38 countries — restaurants, " +
      "bars, hotels, spas, tours, shops. Give at least one of q, city, country or category. Counts against your " +
      "daily read quota.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free text matched against the place name." },
        city: { type: "string", description: "City or destination, e.g. 'Phuket', 'Edinburgh', 'Bangkok', 'London'." },
        country: { type: "string", description: "ISO-2 country code, e.g. 'TH' or 'GB'." },
        category: { type: "string", description: "e.g. 'Restaurant', 'Bar', 'Hotel', 'Spa', 'Tour'." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results, default 20, cap 50." },
      },
    },
  },
  {
    name: "num_get_place",
    description: "Full record for one place by place_id. Counts against your daily read quota.",
    inputSchema: {
      type: "object",
      properties: { place_id: { type: "string", description: "The place_id returned by num_search_places." } },
      required: ["place_id"],
    },
  },
  {
    name: "num_submit_business",
    description:
      "Submit a business to NUM. Free and unmetered. The submission is reviewed by a person at 5arz before any " +
      "traveller sees it — nothing you send goes live automatically. Say honestly whether you own the business, " +
      "were engaged by it, or are simply adding one you know of. Never invent contact details.",
    inputSchema: {
      type: "object",
      properties: {
        relationship: { type: "string", enum: ["owner", "authorized_agent", "third_party"],
          description: "'owner' if you run it, 'authorized_agent' if the owner engaged you, 'third_party' if you neither own nor represent it." },
        external_ref: { type: "string", description: "Your own reference for this business. Re-sending it edits the pending submission instead of creating a duplicate." },
        name: { type: "string", description: "Trading name as it appears on the door." },
        vertical: { type: "string", description: "restaurant, cafe, bar, hotel, spa, boat, tour, shop, transport, clinic, gym, attraction, other…" },
        country: { type: "string" },
        city: { type: "string" },
        address: { type: "string" },
        phone: { type: "string" },
        email: { type: "string", description: "Only if the business has published it. Do not derive it from the domain name." },
        website: { type: "string" },
        description: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        price_range: { type: "string" },
        hours: { type: "string" },
        callback_url: { type: "string", description: "NUM POSTs the review decision here." },
      },
      required: ["relationship", "name", "country", "city"],
    },
  },
  {
    name: "num_submit_promo",
    description:
      "Post a promotion, special, event or ad against a business you already submitted. Free and unmetered, and " +
      "reviewed by a person before it is shown to anyone.",
    inputSchema: {
      type: "object",
      properties: {
        submission_id: { type: "string", description: "From num_submit_business." },
        external_ref: { type: "string", description: "Alternative to submission_id: the reference you used for the business." },
        promo_ref: { type: "string", description: "Your own reference for this promotion, for idempotent edits." },
        kind: { type: "string", enum: ["promo", "special", "event", "ad"] },
        title: { type: "string", description: "The single line a traveller reads." },
        detail: { type: "string" },
        starts_at: { type: "string", description: "2026-08-01 or 2026-08-01T18:00:00Z." },
        ends_at: { type: "string" },
        discount_pct: { type: "integer", minimum: 0, maximum: 90 },
        terms: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "num_list_submissions",
    description: "Everything you have submitted and what a reviewer decided. Free and unmetered.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected", "duplicate", "withdrawn"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
    },
  },
];

// Each MCP tool call is turned into the equivalent HTTP request and run through
// the handler above. One implementation, one set of rules, one place to fix.
async function callTool(name, args, req, env) {
  const auth = req.headers.get("authorization") || "";
  const post = (path, body) => new Request(SITE + path, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json", "cf-connecting-ip": req.headers.get("cf-connecting-ip") || "" },
    body: JSON.stringify(body || {}),
  });
  const get = (path) => new Request(SITE + path, { headers: { authorization: auth } });

  if (name === "num_search_places") {
    const u = new URL(SITE + "/api/agent/search");
    for (const k of ["q", "city", "country", "category", "limit"]) {
      if (args[k] !== undefined && args[k] !== null && args[k] !== "") u.searchParams.set(k, String(args[k]));
    }
    return handleSearch(get("/api/agent/search"), env, u);
  }
  if (name === "num_get_place") {
    const id = str(args.place_id, 80);
    if (!id) return err("missing_place_id", "place_id is required.", 400);
    return handleBusinessGet(get("/api/agent/business/" + id), env, id);
  }
  if (name === "num_submit_business") return handleBusiness(post("/api/agent/business", args), env);
  if (name === "num_submit_promo") return handlePromo(post("/api/agent/promo", args), env);
  if (name === "num_list_submissions") {
    const u = new URL(SITE + "/api/agent/submissions");
    for (const k of ["status", "limit", "offset"]) {
      if (args[k] !== undefined && args[k] !== null && args[k] !== "") u.searchParams.set(k, String(args[k]));
    }
    return handleSubmissions(get("/api/agent/submissions"), env, u);
  }
  return err("unknown_tool", "No tool named '" + name + "'.", 404);
}

function rpcOk(id, result) {
  return json({ jsonrpc: "2.0", id: id === undefined ? null : id, result });
}
function rpcErr(id, code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return json({ jsonrpc: "2.0", id: id === undefined ? null : id, error: e });
}

async function handleRpc(msg, req, env) {
  const { id, method, params } = msg || {};

  if (method === "initialize") {
    const want = (params && params.protocolVersion) || "";
    return rpcOk(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "num", title: "NUM — travel directory by 5arz", version: "1.0.0" },
      instructions:
        "NUM is a directory of verified places, run by 5arz. Reads are metered against your daily quota; writes " +
        "are free. Every business or promotion you submit is reviewed by a person before a traveller sees it, so " +
        "expect status 'pending_review' rather than an immediate listing. Say honestly whether you own a business, " +
        "represent it, or are simply adding one you know of, and never invent contact details — in particular, do " +
        "not guess an email address from a domain name. The full rules are at " + SITE + "/agents/.",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return new Response(null, { status: 202, headers: CORS });   // notifications get no body
  }
  if (method === "ping") return rpcOk(id, {});
  if (method === "tools/list") return rpcOk(id, { tools: MCP_TOOLS });
  if (method === "resources/list") return rpcOk(id, { resources: [] });
  if (method === "prompts/list") return rpcOk(id, { prompts: [] });

  if (method === "tools/call") {
    const name = (params && params.name) || "";
    const args = (params && params.arguments) || {};
    if (!MCP_TOOLS.some((t) => t.name === name)) {
      return rpcErr(id, -32602, "Unknown tool: " + name);
    }
    let res, body;
    try {
      res = await callTool(name, args, req, env);
      body = await res.json();
    } catch (e) {
      return rpcErr(id, -32603, "Tool failed: " + (e && e.message ? e.message : String(e)));
    }
    // A rejected submission is a normal outcome the model should read and act
    // on, not a transport failure — so it comes back as tool content with
    // isError set, never as a JSON-RPC error.
    return rpcOk(id, {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError: res.status >= 400,
    });
  }

  return rpcErr(id, -32601, "Method not found: " + String(method));
}

async function handleMcp(req, env) {
  if (req.method === "GET") {
    // Streamable HTTP uses GET to open a server-to-client SSE stream. Every NUM
    // tool is request/response, so there is nothing to push and 405 is the
    // honest answer rather than an idle stream the client waits on.
    return new Response(JSON.stringify({ error: "sse_not_offered", message: "POST JSON-RPC to this URL." }), {
      status: 405, headers: { ...CORS, "content-type": "application/json", allow: "POST, OPTIONS" },
    });
  }
  let msg;
  try { msg = await req.json(); } catch { return rpcErr(null, -32700, "Parse error: body is not JSON."); }

  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) {
      const r = await handleRpc(m, req, env);
      if (r.status !== 202) out.push(await r.json());
    }
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(out);
  }
  return handleRpc(msg, req, env);
}

/* -------------------------------------------------------------------------- *
 * Discovery. These four URLs are how an agent finds NUM without being told.
 * -------------------------------------------------------------------------- */
function mcpManifest() {
  return {
    name: "num",
    description: "NUM — a directory of verified places for travellers, run by 5arz. Search it, and submit businesses and promotions to it.",
    version: "1.0.0",
    transport: "streamable-http",
    url: SITE + "/mcp",
    authentication: { type: "bearer", token_prefix: "numa_live_", signup: SITE + "/api/agent/signup", docs: SITE + "/agents/" },
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    config_example: {
      mcpServers: { num: { type: "http", url: SITE + "/mcp", headers: { Authorization: "Bearer numa_live_..." } } },
    },
  };
}

function aiPlugin() {
  return {
    schema_version: "v1",
    name_for_human: "NUM",
    name_for_model: "num",
    description_for_human: "Search verified places for travellers, and list your business.",
    description_for_model:
      "NUM is a directory of 567,793 verified places across 77 destinations in 38 countries, operated by 5arz. " +
      "Use it to find restaurants, bars, hotels, spas, tours and shops in a city, and to submit a business or a " +
      "promotion on an operator's behalf. Reads are metered; writes are free. Everything submitted is reviewed by " +
      "a person before it is shown to travellers.",
    auth: { type: "user_http", authorization_type: "bearer" },
    api: { type: "openapi", url: SITE + "/openapi.json" },
    contact_email: "info@5arz.com",
    legal_info_url: SITE + "/terms/",
  };
}

function openapi() {
  const P = (name, where, type, desc) => ({ name, in: where, schema: { type }, description: desc });
  const okJson = (d) => ({ "200": { description: d, content: { "application/json": { schema: { type: "object" } } } } });
  return {
    openapi: "3.1.0",
    info: {
      title: "NUM Agent API",
      version: "1.0.0",
      summary: "Search a directory of verified places, and submit businesses and promotions to it.",
      description:
        "NUM is operated by 5arz. Writes are free and unmetered; reads are metered against a daily quota. Every " +
        "submission is reviewed by a person before a traveller sees it — an approved-looking response is never " +
        "returned automatically. Full rules, quotas and pricing: " + SITE + "/agents/",
      contact: { name: "5arz", email: "info@5arz.com", url: SITE + "/agents/" },
      termsOfService: SITE + "/terms/",
    },
    servers: [{ url: SITE }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "The numa_live_… key returned by POST /api/agent/signup." } },
    },
    paths: {
      "/api/agent/signup": {
        post: {
          summary: "Register an agent and receive an API key",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object",
            required: ["agent_name", "operator_name", "operator_email", "purpose"],
            properties: {
              agent_name: { type: "string" }, operator_name: { type: "string" },
              operator_email: { type: "string", format: "email" }, homepage: { type: "string" },
              purpose: { type: "string", description: "One sentence on what this agent does. At least 12 characters." },
            },
          } } } },
          responses: { "201": { description: "Key issued once and never again shown.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/agent/business": {
        post: {
          summary: "Submit a business for review",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object",
            required: ["relationship", "name", "country", "city"],
            properties: {
              relationship: { type: "string", enum: RELATIONSHIPS },
              external_ref: { type: "string" }, name: { type: "string" }, vertical: { type: "string", enum: VERTICALS },
              country: { type: "string" }, city: { type: "string" }, address: { type: "string" },
              phone: { type: "string" }, email: { type: "string" }, website: { type: "string" },
              description: { type: "string" }, languages: { type: "array", items: { type: "string" } },
              price_range: { type: "string" }, hours: { type: "string" }, callback_url: { type: "string" },
            },
          } } } },
          responses: { "201": { description: "Accepted, pending human review.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/agent/promo": {
        post: {
          summary: "Post a promotion, special, event or ad against a business you submitted",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object",
            required: ["title"],
            properties: {
              submission_id: { type: "string" }, external_ref: { type: "string" }, promo_ref: { type: "string" },
              kind: { type: "string", enum: KINDS }, title: { type: "string" }, detail: { type: "string" },
              starts_at: { type: "string" }, ends_at: { type: "string" },
              discount_pct: { type: "integer", minimum: 0, maximum: 90 }, terms: { type: "string" },
            },
          } } } },
          responses: { "201": { description: "Accepted, pending human review.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/agent/submissions": {
        get: {
          summary: "List your submissions and their review status",
          parameters: [P("status", "query", "string"), P("limit", "query", "integer"), P("offset", "query", "integer")],
          responses: okJson("Your submissions and promotions."),
        },
      },
      "/api/agent/search": {
        get: {
          summary: "Search the directory (metered)",
          parameters: [
            P("q", "query", "string", "Free text matched against the place name."),
            P("city", "query", "string", "Destination or city, e.g. Phuket."),
            P("country", "query", "string", "ISO-2 code, e.g. TH."),
            P("category", "query", "string"), P("limit", "query", "integer", "Default 20, cap 50."),
          ],
          responses: okJson("Matching places."),
        },
      },
      "/api/agent/business/{place_id}": {
        get: {
          summary: "One place in full (metered)",
          parameters: [{ name: "place_id", in: "path", required: true, schema: { type: "string" } }],
          responses: okJson("The place."),
        },
      },
      "/api/agent/me": { get: { summary: "Your agent record and today's quota", responses: okJson("Agent record.") } },
      "/api/agent/me/rotate": { post: { summary: "Issue a new key and revoke the old one immediately", responses: okJson("New key, shown once.") } },
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Router.
 * -------------------------------------------------------------------------- */
const INDEX = {
  service: "NUM Agent API",
  operator: "5arz Inc",
  docs: SITE + "/agents/",
  description:
    "A directory of 567,793 verified places across 77 destinations in 38 countries. Search it, and submit " +
    "businesses and promotions to it. Writes are free; reads are metered. Every submission is reviewed by a " +
    "person at 5arz before a traveller sees it.",
  start_here: "POST " + SITE + "/api/agent/signup",
  endpoints: {
    "POST /api/agent/signup": "Register and receive a key. No auth.",
    "POST /api/agent/business": "Submit a business for review. Free.",
    "POST /api/agent/promo": "Post a promotion, special, event or ad. Free.",
    "GET /api/agent/submissions": "Your submissions and their review status. Free.",
    "GET /api/agent/search": "Search the directory. Metered.",
    "GET /api/agent/business/{place_id}": "One place in full. Metered.",
    "GET /api/agent/me": "Your record and today's quota.",
    "POST /api/agent/me/rotate": "New key; the old one dies immediately.",
  },
  mcp: { url: SITE + "/mcp", transport: "streamable-http", manifest: SITE + "/.well-known/mcp.json" },
  openapi: SITE + "/openapi.json",
  read_quotas: { free: QUOTA.free, "$9.99/mo": QUOTA.bundle, "$19.99/mo": QUOTA.pro, "$50/mo": QUOTA.full },
  contact: "info@5arz.com",
};

export default {
  async fetch(req, env, ctx) {
    // Stashed so authenticate() can defer its last_seen_at write past the
    // response. Nothing else reads it.
    env.__ctx = ctx;

    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const m = req.method.toUpperCase();

    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      // ---- discovery, all public ----
      if (p === "/openapi.json") return json(openapi());
      if (p === "/.well-known/ai-plugin.json") return json(aiPlugin());
      if (p === "/.well-known/mcp.json") return json(mcpManifest());
      if (p === "/api/agent" || p === "/api/agents") return json(INDEX);

      // ---- MCP ----
      if (p === "/mcp") return handleMcp(req, env);

      // ---- REST ----
      if (p === "/api/agent/signup") {
        if (m !== "POST") return err("method_not_allowed", "POST to this URL.", 405);
        return handleSignup(req, env);
      }
      if (p === "/api/agent/business") {
        if (m !== "POST") return err("method_not_allowed", "POST to submit a business. To read one, GET /api/agent/business/{place_id}.", 405);
        return handleBusiness(req, env);
      }
      if (p.startsWith("/api/agent/business/")) {
        if (m !== "GET") return err("method_not_allowed", "GET this URL.", 405);
        return handleBusinessGet(req, env, decodeURIComponent(p.slice("/api/agent/business/".length)));
      }
      if (p === "/api/agent/promo" || p === "/api/agent/promos") {
        if (m !== "POST") return err("method_not_allowed", "POST to this URL. To see promotions you posted, GET /api/agent/submissions.", 405);
        return handlePromo(req, env);
      }
      if (p === "/api/agent/submissions") {
        if (m !== "GET") return err("method_not_allowed", "GET this URL.", 405);
        return handleSubmissions(req, env, url);
      }
      if (p === "/api/agent/search") {
        if (m !== "GET") return err("method_not_allowed", "GET this URL.", 405);
        return handleSearch(req, env, url);
      }
      if (p === "/api/agent/me/rotate") {
        if (m !== "POST") return err("method_not_allowed", "POST to rotate your key.", 405);
        return handleRotate(req, env);
      }
      if (p === "/api/agent/me") {
        if (m !== "GET") return err("method_not_allowed", "GET this URL.", 405);
        return handleMe(req, env);
      }

      return err("not_found", "No such endpoint. The list is at " + SITE + "/api/agent, and the rules at " + SITE + "/agents/.", 404);
    } catch (e) {
      // Never leak a stack to an agent; log it and say plainly that it is ours.
      console.error("num-agents", p, e && e.stack ? e.stack : String(e));
      return err("server_error", "Something broke on NUM's side, not yours. Retry, and if it persists mail info@5arz.com.", 500);
    }
  },
};
