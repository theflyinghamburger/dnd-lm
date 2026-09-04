import { type CharacterSheet } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { type DmCharacterState } from './context';
import {
  executeReadTool,
  renderRollResult,
  validateRollRequest,
  type ReadToolWorld,
} from './tools';

const sheet: CharacterSheet = {
  className: 'Fighter',
  level: 3,
  abilityScores: { str: 18, dex: 10, con: 14, int: 8, wis: 10, cha: 12 },
  skillProficiencies: ['athletics'],
  saveProficiencies: ['str', 'con'],
  maxHp: 32,
  currentHp: 26,
  armorClass: 18,
  speed: 30,
  inventory: [{ name: 'longsword', quantity: 1, equipped: true }],
  currency: { cp: 0, sp: 0, gp: 7, pp: 0 },
};

const character: DmCharacterState = { id: 'c1', name: 'Aria', sheet };
const world: ReadToolWorld = {
  characters: [character],
  settings: { items: ['torch'], notes: ['The temple is cold and quiet.'] },
};

describe('executeReadTool', () => {
  it('renders a character summary from the read handle, not the database', () => {
    const result = executeReadTool('get_character_summary', { character_id: 'c1' }, world);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('Aria — Fighter level 3');
    expect(result.content).toContain('HP 26/32');
  });

  it('answers unknown ids and bad arguments as refusals, never throws', () => {
    expect(executeReadTool('get_character_summary', { character_id: 'nope' }, world).ok).toBe(
      false,
    );
    expect(executeReadTool('get_character_summary', {}, world).content).toContain('Refused');
  });

  it('wraps campaign notes as untrusted data', () => {
    const hit = executeReadTool('search_campaign_notes', { query: 'temple' }, world);
    expect(hit.ok).toBe(true);
    expect(hit.content).toContain('untrusted data');
    expect(hit.content).toContain('The temple is cold and quiet.');
    expect(executeReadTool('search_campaign_notes', { query: 'ocean' }, world).content).toContain(
      'No campaign notes match',
    );
  });

  it('answers from the SRD subset and refuses to guess outside it', () => {
    expect(executeReadTool('lookup_rule', { topic: 'athletics' }, world).content).toContain(
      'Athletics uses str',
    );
    expect(executeReadTool('lookup_rule', { topic: 'proficiency bonus' }, world).content).toContain(
      '+2 at level 1',
    );
    expect(executeReadTool('lookup_rule', { topic: 'advantage' }, world).content).toContain(
      'keep the better',
    );
    expect(executeReadTool('lookup_rule', { topic: 'quantum entanglement' }, world).ok).toBe(false);
  });
});

describe('validateRollRequest', () => {
  it('normalizes a legal expression', () => {
    const ok = validateRollRequest({
      prompt: 'Perception',
      expression: '1d20+2',
      character_ids: ['c1'],
    });
    expect(ok).toEqual({
      ok: true,
      expression: '1d20+2',
      prompt: 'Perception',
      characterIds: ['c1'],
    });
  });

  it('refuses open-ended grammar and incomplete arguments', () => {
    expect(validateRollRequest({ prompt: 'p', expression: '1d11', character_ids: ['c1'] }).ok).toBe(
      false,
    );
    expect(validateRollRequest({ prompt: 'p', expression: '1d20', character_ids: [] }).ok).toBe(
      false,
    );
    expect(validateRollRequest({ prompt: '', expression: '1d20', character_ids: ['c1'] }).ok).toBe(
      false,
    );
  });
});

describe('renderRollResult', () => {
  it('carries full modifier provenance', () => {
    expect(
      renderRollResult({
        character: 'Aria',
        expression: '1d20+4',
        dice: [14],
        modifiers: [
          { source: 'perception', value: 4 },
          { source: 'penalty', value: -1 },
        ],
        total: 17,
      }),
    ).toBe('Aria rolled 14 (1d20+4) + perception +4, penalty -1 = 17.');
  });
});
