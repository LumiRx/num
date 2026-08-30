/**
 * OAuth 2.1 authorization server + resource-server helpers for the NUM MCP server.
 *
 * Implements the subset the MCP authorization spec (2025-06-18) requires:
 *   RFC 9728  Protected Resource Metadata      → /.well-known/oauth-protected-resource
 *   RFC 8414  Authorization Server Metadata    → /.well-known/oauth-authorization-server
 *   RFC 7591  Dynamic Client Registration      → POST /oauth/register
 *   OAuth 2.1 authorization code + PKCE S256   → /oauth/authorize, /oauth/token
 *   RFC 8707  Resource indicators              → audience binding on every token
 *   RFC 7009  Revocation                       → POST /oauth/revoke
 *
 * Identity comes from the existing accounts/sessions tables (magic-link, num_session
 * cookie) which the accounts Worker owns. Both Workers bind the same D1, so this
 * reads the session directly rather than calling across.
 *
 * Self-contained on purpose: worker.js imports this, so importing back would make a
 * cycle. The few helpers here are duplicated deliberately.
 */

const SITE = "https://itsnum.com";
const RESOURCE = SITE + "/mcp";
const SCOPES = ["num.read", "num.write"];
const ACCESS_TTL = 3600;             // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL = 60;                 // 60 seconds, single use

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

const now = () => Math.floor(Date.now() / 1000);

