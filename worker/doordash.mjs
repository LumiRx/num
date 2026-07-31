// DoorDash Drive — a courier, not a menu.
//
// Worth being precise about what this credential is, because it changes what we
// can honestly offer: Drive is delivery-as-a-service. You give it a pickup
// address and a dropoff address and it dispatches a Dasher. It does NOT let us
// order from the DoorDash marketplace.
//
// Which makes it the more useful half for Num. It means:
//   · a restaurant that has no delivery app can still deliver, because we send
//     the courier
//   · the errand case works — "collect the hat I found and bring it to me"
//   · a Num user can pay someone to fetch something without either of them
//     being on any delivery platform
//
// This is the FIRST rail that is genuinely connected rather than handed off, so
// the honesty rule flips: here Num really can say it has arranged something —
// but only once a delivery id comes back.

const API = 'https://openapi.doordash.com/drive/v2';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export const driveReady = (env) =>
  !!(env.DOORDASH_DEVELOPER_ID && env.DOORDASH_KEY_ID && env.DOORDASH_SIGNING_SECRET);

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Drive authenticates with a short-lived HS256 JWT, and two details bite:
 * the signing secret is base64url (not raw text), and the header must carry
 * `dd-ver: DD-JWT-V1` or every call returns 401 with no explanation.
 */
async function driveJwt(env) {
  const header = { alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1', kid: env.DOORDASH_KEY_ID };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: 'doordash', iss: env.DOORDASH_DEVELOPER_ID, kid: env.DOORDASH_KEY_ID, exp: now + 300, iat: now };

  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;

  const secretB64 = env.DOORDASH_SIGNING_SECRET.replace(/-/g, '+').replace(/_/g, '/');
  const secret = Uint8Array.from(atob(secretB64 + '='.repeat((4 - (secretB64.length % 4)) % 4)), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

async function drive(env, path, { method = 'POST', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await driveJwt(env)}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(parsed?.message ?? parsed?.error ?? `Drive ${res.status}`);
    err.status = res.status;
    err.detail = parsed;
    throw err;
  }
  return parsed;
}

/** What it would cost and how long — asked before anything is committed. */
export async function quote(env, d) {
  return drive(env, '/quotes', {
    body: {
      external_delivery_id: d.external_delivery_id,
      pickup_address: d.pickup_address,
      pickup_business_name: d.pickup_business_name,
      pickup_phone_number: d.pickup_phone_number,
      pickup_instructions: d.pickup_instructions,
      dropoff_address: d.dropoff_address,
      dropoff_phone_number: d.dropoff_phone_number,
      dropoff_instructions: d.dropoff_instructions,
      dropoff_contact_given_name: d.dropoff_contact_given_name,
      order_value: d.order_value,
      currency: d.currency ?? 'USD',
    },
  });
}

/** Accept a quote — this is the point a courier is actually dispatched. */
export const accept = (env, id) => drive(env, `/quotes/${encodeURIComponent(id)}/accept`, { body: {} });

export const status = (env, id) => drive(env, `/deliveries/${encodeURIComponent(id)}`, { method: 'GET' });

export const cancel = (env, id) => drive(env, `/deliveries/${encodeURIComponent(id)}/cancel`, { body: {} });

// ── routes ────────────────────────────────────────────────────────────────

export async function handleDrive(request, env, path) {
  if (!driveReady(env)) {
    return json(
      {
        connected: false,
        needs: 'DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID and DOORDASH_SIGNING_SECRET',
        note: 'Drive dispatches a courier between two addresses. It does not order from the DoorDash marketplace.',
      },
      path === '/status' ? 200 : 503,
    );
  }
  const url = new URL(request.url);
  const post = request.method === 'POST';

  try {
    if (path === '/status') {
      // A real round trip, not a config check: a quote for a throwaway id
      // proves the JWT is signed correctly, which is the only thing that
      // actually goes wrong with Drive.
      const probe = await quote(env, {
        external_delivery_id: `num-probe-${crypto.randomUUID().slice(0, 8)}`,
        pickup_address: '901 Market Street 6th Floor, San Francisco, CA 94103',
        pickup_business_name: 'Num Test Kitchen',
        pickup_phone_number: '+16505555555',
        dropoff_address: '901 Market Street 6th Floor, San Francisco, CA 94103',
        dropoff_phone_number: '+16505555555',
        dropoff_contact_given_name: 'Num',
        order_value: 1000,
      }).catch((e) => ({ _error: e.message, _status: e.status, _detail: e.detail }));
      return json({
        connected: !probe._error,
        sandbox: true,
        ...(probe._error ? { error: probe._error, status: probe._status, detail: probe._detail } : { quote_fee: probe.fee, currency: probe.currency, pickup_eta: probe.pickup_time_estimated }),
      });
    }

    if (path === '/quote' && post) {
      const b = await readBody(request);
      const id = clip(b.external_delivery_id, 60) || `num-${crypto.randomUUID()}`;
      return json(await quote(env, { ...b, external_delivery_id: id }));
    }
    if (path === '/accept' && post) {
      const b = await readBody(request);
      if (!b.id) return json({ error: 'id required' }, 400);
      return json(await accept(env, b.id));
    }
    if (path === '/status/one') return json(await status(env, url.searchParams.get('id') ?? ''));
    if (path === '/cancel' && post) {
      const b = await readBody(request);
      return json(await cancel(env, clip(b.id, 60) ?? ''));
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[drive]', path, err?.message ?? err);
    return json({ error: err?.message ?? 'that didn’t go through', detail: err?.detail ?? null }, err?.status ?? 500);
  }
}
