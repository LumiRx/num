# Critical finding from the live admin probe (2026-05-26)

## The platform is `LumiRX`, not generic AEROZ

- The admin at `admin.aeroz.io` is branded **LumiRX** (heart logo, "LRX by Lumi" in the page title).
- Sidebar tabs: Dashboard · Locations · Products · Brands · Seller · Rewards · Tags · Contact Us · Log out.
- All counts at zero — fully empty database.

## The backend API is currently returning 503 (Service Unavailable)

Network sniff during page load on `/brands/brands-list` shows the front-end calling these endpoints — every one of them returned **503** during this session:

```
GET  https://api.lumirx.com/user/profile          → 503
GET  https://api.lumirx.com/brand/getAllBrands    → 503
GET  https://api.lumirx.com/location/getLocations → 503
GET  https://api.lumirx.com/product/getProducts   → 503
GET  https://api.lumirx.com/tag/getTags           → 503
GET  https://api.lumirx.com/seller/getAllSellers  → 503
```

This means:
- The Brands list shows "no records" because the GET failed.
- The "Primary product category" dropdown in the Add Brand form was empty because its category fetch failed.
- **Any record we try to create via the UI will also fail to POST** — because the front-end will be POSTing to the same down API.

Manual UI entry isn't going to work right now even if I drove every click.

## Mapped form schemas (from what I saw before the 503 blocker)

### Brand (3-step wizard)
- **Step 1**: Brand name · Parent company · Business entity name · Business registration number · Address (Line 1, Line 2, Country, City, State, Zip)
- **Step 2**: Primary product category* (dropdown, fetched from API — currently empty due to 503) · Description of brand · Documents upload
- **Step 3**: not yet observed

### Product (3-step wizard)
- **Step 1**: Brand* (dropdown → Brands table) · Price · Name* · Category* (dropdown) · GTIN* · Description* · Documents upload
- **Step 2/3**: not yet observed

### Locations / Seller / Tags / Rewards
- Not yet mapped. Each likely follows the same wizard pattern with a similar API endpoint.

## Inferred POST endpoints (educated guess from the GETs)

```
POST https://api.lumirx.com/brand/createBrand        (or /brand/add)
POST https://api.lumirx.com/location/createLocation
POST https://api.lumirx.com/product/createProduct
POST https://api.lumirx.com/tag/createTag
POST https://api.lumirx.com/seller/createSeller
```

These would also need to send the user's auth bearer token from `localStorage` / cookies.

## Three paths forward

| # | Path | Pros | Cons |
|---|---|---|---|
| 1 | **Get the API back online, then I drive Chrome** | UI works as designed | Slowest entry (~30 records × 3-step wizard ≈ several hours of bot time) |
| 2 | **Get the API back online, then I bulk-POST via fetch() from the console** | Fastest population — minutes, not hours. The seed JSON files map cleanly onto API payloads. | Need to confirm exact POST schemas (may not match GET schemas 1:1). I'd POST one Brand via UI first to capture the real payload, then bulk the rest via console. |
| 3 | **Send seed JSON to your backend dev** | They batch-insert at the database layer. Cleanest. | Requires backend cooperation. |

## What I produced this session that's still useful

In `/Users/dre/Documents/Claude/Projects/NUM/aeroz_demo/`:

- `01_sellers.json` — 8 records (Eli Lilly, HealthyLife, Global Ordinance, Vista, DoD, Saka, Green Earth, Floridian Family Pharmacy)
- `02_locations.json` — 14 records (DCs, hubs, dispensaries, military installations)
- `03_products.json` — 12 records (Humalog, Trulicity, Mounjaro, Zepbound, Verzenio, Taltz, GO-Eagle drone + 3 components, NATO M855, Saka THC)
- `04_tags.json` — 24 records (EPCs / UIDs with parent-child relationships)
- `05_events.json` — 18 journey-log entries spanning all 4 case studies
- `06_alerts.json` — 5 alerts (Humalog breach as the headliner)
- `07_dashboard_metrics.json` — KPIs for dashboard widgets
- `08_case_studies.json` — the 3 packaged case studies + Saka bonus

All cross-referenced (sellers → locations → products → tags → events → alerts), all coordinates and JSON record IDs match the case study deck exactly.

## Recommendation

**Path 2 is the right one once the API is healthy.** When `api.lumirx.com` returns 200s again, ping me and I can:

1. Have you (or me) submit ONE Brand via the UI so I can capture the exact POST payload from the network tab.
2. Open the browser console and `fetch()`-POST the rest of the seed data in batches.
3. Refresh and verify each tab populates correctly.
4. Optionally take a final dashboard screenshot for your demo.

That converts what would have been 3+ hours of click-by-click work into ~15 minutes.
