/**
 * The console's DELIVERY page — the partner side of worker/delivery.mjs.
 *
 * ── WHAT A DELIVERY BUSINESS SEES (4 Sep 2026) ────────────────────────────
 *
 * Two things, one screen:
 *
 *   1. Settings: the switch, the licence number the switch depends on, the
 *      radius, the fee, the age gate and the hours. Saved through
 *      delivery.mjs saveDelivery, which refuses to switch delivery on without
 *      a licence — a rule the page repeats in words so nobody has to discover
 *      it by failing.
 *   2. Orders: every order a guest's Num created, newest first, with the ONE
 *      button that is legal from its current status (delivery.mjs ORDER_NEXT).
 *      Accept → preparing → on its way → delivered. Decline with a reason. The
 *      guest is told at every step by delivery.mjs decideOrder, not by this
 *      page — this page only moves the state.
 *
 * The products themselves live on "What you offer" (bizoffer.mjs). Delivery
 * sells exactly what is listed and priced there; an unpriced item cannot be
 * ordered. The page says so and links across rather than duplicating a menu.
 *
 * Why the page never mentions SMS: some delivery partners sell goods US
 * carriers refuse to carry over text (cannabis, even where licensed). The whole
 * loop is in-app push for that reason — see the header of delivery.mjs.
 */

const H = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (cs) => `$${(Number(cs ?? 0) / 100).toFixed(2)}`;

const NEXT_LABEL = Object.freeze({
  accepted: 'Accept',
  preparing: 'Preparing',
  out_for_delivery: 'On its way',
  delivered: 'Delivered',
  declined: 'Decline',
  cancelled: 'Cancel',
});

const STATUS_WORD = Object.freeze({
  pending_business: 'Waiting for you',
  accepted: 'Accepted',
  preparing: 'Preparing',
  out_for_delivery: 'On its way',
  delivered: 'Delivered',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
});

/** The forward moves the partner may make from a status, in the order shown. */
export function buttonsFor(status, next) {
  const allowed = next?.[status] ?? [];
  const order = ['accepted', 'preparing', 'out_for_delivery', 'delivered', 'declined', 'cancelled'];
  return order.filter((s) => allowed.includes(s));
}

function orderRow(o, token, next) {
  const when = o.created_at ? new Date(Number(o.created_at) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
  const buttons = buttonsFor(o.status, next).map((s) => `
    <form method="post" style="display:inline;margin:0 4px 0 0">
      <input type="hidden" name="action" value="order_move">
      <input type="hidden" name="s" value="${H(token)}">
      <input type="hidden" name="p" value="delivery">
      <input type="hidden" name="order" value="${H(o.id)}">
      <input type="hidden" name="to" value="${s}">
      ${s === 'declined' ? '<input name="reason" placeholder="Why (the guest sees this)" style="width:190px;display:inline;margin:0 4px 0 0">' : ''}
      <button type="submit" class="${s === 'declined' || s === 'cancelled' ? 'ghost' : ''}" style="width:auto;padding:5px 10px;font-size:12.5px;margin:0">${NEXT_LABEL[s]}</button>
    </form>`).join('');
  return `<tr>
    <td><b>${H(o.short_code)}</b><br><span class="sub">${H(when)} UTC</span></td>
    <td>${H(o.items ?? '')}<br><span class="sub">${H(o.address ?? '')}</span></td>
    <td>${money(o.total_cs)}<br><span class="sub">incl. ${money(o.delivery_fee_cs)} delivery</span></td>
    <td>${H(STATUS_WORD[o.status] ?? o.status)}</td>
    <td>${buttons || ''}</td>
  </tr>`;
}

/**
 * @param settings  deliverySettings() result (or null when unclaimed)
 * @param orders    ordersFor() rows
 * @param priced    how many active, priced items "What you offer" holds
 */
export function deliveryPage({ settings, orders = [], priced = 0, next, token, saved = '', err = '' }) {
  const s = settings ?? { on: false, fee_cs: 500, radius_m: 5000, licence: '', age_min: 0, hours: '' };
  const open = orders.filter((o) => o.status === 'pending_business').length;

  const status = s.on
    ? `<div class="note ok">Delivery is <b>on</b>. A traveller within ${(s.radius_m / 1000).toFixed(1)} km who asks their Num for what you sell is offered your ${priced} priced item${priced === 1 ? '' : 's'}, at your prices, plus ${money(s.fee_cs)} delivery.${s.age_min ? ` ${s.age_min}+ only: their Num offers you only to guests whose identity Num has verified, and you check ID at the door.` : ''}</div>`
    : `<div class="note">Delivery is <b>off</b>. Fill in the licence below and switch it on. ${priced ? '' : 'You also need at least one item with a price on <a href="/api/biz/console?s=' + H(token) + '&p=offerings">What you offer</a> — an unpriced item cannot be ordered.'}</div>`;

  const ordersTable = orders.length
    ? `<table><tr><th>Order</th><th>What &amp; where</th><th>Total</th><th>Status</th><th></th></tr>${orders.map((o) => orderRow(o, token, next)).join('')}</table>`
    : `<div class="card soon"><h3>No orders yet</h3><p class="sub" style="margin:0">When a traveller's Num places one it appears here and your notification email gets a copy. Accept it and the guest is told; every step after that tells them too.</p></div>`;

  return `<h2>Delivery${open ? ` <span class="sub">(${open} waiting)</span>` : ''}</h2>
    ${err ? `<div class="err">${H(err)}</div>` : ''}
    ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}
    ${status}
    <h2>Orders</h2>
    ${ordersTable}
    <h2>Settings</h2>
    <form method="post" class="card">
      <input type="hidden" name="action" value="delivery_save">
      <input type="hidden" name="s" value="${H(token)}">
      <input type="hidden" name="p" value="delivery">
      <label><input type="checkbox" name="on" value="1"${s.on ? ' checked' : ''}> Take delivery orders through NUM</label>
      <label for="d_lic">Licence number <span class="sub">(required before delivery can be on — shown to guests who ask)</span></label>
      <input id="d_lic" name="licence" value="${H(s.licence)}" placeholder="Your state or city retail / delivery licence">
      <div class="row">
        <div>
          <label for="d_fee">Delivery fee (USD)</label>
          <input id="d_fee" name="fee" inputmode="decimal" value="${(s.fee_cs / 100).toFixed(2)}">
        </div>
        <div>
          <label for="d_radius">How far you deliver (km)</label>
          <input id="d_radius" name="radius_km" inputmode="decimal" value="${(s.radius_m / 1000).toFixed(1)}">
        </div>
      </div>
      <div class="row">
        <div>
          <label for="d_age">Minimum age</label>
          <select id="d_age" name="age_min">
            <option value="0"${!s.age_min ? ' selected' : ''}>No age limit</option>
            <option value="18"${s.age_min === 18 ? ' selected' : ''}>18+</option>
            <option value="21"${s.age_min === 21 ? ' selected' : ''}>21+ (ID checked at the door)</option>
          </select>
        </div>
        <div>
          <label for="d_hours">Delivery hours</label>
          <input id="d_hours" name="hours" value="${H(s.hours)}" placeholder="Daily 10:00–21:00">
        </div>
      </div>
      <button type="submit">Save delivery settings</button>
      <p class="sub" style="margin:10px 0 0">What you deliver is your <a href="/api/biz/console?s=${H(token)}&p=offerings">What you offer</a> list — only items with a price can be ordered. NUM takes its usual commission on the goods, never on your delivery fee, and only once you mark an order delivered.</p>
    </form>`;
}
