/**
 * The MVP session state machine (M5.1, a subset of architecture.md §6.3).
 *
 * A table, not scattered `if`s, and illegal transitions throw. `COMBAT_TURN`,
 * `WAITING_FOR_TARGET` and `WAITING_FOR_MULTIPLE_PLAYERS` are Phase 3.
 *
 * This is **not** the LangGraph graph and shares no state with it (D-5). The
 * graph is something the orchestrator calls; this is what the orchestrator owns.
 */
import type { SessionState } from './index';

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  // WAITING_FOR_ROLL is reachable directly because a host may ask the party for
  // a check at an idle table (M5.5's REQUEST_ROLL), not only as a graph
  // interrupt out of DM_GENERATING. architecture.md §6.3 lists the states but
  // no edges, so this table is the only definition of them.
  WAITING_FOR_PLAYERS: ['DM_GENERATING', 'WAITING_FOR_ROLL', 'PAUSED', 'SESSION_ENDED'],
  // A generating turn ends by finishing, by parking on a roll, or by failing.
  DM_GENERATING: ['WAITING_FOR_PLAYERS', 'WAITING_FOR_ROLL', 'SESSION_ENDED'],
  WAITING_FOR_ROLL: ['DM_GENERATING', 'WAITING_FOR_PLAYERS', 'PAUSED', 'SESSION_ENDED'],
  // Resume returns to whichever state the pause interrupted.
  PAUSED: ['WAITING_FOR_PLAYERS', 'WAITING_FOR_ROLL', 'SESSION_ENDED'],
  SESSION_ENDED: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: SessionState,
    readonly to: SessionState,
  ) {
    super(`A session cannot go from ${from} to ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export const canTransition = (from: SessionState, to: SessionState): boolean =>
  TRANSITIONS[from].includes(to);

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Nothing leaves SESSION_ENDED, which is what makes it safe to stop replaying. */
export const isTerminal = (state: SessionState): boolean => TRANSITIONS[state].length === 0;

/**
 * A paused session refuses every state-mutating command and blocks all
 * triggers, but chat stays live (M5.6) — the table can talk through a break.
 */
export const acceptsMutations = (state: SessionState): boolean =>
  state !== 'PAUSED' && state !== 'SESSION_ENDED';
