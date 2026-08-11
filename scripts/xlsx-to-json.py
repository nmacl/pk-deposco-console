#!/usr/bin/env python3
"""Convert the go-live item xlsx to JSON for scripts/load-catalog.mjs.

Dependency-free (stdlib zipfile + ElementTree) — no openpyxl/pandas needed.
Reads shared strings as TEXT, so UPC leading zeros survive (48 rows depend on this;
a numeric cast would silently corrupt them).

  python3 scripts/xlsx-to-json.py "~/Downloads/Items to add in Deposco.xlsx" catalog.json

Expects columns: Item No. | Variant Code | WebshopVariantCode | Description | UPC
"""
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REQUIRED = ["Item No.", "Variant Code", "WebshopVariantCode", "Description", "UPC"]


def col_index(ref):
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def read_xlsx(path, sheet="xl/worksheets/sheet1.xml"):
    with zipfile.ZipFile(path) as z:
        strings = []
        try:
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{NS}si"):
                strings.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
        except KeyError:
            pass
        rows = []
        for row in ET.fromstring(z.read(sheet)).iter(f"{NS}row"):
            cells = {}
            for c in row.findall(f"{NS}c"):
                idx, ctype = col_index(c.get("r") or ""), c.get("t")
                if ctype == "s":
                    v = c.find(f"{NS}v")
                    val = strings[int(v.text)] if v is not None and v.text else ""
                elif ctype == "inlineStr":
                    el = c.find(f"{NS}is")
                    val = "".join(t.text or "" for t in el.iter(f"{NS}t")) if el is not None else ""
                else:
                    v = c.find(f"{NS}v")
                    val = (v.text or "") if v is not None else ""
                cells[idx] = val.strip()
            rows.append(cells)
    rows = [r for r in rows if any(v != "" for v in r.values())]
    if not rows:
        return [], []
    width = max(max(r) for r in rows) + 1
    headers = [rows[0].get(i, f"col{i}") or f"col{i}" for i in range(width)]
    return headers, [[r.get(i, "") for i in range(width)] for r in rows[1:]]


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = os.path.expanduser(sys.argv[1]), os.path.expanduser(sys.argv[2])
    headers, rows = read_xlsx(src)
    missing = [c for c in REQUIRED if c not in headers]
    if missing:
        sys.exit(f"ERROR: missing column(s) {missing}. Found: {headers}")
    H = {h: i for i, h in enumerate(headers)}

    recs = []
    for r in rows:
        wvc = r[H["WebshopVariantCode"]].strip()
        upc = r[H["UPC"]].strip()
        # ~141 rows carry the WebshopVariantCode in the UPC column (BC's UPC_GTN_No does too).
        # That is INTENTIONAL — those items are self-barcoded with PK's own SKU, so the WVC is
        # the barcode. Classified for reporting only; the loader sends the sheet value verbatim.
        if not upc:
            cls = "blank"
        elif upc == wvc:
            cls = "is_wvc"
        elif not upc.isdigit():
            cls = "nondigit"
        elif len(upc) in (12, 13, 14):
            cls = "valid_gtin"
        elif len(upc) == 11:
            cls = "short11"
        else:
            cls = f"len{len(upc)}"
        recs.append({
            "item": r[H["Item No."]].strip(), "var": r[H["Variant Code"]].strip(),
            "wvc": wvc, "desc": r[H["Description"]].strip(), "upc": upc, "upcClass": cls,
        })

    with open(dst, "w") as f:
        json.dump(recs, f)

    dupes = {k: v for k, v in Counter(x["wvc"] for x in recs).items() if v > 1}
    print(f"[xlsx] {len(recs)} rows -> {dst}")
    print(f"[xlsx] distinct WebshopVariantCode: {len(set(x['wvc'] for x in recs))}"
          + (f"   ⚠ {len(dupes)} duplicated: {list(dupes)}" if dupes else ""))
    print(f"[xlsx] UPC classes: {dict(Counter(x['upcClass'] for x in recs))}")


if __name__ == "__main__":
    main()
