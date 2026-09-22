// The eSIM pages: the listing, a page per country, a page per airport, and
// the order page where the eSIM is installed.
//
// Server-rendered HTML, no framework, no client script required: a traveller
// on airport wifi with a half-loaded page must still be able to pick, pay and
// install. The one script on the order page only adds copy buttons.
//
// House rules honoured here:
//   - no price, rate or currency figure in any head metadata (head-price-lint)
//   - no claim we cannot check (esimcopy.mjs BANNED)
//   - absolute stylesheet URLs: these pages are served on app.itsnum.com,
//     where public/ does not exist (see scoutpage.mjs)

import { page as P, textNumberDisplay } from './esimcopy.mjs';
import { planLabel } from './esimcatalogue.mjs';
import { usd } from './esimprice.mjs';
import { countryName, airportsIn } from './esimplaces.mjs';
import { appleInstallUrl, manualCodes } from './esimlpa.mjs';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function smsHref(env, body = 'ESIM') {
  const n = String(env?.ESIM_TEXT_NUMBER || env?.TWILIO_FROM || '').trim();
  return /^\+\d{8,15}$/.test(n) ? `sms:${n}?&body=${encodeURIComponent(body)}` : null;
}

const STYLE = `<style>
:root{--pri:#0EA483;--pri-d:#0B7C63;--pri-l:#E7F6F1;--ink:#0A1A24;--slate:#586A74;
  --line:#E7ECEE;--bg:#F6FAF9;--card:#fff;--amber:#EFA43A;--amber-l:#FDF3E1;
  --disp:'Space Grotesk','Plus Jakarta Sans',sans-serif;
  --body:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);line-height:1.6;font-size:16px;
  -webkit-font-smoothing:antialiased;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
a{color:inherit}
h1,h2,h3{font-family:var(--disp);margin:0;letter-spacing:-.02em;font-weight:600;line-height:1.12}
.e-wrap{max-width:680px;margin:0 auto;padding:26px 20px 56px}
.e-brand{display:flex;align-items:center;gap:9px;font-family:var(--disp);font-weight:700;font-size:17px;
  letter-spacing:-.01em;margin-bottom:28px;text-decoration:none}
.e-dot{width:11px;height:11px;border-radius:50%;background:var(--pri)}
.e-brand small{font-weight:500;font-size:12px;color:var(--slate);font-family:var(--body);letter-spacing:0}
.e-tag{display:inline-block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:800;
  color:var(--pri-d);background:var(--pri-l);padding:4px 10px;border-radius:999px;margin-bottom:12px}
h1{font-size:34px;margin-bottom:10px}
h2{font-size:21px;margin:30px 0 12px}
.e-lede{color:var(--slate);font-size:16.5px;margin:0 0 22px}
.e-text{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;background:var(--ink);
  color:#fff;border-radius:16px;padding:16px 18px;margin:0 0 26px}
.e-text p{margin:0;font-size:15px}.e-text b{font-family:var(--disp);font-size:18px;letter-spacing:.01em}
.e-btn{display:inline-block;background:var(--pri);color:#fff;font-weight:700;border:0;border-radius:12px;
  padding:13px 18px;font-size:16px;text-decoration:none;cursor:pointer;font-family:var(--body)}
.e-btn.big{display:block;width:100%;text-align:center;font-size:17px;padding:16px}
.e-btn.light{background:#fff;color:var(--ink)}
.e-btn:focus-visible,.e-plan:focus-within{outline:3px solid var(--pri);outline-offset:2px}
.e-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:12px;
  box-shadow:0 1px 2px rgba(10,26,36,.04),0 10px 30px rgba(10,26,36,.05)}
.e-plans{display:grid;gap:10px;margin:0 0 16px;padding:0;border:0}
.e-plan{display:flex;align-items:center;gap:12px;background:#fff;border:1.5px solid var(--line);border-radius:14px;
  padding:14px 16px;cursor:pointer}
.e-plan:has(input:checked){border-color:var(--pri);background:var(--pri-l)}
.e-plan input{width:20px;height:20px;accent-color:var(--pri);flex:0 0 auto}
.e-plan .e-what{flex:1}.e-plan .e-what b{display:block;font-family:var(--disp);font-size:17px}
.e-plan .e-what span{color:var(--slate);font-size:13px}
.e-plan .e-price{font-family:var(--disp);font-weight:700;font-size:19px}
.e-field{display:block;margin:14px 0 6px;font-weight:600;font-size:14px}
.e-input{width:100%;font-size:16px;padding:12px 14px;border:1.5px solid var(--line);border-radius:12px;font-family:var(--body)}
.e-check{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--slate);margin:10px 0}
.e-check input{margin-top:3px;width:18px;height:18px;accent-color:var(--pri);flex:0 0 auto}
.e-small{font-size:13px;color:var(--slate)}
.e-steps{margin:0;padding-left:20px}.e-steps li{margin:6px 0}
.e-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.e-chips a{display:inline-block;background:#fff;border:1px solid var(--line);border-radius:999px;padding:7px 13px;
  font-size:14px;text-decoration:none}
.e-list{columns:2;column-gap:24px;padding:0;margin:0;list-style:none}
.e-list li{break-inside:avoid;padding:5px 0;font-size:15px}.e-list a{text-decoration:none}
.e-list span{color:var(--slate);font-size:13px}
.e-note{margin-top:22px;padding:15px 17px;border:1px solid var(--line);border-radius:14px;background:#fff;color:var(--slate);font-size:13.5px}
.e-code{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--line);
  border-radius:12px;padding:10px 12px;margin:8px 0;font-family:ui-monospace,Menlo,monospace;font-size:14px;word-break:break-all}
.e-code button{flex:0 0 auto;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer}
.e-qr{display:block;width:220px;height:220px;margin:8px auto;background:#fff;border-radius:12px;border:1px solid var(--line)}
.e-status{font-size:15px;background:var(--amber-l);border-radius:12px;padding:12px 14px;margin:0 0 16px}
.e-foot{margin-top:30px;font-size:12.5px;color:var(--slate);text-align:center}
@media(max-width:480px){.e-wrap{padding:20px 16px 44px}h1{font-size:28px}.e-list{columns:1}}
</style>`;

