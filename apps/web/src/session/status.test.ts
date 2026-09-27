import { TRIGGER_REGISTRY, buildRoster, parseMessage } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { canSend, statusNotice } from './status';

/**
 * U1.0: the composer's gate. Drafts go through the real router so the test
 * exercises the same decision the routing preview shows, not a hand-built one.
 */
const roster = buildRoster([{ userId: 'u-aria', displayName: 'Aria', role: 'player' }]);
const draft = (raw: string) => parseMessage(raw, roster, TRIGGER_REGISTRY, { role: 'player' });

const chat = draft('We should rest here.');
const dm = draft('@dm I inspect the altar.');
const roll = draft('/roll 1d20+2');

describe('canSend', () => {
  it('sends everything while the table is live', () => {
    for (const status of ['WAITING_FOR_PLAYERS', 'DM_GENERATING', 'WAITING_FOR_ROLL'] as const) {
      expect([chat, dm, roll].map((d) => canSend(status, d))).toEqual([true, true, true]);
    }
  });

  it('keeps table chat live while paused, but not the DM or a roll (M5.6)', () => {
    expect(canSend('PAUSED', chat)).toBe(true);
    expect(canSend('PAUSED', dm)).toBe(false);
    expect(canSend('PAUSED', roll)).toBe(false);
  });

  it('sends nothing once the session has ended', () => {
    expect([chat, dm, roll].map((d) => canSend('SESSION_ENDED', d))).toEqual([false, false, false]);
  });

  it('never sends an empty draft or one the router rejects', () => {
    expect(canSend('WAITING_FOR_PLAYERS', null)).toBe(false);
    expect(canSend('WAITING_FOR_PLAYERS', draft('@dm'))).toBe(false);
  });
});

describe('statusNotice', () => {
  it('names a pause and an end differently, and says nothing when live (NFR-403)', () => {
    expect(statusNotice('PAUSED')).toMatch(/paused.*chat still works/i);
    expect(statusNotice('SESSION_ENDED')).toMatch(/ended/i);
    expect(statusNotice('PAUSED')).not.toBe(statusNotice('SESSION_ENDED'));
    expect(statusNotice('WAITING_FOR_PLAYERS')).toBeNull();
    expect(statusNotice('DM_GENERATING')).toBeNull();
  });
});
