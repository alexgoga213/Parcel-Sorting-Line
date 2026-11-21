"""Builds plc/PLC_Tags.xlsx (TIA Portal tag-table import format) from plc/PLC_Tags.csv.

Usage: python tools/make_tag_table.py
No third-party packages: the .xlsx is written by hand (it is just zipped XML).
"""
import csv
import os
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "plc", "PLC_Tags.csv")
DST = os.path.join(ROOT, "plc", "PLC_Tags.xlsx")
TABLE = "Sorter IO"
HEADER = ["Name", "Path", "Data Type", "Logical Address", "Comment",
          "Hmi Visible", "Hmi Accessible", "Hmi Writeable", "Typeobject ID", "Version ID"]


def col(i):
    return chr(ord("A") + i)


def cell(ref, value):
    return f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'


def main():
    with open(SRC, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    data = [HEADER] + [
        [r["Name"], TABLE, r["Data Type"], r["Logical Address"], r["Comment"], "True", "True", "True", "", ""]
        for r in rows
    ]
    sheet_rows = "".join(
        f'<row r="{n}">' + "".join(cell(f"{col(i)}{n}", v) for i, v in enumerate(row) if v != "") + "</row>"
        for n, row in enumerate(data, start=1)
    )
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="PLC Tags" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>"
        ),
        "xl/worksheets/sheet1.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheetData>{sheet_rows}</sheetData></worksheet>"
        ),
    }
    with zipfile.ZipFile(DST, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    print(f"wrote {DST} ({len(rows)} tags)")


if __name__ == "__main__":
    main()
