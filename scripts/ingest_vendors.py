"""NUM — vendor catalogue ingest.

Loads merchants from a CSV (the Thai team's collection sheet) into the
`vendors` table so `search_vendors` has real data to recommend.

CSV format: docs/ops/vendor_template.csv. Core columns map to real vendor
columns; every other recognized column is packed into `metadata` jsonb.

Dedupe: (partner_tenant_id, name, category) — re-running the same sheet
updates metadata/tier/commission instead of duplicating rows, so the team can
maintain one living spreadsheet.

Usage:
    python scripts/ingest_vendors.py path/to/vendors.csv                # live
    python scripts/ingest_vendors.py path/to/vendors.csv --dry-run     # preview
    python scripts/ingest_vendors.py vendors.csv --tenant <uuid>       # explicit tenant

Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (from .env). Tenant falls back
to DEFAULT_PARTNER_TENANT_ID.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from apps.api.deps import get_supabase  # noqa: E402
from apps.api.settings import get_settings  # noqa: E402

CORE_COLUMNS = {"name", "category", "commission_pct", "featured_tier"}
CATEGORIES = {"restaurant", "hotel", "transfer", "tour", "spa", "school", "agent",
              "activity", "nightlife", "shopping", "medical", "other"}
TIERS = {"", "local", "standard", "premium"}
METADATA_COLUMNS = [
    "area", "price_band", "hours", "phone", "line_id", "whatsapp", "wechat_id",
    "photos_url", "maps_url", "website", "languages", "notes", "lat", "lng",
]


def load_rows(csv_path: Path) -> list[dict]:
    with csv_path.open(encoding="utf-8-sig", newline="") as f:
        return [dict(r) for r in csv.DictReader(f)]


def validate(row: dict, line_no: int) -> list[str]:
    problems = []
    if not (row.get("name") or "").strip():
        problems.append(f"line {line_no}: missing name")
    cat = (row.get("category") or "").strip().lower()
    if cat and cat not in CATEGORIES:
        problems.append(f"line {line_no}: unknown category '{cat}' (allowed: {sorted(CATEGORIES)})")
    tier = (row.get("featured_tier") or "").strip().lower()
    if tier not in TIERS:
        problems.append(f"line {line_no}: featured_tier must be local/standard/premium or blank")
    return problems


def to_vendor(row: dict, tenant_id: str | None) -> dict:
    metadata = {}
    for col in METADATA_COLUMNS:
        val = (row.get(col) or "").strip()
        if val:
            metadata[col] = val
    commission = (row.get("commission_pct") or "").strip()
    return {
        "partner_tenant_id": tenant_id,
        "name": row["name"].strip(),
        "category": (row.get("category") or "other").strip().lower(),
        "featured_tier": (row.get("featured_tier") or "").strip().lower() or None,
        "commission_pct": float(commission) if commission else None,
        "metadata": metadata,
    }


def upsert(sb, vendor: dict) -> str:
    """Insert or update by (tenant, name, category). Returns 'created'|'updated'."""
    q = (
        sb.table("vendors")
        .select("id")
        .eq("name", vendor["name"])
        .eq("category", vendor["category"])
    )
    if vendor["partner_tenant_id"]:
        q = q.eq("partner_tenant_id", vendor["partner_tenant_id"])
    existing = q.limit(1).execute().data
    if existing:
        sb.table("vendors").update(
            {k: v for k, v in vendor.items() if k != "partner_tenant_id"}
        ).eq("id", existing[0]["id"]).execute()
        return "updated"
    sb.table("vendors").insert(vendor).execute()
    return "created"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest vendor CSV into Supabase")
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--tenant", help="partner_tenant_id (defaults to DEFAULT_PARTNER_TENANT_ID)")
    parser.add_argument("--dry-run", action="store_true", help="validate + preview, write nothing")
    args = parser.parse_args(argv)

    if not args.csv_path.exists():
        print(f"✗ file not found: {args.csv_path}")
        return 1

    rows = load_rows(args.csv_path)
    if not rows:
        print("✗ CSV has no data rows")
        return 1

    tenant_id = args.tenant or get_settings().DEFAULT_PARTNER_TENANT_ID
    if not tenant_id:
        print("⚠ no tenant id (flag --tenant / env DEFAULT_PARTNER_TENANT_ID) — rows will be tenant-less")

    all_problems: list[str] = []
    for i, row in enumerate(rows, start=2):  # header = line 1
        all_problems.extend(validate(row, i))
    if all_problems:
        print("✗ validation failed:")
        for p in all_problems:
            print(f"  - {p}")
        return 1

    vendors = [to_vendor(r, tenant_id) for r in rows]
    print(f"✓ {len(vendors)} rows valid (tenant: {tenant_id or 'NONE'})")

    if args.dry_run:
        for v in vendors[:10]:
            print(f"  [dry-run] {v['category']:<12} {v['name']}  tier={v['featured_tier'] or '-'}")
        if len(vendors) > 10:
            print(f"  [dry-run] ... and {len(vendors) - 10} more")
        return 0

    sb = get_supabase()
    created = updated = failed = 0
    for v in vendors:
        try:
            outcome = upsert(sb, v)
            created += outcome == "created"
            updated += outcome == "updated"
        except Exception as e:  # keep going — one bad row shouldn't kill the batch
            failed += 1
            print(f"  ✗ {v['name']}: {e}")
    print(f"done: {created} created, {updated} updated, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
