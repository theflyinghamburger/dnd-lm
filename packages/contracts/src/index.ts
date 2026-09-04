/**
 * The only definitions of the wire shapes. No module redeclares a shape here.
 *
 * Envelopes: spec-doc.md §9. DmOutput: architecture.md §6.4.
 * TriggerDefinition: MVP.md §4.2. Task M0.3.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                          */
/* -------------------------------------------------------------------------- */

export const Id = z.string().min(1);

/** Where the router sent a message (MVP.md §5 M3.1 table, architecture.md §6.2). */
export const RecipientType = z.enum([
  'dm',
  'player',
  'party',
  'table',
  'dice',
  'sheet',
  'ooc',
  'whisper',
]);
export type RecipientType = z.infer<typeof RecipientType>;

export const Channel = z.enum(['in_character', 'ooc']);
export type Channel = z.infer<typeof Channel>;

/** `private` covers whispers and secret rolls; fanout is computed server-side (M3.4). */
export const Visibility = z.enum(['public', 'private']);
export type Visibility = z.infer<typeof Visibility>;

/** MVP subset of architecture.md §6.3 (MVP.md M5.1). Combat states are Phase 3. */
export const SessionState = z.enum([
  'WAITING_FOR_PLAYERS',
  'DM_GENERATING',
  'WAITING_FOR_ROLL',
  'PAUSED',
  'SESSION_ENDED',
]);
export type SessionState = z.infer<typeof SessionState>;

/* -------------------------------------------------------------------------- */
/* 9.1 Client command envelope                                                */
/* -------------------------------------------------------------------------- */

/**
 * `sender_id` is deliberately absent: the server derives it from the
 * authenticated connection and never trusts the payload (spec-doc.md §9.1).
 */
const commandBase = {
  command_id: Id,
  session_id: Id,
  expected_state_version: z.int().nonnegative(),
};

/**
 * State-mutating commands only. RESUME is deliberately not one: it mutates
 * nothing, so carrying `expected_state_version` would be a lie (see ResumeRequest).
 */