function head({ title, desc, canonical, noindex, refresh }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${noindex ? 'noindex,nofollow' : 'index,follow'}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">` : ''}
<meta name="referrer" content="no-referrer">
<link rel="icon" href="https://itsnum.com/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://itsnum.com/assets/site.css">
${STYLE}
</head>
<body>
<main class="e-wrap">
<a class="e-brand" href="/esim"><span class="e-dot"></span>NUM <small>eSIM + your travel concierge</small></a>`;
}

function foot() {
  return `<p class="e-foot">${esc(P.dataOnly)} ${esc(P.refundLine)}<br><a href="https://itsnum.com/privacy/">Privacy</a> &middot; <a href="https://itsnum.com/terms/">Terms</a> &middot; <a href="/esim">All eSIMs</a></p>
</main>
</body>
</html>`;
}

function textBanner(env, body, label) {
  const href = smsHref(env, body);
  if (!href) return '';
  return `<div class="e-text"><p>Or just text <b>${esc(body)}</b> to <b>${esc(textNumberDisplay(env))}</b>${label ? `<br><span class="e-small" style="color:#cfe">${esc(label)}</span>` : ''}</p><a class="e-btn" href="${esc(href)}">Text ${esc(body)}</a></div>`;
}

/** "Bangkok (BKK)", or the airport's own name when the city field is messy. */
const place = (a) => `${a[2] && !/[()/]/.test(a[2]) ? a[2] : a[1]} (${a[0]})`;

const POPULAR = ['TH', 'JP', 'US', 'GB', 'AE', 'FR', 'IT', 'ES', 'ID', 'VN', 'SG', 'KR', 'MX', 'TR', 'PT', 'GR'];

export function renderHome({ env, countries = [], origin = '' }) {
  const have = new Map(countries.map((c) => [c.country, c]));
  const popular = POPULAR.filter((c) => have.has(c));
  const all = [...countries].map((c) => ({ ...c, name: countryName(c.country) || c.country })).sort((a, b) => a.name.localeCompare(b.name));
  const sms = smsHref(env, 'ESIM');
  return `${head({ title: 'Travel eSIM with your own concierge | Num', desc: 'Text ESIM and get a data eSIM for your trip in a minute, with a Num concierge who knows the place.', canonical: `${origin}/esim` })}
<span class="e-tag">eSIM</span>
<h1>${esc(P.headline)}</h1>
<p class="e-lede">${esc(P.pitch(env))}</p>
${sms ? `<p><a class="e-btn big" href="${esc(sms)}">Text ESIM now</a></p>` : ''}
<form class="e-card" action="/esim/find" method="get" role="search">
  <label class="e-field" for="q">Where are you going?</label>
  <input class="e-input" id="q" name="q" placeholder="Country, city or airport code, e.g. Thailand or BKK" autocomplete="off" required>
  <p style="margin:12px 0 0"><button class="e-btn" type="submit">Show plans</button></p>
</form>
<h2>How it works</h2>
<ol class="e-steps">${P.how.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
${popular.length ? `<h2>Popular</h2><ul class="e-chips">${popular.map((c) => `<li><a href="/esim/${c.toLowerCase()}">${esc(countryName(c))}</a></li>`).join('')}</ul>` : ''}
${all.length ? `<h2>Every destination</h2><ul class="e-list">${all.map((c) => `<li><a href="/esim/${c.country.toLowerCase()}">${esc(c.name)}</a> <span>from ${usd(c.from_cs)}</span></li>`).join('')}</ul>` : `<p class="e-note">eSIMs are being set up right now. Text ESIM and we will tell you the moment they are ready.</p>`}
<p class="e-note">${esc(P.compatible)}</p>
${foot()}`;
}

function planOptions(plans) {
  return plans
    .map((p, i) => {
      const scope = p.scope === 'local' ? '' : p.scope === 'regional' ? `Works in ${p.countries.length} countries` : 'Works worldwide';
      const nets = (p.networks || []).slice(0, 3).join(', ');
      const sub = [scope, nets].filter(Boolean).join(' · ');
      return `<label class="e-plan"><input type="radio" name="plan" value="${esc(`${p.provider}:${p.code}`)}"${i === 0 ? ' checked' : ''} required><span class="e-what"><b>${esc(planLabel(p))}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span><span class="e-price">${usd(p.priceCs)}</span></label>`;
    })
    .join('');
}

function buyForm({ plans, dest }) {
  return `<form class="e-card" action="/api/esim/quote" method="post">
<fieldset class="e-plans"><legend class="e-field" style="margin-top:0">Pick your data</legend>${planOptions(plans)}</fieldset>
<input type="hidden" name="country" value="${esc(dest.country || '')}">
<input type="hidden" name="airport" value="${esc(dest.airport || '')}">
<input type="hidden" name="region" value="${esc(dest.region || '')}">
<label class="e-field" for="phone">Mobile number (optional)</label>
<input class="e-input" id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+1 555 123 4567">
<label class="e-check"><input type="checkbox" name="sms_ok" value="1"><span>${esc(P.smsConsent)}</span></label>
<label class="e-check"><input type="checkbox" name="marketing_ok" value="1"><span>${esc(P.marketingConsent)}</span></label>
<p style="margin:14px 0 6px"><button class="e-btn big" type="submit">Continue to payment</button></p>
<p class="e-small" style="margin:0">You pay on Stripe's secure page. Apple Pay and Google Pay work there. Your install link appears the moment you pay, and we email it to you too.</p>
</form>`;
}

export function renderCountry({ env, code, plans, origin = '' }) {
  const name = countryName(code) || code;
  const airports = airportsIn(code);
  return `${head({ title: `${name} eSIM | Num`, desc: `A data-only eSIM for ${name}: pay in seconds, install with one tap on iPhone, switch it on when you land. Your Num concierge comes with it.`, canonical: `${origin}/esim/${code.toLowerCase()}`, noindex: !plans.length })}
<span class="e-tag">${esc(name)}</span>
<h1>${esc(name)} eSIM</h1>
<p class="e-lede">Data for your trip to ${esc(name)}, ready before you land. Install it at home on wifi, switch it on when you arrive.</p>
${textBanner(env, `ESIM ${/^[A-Za-z ]+$/.test(name) ? name.toUpperCase() : code}`, 'Your own Num concierge comes with it.')}
${plans.length ? buyForm({ plans, dest: { country: code } }) : `<p class="e-note">No plan for ${esc(name)} yet. Text us and we will find another way to get you online there.</p>`}
${airports.length ? `<h2>Airports in ${esc(name)}</h2><ul class="e-chips">${airports.slice(0, 40).map((a) => `<li><a href="/esim/airport/${a[0].toLowerCase()}">${esc(place(a))}</a></li>`).join('')}</ul>` : ''}
<p class="e-note">${esc(P.compatible)}</p>
${foot()}`;
}

export function renderRegion({ env, region, label, plans, origin = '' }) {
  return `${head({ title: `${label} eSIM | Num`, desc: `One data eSIM for several countries in ${label}. Your Num concierge comes with it.`, canonical: `${origin}/esim/region/${String(region).toLowerCase()}` })}
<span class="e-tag">${esc(label)}</span>
<h1>${esc(label)} eSIM</h1>
<p class="e-lede">One eSIM that works across several countries. Each plan says how many it covers.</p>
${textBanner(env, `ESIM ${String(label).toUpperCase().replace(/^THE /, '')}`, 'Your own Num concierge comes with it.')}
${plans.length ? buyForm({ plans, dest: { region } }) : '<p class="e-note">No multi-country plan here yet. Text us where you are going and we will find the right one.</p>'}
<p class="e-note">${esc(P.compatible)}</p>
${foot()}`;
}

export function renderAirport({ env, airport, plans, origin = '' }) {
  const [iata, aname, city, code, size] = airport;
  const name = countryName(code) || code;
  const others = airportsIn(code).filter((a) => a[0] !== iata).slice(0, 24);
  return `${head({
    title: `eSIM for ${aname} (${iata}) | Num`,
    desc: `Landing at ${aname}? Get a ${name} data eSIM before you fly and switch it on when you land. Your Num concierge comes with it.`,
    canonical: `${origin}/esim/airport/${iata.toLowerCase()}`,
    // Only the big airports go in the search index. Four thousand near-identical
    // pages is what search engines call doorway pages; the rest stay live for
    // links, texts and printed QR codes.
    noindex: size !== 'L' || !plans.length,
  })}
<span class="e-tag">${esc(iata)} · ${esc(name)}</span>
<h1>Landing at ${esc(aname)}?</h1>
<p class="e-lede">${city ? `${esc(city)}, ${esc(name)}. ` : ''}Get your ${esc(name)} eSIM now, install it on wifi before you fly, and switch it on as you walk off the plane.</p>
${textBanner(env, `ESIM ${iata}`, 'Your own Num concierge comes with it.')}
${plans.length ? buyForm({ plans, dest: { country: code, airport: iata } }) : `<p class="e-note">No plan for ${esc(name)} yet. Text ESIM ${esc(iata)} and we will find another way to get you online there.</p>`}
<h2>When you land</h2>
<ol class="e-steps"><li>Turn the eSIM line on and choose it for mobile data.</li><li>Switch Data Roaming on for that line (it is how travel eSIMs connect; your home SIM can stay off).</li><li>${String(env?.SMS_CONCIERGE ?? '').trim() === 'on' ? `Text Num if anything is not working, or ask it anything about ${esc(city || name)}.` : `Ask Num anything about ${esc(city || name)} in the app at app.itsnum.com.`}</li></ol>
<p><a href="/esim/${code.toLowerCase()}">All ${esc(name)} plans</a></p>
${others.length ? `<h2>Other airports in ${esc(name)}</h2><ul class="e-chips">${others.map((a) => `<li><a href="/esim/airport/${a[0].toLowerCase()}">${esc(place(a))}</a></li>`).join('')}</ul>` : ''}
<p class="e-note">${esc(P.compatible)}</p>
${foot()}`;
}

const COPY_SCRIPT = `<script>
document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;
var t=b.getAttribute('data-copy');(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1600)}).catch(function(){});});
</script>`;

export function renderOrder({ env, order, concierge = { sms: false } }) {
  const t = order;
  const common = { title: 'Your eSIM | Num', desc: 'Your Num eSIM order.', noindex: true };
  if (t.state === 'quoted' || t.state === 'checkout') {
    return `${head(common)}
