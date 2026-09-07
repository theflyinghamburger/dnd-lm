import { type CharacterSheet } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { LAYER_BUDGET, buildContextPackage, estimateTokens, type DmReadOnly } from './context';

const sheet: CharacterSheet = {
  classes: [{ name: 'Fighter', level: 3 }],
  abilityScores: { str: 18, dex: 10, con: 14, int: 8, wis: 10, cha: 12 },
  skillProficiencies: ['athletics'],
  saveProficiencies: [],
  maxHp: 32,
  currentHp: 26,
  armorClass: 18,
  speed: 30,
  inventory: [],
  currency: { cp: 0, sp: 0, gp: 0, pp: 0 },
  attacks: [],
  spells: [],
};

const reader: DmReadOnly = {
  characters: async () => [{ id: 'c1', name: 'Aria', sheet }],
  campaignSettings: async () => ({ items: ['torch'], notes: ['The temple is cold and quiet.'] }),
  currentScene: async () => 'the crypt',
  unresolvedAction: async () => null,
  recentPublicMessages: async () =>
    Array.from({ length: 10 }, (_, i) => ({
      sender: `P${i}`,
      content: 'line' + 'x'.repeat(100),
      channel: 'in_character',
    })),
};

const arg = (over: Partial<Parameters<typeof buildContextPackage>[0]> = {}) => ({
  profile: 'resolve_action',
  campaignId: 'camp',
  sessionId: 'sess',
  triggerText: 'Aria picks the lock',
  triggerKind: 'dm_mention',
  entityId: null,
  stateVersion: 7,
  reader,
  system: 'You are the Dungeon Master.',
  ...over,
});

describe('buildContextPackage', () => {
  it('assembles the ordered layers with per-layer token counts', async () => {
    const pkg = await buildContextPackage(arg());
    expect(pkg.prompt.indexOf('## Current state')).toBeLessThan(
      pkg.prompt.indexOf('## Campaign notes'),
    );
    expect(pkg.prompt.indexOf('## Campaign notes')).toBeLessThan(
      pkg.prompt.indexOf('## Recent table talk'),
    );
    expect(pkg.prompt).toContain('State version: 7.');
    expect(pkg.prompt).toContain("Resolve the players' action: Aria picks the lock");
    expect(pkg.prompt).toContain('UNTRUSTED CAMPAIGN DATA');
    expect(pkg.system).toBe('You are the Dungeon Master.');
    expect(pkg.layerTokens).toEqual(
      expect.objectContaining({
        contract: expect.any(Number),
        state: expect.any(Number),
        notes: expect.any(Number),
        transcript: expect.any(Number),
      }),
    );
  });

  it('never carries notes in a recap, and tells the recap to stay prose', async () => {
    const pkg = await buildContextPackage(arg({ profile: 'recap', triggerKind: 'recap_command' }));
    expect(pkg.prompt).not.toContain('Campaign notes');
    expect(pkg.prompt).toContain('prose only');
    expect(pkg.prompt).toContain('The host has asked for a recap');
  });
});

describe('transcript trimming', () => {
  it('drops the oldest lines first until the transcript fits the leftover budget', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      sender: `P${i}`,
      content: `line${i}` + 'x'.repeat(500),
      channel: 'in_character' as const,
    }));
    const pkg = await buildContextPackage(
      arg({ reader: { ...reader, recentPublicMessages: async () => many } }),
    );
    expect(pkg.prompt).toContain('line119');
    // 120 lines at ~125 tokens far exceed the 12000-token prompt ceiling;
    // the cut keeps the newest and drops from the bottom up.
    expect(pkg.prompt.indexOf('line0')).toBe(-1);
  });
});

