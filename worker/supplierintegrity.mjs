/**
 * DOES THE SUPPLIER SIDE STILL AGREE WITH ITSELF?
 *
 * The client half of the host system has had a checker since 0015. This is
 * the same idea for the half nobody could see until now: the suppliers who
 * actually prep the car, drive it, open the villa and hand over the keys.
 *
 * Why a checker matters more here than anywhere else in NUM: a wrong row in
 * the client half produces a wrong answer. A wrong row here produces a car
 * that is not at the airport. The cost of a mistake is physical, it lands on
 * a person standing in an arrivals hall, and it is unrecoverable — you
 * cannot re-run 11:05am.
 *
 * THE WALL is the rule these checks defend above all others: the client
 * never learns the supplier exists, and the supplier never learns who the
 * client is. num_jobs has no client_id column precisely so this cannot
 * happen by accident — but a host can still type a name into a free-text
 * field, so we look.
 *
 * PURE FUNCTIONS OVER ROWS, same as hostintegrity.mjs and for the same
 * reason: a checker that needs a live database to run is a checker nobody
 * runs.
 *
 * Severity is about consequence, not tidiness:
 *   breach — a promise is currently untrue, the wall has been crossed, or
 *            money is landing on the wrong party. Fix today.
 *   orphan — a row points at something gone, or a job is sitting in a state
 *            with nobody coming. Wrong answers and missed pickups follow.
 *   drift  — a setting that cannot do what it says. Nobody is harmed yet.
 */

const F = (severity, code, detail, ids) => ({ severity, code, detail, ids: ids || [] });

/** Statuses in which a job is still live work somebody is expecting. */
export const LIVE = new Set(["sent", "accepted", "in_progress", "ready"]);
/** Statuses in which the work is over, one way or another. */
export const CLOSED = new Set(["declined", "expired", "done", "cancelled"]);

/** The only legal moves. Anything else in num_job_events is a bug in a
 *  writer, and a bug in a writer is how a job ends up in a state the console
 *  cannot render. */
export const NEXT = {
  draft:       ["sent", "cancelled"],
  sent:        ["accepted", "declined", "expired", "cancelled"],
  accepted:    ["in_progress", "cancelled"],
  in_progress: ["ready", "cancelled"],
  ready:       ["delivered", "done", "cancelled"],   // 'done' direct = collected
  delivered:   ["done", "cancelled"],
  declined:    [],
  expired:     [],
  done:        [],
  cancelled:   [],
};

/** True when moving from → to is a legal transition. */
export function canMove(from, to) {
  return Boolean(NEXT[from] && NEXT[from].includes(to));
}

const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;
const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;

/**
 * @param d {{suppliers, links, locations, services, jobs, events, receipts,
 *            hosts, requests, clients}}
 *          each an array of plain rows. Missing keys are treated as empty,
 *          so a caller can check one slice without faking the rest.
 * @param now ISO timestamp to measure ages against. Defaults to real now.
 */
