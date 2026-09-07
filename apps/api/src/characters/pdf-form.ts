/**
 * Reading form fields out of a PDF (M4.7 — character import from PDF).
 *
 * The whole of this file's job is to turn PDF bytes into a flat list of filled
 * widget annotations. It knows nothing about D&D; `wotc-sheet.ts` owns the
 * mapping and is pure, so the interesting logic is testable without a PDF.
 *
 * Why annotations and not a form API: the sheets D&D Beyond exports carry 1981
 * widget annotations but **no `/AcroForm` entry in the document catalogue**.
 * Every library helper that starts from `catalog.AcroForm.Fields` — pdf-lib's
 * `getForm()`, pdf.js's `getFieldObjects()` — therefore returns nothing at all
 * on exactly the files this feature exists to read. Walking each page's
 * annotations is the path that works, and it is also the one that gives us the
 * page number and rectangle the spell-level grouping needs.
 */
import { UnprocessableEntityException } from '@nestjs/common';

/** One filled form field: its name, its value, and where it sits on the page. */
export type PdfFormField = {
  name: string;
  value: string;
  page: number;
  /** PDF user space: origin bottom-left, so a larger `y` is higher up the page. */
  x: number;
  y: number;
};

/** The magic bytes. The declared MIME type comes from the client and proves nothing. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

/**
 * A widget's value can arrive as a string, an array (multi-select), or a name
 * object. Everything downstream compares trimmed strings, so normalise here.
 */
function readValue(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((part) => typeof part === 'string').join(', ');
  if (raw == null || typeof raw === 'object') return '';
  return String(raw);
}

/**
 * Field names in the shipped sheet are inconsistent about whitespace —
 * `"CLASS  LEVEL"` has two spaces, `"DEXmod "` and `"Wpn3 AtkBonus  "` have
 * trailing ones. Collapsing runs of whitespace here means the mapping table
 * gets to spell each name once, the obvious way.
 */
function normaliseName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

export async function readPdfFormFields(bytes: Uint8Array): Promise<PdfFormField[]> {
  if (!looksLikePdf(bytes)) {
    throw new UnprocessableEntityException({
      code: 'NOT_A_PDF',
      message: 'That file is not a PDF.',
    });
  }

  // Imported lazily: `unpdf` is ESM-only in its `import` condition, and this
  // module is reachable from Nest's CommonJS build. A dynamic import is the
  // one form that resolves correctly under both.
  const { getDocumentProxy } = await import('unpdf');

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch {
    // Any parse failure is the same answer to the host: we cannot read it.
    throw new UnprocessableEntityException({
      code: 'PDF_UNREADABLE',
      message: 'That PDF could not be read. It may be corrupt or password-protected.',
    });
  }

  const fields: PdfFormField[] = [];
  for (let page = 1; page <= pdf.numPages; page += 1) {
    const annotations = (await (await pdf.getPage(page)).getAnnotations()) as Array<{
      subtype?: string;
      fieldName?: string;
      fieldValue?: unknown;
      rect?: number[];
    }>;

    for (const annotation of annotations) {
      if (annotation.subtype !== 'Widget' || !annotation.fieldName) continue;
      const value = readValue(annotation.fieldValue).trim();
      if (value === '') continue;
      const rect = annotation.rect ?? [0, 0, 0, 0];
      fields.push({
        name: normaliseName(annotation.fieldName),
        value,
        page,
        x: rect[0] ?? 0,
        // The top edge, so that sorting by descending `y` reads down the page.
        y: rect[3] ?? 0,
      });
    }
  }

  return fields;
}