describe('estimateTokens', () => {
  it('is chars/4, rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

/**
 * M4.7 follow-up. Fixed layers used to record `Math.min(estimate, budget)` while
 * pushing the *untruncated* string, so a big sheet overran `prompt_total` while
 * telemetry reported compliance (FR-701, NFR-502). These assert the rendered
 * text, which is the thing that was wrong — an assertion on `layerTokens` alone
 * would have passed against the old code.
 */
describe('state layer budget', () => {
  const wizard = (spellCount: number): CharacterSheet => ({
    ...sheet,
    classes: [{ name: 'Wizard', level: 7 }],
    race: 'Custom Lineage',
    background: 'Guild Artisan',
    senses: 'Darkvision 60 ft.',
    attacks: [{ name: 'Longsword', attackBonus: 1, damage: '1d8-2 Slashing' }],
    spells: Array.from({ length: spellCount }, (_, i) => ({
      name: `Prestidigitation Variant Number ${i}`,
      level: (i % 9) as 0,
      prepared: i % 5 === 0,
      source: 'Wizard',
      castingTime: '1A',
      range: '120 ft.',
      components: 'V,S,M',
      duration: 'Concentration, up to 1 minute',
      notes: 'V/S/M',
    })),
  });

  const withCharacters = (chars: Array<{ id: string; name: string; sheet: CharacterSheet }>) => ({
    ...reader,
    characters: async () => chars,
  });

  const stateBlock = (prompt: string) => {
    const start = prompt.indexOf('## Current state');
    const next = prompt.indexOf('\n## ', start + 1);
    return prompt.slice(start, next === -1 ? undefined : next).trimEnd();
  };

  it('shows attacks and prepared spells when they fit', async () => {
    const pkg = await buildContextPackage(
      arg({ reader: withCharacters([{ id: 'c1', name: 'Nim', sheet: wizard(6) }]) }),
    );
    expect(pkg.prompt).toContain('attacks: Longsword +1 (1d8-2 Slashing)');
    expect(pkg.prompt).toContain('spells ready:');
    expect(pkg.prompt).toContain('Custom Lineage, Guild Artisan');
  });

  it('shows the real example sheet at full detail — 95 spells still fit', async () => {
    const pkg = await buildContextPackage(
      arg({ reader: withCharacters([{ id: 'c1', name: 'Nim', sheet: wizard(95) }]) }),
    );
    // Listing only cantrips and prepared spells is what keeps this small.
    expect(pkg.prompt).toContain('spells ready:');
    expect(pkg.prompt).toMatch(/more known but not prepared/);
    expect(estimateTokens(stateBlock(pkg.prompt))).toBeLessThanOrEqual(LAYER_BUDGET.state);
  });

  /**
   * A table big enough that even the trimmed full tier does not fit. This is the
   * case the old code got wrong: it pushed the whole string and merely *recorded*
   * a capped count, so the prompt overran while telemetry looked clean.
   */
  it('falls back to the core tier rather than overrunning the budget', async () => {
    const everythingPrepared = (n: number): CharacterSheet => ({
      ...wizard(n),
      spells: Array.from({ length: n }, (_, i) => ({
        name: `Otiluke's Irresistible Resilient Spherical Incantation ${i}`,
        level: 3 as const,
        prepared: true,
      })),
    });
    const table = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: `Caster ${i}`,
      sheet: everythingPrepared(120),
    }));

    const pkg = await buildContextPackage(arg({ reader: withCharacters(table) }));

    // The rendered text, not the recorded count — the old code passed any
    // assertion made against `layerTokens`.
    expect(estimateTokens(stateBlock(pkg.prompt))).toBeLessThanOrEqual(LAYER_BUDGET.state);
    expect(estimateTokens(pkg.prompt)).toBeLessThanOrEqual(LAYER_BUDGET.prompt_total);
    // Core facts survive the fallback; the spell lists are what went.
    expect(pkg.prompt).toContain('Caster 0 — Wizard 7');
    expect(pkg.prompt).toContain('HP 26/32');
    expect(pkg.prompt).not.toContain('Irresistible');
  });
});

/**
 * The tier fallback handles a big character; this is the case behind it — a
 * table whose *core* rendering alone exceeds the budget. Without the hard
 * ceiling the fallback would push an untruncated string and record a capped
 * count, which is the original defect at a higher threshold.
 */
describe('state layer budget, past the tier fallback', () => {
  it('never pushes more than it records, even when core does not fit', async () => {
    const hoarder: CharacterSheet = {
      ...sheet,
      inventory: Array.from({ length: 200 }, (_, i) => ({
        name: `Ornate Reliquary of the Seventh Dawn, item number ${i}`,
        quantity: 1,
        equipped: false,
      })),
    };
    const table = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: `Hoarder ${i}`,
      sheet: hoarder,
    }));

    const pkg = await buildContextPackage(
      arg({ reader: { ...reader, characters: async () => table } }),
    );
    const start = pkg.prompt.indexOf('## Current state');
    const next = pkg.prompt.indexOf('\n## ', start + 1);
    const block = pkg.prompt.slice(start, next === -1 ? undefined : next).trimEnd();

    expect(estimateTokens(block)).toBeLessThanOrEqual(LAYER_BUDGET.state);
    expect(pkg.layerTokens.state).toBeLessThanOrEqual(LAYER_BUDGET.state);
    // The recorded count must describe the text that was actually sent.
    expect(pkg.layerTokens.state).toBeGreaterThanOrEqual(estimateTokens(block) - 1);
    expect(block).toContain('state truncated to its budget');
  });
});