<h1>Almost there</h1>
<p class="e-lede">${esc(t.dest_label)} eSIM, ${esc(t.plan_label)}, ${usd(t.price_cs)}.</p>
<p><a class="e-btn big" href="/esim/pay/${esc(t.token)}">Pay ${usd(t.price_cs)}</a></p>
<p class="e-small">You pay on Stripe's secure page. Apple Pay and Google Pay work there.</p>
${foot()}`;
  }
  if (t.state === 'paid' || t.state === 'ordering') {
    return `${head({ ...common, refresh: 4 })}
<h1>Payment received</h1>
<p class="e-status">Getting your ${esc(t.dest_label)} eSIM ready. This usually takes under a minute, and this page updates by itself.</p>
<p class="e-small">We will also send the install link${t.email ? ' by email' : ''}${t.phone && (t.sms_ok || t.channel !== 'web') ? ' and by text' : ''}, so you can close this page.</p>
${foot()}`;
  }
  if (t.state === 'refunding') {
    return `${head({ ...common, refresh: 10 })}
<h1>Your refund is on its way</h1>
<p class="e-lede">We are refunding the full ${usd(t.paid_cs ?? t.price_cs)} for your ${esc(t.dest_label)} eSIM. It can take 5 to 10 days to show on your statement.</p>
${foot()}`;
  }
  if (t.state === 'refunded') {
    return `${head(common)}
