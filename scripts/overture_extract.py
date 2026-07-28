#!/usr/bin/env python3
"""
NUM · Overture Maps places extractor.

Pulls one destination's bounding box straight out of Overture's public S3
parquet with DuckDB and writes newline-delimited JSON for ingest_overture.mjs.

Nothing is downloaded in full: DuckDB reads the parquet footers, prunes on the
`bbox` struct statistics, and fetches only the row groups that intersect the
box. A whole city costs a few seconds and a few tens of MB.

  python3 overture_extract.py --bbox=S,W,N,E --out=/tmp/x.ndjson [--release=2026-07-22.0]

Licence: the Places theme is published per-record under CDLA-Permissive-2.0,
Apache-2.0 (Foursquare) or CC0-1.0 (AllThePlaces). All three permit commercial
use with attribution; none are share-alike. We therefore keep the per-record
licence and dataset on every row so the console can attribute correctly, and
we drop anything carrying a licence we have not cleared.
"""
import argparse, json, sys, time

ALLOWED_LICENCES = ("CDLA-Permissive-2.0", "Apache-2.0", "CC0-1.0")

# Overture's taxonomy top level. Everything outside this is a real business but
# not somewhere a traveller is ever sent — accountants, plumbers, wholesalers,
# clinics, schools, council offices.
KEEP_TOP = (
    "food_and_drink", "lodging", "shopping", "arts_and_entertainment",
    "cultural_and_historic", "sports_and_recreation", "travel_and_transportation",
    "lifestyle_services",
)
# Narrow exceptions we do want from otherwise-dropped top levels.
KEEP_CATEGORY = ("pharmacy", "drugstore", "hospital", "dentist", "urgent_care", "clinic")

DEFAULT_RELEASE = "2026-07-22.0"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True, help="S,W,N,E in degrees")
    ap.add_argument("--out", required=True)
    ap.add_argument("--release", default=DEFAULT_RELEASE)
    ap.add_argument("--min-confidence", type=float, default=0.0)
    a = ap.parse_args()

    try:
        import duckdb
    except ImportError:
        sys.exit("duckdb is not installed.  pip3 install --user duckdb")

    s, w, n, e = [float(x) for x in a.bbox.split(",")]
    path = (f"s3://overturemaps-us-west-2/release/{a.release}"
            f"/theme=places/type=place/*.parquet")

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")

    keep_top = ",".join(f"'{x}'" for x in KEEP_TOP)
    keep_cat = ",".join(f"'{x}'" for x in KEEP_CATEGORY)
    lic = ",".join(f"'{x}'" for x in ALLOWED_LICENCES)

    # STEP 1 — materialise the bounding box, and NOTHING else.
    #
    # This split is not tidiness, it is the difference between 5 seconds and
    # never finishing. The parquet footers carry min/max statistics on the
    # `bbox` struct, so a WHERE clause containing only bbox comparisons lets
    # DuckDB skip every row group outside the city and fetch a few tens of MB
    # over the wire. Add a correlated subquery over `sources` to the same
    # WHERE and the optimiser can no longer prove the predicate is safe to
    # push into the scan; it falls back to reading the entire global Places
    # theme. Keep this query pure.
    t0 = time.time()
    con.execute(f"""
    CREATE TEMP TABLE box AS
    SELECT * FROM read_parquet('{path}')
    WHERE bbox.xmin BETWEEN {w} AND {e}
      AND bbox.ymin BETWEEN {s} AND {n}
    """)
    n_box = con.execute("SELECT count(*) FROM box").fetchone()[0]
    print(f"  box: {n_box} raw places  ({time.time() - t0:.1f}s)", flush=True)

    # STEP 2 — everything expensive now runs against a local table.
    #
    # Overture has moved the top-level grouping between releases (`taxonomy`
    # is newer than `categories`), so ask the table what it actually has
    # rather than assuming. Without a taxonomy column we fall back to the
    # category allowlist alone and let ingest_overture.mjs's DROP set catch
    # the plumbers and car dealers on the way in.
    cols_present = {r[0] for r in con.execute("DESCRIBE box").fetchall()}
    if "taxonomy" in cols_present:
        top_expr = "taxonomy.hierarchy[1]"
        gate = f"({top_expr} IN ({keep_top}) OR categories.primary IN ({keep_cat}))"
    else:
        top_expr = "NULL"
        gate = f"(categories.primary IS NOT NULL OR categories.alternate[1] IS NOT NULL)"
    status_col = "operating_status" if "operating_status" in cols_present else "NULL"

    sql = f"""
    SELECT
      id,
      names.primary                                        AS name,
      to_json(map_entries(names.common))                   AS names_common,
      categories.primary                                   AS category,
      {top_expr}                                           AS top,
      categories.alternate[1]                              AS alt,
      confidence,
      websites[1]                                          AS website,
      phones[1]                                            AS phone,
      emails[1]                                            AS email,
      addresses[1].freeform                                AS addr,
      addresses[1].locality                                AS locality,
      addresses[1].postcode                                AS postcode,
      addresses[1].country                                 AS country,
      {status_col}                                         AS operating_status,
      (bbox.xmin + bbox.xmax) / 2                          AS lng,
      (bbox.ymin + bbox.ymax) / 2                          AS lat,
      list_distinct(list_transform(sources, x -> x.dataset)) AS datasets,
      list_distinct(list_transform(sources, x -> x.license)) AS licences
    FROM box
    WHERE names.primary IS NOT NULL
      AND confidence >= {a.min_confidence}
      AND {gate}
      AND len(list_filter(list_transform(sources, x -> x.license),
                          l -> l IS NOT NULL AND l NOT IN ({lic}))) = 0
      AND ({status_col} IS NULL OR {status_col} <> 'closed')
    """

    rows = con.execute(sql).fetchall()
    cols = [d[0] for d in con.description]
    with open(a.out, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(dict(zip(cols, r)), ensure_ascii=False, default=str) + "\n")
    print(f"  {len(rows)} places -> {a.out}  ({time.time() - t0:.1f}s total)", flush=True)


if __name__ == "__main__":
    main()
