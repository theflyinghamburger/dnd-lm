import { describe, expect, it } from 'vitest';
import { estimateUsd } from './telemetry';
import { DM_JSON_MARKER, makeDeltaGate, parseDmOutput } from './provider';

const block = (overrides: Record<string, unknown> = {}) =>
  `${DM_JSON_MARKER}\n${JSON.stringify({
    narration: 'The gate grinds open.',
    addressed_to: ['party'],
    tool_requests: [],
    proposed_state_changes: [],
    memory_candidates: [],
    next_state: 'WAITING_FOR_PLAYERS',
    ...overrides,
  })}\n\`\`\``;

describe('parseDmOutput', () => {
  it('splits narration from the control block', () => {
    const { narration, output } = parseDmOutput(`The gate grinds open.\n\n${block()}`);
    expect(narration).toBe('The gate grinds open.');
    expect(output?.narration).toBe('The gate grinds open.');
    expect(output?.proposed_state_changes).toEqual([]);
  });

  it('tries the whole body as JSON when the fence is missing', () => {
    const { narration, output } = parseDmOutput(block().replace(DM_JSON_MARKER, '```'));
    // The fence is wrong but the JSON is intact: the lenient pass finds it.
    expect(output?.next_state).toBe('WAITING_FOR_PLAYERS');
    expect(narration.length).toBeGreaterThan(0);
  });

  it('refuses a block that does not parse or that fails the schema', () => {
    expect(parseDmOutput(`prose\n\`\`\`dm-json\n{ "narration": "broken"`).output).toBeNull();
    expect(parseDmOutput(`prose\n\`\`\`dm-json\n{"narration": "ok only"}`).output).toBeNull();
  });

  it('returns null output for pure prose', () => {
    const { narration, output } = parseDmOutput('Just a paragraph, no decisions.');
    expect(narration).toBe('Just a paragraph, no decisions.');
    expect(output).toBeNull();
  });
});

describe('makeDeltaGate', () => {
  it('streams prose and never leaks the control block, even split across chunks', () => {
    const seen: string[] = [];
    const gate = makeDeltaGate((chunk) => seen.push(chunk));
    gate.push('The door is locked. ');
    gate.push('```dm-j');
    gate.push('son\n{"narration":"x"}\n```');
    gate.end();
    expect(seen.join('')).toBe('The door is locked. ');
  });

  it('holds a tail that could still become the marker, then flushes it if it was not', () => {
    const seen: string[] = [];
    const gate = makeDeltaGate((chunk) => seen.push(chunk));
    gate.push('hello');
    gate.push(' ```dm-j');
    // While the tail could still become ```dm-json, nothing past the safe
    // prefix is released.
    const heldBack = 'hello ```dm-j'.length - seen.join('').length;
    gate.push('xsonal');
    gate.end();
    expect(heldBack).toBeGreaterThan(0);
    expect(seen.join('')).toBe('hello ```dm-jxsonal');
  });

  it('releases the held tail on end() when no marker arrived', () => {
    const seen: string[] = [];
    const gate = makeDeltaGate((chunk) => seen.push(chunk));
    gate.push('plain prose only');
    gate.end();
    expect(seen.join('')).toBe('plain prose only');
  });
});

describe('estimateUsd', () => {
  it('prices known models and reports null rather than guessing', () => {
    expect(estimateUsd('claude-opus-5', { input: 1_000_000, output: 0, cacheRead: 0 })).toBe(5);
    expect(estimateUsd('some-local-model', { input: 1, output: 1, cacheRead: 0 })).toBeNull();
  });
});