function j(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}
function oaErr(code, desc, status = 400) {
  return j({ error: code, error_description: desc }, status);
}
function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256b64url(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function rand(prefix, bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cookies(req) {
  const out = {};
  (req.headers.get("cookie") || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/** The 401 every unauthenticated tool call must return (RFC 9728 §5.1). */
export function unauthorized(message) {
  return j(
    { error: "unauthorized", message, docs: SITE + "/agents/" },
    401,
    {
      "www-authenticate":
        `Bearer realm="NUM", resource_metadata="${SITE}/.well-known/oauth-protected-resource"`,
    },
  );
}

/**
 * Resource-server side. Validates an OAuth access token and returns the agent row it
 * is bound to, or null. Audience is checked against this server specifically — the
 * spec forbids accepting tokens minted for anything else.
 */
export async function verifyAccessToken(token, env) {
  const row = await env.DB.prepare(
    "SELECT token_sha256, kind, client_id, account_id, agent_id, audience, scope, expires_at, revoked " +
    "FROM num_oauth_tokens WHERE token_sha256=?1"
  ).bind(await sha256hex(token)).first();

  if (!row) return null;
  if (row.kind !== "access") return null;
  if (row.revoked) return null;
  if (Number(row.expires_at) <= now()) return null;
  if (row.audience !== RESOURCE && row.audience !== SITE) return null;
  if (!row.agent_id) return null;

  return env.DB.prepare(
    "SELECT id, agent_name, operator_name, operator_email, homepage, key_prefix, tier, status, " +
    "created_at, last_seen_at, rotated_at FROM num_ai_agents WHERE id=?1"
  ).bind(row.agent_id).first();
}

async function sessionAccount(req, env) {
  const tok = cookies(req).num_session;
  if (!tok) return null;
  const s = await env.DB.prepare("SELECT account_id, expires_at FROM sessions WHERE token=?1").bind(tok).first();
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const a = await env.DB.prepare("SELECT id, email, display_name, status FROM accounts WHERE id=?1")
    .bind(s.account_id).first();
  return a && a.status === "active" ? a : null;
}

/** Every account gets exactly one OAuth-provisioned agent row; it carries the quota. */
async function agentForAccount(account, env) {
  const existing = await env.DB.prepare(
    "SELECT id FROM num_ai_agents WHERE operator_email=?1 AND key_prefix='oauth' LIMIT 1"
  ).bind(account.email).first();
  if (existing) return existing.id;

  const id = "agent_" + (await sha256hex("oauth|" + account.id)).slice(0, 24);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO num_ai_agents (id, key_hash, key_prefix, agent_name, operator_name, " +
    "operator_email, homepage, purpose, tier, status, signup_ip_hash, created_at) " +
    "VALUES (?1,?2,'oauth',?3,?4,?5,'','Authorized through OAuth from a connected MCP client.','free','active','',?6)"
  ).bind(
    id, "oauth:" + id,
    (account.display_name || account.email) + " (OAuth)",
    account.display_name || account.email,
    account.email, now(),
  ).run();
  return id;
}

function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1");
  } catch { return false; }
}

/* ------------------------------------------------------------------ metadata */

function protectedResourceMetadata() {
  return j({
    resource: RESOURCE,
    authorization_servers: [SITE],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "NUM — travel places directory",
    resource_documentation: "https://github.com/LumiRx/num-mcp",
  });
}

function authServerMetadata() {
  return j({
    issuer: SITE,
    authorization_endpoint: SITE + "/oauth/authorize",
    token_endpoint: SITE + "/oauth/token",
    registration_endpoint: SITE + "/oauth/register",
    revocation_endpoint: SITE + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SCOPES,
    service_documentation: "https://github.com/LumiRx/num-mcp",
  });
}

/* -------------------------------------------------------------- registration */

async function register(req, env) {
  let b;
  try { b = await req.json(); } catch { return oaErr("invalid_client_metadata", "Body must be JSON."); }

  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length) return oaErr("invalid_redirect_uri", "redirect_uris is required and must be a non-empty array.");
  for (const u of uris) {
    if (!validRedirect(u)) {
      return oaErr("invalid_redirect_uri", "Redirect URIs must be https, or http on localhost. Rejected: " + u);
    }
  }

  const method = b.token_endpoint_auth_method || "none";
  const clientId = rand("numc_", 16);
  let secret = null, secretHash = null;
  if (method !== "none") { secret = rand("nums_", 32); secretHash = await sha256hex(secret); }

  const created = now();
  await env.DB.prepare(
    "INSERT INTO num_oauth_clients (client_id, client_secret_sha256, client_name, redirect_uris, " +
    "grant_types, response_types, token_endpoint_auth_method, scope, client_uri, software_id, " +
    "software_version, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
  ).bind(
    clientId, secretHash, String(b.client_name || "Unnamed MCP client").slice(0, 160),
    JSON.stringify(uris),
    JSON.stringify(b.grant_types || ["authorization_code", "refresh_token"]),
    JSON.stringify(b.response_types || ["code"]),
    method, b.scope || SCOPES.join(" "),
    b.client_uri || null, b.software_id || null, b.software_version || null, created,
  ).run();

  const out = {
    client_id: clientId,
    client_id_issued_at: created,
    redirect_uris: uris,
    grant_types: b.grant_types || ["authorization_code", "refresh_token"],
    response_types: b.response_types || ["code"],
    token_endpoint_auth_method: method,
    scope: b.scope || SCOPES.join(" "),
    client_name: b.client_name || "Unnamed MCP client",
  };
  if (secret) { out.client_secret = secret; out.client_secret_expires_at = 0; }
  return j(out, 201);
}

/* --------------------------------------------------------------- authorize */

function consentPage({ client, account, params }) {
  const scopes = (params.scope || SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  const rows = scopes.map((s) => {
    const label = s === "num.write"
      ? "Submit businesses and promotions on your behalf (each one is reviewed by a person before it appears)"
      : s === "num.read"
        ? "Search NUM's directory of 2.5 million places, against your daily quota"
        : s;
    return `<li><code>${esc(s)}</code><span>${esc(label)}</span></li>`;
  }).join("");

  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
    .map((k) => params[k] ? `<input type="hidden" name="${k}" value="${esc(params[k])}">` : "").join("");

  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize · NUM</title>
<link rel="icon" href="/favicon.ico">
<style>
:root{--bg:#faf7f4;--ink:#14201c;--dim:#5d6b66;--line:#e2dbd3;--accent:#0d9488;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0e1513;--ink:#e9efec;--dim:#93a29c;--line:#243330;--card:#141d1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:460px;width:100%;background:var(--card);border:1px solid var(--line);
border-radius:16px;padding:30px}
h1{font-size:20px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--dim);font-size:14.5px;margin:0 0 20px}
ul{list-style:none;padding:0;margin:0 0 20px;border-top:1px solid var(--line)}
li{padding:13px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:3px}
li code{font-size:12px;color:var(--accent);font-weight:600}
li span{font-size:14px;color:var(--dim)}
.who{font-size:13px;color:var(--dim);margin:0 0 20px;padding:11px 13px;background:var(--bg);
border:1px solid var(--line);border-radius:9px}
.row{display:flex;gap:10px}
button{flex:1;padding:12px;border-radius:10px;font:inherit;font-weight:600;font-size:15px;cursor:pointer;
border:1px solid var(--line);background:transparent;color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><div class="card">
<h1>Authorize ${esc(client.client_name)}</h1>
<p class="sub">It is asking to connect to your NUM account.</p>
<ul>${rows}</ul>
<p class="who">Signed in as <strong>${esc(account.email)}</strong>. Connecting from
<code>${esc(new URL(params.redirect_uri).origin)}</code>.</p>
<form method="POST" action="/oauth/authorize">${hidden}
<div class="row">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="allow" class="primary">Allow</button>
</div></form>
</div></body></html>`);
}

function signinInterstitial(returnTo) {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · NUM</title>
<link rel="icon" href="/favicon.ico">
<style>
:root{--bg:#faf7f4;--ink:#14201c;--dim:#5d6b66;--line:#e2dbd3;--accent:#0d9488;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0e1513;--ink:#e9efec;--dim:#93a29c;--line:#243330;--card:#141d1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:430px;width:100%;background:var(--card);border:1px solid var(--line);
border-radius:16px;padding:30px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:var(--dim);font-size:14.5px;margin:0 0 20px}
a{display:inline-block;padding:12px 22px;border-radius:10px;background:var(--accent);color:#fff;
text-decoration:none;font-weight:600}
</style></head><body><div class="card">
<h1>Sign in to continue</h1>
<p>NUM needs to know who you are before it can authorize this connection.
Sign in, then return to this page and reload it.</p>
<a href="/signin/?next=${encodeURIComponent(returnTo)}">Sign in to NUM</a>
</div></body></html>`, 401);
}

async function authorizeGet(url, req, env) {
  const q = Object.fromEntries(url.searchParams);
  if (q.response_type !== "code") {
    return oaErr("unsupported_response_type", "Only response_type=code is supported.");
  }
  if (!q.client_id) return oaErr("invalid_request", "client_id is required.");

  const client = await env.DB.prepare(
    "SELECT client_id, client_name, redirect_uris FROM num_oauth_clients WHERE client_id=?1"
  ).bind(q.client_id).first();
  if (!client) return oaErr("invalid_client", "Unknown client_id. Register at POST /oauth/register.", 401);

  // Redirect URIs are matched exactly — never by prefix — per the open-redirection
  // requirement in the spec.
  const allowed = JSON.parse(client.redirect_uris || "[]");
  if (!q.redirect_uri || !allowed.includes(q.redirect_uri)) {
    return oaErr("invalid_request", "redirect_uri does not exactly match a registered value for this client.");
  }
  if (!q.code_challenge || q.code_challenge_method !== "S256") {
    return oaErr("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  }
  if (q.resource && q.resource !== RESOURCE && q.resource !== SITE) {
    return oaErr("invalid_target", "resource must be " + RESOURCE + ".");
  }

  const account = await sessionAccount(req, env);
  if (!account) return signinInterstitial(url.pathname + url.search);

  return consentPage({ client, account, params: q });
}

async function authorizePost(req, env) {
  const form = await req.formData();
  const q = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));

  const client = await env.DB.prepare(
    "SELECT client_id, redirect_uris FROM num_oauth_clients WHERE client_id=?1"
  ).bind(q.client_id).first();
  if (!client) return oaErr("invalid_client", "Unknown client_id.", 401);

  const allowed = JSON.parse(client.redirect_uris || "[]");
  if (!allowed.includes(q.redirect_uri)) return oaErr("invalid_request", "redirect_uri mismatch.");

  const account = await sessionAccount(req, env);
  if (!account) return oaErr("access_denied", "Session expired. Start the authorization again.", 401);

  const back = new URL(q.redirect_uri);
  if (q.state) back.searchParams.set("state", q.state);

  if (q.decision !== "allow") {
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "The user denied the request.");
    return Response.redirect(back.toString(), 302);
  }

  const agentId = await agentForAccount(account, env);
  const code = rand("numac_", 32);
  await env.DB.prepare(
    "INSERT INTO num_oauth_codes (code_sha256, client_id, account_id, agent_id, redirect_uri, " +
    "code_challenge, code_challenge_method, resource, scope, expires_at, used, created_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,'S256',?7,?8,?9,0,?10)"
  ).bind(
    await sha256hex(code), q.client_id, account.id, agentId, q.redirect_uri,
    q.code_challenge, q.resource || RESOURCE, q.scope || SCOPES.join(" "),
    now() + CODE_TTL, now(),
  ).run();

  back.searchParams.set("code", code);
  return Response.redirect(back.toString(), 302);
}

