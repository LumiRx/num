/**
 * The supplier layer, checked.
 *
 * Two things are tested here and they are different in kind:
 *
 *  1. The MIGRATION. Every CHECK in 0019 is asserted from the outside, by
 *     trying to write the row it is supposed to refuse. A constraint nobody
 *     tries to break is a constraint that quietly stopped working.
 *
 *  2. The CHECKER. Every finding in supplierintegrity.mjs gets a fixture
 *     that triggers it and, where the distinction matters, one that must
 *     not. A checker with no test for its negative case reports problems
 *     that are not there, which is how people learn to ignore it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { checkSupplierData, supplierReport, canMove, NEXT } from "./supplierintegrity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, "migrations", "0019_suppliers.sql"), "utf8");

const NOW = "2026-09-07T12:00:00.000Z";
const ago = (mins) => new Date(Date.parse(NOW) - mins * 60000).toISOString();

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE num_hosts (id TEXT PRIMARY KEY, tier TEXT);");
  for (const s of SQL.split(";").map((x) => x.trim()).filter(Boolean)) d.exec(s + ";");
  return d;
}
const codes = (f) => f.map((x) => x.code);
const has = (f, code) => codes(f).includes(code);

/* ── 1. THE MIGRATION ─────────────────────────────────────────────────── */

test("migration: no semicolon hides inside a comment", () => {
  // The runner splits on semicolons. One inside prose cuts a statement in
  // half and the half that lands is usually still valid SQL, which is the
  // worst possible failure: silent and wrong.
  const bad = SQL.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.indexOf("--") >= 0 && l.slice(l.indexOf("--")).includes(";"));
  assert.deepEqual(bad, []);
});

test("migration: applies cleanly and creates every table", () => {
  const d = db();
  const names = d.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
  for (const t of ["num_suppliers", "num_supplier_links", "num_supplier_locations",
                   "num_supplier_services", "num_jobs", "num_job_events",
                   "num_job_messages", "num_receipts"]) {
    assert.ok(names.includes(t), "missing " + t);
  }
});

test("migration: num_jobs has no column that could hold a client identity", () => {
  // The wall, enforced by absence. If someone adds client_id here later,
  // this test is the thing that asks them why.
  const d = db();
  const cols = d.prepare("pragma table_info(num_jobs)").all().map((c) => c.name);
  assert.ok(!cols.includes("client_id"));
  assert.ok(!cols.includes("client_name"));
  assert.ok(!cols.includes("member_id"));
  assert.ok(cols.includes("contact_label"), "the supplier still needs someone to look for");
});

// Insert a job row, overriding any default. Kept explicit rather than clever
// so a failure points at the column that broke, not at the helper.
let jobN = 0;
const insJob = (d, status, extra) => {
  const row = {
    id: "j" + (++jobN), host_id: "h", supplier_id: "s", link_id: "l",
    service_key: "car", title: "Car", fulfilment: "deliver",
    status, created_at: "2026-09-01", ...(extra || {}),
  };
  const cols = Object.keys(row);
  const sql = "insert into num_jobs (" + cols.join(",") + ") values ("
    + cols.map(() => "?").join(",") + ")";
  d.prepare(sql).run(...cols.map((c) => row[c]));
};

test("migration: a delivery cannot leave draft without a drop-off address", () => {
  const d = db();
  insJob(d, "draft");                                    // fine — still a draft
  assert.throws(() => insJob(d, "sent", {}));   // not fine — nowhere to go
});

test("migration: a delivery with an address is accepted", () => {
  const d = db();
  insJob(d, "sent", { dropoff_address: "T5 arrivals, bay 3" });
  assert.equal(d.prepare("select count(*) c from num_jobs").get().c, 1);
});

test("migration: a collect job needs no address", () => {
  const d = db();
  d.prepare("insert into num_jobs (id,host_id,supplier_id,link_id,service_key,title,fulfilment,status,created_at)"
    + " values ('jc','h','s','l','car','Car','collect','sent','2026-09-01')").run();
  assert.equal(d.prepare("select count(*) c from num_jobs").get().c, 1);
});

