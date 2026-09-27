import type { EventEnvelope } from '@dnd-lm/contracts';

/** An open request for a check, as `ROLL_REQUESTED` carries it (FR-305). */
export type PendingRoll = {
  pendingActionId: string;
  prompt: string;
  expression: string;
  authorizedCharacterIds: string[];
};

/**
 * `applyEvent`'s high-water guard (M2.4): anything at or below the mark was
 * already applied. It is what keeps a replayed `ROLL_REQUESTED` from
 * resurrecting a card its completion already closed.
 */
export function isFresh(event: EventEnvelope, highWater: number): boolean {
  return event.sequence > highWater;
}

/**
 * The open roll requests, folded out of the event log (U1.1): `ROLL_REQUESTED`
 * opens one, `PENDING_ACTION_COMPLETED` closes it. The log is the only source,
 * so a reload rebuilds the card from `resume`'s replay with no snapshot field.
 * The server closes by character, not expression, so nothing here looks at
 * what was rolled.
 */
export function applyPending(current: PendingRoll[], event: EventEnvelope): PendingRoll[] {
  const p = event.payload;
  const id = p['pending_action_id'];
  if (typeof id !== 'string') return current;
  if (event.type === 'PENDING_ACTION_COMPLETED') {
    return current.some((r) => r.pendingActionId === id)
      ? current.filter((r) => r.pendingActionId !== id)
      : current;
  }
  if (event.type !== 'ROLL_REQUESTED' || current.some((r) => r.pendingActionId === id)) {
    return current;
  }
  // Dropped rather than rendered half-empty, as `statusChange` drops a bad `to`.
  const { prompt, expression, authorized_character_ids: ids } = p;
  if (
    typeof prompt !== 'string' ||
    typeof expression !== 'string' ||
    !Array.isArray(ids) ||
    !ids.every((c) => typeof c === 'string')
  ) {
    return current;
  }
  return [...current, { pendingActionId: id, prompt, expression, authorizedCharacterIds: ids }];
}