export const ClientCommand = z.discriminatedUnion('type', [
  z.object({
    ...commandBase,
    type: z.literal('SEND_MESSAGE'),
    payload: z.object({ content: z.string().min(1).max(4000), channel: Channel }),
  }),
  z.object({
    ...commandBase,
    type: z.literal('ROLL_DICE'),
    payload: z.object({ expression: z.string().min(1).max(64), character_id: Id.optional() }),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

/* -------------------------------------------------------------------------- */
/* 9.2 Message record                                                         */
/* -------------------------------------------------------------------------- */

export const MessageRecord = z.object({
  message_id: Id,
  session_id: Id,
  sender_id: Id,
  recipient_type: RecipientType,
  recipient_ids: z.array(Id),
  visibility: Visibility,
  channel: Channel,
  triggers_dm: z.boolean(),
  /** Which registered trigger fired, so "why did the DM run?" is answerable from the row (M3.3). */
  trigger_definition_id: Id.nullable().default(null),
  sequence: z.int().nonnegative(),
  content: z.string(),
});
export type MessageRecord = z.infer<typeof MessageRecord>;

/* -------------------------------------------------------------------------- */
/* 9.3 Roll result                                                            */
/* -------------------------------------------------------------------------- */

/** Full modifier provenance is a requirement, not a UI nicety (FR-302). */
export const RollModifier = z.object({ source: z.string().min(1), value: z.int() });
export type RollModifier = z.infer<typeof RollModifier>;

export const RollResult = z.object({
  roll_id: Id,
  expression: z.string().min(1),
  dice: z.array(z.int().positive()),
  modifiers: z.array(RollModifier),
  total: z.int(),
  visibility: Visibility,
  state_version: z.int().nonnegative(),
});
export type RollResult = z.infer<typeof RollResult>;

/* -------------------------------------------------------------------------- */
/* 9.4 Authoritative event envelope                                           */
/* -------------------------------------------------------------------------- */

export const ActorRef = z.object({
  type: z.enum(['character', 'player', 'host', 'dm', 'system']),
  id: Id,
});
export type ActorRef = z.infer<typeof ActorRef>;

export const SourceRef = z.object({
  type: z.enum(['resolution', 'command', 'system']),
  id: Id,
});
export type SourceRef = z.infer<typeof SourceRef>;

/** `type` stays open: event types are domain vocabulary, added per milestone. */
export const EventEnvelope = z.object({
  event_id: Id,
  type: z.string().min(1),
  campaign_id: Id,
  session_id: Id,
  sequence: z.int().nonnegative(),
  state_version: z.int().nonnegative(),
  actor: ActorRef,
  source: SourceRef,
  payload: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/* -------------------------------------------------------------------------- */
/* DM output (architecture.md §6.4)                                           */
/* -------------------------------------------------------------------------- */

/**
 * A *proposal*, never a commit. The orchestrator validates every entry against
 * permissions and current state before anything touches the database (FR-503,
 * FR-505). M6.5 tightens `operation` into a closed union once the mutating tool
 * set exists; until then the validator is the only thing that may accept one.
 */
export const ProposedStateChange = z.object({
  operation: z.string().min(1),
  target_id: Id,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type ProposedStateChange = z.infer<typeof ProposedStateChange>;

export const MemoryCandidate = z.object({
  fact: z.string().min(1),
  importance: z.number().min(0).max(1),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;

export const ToolRequest = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolRequest = z.infer<typeof ToolRequest>;

export const DmOutput = z.object({
  narration: z.string(),
  addressed_to: z.array(z.string().min(1)),
  tool_requests: z.array(ToolRequest).default([]),
  proposed_state_changes: z.array(ProposedStateChange).default([]),
  memory_candidates: z.array(MemoryCandidate).default([]),
  next_state: SessionState,
});
export type DmOutput = z.infer<typeof DmOutput>;

/* -------------------------------------------------------------------------- */
/* Trigger registry (MVP.md §4.2)                                             */
/* -------------------------------------------------------------------------- */

export const GraphEntryProfile = z.enum([
  'resolve_action',
  'npc_dialogue',
  'rules_answer',
  'recap',
]);
export type GraphEntryProfile = z.infer<typeof GraphEntryProfile>;

export const TriggerKind = z.enum([
  'mention_tag',
  'command_tag',
  'pending_action_completed',
  'host_control',
]);
export type TriggerKind = z.infer<typeof TriggerKind>;

/** Registry rows are data. Adding a trigger is a row, never a branch in the router (D-6). */
export const TriggerDefinition = z
  .object({
    id: Id,
    kind: TriggerKind,
    /** Absent for triggers that no message can carry: a resumed roll, a host turn. */
    match: z
      .object({
        tag: z.string().min(1),
        argument: z.enum(['none', 'entity', 'text']).optional(),
      })
      .optional(),
    entryProfile: GraphEntryProfile,
    requiredScope: z.enum(['member', 'host']),
    defaultEnabled: z.boolean(),
  })
  .refine((d) => d.match !== undefined || (d.kind !== 'mention_tag' && d.kind !== 'command_tag'), {
    message: 'a mention_tag or command_tag trigger needs a match',
    path: ['match'],
  });
export type TriggerDefinition = z.infer<typeof TriggerDefinition>;

/* -------------------------------------------------------------------------- */
/* Identity, campaigns, memberships (M1)                                      */
/* -------------------------------------------------------------------------- */

export const MembershipRole = z.enum(['player', 'host', 'admin']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const RegisterRequest = z.object({
  email: z.email().max(254).toLowerCase(),
  displayName: z.string().min(1).max(64),
  password: z.string().min(12).max(256),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.email().max(254).toLowerCase(),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** What the API is allowed to say about a user. There is no password field here on purpose. */
export const PublicUser = z.object({
  id: Id,
  email: z.email(),
  displayName: z.string(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const CreateCampaignRequest = z.object({
  name: z.string().min(1).max(120),
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequest>;

export const CampaignSummary = z.object({
  id: Id,
  name: z.string(),
  ownerUserId: Id,
  role: MembershipRole,
  createdAt: z.iso.datetime(),
});
export type CampaignSummary = z.infer<typeof CampaignSummary>;

export const CreateInviteRequest = z.object({
  role: MembershipRole.exclude(['admin']).default('player'),
  expiresInHours: z.int().min(1).max(720).default(168),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;

export const InviteResponse = z.object({
  token: z.string(),
  campaignId: Id,
  role: MembershipRole,
  expiresAt: z.iso.datetime(),
});
export type InviteResponse = z.infer<typeof InviteResponse>;

/* -------------------------------------------------------------------------- */
/* Realtime session protocol (M2)                                             */
/* -------------------------------------------------------------------------- */

export const SessionSnapshot = z.object({
  session_id: Id,
  campaign_id: Id,
  status: SessionState,
  state_version: z.int().nonnegative(),
  /** Highest sequence written. A fresh session has 0 and no events. */
  last_sequence: z.int().nonnegative(),
  scene_id: Id.nullable(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

/** M2.4. Not a `ClientCommand`: it takes no lock and changes no state. */
export const ResumeRequest = z.object({
  last_sequence: z.int().nonnegative(),
});
export type ResumeRequest = z.infer<typeof ResumeRequest>;

export const ResumeResponse = z.object({
  snapshot: SessionSnapshot,
  /** Strictly `sequence > last_sequence`, ascending, contiguous. */
  events: z.array(EventEnvelope),
});
export type ResumeResponse = z.infer<typeof ResumeResponse>;

/** Stored verbatim in `commands.result` and replayed on a duplicate command_id. */
export const CommandAck = z.object({
  command_id: Id,
  sequence: z.int().nonnegative(),
  state_version: z.int().nonnegative(),
});
export type CommandAck = z.infer<typeof CommandAck>;

export const ErrorCode = z.enum([
  'NOT_AUTHENTICATED',
  'NOT_A_MEMBER',
  'SESSION_NOT_FOUND',
  'INVALID_PAYLOAD',
  'RATE_LIMITED',
  'STATE_CONFLICT',
  'ROUTING_REJECTED',
  'NOT_YOUR_CHARACTER',
  'CHARACTER_NOT_FOUND',
  'CAMPAIGN_NOT_FOUND',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Rejections are always an explicit typed event — never a silent drop (M2.5). */
export const ServerError = z.object({
  code: ErrorCode,
  message: z.string(),
  command_id: Id.optional(),
  /** Present on STATE_CONFLICT so the client can refetch and retry (M5.4). */
  state_version: z.int().nonnegative().optional(),
  /** Present on ROUTING_REJECTED: which router rule refused, so the UI can be specific. */
  reason: z.string().optional(),
});
export type ServerError = z.infer<typeof ServerError>;

export const CreateSessionRequest = z.object({
  scene_id: Id.nullish(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export * from './dice';
export * from './router';
export * from './sheet';
export * from './srd';

/** Per-campaign trigger enable/disable (M3.2). Unlisted ids keep their default. */
export const UpdateTriggersRequest = z.object({
  triggers: z.record(z.string().min(1), z.boolean()),
});
export type UpdateTriggersRequest = z.infer<typeof UpdateTriggersRequest>;

export const CampaignTriggersResponse = z.object({
  triggers: z.array(
    z.object({
      id: Id,
      enabled: z.boolean(),
      entryProfile: GraphEntryProfile,
      tag: z.string().nullable(),
    }),
  ),
});
export type CampaignTriggersResponse = z.infer<typeof CampaignTriggersResponse>;

/**
 * The roster the server parses against, handed to the client so the composer's
 * preview and the server's decision cannot disagree about handles (M3.5).
 */
export const RosterResponse = z.object({
  members: z.array(
    z.object({ userId: Id, handle: z.string(), displayName: z.string(), role: MembershipRole }),
  ),
  npcs: z.array(z.object({ id: Id, name: z.string(), aliases: z.array(z.string()) })),
});
export type RosterResponse = z.infer<typeof RosterResponse>;
