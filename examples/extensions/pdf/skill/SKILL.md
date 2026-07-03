---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files -- reading, extracting text/tables, merging, splitting, rotating, watermarking, creating, filling forms, encrypting/decrypting, extracting images, OCR, or converting to images. Activate when a .pdf file is mentioned or PDF output is requested.
---

# PDF Processing Skill

Process PDF files using open-source tools. This guide is organized by task -- find what you need to do, get working code.

## Decision Tree -- Pick the Right Tool

```
What do you need to do?
|
+- READ text from a PDF
|  +- Simple text extraction ----------> pypdf  (fast, pure Python)
|  +- Text with layout/positions ------> pdfplumber  (preserves spatial info)
|  +- Tables from PDF -----------------> pdfplumber  (best table extraction)
|  +- Scanned PDF (image-based) -------> pytesseract + pdf2image  (OCR)
|  +- CLI one-liner --------------------> pdftotext  (poppler)
|
+- CREATE a new PDF from scratch ------> reportlab
|
+- MODIFY an existing PDF
|  +- Merge multiple PDFs --------------> pypdf
|  +- Split into pages -----------------> pypdf
|  +- Rotate pages ---------------------> pypdf
|  +- Add watermark --------------------> pypdf (overlay)
|  +- Encrypt / decrypt ----------------> pypdf or qpdf (CLI)
|  +- Fill form fields -----------------> pypdf (fillable) or reportlab (non-fillable)
|
+- EXTRACT from a PDF
|  +- Images ---------------------------> pypdfium2 or pdfimages (CLI)
|  +- Metadata -------------------------> pypdf
|
+- CONVERT
   +- PDF to images --------------------> pdf2image or pypdfium2
   +- Images to PDF --------------------> reportlab or pypdf
```

## Decision Rules

Follow these rules to pick the right approach for ambiguous tasks:

1. **IF the user wants to extract text** -> Use pypdf or pdfplumber first. If the result is empty or garbled, the PDF is likely scanned -> fall back to the OCR workflow (Section 10).

2. **IF the user wants to fill a form** -> First run `check_fillable_fields.py` to detect if the PDF has fillable fields.
   - If fillable fields exist -> use the fillable workflow (pypdf)
   - If no fillable fields -> use the annotation-based workflow (reportlab overlay)
   - See `forms.md` for the complete decision tree.

3. **IF the user wants to merge PDFs** -> Use pypdf for simple merges. Use `qpdf` CLI if you need fine-grained page selection (e.g., specific page ranges from multiple files).

4. **IF the user wants to encrypt** -> Use pypdf for AES-256 encryption. Use `qpdf` CLI for quick password protection from the command line.

5. **IF the user wants images from a PDF** -> Use pypdfium2 for high-quality page renders. Use `pdfimages` CLI to extract embedded images without re-encoding.

6. **IF the user wants to create a PDF** -> Use reportlab. For simple text documents, use the Canvas API. For complex reports with automatic layout, use Platypus (SimpleDocTemplate + Paragraphs).

## Available Libraries

All pre-installed in the container:

| Library | Purpose |
|---|---|
| `pypdf` | Read, merge, split, rotate, encrypt, fill forms |
| `pdfplumber` | Extract text with layout, tables |
| `pypdfium2` | Fast rendering to images, text extraction |
| `reportlab` | Create PDFs from scratch, draw text/shapes/images |
| `pytesseract` | OCR (requires tesseract-ocr system package) |
| `pdf2image` | Convert PDF pages to PIL images (requires poppler) |
| `Pillow` | Image processing |

CLI tools: `qpdf`, `pdftotext`, `pdfimages` (poppler-utils), `tesseract`

---

## 1. Read / Extract Text

### Simple text extraction with pypdf

```python
from pypdf import PdfReader

reader = PdfReader("input.pdf")
for page in reader.pages:
    text = page.extract_text()
    print(text)
```

### Extract text with layout using pdfplumber

```python
import pdfplumber

with pdfplumber.open("input.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

### Extract tables with pdfplumber

```python
import pdfplumber