<h1>We refunded you</h1>
<p class="e-lede">We couldn't issue your ${esc(t.dest_label)} eSIM, so we refunded the full ${usd(t.paid_cs ?? t.price_cs)}. It can take 5 to 10 days to show on your statement.</p>
<p><a class="e-btn" href="/esim${t.country ? `/${esc(t.country.toLowerCase())}` : ''}">See other plans</a></p>
${foot()}`;
  }
  if (t.state === 'attention') {
    return `${head(common)}
<h1>We're on it</h1>
<p class="e-lede">Your payment went through and your eSIM needs a person to finish it. We have been alerted and will send it${t.email ? ' by email' : ''}${t.phone ? ' or text' : ''} shortly, or refund you in full.</p>
${foot()}`;
  }
  if (t.state === 'expired') {
    return `${head(common)}
<h1>This link has expired</h1>
<p class="e-lede">Nothing was charged. Pick a plan again whenever you are ready.</p>
<p><a class="e-btn" href="/esim${t.country ? `/${esc(t.country.toLowerCase())}` : ''}">See plans</a></p>
${foot()}`;
  }
  // ready
  const apple = appleInstallUrl(t.lpa);
  const codes = manualCodes(t.lpa);
  const smsLine = concierge.sms && smsHref(env, 'Hi Num') ? ` Or text <a href="${esc(smsHref(env, 'Hi Num'))}">${esc(textNumberDisplay(env))}</a>.` : '';
  return `${head(common)}
