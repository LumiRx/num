/**
 * DOES THE LUXURY SIDE STILL AGREE WITH ITSELF?
 *
 * The client half of the host system has a checker. The supplier half has one.
 * This is the third, for the half where the mistakes cost the most.
 *
 * A wrong row in the client book gives somebody a wrong answer. A wrong row
 * here puts two families on the same hull on the same Saturday, or settles a
 * five-figure charter to an owner nobody verified. Neither of those is a bug
 * you apologise for — the first ends the relationship and the second is how a
 * concierge becomes a defendant.
 *
 * So the severities mean something slightly harder here than elsewhere:
 *   breach — somebody is about to be harmed, or money is moving to the wrong
 *            party, or a promise is currently untrue. Stop and fix.
 *   orphan — a row is holding something it should have let go of, or waiting
 *            for a decision nobody is coming to make.
 *   drift  — inventory that cannot do what it claims. Nobody harmed yet.
 *
 * Pure functions over rows, same as its two siblings, for the same reason: a
 * checker that needs a live database to run is a checker nobody runs.
 */

const F = (severity, code, detail, ids) => ({ severity, code, detail, ids: ids || [] });

/** Holds that actually occupy the asset. A released hold occupies nothing. */
export const OCCUPYING = new Set(['booked', 'provisional']);

/** Do two date ranges overlap? Touching end-to-start does NOT overlap — one
 *  charter ending the morning another begins is the normal turnaround, and
 *  calling it a clash would bury the real ones. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;

/**
 * @param d {{assets, photos, holds, media, jobs, links, suppliers}} plain rows.
 *          Missing keys are treated as empty so a caller can check one slice.
 * @param now ISO timestamp to measure ages against.
 */