/* ------------------------------------------------------------------- token */

async function clientFromRequest(f, req, env) {
  let id = f.get("client_id"), secret = f.get("client_secret");
  const basic = req.headers.get("authorization") || "";
  if (/^Basic /i.test(basic)) {
    try {
      const [u, p] = atob(basic.slice(6)).split(":");
      id = id || decodeURIComponent(u); secret = secret || decodeURIComponent(p);
    } catch { /* fall through to the null check below */ }
  }
  if (!id) return { error: oaErr("invalid_client", "client_id is required.", 401) };

  const c = await env.DB.prepare(
    "SELECT client_id, client_secret_sha256, redirect_uris FROM num_oauth_clients WHERE client_id=?1"
  ).bind(id).first();
  if (!c) return { error: oaErr("invalid_client", "Unknown client_id.", 401) };

  if (c.client_secret_sha256) {
    if (!secret || (await sha256hex(secret)) !== c.client_secret_sha256) {
      return { error: oaErr("invalid_client", "Bad client_secret.", 401) };
    }
  }
  return { client: c };
}

async function issuePair(env, { client_id, account_id, agent_id, audience, scope, parent }) {
  const at = rand("numo_at_", 32);
  const rt = rand("numo_rt_", 32);
  const t = now();
  const atHash = await sha256hex(at);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO num_oauth_tokens (token_sha256, kind, client_id, account_id, agent_id, audience, " +
      "scope, expires_at, revoked, parent_sha256, created_at) VALUES (?1,'access',?2,?3,?4,?5,?6,?7,0,?8,?9)"
    ).bind(atHash, client_id, account_id, agent_id, audience, scope, t + ACCESS_TTL, parent || null, t),
    env.DB.prepare(
      "INSERT INTO num_oauth_tokens (token_sha256, kind, client_id, account_id, agent_id, audience, " +
      "scope, expires_at, revoked, parent_sha256, created_at) VALUES (?1,'refresh',?2,?3,?4,?5,?6,?7,0,?8,?9)"
    ).bind(await sha256hex(rt), client_id, account_id, agent_id, audience, scope, t + REFRESH_TTL, parent || null, t),
  ]);
  return j({
    access_token: at,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: rt,
    scope,
  }, 200, { "cache-control": "no-store", pragma: "no-cache" });
}