<span class="e-tag">Ready</span>
<h1>Your ${esc(t.dest_label)} eSIM is ready</h1>
<p class="e-lede">${esc(t.plan_label)}. Install it now, on wifi, then switch it on when you land.</p>
<div class="e-card">
<h2 style="margin-top:0">On this iPhone</h2>
${apple ? `<p><a class="e-btn big" href="${esc(apple)}" rel="noopener">Install on this iPhone</a></p>` : ''}
<p class="e-small">Needs iOS 17.4 or later. Tap it on the iPhone you are taking. If nothing happens, use the codes below.</p>
</div>
<div class="e-card">
<h2 style="margin-top:0">On another phone</h2>
${t.qr_url ? `<p class="e-small">Scan this from the phone you are taking (Settings &gt; Mobile/Cellular &gt; Add eSIM). On Android you can also save it and choose it from your photos.</p><img class="e-qr" src="${esc(t.qr_url)}" alt="eSIM QR code" width="220" height="220">` : ''}
${codes ? `<p class="e-small">${t.qr_url ? 'Or type' : 'Type'} these in by hand:</p>
<div class="e-code"><span>SM-DP+ address: ${esc(codes.smdp)}</span><button type="button" data-copy="${esc(codes.smdp)}">Copy</button></div>
<div class="e-code"><span>Activation code: ${esc(codes.activationCode)}</span><button type="button" data-copy="${esc(codes.activationCode)}">Copy</button></div>` : ''}
</div>
<h2>When you land</h2>
<ol class="e-steps"><li>Turn the eSIM line on and choose it for mobile data.</li><li>Switch Data Roaming on for that line. Keep your home SIM's roaming off if you want to avoid your own carrier's charges.</li><li>Stuck? Ask your concierge.</li></ol>
<p class="e-note"><b>Your concierge:</b> ask Num anything about your trip in the app at <a href="https://app.itsnum.com/?app">app.itsnum.com</a>.${smsLine} Keep this page private: the codes on it install your eSIM.</p>
${COPY_SCRIPT}
${foot()}`;
}

export function renderMessage({ title, body, status = 200 }) {
  return {
    status,
    html: `${head({ title: `${title} | Num`, desc: title, noindex: true })}
<h1>${esc(title)}</h1>
<p class="e-lede">${esc(body)}</p>
<p><a class="e-btn" href="/esim">All eSIMs</a></p>
${foot()}`,
  };
}

export function renderSitemap({ origin, countries = [], airports = [] }) {
  const urls = [`${origin}/esim`, ...countries.map((c) => `${origin}/esim/${c.toLowerCase()}`), ...airports.map((a) => `${origin}/esim/airport/${a.toLowerCase()}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
