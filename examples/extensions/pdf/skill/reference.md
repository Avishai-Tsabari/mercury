# PDF Advanced Reference

Extended reference for less common operations, advanced techniques, and CLI tool details.

## pypdf -- Advanced Usage

### Cloning with modifications

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

# Clone all pages
writer.clone_document_from_reader(reader)

# Modify metadata
writer.add_metadata({
    "/Author": "Mercury Agent",
    "/Title": "Processed Document",
    "/Subject": "Automated processing",
})

writer.write("outbox/output.pdf")
writer.close()
```

### Cropping pages

```python
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject

reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]

# Crop to a specific region (in points, from bottom-left)
# RectangleObject(left, bottom, right, top)
page.cropbox = RectangleObject([72, 72, 400, 700])

writer.add_page(page)
writer.write("outbox/cropped.pdf")
writer.close()
```

### Extracting links and annotations

```python
from pypdf import PdfReader

reader = PdfReader("input.pdf")
for page in reader.pages:
    if "/Annots" in page:
        for annot in page["/Annots"]:
            obj = annot.get_object()
            if obj.get("/Subtype") == "/Link":
                action = obj.get("/A")
                if action and "/URI" in action:
                    print(f"URL: {action['/URI']}")
```

### Removing pages

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

pages_to_remove = {2, 5, 7}  # 0-indexed

for i, page in enumerate(reader.pages):
    if i not in pages_to_remove:
        writer.add_page(page)

writer.write("outbox/trimmed.pdf")
writer.close()
```

### Overlay / Stamp (Multi-Layer Merge)

```python
from pypdf import PdfReader, PdfWriter

base = PdfReader("base.pdf")
stamp = PdfReader("stamp.pdf")
writer = PdfWriter()

for page in base.pages:
    page.merge_page(stamp.pages[0])  # Stamp page 1 onto every page
    writer.add_page(page)

writer.write("outbox/stamped.pdf")
writer.close()
```

---

## pdfplumber -- Advanced Usage

### Extracting text from specific regions

```python
import pdfplumber

with pdfplumber.open("input.pdf") as pdf:
    page = pdf.pages[0]

    # Crop to a region (x0, top, x1, bottom) -- note: top-left origin
    region = page.within_bbox((50, 100, 400, 300))
    text = region.extract_text()
    print(text)
```

### Table extraction with custom settings

```python
import pdfplumber

with pdfplumber.open("input.pdf") as pdf:
    page = pdf.pages[0]

    table_settings = {
        "vertical_strategy": "text",
        "horizontal_strategy": "lines",
        "min_words_vertical": 3,
        "min_words_horizontal": 1,
    }

    tables = page.extract_tables(table_settings)
    for table in tables:
        for row in table:
            print(row)
```

### Getting character-level data

```python
import pdfplumber

with pdfplumber.open("input.pdf") as pdf:
    page = pdf.pages[0]

    for char in page.chars:
        print(f"'{char['text']}' at ({char['x0']:.1f}, {char['top']:.1f}) "
              f"font={char['fontname']} size={char['size']:.1f}")
```

---

## reportlab -- Advanced Usage

### Drawing tables

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
from reportlab.lib import colors

doc = SimpleDocTemplate("outbox/table.pdf", pagesize=letter)

data = [
    ["Name", "Age", "City"],
    ["Alice", "30", "Toronto"],
    ["Bob", "25", "Vancouver"],
    ["Carol", "35", "Montreal"],
]

table = Table(data, colWidths=[2 * inch, 1 * inch, 2 * inch])
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4472C4")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTSIZE", (0, 0), (-1, -1), 11),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("ALIGN", (1, 1), (1, -1), "CENTER"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#D9E2F3")]),
]))

doc.build([table])
```

### Adding page numbers and headers

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

def add_page_number(canvas_obj, doc):
    canvas_obj.saveState()
    canvas_obj.setFont("Helvetica", 9)
    page_num = canvas_obj.getPageNumber()
    text = f"Page {page_num}"
    canvas_obj.drawRightString(7.5 * inch, 0.5 * inch, text)
    # Header
    canvas_obj.drawString(1 * inch, 10.5 * inch, "My Report")
    canvas_obj.line(1 * inch, 10.45 * inch, 7.5 * inch, 10.45 * inch)
    canvas_obj.restoreState()

doc = SimpleDocTemplate("outbox/report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

for i in range(5):
    story.append(Paragraph(f"Content for page {i + 1}", styles["BodyText"]))
    story.append(PageBreak())

doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
```

### Drawing shapes and diagrams

