#!/usr/bin/env python3
"""Fill a non-fillable PDF by overlaying text at specified positions.

Usage:
    python3 fill_pdf_form_with_annotations.py input.pdf spec.json -o filled.pdf

The spec JSON defines where to place text on each page:

    [
        {
            "page": 0,
            "fields": [
                {"x": 200, "y": 705, "value": "Alice Smith", "font_size": 11},
                {"x": 200, "y": 680, "value": "alice@example.com"}
            ]
        }
    ]

Or a simpler single-page format:

    {
        "page": 0,
        "fields": [
            {"x": 200, "y": 705, "value": "Alice Smith"}
        ]
    }

Coordinates are in PDF points (1/72 inch), origin at bottom-left.
Default font size is 10pt. Default font is Helvetica.

Two methods are available:
  --method overlay   (default) Creates a transparent PDF with reportlab and merges it.
                     Best compatibility. Values become part of the page content.
  --method annot     Adds FreeText annotations. Original content is untouched.
                     Some viewers may display annotations differently.
"""

import argparse
import io
import json
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText
from pypdf.generic import ArrayObject, FloatObject, NameObject
from reportlab.pdfgen import canvas


DEFAULT_FONT_SIZE = 10
DEFAULT_FONT = "Helvetica"


def fill_with_overlay(
    pdf_path: str,
    pages_spec: list[dict],
    output_path: str,
):
    """Fill by creating a transparent overlay and merging onto each page."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    # Group fields by page
    fields_by_page: dict[int, list[dict]] = {}
    for spec in pages_spec:
        page_num = spec.get("page", 0)
        fields = spec.get("fields", [])
        if page_num not in fields_by_page:
            fields_by_page[page_num] = []
        fields_by_page[page_num].extend(fields)

    for i, page in enumerate(reader.pages):
        if i in fields_by_page and fields_by_page[i]:
            # Get page dimensions
            page_width = float(page.mediabox.width)
            page_height = float(page.mediabox.height)

            # Create overlay
            packet = io.BytesIO()
            c = canvas.Canvas(packet, pagesize=(page_width, page_height))

            for field in fields_by_page[i]:
                x = float(field["x"])
                y = float(field["y"])
                value = str(field["value"])
                font_size = field.get("font_size", DEFAULT_FONT_SIZE)
                font_name = field.get("font", DEFAULT_FONT)
                color = field.get("color", [0, 0, 0])  # RGB 0-1 or 0-255

                # Normalize color to 0-1 range
                if isinstance(color, (list, tuple)) and len(color) >= 3:
                    r, g, b = color[0], color[1], color[2]
                    if any(c > 1 for c in [r, g, b]):
                        r, g, b = r / 255, g / 255, b / 255
                else:
                    r, g, b = 0, 0, 0

                c.setFont(font_name, font_size)
                c.setFillColorRGB(r, g, b)
                c.drawString(x, y, value)

            c.save()
            packet.seek(0)

            overlay_reader = PdfReader(packet)
            page.merge_page(overlay_reader.pages[0])

        writer.add_page(page)

    writer.write(output_path)
    writer.close()


def fill_with_annotations(
    pdf_path: str,
    pages_spec: list[dict],
    output_path: str,
):
    """Fill by adding FreeText annotations to each page."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()
    writer.append(reader)

    # Group fields by page
    fields_by_page: dict[int, list[dict]] = {}
    for spec in pages_spec:
        page_num = spec.get("page", 0)
        fields = spec.get("fields", [])
        if page_num not in fields_by_page:
            fields_by_page[page_num] = []
        fields_by_page[page_num].extend(fields)

    for page_num, fields in fields_by_page.items():
        if page_num >= len(writer.pages):
            print(f"Warning: page {page_num} out of range, skipping.", file=sys.stderr)
            continue

        page = writer.pages[page_num]

        for field in fields:
            x = float(field["x"])
            y = float(field["y"])
            value = str(field["value"])
            font_size = field.get("font_size", DEFAULT_FONT_SIZE)
            font_name = field.get("font", DEFAULT_FONT)

            # Estimate text width for the rectangle
            char_width = font_size * 0.6  # approximate
            text_width = len(value) * char_width
            text_height = font_size * 1.4

            # Build the annotation
            annotation = FreeText(
                text=value,
                rect=(x, y, x + text_width, y + text_height),
                font=font_name,
                font_size=f"{font_size}pt",
                font_color="000000",
                border_color=None,
            )

            writer.add_annotation(page_number=page_num, annotation=annotation)

    writer.write(output_path)
    writer.close()


def normalize_spec(raw: dict | list) -> list[dict]:
    """Normalize spec to a list of page specs."""
    if isinstance(raw, dict):
        # Single page spec
        return [raw]
    if isinstance(raw, list):
        # Could be a list of page specs, or a list of fields (legacy)
        if raw and isinstance(raw[0], dict) and "fields" in raw[0]:
            return raw
        # Assume it's a list of page specs
        return raw
    raise ValueError("Spec must be a JSON object or array.")


def main():
    parser = argparse.ArgumentParser(
        description="Fill a non-fillable PDF with text at specified positions"
    )
    parser.add_argument("pdf", help="Path to the input PDF")
    parser.add_argument("spec", help="Path to the JSON fill specification")
    parser.add_argument("-o", "--output", required=True, help="Output PDF path")
    parser.add_argument(
        "--method", choices=["overlay", "annot"], default="overlay",
        help="Fill method: 'overlay' (default, reportlab merge) or 'annot' (FreeText annotations)"
    )
    args = parser.parse_args()

    try:
        with open(args.spec, "r", encoding="utf-8") as f:
            raw_spec = json.load(f)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in {args.spec}: {e}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print(f"Spec file not found: {args.spec}", file=sys.stderr)
        sys.exit(1)

    try:
        pages_spec = normalize_spec(raw_spec)
    except ValueError as e:
        print(f"Invalid spec format: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        if args.method == "overlay":
            fill_with_overlay(args.pdf, pages_spec, args.output)
        else:
            fill_with_annotations(args.pdf, pages_spec, args.output)

        total_fields = sum(len(s.get("fields", [])) for s in pages_spec)
        print(f"Filled {total_fields} field(s) using {args.method} method. Output: {args.output}")
    except Exception as e:
        print(f"Error filling PDF: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
