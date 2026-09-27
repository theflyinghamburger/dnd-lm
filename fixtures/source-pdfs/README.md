# Campaign source PDFs

Test inputs for `readPdf` (`apps/api/src/sources/pdf-text.ts`, P4.1.2). Both are
hand-built, uncompressed PDF 1.4, so `cat` shows exactly what is in them.

- `two-page-text.pdf` — two pages of Helvetica text. "Klarg the bugbear" is on
  page 2 only, which is what the page-attribution test looks for.
- `image-only.pdf` — one page that paints a 2×2 grey image and has no text
  operators at all: the shape of a scan, for the `PDF_HAS_NO_TEXT_LAYER` refusal.
- `zero-pages.pdf` — well-formed, `/Count 0`: must be refused, not read as empty.

The `xref` byte offsets are exact. Editing a file by hand breaks them; pdf.js
recovers by re-indexing, but then the fixture no longer tests a well-formed PDF.
