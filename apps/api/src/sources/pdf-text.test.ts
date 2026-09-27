import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPdf } from './pdf-text';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'fixtures/source-pdfs', name));
const TEXT = fixture('two-page-text.pdf');
const SCAN = fixture('image-only.pdf');

/** The thrown exception's body, so a test can assert the named code. */
async function refusal(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = (await promise.then(
    () => expect.fail('expected a refusal'),
    (caught: unknown) => caught,
  )) as { getStatus(): number; getResponse(): Record<string, unknown> };
  expect(error.getStatus()).toBe(422);
  return error.getResponse();
}

function suite(read: typeof readPdf) {
  it('returns one string per page, attributed to the right page', async () => {
    const { totalPages, pages } = await read(TEXT);
    expect(totalPages).toBe(2);
    expect(pages).toHaveLength(totalPages);
    expect(pages[1]).toContain('Klarg the bugbear');
    expect(pages[0]).not.toContain('Klarg');
    expect(pages[0]).toContain('Triboar Trail');
  });

  it('refuses an image-only PDF as PDF_HAS_NO_TEXT_LAYER, saying why', async () => {
    const body = await refusal(read(SCAN));
    expect(body).toMatchObject({ code: 'PDF_HAS_NO_TEXT_LAYER', totalPages: 1, chars: 0 });
    expect(body.message).toMatch(/OCR/);
  });

  it('fails a truncated or corrupt PDF with an error, not empty pages', async () => {
    // Cut mid-object (not just the trailer, which pdf.js recovers from losslessly).
    const broken = [
      TEXT.subarray(0, 400),
      TEXT.subarray(0, TEXT.length - 200),
      Buffer.from('%PDF-1.4 nope'),
      Buffer.alloc(0),
    ];
    for (const bytes of broken) {
      expect(await refusal(read(bytes))).toMatchObject({ code: 'PDF_UNREADABLE' });
    }
  });

  it('refuses a well-formed PDF with zero pages instead of returning nothing', async () => {
    expect(await refusal(read(fixture('zero-pages.pdf')))).toMatchObject({
      code: 'PDF_UNREADABLE',
    });
  });

  // pdf.js detaches the ArrayBuffer it is handed (byteLength 0 afterwards);
  // P4.1.1 keeps the original bytes to re-run extraction (FR-611).
  it('leaves the caller’s buffer intact', async () => {
    const copy = Buffer.from(TEXT);
    await read(copy);
    expect(copy.equals(TEXT)).toBe(true);
  });
}

describe('readPdf (source, vitest resolves unpdf’s `import` bundle)', () => suite(readPdf));

/**
 * The Nest build resolves unpdf's `require` bundle, a different file, so the
 * source-level suite above proves nothing about production. Node's own
 * `require` on the compiled output does. CI builds before it tests; locally,
 * run `pnpm build` first or this skips (CI fails instead of skipping).
 */
const DIST = join(process.cwd(), 'apps/api/dist/sources/pdf-text.js');
describe.skipIf(!existsSync(DIST) && !process.env.CI)('readPdf (built dist/, CommonJS)', () => {
  const built = () => (createRequire(DIST)(DIST) as { readPdf: typeof readPdf }).readPdf;
  suite((bytes) => built()(bytes));
});
