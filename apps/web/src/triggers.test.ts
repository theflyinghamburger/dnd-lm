import { describe, expect, it } from 'vitest';
import {
  TRIGGER_REGISTRY,
  parseMessage,
  type CampaignTriggersResponse,
  type Roster,
} from '@dnd-lm/contracts';
import { TRIGGER_LABELS, enabledRegistry } from './triggers';

/** The GET /triggers shape, every registry entry enabled unless overridden. */
const response = (overrides: Record<string, boolean> = {}): CampaignTriggersResponse => ({
  triggers: TRIGGER_REGISTRY.map((d) => ({
    id: d.id,
    enabled: overrides[d.id] ?? true,
    entryProfile: d.entryProfile,
    tag: d.match?.tag ?? null,
  })),
});

const roster: Roster = { members: [], npcs: [] };
const preview = (text: string, data: CampaignTriggersResponse) =>
  parseMessage(text, roster, enabledRegistry(data), { role: 'player' });

describe('the composer after a host toggles a trigger (U1.3, MVP.md §4.3 rule 7)', () => {
  it('previews @dm as a DM turn while it is enabled', () => {
    expect(preview('@dm I open the door', response())).toMatchObject({
      recipientType: 'dm',
      dmTrigger: { definitionId: 'dm_mention' },
    });
  });

  it('previews @dm as table chat once it is disabled, and stops offering the tag', () => {
    const off = response({ dm_mention: false });
    const decision = preview('@dm I open the door', off);
    expect(decision).toMatchObject({ kind: 'route', recipientType: 'table' });
    expect(decision).not.toHaveProperty('dmTrigger');
    expect(enabledRegistry(off).map((d) => d.match?.tag)).not.toContain('@dm');
  });

  it('offers nothing before the triggers have loaded', () => {
    expect(enabledRegistry(undefined)).toEqual([]);
  });
});

describe('the toggle labels', () => {
  it('describe every registry entry, so a new trigger cannot ship unlabelled', () => {
    for (const d of TRIGGER_REGISTRY) expect(TRIGGER_LABELS[d.id]?.does).toBeTruthy();
    expect(Object.keys(TRIGGER_LABELS).sort()).toEqual(TRIGGER_REGISTRY.map((d) => d.id).sort());
  });

  it('warn next to the roll-resume trigger rather than blocking it', () => {
    expect(TRIGGER_LABELS['pending_action_completed']?.warning).toMatch(/never resumes/);
  });
});
