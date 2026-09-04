import { describe, expect, it } from 'vitest';
import { SessionState } from './index';
import {
  IllegalTransitionError,
  acceptsMutations,
  assertTransition,
  canTransition,
  isTerminal,
} from './session-state';

const ALL = SessionState.options;

describe('the session state machine', () => {
  it.each([
    ['WAITING_FOR_PLAYERS', 'DM_GENERATING'],
    // A host asking an idle table for a check, rather than a graph interrupt.
    ['WAITING_FOR_PLAYERS', 'WAITING_FOR_ROLL'],
    ['DM_GENERATING', 'WAITING_FOR_ROLL'],
    ['WAITING_FOR_ROLL', 'DM_GENERATING'],
    ['WAITING_FOR_PLAYERS', 'PAUSED'],
    ['PAUSED', 'WAITING_FOR_PLAYERS'],
    ['PAUSED', 'WAITING_FOR_ROLL'],
    ['WAITING_FOR_ROLL', 'PAUSED'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['DM_GENERATING', 'PAUSED'],
    ['DM_GENERATING', 'DM_GENERATING'],
    ['SESSION_ENDED', 'WAITING_FOR_PLAYERS'],
    ['SESSION_ENDED', 'PAUSED'],
    ['PAUSED', 'DM_GENERATING'],
  ] as const)('refuses %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
  });

  it('never allows a state to transition to itself', () => {
    for (const state of ALL) expect(canTransition(state, state)).toBe(false);
  });

  it('lets every live state end, so a host is never trapped', () => {
    for (const state of ALL) {
      if (state !== 'SESSION_ENDED') expect(canTransition(state, 'SESSION_ENDED')).toBe(true);
    }
  });

  it('makes SESSION_ENDED the only terminal state', () => {
    expect(ALL.filter(isTerminal)).toEqual(['SESSION_ENDED']);
  });

  it('refuses mutations only while paused or ended', () => {
    expect(ALL.filter((state) => !acceptsMutations(state)).sort()).toEqual([
      'PAUSED',
      'SESSION_ENDED',
    ]);
  });

  it('names both ends in the error, so a log line explains itself', () => {
    try {
      assertTransition('SESSION_ENDED', 'DM_GENERATING');
      expect.unreachable();
    } catch (error) {
      expect((error as IllegalTransitionError).from).toBe('SESSION_ENDED');
      expect((error as IllegalTransitionError).to).toBe('DM_GENERATING');
    }
  });
});