export function checkSupplierData(d, now) {
  const at = now || new Date().toISOString();
  const suppliers = d.suppliers || [];
  const links = d.links || [];
  const locations = d.locations || [];
  const jobs = d.jobs || [];
  const events = d.events || [];
  const receipts = d.receipts || [];
  const hosts = d.hosts || [];
  const requests = d.requests || [];
  const clients = d.clients || [];

  const supById = new Map(suppliers.map((s) => [s.id, s]));
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const linkById = new Map(links.map((l) => [l.id, l]));
  const linkByPair = new Map(links.map((l) => [l.host_id + "|" + l.supplier_id, l]));
  const locById = new Map(locations.map((l) => [l.id, l]));
  const reqById = new Map(requests.map((r) => [r.id, r]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const eventsByJob = new Map();
  for (const e of events) {
    if (!eventsByJob.has(e.job_id)) eventsByJob.set(e.job_id, []);
    eventsByJob.get(e.job_id).push(e);
  }
  const receiptsByJob = new Map();
  for (const r of receipts) {
    if (!receiptsByJob.has(r.job_id)) receiptsByJob.set(r.job_id, []);
    receiptsByJob.get(r.job_id).push(r);
  }
  const out = [];

  /* ── BREACH ─────────────────────────────────────────────────────────── */

  // Work sent down a relationship that does not exist, or no longer does.
  // The supplier is being asked to do something by a host they never agreed
  // to work with — or one they have since left.
  const noLink = jobs.filter((j) => {
    if (CLOSED.has(j.status)) return false;
    const l = linkById.get(j.link_id) || linkByPair.get(j.host_id + "|" + j.supplier_id);
    return !l || l.status !== "accepted";
  });
  if (noLink.length) {
    out.push(F("breach", "job_without_accepted_link",
      "Live jobs sent to a supplier with no accepted link — work is travelling down a relationship that does not exist.",
      noLink.map((j) => j.id)));
  }

  // THE WALL. A client's real name or phone number sitting in a field the
  // supplier can read. The host may share a name deliberately, but it must
  // be a name they typed — never one we copied across from the client row.
  const leaked = jobs.filter((j) => {
    const r = j.request_id ? reqById.get(j.request_id) : null;
    const c = r && r.client_id ? clientById.get(r.client_id) : null;
    if (!c) return false;
    const hay = [j.contact_label, j.dropoff_note, j.brief, j.title].filter(Boolean).join(" ").toLowerCase();
    const name = (c.name || "").trim().toLowerCase();
    const phone = (c.phone || "").replace(/\D/g, "");
    const jphone = (j.contact_phone || "").replace(/\D/g, "");
    const nameHit = name.length > 3 && hay.includes(name);
    const phoneHit = phone.length > 6 && (hay.replace(/\D/g, "").includes(phone)
                                          || (jphone && jphone.endsWith(phone.slice(-7))));
    return nameHit || phoneHit;
  });
  if (leaked.length) {
    out.push(F("breach", "client_identity_on_job",
      "Jobs carrying a client's own name or number where the supplier can read it — the wall between client and supplier has been crossed.",
      leaked.map((j) => j.id)));
  }

  // A delivery with nowhere to deliver to. The database CHECK stops this on
  // write, so a row here means something wrote around it.
  const nowhere = jobs.filter((j) => j.fulfilment === "deliver"
    && !["draft", "cancelled"].includes(j.status) && !j.dropoff_address);
  if (nowhere.length) {
    out.push(F("breach", "delivery_without_address",
      "Delivery jobs that left draft with no drop-off address — an instruction nobody can follow.",
      nowhere.map((j) => j.id)));
  }

  // A status change nobody recorded. The trail is the whole reason this
  // system can be trusted, so a gap in it is not tidiness, it is the failure.
  const untrailed = jobs.filter((j) => {
    if (j.status === "draft") return false;
    const evs = eventsByJob.get(j.id) || [];
    return !evs.some((e) => e.to_status === j.status);
  });
  if (untrailed.length) {
    out.push(F("breach", "status_without_event",
      "Jobs whose current status has no event recording how it got there — a silent change cannot be told apart from a bug.",
      untrailed.map((j) => j.id)));
  }

  // A move that is not on the map. Someone jumped a state.
  const illegal = [];
  for (const e of events) {
    if (!e.from_status || !e.to_status) continue;
    if (e.from_status === e.to_status) continue;
    if (!canMove(e.from_status, e.to_status)) illegal.push(e.job_id);
  }
  if (illegal.length) {
    out.push(F("breach", "illegal_transition",
      "Jobs that moved between states the lifecycle does not allow.",
      [...new Set(illegal)]));
  }

  // Two live jobs for the same client request. Somebody is about to send two
  // cars, or two suppliers are both holding a slot they will both bill for.
  const byReq = new Map();
  for (const j of jobs) {
    if (!j.request_id || CLOSED.has(j.status)) continue;
    if (!byReq.has(j.request_id)) byReq.set(j.request_id, []);
    byReq.get(j.request_id).push(j.id);
  }
  const doubled = [...byReq.values()].filter((v) => v.length > 1).flat();
  if (doubled.length) {
    out.push(F("breach", "request_double_dispatched",
      "One client request with more than one live job against it — two suppliers are both working it.",
      doubled));
  }

  // Money recorded as paid with nothing to show for it. The receipt is what
  // makes the number defensible to both sides.
  const noReceipt = jobs.filter((j) => j.settle_status === "paid"
    && !(receiptsByJob.get(j.id) || []).some((r) => r.kind === "receipt"));
  if (noReceipt.length) {
    out.push(F("breach", "paid_without_receipt",
      "Jobs marked paid with no receipt on file — the amount cannot be evidenced by either side.",
      noReceipt.map((j) => j.id)));
  }

  // The receipt and the job disagree about the number.
  const mismatched = jobs.filter((j) => {
    const rs = (receiptsByJob.get(j.id) || []).filter((r) => r.kind === "receipt");
    if (!rs.length || j.unit === "quote") return false;
    return rs.some((r) => r.amount_minor !== j.cost_minor || r.currency !== j.currency);
  });
  if (mismatched.length) {
    out.push(F("breach", "receipt_disagrees_with_job",
      "Receipts whose amount or currency does not match the job they settle.",
      mismatched.map((j) => j.id)));
  }

  // Live work on a link that has ended. Either the supplier walked away and
  // the host still expects them, or the reverse.
  const onEnded = jobs.filter((j) => {
    if (!LIVE.has(j.status)) return false;
    const l = linkById.get(j.link_id);
    return l && l.status === "ended";
  });
  if (onEnded.length) {
    out.push(F("breach", "live_job_on_ended_link",
      "Live jobs on a host-supplier relationship that has already ended.",
      onEnded.map((j) => j.id)));
  }

  // An ending nobody was told about — the same rule the client half has.
  const untold = links.filter((l) => l.status === "ended" && l.ended_at && !l.notified_at);
  if (untold.length) {
    out.push(F("breach", "link_ended_without_notice",
      "Host-supplier relationships ended with the other side never told.",
      untold.map((l) => l.id)));
  }

  /* ── ORPHAN ─────────────────────────────────────────────────────────── */

  // Sent, and nobody was ever pinged. The host believes it is in motion.
  const unpinged = jobs.filter((j) => j.status === "sent" && !j.supplier_notified_at
    && j.sent_at && mins(j.sent_at, at) > 10);
  if (unpinged.length) {
    out.push(F("orphan", "sent_but_supplier_never_notified",
      "Jobs sent more than ten minutes ago that never reached the supplier — the host thinks this is in motion.",
      unpinged.map((j) => j.id)));
  }

  // Sitting unanswered past the host's own expiry window, still marked sent.
  const stale = jobs.filter((j) => {
    if (j.status !== "sent" || !j.sent_at) return false;
    const h = hostById.get(j.host_id);
    const win = (h && h.job_expiry_min) || 120;
    return mins(j.sent_at, at) > win;
  });
  if (stale.length) {
    out.push(F("orphan", "sent_past_expiry",
      "Jobs unanswered past the host's expiry window and still marked sent — the host has not been told to try someone else.",
      stale.map((j) => j.id)));
  }

  // Nobody is coming. The request is dead but the supplier is still working.
  const orphanedByRequest = jobs.filter((j) => {
    if (!j.request_id || CLOSED.has(j.status)) return false;
    const r = reqById.get(j.request_id);
    return !r || ["declined", "cancelled"].includes(r.status);
  });
  if (orphanedByRequest.length) {
    out.push(F("orphan", "job_for_dead_request",
      "Live jobs whose client request is gone, declined or cancelled — the supplier is still preparing something nobody wants.",
      orphanedByRequest.map((j) => j.id)));
  }

  // A job pointing at a location that is not this supplier's.
  const wrongPlace = jobs.filter((j) => {
    if (!j.location_id) return false;
    const l = locById.get(j.location_id);
    return !l || l.supplier_id !== j.supplier_id;
  });
  if (wrongPlace.length) {
    out.push(F("orphan", "job_location_not_suppliers",
      "Jobs starting from a location that does not belong to the supplier they were sent to.",
      wrongPlace.map((j) => j.id)));
  }

  // A job on a supplier who has closed or paused their account.
  const goneSupplier = jobs.filter((j) => {
    if (!LIVE.has(j.status)) return false;
    const s = supById.get(j.supplier_id);
    return !s || s.status !== "active";
  });
  if (goneSupplier.length) {
    out.push(F("orphan", "live_job_on_inactive_supplier",
      "Live jobs assigned to a supplier who is paused, closed or missing.",
      goneSupplier.map((j) => j.id)));
  }

  // Declined or expired, request still open, nothing sent to anyone else.
  const notReassigned = jobs.filter((j) => {
    if (!["declined", "expired"].includes(j.status) || !j.request_id) return false;
    const r = reqById.get(j.request_id);
    if (!r || ["declined", "cancelled", "done"].includes(r.status)) return false;
    return !jobs.some((k) => k.request_id === j.request_id && k.id !== j.id && !CLOSED.has(k.status));
  });
  if (notReassigned.length) {
    out.push(F("orphan", "declined_and_never_reassigned",
      "Jobs declined or expired on requests that are still open, with nothing sent to anyone else.",
      notReassigned.map((j) => j.id)));
  }

  /* ── DRIFT ──────────────────────────────────────────────────────────── */

  // Delivered with no photo, for a host who asked for photos.
  const noProof = jobs.filter((j) => {
    const h = hostById.get(j.host_id);
    return h && h.requires_proof && ["delivered", "done"].includes(j.status) && !j.proof_url;
  });
  if (noProof.length) {
    out.push(F("drift", "delivered_without_proof",
      "Jobs closed without the drop-off photo this host requires.",
      noProof.map((j) => j.id)));
  }

  // Work finished a month ago that nobody has invoiced. This is where a
  // host quietly loses money — not to us, to their own paperwork.
  const unbilled = jobs.filter((j) => j.status === "done" && j.settle_status === "unbilled"
    && j.done_at && days(j.done_at, at) > 30 && (j.cost_minor > 0 || j.unit === "quote"));
  if (unbilled.length) {
    out.push(F("drift", "done_and_unbilled_over_30d",
      "Jobs completed over thirty days ago with nothing invoiced against them.",
      unbilled.map((j) => j.id)));
  }

  // A dispute nobody has moved on in a fortnight.
  const stuck = jobs.filter((j) => j.settle_status === "disputed" && j.updated_at
    && days(j.updated_at, at) > 14);
  if (stuck.length) {
    out.push(F("drift", "dispute_untouched_14d",
      "Payment disputes with no movement in two weeks.",
      stuck.map((j) => j.id)));
  }

  // A supplier who is open to new hosts but has said nothing about where
  // they work. They will never appear in anyone's search.
  const placeless = suppliers.filter((s) => s.open_to_hosts && s.status === "active"
    && !locations.some((l) => l.supplier_id === s.id && l.active));
  if (placeless.length) {
    out.push(F("drift", "open_to_hosts_without_a_location",
      "Suppliers open to new hosts with no active location — nobody can find them.",
      placeless.map((s) => s.id)));
  }

  // A supplier open to new hosts with nothing on their list.
  const serviceless = suppliers.filter((s) => s.open_to_hosts && s.status === "active"
    && !(d.services || []).some((v) => v.supplier_id === s.id && v.active));
  if (serviceless.length) {
    out.push(F("drift", "open_to_hosts_without_a_service",
      "Suppliers open to new hosts with nothing on their service list.",
      serviceless.map((s) => s.id)));
  }

  // A link that has sat pending long enough that both sides have forgotten.
  const forgotten = links.filter((l) => l.status === "pending" && l.created_at
    && days(l.created_at, at) > 21);
  if (forgotten.length) {
    out.push(F("drift", "link_pending_over_21d",
      "Host-supplier invitations pending for over three weeks.",
      forgotten.map((l) => l.id)));
  }

  return out;
}

/** Ordered worst-first, with a one-line verdict, so nobody has to read the
 *  whole list to learn whether anything is wrong. */
export function supplierReport(d, now) {
  const rank = { breach: 0, orphan: 1, drift: 2 };
  const findings = checkSupplierData(d, now).sort((a, b) => rank[a.severity] - rank[b.severity]);
  const n = (s) => findings.filter((f) => f.severity === s).length;
  return {
    ok: findings.length === 0,
    clean: n("breach") === 0,
    counts: { breach: n("breach"), orphan: n("orphan"), drift: n("drift") },
    verdict: n("breach")
      ? n("breach") + " breach" + (n("breach") === 1 ? "" : "es") + " — a promise is untrue or money is on the wrong party. Fix today."
      : n("orphan")
        ? n("orphan") + " job" + (n("orphan") === 1 ? "" : "s") + " nobody is coming for."
        : findings.length
          ? "No breaches. " + findings.length + " thing" + (findings.length === 1 ? "" : "s") + " to tidy."
          : "Every job, link and receipt agrees.",
    findings,
  };
}