async function token(req, env) {
  const f = await req.formData();
  const { client, error } = await clientFromRequest(f, req, env);
  if (error) return error;

  const grant = f.get("grant_type");

  if (grant === "authorization_code") {
    const code = f.get("code") || "";
    const verifier = f.get("code_verifier") || "";
    const redirect = f.get("redirect_uri") || "";
    if (!code || !verifier) return oaErr("invalid_request", "code and code_verifier are required.");

    const hash = await sha256hex(code);
    const row = await env.DB.prepare("SELECT * FROM num_oauth_codes WHERE code_sha256=?1").bind(hash).first();
    if (!row) return oaErr("invalid_grant", "Unknown authorization code.");

    // Replay: burn every token already minted from this code, per OAuth 2.1.
    if (row.used) {
      await env.DB.prepare("UPDATE num_oauth_tokens SET revoked=1 WHERE account_id=?1 AND client_id=?2")
        .bind(row.account_id, row.client_id).run();
      return oaErr("invalid_grant", "This authorization code was already used. All tokens from it are revoked.");
    }
    if (Number(row.expires_at) <= now()) return oaErr("invalid_grant", "Authorization code expired.");
    if (row.client_id !== client.client_id) return oaErr("invalid_grant", "Code was issued to a different client.");
    if (row.redirect_uri !== redirect) return oaErr("invalid_grant", "redirect_uri does not match the one used to get this code.");
    if ((await sha256b64url(verifier)) !== row.code_challenge) {
      return oaErr("invalid_grant", "PKCE verification failed.");
    }

    await env.DB.prepare("UPDATE num_oauth_codes SET used=1 WHERE code_sha256=?1").bind(hash).run();
    return issuePair(env, {
      client_id: client.client_id, account_id: row.account_id, agent_id: row.agent_id,
      audience: row.resource || RESOURCE, scope: row.scope, parent: hash,
    });
  }

  if (grant === "refresh_token") {
    const rt = f.get("refresh_token") || "";
    if (!rt) return oaErr("invalid_request", "refresh_token is required.");
    const hash = await sha256hex(rt);
    const row = await env.DB.prepare(
      "SELECT * FROM num_oauth_tokens WHERE token_sha256=?1 AND kind='refresh'"
    ).bind(hash).first();
    if (!row) return oaErr("invalid_grant", "Unknown refresh token.");
    if (row.revoked) return oaErr("invalid_grant", "This refresh token was already used or revoked.");
    if (Number(row.expires_at) <= now()) return oaErr("invalid_grant", "Refresh token expired.");
    if (row.client_id !== client.client_id) return oaErr("invalid_grant", "Token belongs to a different client.");

    // Public clients MUST rotate refresh tokens — retire this one as we issue the next.
    await env.DB.prepare("UPDATE num_oauth_tokens SET revoked=1 WHERE token_sha256=?1").bind(hash).run();
    return issuePair(env, {
      client_id: client.client_id, account_id: row.account_id, agent_id: row.agent_id,
      audience: row.audience, scope: row.scope, parent: hash,
    });
  }

  return oaErr("unsupported_grant_type", "Supported: authorization_code, refresh_token.");
}