test("migration: a declined job must say why", () => {
  const d = db();
  assert.throws(() => insJob(d, "declined", { dropoff_address: "x" }));
  insJob(d, "declined", { dropoff_address: "x", decline_reason: "car is in for service" });
});

test("migration: a cancelled job must record who cancelled it and when", () => {
  const d = db();
  assert.throws(() => insJob(d, "cancelled", { cancel_reason: "client changed plans" }));
  insJob(d, "cancelled", { cancelled_at: NOW, cancelled_by: "host" });
});

test("migration: a priced job must carry a number, a quote job must not pretend to", () => {
  const d = db();
  assert.throws(() => insJob(d, "sent", { dropoff_address: "x", unit: "fixed", cost_minor: 0 }));
  insJob(d, "sent", { dropoff_address: "x", unit: "fixed", cost_minor: 12000 });
  insJob(d, "sent", { dropoff_address: "x", unit: "quote", cost_minor: 0 });
});

test("migration: money cannot be recorded against work that was never accepted", () => {
  const d = db();
  assert.throws(() => insJob(d, "sent", { dropoff_address: "x", settle_status: "invoiced" }));
  insJob(d, "done", { dropoff_address: "x", done_at: NOW, settle_status: "invoiced" });
});

test("migration: an ended link must say who ended it", () => {
  const d = db();
  const ins = (extra) => d.prepare("insert into num_supplier_links (id,host_id,supplier_id,asked_by,status,created_at"
    + (extra ? "," + Object.keys(extra).join(",") : "") + ") values ('l','h','s','host','ended','2026-09-01'"
    + (extra ? "," + Object.values(extra).map((v) => "'" + v + "'").join(",") : "") + ")").run();
  assert.throws(() => ins(null));
  ins({ ended_at: NOW, ended_by: "supplier" });
});

test("migration: a supplier service priced in anything but quote needs a price", () => {
  const d = db();
  const ins = (unit, price, id) => d.prepare("insert into num_supplier_services"
    + " (id,supplier_id,service_key,title,unit,price_minor,created_at) values (?,?,?,?,?,?,?)")
    .run(id, "s", "car", "Airport transfer", unit, price, NOW);
  assert.throws(() => ins("fixed", 0, "v1"));
  ins("fixed", 9500, "v2");
  ins("quote", 0, "v3");
});

/* ── 2. THE LIFECYCLE ─────────────────────────────────────────────────── */

test("lifecycle: every state is reachable and every terminal state is terminal", () => {
  const reachable = new Set(["draft"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const from of [...reachable]) for (const to of NEXT[from]) if (!reachable.has(to)) { reachable.add(to); grew = true; }
  }
  assert.deepEqual([...reachable].sort(), Object.keys(NEXT).sort());
  for (const t of ["declined", "expired", "done", "cancelled"]) assert.deepEqual(NEXT[t], []);
});

test("lifecycle: a job cannot skip from sent straight to done", () => {
  assert.equal(canMove("sent", "done"), false);
  assert.equal(canMove("sent", "accepted"), true);
});

test("lifecycle: a collected job may close from ready without a delivery", () => {
  // fulfilment 'collect' means nobody delivers anything — ready IS the
  // handover. Forcing it through 'delivered' would make the trail lie.
  assert.equal(canMove("ready", "done"), true);
  assert.equal(canMove("ready", "delivered"), true);
});

test("lifecycle: anything live can still be cancelled", () => {
  for (const s of ["draft", "sent", "accepted", "in_progress", "ready", "delivered"]) {
    assert.equal(canMove(s, "cancelled"), true, s + " must be cancellable");
  }
});

/* ── 3. THE CHECKER — breaches ────────────────────────────────────────── */

const link = (o) => ({ id: "l1", host_id: "h1", supplier_id: "s1", status: "accepted",
                       asked_by: "host", created_at: ago(60), ...o });
