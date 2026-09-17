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
const REGISTER_PER_DAY = 20;         // dynamic client registrations, per IP, per UTC day

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

  // Registration has to stay open — the MCP spec requires it and both Claude and
  // ChatGPT register themselves on first connect — but open is not the same as
  // unlimited. A person connects a handful of clients; a script that wants a
  // thousand throwaway client_ids is doing something else. Same salted-hash
  // guard as agent signup, in the same table, under its own scope string so the
  // two counts never share a bucket.
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const salt = env.VISITOR_SALT || "num-agents-unsalted";
  const ipHash = await sha256hex(salt + "|oauth-register|" + ip);
  const day = new Date().toISOString().slice(0, 10);
  const guard = await env.DB.prepare("SELECT count FROM num_ai_signup_guard WHERE ip_hash=?1 AND day=?2")
    .bind(ipHash, day).first();
  if (guard && guard.count >= REGISTER_PER_DAY) {
    return oaErr("invalid_client_metadata",
      "Too many client registrations from this address today. Reuse the client_id you already have.", 429);
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

  await env.DB.prepare(
    "INSERT INTO num_ai_signup_guard (ip_hash, day, count) VALUES (?1,?2,1) " +
    "ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1"
  ).bind(ipHash, day).run();

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

/* One page shell for every screen this file serves, so the consent screen, the
   connected-apps page and /signin/ read as one product. The tokens are the ones
   in public/assets/site.css; they are copied rather than imported because this
   worker serves HTML from a different origin path than the site assets and a
   stylesheet fetch is one more thing that can fail mid-authorization. */
const PAGE_CSS = `:root{--pri:#0EA483;--pri-d:#0B7C63;--pri-l:#E7F6F1;--ink:#0A1A24;--slate:#586A74;--line:#E7ECEE;--bg:#F6FAF9;--warn:#B42318;--warn-bg:#FEF3F2;--warn-line:#FECDCA}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
font:16px/1.6 'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
header{padding:18px 24px;border-bottom:1px solid var(--line);background:rgba(246,250,249,.9)}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:19px;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.brand i{width:12px;height:12px;border-radius:50%;background:var(--pri);box-shadow:0 0 0 4px var(--pri-l);display:block}
.brand small{font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--slate)}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 20px 56px;
background:radial-gradient(900px 420px at 50% -10%,#E7F6F1 0%,rgba(231,246,241,0) 70%)}
.card{width:100%;background:#fff;border:1px solid var(--line);border-radius:20px;padding:32px 30px 26px;
box-shadow:0 1px 2px rgba(10,26,36,.04),0 24px 60px rgba(10,26,36,.10)}
.eyebrow{display:inline-flex;align-items:center;gap:8px;background:var(--pri-l);color:var(--pri-d);font-size:12px;font-weight:700;
letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:6px 12px}
.eyebrow i{width:8px;height:8px;border-radius:50%;background:var(--pri);display:block}
h1{font-family:'Space Grotesk','Plus Jakarta Sans',sans-serif;font-size:28px;font-weight:600;line-height:1.12;letter-spacing:-.02em;margin:14px 0 8px}
.sub{color:var(--slate);font-size:15px;margin:0 0 18px}
ul{list-style:none;padding:0;margin:0 0 18px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
li{padding:13px 14px;display:flex;gap:11px;align-items:flex-start;font-size:14.5px;line-height:1.5}
li+li{border-top:1px solid var(--line)}
li:before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--pri);margin-top:7px}
li code{display:block;font:600 11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--slate);margin-top:2px}
.who{font-size:13px;color:var(--slate);margin:0 0 18px;line-height:1.55}
.who strong{color:var(--ink)}
.who code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
.row{display:flex;gap:10px}
button{flex:1;padding:14px;border-radius:12px;font:inherit;font-weight:700;font-size:15px;cursor:pointer;
border:1px solid var(--line);background:#fff;color:var(--ink);transition:background .15s,border-color .15s,transform .15s}
button:hover{border-color:#cbd6da}
button.primary{flex:1.4;background:var(--pri);border-color:var(--pri);color:#fff;box-shadow:0 8px 22px rgba(14,164,131,.28)}
button.primary:hover{background:var(--pri-d);border-color:var(--pri-d);transform:translateY(-1px)}
button:focus-visible{outline:3px solid rgba(14,164,131,.4);outline-offset:2px}
.warn{border:1px solid var(--warn-line);background:var(--warn-bg);border-radius:12px;padding:14px 15px;margin:0 0 18px}
.warn b{display:block;color:var(--warn);font-size:14.5px;margin-bottom:4px}
.warn p{margin:0;font-size:14px;line-height:1.5;color:var(--ink)}
.warn code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.apps{list-style:none;padding:0;margin:0 0 18px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.apps li{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px}
.apps li:before{display:none}
.apps .nm{font-weight:700;font-size:15px}
.apps .meta{font-size:12.5px;color:var(--slate);margin-top:2px}
.apps button{flex:none;padding:9px 14px;font-size:13.5px;border-radius:10px}
.apps button:hover{border-color:var(--warn-line);color:var(--warn);background:var(--warn-bg)}
.apps li.risk{background:var(--warn-bg)}
.apps .flag{font-size:12.5px;font-weight:700;color:var(--warn);margin-top:4px}
.apps button.danger{border-color:var(--warn-line);color:var(--warn)}
.empty{font-size:14.5px;color:var(--slate);padding:18px 14px;text-align:center}
.foot{margin:16px 0 0;text-align:center;font-size:13px;color:var(--slate)}
.foot a{color:var(--slate);text-decoration:none}.foot a:hover{color:var(--pri-d)}
@media(max-width:480px){main{padding:24px 16px 40px;align-items:flex-start}.card{padding:26px 20px 22px}h1{font-size:25px}
.apps li{flex-direction:column;align-items:flex-start}}`;

function shell({ title, width = 460, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · NUM</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style></head><body>
<header><a class="brand" href="/"><i></i>NUM <small>travel concierge</small></a></header>
<main><div style="width:100%;max-width:${width}px">${body}
<p class="foot"><a href="/oauth/apps">Connected apps</a> &nbsp;&middot;&nbsp; <a href="/privacy/#developers">Privacy</a> &nbsp;&middot;&nbsp; <a href="/terms/">Terms</a> &nbsp;&middot;&nbsp; <a href="mailto:info@itsnum.com">Help</a></p>
</div></main></body></html>`;
}

/* ----------------------------------------------------------- impersonation
 *
 * Registration is open, because the MCP authorization spec requires it and
 * because Claude and ChatGPT both register themselves on first connect. That is
 * correct and it is not going to change. What it costs is this: `client_name`
 * is whatever the registrant typed, so anyone can register an app called
 * "Claude" pointing at their own server, and the consent screen — served from
 * itsnum.com, over TLS, with our logo on it — will say "Let Claude use NUM?".
 *
 * The one fact that cannot be faked is where the browser is sent afterwards,
 * because it must exactly match a URI registered with the client. So compare
 * the two: a name that claims a brand plus a return address that is not that
 * brand's is the shape of a phishing attempt, and the person is told so in
 * words, above the Allow button.
 *
 * Loopback is exempt. Claude Code and every other desktop client legitimately
 * return to http://localhost, and warning about those would teach people to
 * click through warnings — which is worse than not warning at all.
 */
const BRANDS = Object.freeze([
  { label: "Claude", claims: /claude|anthropic/i, hosts: /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i },
  { label: "ChatGPT", claims: /chat\s*-?gpt|openai/i, hosts: /(^|\.)(chatgpt\.com|openai\.com)$/i },
  { label: "Gemini", claims: /\bgemini\b/i, hosts: /(^|\.)(google\.com|googleapis\.com|gemini\.google\.com)$/i },
  { label: "Copilot", claims: /copilot/i, hosts: /(^|\.)(microsoft\.com|github\.com|githubcopilot\.com)$/i },
  { label: "Cursor", claims: /\bcursor\b/i, hosts: /(^|\.)cursor\.(com|sh)$/i },
  { label: "VS Code", claims: /vs\s*code|visual\s*studio/i, hosts: /(^|\.)(vscode\.dev|visualstudio\.com|github\.dev)$/i },
  { label: "Smithery", claims: /smithery/i, hosts: /(^|\.)smithery\.ai$/i },
  { label: "NUM", claims: /^num\b|itsnum/i, hosts: /(^|\.)(itsnum\.com|5arz\.com)$/i },
]);

/** @returns {{label:string, host:string}|null} — a brand claimed by a stranger. */
export function impersonation(clientName, redirectUri) {
  let host;
  try { host = new URL(redirectUri).hostname.toLowerCase(); } catch { return null; }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
  const name = String(clientName || "");
  for (const b of BRANDS) {
    if (b.claims.test(name) && !b.hosts.test(host)) return { label: b.label, host };
  }
  return null;
}

function consentPage({ client, account, params }) {
  const scopes = (params.scope || SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  const rows = scopes.map((s) => {
    const label = s === "num.write"
      ? "Submit a business or a promotion for you. A person reviews each one before it appears."
      : s === "num.read"
        ? "Search NUM's directory of more than 2.5 million places, within your daily limit."
        : s;
    return `<li><span>${esc(label)}<code>${esc(s)}</code></span></li>`;
  }).join("");

  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
    .map((k) => params[k] ? `<input type="hidden" name="${k}" value="${esc(params[k])}">` : "").join("");

  const origin = new URL(params.redirect_uri).origin;
  const fake = impersonation(client.client_name, params.redirect_uri);
  const warn = fake ? `<div class="warn">
<b>This may not really be ${esc(fake.label)}.</b>
<p>It calls itself &ldquo;${esc(client.client_name)}&rdquo;, but it sends you to <code>${esc(fake.host)}</code>, which is not ${esc(fake.label)}&rsquo;s. Anyone can pick that name. If you did not start this from ${esc(fake.label)} yourself, choose Not now.</p>
</div>` : "";

  return html(shell({
    title: "Connect " + client.client_name,
    body: `<div class="card">
<div class="eyebrow"><i></i>Connect NUM</div>
<h1>Let ${esc(client.client_name)} use NUM?</h1>
${warn}<p class="sub">It will be able to:</p>
<ul>${rows}</ul>
<p class="who">Signed in as <strong>${esc(account.email)}</strong>. You'll go back to <code>${esc(origin)}</code>.
It never sees your sign-in link, and you can disconnect it whenever you like at <a href="/oauth/apps">itsnum.com/oauth/apps</a>.</p>
<form method="POST" action="/oauth/authorize">${hidden}
<div class="row">${fake
  // When we are warning, the safe answer becomes the big green button. Leaving
  // Allow as the obvious one while telling somebody not to press it is how you
  // get it pressed.
  ? `<button type="submit" name="decision" value="allow">Allow anyway</button>
<button type="submit" name="decision" value="deny" class="primary" autofocus>Not now</button>`
  : `<button type="submit" name="decision" value="deny">Not now</button>
<button type="submit" name="decision" value="allow" class="primary">Allow</button>`}
</div></form>
</div>`,
  }));
}

/* ------------------------------------------------------- connected apps
 *
 * "You can disconnect it at any time" was true of the protocol and false of the
 * product: every screen said it and there was nowhere to do it. This is that
 * page. It reads the token table, which is the only record of a live connection.
 *
 * Disconnecting revokes both halves of the pair, so the app's next call gets a
 * 401 and its refresh token is dead — there is no quiet re-issue.
 *
 * CSRF: the session cookie is SameSite=Lax, so a POST from another origin
 * arrives without it and lands on the signed-out page instead of revoking
 * anything.
 */
async function appsFor(account, env) {
  const { results } = await env.DB.prepare(
    "SELECT t.client_id AS client_id, MAX(c.client_name) AS client_name, MAX(c.redirect_uris) AS redirect_uris, " +
    "MAX(t.scope) AS scope, MIN(t.created_at) AS first_at, MAX(t.created_at) AS last_at, " +
    "MAX(CASE WHEN t.kind='refresh' THEN t.expires_at END) AS refresh_until " +
    "FROM num_oauth_tokens t LEFT JOIN num_oauth_clients c ON c.client_id = t.client_id " +
    "WHERE t.account_id = ?1 AND t.revoked = 0 GROUP BY t.client_id ORDER BY MAX(t.created_at) DESC"
  ).bind(account.id).all();
  return results || [];
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

/** redirect_uris is stored as a JSON array; the first one is what the app uses. */
const firstRedirect = (json) => {
  try { const a = JSON.parse(json || "[]"); return Array.isArray(a) && a.length ? String(a[0]) : ""; }
  catch { return ""; }
};

const when = (secs) => {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString().slice(0, 10);
};

async function appsPage(req, env, { revoked = "" } = {}) {
  const account = await sessionAccount(req, env);
  if (!account) return signinInterstitial("/oauth/apps");
  const apps = await appsFor(account, env);

  const rows = apps.map((a) => {
    const name = a.client_name || a.client_id;
    const uri = firstRedirect(a.redirect_uris);
    const fake = impersonation(a.client_name, uri);
    const scopes = String(a.scope || "").split(/\s+/).filter(Boolean).join(", ") || "num.read";
    const host = hostOf(uri);
    // Two apps can both be called "Claude". Only one of them returns you to
    // Claude. That host is the line that tells them apart, so it is on every row.
    const meta = [scopes, host ? "returns to " + host : "", "connected " + when(a.first_at)]
      .filter(Boolean).map(esc).join(" &middot; ");
    return `<li${fake ? ' class="risk"' : ""}><div><div class="nm">${esc(name)}</div>
<div class="meta">${meta}</div>${fake
  ? `<div class="flag">Not ${esc(fake.label)}. Disconnect it unless you know what it is.</div>` : ""}</div>
<form method="POST" action="/oauth/apps"><input type="hidden" name="client_id" value="${esc(a.client_id)}">
<button type="submit"${fake ? ' class="danger"' : ""}>Disconnect</button></form></li>`;
  }).join("");

  const body = `<div class="card">
<div class="eyebrow"><i></i>Your account</div>
<h1>Apps connected to NUM</h1>
<p class="sub">Every app you have allowed to use your NUM account. Disconnecting one takes effect immediately.</p>
${revoked ? `<div class="warn" style="border-color:#A6E5D4;background:var(--pri-l)"><b style="color:var(--pri-d)">Disconnected ${esc(revoked)}.</b><p>It can no longer search or submit anything with your account.</p></div>` : ""}
${apps.length ? `<ul class="apps">${rows}</ul>` : `<ul class="apps"><li><div class="empty">Nothing is connected. When you add <code>itsnum.com/mcp</code> in Claude or ChatGPT, it will appear here.</div></li></ul>`}
<p class="who">Signed in as <strong>${esc(account.email)}</strong>. API keys are separate — rotate one with <code>POST /api/agent/me/rotate</code>.</p>
</div>`;
  return html(shell({ title: "Connected apps", width: 560, body }));
}

async function appsDisconnect(req, env) {
  const account = await sessionAccount(req, env);
  if (!account) return signinInterstitial("/oauth/apps");
  const f = await req.formData().catch(() => null);
  const clientId = f && String(f.get("client_id") || "");
  if (!clientId) return appsPage(req, env);

  const row = await env.DB.prepare("SELECT client_name FROM num_oauth_clients WHERE client_id=?1")
    .bind(clientId).first();
  // Scoped to THIS account: one person disconnecting an app must never revoke
  // anybody else's tokens for the same client.
  await env.DB.prepare("UPDATE num_oauth_tokens SET revoked=1 WHERE account_id=?1 AND client_id=?2")
    .bind(account.id, clientId).run();
  return appsPage(req, env, { revoked: (row && row.client_name) || "that app" });
}

// Not signed in: go straight to the branded sign-in page, carrying the whole
// authorize request in ?next= so the emailed link lands back here. This used to
// be an unbranded 401 page with one button on it ("Sign in, then return to this
// page and reload it") — an extra screen, in a different design, asking the
// person to do by hand what ?next= already does.
function signinInterstitial(returnTo) {
  return new Response(null, {
    status: 302,
    headers: { location: "/signin/?next=" + encodeURIComponent(returnTo), "cache-control": "no-store" },
  });
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
  if (p === "/oauth/apps") {
    if (m === "GET") return appsPage(req, env);
    if (m === "POST") return appsDisconnect(req, env);
    return oaErr("invalid_request", "GET or POST only.", 405);
  }
  if (p === "/oauth/revoke") {
    return m === "POST" ? revoke(req, env) : oaErr("invalid_request", "POST to revoke.", 405);
  }
  return null;
}
