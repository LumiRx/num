/**
 * DOES THE HOST SYSTEM STILL AGREE WITH ITSELF?
 *
 * Six tables now describe one relationship between two people, and each was
 * written by a different endpoint on a different day. That is exactly the
 * shape of system where the tables quietly stop agreeing — and where the
 * disagreement is invisible until somebody is billed for a client they
 * released, or keeps receiving work for a member who left.
 *
 * These checks are PURE FUNCTIONS OVER ROWS, deliberately. The alternative —
 * a pile of SQL in an admin route — cannot be tested without a database, so
 * in practice it never is, and a checker nobody tests is a checker that
 * reports "all clear" long after it stopped looking.
 *
 * Severity is about consequence, not tidiness:
 *   breach — a promise we made to a person is currently untrue, or money is
 *            landing on the wrong party. Fix today.
 *   orphan — a row points at something that is gone. Wrong answers follow.
 *   drift  — a setting that cannot do what it says. Nobody is harmed yet.
 */

const F = (severity, code, detail, ids) => ({ severity, code, detail, ids: ids || [] });

/**
 * @param d {{clients, hosts, offers, separations, links, areas, requests}}
 *          each an array of plain rows. Missing keys are treated as empty,
 *          so a caller can check one slice without faking the rest.
 */
export function checkHostData(d) {
  const clients = d.clients || [];
  const hosts = d.hosts || [];
  const offers = d.offers || [];
  const separations = d.separations || [];
  const links = d.links || [];
  const areas = d.areas || [];
  const requests = d.requests || [];

  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const sepByClient = new Set(separations.map((s) => s.client_id));
  const out = [];

  /* ── BREACH ─────────────────────────────────────────────────────────── */

  // An ending nobody recorded. The status says it is over; nothing says who
  // ended it, which is the one fact a later dispute turns on.
  const unrecorded = clients.filter((c) => c.status === "removed" && !sepByClient.has(c.id));
  if (unrecorded.length) {
    out.push(F("breach", "ended_without_record",
      "Client relationships ended with no separation record — who ended it cannot be established.",
      unrecorded.map((c) => c.id)));
  }

  // An ending nobody was told about. The other side still believes the
  // relationship exists, and the £5 is landing on whoever the stale row says.
  const untold = clients.filter((c) => c.status === "removed" && c.ended_at && !c.notified_at
                                       && (c.email || hostById.get(c.host_id)));
  if (untold.length) {
    out.push(F("breach", "ended_without_notice",
      "Ended relationships where the other side was never notified.",
      untold.map((c) => c.id)));
  }

  // The same person actively held by two hosts. Both would be billed the £5,
  // and worker/servicefee.mjs would answer with whichever row it read first.
  const byMember = new Map();
  for (const c of clients) {
    if (c.status !== "active" || !c.member_id) continue;
    byMember.set(c.member_id, (byMember.get(c.member_id) || []).concat(c.id));
  }
  const doubled = [...byMember.entries()].filter(([, ids]) => ids.length > 1);
  if (doubled.length) {
    out.push(F("breach", "member_has_two_hosts",
      "A NUM member is an active client of more than one host — the booking fee would be charged twice.",
      doubled.flatMap(([, ids]) => ids)));
  }

  /* THERE IS NO PER-BOOKING FEE ANY MORE (7 Sep 2026), so the two checks that
   * used to live here — work confirmed without a fee, and fees accrued against
   * a host with no card — are gone with it.
   *
   * What replaces them is the opposite check. A fee appearing on work
   * confirmed AFTER the change means something reintroduced a charge that no
   * host agreed to and no page mentions, which is worse than under-charging:
   * it is money taken quietly. Rows from before the change are left alone,
   * because they are history and were never collected. */
  const NO_FEE_FROM = "2026-09-07";
  const charged = requests.filter((r) =>
    r.booking_fee_minor > 0 && String(r.confirmed_at || r.created_at || "") >= NO_FEE_FROM);
  if (charged.length) {
    out.push(F("breach", "fee_charged_after_it_was_removed",
      "Bookings confirmed since the per-booking fee was removed are carrying one — a host is being charged for work.",
      charged.map((r) => r.id)));
  }

  // A client who cannot leave. Without a token there is no page that lets
  // them out, which makes the consent they gave one-directional.
  const trapped = clients.filter((c) => c.status !== "removed" && !c.member_token);
  if (trapped.length) {
    out.push(F("breach", "client_cannot_leave",
      "Live clients with no member token — these people have no way to remove themselves.",
      trapped.map((c) => c.id)));
  }

  /* ── ORPHAN ─────────────────────────────────────────────────────────── */

  // Still on the books of a host who is gone. Nobody is looking after them
  // and nobody has said so.
  const strandedByHost = clients.filter((c) => {
    const h = hostById.get(c.host_id);
    return c.status !== "removed" && (!h || h.status !== "active");
  });
  if (strandedByHost.length) {
    out.push(F("orphan", "client_of_closed_host",
      "Live clients belonging to a host that is closed or missing.",
      strandedByHost.map((c) => c.id)));
  }

  const danglingOffers = offers.filter((o) => o.client_id && !clientById.has(o.client_id));
  if (danglingOffers.length) {
    out.push(F("orphan", "offer_without_client",
      "Introduction offers pointing at a client row that no longer exists.",
      danglingOffers.map((o) => o.id)));
  }

  // Accepted, then the client went. The offer says yes to a relationship that
  // is over, so the member can never be re-offered that host.
  const staleAccepted = offers.filter((o) => {
    const c = o.client_id ? clientById.get(o.client_id) : null;
    return o.host_said === "yes" && c && c.status === "removed" && c.ended_by === "member";
  });
  if (staleAccepted.length) {
    out.push(F("orphan", "offer_held_after_member_left",
      "Offers still marked accepted although the member left — they cannot choose that host again.",
      staleAccepted.map((o) => o.id)));
  }

  const ghostAreas = areas.filter((a) => {
    const h = hostById.get(a.host_id);
    return !h || h.status !== "active";
  });
  if (ghostAreas.length) {
    out.push(F("orphan", "area_of_closed_host",
      "Coverage rows for hosts that are closed — they would still rank for introductions.",
      ghostAreas.map((a) => a.id)));
  }

  const liveLinkToGone = links.filter((l) => {
    if (l.status !== "accepted") return false;
    const a = hostById.get(l.host_a), b = hostById.get(l.host_b);
    return !a || !b || a.status !== "active" || b.status !== "active";
  });
  if (liveLinkToGone.length) {
    out.push(F("orphan", "network_link_to_closed_host",
      "Accepted network links where one side is closed — work could be handed to nobody.",
      liveLinkToGone.map((l) => l.id)));
  }

  // Handed out on a connection that is not accepted. The receiving host never
  // agreed to it, so nobody is actually doing this job.
  const linkKey = new Set(links.filter((l) => l.status === "accepted")
    .map((l) => [l.host_a, l.host_b].sort().join("|")));
  const unlinkedHandoffs = requests.filter((r) =>
    r.network_host_id && !linkKey.has([r.host_id, r.network_host_id].sort().join("|")));
  if (unlinkedHandoffs.length) {
    out.push(F("orphan", "handoff_without_link",
      "Requests handed to a host with no accepted connection — nobody agreed to do this work.",
      unlinkedHandoffs.map((r) => r.id)));
  }

  /* ── DRIFT ──────────────────────────────────────────────────────────── */

  // Switched on, but the plan cannot serve it. The host believes they are
  // reachable and is not — the worst kind of silent, because it looks fine.
  const PAID = new Set(["pro", "full"]);
  const introsOffPlan = hosts.filter((h) => h.status === "active" && h.accepts_intros && !PAID.has(h.tier));
  if (introsOffPlan.length) {
    out.push(F("drift", "intros_on_below_pro",
      "Hosts accepting introductions on a plan that does not include them — they will never receive any.",
      introsOffPlan.map((h) => h.id)));
  }
  const networkOffPlan = hosts.filter((h) => h.status === "active" && h.in_network && !PAID.has(h.tier));
  if (networkOffPlan.length) {
    out.push(F("drift", "network_on_below_pro",
      "Hosts listed in the network on a plan that does not include it.",
      networkOffPlan.map((h) => h.id)));
  }

  // Reachable in principle, invisible in practice: matching is city-based, so
  // a host with no coverage row is a host nobody is ever offered.
  const withAreas = new Set(areas.map((a) => a.host_id));
  const invisible = hosts.filter((h) => h.status === "active" && h.accepts_intros && !withAreas.has(h.id));
  if (invisible.length) {
    out.push(F("drift", "intros_on_without_coverage",
      "Hosts accepting introductions with no city saved — nearest-host matching cannot see them.",
      invisible.map((h) => h.id)));
  }

  // Texts switched on with nothing to text.
  const smsNoPhone = hosts.filter((h) => h.sms_opt_in && !h.notify_phone);
  if (smsNoPhone.length) {
    out.push(F("drift", "sms_on_without_number",
      "Hosts with text alerts on and no number saved.",
      smsNoPhone.map((h) => h.id)));
  }

  return out;
}

/** Ordered worst-first, with a one-line verdict. A checker that returns a
 *  bare list makes someone read all of it to learn whether anything is wrong. */
export function integrityReport(d) {
  const rank = { breach: 0, orphan: 1, drift: 2 };
  const findings = checkHostData(d).sort((a, b) => rank[a.severity] - rank[b.severity]);
  const n = (s) => findings.filter((f) => f.severity === s).length;
  return {
    ok: findings.length === 0,
    clean: n("breach") === 0,
    counts: { breach: n("breach"), orphan: n("orphan"), drift: n("drift") },
    verdict: n("breach")
      ? n("breach") + " promise or money breach — fix today"
      : findings.length
        ? "No breaches. " + findings.length + " thing" + (findings.length === 1 ? "" : "s") + " to tidy."
        : "Everything agrees.",
    findings,
  };
}
