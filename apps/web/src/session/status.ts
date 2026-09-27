import {
  type EventEnvelope,
  type RoutingDecision,
  type SessionSnapshot,
  SessionState,
  acceptsMutations,
  canTransition,
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
 * The snapshot `resume` returned, unless a state change seen live postdates it.
 * The socket joins the session's room before `resume` answers, so a change can
 * arrive ahead of the snapshot; the snapshot must not roll it back.
 */
export function resumedSnapshot(
  snapshot: SessionSnapshot,
  live: { sequence: number; to: SessionState } | null,
): SessionSnapshot {
  return live && live.sequence > snapshot.last_sequence
    ? { ...snapshot, status: live.to }
    : snapshot;
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

/**
 * Which host controls are legal from here (U1.2, FR-801). The transition table
 * decides, never a local list: PAUSE and END are the edges to PAUSED and
 * SESSION_ENDED, and asking for a check is the edge to WAITING_FOR_ROLL.
 * RESUME's target is the server's `pausedFrom`, so it is "only from PAUSED".
 * FORCE_DM_TURN moves nothing; it is a trigger, and the server runs it as an
 * ordinary mutation — refused while paused (summary.md §4) and once ended.
 */
export function hostActions(status: SessionState) {
  return {
    PAUSE: canTransition(status, 'PAUSED'),
    RESUME: status === 'PAUSED',
    END: canTransition(status, 'SESSION_ENDED'),
    FORCE_DM_TURN: acceptsMutations(status),
    // PAUSED -> WAITING_FOR_ROLL is RESUME's edge; the request itself is a
    // mutation, so a pause refuses it.
    REQUEST_ROLL: acceptsMutations(status) && canTransition(status, 'WAITING_FOR_ROLL'),
  };
}
