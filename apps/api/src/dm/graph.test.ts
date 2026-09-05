import { type CharacterSheet } from '@dnd-lm/contracts';
import { Command, GraphRecursionError, MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { type DmReadOnly } from './context';
import {
  buildDmGraph,
  GRAPH_RECURSION_LIMIT,
  type DmGraphState,
  type DmStreamPayload,
  type DmTriggerState,
  type RollAsk,
  type RollResult,
} from './graph';
import { makeDeltaGate, type DmProvider } from './provider';

const sheet: CharacterSheet = {
  className: 'Fighter',
  level: 3,
  abilityScores: { str: 18, dex: 10, con: 14, int: 8, wis: 10, cha: 12 },
  skillProficiencies: ['athletics'],
  saveProficiencies: [],
  maxHp: 32,
  currentHp: 26,
  armorClass: 18,
  speed: 30,
  inventory: [],
  currency: { cp: 0, sp: 0, gp: 0, pp: 0 },
};

const reader: DmReadOnly = {
  characters: async () => [{ id: 'c1', name: 'Aria', sheet }],
  campaignSettings: async () => ({ items: [], notes: [] }),
  currentScene: async () => 'the crypt',
  unresolvedAction: async () => null,
  recentPublicMessages: async () => [],
};

type Step = { reply: string } | { error: string };

const block = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    narration: 'The gate grinds open.',
    addressed_to: ['party'],
    tool_requests: [],
    proposed_state_changes: [],
    memory_candidates: [],
    next_state: 'WAITING_FOR_PLAYERS',
    ...over,
  });

// The contract says the block's narration repeats the prose exactly, so the
// prose is derived from the override.
const answer = (over: Record<string, unknown> = {}): string =>
  `${(over.narration as string) ?? 'The gate grinds open.'}\n\`\`\`dm-json\n${block(over)}\n\`\`\``;

function scripted(steps: Step[]): { provider: DmProvider; prompts: string[] } {
  const prompts: string[] = [];
  // A script shorter than the run repeats its last step: how the recursion
  // cap and the retry loops get exercised by a one-liner.
  const provider: DmProvider = {
    kind: 'test',
    model: 'test-model',
    async generate(req, onDelta) {
      prompts.push(req.prompt);
      // Scripts are always non-empty; the clamp only picks the last step.
      const step = steps[Math.min(prompts.length, steps.length) - 1]!;
      if ('error' in step) return { kind: 'error', message: step.error };
      onDelta?.(step.reply);
      return {
        kind: 'ok',
        raw: step.reply,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      };
    },
  };
  return { provider, prompts };
}

const makeTrigger = (
  resolutionId: string,
  over: Partial<Omit<DmTriggerState, 'resolutionId'>> = {},
): DmTriggerState => ({
  resolutionId,
  definitionId: 'dm_mention',
  entryProfile: 'resolve_action',
  text: 'Aria picks the lock',
  entityId: null,
  campaignId: 'camp',
  sessionId: 'sess',
  stateVersion: 1,
  ...over,
});

const testConfig = {
  kind: 'openai_compatible' as const,
  baseUrl: null,
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 1000,
};

/** The row the turn is attributed to (M7.8). */
const TEST_CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

/** The M7.7 shape: the graph resolves the campaign's provider at call time. */
const sourcing = (provider: DmProvider) => async (_campaignId: string) => ({
  provider,
  config: testConfig,
  connectionId: TEST_CONNECTION_ID,
});

async function run(steps: Step[], over: Partial<Omit<DmTriggerState, 'resolutionId'>> = {}) {
  const { provider, prompts } = scripted(steps);
  const emits: DmStreamPayload[] = [];
  const graph = buildDmGraph(
    { provider: sourcing(provider), reader, emit: (payload) => emits.push(payload) },
    new MemorySaver(),
  );
  const resolutionId = `res-${Math.random()}`;
  const config = {
    configurable: { thread_id: resolutionId },
    recursionLimit: GRAPH_RECURSION_LIMIT,
  };
  const state = (await graph.invoke(
    { trigger: makeTrigger(resolutionId, over) },
    config,
  )) as DmGraphState & {
    __interrupt__?: Array<{ value: RollAsk }>;
  };
  return { state, prompts, emits };
}