export function checkAssetData(d, now) {
  const at = now || new Date().toISOString();
  const assets = d.assets || [];
  const photos = d.photos || [];
  const holds = d.holds || [];
  const media = d.media || [];
  const jobs = d.jobs || [];
  const links = d.links || [];

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const linkBySupplier = new Map();
  for (const l of links) linkBySupplier.set(l.supplier_id, l);
  const photosByAsset = new Map();
  for (const p of photos) {
    if (!photosByAsset.has(p.asset_id)) photosByAsset.set(p.asset_id, []);
    photosByAsset.get(p.asset_id).push(p);
  }
  const out = [];

  /* ── BREACH ─────────────────────────────────────────────────────────── */

  // THE ONE THAT ENDS A RELATIONSHIP. Two live holds on one hull, overlapping.
  // Checked pairwise per asset rather than globally, because the only clash
  // that matters is one against the same thing.
  const byAsset = new Map();
  for (const h of holds) {
    if (!OCCUPYING.has(h.kind) || h.released_at) continue;
    if (!byAsset.has(h.asset_id)) byAsset.set(h.asset_id, []);
    byAsset.get(h.asset_id).push(h);
  }
  const clashing = new Set();
  for (const list of byAsset.values()) {
    const sorted = [...list].sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      for (let k = i + 1; k < sorted.length; k++) {
        if (sorted[k].starts_at >= sorted[i].ends_at) break;   // sorted — no later one can overlap
        if (overlaps(sorted[i].starts_at, sorted[i].ends_at, sorted[k].starts_at, sorted[k].ends_at)) {
          clashing.add(sorted[i].id);
          clashing.add(sorted[k].id);
        }
      }
    }
  }
  if (clashing.size) {
    out.push(F('breach', 'asset_double_booked',
      'One asset held twice over the same dates — two clients are expecting the same boat, car or aircraft.',
      [...clashing]));
  }

  // THE MARKETPLACE GATE. A member-owned asset offered to anybody before a
  // human checked they own it. The database refuses this on write, so a row
  // here means something wrote around the CHECK.
  const unverified = assets.filter((a) => a.owner_kind === 'member' && a.listable && !a.verified_at);
  if (unverified.length) {
    out.push(F('breach', 'member_asset_listable_unverified',
      'Member-owned assets offered to clients with no ownership verification on file.',
      unverified.map((a) => a.id)));
  }

  // MONEY TO A STRANGER. NUM collecting a charter and settling it to an owner
  // nobody verified is the single worst thing on this surface.
  const payToStranger = assets.filter((a) => a.settle_mode === 'num_collects' && !a.verified_at);
  if (payToStranger.length) {
    out.push(F('breach', 'num_settles_to_unverified_owner',
      'NUM is set to collect and settle for assets whose owner has never been verified.',
      payToStranger.map((a) => a.id)));
  }

  // Offerable inventory with no host able to offer it. The CHECK refuses it
  // on write, so this catches a writer that went around it.
  const hostless = assets.filter((a) => a.listable && !a.host_id);
  if (hostless.length) {
    out.push(F('breach', 'listable_without_host',
      'Assets marked offerable with no host attached — nobody can actually place them.',
      hostless.map((a) => a.id)));
  }

  // A registration, tail number or plate in a field a member reads. It is
  // recorded so a host can identify the thing, never so a client can.
  const exposed = assets.filter((a) => {
    const reg = String(a.registration || '').replace(/[\s-]/g, '').toLowerCase();
    if (reg.length < 4) return false;
    const seen = [a.notes, a.extras_note, a.name].filter(Boolean).join(' ')
      .replace(/[\s-]/g, '').toLowerCase();
    return seen.includes(reg);
  });
  if (exposed.length) {
    out.push(F('breach', 'registration_in_client_copy',
      'A tail number, hull number or plate appears in text a client reads.',
      exposed.map((a) => a.id)));
  }

  // A booking with nothing behind it. A 'booked' hold and no job means a
  // commitment exists that no request, price or receipt can be traced to.
  const untraceable = holds.filter((h) => h.kind === 'booked' && !h.released_at && !h.job_id);
  if (untraceable.length) {
    out.push(F('breach', 'booked_hold_without_job',
      'Confirmed holds with no job behind them — a commitment nothing can be traced to.',
      untraceable.map((h) => h.id)));
  }

  // Live work against a hull that is paused, retired or gone.
  const deadAsset = jobs.filter((j) => {
    if (!j.asset_id) return false;
    if (['done', 'cancelled', 'declined', 'expired'].includes(j.status)) return false;
    const a = assetById.get(j.asset_id);
    return !a || a.status !== 'active';
  });
  if (deadAsset.length) {
    out.push(F('breach', 'live_job_on_inactive_asset',
      'Live jobs against an asset that is paused, retired or missing.',
      deadAsset.map((j) => j.id)));
  }

  /* ── ORPHAN ─────────────────────────────────────────────────────────── */

  // A provisional hold past its own expiry, still occupying the calendar. This
  // is how a boat looks busy all season without earning anything.
  const stale = holds.filter((h) => h.kind === 'provisional' && !h.released_at
    && h.expires_at && h.expires_at < at);
  if (stale.length) {
    out.push(F('orphan', 'provisional_hold_expired',
      'Provisional holds past their expiry still blocking the calendar.',
      stale.map((h) => h.id)));
  }

  // A hold for work that is not happening.
  const holdForDead = holds.filter((h) => {
    if (h.released_at || !h.job_id) return false;
    const j = jobById.get(h.job_id);
    return !j || ['cancelled', 'declined', 'expired'].includes(j.status);
  });
  if (holdForDead.length) {
    out.push(F('orphan', 'hold_for_dead_job',
      'Holds still blocking dates for jobs that were cancelled, declined or expired.',
      holdForDead.map((h) => h.id)));
  }

  // A photograph somebody texted in that nobody ever filed. Two days is the
  // point at which the supplier has assumed it worked.
  const unresolved = media.filter((m) => m.status === 'new' && days(m.created_at, at) > 2);
  if (unresolved.length) {
    out.push(F('orphan', 'inbound_media_unresolved',
      'Photos texted in over two days ago that were never attached or discarded — the sender believes it worked.',
      unresolved.map((m) => m.id)));
  }

  // Media from a number we cannot match to a supplier. Worth a look rather
  // than a shrug: it is either a supplier texting from a second phone, or
  // somebody sending us pictures we never asked for.
  const unknown = media.filter((m) => m.status === 'unknown_sender');
  if (unknown.length) {
    out.push(F('orphan', 'media_from_unknown_sender',
      'Inbound photos from numbers that match no supplier.',
      unknown.map((m) => m.id)));
  }

  // An asset whose supplier has left the host it was listed under.
  const orphanedByLink = assets.filter((a) => {
    if (a.owner_kind !== 'supplier' || a.status !== 'active') return false;
    const l = linkBySupplier.get(a.owner_id);
    return l && l.status === 'ended';
  });
  if (orphanedByLink.length) {
    out.push(F('orphan', 'asset_of_ended_supplier_link',
      'Active assets belonging to a supplier whose relationship with the host has ended.',
      orphanedByLink.map((a) => a.id)));
  }

  /* ── DRIFT ──────────────────────────────────────────────────────────── */

  // Offerable, and nothing to look at. A charter is chosen on photographs.
  const noPhotos = assets.filter((a) => a.listable && a.status === 'active'
    && !(photosByAsset.get(a.id) || []).some((p) => p.moderation === 'ok'));
  if (noPhotos.length) {
    out.push(F('drift', 'listable_without_an_approved_photo',
      'Assets offered to clients with no approved photograph — nobody charters a boat sight unseen.',
      noPhotos.map((a) => a.id)));
  }

  // Offerable and unfindable. Same failure the host coverage had: a place name
  // with no coordinates answers "who typed this string" and never "what is
  // near me".
  const noCoords = assets.filter((a) => a.listable && a.status === 'active'
    && (a.lat == null || a.lon == null));
  if (noCoords.length) {
    out.push(F('drift', 'listable_without_coordinates',
      'Offerable assets with no coordinates — they cannot answer "what is near me".',
      noCoords.map((a) => a.id)));
  }

  // A moderation queue building up. Photos sitting in 'new' are a supplier
  // waiting and a listing that looks unfinished.
  const queued = photos.filter((p) => p.moderation === 'new' && days(p.created_at, at) > 3);
  if (queued.length) {
    out.push(F('drift', 'photos_awaiting_moderation_over_3d',
      'Photographs waiting more than three days for a decision.',
      queued.map((p) => p.id)));
  }

  // A week-rate charter quoted with no word about what else the client pays.
  // Charter norms mean fuel, food, berths and tax land on top — a base rate
  // presented as the price is how a client is surprised by half again.
  const bareRate = assets.filter((a) => a.listable && a.rate_unit === 'week'
    && a.rate_minor > 0 && !a.extras_note);
  if (bareRate.length) {
    out.push(F('drift', 'week_rate_without_extras_note',
      'Weekly charter rates offered with nothing said about fuel, provisioning, berths or tax.',
      bareRate.map((a) => a.id)));
  }

  return out;
}

