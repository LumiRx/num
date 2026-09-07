/**
 * The connections page is GENERATED, and these tests are why that matters.
 *
 * A hand-written partners page is a claim that decays silently: a key expires,
 * a trial ends, and the page keeps saying we do that. Nothing fails, because
 * marketing pages have no tests. So the page reads the same registry the
 * concierge reads, and these tests pin the three distinctions it must never
 * blur — and the one thing it must never contain.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rails, platforms, forBusiness, connectionsPayload, sandboxOf, MEANING } from './connections.mjs';

const SECRETS = {
  DOORDASH_DEVELOPER_ID: 'dd-dev-SECRET', DOORDASH_KEY_ID: 'dd-key-SECRET', DOORDASH_SIGNING_SECRET: 'sign-SECRET',
  VIATOR_API_KEY: 'viator-SECRET', TICKETMASTER_API_KEY: 'tm-SECRET',
};

describe('it reports what is configured, not what we wish', () => {
  test('an unconfigured rail says so, on the public page', () => {
    const off = rails({}).find((r) => r.id === 'viator');
    assert.equal(off.live, false);
    assert.equal(off.status, 'Not connected yet');
  });

  test('a configured rail goes live with no edit to anything', () => {
    assert.equal(rails(SECRETS).find((r) => r.id === 'viator').live, true);
  });

  test('the headline count can never be higher than the truth', () => {
    const p = connectionsPayload(SECRETS);
    const claimed = p.live_count;
    const actually = p.rails.filter((r) => r.live && !r.sandbox).length;
    assert.equal(claimed, actually);
    // And a sandbox rail is NOT counted, however connected it is.
    assert.ok(p.rails.some((r) => r.sandbox));
    assert.ok(claimed < p.rails.filter((r) => r.live).length);
  });

  test('with nothing configured the page claims nothing', () => {
    assert.equal(connectionsPayload({}).live_count, 0);
  });
});

describe('the three distinctions it must not blur', () => {
  test('LIVE is not SANDBOX — a courier that will not arrive is not a service', () => {
    const dd = rails(SECRETS).find((r) => r.id === 'doordash_drive');
    assert.equal(dd.live, true);
    assert.equal(dd.sandbox, true);
    assert.match(dd.status, /test mode, not yet serving guests/);
    // Production is one variable away and the page follows it immediately.
    assert.equal(sandboxOf('doordash_drive', { ...SECRETS, DOORDASH_ENV: 'production' }), false);
    assert.equal(rails({ ...SECRETS, DOORDASH_ENV: 'production' }).find((r) => r.id === 'doordash_drive').status, 'Live');
  });

  test('WE SHOP IT is not WE BOOK IT — the flight rails say quotes only', () => {
    assert.match(MEANING.sabre_air.caveat, /Quotes only/);
    assert.match(MEANING.duffel.caveat, /Search only/);
    const air = rails({ SABRE_CLIENT_ID: 'x', SABRE_CLIENT_SECRET: 'y' }).find((r) => r.id === 'sabre_air');
    assert.equal(air.kind, 'flight_shop', 'calling it "flight" is how a prompt promises a ticket nobody holds');
  });

  test('WE LINK YOU is not WE INTEGRATE — every booking platform is a deeplink', () => {
    const p = platforms();
    assert.ok(p.total >= 20);
    // The count is of SYSTEMS, and it still adds up after the collapse.
    const shown = Object.values(p.by_kind).flat().reduce((n, x) => n + x.systems, 0);
    assert.equal(shown, p.total);
    for (const list of Object.values(p.by_kind)) {
      for (const x of list) assert.equal(x.mode, 'deeplink', `${x.id} is described as more than a link`);
      // Distinct labels only — fourteen rows reading "the hotel's own booking
      // page" is a list that tells a reader nothing.
      assert.equal(new Set(list.map((x) => x.label)).size, list.length);
    }
    assert.match(p.how, /does not hold an account with these platforms/);
    assert.match(p.how, /never charges you through one/);
  });
});

describe('it can never leak a key', () => {
  test('no secret VALUE appears anywhere in the payload', () => {
    const dump = JSON.stringify(connectionsPayload(SECRETS));
    for (const v of Object.values(SECRETS)) assert.ok(!dump.includes(v), `leaked ${v}`);
    // The only place a secret's NAME may appear is `needs`, and only while
    // that rail is disconnected. Everywhere else in the payload is prose.
    const withoutNeeds = JSON.stringify(connectionsPayload(SECRETS).rails.map(({ needs, ...r }) => r));
    assert.doesNotMatch(withoutNeeds, /[A-Z][A-Z0-9]{4,}_[A-Z0-9_]+/, 'a variable name escaped into the prose');
  });

  test('`needs` names VARIABLES, never values, and only when disconnected', () => {
    const off = rails({}).find((r) => r.id === 'doordash_drive');
    assert.match(off.needs, /DOORDASH_DEVELOPER_ID/);
    assert.equal(rails(SECRETS).find((r) => r.id === 'doordash_drive').needs, null);
  });

  test('plumbing nobody would call a partner is not listed as one', () => {
    assert.ok(!connectionsPayload({ GEOAPIFY_KEY: 'k' }).rails.some((r) => r.id === 'geoapify'));
    assert.ok(rails({ GEOAPIFY_KEY: 'k' }).some((r) => r.id === 'geoapify' && r.plumbing));
  });
});

describe('what a business is told it gets', () => {
  test('the courier line follows the real DoorDash state, not a promise', () => {
    assert.equal(forBusiness({}).find((b) => b.id === 'courier').live, false);
    const on = forBusiness(SECRETS).find((b) => b.id === 'courier');
    assert.equal(on.live, true);
    assert.equal(on.sandbox, true);
  });

  test('it says plainly that the business needs no DoorDash account', () => {
    assert.match(forBusiness(SECRETS).find((b) => b.id === 'courier').does, /no DoorDash account of your own/);
  });

  test('bookings follow the real switch, not a hopeful boolean', async () => {
    // FOUND IN PRODUCTION, one hour after this page first deployed:
    // /api/version said `booking: false` while this page told businesses they
    // could take table requests. A hand-written `live: true` is a claim
    // wherever it appears — including inside the generator whose whole job is
    // to stop claims.
    assert.equal(forBusiness({}).find((b) => b.id === 'bookings').live, false);
    assert.match(forBusiness({}).find((b) => b.id === 'bookings').caveat, /Switched off/);
    assert.equal(forBusiness({ BOOKDESK_ENABLED: 'true' }).find((b) => b.id === 'bookings').live, true);
    // Anything other than the exact string is off, same as the flag itself.
    assert.equal(forBusiness({ BOOKDESK_ENABLED: '1' }).find((b) => b.id === 'bookings').live, false);
  });

  test('pickup is marked NOT BUILT, because it is not built', async () => {
    // createOrder writes the literal string 'delivery' into `fulfilment`.
    // There is no code path that produces a collection order, so the page
    // must not imply there is one.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./delivery.mjs', import.meta.url), 'utf8');
    const built = /fulfilment[^)]{0,200}['"]pickup['"]/.test(src);
    const claimed = forBusiness({}).find((b) => b.id === 'pickup');
    assert.equal(claimed.live, built, 'the page and the code disagree about pickup');
    if (!built) {
      assert.equal(claimed.built, false);
      assert.match(claimed.caveat, /Not built yet/);
    }
  });

  test('every line that says LIVE can be pointed at', () => {
    // The rule for this block: if you cannot point at the thing that makes it
    // true, it is not live. These four are structural — the code exists and
    // is wired — and the other three are derived from a flag or a rail.
    const live = forBusiness({}).filter((b) => b.live).map((b) => b.id);
    assert.deepEqual(live.sort(), ['agent', 'delivery', 'listing', 'offerings']);
  });

  test('the cannabis caveat is on the rail, where somebody reading it will see it', () => {
    assert.match(MEANING.doordash_drive.caveat, /will not carry cannabis/);
  });

  test('every business line says what it DOES, not what it is called', () => {
    for (const b of forBusiness(SECRETS)) {
      assert.ok(b.does && b.does.length > 30, `${b.id} has no plain-language description`);
    }
  });
});
