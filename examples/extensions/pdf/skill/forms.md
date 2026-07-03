# PDF Form Filling Guide

This guide covers filling PDF forms, both fillable (AcroForm) and non-fillable PDFs.

## Overview

There are two categories of PDF forms:

1. **Fillable PDFs** (AcroForm/XFA) -- contain interactive form fields. Users can click and type into fields. These are straightforward to fill programmatically.
2. **Non-fillable PDFs** -- just text and lines rendered as page content, with no interactive fields. Filling these requires overlaying text at precise coordinates using annotations or drawing.

## Workflow Summary

```
Start
|
+- Run check_fillable_fields.py
|  |
|  +- Has fields -> Fillable path
|  |  +- extract_form_field_info.py  -> get field names and types
|  |  +- check_bounding_boxes.py     -> visualize field positions
|  |  +- fill_fillable_fields.py     -> fill from JSON mapping
|  |  +- create_validation_image.py  -> verify the result visually
|  |
|  +- No fields -> Non-fillable path
|     +- convert_pdf_to_images.py    -> render pages for visual inspection
|     +- extract_form_structure.py   -> detect text labels and guess field positions
|     +- fill_pdf_form_with_annotations.py -> overlay text using annotations
|     +- create_validation_image.py  -> verify the result visually
```

---

## Part 1: Fillable PDF Forms

### Step 1: Detect fillable fields

```bash
python3 scripts/check_fillable_fields.py input.pdf
```

This reports whether the PDF has AcroForm fields, lists their names, types, and current values.

### Step 2: Extract field metadata

```bash
python3 scripts/extract_form_field_info.py input.pdf -o outbox/fields.json
```

Produces a JSON file with all field details:

```json
[
  {
    "name": "first_name",
    "type": "/Tx",
    "value": "",
    "rect": [72.0, 700.0, 250.0, 720.0],
    "page": 0,
    "flags": 0,
    "read_only": false,
    "required": false,
    "options": null
  }
]
```

Field types:
- `/Tx` -- text field
- `/Btn` -- button (checkbox, radio)
- `/Ch` -- choice (dropdown, list)
- `/Sig` -- signature

### Step 3: Visualize field positions

```bash
python3 scripts/check_bounding_boxes.py input.pdf -o outbox/fields_overlay.png
```

Renders each page with colored rectangles showing where fields are, labeled with field names. Use this to verify fields map to the right visual locations before filling.

### Step 4: Fill the form

Create a JSON file mapping field names to values:

```json
{
  "first_name": "Alice",
  "last_name": "Smith",
  "email": "alice@example.com",
  "agree_terms": true,
  "country": "Canada"
}
```

Then fill:

```bash
python3 scripts/fill_fillable_fields.py input.pdf values.json -o outbox/filled.pdf
```

For checkboxes, use `true`/`false`. For radio buttons, use the export value string. For dropdowns, use the option text.

### Step 5: Validate the result

```bash
python3 scripts/create_validation_image.py outbox/filled.pdf -o outbox/validation.png
```

Renders the filled PDF to an image. Visually inspect it to confirm all values appear correctly.

### Inline code (without scripts)

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("form.pdf")
writer = PdfWriter()
writer.append(reader)

# Fill fields on page 0
writer.update_page_form_field_values(
    writer.pages[0],
    {
        "first_name": "Alice",
        "last_name": "Smith",
        "date": "2025-01-15",
    },
    auto_regenerate=False,
)

writer.write("outbox/filled.pdf")
writer.close()
```

**Important**: Always set `auto_regenerate=False`. The default `True` can corrupt field appearances in some PDFs.

### Handling checkboxes

Checkboxes use specific values. To check a box, you need its "on" value:

```python
from pypdf import PdfReader

reader = PdfReader("form.pdf")
fields = reader.get_fields()

for name, field in fields.items():
    if field.get("/FT") == "/Btn":
        # The /AP dict contains the appearance states
        widget = field.get("/Kids", [field])
        print(f"Checkbox '{name}': possible values = {field.get('/V')}")
