// Pre-flight: everything that must be true before money leaves.
//
// This exists because of what a real audit of the live table turned up. The
// plan we were handed said "best first payout: mem_pmajqk, $100" and never
// mentioned that one member's saved wallet is the USDC token contract itself —
// paying it would burn the money with no way back. A human reading a list of
// hex strings will not catch that. A list of rules will, every time.
//
// Severity is the whole point:
//   block — never pay this. The system refuses; no override in the UI.
//   hold  — a person must look at it and say yes.
//   note  — worth knowing, does not stop anything.

/** Addresses that must never receive a payout on Base. */
export const NEVER_PAY = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'the USDC token contract on Base — anything sent here is burned',
  '0x4200000000000000000000000000000000000006': 'the WETH contract on Base',
  '0x4200000000000000000000000000000000000010': 'the Base bridge contract',
  '0x0000000000000000000000000000000000000000': 'the zero address — anything sent here is burned',
  '0x000000000000000000000000000000000000dead': 'a burn address',
  '0xffffffffffffffffffffffffffffffffffffffff': 'not a real account',
};

/** Countries we hold no rail for, so a balance there cannot be routed at all. */
export const UNROUTABLE_COUNTRY = new Set(['other', 'OTHER', '']);

const addrOf = (externalId) => String(externalId ?? '').split(':').pop().toLowerCase();
const isHexAddress = (a) => /^0x[0-9a-f]{40}$/.test(a);

/**
 * Check one member's payout readiness.
 *
 * `context` carries the things that can only be known across the whole set —
 * chiefly which wallet addresses are shared by more than one account, which is
 * the classic way one person collects twice.
 */
export function checkMember({ member, finance, method, rails = [], context = {} }) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message });

  // ── identity ────────────────────────────────────────────────────────────
  if (!member) {
    add('block', 'no_member', 'No member record.');
    return findings;
  }
  if (member.frozen_at) add('block', 'frozen', `Account frozen: ${member.frozen_reason || 'no reason recorded'}.`);
  if (!member.verified_at) add('block', 'unverified', 'Identity was never verified — verification is the gate for any payout.');
  if (!member.msa_signed_at) add('hold', 'no_msa', 'No signed agreement on file.');

  // ── balance ─────────────────────────────────────────────────────────────
  const stars = finance?.stars_earned ?? 0;
  if (stars <= 0) add('block', 'no_balance', 'No Stars to pay out.');

  // ── destination ─────────────────────────────────────────────────────────
  if (!method) {
    add('block', 'no_method', 'No payout destination on file — nothing to send to.');
  } else {
    if (method.status !== 'enabled') add('block', 'method_disabled', `Payout method is "${method.status}", not enabled.`);

    if (method.rail === 'usdc_base') {
      const addr = addrOf(method.external_id);
      if (!isHexAddress(addr)) {
        add('block', 'bad_address', `"${addr}" is not a valid address — a payout would be lost.`);
      } else if (NEVER_PAY[addr]) {
        add('block', 'burn_address', `That wallet is ${NEVER_PAY[addr]}. Do not pay it; ask the member for a wallet they control.`);
      }
      const sharers = (context.duplicateWallets?.[addr] ?? []).filter((id) => id !== member.id);
      if (sharers.length) {
        add('hold', 'shared_wallet', `This wallet is also on ${sharers.join(', ')}. Two accounts, one wallet is the pattern uniqueness checks exist to catch.`);
      }
    }

    if (method.country && member.country && method.country !== member.country) {
      add('hold', 'country_mismatch', `The account says ${member.country} but the payout method says ${method.country}.`);
    }
  }

  // ── routing ─────────────────────────────────────────────────────────────
  const country = member.country;
  if (!country) {
    add('hold', 'no_country', 'No country on the account, so no bank rail can be chosen. A crypto rail still works.');
  } else if (UNROUTABLE_COUNTRY.has(country)) {
    add('hold', 'country_placeholder', `Country is "${country}", which is a placeholder rather than a country.`);
  } else if (!rails.length) {
    add('note', 'no_bank_rail', `No bank rail is configured for ${country}. Crypto is the only route.`);
  }

  // ── debts ───────────────────────────────────────────────────────────────
  if (context.openDebtCents) {
    add('note', 'open_debt', `Member has ${(context.openDebtCents / 100).toFixed(2)} of recorded debt.`);
  }

  return findings;
}

export const worstSeverity = (findings) =>
  findings.some((f) => f.severity === 'block') ? 'block' : findings.some((f) => f.severity === 'hold') ? 'hold' : findings.length ? 'note' : 'clear';

/** Build the cross-member context a single check cannot work out on its own. */
export function buildContext(methods) {
  const byAddress = {};
  for (const m of methods) {
    if (m.rail !== 'usdc_base') continue;
    const a = addrOf(m.external_id);
    (byAddress[a] ??= []).push(m.member_id);
  }
  const duplicateWallets = Object.fromEntries(Object.entries(byAddress).filter(([, ids]) => ids.length > 1));
  return { duplicateWallets };
}
