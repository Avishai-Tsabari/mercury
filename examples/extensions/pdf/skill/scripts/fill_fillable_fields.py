#!/usr/bin/env python3
"""Fill fillable PDF form fields from a JSON mapping.

Usage:
    python3 fill_fillable_fields.py input.pdf values.json -o filled.pdf

The values JSON should be an object mapping field names to values:
    {
        "first_name": "Alice",
        "agree_terms": true,
        "country": "Canada"
    }

Boolean values are converted to "/Yes" (checked) or "/Off" (unchecked) for
checkbox fields. String values are used as-is.
"""

import argparse
import json
import sys

from pypdf import PdfReader, PdfWriter


def fill_form(pdf_path: str, values: dict, output_path: str, flatten: bool = False):
    """Fill a PDF form with the given values.

    Args:
        pdf_path: Path to the input PDF with fillable fields.
        values: Dict mapping field names to values.
        output_path: Path to write the filled PDF.
        flatten: If True, make fields read-only after filling.
    """
    reader = PdfReader(pdf_path)

    if reader.is_encrypted:
        # Try empty password first
        try:
            reader.decrypt("")
        except Exception:
            raise ValueError("PDF is encrypted. Provide the password or decrypt first.")

    existing_fields = reader.get_fields()
    if not existing_fields:
        raise ValueError("PDF has no fillable form fields.")

    # Validate field names
    unknown = set(values.keys()) - set(existing_fields.keys())
    if unknown:
        print(f"Warning: ignoring unknown field(s): {', '.join(sorted(unknown))}", file=sys.stderr)

    # Convert boolean values for checkboxes
    processed_values = {}
    for name, value in values.items():
        if name not in existing_fields:
            continue
        field = existing_fields[name]
        field_type = str(field.get("/FT", ""))

        if field_type == "/Btn" and isinstance(value, bool):
            processed_values[name] = "/Yes" if value else "/Off"
        elif isinstance(value, bool):
            processed_values[name] = str(value)
        else:
            processed_values[name] = str(value)

    writer = PdfWriter()
    writer.append(reader)

    # Fill fields on each page
    filled_count = 0
    for page_num in range(len(writer.pages)):
        page = writer.pages[page_num]
        try:
            writer.update_page_form_field_values(
                page,
                processed_values,
                auto_regenerate=False,
            )
            filled_count += 1
        except Exception:
            # Some pages may not have matching fields -- that's OK
            pass

    if flatten:
        # Set read-only flag on all fields
        for page in writer.pages:
            annots = page.get("/Annots")
            if annots is None:
                continue
            for annot in annots:
                annot_obj = annot.get_object()
                if annot_obj.get("/FT") or annot_obj.get("/Parent"):
                    annot_obj.update({"/Ff": 1})

    writer.write(output_path)
    writer.close()

    matched = set(processed_values.keys()) & set(existing_fields.keys())
    return len(matched)


def main():
    parser = argparse.ArgumentParser(
        description="Fill fillable PDF form fields from a JSON mapping"
    )
    parser.add_argument("pdf", help="Path to the input PDF")
    parser.add_argument("values", help="Path to the JSON file with field values")
    parser.add_argument("-o", "--output", required=True, help="Output PDF path")
    parser.add_argument(
        "--flatten", action="store_true",
        help="Make fields read-only after filling"
    )
    args = parser.parse_args()

    try:
        with open(args.values, "r", encoding="utf-8") as f:
            values = json.load(f)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in {args.values}: {e}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print(f"Values file not found: {args.values}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(values, dict):
        print("Values JSON must be an object (dict), not an array.", file=sys.stderr)
        sys.exit(1)

    try:
        count = fill_form(args.pdf, values, args.output, flatten=args.flatten)
        print(f"Filled {count} field(s). Output: {args.output}")
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error filling form: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