with pdfplumber.open("input.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                print(row)
```

Export a table to CSV:

```python
import pdfplumber
import csv

with pdfplumber.open("input.pdf") as pdf:
    page = pdf.pages[0]  # first page
    table = page.extract_tables()[0]  # first table

    with open("output.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(table)
```

### CLI text extraction

```bash
# Plain text
pdftotext input.pdf output.txt

# Preserve layout
pdftotext -layout input.pdf output.txt

# Extract specific pages
pdftotext -f 2 -l 5 input.pdf output.txt

# To stdout
pdftotext input.pdf -
```

---

## 2. Merge PDFs

```python
from pypdf import PdfWriter

writer = PdfWriter()

# Add entire PDFs
for pdf_path in ["file1.pdf", "file2.pdf", "file3.pdf"]:
    writer.append(pdf_path)

writer.write("outbox/merged.pdf")
writer.close()
```

Merge specific page ranges:

```python
from pypdf import PdfWriter

writer = PdfWriter()
writer.append("file1.pdf", pages=(0, 5))    # pages 1-5
writer.append("file2.pdf", pages=(2, 4))    # pages 3-4
writer.write("outbox/merged.pdf")
writer.close()
```

---

## 3. Split PDFs

### Split into individual pages

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    writer.write(f"outbox/page_{i + 1}.pdf")
    writer.close()
```

### Split into chunks

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
chunk_size = 10

for start in range(0, len(reader.pages), chunk_size):
    writer = PdfWriter()
    end = min(start + chunk_size, len(reader.pages))
    for page in reader.pages[start:end]:
        writer.add_page(page)
    writer.write(f"outbox/chunk_{start // chunk_size + 1}.pdf")
    writer.close()
```

---

## 4. Rotate Pages

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.rotate(90)   # 90, 180, or 270 degrees clockwise
    writer.add_page(page)

writer.write("outbox/rotated.pdf")
writer.close()
```

Rotate only specific pages:

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

pages_to_rotate = [0, 2, 4]  # 0-indexed

for i, page in enumerate(reader.pages):
    if i in pages_to_rotate:
        page.rotate(90)
    writer.add_page(page)

writer.write("outbox/rotated.pdf")
writer.close()
```

---

## 5. Add Watermark

```python
from pypdf import PdfReader, PdfWriter

# The watermark must be a single-page PDF (create one with reportlab if needed)
stamp_reader = PdfReader("watermark.pdf")
stamp_page = stamp_reader.pages[0]

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(stamp_page)
    writer.add_page(page)

writer.write("outbox/watermarked.pdf")
writer.close()
```

### Create a watermark PDF with reportlab

```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.colors import Color

c = canvas.Canvas("watermark.pdf", pagesize=letter)
width, height = letter

c.saveState()
c.translate(width / 2, height / 2)
c.rotate(45)
c.setFillColor(Color(0.8, 0.8, 0.8, alpha=0.3))
c.setFont("Helvetica-Bold", 60)
c.drawCentredString(0, 0, "CONFIDENTIAL")
c.restoreState()
c.save()
```

---

## 6. Create PDFs from Scratch (reportlab)

```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.units import inch

c = canvas.Canvas("outbox/new.pdf", pagesize=letter)
width, height = letter

# Text
c.setFont("Helvetica-Bold", 24)
c.drawString(1 * inch, height - 1 * inch, "Report Title")

c.setFont("Helvetica", 12)
c.drawString(1 * inch, height - 1.5 * inch, "Generated automatically.")

# Line
c.setStrokeColorRGB(0, 0, 0)
c.line(1 * inch, height - 1.7 * inch, width - 1 * inch, height - 1.7 * inch)

# Rectangle
c.setFillColorRGB(0.9, 0.9, 1.0)
c.rect(1 * inch, height - 4 * inch, 4 * inch, 2 * inch, fill=True)

# New page
c.showPage()
c.setFont("Helvetica", 12)
c.drawString(1 * inch, height - 1 * inch, "Page 2 content here.")

c.save()
```

### Multi-line text with automatic wrapping

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("outbox/report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

story.append(Paragraph("Report Title", styles["Title"]))
story.append(Spacer(1, 0.25 * inch))

body_text = """This is a paragraph that will automatically wrap to fit the page width.
It supports <b>bold</b>, <i>italic</i>, and other basic HTML-like formatting."""
story.append(Paragraph(body_text, styles["BodyText"]))

doc.build(story)
```

### Pitfall: Unicode subscripts and superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (such as the subscript digits) in ReportLab PDFs. The built-in fonts (Helvetica, Times-Roman, Courier) do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:

```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# Subscripts: use <sub> tag
chemical = Paragraph("H<sub>2</sub>O", styles["Normal"])

# Superscripts: use <super> tag
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles["Normal"])
```

For canvas-drawn text (not Paragraph objects), manually adjust the font size and position rather than using Unicode subscript/superscript characters.

### Pitfall: Unicode text beyond Latin-1

ReportLab's built-in fonts (Helvetica, Times-Roman, Courier) do NOT support Unicode characters beyond Latin-1. For Unicode text (CJK, Cyrillic, Arabic, mathematical symbols), you must register a TrueType font:

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
c.setFont("DejaVu", 12)
c.drawString(100, 700, "Unicode text here")
```

---

## 7. Fill PDF Forms

This is a complex topic. Read `forms.md` for the full guide.

### Quick: fill a simple fillable PDF

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("form.pdf")
writer = PdfWriter()
writer.append(reader)

# Get field names
fields = reader.get_fields()
for name, field in fields.items():
    print(f"Field: {name}, Type: {field.get('/FT')}")

# Fill fields
writer.update_page_form_field_values(
    writer.pages[0],
    {"first_name": "Alice", "last_name": "Smith", "email": "alice@example.com"},
    auto_regenerate=False,
)

writer.write("outbox/filled.pdf")
writer.close()
```

### Helper scripts

The `scripts/` directory contains Python helpers for form processing:

| Script | Purpose |
|---|---|
| `check_fillable_fields.py` | Detect if a PDF has fillable form fields |
| `extract_form_field_info.py` | Extract field metadata to JSON |
| `fill_fillable_fields.py` | Fill fillable fields from a JSON mapping |
| `check_bounding_boxes.py` | Visualize field positions on the PDF |
| `convert_pdf_to_images.py` | Render PDF pages to images |
| `create_validation_image.py` | Overlay showing filled values |
| `extract_form_structure.py` | Extract structure from non-fillable PDFs |
| `fill_pdf_form_with_annotations.py` | Fill non-fillable PDFs using annotations |

Run any script with `python3 scripts/<name>.py --help` for usage.

---

## 8. Encrypt / Decrypt PDFs

### Encrypt with pypdf

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()
writer.append(reader)

# User password (to open) + owner password (to edit)
writer.encrypt(
    user_password="readpass",
    owner_password="ownerpass",
    algorithm="AES-256",
)

writer.write("outbox/encrypted.pdf")
writer.close()
```

### Decrypt with pypdf

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("encrypted.pdf")
if reader.is_encrypted:
    reader.decrypt("readpass")

writer = PdfWriter()
writer.append(reader)
writer.write("outbox/decrypted.pdf")
writer.close()
```

### CLI with qpdf

```bash
# Encrypt
qpdf --encrypt userpass ownerpass 256 -- input.pdf encrypted.pdf

# Decrypt
qpdf --decrypt --password=ownerpass encrypted.pdf decrypted.pdf

# Linearize (optimize for web)
qpdf --linearize input.pdf optimized.pdf
```

---

## 9. Extract Images

### With pypdfium2

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("input.pdf")

for page_index in range(len(pdf)):
    page = pdf[page_index]
    for obj_index, obj in enumerate(page.get_objects()):
        if obj.type == pdfium.FPDF_PAGEOBJ_IMAGE:
            bitmap = obj.get_bitmap()
            pil_image = bitmap.to_pil()
            pil_image.save(f"outbox/image_p{page_index + 1}_{obj_index}.png")
```

### CLI with pdfimages

```bash
# Extract all images as PNG
pdfimages -png input.pdf outbox/prefix

# Extract as original format
pdfimages -all input.pdf outbox/prefix

# List images without extracting
pdfimages -list input.pdf
```

---

## 10. OCR Scanned PDFs

### Detection: is this PDF scanned?

If text extraction returns empty or garbled results, the PDF is likely scanned. Fall back to OCR.

```python
from pdf2image import convert_from_path
import pytesseract

# Convert PDF pages to images
images = convert_from_path("scanned.pdf", dpi=300)

# OCR each page
full_text = []
for i, image in enumerate(images):
    text = pytesseract.image_to_string(image)
    full_text.append(text)
    print(f"--- Page {i + 1} ---")
    print(text)

# Save to file
with open("outbox/ocr_output.txt", "w") as f:
    f.write("\n\n".join(full_text))
```

### OCR to searchable PDF

```python
from pdf2image import convert_from_path
import pytesseract

images = convert_from_path("scanned.pdf", dpi=300)

# Create searchable PDF from first page
pdf_bytes = pytesseract.image_to_pdf_or_hocr(images[0], extension="pdf")
with open("outbox/searchable.pdf", "wb") as f:
    f.write(pdf_bytes)
```

**Tip**: OCR quality depends heavily on image resolution. Always render at 300 DPI minimum. For poor-quality scans, try 600 DPI.

---

## 11. Convert PDF Pages to Images

### With pdf2image (poppler-based)

```python
from pdf2image import convert_from_path

# All pages
images = convert_from_path("input.pdf", dpi=200)
for i, img in enumerate(images):
    img.save(f"outbox/page_{i + 1}.png", "PNG")

# Specific pages
images = convert_from_path("input.pdf", dpi=200, first_page=2, last_page=5)
```

### With pypdfium2 (no poppler needed)

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("input.pdf")

for i in range(len(pdf)):
    page = pdf[i]
    bitmap = page.render(scale=2)  # 2x = ~144 DPI
    pil_image = bitmap.to_pil()
    pil_image.save(f"outbox/page_{i + 1}.png")
```

### With the helper script

```bash
python3 scripts/convert_pdf_to_images.py input.pdf -o outbox/ --dpi 200
```

---

## 12. Get PDF Metadata

```python
from pypdf import PdfReader

reader = PdfReader("input.pdf")

meta = reader.metadata
print(f"Title:    {meta.title}")
print(f"Author:   {meta.author}")
print(f"Subject:  {meta.subject}")
print(f"Creator:  {meta.creator}")
print(f"Producer: {meta.producer}")
print(f"Pages:    {len(reader.pages)}")

# Page dimensions
page = reader.pages[0]
box = page.mediabox
print(f"Size:     {float(box.width)} x {float(box.height)} points")
```

---

## Common Patterns

### Process many PDFs in a directory

```python
from pathlib import Path
from pypdf import PdfReader

pdf_dir = Path("inbox")
for pdf_path in sorted(pdf_dir.glob("*.pdf")):
    reader = PdfReader(pdf_path)
    text = reader.pages[0].extract_text()
    print(f"{pdf_path.name}: {text[:100]}...")
```

### Error handling

```python
from pypdf import PdfReader
from pypdf.errors import PdfReadError

try:
    reader = PdfReader("input.pdf")
    if reader.is_encrypted:
        reader.decrypt("password")
    text = reader.pages[0].extract_text()
except PdfReadError as e:
    print(f"Invalid or corrupted PDF: {e}")
except Exception as e:
    print(f"Error processing PDF: {e}")
```

### Working with the outbox

Always write output files to the `outbox/` directory so users can download them:

```python
import os
os.makedirs("outbox", exist_ok=True)
writer.write("outbox/result.pdf")
```

---

## Error Handling Guide

When a PDF operation fails, follow these steps:

1. **"Cannot open file" / encrypted error** -> PDF is encrypted. Ask the user for the password, then use `reader.decrypt(password)`.

2. **Empty text extraction** -> PDF is scanned/image-based. Switch to the OCR workflow (Section 10).

3. **"Cannot find font" in ReportLab** -> Register a TrueType font before use. See Section 6 pitfalls.

4. **Corrupted PDF** -> Try `qpdf --check input.pdf` first. Then `qpdf input.pdf --replace-input` to attempt repair.

5. **"No form fields found"** -> PDF uses static layout, not AcroForm. Use the annotation-based filling workflow (see forms.md, non-fillable section).

6. **Large PDF slow to process** -> Process pages in batches. Use `qpdf --pages . 1-50 --` to extract chunks. Use pypdfium2 instead of pdf2image for rendering -- it is significantly faster.

7. **Image extraction returns 0 images** -> Images may be in-lined in content streams. Try `pdfimages -all` CLI tool instead.

8. **Field values not visible after filling** -> Set `auto_regenerate=False` when calling `update_page_form_field_values`. Some PDF viewers cache field appearances. Try flattening: `qpdf --flatten-annotations=all filled.pdf output.pdf`.
