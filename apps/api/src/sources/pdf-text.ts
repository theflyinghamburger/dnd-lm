/**
 * Per-page text out of a campaign PDF (P4.1.2, FR-602 partial: text and page
 * references only — no tables, boxed text or images).
 *
 * Kept in its own file with nothing but `unpdf` and the Nest exception type, so
 * the CJS/ESM dual-bundle risk stays in one place: vitest resolves unpdf's
 * `import` condition (`dist/index.mjs`) while the Nest build resolves `require`
 * (`dist/index.cjs`) — **different bundles**, so a green vitest run does not
 * prove the built path. `pdf-text.test.ts` also runs this file's compiled output
 * from `dist/` through Node's own `require` for that.
 *
 * Never call unpdf's `renderPageAsImage`: it is the one function that needs the
 * native `@napi-rs/canvas`, which this design excludes. OCR (FR-603) is out, so
 * a source with no text layer is refused by name instead.
 */
import { UnprocessableEntityException } from '@nestjs/common';

export type PdfText = {
  totalPages: number;
  /** `pages[i]` is page `i + 1` — the number P4.1.3 cites in `frontmatter.source.pages`. */
  pages: string[];
};

/**
 * ponytail: a flat chars-per-page threshold, not layout analysis. Raise it if a
 * sparse-but-real map appendix ever trips it.
 */
const MIN_CHARS_PER_PAGE = 50;

export async function readPdf(buffer: Uint8Array): Promise<PdfText> {
  // Lazy, as in `characters/pdf-form.ts`: under the CommonJS build this compiles
  // to a `require`, so unpdf is only loaded by the path that reads a PDF.
  const { getDocumentProxy, extractText } = await import('unpdf');

  let result: { totalPages: number; text: string[] };
  try {
    // A copy, not a view: pdf.js detaches the buffer it is given, and the caller
    // keeps the original to re-run extraction later (FR-611).
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    result = await extractText(pdf, { mergePages: false });
    // A well-formed `/Count 0` document parses fine, and `0 < 0 * 50` would let
    // it through as an empty success. Nothing to read is unreadable.
    if (result.totalPages < 1) throw new Error('no pages');
  } catch {
    throw new UnprocessableEntityException({
      code: 'PDF_UNREADABLE',
      message: 'That PDF could not be read. It may be corrupt or password-protected.',
    });
  }

  const { totalPages, text: pages } = result;
  // Whitespace is not text: a scan's "text layer" can be nothing but line breaks.
  const chars = pages.reduce((sum, page) => sum + page.replace(/\s/g, '').length, 0);
  if (chars < totalPages * MIN_CHARS_PER_PAGE) {
    throw new UnprocessableEntityException({
      code: 'PDF_HAS_NO_TEXT_LAYER',
      message:
        `This PDF has almost no selectable text (${chars} characters across ${totalPages} ` +
        `page${totalPages === 1 ? '' : 's'}), so it is probably a scan. ` +
        'Scanned PDFs need OCR, which is not supported yet.',
      totalPages,
      chars,
    });
  }
  return { totalPages, pages };
}
