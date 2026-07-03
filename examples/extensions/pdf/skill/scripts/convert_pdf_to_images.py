#!/usr/bin/env python3
"""Render PDF pages to images for visual inspection.

Usage:
    python3 convert_pdf_to_images.py input.pdf -o outdir/
    python3 convert_pdf_to_images.py input.pdf -o outdir/ --dpi 300
    python3 convert_pdf_to_images.py input.pdf -o outdir/ --pages 1-3
    python3 convert_pdf_to_images.py input.pdf -o page.png --pages 1

Prefers pypdfium2 for speed; falls back to pdf2image (poppler) if unavailable.
"""

import argparse
import sys
from pathlib import Path

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


def parse_page_range(spec: str, total_pages: int) -> list[int]:
    """Parse a page range like '1-3' or '2,5,7' into 0-based indices."""
    indices = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            start = max(1, int(start))
            end = min(total_pages, int(end))
            for i in range(start, end + 1):
                indices.add(i - 1)
        else:
            page = int(part)
            if 1 <= page <= total_pages:
                indices.add(page - 1)
    return sorted(indices)


def render_with_pdfium(pdf_path: str, page_indices: list[int], dpi: int) -> list[tuple[int, "Image"]]:
    """Render pages using pypdfium2."""
    pdf = pdfium.PdfDocument(pdf_path)
    scale = dpi / 72.0
    results = []
    for idx in page_indices:
        page = pdf[idx]
        bitmap = page.render(scale=scale)
        pil_image = bitmap.to_pil()
        results.append((idx, pil_image))
    return results


def render_with_pdf2image(pdf_path: str, page_indices: list[int], dpi: int) -> list[tuple[int, "Image"]]:
    """Render pages using pdf2image (poppler)."""
    results = []
    for idx in page_indices:
        images = convert_from_path(
            pdf_path, dpi=dpi,
            first_page=idx + 1,
            last_page=idx + 1,
        )
        results.append((idx, images[0]))
    return results


def get_total_pages(pdf_path: str) -> int:
    """Get the total number of pages in a PDF."""
    if HAS_PDFIUM:
        pdf = pdfium.PdfDocument(pdf_path)
        return len(pdf)
    else:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        return len(reader.pages)


def main():
    parser = argparse.ArgumentParser(
        description="Render PDF pages to images"
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument("-o", "--output", required=True, help="Output directory or file path (for single page)")
    parser.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200)")
    parser.add_argument("--pages", help="Page range, e.g. '1-3' or '2,5,7' (1-based). Default: all pages.")
    parser.add_argument("--format", choices=["png", "jpg"], default="png", help="Image format (default: png)")
    args = parser.parse_args()

    if not HAS_PDFIUM and not HAS_PDF2IMAGE:
        print("Error: neither pypdfium2 nor pdf2image is installed.", file=sys.stderr)
        sys.exit(1)

    try:
        total_pages = get_total_pages(args.pdf)
    except Exception as e:
        print(f"Error reading PDF: {e}", file=sys.stderr)
        sys.exit(1)

    if args.pages:
        page_indices = parse_page_range(args.pages, total_pages)
    else:
        page_indices = list(range(total_pages))

    if not page_indices:
        print("No valid pages selected.", file=sys.stderr)
        sys.exit(1)

    # Render
    try:
        if HAS_PDFIUM:
            rendered = render_with_pdfium(args.pdf, page_indices, args.dpi)
        else:
            rendered = render_with_pdf2image(args.pdf, page_indices, args.dpi)
    except Exception as e:
        print(f"Error rendering PDF: {e}", file=sys.stderr)
        sys.exit(1)

    # Save
    output_path = Path(args.output)
    fmt = args.format.upper()
    if fmt == "JPG":
        fmt = "JPEG"

    if len(rendered) == 1 and output_path.suffix:
        # Single page, output is a file path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        rendered[0][1].save(str(output_path), fmt)
        print(f"Page {rendered[0][0] + 1} -> {output_path}")
    else:
        # Multiple pages, output is a directory
        output_path.mkdir(parents=True, exist_ok=True)
        ext = "png" if fmt == "PNG" else "jpg"
        for idx, img in rendered:
            save_path = output_path / f"page_{idx + 1}.{ext}"
            img.save(str(save_path), fmt)
            print(f"Page {idx + 1} -> {save_path}")

    print(f"Done. Rendered {len(rendered)} page(s) at {args.dpi} DPI.")


if __name__ == "__main__":
    main()
