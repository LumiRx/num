#!/usr/bin/env python3
"""
NUM · contacts export — the business contact list, straight from num-db.

Pulls every place that has a phone or website (i.e. contactable) for the given
destinations and writes contacts.csv + contacts.xlsx (pure-stdlib xlsx: a
minimal SpreadsheetML zip — no openpyxl needed).

Usage:
    python3 scripts/export_contacts.py dubai,abu-dhabi,... out/contacts
    python3 scripts/export_contacts.py --all out/contacts
"""
import csv
import io
import json
import subprocess
import sys
import zipfile
from xml.sax.saxutils import escape

COLS = ["destination", "area", "name", "category", "phone", "website", "address", "lat", "lng", "source"]
PAGE = 5000


def d1(sql: str):
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "num-db", "--remote", "--json", "--command", sql],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)[0]["results"]


def fetch(dests):
    where = "WHERE ((phone IS NOT NULL AND phone != '') OR (website IS NOT NULL AND website != ''))"
    if dests:
        quoted = ",".join("'" + d.replace("'", "''") + "'" for d in dests)
        where += f" AND dest IN ({quoted})"
    rows, offset = [], 0
    while True:
        page = d1(
            "SELECT dest, area, name, category, phone, website, address, lat, lng, source "
            f"FROM places {where} ORDER BY dest, area, name LIMIT {PAGE} OFFSET {offset}"
        )
        rows.extend(page)
        if len(page) < PAGE:
            return rows
        offset += PAGE


def write_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(COLS)
        for r in rows:
            w.writerow([r.get(c.replace("destination", "dest")) or "" for c in COLS])


def col_ref(i):
    s = ""
    i += 1
    while i:
        i, rem = divmod(i - 1, 26)
        s = chr(65 + rem) + s
    return s


def write_xlsx(rows, path):
    """Minimal but valid .xlsx: one sheet, inline strings, frozen header row."""
    sheet = io.StringIO()
    sheet.write(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>'
        "<sheetData>"
    )
    def row_xml(idx, values, style=""):
        cells = "".join(
            f'<c r="{col_ref(i)}{idx}" t="inlineStr"{style}><is><t xml:space="preserve">{escape(str(v)[:900])}</t></is></c>'
            for i, v in enumerate(values)
        )
        return f'<row r="{idx}">{cells}</row>'

    sheet.write(row_xml(1, COLS, ' s="1"'))
    for n, r in enumerate(rows, start=2):
        sheet.write(row_xml(n, [r.get(c.replace("destination", "dest")) or "" for c in COLS]))
    sheet.write("</sheetData></worksheet>")

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        z.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="NUM contacts" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>",
        )
        z.writestr(
            "xl/styles.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fonts count="2"><font/><font><b/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border/></borders>'
            '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
            '<cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs>'
            "</styleSheet>",
        )
        z.writestr("xl/worksheets/sheet1.xml", sheet.getvalue())


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    dests = None if sys.argv[1] == "--all" else [d.strip() for d in sys.argv[1].split(",") if d.strip()]
    base = sys.argv[2]
    rows = fetch(dests)
    write_csv(rows, base + ".csv")
    write_xlsx(rows, base + ".xlsx")
    by_dest = {}
    for r in rows:
        by_dest[r["dest"]] = by_dest.get(r["dest"], 0) + 1
    print(f"{len(rows)} contactable places → {base}.csv / .xlsx")
    for d, n in sorted(by_dest.items(), key=lambda kv: -kv[1]):
        print(f"  {d}: {n}")


if __name__ == "__main__":
    main()