```

Typically checkboxes accept `/Yes` to check and `/Off` to uncheck:

```python
writer.update_page_form_field_values(
    writer.pages[0],
    {"agree_terms": "/Yes"},
    auto_regenerate=False,
)
```

### Flattening forms

After filling, you may want to flatten the form so fields become static text (non-editable):

```bash
# Using qpdf (recommended)
qpdf --flatten-annotations=all filled.pdf flattened.pdf
```

### Common pitfalls with fillable forms

1. **Field names with dots**: Some PDFs use hierarchical names like `form1.page1.FirstName`. Always use the FULL qualified name from the extraction output.

2. **Checkbox export values**: Checkboxes have an "export value" (often "Yes", "1", or "On"). Setting `true` maps to `/Yes`. Check the `extract_form_field_info.py` output to see the actual export value.

3. **Read-only fields**: Fields with the read-only flag (bit 1 of /Ff) cannot be filled. The script will warn about these.

4. **Appearance streams**: Some PDF viewers won't display values without proper appearance streams (/AP). If the filled PDF looks empty in a viewer, try flattening with qpdf.

5. **Font embedding**: If the original form uses a custom font, filled values may render in a fallback font. For non-ASCII text, consider the reportlab overlay approach where you control the font.

---

## Part 2: Non-Fillable PDF Forms

Non-fillable PDFs have no interactive fields. To "fill" them, you overlay text at specific coordinates using PDF annotations or by drawing on a separate layer and merging it.

### Strategy

1. Render the PDF to an image to see exactly where fields should be filled.
2. Identify the coordinates of blank areas where values need to go.
3. Use a reportlab overlay (default method, best compatibility) or FreeText annotations.

### Step 1: Render to image for inspection

```bash
python3 scripts/convert_pdf_to_images.py input.pdf -o outbox/ --dpi 200
```

Open the resulting images to visually identify where to place text.

### Step 2: Extract form structure (heuristic)

```bash
python3 scripts/extract_form_structure.py input.pdf -o outbox/structure.json
```

This script uses pdfplumber to detect text labels and underlines/boxes, then heuristically guesses where fillable regions might be. The output is approximate -- always verify with the rendered image.

The output includes both pdfplumber coordinates (top-left origin) and PDF coordinates (bottom-left origin) for each detected region.

### Step 3: Define fill positions

Create a JSON file specifying what to write and where:

```json
[
  {
    "page": 0,
    "fields": [
      {
        "x": 200,
        "y": 705,
        "value": "Alice Smith",
        "font_size": 11
      },
      {
        "x": 200,
        "y": 680,
        "value": "alice@example.com",
        "font_size": 11
      }
    ]
  }
]
```

Coordinates are in PDF points (1 point = 1/72 inch). Origin is bottom-left of the page.

### Step 4: Fill using overlay (default method)

```bash
python3 scripts/fill_pdf_form_with_annotations.py input.pdf fill_spec.json -o outbox/filled.pdf
```

This creates a transparent overlay with reportlab and merges it onto the original PDF. The original content is preserved underneath.

To use FreeText annotations instead (original content completely untouched):

```bash
python3 scripts/fill_pdf_form_with_annotations.py input.pdf fill_spec.json -o outbox/filled.pdf --method annot
```

### Alternative: manual overlay with reportlab

For full control over the overlay:

```python
import io
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

# Create overlay
packet = io.BytesIO()
c = canvas.Canvas(packet, pagesize=letter)
c.setFont("Helvetica", 11)
c.drawString(200, 705, "Alice Smith")
c.drawString(200, 680, "alice@example.com")
c.save()
packet.seek(0)

# Merge overlay onto original
original = PdfReader("input.pdf")
overlay = PdfReader(packet)

writer = PdfWriter()
page = original.pages[0]
page.merge_page(overlay.pages[0])
writer.add_page(page)

# Copy remaining pages unchanged
for p in original.pages[1:]:
    writer.add_page(p)

writer.write("outbox/filled.pdf")
writer.close()
```

### Step 5: Validate

```bash
python3 scripts/create_validation_image.py outbox/filled.pdf -o outbox/validation.png
```

Always visually inspect the result. Coordinates often need fine-tuning.

### Common pitfalls with non-fillable forms

1. **Coordinate mismatch**: The most common error. PDF Y-axis is bottom-up (origin at bottom-left), but screen/image Y-axis is top-down. Always convert:
   ```
   pdf_x = pixel_x * 72 / dpi
   pdf_y = page_height_points - (pixel_y * 72 / dpi)
   ```

2. **Page rotation**: If a page is rotated (e.g., 90 degrees), the coordinate system rotates too. Check `page.mediabox` and `page.rotation` and adjust.

3. **Different page sizes**: Not all pages in a PDF have the same dimensions. Always check each page's mediabox.

4. **Font metrics**: Characters have different widths. If you need to center text in a box, use `stringWidth()` from ReportLab:
   ```python
   from reportlab.pdfbase.pdfmetrics import stringWidth
   w = stringWidth("Jane Doe", "Helvetica", 10)
   x = box_x + (box_width - w) / 2  # centered x position
   ```

5. **Overlapping with existing content**: If the form has lines or boxes, your text might overlap. Adjust the Y coordinate by 2-3 points upward from the line.

6. **Checkbox simulation**: For non-fillable checkboxes, overlay "X" or a checkmark character at the checkbox coordinates.

---

## Troubleshooting

### Field values not visible after filling

- Set `auto_regenerate=False` when calling `update_page_form_field_values`.
- Some PDF viewers cache field appearances. Try opening in a different viewer.
- Flatten the form with qpdf to force rendering: `qpdf --flatten-annotations=all filled.pdf output.pdf`

### Wrong font or encoding in filled fields

- pypdf uses the font already defined in the field. If the original font does not support your characters, the text may appear garbled.
- For non-ASCII text, consider the reportlab overlay approach where you control the font.

### Coordinates are wrong for non-fillable forms

- PDF coordinate origin is bottom-left, not top-left.
- To convert from pixel coordinates (in a rendered image) to PDF points:
  ```
  pdf_x = pixel_x * 72 / dpi
  pdf_y = page_height_points - (pixel_y * 72 / dpi)
  ```
- Use `check_bounding_boxes.py` or render the page to an image and measure pixel positions.

### Large PDFs are slow

- Use pypdfium2 instead of pdf2image for rendering -- it is significantly faster.
- Process only the pages you need rather than the entire document.
