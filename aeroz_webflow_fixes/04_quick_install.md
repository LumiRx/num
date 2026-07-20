# aeroz.io — 10-Minute Install Guide

Three files, three paste targets. After this, every broken link works, the dead-end pages have proper CTAs, and mobile is hardened.

---

## Step 1 — CSS (site-wide, head)

**File:** `01_site_wide_mobile_css.css`
**Where:** Webflow → Project Settings → Custom Code → **Head Code**

Paste the contents wrapped in a `<style>` tag:

```html
<style>
  /* paste contents of 01_site_wide_mobile_css.css here */
</style>
```

Save.

## Step 2 — JS (site-wide, footer)

**File:** `02_site_wide_redirect.js`
**Where:** Webflow → Project Settings → Custom Code → **Footer Code**

Paste the contents wrapped in a `<script>` tag:

```html
<script>
  /* paste contents of 02_site_wide_redirect.js here */
</script>
```

Save. This handles:
- `/dscsa` link rewrites
- `/our-team` link rewrites
- "Terms" empty href patch
- Mobile menu fallback for the `≡` button
- Click-to-open audit dropdown on mobile

## Step 3 — CTA embed (per page, 3 pages)

**File:** `03_dead_end_cta_block.html`
**Where:** Each of these Webflow pages — at the very bottom of the page body:
- `/industries`
- `/battery-passport`
- `/uae`

In Webflow Designer:
1. Open the page.
2. Drag an **HTML Embed** element to the bottom of the body wrapper.
3. Paste the full HTML from `03_dead_end_cta_block.html`.
4. Save & close → publish.

## Step 4 — Publish & spot-check

Click **Publish** in Webflow.

In an incognito window (so you bypass cache), open:

- https://aeroz.io/ — verify the Audit dropdown still scrolls correctly.
- https://aeroz.io/dscsa — should now jump to the audit section on home, not 404.
- https://aeroz.io/industries — should show the new CTA block at the bottom.
- https://aeroz.io/battery-passport — same.
- https://aeroz.io/uae — same.
- https://aeroz.io/contact — the "Terms" link should now point to `/tos`.
- On mobile (or Chrome DevTools at 390 × 844) — the `≡` menu should open the overlay.

---

## When you have time, do these properly in Webflow

The fix bundle keeps you out of 404 land today, but the cleaner long-term fixes are:

1. **Build a real `/dscsa` page.** Clone the home page's `#audit-dscsa` section into a new page at `/dscsa`. Remove the JS rewrite for `/dscsa` once it's live.
2. **Decide what `/our-team` should be.** Either build it (a "Team" page using `/about` content), or remove the contact-page link entirely.
3. **Ship a real Webflow nav on `/industries`, `/battery-passport`, `/uae`.** Those pages are inheriting an empty layout. Whatever symbol/component is supposed to render the nav and footer isn't on those pages. Drop the nav and footer symbols in, then you can remove the dead-end CTA embed.
4. **Audit your Webflow CMS for any other pages built off the same empty template.** Search the CMS list for pages with no nav symbol — likely the same template is the culprit.

---

## What changes for the user

| Before | After |
|---|---|
| `/dscsa` → 404 | `/dscsa` → home page DSCSA section |
| `/our-team` → 404 | `/our-team` → `/about` |
| `/industries` → cul-de-sac | `/industries` → has a 3-button CTA + 8 quicklinks |
| `/battery-passport` → cul-de-sac | Same |
| `/uae` → cul-de-sac | Same |
| "Terms" link on `/contact` does nothing | "Terms" → `/tos` |
| Mobile `≡` menu does nothing | `≡` opens a full overlay menu |
| Long words / numbers overflow on mobile | Wrap properly |
| Tap targets too small on dropdowns | All ≥ 44 × 44 px |
| Last block hidden under sticky CTA | 96px bottom padding clears it |

---

## How to remove the bundle later

If you later rebuild these pages properly in Webflow:

1. Strip the matching rule out of the `rewrites` object in `02_site_wide_redirect.js`.
2. Remove the HTML Embed from the page in Designer.
3. Republish.

Keep the CSS — it's preventive hardening that's useful regardless.
