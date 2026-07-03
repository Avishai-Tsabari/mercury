#!/usr/bin/env python3
"""Visualize form field positions by drawing labeled rectangles on a rendered PDF.

Usage:
    python3 check_bounding_boxes.py input.pdf -o fields_overlay.png
    python3 check_bounding_boxes.py input.pdf -o fields_overlay.png --page 0
    python3 check_bounding_boxes.py input.pdf -o fields_overlay.png --dpi 150

Renders each page and draws colored rectangles where form fields are, with
field names as labels. Useful for verifying field positions before filling.
"""

import argparse
import sys
from pathlib import Path

from pypdf import PdfReader

try:
    import pypdfium2 as pdfium
except ImportError:
    pdfium = None

try:
    from pdf2image import convert_from_path
except ImportError:
    convert_from_path = None

from PIL import Image, ImageDraw, ImageFont


# Colors for different field types (R, G, B, A)
FIELD_COLORS = {
    "/Tx": (255, 0, 0, 100),       # Red -- text
    "/Btn": (0, 0, 255, 100),      # Blue -- buttons/checkboxes
    "/Ch": (0, 180, 0, 100),       # Green -- choice/dropdown
    "/Sig": (255, 165, 0, 100),    # Orange -- signature
}
FIELD_BORDER_COLORS = {
    "/Tx": (255, 0, 0, 255),
    "/Btn": (0, 0, 255, 255),
    "/Ch": (0, 180, 0, 255),
    "/Sig": (255, 165, 0, 255),
}
DEFAULT_COLOR = (128, 128, 128, 100)
DEFAULT_BORDER = (128, 128, 128, 255)


def render_page_to_image(pdf_path: str, page_index: int, dpi: int) -> Image.Image:
    """Render a single PDF page to a PIL Image."""
    if pdfium is not None:
        pdf = pdfium.PdfDocument(pdf_path)
        page = pdf[page_index]
        scale = dpi / 72.0
        bitmap = page.render(scale=scale)
        return bitmap.to_pil()
    elif convert_from_path is not None:
        images = convert_from_path(
            pdf_path, dpi=dpi,
            first_page=page_index + 1,
            last_page=page_index + 1,
        )
        return images[0]
    else:
        raise RuntimeError("Neither pypdfium2 nor pdf2image is available.")


def collect_fields_by_page(pdf_path: str) -> dict[int, list[dict]]:
    """Collect form fields grouped by page number."""
    reader = PdfReader(pdf_path)
    fields = reader.get_fields()

    if not fields:
        return {}

    page_fields: dict[int, list[dict]] = {}

    for name, field in fields.items():
        field_type = str(field.get("/FT", ""))

        # Collect widget annotations (may be the field itself or its /Kids)
        widgets = []
        kids = field.get("/Kids")
        if kids:
            for kid in kids:
                widgets.append(kid.get_object() if hasattr(kid, "get_object") else kid)
        else:
            widgets.append(field)

        for widget in widgets:
            rect = widget.get("/Rect")
            if rect is None:
                continue

            try:
                rect_vals = [float(x) for x in rect]
            except (TypeError, ValueError):
                continue

            # Determine page
            page_num = None
            page_ref = widget.get("/P")
            if page_ref is not None:
                page_obj = page_ref.get_object() if hasattr(page_ref, "get_object") else page_ref
                for i, p in enumerate(reader.pages):
                    if p.get_object() == page_obj:
                        page_num = i
                        break

            if page_num is None:
                # Search annotations on each page
                for i, p in enumerate(reader.pages):
                    annots = p.get("/Annots")
                    if annots:
                        for annot in annots:
                            if annot.get_object() == widget:
                                page_num = i
                                break
                    if page_num is not None:
                        break

            if page_num is None:
                page_num = 0  # fallback

            if page_num not in page_fields:
                page_fields[page_num] = []

            page_fields[page_num].append({
                "name": name,
                "type": field_type,
                "rect": rect_vals,
            })

    return page_fields


def draw_fields_on_image(
    image: Image.Image,
    fields: list[dict],
    page_height_pts: float,
    dpi: int,
) -> Image.Image:
    """Draw field rectangles and labels on a rendered page image."""
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    scale = dpi / 72.0

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 10)
    except (OSError, IOError):
        font = ImageFont.load_default()

    for field in fields:
        x0, y0, x1, y1 = field["rect"]

        # PDF rect is (left, bottom, right, top), convert to image coords
        # Image origin is top-left
        img_x0 = x0 * scale
        img_y0 = (page_height_pts - y1) * scale
        img_x1 = x1 * scale
        img_y1 = (page_height_pts - y0) * scale

        ft = field["type"]
        fill_color = FIELD_COLORS.get(ft, DEFAULT_COLOR)
        border_color = FIELD_BORDER_COLORS.get(ft, DEFAULT_BORDER)

        draw.rectangle([img_x0, img_y0, img_x1, img_y1], fill=fill_color, outline=border_color, width=2)

        # Label
        label = field["name"]
        draw.text((img_x0 + 2, img_y0 - 12), label, fill=border_color, font=font)

    # Composite
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    result = Image.alpha_composite(image, overlay)
    return result.convert("RGB")


def main():
    parser = argparse.ArgumentParser(
        description="Visualize form field bounding boxes on a rendered PDF"
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument("-o", "--output", required=True, help="Output image path (or directory for multi-page)")
    parser.add_argument("--page", type=int, default=None, help="Specific page index (0-based). Default: all pages with fields.")
    parser.add_argument("--dpi", type=int, default=150, help="Render DPI (default: 150)")
    args = parser.parse_args()

    try:
        page_fields = collect_fields_by_page(args.pdf)
    except Exception as e:
        print(f"Error reading PDF: {e}", file=sys.stderr)
        sys.exit(1)

    if not page_fields:
        print("No form fields found in this PDF.")
        sys.exit(0)

    reader = PdfReader(args.pdf)

    pages_to_render = [args.page] if args.page is not None else sorted(page_fields.keys())

    output_path = Path(args.output)

    for page_num in pages_to_render:
        fields = page_fields.get(page_num, [])

        page = reader.pages[page_num]
        page_height = float(page.mediabox.height)

        image = render_page_to_image(args.pdf, page_num, args.dpi)

        if fields:
            image = draw_fields_on_image(image, fields, page_height, args.dpi)

        if len(pages_to_render) == 1:
            save_path = output_path
        else:
            output_path.mkdir(parents=True, exist_ok=True)
            save_path = output_path / f"page_{page_num + 1}.png"

        image.save(str(save_path))
        print(f"Page {page_num + 1}: {len(fields)} field(s) -> {save_path}")


if __name__ == "__main__":
    main()
