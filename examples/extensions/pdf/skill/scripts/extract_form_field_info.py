#!/usr/bin/env python3
"""Extract detailed form field metadata from a PDF and output as JSON.

Usage:
    python3 extract_form_field_info.py input.pdf
    python3 extract_form_field_info.py input.pdf -o fields.json
"""

import argparse
import json
import sys

from pypdf import PdfReader
from pypdf.generic import ArrayObject


def resolve_value(value):
    """Resolve a PDF object to a JSON-serializable value."""
    if value is None:
        return None
    if hasattr(value, "get_object"):
        value = value.get_object()
    if isinstance(value, (list, ArrayObject)):
        return [resolve_value(v) for v in value]
    return str(value)


def extract_field_rect(field) -> list | None:
    """Extract the bounding box rectangle for a field widget."""
    # Try direct /Rect
    rect = field.get("/Rect")
    if rect is not None:
        try:
            return [float(x) for x in rect]
        except (TypeError, ValueError):
            pass

    # Try from /Kids (some forms use indirect widgets)
    kids = field.get("/Kids")
    if kids:
        for kid in kids:
            kid_obj = kid.get_object() if hasattr(kid, "get_object") else kid
            rect = kid_obj.get("/Rect")
            if rect is not None:
                try:
                    return [float(x) for x in rect]
                except (TypeError, ValueError):
                    pass

    return None


def find_field_page(reader: PdfReader, field) -> int | None:
    """Determine which page a field belongs to."""
    # Check /P reference
    page_ref = field.get("/P")
    if page_ref is not None:
        page_obj = page_ref.get_object() if hasattr(page_ref, "get_object") else page_ref
        for i, page in enumerate(reader.pages):
            if page.get_object() == page_obj:
                return i

    # Fall back: search annotations on each page
    field_obj = field.get_object() if hasattr(field, "get_object") else field

    for i, page in enumerate(reader.pages):
        annots = page.get("/Annots")
        if annots is None:
            continue
        for annot in annots:
            annot_obj = annot.get_object() if hasattr(annot, "get_object") else annot
            if annot_obj == field_obj:
                return i

    return None


def extract_options(field) -> list | None:
    """Extract options for choice fields."""
    opts = field.get("/Opt")
    if opts is None:
        return None
    result = []
    for opt in opts:
        if hasattr(opt, "get_object"):
            opt = opt.get_object()
        if isinstance(opt, (list, ArrayObject)):
            # [export_value, display_value]
            result.append({
                "export": str(opt[0]) if len(opt) > 0 else "",
                "display": str(opt[1]) if len(opt) > 1 else str(opt[0]) if len(opt) > 0 else "",
            })
        else:
            result.append({"export": str(opt), "display": str(opt)})
    return result


def extract_fields(pdf_path: str) -> list[dict]:
    """Extract all form field metadata from a PDF."""
    reader = PdfReader(pdf_path)
    fields = reader.get_fields()

    if not fields:
        return []

    result = []
    for name, field in fields.items():
        field_type = str(field.get("/FT", ""))
        flags = field.get("/Ff")
        flags_int = int(flags) if flags is not None else 0

        info = {
            "name": name,
            "type": field_type,
            "value": resolve_value(field.get("/V")),
            "default_value": resolve_value(field.get("/DV")),
            "rect": extract_field_rect(field),
            "page": find_field_page(reader, field),
            "flags": flags_int,
            "read_only": bool(flags_int & 1),
            "required": bool(flags_int & 2),
            "max_length": field.get("/MaxLen"),
            "options": extract_options(field) if field_type == "/Ch" else None,
            "tooltip": resolve_value(field.get("/TU")),
        }

        # For max_length, convert to int if present
        if info["max_length"] is not None:
            try:
                info["max_length"] = int(info["max_length"])
            except (TypeError, ValueError):
                info["max_length"] = None

        result.append(info)

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Extract form field metadata from a PDF"
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument(
        "-o", "--output",
        help="Output JSON file path (default: stdout)"
    )
    args = parser.parse_args()

    try:
        fields = extract_fields(args.pdf)
    except Exception as e:
        print(f"Error reading PDF: {e}", file=sys.stderr)
        sys.exit(1)

    output = json.dumps(fields, indent=2, ensure_ascii=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Wrote {len(fields)} field(s) to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
