import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * Builds a minimal form-fillable PDF: one page, one widget annotation per field.
 *
 * It carries **no `/AcroForm` entry**, which is the point — that is exactly how
 * the sheets D&D Beyond exports are shaped, and it is what makes every
 * form-field helper that starts at the catalogue come back empty. A fixture that
 * declared an AcroForm would pass while the real files failed.
 */
function sheetPdf(fields: Array<{ name: string; value: string; x?: number; y: number }>): Buffer {
  const escape = (text: string) => text.replace(/([\\()])/g, '\\$1');
  const widgetIds = fields.map((_, index) => 4 + index);
  const objects: string[] = [];
  objects[1] = '<</Type/Catalog/Pages 2 0 R>>';
  objects[2] = '<</Type/Pages/Count 1/Kids[3 0 R]>>';
  objects[3] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Annots[${widgetIds
    .map((id) => `${id} 0 R`)
    .join(' ')}]>>`;
  fields.forEach((field, index) => {
    const x = field.x ?? 40;
    objects[widgetIds[index] as number] =
      `<</Type/Annot/Subtype/Widget/FT/Tx/T(${escape(field.name)})/V(${escape(field.value)})` +
      `/Rect[${x} ${field.y - 12} ${x + 180} ${field.y}]/F 4>>`;
  });

  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A complete level-3 fighter, plus one spell banner so the grouping is exercised. */
const FIGHTER = sheetPdf([
  { name: 'CharacterName', value: 'Test Dummy', y: 700 },
  { name: 'CLASS  LEVEL', value: 'Fighter 3', y: 690 },
  { name: 'STR', value: '16', y: 680 },
  { name: 'DEX', value: '14', y: 670 },
  { name: 'CON', value: '15', y: 660 },
  { name: 'INT', value: '10', y: 650 },
  { name: 'WIS', value: '12', y: 640 },
  { name: 'CHA', value: '8', y: 630 },
  { name: 'StrProf', value: '•', y: 620 },
  { name: 'AthleticsProf', value: 'P', y: 610 },
  { name: 'MaxHP', value: '28', y: 600 },
  { name: 'AC', value: '17', y: 590 },
  { name: 'Speed', value: '30 ft. (Walking)', y: 580 },
  { name: 'ProfBonus', value: '+2', y: 570 },
  { name: 'GP', value: '12', y: 560 },
  { name: 'Eq Name0', value: 'Greataxe', y: 550 },
  { name: 'Eq Qty0', value: '1', y: 540 },
  { name: 'RACE', value: 'Dwarf', y: 530 },
  { name: 'spellHeader0', value: '=== 1st LEVEL ===', y: 520 },
  { name: 'spellName0', value: 'Shield of Faith', y: 510 },
  { name: 'spellPrepared0', value: 'P', y: 510 },
]);

/** The same fighter, but with a proficiency bonus that contradicts "Fighter 3". */
const LYING_LEVEL = sheetPdf([
  { name: 'CharacterName', value: 'Test Dummy', y: 700 },
  { name: 'CLASS  LEVEL', value: 'Fighter 3', y: 690 },
  { name: 'STR', value: '16', y: 680 },
  { name: 'DEX', value: '14', y: 670 },
  { name: 'CON', value: '15', y: 660 },
  { name: 'INT', value: '10', y: 650 },
  { name: 'WIS', value: '12', y: 640 },
  { name: 'CHA', value: '8', y: 630 },
  { name: 'MaxHP', value: '28', y: 600 },
  { name: 'AC', value: '17', y: 590 },
  { name: 'ProfBonus', value: '+5', y: 570 },
]);

describe.skipIf(!DATABASE_URL)('character import from PDF (M4.7)', () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0]! : (cookie as unknown as string);
  }

  async function campaignFor(cookie: string): Promise<string> {
    const res = await api()
      .post('/api/campaigns')
      .set('Cookie', cookie)
      .send({ name: 'Lost Mine' })
      .expect(201);
    return res.body.id as string;
  }

  it('creates a character from an uploaded sheet and derives its numbers', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .attach('file', FIGHTER, { filename: 'sheet.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(res.body.character.name).toBe('Test Dummy');
    expect(res.body.character.sheet.classes).toEqual([{ name: 'Fighter', level: 3 }]);
    expect(res.body.character.sheet.spells).toEqual([
      expect.objectContaining({ name: 'Shield of Faith', level: 1, prepared: true }),
    ]);
    // Derived server-side from the sheet, never read out of the file (D-3).
    expect(res.body.character.derived).toMatchObject({
      level: 3,
      className: 'Fighter 3',
      proficiencyBonus: 2,
      currentHp: 28,
    });
    expect(res.body.character.derived.saveModifiers.str).toBe(5); // +3 STR, +2 proficient
    expect(res.body.character.sheet.race).toBe('Dwarf');

    // It is a real character, so the roster the lobby reads now has it.
    const list = await api()
      .get(`/api/campaigns/${campaignId}/characters`)
      .set('Cookie', host)
      .expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('refuses a file that is not a PDF, on its bytes rather than its name', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .attach('file', Buffer.from('not a pdf at all'), {
        filename: 'sheet.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
    expect(res.body.code).toBe('NOT_A_PDF');
  });

  it('refuses a PDF that carries no character-sheet fields', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .attach('file', sheetPdf([{ name: 'Some Other Form', value: 'x', y: 700 }]), {
        filename: 'sheet.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
    expect(res.body.code).toBe('NOT_A_CHARACTER_SHEET');
  });

  /**
   * The sheet's own proficiency bonus is the check on our class-line parse.
   * Importing at the wrong level would skew every roll the character makes.
   */
  it('refuses a sheet whose level contradicts its proficiency bonus', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .attach('file', LYING_LEVEL, { filename: 'sheet.pdf', contentType: 'application/pdf' })
      .expect(422);
    expect(res.body.code).toBe('LEVEL_MISMATCH');
  });

  /**
   * The way past the refusal echoes back the level it was shown, so a client
   * cannot get through by blindly retrying — someone has to have read the number.
   */
  it('imports the mismatching sheet when the caller confirms the parsed level', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const refusal = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .attach('file', LYING_LEVEL, { filename: 'sheet.pdf', contentType: 'application/pdf' })
      .expect(422);
    // The override button reads `code` and `parsedLevel` off this body
    // (`ApiError.code` comes from `body.code`), so their names are a contract.
    expect(refusal.body).toMatchObject({
      code: 'LEVEL_MISMATCH',
      parsedLevel: 3,
      statedBonus: 5,
      derivedBonus: 2,
    });

    const confirmed = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf?confirmLevel=3`)
      .set('Cookie', host)
      .attach('file', LYING_LEVEL, { filename: 'sheet.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(confirmed.body.character.derived.level).toBe(3);
  });

  it('still refuses when the confirmed level is not the one it parsed', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf?confirmLevel=9`)
      .set('Cookie', host)
      .attach('file', LYING_LEVEL, { filename: 'sheet.pdf', contentType: 'application/pdf' })
      .expect(422);
  });

  /**
   * The 8 MB ceiling had no failing-if-broken test: raising or removing
   * `limits.fileSize` would have passed CI. Multer refuses before the body is
   * materialised, so nothing is parsed and no character is written.
   */
  it('refuses a file past the size ceiling before parsing it', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(9 * 1024 * 1024, 0x20),
    ]);

    const res = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .attach('file', oversized, { filename: 'huge.pdf', contentType: 'application/pdf' });

    // 413 specifically, not merely "a 4xx": without the limit these bytes reach
    // the parser and come back 422 PDF_UNREADABLE, which a looser assertion
    // would have accepted.
    expect(res.status).toBe(413);
    const list = await api()
      .get(`/api/campaigns/${campaignId}/characters`)
      .set('Cookie', host)
      .expect(200);
    expect(list.body).toHaveLength(0);
  });

  /**
   * Past the magic bytes but not a readable document. This was the only refusal
   * on the route with no test behind it, and it covers both catch layers —
   * `getDocumentProxy` and the page loop.
   */
  it('refuses a file that starts like a PDF but is not one', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .attach('file', Buffer.from('%PDF-1.7\nnot actually a document at all\n'), {
        filename: 'sheet.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
    expect(res.body.code).toBe('PDF_UNREADABLE');
  });

  it('requires a file', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);
    await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', host)
      .expect(400);
  });

  it('refuses someone who is not a member of the campaign', async () => {
    const host = await signUp('host@example.com');
    const stranger = await signUp('stranger@example.com');
    const campaignId = await campaignFor(host);

    await api()
      .post(`/api/campaigns/${campaignId}/characters/import-pdf`)
      .set('Cookie', stranger)
      .attach('file', FIGHTER, { filename: 'sheet.pdf', contentType: 'application/pdf' })
      .expect(403);
  });
});
