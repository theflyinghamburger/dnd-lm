/**
 * The DM resolution orchestrator (M6.6, M6.7, M6.8, FR-504/505).
 *
 * Consumes the `DM_TRIGGERED` events the gateway emits, owns the session
 * state machine moves a resolution makes, and commits narration and
 * proposals as one transaction (invariant 4). The graph runs with a
 * Postgres checkpointer, so a turn interrupted for a roll survives a process
 * restart; the checkpoint is the resume point the roll's completion hands
 * back. The orchestrator is the only place a resolution may touch both the
 * session and the checkpoint.
 */
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Command, GraphRecursionError } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  type CharacterSheet,
  type DmFailureReason,
  type DmOutput,
  type EventEnvelope,
  type GraphEntryProfile,
  type ProposedStateChange,
} from '@dnd-lm/contracts';
import { and, eq, isNotNull, inArray, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB, type Db } from '../db/db.module';
import { campaigns, characters, pendingActions, rolls, sessions } from '../db/schema';
import {
  type EventDraft,
  type SessionRow,
  SessionService,
  type Tx,
} from '../session/session.service';
import { DmContextReader } from './context';
import {
  buildDmGraph,
  GRAPH_RECURSION_LIMIT,
  type DmGraphState,
  type DmStreamPayload,
  type RollAsk,
  type RollResult,
} from './graph';
import {
  buildDmProvider,
  readDmProviderConfig,
  type DmProvider,
  type DmProviderConfig,
} from './provider';
import { estimateUsd, withSpan } from './telemetry';

export const DM_PROVIDER_SOURCE = Symbol('DM_PROVIDER_SOURCE');

type DmCompiledGraph = ReturnType<typeof buildDmGraph>;

/**
 * Where the provider comes from (M6 is env; M7 moves it to per-connection
 * rows with a UI). Overridable in tests, which keeps the e2e suite free of
 * API keys. A missing config is a valid state — one turn's worth of a typed
 * failure, not a crash.
 */
@Injectable()
export class DmProviderSource {
  get(): { provider: DmProvider; config: DmProviderConfig } | null {
    const config = readDmProviderConfig();
    return config ? { provider: buildDmProvider(config), config } : null;
  }
}

export type DmTriggerCallbacks = {
  stream: (payload: DmStreamPayload) => void;
  events: (events: EventEnvelope[]) => void;
};

export type DmTriggerPayload = {
  definition_id: string;
  entry_profile: string;
  args?: Record<string, unknown>;
};

