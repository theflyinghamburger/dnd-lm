import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M7.6's exit criterion, automated: "No DOM node anywhere on either surface
 * renders the stored key (grep the components for the key binding: only
 * `last4` appears)."
 *
 * A source scan rather than a rendering test, deliberately. The claim is about
 * what the code *can* do, not about one rendered state — and it needs no DOM
 * library to make, which keeps the web app's dependency list where it is.
 */
const SRC = import.meta.dirname;

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')
      ? [{ path, text: readFileSync(path, 'utf8') }]
      : [];
  });
}

describe('provider keys are write-only in the web app (M7.6, NFR-305)', () => {
  const files = sources(SRC);

  it('scans the whole web source tree', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((f) => f.path)).toContain(join(SRC, 'AdminProviders.tsx'));
  });

  it('never reads a key off a connection object', () => {
    // `.apiKeyLast4` does not match: the word boundary requires the property to
    // end at `apiKey`. What would match is `connection.apiKey`, which is the
    // binding that must never exist — no response this app receives has one.
    for (const file of files) {
      expect({ file: file.path, hit: /\.apiKey\b/.test(file.text) }).toEqual({
        file: file.path,
        hit: false,
      });
    }
  });

  it('displays the key as last4 and nothing else', () => {
    const admin = files.find((f) => f.path.endsWith('AdminProviders.tsx'))!.text;
    expect(admin).toContain('apiKeyLast4');
    expect(admin).toContain('••••');
  });

  it('offers no reveal affordance, and never sends a key over a GET', () => {
    const admin = files.find((f) => f.path.endsWith('AdminProviders.tsx'))!.text;
    // Every key input is a password field: there is no "show" toggle to build
    // a reveal on top of.
    for (const name of ['newKey', 'replacement']) {
      const input = new RegExp(`name="${name}"[^>]*type="password"`, 's');
      expect(input.test(admin)).toBe(true);
    }
    expect(admin).not.toMatch(/type="text"[^>]*name="(newKey|replacement)"/s);
    expect(admin).not.toMatch(/show(Key|Secret|Password)/i);
  });

  /**
   * M7-FU2 (#45). Not a rendering claim -- there is still no DOM library here,
   * by M7.6's decision. This is the narrower structural one the scan can make:
   * a failed read has somewhere to be shown on both surfaces. What it cannot
   * check is that the element renders, which is stated plainly in the change
   * doc rather than implied by a green test.
   */
  it('gives a failed query somewhere to surface, on both surfaces', () => {
    for (const name of ['AdminProviders.tsx', 'CampaignSettings.tsx']) {
      const text = files.find((f) => f.path.endsWith(name))!.text;
      expect({ name, renders: /connections\.error/.test(text) }).toEqual({ name, renders: true });
    }
    // The empty-state hint must not double as the error state: gating it on a
    // length check alone makes a failed read look like an empty list.
    const settings = files.find((f) => f.path.endsWith('CampaignSettings.tsx'))!.text;
    expect(settings).toContain('connections.isSuccess');
  });

  it('sends a key only to the two write endpoints that take one', () => {
    for (const file of files) {
      if (file.path.endsWith('api.ts')) continue;
      // Components pass the value; only the client names the field, and only
      // on create and replace.
      expect({ file: file.path, hit: /apiKey:/.test(file.text) }).toEqual({
        file: file.path,
        hit: file.path.endsWith('AdminProviders.tsx'),
      });
    }
    const client = files.find((f) => f.path.endsWith('api.ts'))!.text;
    expect(client.match(/apiKey/g)?.length).toBe(2);
  });
});