async function revoke(req, env) {
  const f = await req.formData();
  const t = f.get("token");
  if (t) {
    await env.DB.prepare("UPDATE num_oauth_tokens SET revoked=1 WHERE token_sha256=?1")
      .bind(await sha256hex(String(t))).run();
  }
  return new Response(null, { status: 200, headers: CORS }); // RFC 7009: always 200
}

/* ------------------------------------------------------------------ router */

/** Returns a Response for any OAuth path, or null so worker.js keeps routing. */
export async function oauthRoutes(p, req, env) {
  const url = new URL(req.url);
  const m = req.method.toUpperCase();

  if (p === "/.well-known/oauth-protected-resource") return protectedResourceMetadata();
  if (p === "/.well-known/oauth-authorization-server") return authServerMetadata();

  if (p === "/oauth/register") {
    return m === "POST" ? register(req, env) : oaErr("invalid_request", "POST to register.", 405);
  }
  if (p === "/oauth/authorize") {
    if (m === "GET") return authorizeGet(url, req, env);
    if (m === "POST") return authorizePost(req, env);
    return oaErr("invalid_request", "GET or POST only.", 405);
  }
  if (p === "/oauth/token") {
    return m === "POST" ? token(req, env) : oaErr("invalid_request", "POST to the token endpoint.", 405);
  }
  if (p === "/oauth/revoke") {
    return m === "POST" ? revoke(req, env) : oaErr("invalid_request", "POST to revoke.", 405);
  }
  return null;
}