```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor

c = canvas.Canvas("outbox/shapes.pdf", pagesize=letter)
w, h = letter

# Rounded rectangle
c.setFillColor(HexColor("#E8F0FE"))
c.setStrokeColor(HexColor("#4472C4"))
c.roundRect(1 * inch, h - 3 * inch, 3 * inch, 1.5 * inch, 10, fill=True)

# Circle
c.setFillColor(HexColor("#FCE4EC"))
c.circle(5.5 * inch, h - 2.25 * inch, 0.75 * inch, fill=True)

# Arrow (as a line with a polygon head)
c.setStrokeColor(HexColor("#333333"))
c.setLineWidth(2)
c.line(4.2 * inch, h - 2.25 * inch, 4.6 * inch, h - 2.25 * inch)

c.save()
```

---

## Advanced Techniques

### Redaction (requires pymupdf)

To permanently remove content from a PDF, pymupdf (fitz) provides a redaction API. Install with `pip install pymupdf`.

```python
import fitz

doc = fitz.open("input.pdf")
for page in doc:
    for rect in page.search_for("CONFIDENTIAL"):
        page.add_redact_annot(rect, fill=(0, 0, 0))
    page.apply_redactions()
doc.save("outbox/redacted.pdf")
doc.close()
```

**Warning**: `apply_redactions()` permanently removes the underlying content. This is irreversible. Always work on a copy.

### Adding Bookmarks / Table of Contents (requires pymupdf)

```python
import fitz

doc = fitz.open("input.pdf")

# Read existing TOC
toc = doc.get_toc()  # list of [level, title, page_number]

# Set new TOC
new_toc = [
    [1, "Chapter 1", 1],
    [2, "Section 1.1", 1],
    [2, "Section 1.2", 3],
    [1, "Chapter 2", 5],
]
doc.set_toc(new_toc)

doc.save("outbox/with_bookmarks.pdf")
doc.close()
```

### Text Search and Highlight (requires pymupdf)

```python
import fitz

doc = fitz.open("input.pdf")
for page in doc:
    matches = page.search_for("search term")
    for rect in matches:
        page.add_highlight_annot(rect)
doc.save("outbox/highlighted.pdf")
doc.close()
```

### Creating Searchable PDFs from Scans

For multi-page scanned PDFs, use `ocrmypdf` (install with `pip install ocrmypdf`):

```bash
ocrmypdf scanned.pdf searchable.pdf
```

For single pages, use pytesseract directly:

```python
from pdf2image import convert_from_path
import pytesseract

images = convert_from_path("scanned.pdf", dpi=300)
pdf_bytes = pytesseract.image_to_pdf_or_hocr(images[0], extension="pdf")
with open("outbox/searchable_page.pdf", "wb") as f:
    f.write(pdf_bytes)
```

---

## CLI Tools Reference

### qpdf

```bash
# Merge
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split every page
qpdf input.pdf --split-pages output_%d.pdf

# Extract pages 3-7
qpdf input.pdf --pages . 3-7 -- extracted.pdf

# Extract complex ranges
qpdf input.pdf --pages . 1,3-5,8,10-end -- extracted.pdf

# Rotate page 1 by 90 degrees
qpdf input.pdf --rotate=+90:1 rotated.pdf

# Rotate all pages
qpdf input.pdf --rotate=+90 -- rotated.pdf

# Linearize for fast web display
qpdf --linearize input.pdf optimized.pdf

# Check/repair
qpdf --check input.pdf
qpdf input.pdf --replace-input  # repair in place

# Encrypt AES-256
qpdf --encrypt userpass ownerpass 256 -- input.pdf encrypted.pdf

# Encrypt with restricted permissions
qpdf --encrypt user_pass owner_pass 256 --print=none --modify=none -- input.pdf encrypted.pdf

# Decrypt
qpdf --decrypt --password=pass encrypted.pdf decrypted.pdf

# Check encryption status
qpdf --show-encryption encrypted.pdf

# Flatten annotations (bake form values)
qpdf --flatten-annotations=all input.pdf flattened.pdf

# Remove restrictions (if no encryption)
qpdf --decrypt input.pdf unrestricted.pdf
```

### pdftotext (poppler)

```bash
# Basic extraction
pdftotext input.pdf output.txt

# Preserve layout
pdftotext -layout input.pdf output.txt

# Page range
pdftotext -f 2 -l 10 input.pdf output.txt

# Output to stdout
pdftotext input.pdf -

# HTML output
pdftotext -htmlmeta input.pdf output.html

# Encoding
pdftotext -enc UTF-8 input.pdf output.txt

# Extract with bounding box coordinates (XML)
pdftotext -bbox-layout input.pdf output.xml
```

### pdfimages (poppler)

```bash
# Extract as PNG
pdfimages -png input.pdf outdir/prefix

# Extract in original format
pdfimages -all input.pdf outdir/prefix

# List images (no extraction)
pdfimages -list input.pdf

# Specific page range
pdfimages -f 1 -l 5 -png input.pdf outdir/prefix
```