/** Worst-first, with a one-line verdict — nobody should have to read the whole
 *  list to learn whether anything is wrong. */
export function assetReport(d, now) {
  const rank = { breach: 0, orphan: 1, drift: 2 };
  const findings = checkAssetData(d, now).sort((a, b) => rank[a.severity] - rank[b.severity]);
  const n = (s) => findings.filter((f) => f.severity === s).length;
  const doubled = findings.some((f) => f.code === 'asset_double_booked');
  return {
    ok: findings.length === 0,
    clean: n('breach') === 0,
    counts: { breach: n('breach'), orphan: n('orphan'), drift: n('drift') },
    verdict: doubled
      ? 'AN ASSET IS DOUBLE-BOOKED — two clients expect the same thing. Fix before anything else.'
      : n('breach')
        ? n('breach') + ' breach' + (n('breach') === 1 ? '' : 'es') + ' — somebody is about to be harmed or money is on the wrong party.'
        : n('orphan')
          ? n('orphan') + ' thing' + (n('orphan') === 1 ? '' : 's') + ' holding on to something it should have let go of.'
          : findings.length
            ? 'No breaches. ' + findings.length + ' listing' + (findings.length === 1 ? '' : 's') + ' that cannot do what it claims.'
            : 'Every asset, hold and photograph agrees.',
    findings,
  };
}
