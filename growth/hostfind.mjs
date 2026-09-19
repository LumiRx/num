// Finding another host, and finding what they have.
//
// THE MOMENT THIS SERVES. A host's client wants a car in Bangkok on Thursday
// and the host does not have one there. Until now the console offered a list
// of every host in the network, newest first, capped at 200, with no way to
// ask it a question — so the answer to "who can do this" was to read the list.
// That is not a search, it is a directory, and a directory of 200 is a
// directory nobody opens twice.
//
// THREE KINDS OF ANSWER, ONE QUESTION. A host asking "boat, Phuket" does not
// care which of our tables the answer lives in:
//
//   hosts     someone who covers that city and does that service
//   assets    a specific hull, already listable, with an approved photograph
//   products  something already on another host's shelf, at a price
//
// WHAT IS NEVER RETURNED. No email, no phone number, no registration. The
// directory rule from /api/host/network holds here word for word: two hosts
// who want to talk are connected through an accepted link, not by reading a
// list. And every asset goes through clientView, which does not select the
// registration column at all — the search a host runs for their client is
// client-facing copy the moment they paste it into a message.
//
// WHY IT IS ITS OWN ENDPOINT. /api/host/network is a read-write endpoint that
// also carries the host's own visibility switch and their links. Bolting a
// query string onto it would mean a search could change something.

import { rows, readFailedResponse, isReadFailed } from './readfail.mjs';
import { clientView } from './hostassets.mjs';

// What the console offers as filters. Same vocabulary as num_hosts.services_json.
export const SERVICES = ['car', 'reservation', 'stay', 'activity', 'appointment',
  'delivery', 'yacht', 'jet', 'provisioning'];
export const KINDS = ['yacht', 'boat', 'jet', 'helicopter', 'car', 'villa', 'other'];

/** LIKE with the wildcards escaped.
 *
 *  A host searching for "50% off" or for a name with an underscore in it must
 *  not have those characters read as wildcards — '%' alone matches every row
 *  in the table, which would look like a spectacularly good search result and
 *  be a meaningless one. */