@Injectable()
export class DmOrchestrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(DmOrchestrator.name);
  /** One resolution per session at a time (M5's lock does the same, coarser). */
  private readonly active = new Map<string, string>();
  /** Provisional narration is a socket concern; the graph pushes to these. */
  private readonly streamHandlers = new Map<string, DmTriggerCallbacks['stream']>();
  private graph: DmCompiledGraph | null = null;
  private checkpointer: PostgresSaver | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessionService: SessionService,
    private readonly reader: DmContextReader,
    @Inject(DM_PROVIDER_SOURCE) private readonly providerSource: DmProviderSource,
  ) {}

  /**
   * Crashed processes leave checkpoints behind whose roll never came back.
   * An hour is an arbitrary but honest ceiling; earlier deletion risks a
   * slow player who still has the roll to make.
   */
  async onApplicationBootstrap(): Promise<void> {
    const url = process.env.DATABASE_URL;
    if (!url) return;
    try {
      const saver = await PostgresSaver.fromConnString(url);
      const cutoff = new Date(Date.now() - 3600_000);
      const orphans = await this.db
        .select({ thread: pendingActions.graphThreadId })
        .from(pendingActions)
        .where(
          and(
            inArray(pendingActions.status, ['completed', 'cancelled']),
            isNotNull(pendingActions.graphThreadId),
            lt(pendingActions.completedAt, cutoff),
          ),
        );
      for (const orphan of orphans) {
        if (orphan.thread) await saver.deleteThread(orphan.thread);
      }
    } catch (error) {
      this.logger.warn(
        `orphan checkpoint sweep skipped: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Ends a parked checkpoint the moment the session ends, not when a sweep notices. */
  async onSessionEnded(sessionId: string): Promise<void> {
    const parked = await this.db
      .select({ thread: pendingActions.graphThreadId })
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.sessionId, sessionId),
          eq(pendingActions.status, 'open'),
          isNotNull(pendingActions.graphThreadId),
        ),
      );
    for (const row of parked) {
      await this.deleteThread(row.thread);
    }
  }

  /**
   * The single entry point the DM_TRIGGERED event feeds. The caller (the
   * gateway's publish path) passes callbacks, because the room address is a
   * socket concern this class does not own.
   */
  async onTriggered(
    sessionId: string,
    payload: DmTriggerPayload,
    actorId: string,
    callbacks: DmTriggerCallbacks,
  ): Promise<void> {
    try {
      const definitionId = payload.definition_id;
      const entryProfile = payload.entry_profile as GraphEntryProfile;
      const args = {
        text: typeof payload.args?.text === 'string' ? payload.args.text : '',
        entityId: typeof payload.args?.entityId === 'string' ? payload.args.entityId : null,
        pendingActionId:
          typeof payload.args?.pending_action_id === 'string'
            ? payload.args.pending_action_id
            : null,
      };

      if (definitionId === 'pending_action_completed' && args.pendingActionId) {
        const [action] = await this.db
          .select()
          .from(pendingActions)
          .where(eq(pendingActions.id, args.pendingActionId))
          .limit(1);
        if (action?.sessionId === sessionId && action.graphThreadId) {
          await this.resumeFromRoll(sessionId, action.graphThreadId, action.id, actorId, callbacks);
          return;
        }
        // A roll that closed a host-requested action (no graph parked): there is
        // nothing to resume, and the host can ask the table to continue.
        this.logger.debug(
          `pending action ${args.pendingActionId} closed with no parked DM turn; nothing to resume`,
        );
        return;
      }

      await this.startResolution(sessionId, {
        definitionId,
        entryProfile,
        text: args.text,
        entityId: args.entityId,
        actorId,
        callbacks,
      });
    } catch (error) {
      // The trigger path must never take the gateway's publish loop down with it.
      this.logger.error(
        `DM trigger failed for session ${sessionId}: ${error instanceof Error ? error.stack : error}`,
      );
    }
  }

  private async ensureGraph(): Promise<{
    graph: NonNullable<DmCompiledGraph>;
    checkpointer: PostgresSaver;
  } | null> {
    const sourced = this.providerSource.get();
    const url = process.env.DATABASE_URL;
    if (!sourced || !url) return null;
    if (this.graph && this.checkpointer)
      return { graph: this.graph, checkpointer: this.checkpointer };
    // ponytail: the graph and checkpointer are process-lifetime; a provider
    // reconfigured mid-run (an M7 case) keeps the first connection until
    // restart. Fine while config is a process constant.
    this.checkpointer = await PostgresSaver.fromConnString(url);
    await this.checkpointer.setup();
    this.graph = buildDmGraph(
      {
        provider: sourced.provider,
        maxTokens: sourced.config.maxTokens,
        reader: this.reader,
        emit: (payload) => this.streamHandlers.get(payload.resolutionId)?.(payload),
      },
      this.checkpointer,
    );
    return { graph: this.graph, checkpointer: this.checkpointer };
  }

  private async deleteThread(threadId: string | null): Promise<void> {
    if (!threadId) return;
    if (!this.checkpointer) return;
    try {
      await this.checkpointer.deleteThread(threadId);
    } catch (error) {
      this.logger.warn(
        `checkpoint delete for ${threadId} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async startResolution(
    sessionId: string,
    opts: {
      definitionId: string;
      entryProfile: GraphEntryProfile;
      text: string;
      entityId: string | null;
      actorId: string;
      callbacks: DmTriggerCallbacks;
    },
  ): Promise<void> {
    const session = await this.sessionService.find(sessionId);
    if (!session) return;
    if (this.active.has(sessionId)) {
      this.logger.warn(
        `trigger ${opts.definitionId} dropped: a resolution is already running for session ${sessionId}`,
      );
      return;
    }

    await withSpan(
      'dm.resolution',
      { campaign_id: session.campaignId, session_id: sessionId, trigger: opts.definitionId },
      async (span) => {
        const sourced = this.providerSource.get();
        if (!sourced) {
          await this.reportFailure(sessionId, null, 'NO_PROVIDER', opts.actorId, opts.callbacks);
          return;
        }
        span.setAttribute('model', sourced.provider.model);

        const resolutionId = randomUUID();
        this.active.set(sessionId, resolutionId);
        this.streamHandlers.set(resolutionId, opts.callbacks.stream);
        const dmActor = { type: 'dm' as const, id: session.campaignId };
        let parked = false;

        try {
          const infra = await this.ensureGraph();
          if (!infra) {
            await this.reportFailure(
              sessionId,
              resolutionId,
              'INTERNAL',
              opts.actorId,
              opts.callbacks,
            );
            return;
          }
          const { graph } = infra;

          await this.sessionService.runCommand(
            {
              commandId: `${resolutionId}:start`,
              sessionId,
              senderId: opts.actorId,
              type: 'DM_RESOLUTION_START',
              // null: server-internal, re-validates against the locked row and
              // gates nothing (M6.6).
              expectedStateVersion: null,
              mode: 'mutation',
            },
            (row) => [
              {
                type: 'SESSION_STATE_CHANGED',
                payload: { action: 'DM_RESOLUTION', from: row.status, to: 'DM_GENERATING' },
                actor: dmActor,
                source: { type: 'resolution', id: resolutionId },
              },
            ],
            async (tx, _appended, _stateVersion, row) => {
              await this.sessionService.setStatus(tx, row, 'DM_GENERATING');
            },
          );

          span.setAttribute('resolution_id', resolutionId);
          let state: DmGraphState & { __interrupt__?: Array<{ value: unknown }> };
          try {
            state = (await graph.invoke(
              {
                trigger: {
                  resolutionId,
                  definitionId: opts.definitionId,
                  entryProfile: opts.entryProfile,
                  text: opts.text,
                  entityId: opts.entityId,
                  campaignId: session.campaignId,
                  sessionId,
                  stateVersion: session.stateVersion,
                },
              },
              { configurable: { thread_id: resolutionId }, recursionLimit: GRAPH_RECURSION_LIMIT },
            )) as DmGraphState & { __interrupt__?: Array<{ value: unknown }> };
          } catch (error) {
            if (error instanceof GraphRecursionError) {
              await this.reportFailure(
                sessionId,
                resolutionId,
                'RECURSION_LIMIT',
                opts.actorId,
                opts.callbacks,
              );
            } else {
              this.logger.error(
                `graph run failed: ${error instanceof Error ? error.stack : error}`,
              );
              await this.reportFailure(
                sessionId,
                resolutionId,
                'INTERNAL',
                opts.actorId,
                opts.callbacks,
              );
            }
            return;
          }

          const interruptValue = state.__interrupt__?.[0]?.value as RollAsk | undefined;
          if (interruptValue) {
            parked = await this.parkForRoll(
              sessionId,
              session,
              resolutionId,
              interruptValue,
              opts.actorId,
              dmActor,
              opts.callbacks,
            );
            return;
          }
          if (state.failure) {
            await this.reportFailure(
              sessionId,
              resolutionId,
              state.failure.reason,
              opts.actorId,
              opts.callbacks,
            );
            return;
          }
          await this.commit(
            sessionId,
            session,
            resolutionId,
            state,
            sourced,
            opts.actorId,
            dmActor,
            opts.callbacks,
            span,
          );
        } finally {
          this.active.delete(sessionId);
          this.streamHandlers.delete(resolutionId);
          if (!parked) await this.deleteThread(resolutionId);
        }
      },
    );
  }

  private async parkForRoll(
    sessionId: string,
    session: SessionRow,
    resolutionId: string,
    ask: RollAsk,
    actorId: string,
    dmActor: { type: 'dm'; id: string },
    callbacks: DmTriggerCallbacks,
  ): Promise<boolean> {
    const [campaign] = await this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, session.campaignId))
      .limit(1);
    if (!campaign) return false;
    const actionId = randomUUID();

    const { events } = await this.sessionService.runCommand(
      {
        commandId: `${resolutionId}:ask`,
        sessionId,
        senderId: actorId,
        type: 'DM_ROLL_REQUEST',
        expectedStateVersion: null,
        mode: 'mutation',
      },
      () => [
        {
          type: 'ROLL_REQUESTED',
          payload: {
            pending_action_id: actionId,
            prompt: ask.prompt,
            expression: ask.expression,
            authorized_character_ids: ask.characterIds,
          },
          actor: dmActor,
          source: { type: 'resolution', id: resolutionId },
        },
      ],
      async (tx, _appended, _stateVersion, row) => {
        await this.sessionService.setStatus(tx, row, 'WAITING_FOR_ROLL');
        await tx.insert(pendingActions).values({
          id: actionId,
          sessionId,
          type: 'roll',
          // The DM is not a user, and this column must be. The campaign owner
          // is the recorded requester; roll authorization is by character
          // (M5.5), so the requester row is provenance, not a gate.
          requesterId: campaign.ownerUserId,
          authorizedCharacterIds: ask.characterIds,
          payload: { prompt: ask.prompt, expression: ask.expression },
          resolutionId,
          graphThreadId: resolutionId,
        });
      },
    );
    callbacks.events(events);
    this.logger.log(
      `session ${sessionId} parked on roll (${actionId}); checkpoint kept for ${resolutionId}`,
    );
    return true;
  }

  private async resumeFromRoll(
    sessionId: string,
    resolutionId: string,
    actionId: string,
    actorId: string,
    callbacks: DmTriggerCallbacks,
  ): Promise<void> {
    const session = await this.sessionService.find(sessionId);
    if (!session) return;
    if (this.active.has(sessionId)) {
      this.logger.warn(
        `roll resume dropped: a resolution is already running for session ${sessionId}`,
      );
      return;
    }

    await withSpan(
      'dm.resolution.resume',
      { campaign_id: session.campaignId, session_id: sessionId, resolution_id: resolutionId },
      async (span) => {
        const sourced = this.providerSource.get();
        if (!sourced) {
          await this.reportFailure(sessionId, resolutionId, 'NO_PROVIDER', actorId, callbacks);
          return;
        }
        span.setAttribute('model', sourced.provider.model);

        const [roll] = await this.db
          .select()
          .from(rolls)
          .where(eq(rolls.pendingActionId, actionId))
          .limit(1);
        if (!roll) {
          await this.reportFailure(sessionId, resolutionId, 'INTERNAL', actorId, callbacks);
          return;
        }
        const [character] = roll.characterId
          ? await this.db
              .select()
              .from(characters)
              .where(eq(characters.id, roll.characterId))
              .limit(1)
          : [];
        const rollResult: RollResult = {
          character: character?.name ?? 'A character',
          expression: roll.expression,
          dice: roll.dice,
          modifiers: roll.modifiers as Array<{ source: string; value: number }>,
          total: roll.total,
        };

        this.active.set(sessionId, resolutionId);
        this.streamHandlers.set(resolutionId, callbacks.stream);
        const dmActor = { type: 'dm' as const, id: session.campaignId };
        let parked = false;

        try {
          const infra = await this.ensureGraph();
          if (!infra) {
            await this.reportFailure(sessionId, resolutionId, 'INTERNAL', actorId, callbacks);
            return;
          }
          const { graph } = infra;

          await this.sessionService.runCommand(
            {
              commandId: `${resolutionId}:resume`,
              sessionId,
              senderId: actorId,
              type: 'DM_RESOLUTION_RESUME',
              expectedStateVersion: null,
              mode: 'mutation',
            },
            (row) => [
              {
                type: 'SESSION_STATE_CHANGED',
                payload: { action: 'DM_RESOLUTION', from: row.status, to: 'DM_GENERATING' },
                actor: dmActor,
                source: { type: 'resolution', id: resolutionId },
              },
            ],
            async (tx, _appended, _stateVersion, row) => {
              await this.sessionService.setStatus(tx, row, 'DM_GENERATING');
            },
          );

          let state: DmGraphState & { __interrupt__?: Array<{ value: unknown }> };
          try {
            state = (await graph.invoke(new Command({ resume: rollResult }), {
              configurable: { thread_id: resolutionId },
              recursionLimit: GRAPH_RECURSION_LIMIT,
            })) as DmGraphState & { __interrupt__?: Array<{ value: unknown }> };
          } catch (error) {
            if (error instanceof GraphRecursionError) {
              await this.reportFailure(
                sessionId,
                resolutionId,
                'RECURSION_LIMIT',
                actorId,
                callbacks,
              );
            } else {
              this.logger.error(
                `graph resume failed: ${error instanceof Error ? error.stack : error}`,
              );
              await this.reportFailure(sessionId, resolutionId, 'INTERNAL', actorId, callbacks);
            }
            return;
          }

          const interruptValue = state.__interrupt__?.[0]?.value as RollAsk | undefined;
          if (interruptValue) {
            parked = await this.parkForRoll(
              sessionId,
              session,
              resolutionId,
              interruptValue,
              actorId,
              dmActor,
              callbacks,
            );
            return;
          }
          if (state.failure) {
            await this.reportFailure(
              sessionId,
              resolutionId,
              state.failure.reason,
              actorId,
              callbacks,
            );
            return;
          }
          await this.commit(
            sessionId,
            session,
            resolutionId,
            state,
            sourced,
            actorId,
            dmActor,
            callbacks,
            span,
          );
        } finally {
          this.active.delete(sessionId);
          this.streamHandlers.delete(resolutionId);
          if (!parked) await this.deleteThread(resolutionId);
        }
      },
    );
  }

  /**
   * The whole point of invariant 4: narration and mutation commit together.
   * Validation runs inside the resolution, under the lock; a rejected proposal
   * rolls back the narration with it, and the table is told the turn failed
   * rather than being shown a story whose ending was refused.
   */
  private async commit(
    sessionId: string,
    session: SessionRow,
    resolutionId: string,
    state: DmGraphState,
    sourced: { provider: DmProvider; config: DmProviderConfig },
    actorId: string,
    dmActor: { type: 'dm'; id: string },
    callbacks: DmTriggerCallbacks,
    span: import('@opentelemetry/api').Span,
  ): Promise<void> {
    const output = state.proposal!;
    const { narration, usage, contextPackage } = state;

    try {
      const { events } = await this.sessionService.runCommand(
        {
          commandId: `${resolutionId}:commit`,
          sessionId,
          senderId: actorId,
          type: 'DM_RESOLUTION_COMMIT',
          expectedStateVersion: null,
          mode: 'mutation',
        },
        async (row, tx) => {
          const errors = await this.validateProposals(tx, row, output);
          if (errors.length > 0) {
            throw new ConflictException({
              code: 'MUTATION_VALIDATION_FAILED',
              message: errors.join('; '),
            });
          }
          return [
            {
              type: 'DM_NARRATION',
              payload: {
                resolution_id: resolutionId,
                entry_profile: state.trigger.entryProfile,
                definition_id: state.trigger.definitionId,
                narration,
                addressed_to: output.addressed_to,
                proposed_state_changes: output.proposed_state_changes,
                memory_candidates: output.memory_candidates,
                usage: usage
                  ? {
                      input_tokens: usage.inputTokens,
                      output_tokens: usage.outputTokens,
                      cache_read_tokens: usage.cacheReadTokens,
                    }
                  : null,
                layer_tokens: contextPackage?.layerTokens ?? {},
              },
              actor: dmActor,
              source: { type: 'resolution', id: resolutionId },
            },
            {
              type: 'SESSION_STATE_CHANGED',
              payload: { action: 'DM_RESOLUTION', from: row.status, to: 'WAITING_FOR_PLAYERS' },
              actor: dmActor,
              source: { type: 'resolution', id: resolutionId },
            },
          ];
        },
        async (tx, _appended, _stateVersion, row) => {
          for (const proposal of output.proposed_state_changes) {
            await this.applyProposal(tx, row, proposal);
          }
          await this.sessionService.setStatus(tx, row, 'WAITING_FOR_PLAYERS');
        },
      );

      if (usage) {
        span.setAttributes({
          'dm.input_tokens': usage.inputTokens,
          'dm.output_tokens': usage.outputTokens,
          'dm.cache_read_tokens': usage.cacheReadTokens,
          ...(contextPackage
            ? Object.fromEntries(
                Object.entries(contextPackage.layerTokens).map(([layer, tokens]) => [
                  `dm.layer.${layer}`,
                  tokens,
                ]),
              )
            : {}),
          ...(() => {
            const cost = estimateUsd(sourced.provider.model, {
              input: usage.inputTokens,
              output: usage.outputTokens,
              cacheRead: usage.cacheReadTokens,
            });
            return cost === null ? {} : { 'dm.cost_usd': cost };
          })(),
        });
      }
      callbacks.events(events);
    } catch (error) {
      const rejected = error instanceof ConflictException;
      this.logger.warn(
        `resolution ${resolutionId} not committed: ${error instanceof Error ? error.message : error}`,
      );
      await this.reportFailure(
        sessionId,
        resolutionId,
        rejected ? 'MUTATION_REJECTED' : 'INTERNAL',
        actorId,
        callbacks,
      );
    }
  }

  /**
   * Validates a proposal set against the state read under the commit lock.
   * Errors are table-safe strings: names and quantities a player can see,
   * never stack traces or ids that could be replayed.
   */
  private async validateProposals(
    tx: Tx,
    session: SessionRow,
    output: DmOutput,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (output.proposed_state_changes.length === 0) return [];

    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, session.campaignId))
      .limit(1);
    const settings = (campaign?.settings ?? {}) as { items?: unknown };
    const items = Array.isArray(settings.items) ? (settings.items as string[]) : [];
    const characterRows = await tx
      .select()
      .from(characters)
      .where(eq(characters.campaignId, session.campaignId));
    const byId = new Map(characterRows.map((row) => [row.id, row]));

    for (const proposal of output.proposed_state_changes) {
      switch (proposal.operation) {
        case 'set_scene': {
          const id = proposal.payload.id;
          if (typeof id !== 'string' || id.length === 0 || id.length > 120) {
            errors.push('set_scene: payload.id must be a scene id');
          }
          break;
        }
        case 'adjust_hp': {
          const delta = proposal.payload.delta;
          if (!Number.isInteger(delta) || (delta as number) === 0) {
            errors.push('adjust_hp: payload.delta must be a nonzero integer');
            break;
          }
          const target = byId.get(proposal.target_id);
          if (!target) {
            errors.push(`adjust_hp: unknown character`);
            break;
          }
          const sheet = target.sheet as CharacterSheet;
          const next = (sheet.currentHp ?? sheet.maxHp) + (delta as number);
          if (next < 0 || next > sheet.maxHp) {
            errors.push(
              `adjust_hp: would move ${target.name} to ${next} HP, outside 0..${sheet.maxHp}`,
            );
          }
          break;
        }
        case 'add_item':
        case 'remove_item': {
          const { name, quantity } = proposal.payload as { name?: unknown; quantity?: unknown };
          if (typeof name !== 'string' || name.length === 0) {
            errors.push(`${proposal.operation}: payload.name is required`);
            break;
          }
          if (!Number.isInteger(quantity) || (quantity as number) < 1) {
            errors.push(`${proposal.operation}: payload.quantity must be a positive integer`);
            break;
          }
          if (!items.includes(name)) {
            errors.push(`${proposal.operation}: "${name}" is not in this campaign's item list`);
            break;
          }
          if (proposal.operation === 'remove_item') {
            const target = byId.get(proposal.target_id);
            if (!target) {
              errors.push(`remove_item: unknown character`);
              break;
            }
            const have = (target.sheet as CharacterSheet).inventory
              .filter((item) => item.name === name)
              .reduce((sum, item) => sum + item.quantity, 0);
            if (have < (quantity as number)) {
              errors.push(`remove_item: ${target.name} has ${have} of "${name}"`);
            }
          }
          break;
        }
      }
    }
    return errors;
  }

  /** The write path. Reached only after validateProposals passed on the same locked read. */
  private async applyProposal(
    tx: Tx,
    session: SessionRow,
    proposal: ProposedStateChange,
  ): Promise<void> {
    switch (proposal.operation) {
      case 'set_scene':
        // validateProposals already proved it is a string.
        await tx
          .update(sessions)
          .set({ sceneId: proposal.payload.id as string })
          .where(eq(sessions.id, session.id));
        return;
      case 'adjust_hp': {
        const [target] = await tx
          .select()
          .from(characters)
          .where(eq(characters.id, proposal.target_id))
          .limit(1);
        if (!target) return;
        const sheet = target.sheet as CharacterSheet;
        const next = (sheet.currentHp ?? sheet.maxHp) + (proposal.payload.delta as number);
        await tx
          .update(characters)
          .set({ sheet: { ...sheet, currentHp: next }, stateVersion: target.stateVersion + 1 })
          .where(eq(characters.id, target.id));
        return;
      }
      case 'add_item':
      case 'remove_item': {
        const [target] = await tx
          .select()
          .from(characters)
          .where(eq(characters.id, proposal.target_id))
          .limit(1);
        if (!target) return;
        const sheet = target.sheet as CharacterSheet;
        const { name } = proposal.payload as { name: string };
        const quantity = proposal.payload.quantity as number;
        const inventory = [...sheet.inventory];
        const at = inventory.findIndex((item) => item.name === name);
        const existing = inventory[at];
        if (proposal.operation === 'add_item') {
          if (!existing) inventory.push({ name, quantity, equipped: false });
          else inventory[at] = { ...existing, quantity: existing.quantity + quantity };
        } else if (existing) {
          const remaining = existing.quantity - quantity;
          if (remaining <= 0) inventory.splice(at, 1);
          else inventory[at] = { ...existing, quantity: remaining };
        }
        await tx
          .update(characters)
          .set({ sheet: { ...sheet, inventory }, stateVersion: target.stateVersion + 1 })
          .where(eq(characters.id, target.id));
        return;
      }
    }
  }

  /**
   * A resolution that ends without a commit. The message on the event is
   * static per reason — provider error text can carry URLs and identifiers
   * that are not for the table — while the raw detail goes to the log.
   */
  async reportFailure(
    sessionId: string,
    resolutionId: string | null,
    reason: DmFailureReason,
    actorId: string,
    callbacks: DmTriggerCallbacks,
  ): Promise<void> {
    const session = await this.sessionService.find(sessionId);
    if (!session) return;
    const message: Record<DmFailureReason, string> = {
      NO_PROVIDER: 'The DM is not configured for this table yet.',
      PROVIDER_ERROR: 'The DM service had a problem and the turn was not committed.',
      INVALID_OUTPUT:
        'The DM could not produce a well-formed answer, and the turn was not committed.',
      MUTATION_REJECTED:
        'The DM proposed a change the table does not allow; the whole turn was retracted.',
      RECURSION_LIMIT: 'The DM did not finish its turn in time.',
      INTERNAL: 'Something went wrong with the DM turn.',
    };
    const dmActor = { type: 'dm' as const, id: session.campaignId };
    const source = resolutionId
      ? { type: 'resolution' as const, id: resolutionId }
      : { type: 'system' as const, id: 'dm' };

    try {
      const { events } = await this.sessionService.runCommand(
        {
          // Fresh id per failure: two real failures in a row must both be
          // recorded, and idempotency is for client replays, not for the DM.
          commandId: `dm-fail-${randomUUID()}`,
          sessionId,
          senderId: actorId,
          type: 'DM_RESOLUTION_FAILED',
          expectedStateVersion: null,
          mode: 'mutation',
        },
        (row) => {
          const generating = row.status === 'DM_GENERATING' || row.status === 'WAITING_FOR_ROLL';
          const drafts: EventDraft[] = [
            {
              type: 'DM_RESOLUTION_FAILED',
              payload: { resolution_id: resolutionId, reason, message: message[reason] },
              actor: dmActor,
              source,
            },
          ];
          if (generating) {
            drafts.push({
              type: 'SESSION_STATE_CHANGED',
              payload: { action: 'DM_RESOLUTION', from: row.status, to: 'WAITING_FOR_PLAYERS' },
              actor: dmActor,
              source,
            });
          }
          return drafts;
        },
        async (tx, _appended, _stateVersion, row) => {
          if (row.status === 'DM_GENERATING' || row.status === 'WAITING_FOR_ROLL') {
            await this.sessionService.setStatus(tx, row, 'WAITING_FOR_PLAYERS');
          }
        },
      );
      callbacks.events(events);
    } catch (error) {
      this.logger.error(
        `could not record DM failure for session ${sessionId}: ${error instanceof Error ? error.message : error}`,
      );
    }
    await this.deleteThread(resolutionId);
  }
}
