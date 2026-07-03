#!/usr/bin/env python3
"""Extract form structure from a non-fillable PDF by detecting labels and blank regions.

Usage:
    python3 extract_form_structure.py input.pdf -o structure.json
    python3 extract_form_structure.py input.pdf -o structure.json --page 1

Uses pdfplumber to analyze text positions and detect patterns common in forms:
labels followed by underlines, colons, or blank spaces where values should go.

The output is heuristic -- always verify with a rendered image of the PDF.
"""

import argparse
import json
import re
import sys

import pdfplumber


# Common form label patterns
LABEL_PATTERNS = [
    re.compile(r"^(.+?):\s*$"),           # "Name:"
    re.compile(r"^(.+?)\s*[:]\s*$"),      # "Name :"
    re.compile(r"^(.+?)_{2,}\s*$"),       # "Name____"
    re.compile(r"^(.+?)\s*\.{3,}\s*$"),   # "Name..."
]


def extract_structure(pdf_path: str, page_num: int | None = None) -> list[dict]:
    """Extract form structure from a non-fillable PDF.

    Returns a list of detected form regions with:
        - label: the text label
        - label_rect: bounding box of the label text
        - fill_rect: estimated bounding box where the value should go
        - page: page number (0-based)
        - confidence: rough confidence score (high, medium, low)
    """
    results = []

    with pdfplumber.open(pdf_path) as pdf:
        pages = [pdf.pages[page_num]] if page_num is not None else pdf.pages

        for page in pages:
            page_idx = page.page_number - 1  # pdfplumber uses 1-based
            page_width = float(page.width)
            page_height = float(page.height)

            words = page.extract_words(
                keep_blank_chars=True,
                x_tolerance=3,
                y_tolerance=3,
            )

            # Group words into lines by vertical position
            lines = _group_into_lines(words, y_tolerance=5)

            # Detect horizontal lines/rules (potential underlines for fill areas)
            h_lines = []
            if page.lines:
                for line in page.lines:
                    if abs(float(line.get("top", 0)) - float(line.get("bottom", 0))) < 2:
                        h_lines.append({
                            "x0": float(line["x0"]),
                            "x1": float(line["x1"]),
                            "y": float(line["top"]),
                        })

            # Detect rectangles (potential input boxes)
            rects = []
            if page.rects:
                for rect in page.rects:
                    w = float(rect["x1"]) - float(rect["x0"])
                    h_r = float(rect["bottom"]) - float(rect["top"])
                    if w > 30 and 10 < h_r < 40:
                        rects.append({
                            "x0": float(rect["x0"]),
                            "top": float(rect["top"]),
                            "x1": float(rect["x1"]),
                            "bottom": float(rect["bottom"]),
                        })

            for line_words in lines:
                line_text = " ".join(w["text"] for w in line_words)
                line_top = min(float(w["top"]) for w in line_words)
                line_bottom = max(float(w["bottom"]) for w in line_words)

                # Check for label patterns
                is_label = False
                label_text = line_text.strip()
                confidence = "low"

                for pattern in LABEL_PATTERNS:
                    m = pattern.match(line_text)
                    if m:
                        label_text = m.group(1).strip()
                        is_label = True
                        confidence = "high"
                        break

                if not is_label and line_text.strip().endswith(":"):
                    label_text = line_text.strip().rstrip(":")
                    is_label = True
                    confidence = "high"

                if not is_label:
                    # Check if there's a large gap after the text (inline fill area)
                    last_word = line_words[-1]
                    text_end = float(last_word["x1"])
                    if text_end < page_width * 0.5:
                        # Text ends in the left half -- potential label with fill to the right
                        is_label = True
                        confidence = "medium"

                if not is_label:
                    continue

                # Determine where the label ends
                label_x0 = min(float(w["x0"]) for w in line_words)
                label_x1 = max(float(w["x1"]) for w in line_words)

                label_rect = {
                    "x0": round(label_x0, 1),
                    "top": round(line_top, 1),
                    "x1": round(label_x1, 1),
                    "bottom": round(line_bottom, 1),
                }

                # Estimate fill region
                fill_rect = None

                # Check for a horizontal line near this label
                for hl in h_lines:
                    if abs(hl["y"] - line_bottom) < 15 and hl["x0"] >= label_x1 - 5:
                        fill_rect = {
                            "x0": round(hl["x0"], 1),
                            "top": round(line_top, 1),
                            "x1": round(hl["x1"], 1),
                            "bottom": round(line_bottom, 1),
                        }
                        confidence = "high"
                        break

                # Check for a rectangle near this label
                if fill_rect is None:
                    for r in rects:
                        if abs(r["top"] - line_top) < 10 and r["x0"] >= label_x1 - 5:
                            fill_rect = {
                                "x0": round(r["x0"], 1),
                                "top": round(r["top"], 1),
                                "x1": round(r["x1"], 1),
                                "bottom": round(r["bottom"], 1),
                            }
                            confidence = "high"
                            break

                # Fallback: assume fill area is to the right of the label
                if fill_rect is None:
                    fill_rect = {
                        "x0": round(label_x1 + 5, 1),
                        "top": round(line_top, 1),
                        "x1": round(min(label_x1 + 250, page_width - 36), 1),
                        "bottom": round(line_bottom, 1),
                    }

                # Convert from pdfplumber coords (top-left origin) to PDF coords (bottom-left origin)
                pdf_fill_rect = {
                    "x0": fill_rect["x0"],
                    "y0": round(page_height - fill_rect["bottom"], 1),
                    "x1": fill_rect["x1"],
                    "y1": round(page_height - fill_rect["top"], 1),
                }

                results.append({
                    "label": label_text,
                    "label_rect_plumber": label_rect,
                    "fill_rect_plumber": fill_rect,
                    "fill_rect_pdf": pdf_fill_rect,
                    "page": page_idx,
                    "confidence": confidence,
                })

    return results


def _group_into_lines(words: list[dict], y_tolerance: float = 5) -> list[list[dict]]:
    """Group words into lines based on vertical position."""
    if not words:
        return []

    sorted_words = sorted(words, key=lambda w: (float(w["top"]), float(w["x0"])))
    lines = []
    current_line = [sorted_words[0]]

    for word in sorted_words[1:]:
        if abs(float(word["top"]) - float(current_line[0]["top"])) <= y_tolerance:
            current_line.append(word)
        else:
            lines.append(sorted(current_line, key=lambda w: float(w["x0"])))
            current_line = [word]

    if current_line:
        lines.append(sorted(current_line, key=lambda w: float(w["x0"])))

    return lines


def main():
    parser = argparse.ArgumentParser(
        description="Extract form structure from a non-fillable PDF"
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument("-o", "--output", help="Output JSON file (default: stdout)")
    parser.add_argument("--page", type=int, default=None, help="Specific page (1-based). Default: all pages.")
    args = parser.parse_args()

    page_idx = (args.page - 1) if args.page is not None else None

    try:
        structure = extract_structure(args.pdf, page_num=page_idx)
    except Exception as e:
        print(f"Error analyzing PDF: {e}", file=sys.stderr)
        sys.exit(1)

    output = json.dumps(structure, indent=2, ensure_ascii=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Found {len(structure)} potential form region(s). Written to {args.output}")
        print("Note: These positions are heuristic. Verify with a rendered image.")
    else:
        print(output)


if __name__ == "__main__":
    main()
