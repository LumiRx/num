# AEROZ Demo Seed Data

Generated from the case-study deck (Pharma / Defense / Cannabis) plus realistic extensions to give the admin.aeroz.io demo a credible, fully-populated look across every tab.

## Story arc

This data set tells **one coherent demo narrative**:

> Aeroz operates a single Universal Asset Intelligence platform. A logistics officer logs in and sees a portfolio dashboard spanning Pharma cold-chain, Defense parts batching, and Mission-Critical logistics. Within the past 24h, three events fired: (a) a **Humalog seal breach** caught at geo:30.1578,-82.9989 between Ocala DC and a Florida pharmacy; (b) a **GO-Eagle Mk II drone** completed parent-child component aggregation at the Global Ordinance Ocala assembly line; (c) a **5.56mm NATO crate** triggered an automated OBSERVE event at Fort Liberty. The dashboard surfaces all three; the operator drills into the Humalog breach to walk the full chain-of-custody back to the source.

The same three case studies referenced in the slide deck become live, clickable records in the platform.

## Files

| File | Records | Purpose |
|---|---|---|
| `01_sellers.json` | 8 | Parties / clients / dispensers (HealthyLife, Global Ordinance, Vista, etc.) |
| `02_locations.json` | 14 | DCs, hubs, dispensaries, military installations |
| `03_products.json` | 12 | SKUs across pharma, defense, consumer |
| `04_tags.json` | 24 | EPC / UID records linking products to tag types |
| `05_events.json` | 18 | Journey-log entries (origin → transit → destination, plus aggregation + observe) |
| `06_alerts.json` | 5 | Security breach + anomaly alerts (the Humalog breach is the headliner) |
| `07_dashboard_metrics.json` | n/a | KPIs to populate the dashboard widgets |
| `08_case_studies.json` | 3 | The three packaged case studies (Lilly, Global Ordinance, DoD) |

## Notes

- All IDs are stable and deterministic — if you re-import you get the same records.
- Geo coordinates come straight from the case studies (e.g., `30.1578,-82.9989` for the Humalog breach; `35.1415,-79.0080` for Fort Liberty).
- Timestamps are recent (2026-05) so the dashboard looks "live."
- The "consumer authentication" cannabis example from the deck is included as a 4th micro case study (Saka White THC, Green Earth Dispensary, Los Angeles).
- Source: `/Users/dre/Documents/Claude/Projects/NUM/uploads/05b_Global-Ordinance-Defense-Case-Study.pdf`

## Field reconciliation

These files are written to a sensible "standard supply-chain schema" derived from the JSON outputs in the deck. After viewing the live admin tab structure I'll either (a) map these into the actual fields one-to-one, or (b) provide a transform script. See `99_field_mapping.md` once the admin is mapped.