### tesseract (OCR)

```bash
# Basic OCR
tesseract image.png output_base  # produces output_base.txt

# Specify language
tesseract image.png output_base -l eng+fra

# Output formats
tesseract image.png output_base pdf      # searchable PDF
tesseract image.png output_base hocr     # HTML with coordinates
tesseract image.png output_base tsv      # tab-separated values

# Page segmentation modes (--psm)
# 3 = fully automatic (default)
# 6 = assume uniform block of text
# 7 = single text line
# 8 = single word
tesseract image.png output_base --psm 6

# List available languages
tesseract --list-langs
```

### pdftoppm (poppler -- image conversion)

```bash
# Convert to PNG at 300 DPI
pdftoppm -png -r 300 input.pdf output_prefix

# Convert specific pages
pdftoppm -png -r 300 -f 1 -l 3 input.pdf output_prefix

# Convert to JPEG with quality setting
pdftoppm -jpeg -jpegopt quality=85 -r 200 input.pdf output_prefix
```

---

## Batch Processing

### Process many PDFs in parallel

```python
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor
from pypdf import PdfReader

def extract_text(pdf_path: str) -> tuple[str, str]:
    reader = PdfReader(pdf_path)
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return pdf_path, text

pdf_files = list(Path("inbox").glob("*.pdf"))

with ProcessPoolExecutor(max_workers=4) as executor:
    results = executor.map(extract_text, [str(p) for p in pdf_files])
    for path, text in results:
        print(f"{path}: {len(text)} chars")
```

### Batch processing with error handling

```python
from pathlib import Path
from pypdf import PdfReader, PdfWriter

def process_pdfs(input_dir, output_dir, operation):
    """Apply an operation to all PDFs in a directory."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    for pdf_path in sorted(Path(input_dir).glob("*.pdf")):
        try:
            reader = PdfReader(str(pdf_path))
            operation(reader, pdf_path, output_dir)
            print(f"OK: {pdf_path.name}")
        except Exception as e:
            print(f"FAIL: {pdf_path.name}: {e}")
```

---

## Performance Tips

### Choose the right rendering library

| Task | Use | Why |
|---|---|---|
| Render to image | pypdfium2 | 5-10x faster than pdf2image, no poppler dependency |
| Render many pages | pypdfium2 | Lower memory, C-based |
| Need exact poppler compat | pdf2image | Wraps poppler's pdftoppm |

### Memory efficiency for large PDFs

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("large.pdf")

# Process pages one at a time instead of loading all
for i in range(len(reader.pages)):
    writer = PdfWriter()
    writer.add_page(reader.pages[i])

    text = reader.pages[i].extract_text()
    # process text...

    writer.close()  # free memory
```

### Compress PDF with Ghostscript

```bash
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
   -dNOPAUSE -dBATCH -sOutputFile=compressed.pdf input.pdf
```

Settings: `/screen` (72dpi), `/ebook` (150dpi), `/printer` (300dpi), `/prepress` (300dpi, color-preserving).

### Repair damaged PDFs

```bash
qpdf --replace-input damaged.pdf        # In-place repair
qpdf damaged.pdf repaired.pdf           # qpdf fixes many structural issues automatically
gs -o repaired.pdf -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress damaged.pdf  # Ghostscript rewrite
```

---

## Coordinate Systems

PDF coordinates can be confusing. Key facts:

- **PDF native**: origin at bottom-left, Y increases upward. Units are points (1 pt = 1/72 inch).
- **pdfplumber**: origin at top-left, Y increases downward (like screen coordinates). Uses the same point scale.
- **Rendered images**: origin at top-left, Y increases downward. Units are pixels. Conversion: `pdf_points = pixels * 72 / dpi`.

### Converting between systems

```python
def image_coords_to_pdf(pixel_x, pixel_y, page_height_pts, dpi):
    """Convert rendered image pixel coordinates to PDF coordinates."""
    pdf_x = pixel_x * 72.0 / dpi
    pdf_y = page_height_pts - (pixel_y * 72.0 / dpi)
    return pdf_x, pdf_y

def pdf_coords_to_image(pdf_x, pdf_y, page_height_pts, dpi):
    """Convert PDF coordinates to rendered image pixel coordinates."""
    pixel_x = pdf_x * dpi / 72.0
    pixel_y = (page_height_pts - pdf_y) * dpi / 72.0
    return pixel_x, pixel_y
```

---

## Library License Information

| Library | License |
|---|---|
| pypdf | BSD |
| pdfplumber | MIT |
| pypdfium2 | Apache/BSD |
| reportlab | BSD |
| pytesseract | Apache-2.0 |
| Pillow | MIT-like (HPND) |
| poppler-utils | GPL-2 |
| qpdf | Apache |