export function likeTerm(q) {
  return '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** How well a host answers the question that was asked.
 *
 *  Ordering is done here rather than in SQL because the inputs come from three
 *  queries and one of them (distance by city name) is not a column. Written as
 *  a function so the order is testable, which an ORDER BY spread across three
 *  statements is not. */
export function rankHost(h, { q, city, service }) {
  let score = 0;
  if (h.connected) score += 50;            // someone you already work with
  if (service && (h.services || []).includes(service)) score += 20;
  if (city && String(h.city || '').toLowerCase().includes(city.toLowerCase())) score += 15;
  if (q) {
    const hay = [h.name, h.company, h.blurb].filter(Boolean).join(' ').toLowerCase();
    const needle = q.toLowerCase();
    if (hay.includes(needle)) score += 10;
    if (String(h.name || '').toLowerCase().startsWith(needle)) score += 5;
  }
  if (h.assets) score += Math.min(h.assets, 5);   // someone with things listed
  return score;
}

/**
 * GET /api/host/find?k=KEY&q=&service=&city=&country=&kind=
 *
 * Every parameter is optional. With none of them it is the directory, ranked
 * by who you already work with — which is a better empty state than "newest
 * first" and costs nothing.
 */
export async function hostFind(req, env, url, D) {
  const { J, clean, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'GET') return J({ ok: false, error: 'method' }, 405);

  const q = clean(url.searchParams.get('q'), 80);
  const city = clean(url.searchParams.get('city'), 80);
  const country = clean(url.searchParams.get('country'), 80);
  const service = SERVICES.includes(String(url.searchParams.get('service') || ''))
    ? String(url.searchParams.get('service')) : null;
  const kind = KINDS.includes(String(url.searchParams.get('kind') || ''))
    ? String(url.searchParams.get('kind')) : null;

  try {
    /* ── who ────────────────────────────────────────────────────────────
       Every host in the network except this one. The city comes from
       num_host_areas, which is the indexed shadow of areas_json — a host with
       no area saved is findable by name and by service but not by place,
       which is the same rule introductions already work by. */
    const hostWhere = ["h.in_network = 1", "h.status = 'active'", 'h.id <> ?1'];
    const binds = [host.id];
    const add = (sql, ...vals) => {
      hostWhere.push(sql.replace(/\$(\d)/g, (_, n) => '?' + (binds.length + Number(n))));
      binds.push(...vals);
    };
    if (q) add('(h.name LIKE $1 ESCAPE \'\\\' OR h.company LIKE $1 ESCAPE \'\\\' OR h.blurb LIKE $1 ESCAPE \'\\\')', likeTerm(q));
    if (service) add('h.services_json LIKE $1', likeTerm('"' + service + '"'));
    if (city) add("EXISTS (SELECT 1 FROM num_host_areas a WHERE a.host_id = h.id AND a.city LIKE $1 ESCAPE '\\')", likeTerm(city));
    if (country) add("EXISTS (SELECT 1 FROM num_host_areas a WHERE a.host_id = h.id AND a.country LIKE $1 ESCAPE '\\')", likeTerm(country));

    const found = await rows(env.DB.prepare(
      `SELECT h.id, h.name, h.company, h.blurb, h.services_json, h.currency,
              (SELECT a.city FROM num_host_areas a WHERE a.host_id = h.id LIMIT 1) AS city,
              (SELECT a.country FROM num_host_areas a WHERE a.host_id = h.id LIMIT 1) AS country,
              (SELECT COUNT(*) FROM num_assets x
                WHERE x.host_id = h.id AND x.listable = 1 AND x.status = 'active') AS assets
         FROM num_hosts h
        WHERE ${hostWhere.join(' AND ')}
        ORDER BY h.created_at DESC LIMIT 100`
    ).bind(...binds).all(), 'hosts who could help');

    // Who you are already connected to. One query, not one per row.
    const links = await rows(env.DB.prepare(
      `SELECT host_a, host_b, status FROM num_host_links
        WHERE (host_a = ?1 OR host_b = ?1) AND status IN ('pending','accepted')`
    ).bind(host.id).all(), 'your connections');
    const state = new Map();
    for (const l of links) state.set(l.host_a === host.id ? l.host_b : l.host_a, l.status);

    const hosts = found.map((h) => ({
      host_id: h.id,
      name: h.name,
      company: h.company || '',
      blurb: h.blurb || '',
      city: h.city || '',
      country: h.country || '',
      currency: h.currency || 'GBP',
      services: safeArr(h.services_json),
      assets: Number(h.assets || 0),
      connected: state.get(h.id) === 'accepted',
      asked: state.get(h.id) === 'pending',
    }));
    hosts.forEach((h) => { h.score = rankHost(h, { q, city, service }); });
    hosts.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    /* ── what ───────────────────────────────────────────────────────────
       Listable assets belonging to anyone in the network. An asset with no
       approved photograph is not a listing a host can put in front of a
       client, so it is not in the answer. */
    const aWhere = ['a.listable = 1', "a.status = 'active'", 'a.host_id <> ?1',
      "EXISTS (SELECT 1 FROM num_asset_photos p WHERE p.asset_id = a.id AND p.moderation = 'ok')",
      "EXISTS (SELECT 1 FROM num_hosts h WHERE h.id = a.host_id AND h.in_network = 1 AND h.status = 'active')"];
    const aBinds = [host.id];
    const aAdd = (sql, ...vals) => {
      aWhere.push(sql.replace(/\$(\d)/g, (_, n) => '?' + (aBinds.length + Number(n))));
      aBinds.push(...vals);
    };
    if (kind) aAdd('a.kind = $1', kind);
    if (city) aAdd("(a.home_city LIKE $1 ESCAPE '\\' OR a.home_port LIKE $1 ESCAPE '\\')", likeTerm(city));
    if (country) aAdd("a.home_country LIKE $1 ESCAPE '\\'", likeTerm(country));
    if (q) aAdd("(a.name LIKE $1 ESCAPE '\\' OR a.make LIKE $1 ESCAPE '\\' OR a.model LIKE $1 ESCAPE '\\')", likeTerm(q));

    const assetRows = await rows(env.DB.prepare(
      `SELECT a.*, h.name AS host_name FROM num_assets a
         JOIN num_hosts h ON h.id = a.host_id
        WHERE ${aWhere.join(' AND ')}
        ORDER BY a.kind ASC, a.rate_minor ASC LIMIT 40`
    ).bind(...aBinds).all(), 'what is listed');

    const assets = [];
    for (const a of assetRows) {
      const ph = await rows(env.DB.prepare(
        `SELECT id, caption FROM num_asset_photos
          WHERE asset_id=?1 AND moderation='ok' ORDER BY position ASC LIMIT 4`
      ).bind(a.id).all(), "an asset's photos");
      // clientView is what keeps the registration out. Do not replace it with
      // a spread — the column is deliberately absent from its output.
      assets.push({
        ...clientView({ ...a, photos: ph.map((p) => ({ url: `/p/asset/${p.id}`, caption: p.caption })) }),
        host_id: a.host_id,
        host_name: a.host_name,
      });
    }

    return J({
      ok: true,
      query: { q, city, country, service, kind },
      hosts,
      assets,
      vocabulary: { services: SERVICES, kinds: KINDS },
      // How the money works, said at the point of use rather than in a help
      // page. A host handing work to another host is about to quote their
      // client, and the fee is part of the number they quote.
      how_money_works: 'They invoice you, you bill your client as normal. NUM never appears to your client and never charges them.',
      note: (hosts.length || assets.length) ? null
        : 'Nobody in the network matches that yet. Widen it, or ask NUM — a request with nobody to send it to is still worth logging.',
    });
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
}

function safeArr(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
