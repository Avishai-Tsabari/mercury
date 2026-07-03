#!/usr/bin/env python3
"""Render a filled PDF to an image for visual validation.

Usage:
    python3 create_validation_image.py filled.pdf -o validation.png
    python3 create_validation_image.py filled.pdf -o validation/ --all-pages
    python3 create_validation_image.py filled.pdf -o validation.png --page 1 --dpi 200

Renders the PDF and optionally highlights filled form fields with a colored
border so you can quickly verify values are in the right places.
"""

import argparse
import sys
from pathlib import Path

from pypdf import PdfReader

try:
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except ImportError:
    HAS_PDFIUM = False

try:
    from pdf2image import convert_from_path
    HAS_PDF2IMAGE = True
except ImportError:
    HAS_PDF2IMAGE = False

from PIL import Image, ImageDraw, ImageFont


def render_page(pdf_path: str, page_index: int, dpi: int) -> Image.Image:
    """Render a single page to a PIL image."""
    if HAS_PDFIUM:
        pdf = pdfium.PdfDocument(pdf_path)
        page = pdf[page_index]
        bitmap = page.render(scale=dpi / 72.0)
        return bitmap.to_pil()
    elif HAS_PDF2IMAGE:
        images = convert_from_path(
            pdf_path, dpi=dpi,
            first_page=page_index + 1,
            last_page=page_index + 1,
        )
        return images[0]
    else:
        raise RuntimeError("Neither pypdfium2 nor pdf2image is available.")


def add_field_highlights(
    image: Image.Image,
    reader: PdfReader,
    page_index: int,
    dpi: int,
) -> Image.Image:
    """Add green border highlights around filled form fields."""
    page = reader.pages[page_index]
    annots = page.get("/Annots")
    if not annots:
        return image

    page_height = float(page.mediabox.height)
    scale = dpi / 72.0

    if image.mode != "RGBA":
        image = image.convert("RGBA")

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 9)
    except (OSError, IOError):
        font = ImageFont.load_default()

    for annot in annots:
        annot_obj = annot.get_object()
        ft = annot_obj.get("/FT")

        # Also check parent for field type
        if ft is None:
            parent = annot_obj.get("/Parent")
            if parent:
                parent_obj = parent.get_object() if hasattr(parent, "get_object") else parent
                ft = parent_obj.get("/FT")

        if ft is None:
            continue

        rect = annot_obj.get("/Rect")
        if rect is None:
            continue

        try:
            x0, y0, x1, y1 = [float(v) for v in rect]
        except (TypeError, ValueError):
            continue

        # Check if field has a value
        value = annot_obj.get("/V")
        if value is None:
            parent = annot_obj.get("/Parent")
            if parent:
                parent_obj = parent.get_object() if hasattr(parent, "get_object") else parent
                value = parent_obj.get("/V")

        if value is None or str(value) in ("", "/Off"):
            continue

        # Convert to image coordinates
        img_x0 = x0 * scale
        img_y0 = (page_height - y1) * scale
        img_x1 = x1 * scale
        img_y1 = (page_height - y0) * scale

        # Draw green highlight border
        draw.rectangle(
            [img_x0 - 1, img_y0 - 1, img_x1 + 1, img_y1 + 1],
            outline=(0, 200, 0, 180),
            width=2,
        )

        # Show value as label
        val_str = str(value)
        if len(val_str) > 30:
            val_str = val_str[:27] + "..."
        draw.text(
            (img_x0, img_y1 + 2),
            val_str,
            fill=(0, 150, 0, 220),
            font=font,
        )

    result = Image.alpha_composite(image, overlay)
    return result.convert("RGB")


def main():
    parser = argparse.ArgumentParser(
        description="Render a filled PDF for visual validation"
    )
    parser.add_argument("pdf", help="Path to the filled PDF file")
    parser.add_argument("-o", "--output", required=True, help="Output image path or directory")
    parser.add_argument("--page", type=int, default=1, help="Page number to render (1-based, default: 1)")
    parser.add_argument("--all-pages", action="store_true", help="Render all pages")
    parser.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200)")
    parser.add_argument("--no-highlight", action="store_true", help="Skip field highlighting")
    args = parser.parse_args()

    if not HAS_PDFIUM and not HAS_PDF2IMAGE:
        print("Error: neither pypdfium2 nor pdf2image is installed.", file=sys.stderr)
        sys.exit(1)

    try:
        reader = PdfReader(args.pdf)
        total_pages = len(reader.pages)
    except Exception as e:
        print(f"Error reading PDF: {e}", file=sys.stderr)
        sys.exit(1)

    if args.all_pages:
        page_indices = list(range(total_pages))
    else:
        page_idx = args.page - 1
        if page_idx < 0 or page_idx >= total_pages:
            print(f"Page {args.page} out of range (1-{total_pages}).", file=sys.stderr)
            sys.exit(1)
        page_indices = [page_idx]

    output_path = Path(args.output)

    for idx in page_indices:
        try:
            image = render_page(args.pdf, idx, args.dpi)
        except Exception as e:
            print(f"Error rendering page {idx + 1}: {e}", file=sys.stderr)
            continue

        if not args.no_highlight:
            try:
                image = add_field_highlights(image, reader, idx, args.dpi)
            except Exception as e:
                print(f"Warning: could not add highlights for page {idx + 1}: {e}", file=sys.stderr)

        if len(page_indices) == 1 and output_path.suffix:
            save_path = output_path
            save_path.parent.mkdir(parents=True, exist_ok=True)
        else:
            output_path.mkdir(parents=True, exist_ok=True)
            save_path = output_path / f"validation_page_{idx + 1}.png"

        image.save(str(save_path))
        print(f"Page {idx + 1} -> {save_path}")

    print("Validation image(s) created. Visually inspect to confirm field values.")


if __name__ == "__main__":
    main()