const job = (o) => ({ id: "j1", host_id: "h1", supplier_id: "s1", link_id: "l1",
                      service_key: "car", title: "Black S-Class", fulfilment: "deliver",
                      dropoff_address: "T5 arrivals", status: "accepted", unit: "fixed",
                      cost_minor: 12000, currency: "GBP", settle_status: "unbilled",
                      created_at: ago(60), sent_at: ago(50), supplier_notified_at: ago(49), ...o });
const ev = (o) => ({ id: "e1", job_id: "j1", at: ago(50), actor_kind: "host",
                     event: "accepted", from_status: "sent", to_status: "accepted", ...o });
const base = (o) => ({
  hosts: [{ id: "h1", job_expiry_min: 120, requires_proof: 0 }],
  suppliers: [{ id: "s1", status: "active", open_to_hosts: 0 }],
  links: [link()], jobs: [job()], events: [ev()], ...o,
});

test("checker: a clean world reports nothing", () => {
  const r = supplierReport(base(), NOW);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
  assert.equal(r.ok, true);
});

test("breach: work sent down a link that was never accepted", () => {
  const f = checkSupplierData(base({ links: [link({ status: "pending" })] }), NOW);
  assert.ok(has(f, "job_without_accepted_link"));
});

test("breach: the client's own name reaches the supplier", () => {
  const f = checkSupplierData(base({
    requests: [{ id: "r1", client_id: "c1", status: "confirmed" }],
    clients: [{ id: "c1", name: "Amelia Hartwell", phone: "+447700900123" }],
    jobs: [job({ request_id: "r1", contact_label: "Amelia Hartwell" })],
  }), NOW);
  assert.ok(has(f, "client_identity_on_job"));
});

test("breach: the client's phone number reaches the supplier", () => {
  const f = checkSupplierData(base({
    requests: [{ id: "r1", client_id: "c1", status: "confirmed" }],
    clients: [{ id: "c1", name: "Amelia Hartwell", phone: "+44 7700 900123" }],
    jobs: [job({ request_id: "r1", contact_phone: "07700900123" })],
  }), NOW);
  assert.ok(has(f, "client_identity_on_job"));
});

test("no breach: a host's own alias for the client is fine", () => {
  // This is the normal case and it must stay quiet, or hosts learn to
  // ignore the checker.
  const f = checkSupplierData(base({
    requests: [{ id: "r1", client_id: "c1", status: "confirmed" }],
    clients: [{ id: "c1", name: "Amelia Hartwell", phone: "+447700900123" }],
    jobs: [job({ request_id: "r1", contact_label: "Mr H's guest", contact_phone: "+447700111222" })],
  }), NOW);
  assert.ok(!has(f, "client_identity_on_job"), JSON.stringify(codes(f)));
});

test("breach: a delivery that left draft with nowhere to go", () => {
  const f = checkSupplierData(base({ jobs: [job({ dropoff_address: null })] }), NOW);
  assert.ok(has(f, "delivery_without_address"));
});

test("breach: a status with no event behind it", () => {
  const f = checkSupplierData(base({ events: [] }), NOW);
  assert.ok(has(f, "status_without_event"));
});

test("breach: a move the lifecycle does not allow", () => {
  const f = checkSupplierData(base({
    events: [ev(), ev({ id: "e2", from_status: "sent", to_status: "done" })],
  }), NOW);
  assert.ok(has(f, "illegal_transition"));
});

test("breach: two live jobs against one client request", () => {
  const f = checkSupplierData(base({
    requests: [{ id: "r1", client_id: "c1", status: "confirmed" }],
    jobs: [job({ request_id: "r1" }), job({ id: "j2", request_id: "r1", supplier_id: "s2" })],
    events: [ev(), ev({ id: "e2", job_id: "j2" })],
  }), NOW);
  assert.ok(has(f, "request_double_dispatched"));
});

