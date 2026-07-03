#!/usr/bin/env python3
"""Detect whether a PDF has fillable form fields and list them.

Usage:
    python3 check_fillable_fields.py input.pdf
    python3 check_fillable_fields.py input.pdf --json
"""

import argparse
import json
import sys

from pypdf import PdfReader


FIELD_TYPE_NAMES = {
    "/Tx": "Text",
    "/Btn": "Button/Checkbox",
    "/Ch": "Choice/Dropdown",
    "/Sig": "Signature",
}


def check_fields(pdf_path: str) -> dict:
    """Check a PDF for fillable form fields.

    Returns a dict with:
        - has_fields: bool
        - count: int
        - fields: list of field info dicts
    """
    reader = PdfReader(pdf_path)
    fields = reader.get_fields()

    if not fields:
        return {"has_fields": False, "count": 0, "fields": []}

    field_list = []
    for name, field in fields.items():
        field_type = field.get("/FT", "Unknown")
        value = field.get("/V")
        if hasattr(value, "get_object"):
            value = str(value.get_object())
        elif value is not None:
            value = str(value)

        field_list.append({
            "name": name,
            "type": str(field_type),
            "type_name": FIELD_TYPE_NAMES.get(str(field_type), "Unknown"),
            "value": value,
        })

    return {
        "has_fields": True,
        "count": len(field_list),
        "fields": field_list,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Check if a PDF has fillable form fields"
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument(
        "--json", action="store_true", dest="as_json",
        help="Output as JSON"
    )
    args = parser.parse_args()

    try:
        result = check_fields(args.pdf)
    except Exception as e:
        print(f"Error reading PDF: {e}", file=sys.stderr)
        sys.exit(1)

    if args.as_json:
        print(json.dumps(result, indent=2))
        return

    if not result["has_fields"]:
        print("No fillable form fields found.")
        print("This PDF may be a non-fillable form. See forms.md for the non-fillable workflow.")
        return

    print(f"Found {result['count']} fillable form field(s):\n")
    for f in result["fields"]:
        value_str = f" = {f['value']}" if f["value"] else ""
        print(f"  {f['name']}")
        print(f"    Type: {f['type_name']} ({f['type']}){value_str}")
        print()


if __name__ == "__main__":
    main()
