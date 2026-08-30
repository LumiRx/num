/**
 * qrcheck — does every code we have printed still point where it should?
 *
 * A QR is glued to a table and then nobody looks at it again. If a code's row
 * drifts — a table that was deleted, a sticker whose payment target went
 * missing, a bill with no amount, a code belonging to one venue attached to
 * another's table — nothing complains. The sticker keeps scanning and the
 * money keeps not arriving, and the first person to notice is a venue asking
 * where their booking went.
 *
 * So this walks the whole chain and returns what is wrong:
 *
 *     business → table → sticker → bill → booking → ledger line
 *
 * Findings only. It never repairs anything: a checker that quietly rewrites
 * rows is a checker whose findings nobody can trust, and half of what it
 * would "fix" needs a human who knows what the venue actually agreed.
 */

const SEVERITY = ['critical', 'warn', 'info'];

const finding = (severity, kind, ref, detail) => ({ severity, kind, ref, detail });

/**
 * @returns {Promise<{ok: boolean, checked: object, findings: object[]}>}
 *   `ok` is true only when nothing critical was found.
 */
export async function checkQrs(env, { businessId = null } = {}) {
  const findings = [];
  const scope = businessId ? ' AND p.business_id = ?1' : '';
  const bind = businessId ? [businessId] : [];

  /* ── every paylink ─────────────────────────────────────────────────────── */
  const { results: links } = await env.DB.prepare(
    `SELECT p.token, p.business_id, p.label, p.kind, p.target, p.promptpay_kind,
            p.crypto_asset, p.crypto_base_units, p.amount_mode, p.amount, p.currency,
            p.state, p.one_time, p.resource_id, p.booking_id, p.settled_at, p.created_at,
            b.id AS biz_exists, b.status AS biz_status,
            r.id AS res_exists, r.business_id AS res_owner, r.active AS res_active
       FROM num_paylinks p
       LEFT JOIN businesses b ON b.id = p.business_id
       LEFT JOIN num_resources r ON r.id = p.resource_id
      WHERE 1=1${scope}`,
  ).bind(...bind).all().catch(() => ({ results: [] }));

  for (const l of links ?? []) {
    // A code whose venue no longer exists still scans and still shows a
    // payment target. Nobody is watching that money.
    if (!l.biz_exists) {
      findings.push(finding('critical', 'orphan_code', l.token,
        `points at business ${l.business_id}, which no longer exists`));
    }

    if (!l.target) {
      findings.push(finding('critical', 'no_target', l.token,
        'a payment code with no destination — it can be scanned and pays nobody'));
    }

    // The one rule the whole design rests on.
    if (l.resource_id && l.res_exists && l.res_owner !== l.business_id) {
      findings.push(finding('critical', 'cross_venue', l.token,
        `code belongs to ${l.business_id} but its table belongs to ${l.res_owner}`));
    }
    if (l.resource_id && !l.res_exists) {
      findings.push(finding('warn', 'missing_table', l.token,
        `attached to table ${l.resource_id}, which has been deleted`));
    }

    if (l.one_time) {
      if (l.amount_mode !== 'fixed') {
        findings.push(finding('critical', 'bill_without_amount', l.token,
          'a one-time bill code with an open amount can never report what was paid'));
      }
      if (!l.amount) {
        findings.push(finding('critical', 'bill_no_amount', l.token, 'bill code has no amount'));
      }
    } else if (l.amount_mode === 'fixed' && l.state === 'active') {
      findings.push(finding('warn', 'reusable_fixed', l.token,
        'a permanent code with a fixed amount — every guest at that table pays the same figure'));
    }

    if (l.kind === 'promptpay' && !l.promptpay_kind) {
      findings.push(finding('warn', 'promptpay_untyped', l.token,
        'no promptpay_kind recorded — the EMV payload may be built with the wrong proxy type'));
    }
    if (l.kind === 'crypto') {
      if (!l.crypto_asset) {
        findings.push(finding('critical', 'crypto_no_asset', l.token,
          'a crypto code with no asset — we cannot say which token or chain to pay on'));
      }
      if (l.one_time && !l.crypto_base_units) {
        findings.push(finding('critical', 'crypto_no_quote', l.token,
          'a crypto bill with no quoted amount — the guest has no figure to send'));
      }
    }

    // Settled means money moved. A revoked-and-settled row is fine (it was
    // paid, then retired) but an unsettled bill sitting active forever is the
    // agent failing to expire it.
    if (l.one_time && l.state === 'active' && !l.settled_at) {
      const ageH = (Date.now() - Date.parse(l.created_at || 0)) / 3600_000;
      if (Number.isFinite(ageH) && ageH > 24) {
        findings.push(finding('warn', 'stale_bill', l.token,
          `open and unpaid for ${Math.round(ageH)}h — the agent should have expired it at 90 minutes`));
      }
    }
  }

  /* ── every check-in code ───────────────────────────────────────────────── */
  const { results: codes } = await env.DB.prepare(
    `SELECT c.token, c.business_id, c.resource_id, c.state,
            b.id AS biz_exists, r.id AS res_exists, r.business_id AS res_owner
       FROM num_venue_codes c
       LEFT JOIN businesses b ON b.id = c.business_id
       LEFT JOIN num_resources r ON r.id = c.resource_id
      WHERE 1=1${businessId ? ' AND c.business_id = ?1' : ''}`,
  ).bind(...bind).all().catch(() => ({ results: [] }));

  for (const c of codes ?? []) {
    if (!c.biz_exists) {
      findings.push(finding('critical', 'orphan_checkin', c.token,
        `points at business ${c.business_id}, which no longer exists`));
    }
    if (c.resource_id && c.res_exists && c.res_owner !== c.business_id) {
      findings.push(finding('critical', 'cross_venue_checkin', c.token,
        `check-in code belongs to ${c.business_id} but its table belongs to ${c.res_owner}`));
    }
  }

  /* ── every active table ────────────────────────────────────────────────── */
  const { results: tables } = await env.DB.prepare(
    `SELECT r.id, r.business_id, r.name, r.active,
            (SELECT COUNT(*) FROM num_paylinks p
              WHERE p.resource_id = r.id AND p.state='active' AND COALESCE(p.one_time,0)=0) AS stickers,
            (SELECT COUNT(*) FROM num_venue_codes c
              WHERE c.resource_id = r.id AND c.state='active') AS checkins
       FROM num_resources r
      WHERE r.active = 1${businessId ? ' AND r.business_id = ?1' : ''}`,
  ).bind(...bind).all().catch(() => ({ results: [] }));

  for (const t of tables ?? []) {
    if (t.stickers === 0) {
      findings.push(finding('info', 'table_unprinted', t.id,
        `${t.name} has no pay sticker — usually means the venue has no payment identity yet`));
    }
    // Two live stickers on one table means two different QRs, printed at
    // different times, both scanning. Only one of them is on the table.
    if (t.stickers > 1) {
      findings.push(finding('warn', 'duplicate_sticker', t.id,
        `${t.name} has ${t.stickers} live pay stickers — a guest may scan a code the venue thinks is retired`));
    }
    if (t.checkins > 1) {
      findings.push(finding('warn', 'duplicate_checkin', t.id, `${t.name} has ${t.checkins} live check-in codes`));
    }
  }

  /* ── settled bills against the ledger ──────────────────────────────────── */
  const { results: settled } = await env.DB.prepare(
    `SELECT p.token, p.booking_id, p.amount, p.business_id
       FROM num_paylinks p
      WHERE COALESCE(p.one_time,0)=1 AND p.settled_at IS NOT NULL
        AND p.booking_id IS NOT NULL${scope}`,
  ).bind(...bind).all().catch(() => ({ results: [] }));

  for (const s of settled ?? []) {
    const line = await env.DB.prepare(
      'SELECT id, state, amount_cs FROM num_commissions WHERE booking_id = ?1',
    ).bind(s.booking_id).first().catch(() => null);
    if (!line) {
      findings.push(finding('critical', 'paid_but_unbilled', s.token,
        `settled against booking ${s.booking_id} but there is no ledger line — that fee is lost`));
    } else if (line.state === 'awaiting_value') {
      findings.push(finding('warn', 'ledger_awaiting', s.token,
        `settled but its ledger line is still awaiting a value — the agent should reconcile it`));
    }
  }

  const counts = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    ok: counts.critical === 0,
    checked: {
      paylinks: links?.length ?? 0,
      checkin_codes: codes?.length ?? 0,
      active_tables: tables?.length ?? 0,
      settled_bills: settled?.length ?? 0,
    },
    counts,
    findings: findings.sort(
      (a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity),
    ),
  };
}
