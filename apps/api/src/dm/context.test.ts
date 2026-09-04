import { type CharacterSheet } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { buildContextPackage, estimateTokens, type DmReadOnly } from './context';

const sheet: CharacterSheet = {
  className: 'Fighter',
  level: 3,
  abilityScores: { str: 18, dex: 10, con: 14, int: 8, wis: 10, cha: 12 },
  skillProficiencies: ['athletics'],
  saveProficiencies: [],
  maxHp: 32,
  currentHp: 26,
  armorClass: 18,
  speed: 30,
  inventory: [],
  currency: { cp: 0, sp: 0, gp: 0, pp: 0 },
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