test("breach: paid, with no receipt anyone could point at", () => {
  const f = checkSupplierData(base({
    jobs: [job({ status: "done", done_at: ago(30), settle_status: "paid" })],
    events: [ev({ to_status: "done" })],
  }), NOW);
  assert.ok(has(f, "paid_without_receipt"));
});

test("breach: the receipt and the job disagree about the amount", () => {
  const f = checkSupplierData(base({
    jobs: [job({ status: "done", done_at: ago(30), settle_status: "paid" })],
    events: [ev({ to_status: "done" })],
    receipts: [{ id: "rc1", job_id: "j1", kind: "receipt", amount_minor: 15000, currency: "GBP" }],
  }), NOW);
  assert.ok(has(f, "receipt_disagrees_with_job"));
});

test("no breach: a matching receipt settles it", () => {
  const f = checkSupplierData(base({
    jobs: [job({ status: "done", done_at: ago(30), settle_status: "paid" })],
    events: [ev({ to_status: "done" })],
    receipts: [{ id: "rc1", job_id: "j1", kind: "receipt", amount_minor: 12000, currency: "GBP" }],
  }), NOW);
  assert.ok(!has(f, "paid_without_receipt"));
  assert.ok(!has(f, "receipt_disagrees_with_job"));
});

test("breach: live work on a relationship that has ended", () => {
  const f = checkSupplierData(base({
    links: [link({ status: "ended", ended_at: ago(10), ended_by: "supplier", notified_at: ago(9) })],
    jobs: [job({ status: "in_progress" })],
    events: [ev({ from_status: "accepted", to_status: "in_progress" })],
  }), NOW);
  assert.ok(has(f, "live_job_on_ended_link"));
});

test("breach: an ending nobody was told about", () => {
  const f = checkSupplierData(base({
    links: [link({ status: "ended", ended_at: ago(10), ended_by: "host" })],
    jobs: [], events: [],
  }), NOW);
  assert.ok(has(f, "link_ended_without_notice"));
});

/* ── 4. THE CHECKER — orphans ─────────────────────────────────────────── */

test("orphan: sent, and the supplier was never pinged", () => {
  const f = checkSupplierData(base({
    jobs: [job({ status: "sent", sent_at: ago(30), supplier_notified_at: null })],
    events: [ev({ from_status: "draft", to_status: "sent" })],
  }), NOW);
  assert.ok(has(f, "sent_but_supplier_never_notified"));
});

test("no orphan: sent two minutes ago and not yet pinged is not a problem", () => {
  const f = checkSupplierData(base({
    jobs: [job({ status: "sent", sent_at: ago(2), supplier_notified_at: null })],
    events: [ev({ from_status: "draft", to_status: "sent" })],
  }), NOW);
  assert.ok(!has(f, "sent_but_supplier_never_notified"));
});

test("orphan: unanswered past the host's own expiry window", () => {
  const f = checkSupplierData(base({
    hosts: [{ id: "h1", job_expiry_min: 60 }],
    jobs: [job({ status: "sent", sent_at: ago(90) })],
    events: [ev({ from_status: "draft", to_status: "sent" })],
  }), NOW);
  assert.ok(has(f, "sent_past_expiry"));
});

test("orphan: the supplier is working on a request that no longer exists", () => {
  const f = checkSupplierData(base({
    requests: [{ id: "r1", client_id: "c1", status: "cancelled" }],
    jobs: [job({ request_id: "r1", status: "in_progress" })],
    events: [ev({ to_status: "in_progress" })],
  }), NOW);
  assert.ok(has(f, "job_for_dead_request"));
});

test("orphan: a job starting from someone else's yard", () => {
  const f = checkSupplierData(base({
    locations: [{ id: "loc1", supplier_id: "s2", active: 1 }],
    jobs: [job({ location_id: "loc1" })],
  }), NOW);
  assert.ok(has(f, "job_location_not_suppliers"));
});