describe('buildDmGraph', () => {
  it('commits a well-formed reply: the proposal is the output, nothing fails', async () => {
    const { state, prompts, emits } = await run([{ reply: answer() }]);
    expect(state.proposal?.narration).toBe('The gate grinds open.');
    expect(state.failure).toBeNull();
    expect(state.narration).toBe('The gate grinds open.');
    expect(state.system).toContain('Dungeon Master');
    // Commit prices the turn on the model the graph actually called (M7.7).
    expect(state.model).toBe('test-model');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('State version: 1.');
    // The stream is prose only: the control block never leaks out. The gate
    // releases the prose up to — not including — the marker line.
    const streamed = emits
      .filter((e) => e.delta)
      .map((e) => e.delta)
      .join('');
    expect(streamed).toBe('The gate grinds open.\n');
  });

  it('retries one bad reply, and the model is told what was wrong', async () => {
    const { state, prompts } = await run([{ reply: 'Just prose, no block.' }, { reply: answer() }]);
    expect(state.proposal).not.toBeNull();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('## Your last reply was rejected');
  });

  it('fails INVALID_OUTPUT when the block is still unreadable after the retry', async () => {
    const { state, prompts } = await run([{ reply: 'prose only' }, { reply: 'still no block' }]);
    expect(state.proposal).toBeNull();
    expect(state.failure).toMatchObject({ reason: 'INVALID_OUTPUT' });
    expect(prompts).toHaveLength(2);
  });

  it('retries a provider error exactly once, then fails PROVIDER_ERROR', async () => {
    const { state, prompts } = await run([{ error: '500 upstream' }, { error: '500 again' }]);
    expect(state.proposal).toBeNull();
    expect(state.failure).toMatchObject({ reason: 'PROVIDER_ERROR' });
    expect(prompts).toHaveLength(2);
  });

  it('recovers when the retry after a provider error succeeds', async () => {
    const { state, prompts } = await run([{ error: '500' }, { reply: answer() }]);
    expect(state.proposal?.next_state).toBe('WAITING_FOR_PLAYERS');
    expect(prompts).toHaveLength(2);
  });

  it('fails NO_PROVIDER when the campaign has no usable connection, calling the model never', async () => {
    const graph = buildDmGraph(
      { provider: async () => null, reader, emit: () => undefined },
      new MemorySaver(),
    );
    const state = (await graph.invoke(
      { trigger: makeTrigger('no-provider-1') },
      { configurable: { thread_id: 'no-provider-1' }, recursionLimit: GRAPH_RECURSION_LIMIT },
    )) as DmGraphState;
    expect(state.failure).toMatchObject({ reason: 'NO_PROVIDER' });
    expect(state.proposal).toBeNull();
  });

  it('returns the roll ask as an interrupt, and the checkpoint resume hands the roll back to the model', async () => {
    const rollStep: Step = {
      reply: answer({
        tool_requests: [
          {
            name: 'request_roll',
            arguments: { prompt: 'Perception check', expression: '1d20+2', character_ids: ['c1'] },
          },
        ],
      }),
    };
    const { provider, prompts } = scripted([rollStep, { reply: answer() }]);
    const emits: DmStreamPayload[] = [];
    const graph = buildDmGraph(
      { provider: sourcing(provider), reader, emit: (payload) => emits.push(payload) },
      new MemorySaver(),
    );
    const config = { configurable: { thread_id: 'park-1' }, recursionLimit: GRAPH_RECURSION_LIMIT };

    const parked = (await graph.invoke({ trigger: makeTrigger('park-1') }, config)) as {
      __interrupt__?: Array<{ value: RollAsk }>;
    };
    expect(parked.__interrupt__?.[0]?.value).toEqual({
      prompt: 'Perception check',
      expression: '1d20+2',
      characterIds: ['c1'],
    });

    const resumption: RollResult = {
      character: 'Aria',
      expression: '1d20+2',
      dice: [14],
      modifiers: [{ source: 'perception', value: 2 }],
      total: 16,
    };
    const finished = (await graph.invoke(
      new Command({ resume: resumption }),
      config,
    )) as DmGraphState;
    expect(finished.proposal).not.toBeNull();
    // `rollNote` is consumed by the second `call_dm` and cleared again: the
    // roll is observable in the prompt it produced, not in the final state.
    expect(prompts[1]).toContain('## The roll came back');
    expect(prompts[1]).toContain('Aria rolled 14');
    expect(prompts[1]).toContain('= 16.');
  });

  it('runs read tools inline and their results come back in the next prompt', async () => {
    const { state, prompts } = await run([
      {
        reply: answer({
          tool_requests: [{ name: 'get_character_summary', arguments: { character_id: 'c1' } }],
        }),
      },
      { reply: answer() },
    ]);
    expect(state.proposal).not.toBeNull();
    expect(state.toolResults).toHaveLength(1);
    expect(state.toolResults[0]?.ok).toBe(true);
    expect(state.toolResults[0]?.content).toContain('Aria — Fighter level 3');
    expect(prompts[1]).toContain('## Tool results from this turn');
  });

  it('rejects a recap that proposes changes, and the retry carries the correction', async () => {
    const proposal = {
      operation: 'adjust_hp',
      target_id: 'c1',
      payload: { delta: -4 },
      actor: { type: 'dm', id: 'camp' },
      scope: 'host',
      expected_state_version: 1,
    };
    const { state, prompts } = await run(
      [{ reply: answer({ proposed_state_changes: [proposal] }) }, { reply: answer() }],
      { entryProfile: 'recap', definitionId: 'recap_command' },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('must carry no proposed_state_changes');
    expect(state.proposal).not.toBeNull();
  });

  it('throws the recursion error the orchestrator maps to RECURSION_LIMIT', async () => {
    // One read tool that never satisfies: every LLM answer asks again.
    const { provider, prompts } = scripted([
      {
        reply: answer({
          tool_requests: [{ name: 'search_campaign_notes', arguments: { query: 'x' } }],
        }),
      },
    ]);
    const graph = buildDmGraph(
      { provider: sourcing(provider), reader, emit: () => undefined },
      new MemorySaver(),
    );
    await expect(
      graph.invoke(
        { trigger: makeTrigger('loop-1') },
        { configurable: { thread_id: 'loop-1' }, recursionLimit: GRAPH_RECURSION_LIMIT },
      ),
    ).rejects.toThrow(GraphRecursionError);
    expect(prompts.length).toBeGreaterThanOrEqual(5);
  });

  it('exposes a delta gate that seals at the first marker mid-stream', () => {
    const seen: string[] = [];
    const gate = makeDeltaGate((chunk) => seen.push(chunk));
    gate.push('Prose one. ');
    gate.push('```dm-jso');
    gate.push('n\n{"narration":"x"}');
    gate.end();
    gate.push('after the fence');
    expect(seen.join('')).toBe('Prose one. ');
  });
});
