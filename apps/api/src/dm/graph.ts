/**
 * The DM turn graph (M6.1, M6.2). One LangGraph state machine per resolution,
 * checkpointed in Postgres, shaped as:
 *
 *   START -> entry -> build_context -> call_dm
 *                                            |  ^
 *              execute_read_tools <----+-----+--|
 *                      +-------+-------+      | (retry)
 *              request_roll (interrupt) <-----+
 *                                            |
 *                                        validate_output
 *                                           /  \
 *                                       retry  END
 *
 * The graph owns no write handle — everything it can do ends in a `DmOutput`,
 * and committing that is the orchestrator's transaction (FR-503, invariant 1).
 * The interrupt is the roll: the checkpoint written before it is what survives
 * a restart between the request and the roll (M6.8, FR-504).
 */
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { type DmFailureReason, type DmOutput, type GraphEntryProfile } from '@dnd-lm/contracts';
import { classifyProviderError, type ProviderFailureClass } from '../providers/provider-error';
import { redactSecrets } from '../providers/provider-secrets.service';
import {
  buildContextPackage,
  buildDmSystem,
  type ContextPackage,
  type DmReadOnly,
} from './context';
import { makeDeltaGate, parseDmOutput, type SourcedProvider, type DmUsage } from './provider';
import {
  executeReadTool,
  type ReadToolName,
  type ReadToolResult,
  READ_TOOLS,
  renderRollResult,
  TOOLS_DOC,
  type ReadToolWorld,
  validateRollRequest,
} from './tools';

export type DmFailure = {
  reason: DmFailureReason;
  /** Operator detail, already redacted. Never reaches the table (M7.9). */
  message: string;
  /**
   * The fine-grained class behind the client-facing reason (M7.9). It exists
   * only for the operator log line: the closed `DmFailureReason` enum is what
   * the client reacts to and does not grow to carry this.
   */
  providerClass?: ProviderFailureClass;
};

export type DmTriggerState = {
  resolutionId: string;
  definitionId: string;
  entryProfile: GraphEntryProfile;
  text: string;
  entityId: string | null;
  campaignId: string;
  sessionId: string;
  /** Version at turn start, so a proposal can record what it was made against (M6.5). */
  stateVersion: number;
};

export type RollAsk = { prompt: string; expression: string; characterIds: string[] };
export type RollResult = {
  character: string;
  expression: string;
  dice: number[];
  modifiers: Array<{ source: string; value: number }>;
  total: number;
};

/**
 * A last-value channel with a default. This langgraph version's `Annotation`
 * only carries a `default` alongside a `reducer`, so a plain hold is an
 * identity reducer — written out, not implied.
 */
const hold = <T>(init: () => T): { reducer: (prev: T, next: T) => T; default: () => T } => ({
  reducer: (_prev, next) => next,
  default: init,
});

