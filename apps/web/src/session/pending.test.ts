import type { EventEnvelope } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { type PendingRoll, applyPending, isFresh } from './pending';

const event = (sequence: number, type: string, payload: Record<string, unknown>) =>
  ({ sequence, type, payload }) as unknown as EventEnvelope;

const requested = (sequence: number, id: string) =>
  event(sequence, 'ROLL_REQUESTED', {
    pending_action_id: id,
    prompt: 'Make a Perception check',
    expression: 'Perception',
    authorized_character_ids: ['c-aria'],
  });
const completed = (sequence: number, id: string) =>
  event(sequence, 'PENDING_ACTION_COMPLETED', {
    pending_action_id: id,
    roll_id: 'r',
    character_id: 'c-aria',
    graph_thread_id: null,
  });

/** What `useSession.applyEvent` does: the guard first, then the reducer. */
function deliver(events: EventEnvelope[]) {
  let highWater = 0;
  let pending: PendingRoll[] = [];
  for (const e of events) {
    if (!isFresh(e, highWater)) continue;
    highWater = e.sequence;
    pending = applyPending(pending, e);
  }
  return pending;
}

describe('applyPending', () => {
  it('opens a card from ROLL_REQUESTED', () => {
    expect(applyPending([], requested(1, 'a'))).toEqual([
      {
        pendingActionId: 'a',
        prompt: 'Make a Perception check',
        expression: 'Perception',
        authorizedCharacterIds: ['c-aria'],
      },
    ]);
  });

  it('closes it on its PENDING_ACTION_COMPLETED', () => {
    expect(applyPending(applyPending([], requested(1, 'a')), completed(2, 'a'))).toEqual([]);
  });

  it('ignores a completion for another request, and unrelated events', () => {
    const open = applyPending([], requested(1, 'a'));
    expect(applyPending(open, completed(2, 'b'))).toBe(open);
    expect(applyPending(open, event(3, 'MESSAGE_POSTED', { content: 'hi' }))).toBe(open);
  });

  it('never holds the same request twice', () => {
    const open = applyPending([], requested(1, 'a'));
    expect(applyPending(open, requested(1, 'a'))).toBe(open);
  });

  it('does not open a card from a completion that arrives before its request', () => {
    expect(applyPending([], completed(2, 'a'))).toEqual([]);
  });
});

describe('behind the high-water guard', () => {
  it('a replay overlapping live delivery neither duplicates nor resurrects a card', () => {
    // Live: request, then two quick rolls — the first closes it, the second
    // (a plain roll) has nothing to close. Then a resume replays the tail.
    const live = [requested(5, 'a'), completed(6, 'a'), event(7, 'ROLL_RESULT', {})];
    expect(deliver([...live, ...live])).toEqual([]);
    // An out-of-order request below the mark does not come back.
    expect(deliver([requested(5, 'a'), completed(6, 'a'), requested(5, 'a')])).toEqual([]);
  });

  it('a reload rebuilds the open card from replay alone', () => {
    expect(deliver([requested(3, 'a'), completed(4, 'a'), requested(8, 'b')])).toMatchObject([
      { pendingActionId: 'b' },
    ]);
  });
});
