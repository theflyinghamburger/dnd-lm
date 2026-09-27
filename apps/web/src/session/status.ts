import {
  type EventEnvelope,
  type RoutingDecision,
  SessionState,
  acceptsMutations,
  isTerminal,
} from '@dnd-lm/contracts';

/**
 * The state a `SESSION_STATE_CHANGED` event moves the session to, or `null`
 * for any other event (U1.0, NFR-205). The server's `to` is the truth,
 * including where a resume lands, which only its `pausedFrom` knows. A `to`
 * that is not a known state is ignored rather than written into the snapshot,
 * where it would silently break every gate below.
 */
export function statusChange(event: EventEnvelope): SessionState | null {
  if (event.type !== 'SESSION_STATE_CHANGED') return null;
  const to = SessionState.safeParse(event.payload['to']);
  return to.success ? to.data : null;
}

/**
 * What the table is told about a state that refuses things, in words — a
 * greyed-out button explains neither a pause nor an end (NFR-403). `null` for
 * the states where everything the composer offers is allowed.
 */
export function statusNotice(status: SessionState): string | null {
  if (status === 'PAUSED')
    return 'The session is paused. Table chat still works; the Dungeon Master and rolls wait for the host to resume.';
  if (status === 'SESSION_ENDED')
    return 'This session has ended. Nothing more can be sent; the transcript stays here to read.';
  return null;
}

/**
 * Whether the composer may send this draft (M5.6). Chat stays live through a
 * pause; what a pause refuses is anything that runs a mutating resolution — a
 * DM trigger, or a `/roll` typed into chat (the gateway runs that as ROLL_DICE).
 * The gate is `acceptsMutations`, never a local list of states, so the client
 * cannot drift from the server's transition table. An ended session sends
 * nothing at all.
 */
export function canSend(status: SessionState, draft: RoutingDecision | null): boolean {
  if (draft?.kind !== 'route' || isTerminal(status)) return false;
  const mutating = Boolean(draft.dmTrigger) || draft.recipientType === 'dice';
  return !mutating || acceptsMutations(status);
}