test("orphan: live work on a supplier who has paused", () => {
  const f = checkSupplierData(base({
    suppliers: [{ id: "s1", status: "paused" }],
    jobs: [job({ status: "ready" })],
    events: [ev({ to_status: "ready" })],
  }), NOW);
  assert.ok(has(f, "live_job_on_inactive_supplier"));
});

test("orphan: declined, request still open, nothing sent to anyone else", () => {
  const f = checkSupplierData(base({
    requests: [{ id: "r1", client_id: "c1", status: "awaiting_host" }],
    jobs: [job({ request_id: "r1", status: "declined", decline_reason: "in for service" })],
    events: [ev({ to_status: "declined" })],
  }), NOW);
  assert.ok(has(f, "declined_and_never_reassigned"));
});

test("no orphan: declined, but a second supplier already has it", () => {
  const f = checkSupplierData(base({
    requests: [{ id: "r1", client_id: "c1", status: "awaiting_host" }],
    jobs: [job({ request_id: "r1", status: "declined", decline_reason: "in for service" }),
           job({ id: "j2", request_id: "r1", supplier_id: "s2", status: "accepted" })],
    events: [ev({ to_status: "declined" }), ev({ id: "e2", job_id: "j2" })],
  }), NOW);
  assert.ok(!has(f, "declined_and_never_reassigned"));
});

/* ── 5. THE CHECKER — drift ───────────────────────────────────────────── */

test("drift: closed without the photo this host asked for", () => {
  const f = checkSupplierData(base({
    hosts: [{ id: "h1", requires_proof: 1 }],
    jobs: [job({ status: "delivered", delivered_at: ago(20) })],
    events: [ev({ to_status: "delivered" })],
  }), NOW);
  assert.ok(has(f, "delivered_without_proof"));
});

test("drift: a month of finished work nobody invoiced", () => {
  const f = checkSupplierData(base({
    jobs: [job({ status: "done", done_at: "2026-07-01T09:00:00.000Z", settle_status: "unbilled" })],
    events: [ev({ to_status: "done" })],
  }), NOW);
  assert.ok(has(f, "done_and_unbilled_over_30d"));
});

test("drift: a dispute nobody has touched in a fortnight", () => {
  const f = checkSupplierData(base({
    jobs: [job({ status: "done", done_at: ago(60), settle_status: "disputed",
                 updated_at: "2026-08-01T09:00:00.000Z" })],
    events: [ev({ to_status: "done" })],
  }), NOW);
  assert.ok(has(f, "dispute_untouched_14d"));
});

test("drift: open to new hosts, but findable by nobody", () => {
  const f = checkSupplierData({
    suppliers: [{ id: "s9", status: "active", open_to_hosts: 1 }],
    locations: [], services: [],
  }, NOW);
  assert.ok(has(f, "open_to_hosts_without_a_location"));
  assert.ok(has(f, "open_to_hosts_without_a_service"));
});

test("drift: an invitation that has sat for three weeks", () => {
  const f = checkSupplierData({
    links: [link({ status: "pending", created_at: "2026-08-01T09:00:00.000Z" })],
  }, NOW);
  assert.ok(has(f, "link_pending_over_21d"));
});

/* ── 6. THE REPORT ────────────────────────────────────────────────────── */

test("report: breaches are ranked above everything else and named plainly", () => {
  const r = supplierReport(base({
    links: [link({ status: "pending", created_at: "2026-08-01T09:00:00.000Z" })],
    jobs: [job({ status: "sent", sent_at: ago(300), supplier_notified_at: null })],
    events: [ev({ from_status: "draft", to_status: "sent" })],
  }), NOW);
  assert.equal(r.findings[0].severity, "breach");
  assert.equal(r.clean, false);
  assert.match(r.verdict, /breach/);
});

test("report: a world with only tidying to do says so, and does not cry breach", () => {
  const r = supplierReport({
    links: [link({ status: "pending", created_at: "2026-08-01T09:00:00.000Z" })],
  }, NOW);
  assert.equal(r.clean, true);
  assert.match(r.verdict, /No breaches/);
});