export const DmState = Annotation.Root({
  /* The spec's channels, named as MVP.md M6.1 gives them. */
  trigger: Annotation<DmTriggerState>,
  contextPackage: Annotation<ContextPackage | null>(hold<ContextPackage | null>(() => null)),
  messages: Annotation<string>(hold(() => '')),
  toolResults: Annotation<ReadToolResult[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  proposal: Annotation<DmOutput | null>(hold<DmOutput | null>(() => null)),
  validationErrors: Annotation<string | null>(hold<string | null>(() => null)),
  attempt: Annotation<number>(hold(() => 0)),
  /* Operational channels the spec's list leaves to implementation. */
  system: Annotation<string>(hold(() => '')),
  rollRequest: Annotation<RollAsk | null>(hold<RollAsk | null>(() => null)),
  rollNote: Annotation<string | null>(hold<string | null>(() => null)),
  readRequests: Annotation<Array<{ name: ReadToolName; args: unknown }> | null>(
    hold<Array<{ name: ReadToolName; args: unknown }> | null>(() => null),
  ),
  narration: Annotation<string>(hold(() => '')),
  usage: Annotation<DmUsage | null>(hold<DmUsage | null>(() => null)),
  /** The model the turn ran on — cost estimation at commit, telemetry span. */
  model: Annotation<string | null>(hold<string | null>(() => null)),
  /**
   * The connection row the turn ran on (M7.8). Carried beside `model` rather
   * than looked up at commit: the resume-after-roll path then reports the same
   * connection the turn actually used, with no second read to disagree with.
   */
  connectionId: Annotation<string | null>(hold<string | null>(() => null)),
  failure: Annotation<DmFailure | null>(hold<DmFailure | null>(() => null)),
});
export type DmGraphState = typeof DmState.State;

export type DmStreamPayload = { resolutionId: string; delta?: string; reset?: boolean };

export type DmGraphDeps = {
  /**
   * Resolves the campaign's provider at call time (M7.7): one graph is shared
   * by every campaign in the process, so the provider cannot be baked in at
   * compile time. Null means the campaign has no usable connection — the
   * typed NO_PROVIDER failure, not a crash.
   */
  provider: (campaignId: string) => Promise<SourcedProvider | null>;
  reader: DmReadOnly;
  emit: (payload: DmStreamPayload) => void;
};

/** One provider error or invalid reply gets a bounded retry (M6.7). */
const MAX_ATTEMPTS = 2;
/** Per turn, not per node: tools, retries and the roll all count against it (M6.2). */
export const GRAPH_RECURSION_LIMIT = 25;

const toolRequests = (output: DmOutput) => {
  const reads: Array<{ name: ReadToolName; args: unknown }> = [];
  let roll: (typeof output.tool_requests)[number] | null = null;
  for (const request of output.tool_requests) {
    if (request.name === 'request_roll') roll = request;
    else if (READ_TOOLS.includes(request.name)) {
      reads.push({ name: request.name as ReadToolName, args: request.arguments });
    }
  }
  return { reads, roll };
};

export function buildDmGraph(deps: DmGraphDeps, checkpointer: BaseCheckpointSaver) {
  const { provider, reader, emit } = deps;

  const entry = (_state: DmGraphState) => ({ system: buildDmSystem(TOOLS_DOC) });

  const buildContext = async (state: DmGraphState) => {
    const { trigger } = state;
    const pkg = await buildContextPackage({
      profile: trigger.entryProfile,
      campaignId: trigger.campaignId,
      sessionId: trigger.sessionId,
      triggerText: trigger.text,
      triggerKind: trigger.definitionId,
      entityId: trigger.entityId,
      stateVersion: trigger.stateVersion,
      reader,
      system: state.system,
    });
    return { contextPackage: pkg, messages: pkg.prompt };
  };

  const callDm = async (state: DmGraphState) => {
    const { trigger } = state;
    if (state.attempt > 0) emit({ resolutionId: trigger.resolutionId, reset: true });

    const sourced = await provider(trigger.campaignId);
    if (!sourced) {
      // The orchestrator already gates the common case before the graph
      // starts; this covers a connection disabled mid-turn.
      return {
        failure: {
          reason: 'NO_PROVIDER' as const,
          message: 'The campaign has no usable provider connection.',
        },
      };
    }

    const parts: string[] = [state.messages];
    if (state.toolResults.length > 0) {
      const section = state.toolResults
        .map(
          (result) =>
            `### ${result.name}\n${result.ok ? result.content : `Rejected: ${result.content}`}`,
        )
        .join('\n\n');
      parts.push(
        `## Tool results from this turn\n${section}\nAct on these results; continue the turn.`,
      );
    }
    if (state.rollNote) {
      parts.push(`## The roll came back\n${state.rollNote} Narrate its consequences and continue.`);
    }
    if (state.validationErrors) {
      parts.push(
        `## Your last reply was rejected\n${state.validationErrors}\nReply again with a well-formed dm-json block.`,
      );
    }

    const gate = makeDeltaGate((chunk) =>
      emit({ resolutionId: trigger.resolutionId, delta: chunk }),
    );
    // M7.9: both SDKs throw their own error types, and a local endpoint throws
    // undici's. One catch at the single call site classifies all three, so the
    // operator line can report DNS from auth from a wrong model id — and the
    // client still sees only the closed `PROVIDER_ERROR`.
    let completion;
    try {
      completion = await sourced.provider.generate(
        { system: state.system, prompt: parts.join('\n\n'), maxTokens: sourced.config.maxTokens },
        (chunk) => gate.push(chunk),
      );
    } catch (error) {
      gate.end();
      const classified = classifyProviderError(error);
      return {
        failure: {
          reason: 'PROVIDER_ERROR' as const,
          message: redactSecrets(classified.detail, [sourced.config.apiKey]),
          providerClass: classified.class,
        },
      };
    }
    gate.end();

    if (completion.kind === 'error') {
      // The adapters return this rather than throwing when the request-time URL
      // re-check refuses the call, so nothing was sent: unreachable, by policy.
      // `attempt` is left to `validate_output`, which owns the increment for
      // both failure kinds — one bounded retry either way (M6.7).
      return {
        failure: {
          reason: 'PROVIDER_ERROR' as const,
          message: redactSecrets(completion.message, [sourced.config.apiKey]),
          providerClass: 'unreachable' as const,
        },
      };
    }

    const { narration, output } = parseDmOutput(completion.raw);
    const base = {
      narration,
      usage: completion.usage,
      model: sourced.config.model,
      connectionId: sourced.connectionId,
      attempt: state.attempt,
      validationErrors: null,
      rollRequest: null,
      rollNote: null,
      readRequests: null,
    };

    if (!output) {
      // No parseable control block: the retry note is what the model gets back.
      return {
        ...base,
        proposal: null,
        narration: narration || state.narration,
        validationErrors:
          'Your reply had no readable dm-json control block. Reply with your narration as prose, then a ```dm-json block exactly as the contract specifies.',
      };
    }

    // A recap or rules answer that changed anything is a rule violation
    // (profiles are selection, M6.1), and so is an empty narration.
    if (
      (trigger.entryProfile === 'recap' || trigger.entryProfile === 'rules_answer') &&
      output.proposed_state_changes.length > 0
    ) {
      return {
        ...base,
        proposal: null,
        narration,
        validationErrors:
          'This is a recap/rule answer: the control block must carry no proposed_state_changes.',
      };
    }

    const { reads, roll } = toolRequests(output);
    if (roll) {
      const checked = validateRollRequest(roll.arguments);
      if (!checked.ok) {
        return {
          ...base,
          proposal: null,
          narration,
          validationErrors: `request_roll was refused (${checked.error}). Fix the arguments and reply again.`,
        };
      }
      return {
        ...base,
        proposal: null,
        narration,
        rollRequest: {
          prompt: checked.prompt,
          expression: checked.expression,
          characterIds: checked.characterIds,
        },
      };
    }

    if (reads.length > 0) {
      // An intermediate answer: its proposals do not count, the final reply does.
      return { ...base, proposal: null, narration, readRequests: reads };
    }

    return { ...base, proposal: output, narration: narration || output.narration };
  };

  /**
   * The roll (M6.5). First pass: the interrupt writes the checkpoint and parks
   * the resolution; the orchestrator opens the pending action. Re-invocation
   * with `Command({ resume })` re-runs this node and `interrupt` yields the
   * roll result instead.
   */
  const requestRoll = (state: DmGraphState) => {
    const result = interrupt(state.rollRequest!) as RollResult;
    return { rollNote: renderRollResult(result), rollRequest: null };
  };

  const executeReadTools = (state: DmGraphState) => {
    const world: ReadToolWorld = {
      characters: state.contextPackage?.characters ?? [],
      settings: state.contextPackage?.campaignSettings ?? null,
    };
    const results = (state.readRequests ?? []).map((request) =>
      executeReadTool(request.name, request.args, world),
    );
    return { readRequests: null, toolResults: results };
  };

  /*
   * One bounded retry (M6.7). `validate_output` owns the attempt count for
   * both failure kinds — a provider error and an unreadable block clear in
   * the same place — so this node is the only write to `attempt` and the
   * routing edge can trust the state it reads.
   */
  const validateOutput = (state: DmGraphState) => {
    if (state.proposal) return {};
    if (state.attempt >= MAX_ATTEMPTS - 1) {
      if (state.failure) return {};
      return {
        failure: {
          reason: 'INVALID_OUTPUT' as const,
          message: 'The model never produced a well-formed control block.',
        },
      };
    }
    return { ...(state.failure ? { failure: null } : {}), attempt: state.attempt + 1 };
  };

  const afterCallDm = (state: DmGraphState): string => {
    if (state.rollRequest) return 'request_roll';
    if (state.readRequests) return 'execute_read_tools';
    return 'validate_output';
  };

  const afterValidate = (state: DmGraphState): string => {
    // `attempt` moved only when this node asked for another pass.
    if (state.failure) return END;
    if (!state.proposal && state.attempt >= 1) return 'call_dm';
    return END;
  };

  return new StateGraph(DmState)
    .addNode('entry', entry)
    .addNode('build_context', buildContext)
    .addNode('call_dm', callDm)
    .addNode('request_roll', requestRoll)
    .addNode('execute_read_tools', executeReadTools)
    .addNode('validate_output', validateOutput)
    .addEdge(START, 'entry')
    .addEdge('entry', 'build_context')
    .addEdge('build_context', 'call_dm')
    .addConditionalEdges('call_dm', afterCallDm, {
      [END]: END,
      request_roll: 'request_roll',
      execute_read_tools: 'execute_read_tools',
      validate_output: 'validate_output',
    })
    .addEdge('request_roll', 'call_dm')
    .addEdge('execute_read_tools', 'call_dm')
    .addConditionalEdges('validate_output', afterValidate, { [END]: END, call_dm: 'call_dm' })
    .compile({ checkpointer });
}
