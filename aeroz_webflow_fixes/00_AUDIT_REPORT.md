# aeroz.io — Site Audit & Fix Plan

**Date:** 2026-05-26
**Auditor:** Claude
**Scope:** Every page reachable from the main nav + footer + Audit dropdown.

---

## TL;DR

There are **3 dead-end pages** (zero outbound links), **2 broken routes** (404s), and **mobile breakpoint hardening** to do. The fix bundle in this folder is paste-ready Webflow custom code that handles all three problem classes without you touching the Designer (other than embedding two HTML snippets on the dead-end pages).

---

## A. Dead-end pages (CRITICAL)

Pages that load successfully but have **0 links** — visitor must use the browser back button. The global nav and footer aren't rendering on these.

| Page | Links | Title |
|---|---|---|
| `/industries` | **0** | Industries · Pharma, EU Battery, UAE, Aesthetic |
| `/battery-passport` | **0** | EU Battery Passport Software · Article 77 Ready |
| `/uae` | **0** | Made-in-UAE Authentication · DMCC, VARA, GCC |

**Why this is bad:** `/industries` is in your main nav. `/battery-passport` is linked from the home page Audit dropdown. `/uae` is linked from the home page Audit area. Visitors who click these land in a content cul-de-sac.

**Fix:** Drop the HTML snippet from `03_dead_end_cta_block.html` into each of these pages as a Webflow HTML Embed at the bottom of the page. It renders a "What's next" CTA block matching the dark theme with three buttons pointing to `/platform`, `/contact`, and the home page.

---

## B. Broken routes (CRITICAL)

| Linked from | Target | Actual result |
|---|---|---|
| Main nav Audit dropdown · multiple pages · footer | `/dscsa` | Redirects to `/learn-more` → **404 Not Found** |
| `/contact` page | `/our-team` | **404 Not Found** |

**Fix:** Two paths, you can pick:

1. **Best:** rebuild the `/dscsa` page in Webflow (it's referenced everywhere — main nav, dropdown, footer, blog posts) and either build `/our-team` or remove the link from `/contact`. The content already exists in the `#audit-dscsa` section of your home page — you can clone that to a real `/dscsa` page in ~10 minutes.

2. **Until you do the above:** the `02_site_wide_redirect.js` script in this folder rewrites every `/dscsa` link on every page to scroll to `#audit-dscsa` on the home page instead (i.e. `/#audit-dscsa`), and rewrites `/our-team` to `/about`. That way no one ever lands on a 404.

---

## C. Mobile hardening (PREVENTIVE)

Several Webflow defaults that bite at mobile widths:
- Horizontal-overflow scroll when text or large numbers don't wrap (e.g., the home page metric callouts).
- Hero text sized for desktop spilling under the sticky header.
- Tap targets under 44×44 px on the audit dropdown items.
- Sticky CTA pill ("Start an audit") covering content when the page is short.

**Fix:** `01_site_wide_mobile_css.css` is a mobile-only CSS bundle that:
- Forces `overflow-x: hidden` on `html, body` and on common Webflow wrapper classes.
- Adds `max-width: 100%` and `word-break: break-word` to long-text blocks.
- Raises tap target minimums to 44px on every nav and dropdown item.
- Adds bottom-padding to the body equal to the sticky CTA height so the last content block can't sit under it.
- Adds safe-area inset support for iPhone notch / home indicator.

You paste this into **Project Settings → Custom Code → Head Code**. It's scoped to `@media (max-width: 768px)` so it only runs on mobile and won't disturb your desktop layout.

---

## D. The "≡" hamburger button has no handler

On the home page (and likely others) there's a single `<button>` with text `≡` and no `onclick` / no `data-action`. That's the mobile menu button — it has no behavior wired. Symptom: mobile users can't open the menu at all.

**Fix:** `02_site_wide_redirect.js` (same file as the link rewriter) includes a small handler that attaches a click listener to any header button whose innerText is `≡`. When tapped, it slides in a full-screen overlay menu with the same nav items as desktop. It only injects the menu DOM if Webflow hasn't already wired its own — if you have a proper Webflow nav set up that we just can't see, this is a no-op.

---

## E. Pages with empty `href` attributes

| Page | Count of empty links |
|---|---|
| `/` (home) | 0 |
| `/platform` | 2 (likely icon-only logos in footer) |
| `/supply-chain` | 2 (same) |
| `/implementation` | 2 (same) |
| `/liquid-data` | 2 (same) |
| `/contact` | 1 — the text "Terms" |

The "Terms" empty link on `/contact` should point to `/tos`. Add this single line of CSS-targeted JS in the bundle: rewrites any `<a>` whose text is exactly "Terms" and has no href to `/tos`.

---

## F. What I couldn't verify automatically

The Chrome window in this session was 1710px wide and I couldn't force it narrower than my display allows, so I couldn't visually screenshot the mobile breakpoint state. The CSS bundle is therefore **preventive hardening** — it adds safety rules that won't hurt anything but will catch the common Webflow mobile pitfalls. After you paste, please:

1. Open the live site on your phone (or use Chrome DevTools' device mode at 390 × 844).
2. Walk through home → Audit dropdown → /platform → /technology → /industries → /battery-passport → /uae → /contact.
3. Look for any remaining issues. If you see specific ones, share screenshots and I'll add targeted CSS.

---

## Page inventory (for the punch list)

| Path | Status | Links | Notes |
|---|---|---|---|
| `/` | ✅ Good | many | All audit anchors exist |
| `/platform` | ✅ Good | 18 | 2 empty (icons) |
| `/technology` | ✅ Good | 27 | — |
| `/supply-chain` | ✅ Good | 29 | 2 empty (icons) |
| `/industries` | ❌ Dead-end | **0** | Patch with embed |
| `/battery-passport` | ❌ Dead-end | **0** | Patch with embed |
| `/uae` | ❌ Dead-end | **0** | Patch with embed |
| `/dscsa` | ❌ 404 | — | Rewrite to `/#audit-dscsa` |
| `/learn-more` | ❌ 404 | — | (Target of `/dscsa` misdirect) |
| `/our-team` | ❌ 404 | — | Rewrite to `/about` |
| `/implementation` | ✅ Good | 15 | — |
| `/liquid-data` | ✅ Good | 15 | — |
| `/contact` | ✅ Good (form) | 12 | "Terms" empty → patch |
| `/blog` | ✅ Good | 124 | — |
| `/about` | ✅ Good | 42 | — |
| `/ai-management` | ✅ Good | 15 | — |
| `/privacy-policy` | ✅ Good | 25 | — |
| `/tos` | ✅ Good | 25 | — |
| `/post/defense-supply-chain` | ✅ Good | 56 | — |

---

## How to apply the bundle

1. **Webflow → Project Settings → Custom Code → Head Code**
   Paste contents of `01_site_wide_mobile_css.css` between `<style>` and `</style>` tags.

2. **Webflow → Project Settings → Custom Code → Footer Code**
   Paste contents of `02_site_wide_redirect.js` between `<script>` and `</script>` tags.

3. **On each of `/industries`, `/battery-passport`, `/uae`:**
   Open page in Designer → drag an **HTML Embed** element to the bottom of the page body → paste contents of `03_dead_end_cta_block.html`.

4. **Publish** the site.

5. **Verify** by visiting each fixed page in incognito (so you bypass cache) and confirming the nav, the CTA blocks, and the rewrites all work.
