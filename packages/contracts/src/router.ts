/**
 * The deterministic router (M3.1, FR-202, FR-206). A pure function: no I/O, no
 * LLM, no async, no clock.
 *
 * It lives in `packages/contracts` rather than the API because the composer
 * needs the same answer before send — the visibility badge and the "this will
 * wake the DM" affordance (FR-209, M3.5). A second implementation on the client
 * is exactly the drift that would break FR-202.
 */
// Types only: a value import from './index' would close a runtime cycle, since
// index.ts re-exports this module.
import type {
  Channel,
  GraphEntryProfile,
  MembershipRole,
  RecipientType,
  TriggerDefinition,
  Visibility,
} from './index';

/**
 * The MVP trigger set (MVP.md §4.1), in match order — rule 6, first match wins.
 * Per-campaign enable/disable overrides these in `campaigns.settings.triggers`.
 */
export const TRIGGER_REGISTRY: readonly TriggerDefinition[] = [
  {
    id: 'dm_mention',
    kind: 'mention_tag',
    match: { tag: '@dm', argument: 'text' },
    entryProfile: 'resolve_action',
    requiredScope: 'member',
    defaultEnabled: true,
  },
  {
    id: 'npc_mention',
    kind: 'mention_tag',
    match: { tag: '@npc', argument: 'entity' },
    entryProfile: 'npc_dialogue',
    requiredScope: 'member',
    defaultEnabled: true,
  },
  {
    id: 'ask_command',
    kind: 'command_tag',
    match: { tag: '/ask', argument: 'text' },
    entryProfile: 'rules_answer',
    requiredScope: 'member',
    defaultEnabled: true,
  },
  {
    id: 'recap_command',
    kind: 'command_tag',
    match: { tag: '/recap', argument: 'none' },
    entryProfile: 'recap',
    requiredScope: 'member',
    defaultEnabled: true,
  },
  {
    id: 'pending_action_completed',
    kind: 'pending_action_completed',
    entryProfile: 'resolve_action',
    requiredScope: 'member',
    defaultEnabled: true,
  },
  {
    id: 'host_turn',
    kind: 'host_control',
    entryProfile: 'resolve_action',
    requiredScope: 'host',
    defaultEnabled: true,
  },
];

export type RosterMember = {
  userId: string;
  /** Unique within the campaign and never equal to a registered tag (rule 3). */
  handle: string;
  displayName: string;
  role: MembershipRole;
};

/** Campaign NPCs, from `campaign_notes` once M8 lands; empty until then. */
export type RosterNpc = { id: string; name: string; aliases: string[] };

export type Roster = { members: RosterMember[]; npcs: RosterNpc[] };

export type DmTrigger = {
  definitionId: string;
  entryProfile: GraphEntryProfile;
  args: { text: string; entityId?: string };
};

export type RoutingRejectionCode =
  | 'UNKNOWN_NPC'
  | 'AMBIGUOUS_NPC'
  | 'UNKNOWN_PLAYER'
  | 'EMPTY_TRIGGER'
  | 'SCOPE_DENIED'
  | 'EMPTY_MESSAGE';

export type RoutingDecision =
  | {
      kind: 'route';
      recipientType: RecipientType;
      recipientIds: string[];
      visibility: Visibility;
      channel: Channel;
      content: string;
      /** The text after the leading tag, so callers need not re-split it. */
      argument: string;
      dmTrigger?: DmTrigger;
    }
  | { kind: 'reject'; code: RoutingRejectionCode; message: string };

const RESERVED_HANDLES = new Set(['party', 'dm', 'npc', 'all', 'everyone']);

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Rule 3: the registry wins. A player called "DM" is addressed by a
 * disambiguated handle rather than shadowing `@dm`, and two players who
 * normalize to the same handle are separated by a slice of their id.
 */
export function buildRoster(
  members: Array<{ userId: string; displayName: string; role: MembershipRole }>,
  npcs: RosterNpc[] = [],
): Roster {
  const taken = new Set<string>();
  const built: RosterMember[] = [];

  for (const member of members) {
    const base = normalize(member.displayName) || 'player';
    let handle = base;

    if (RESERVED_HANDLES.has(handle) || taken.has(handle)) {
      handle = `${base}-${member.userId.replace(/-/g, '').slice(0, 4)}`;
    }
    // Still colliding only if two ids share a prefix; the full id always works.
    if (RESERVED_HANDLES.has(handle) || taken.has(handle)) {
      handle = `${base}-${member.userId.replace(/-/g, '')}`;
    }

    taken.add(handle);
    built.push({
      userId: member.userId,
      handle,
      displayName: member.displayName,
      role: member.role,
    });
  }

  return { members: built, npcs };
}

/** Splits "@dm I inspect the altar" into "@dm" and "I inspect the altar". */
function head(raw: string): { tag: string; rest: string } {
  // Leading whitespace is trimmed — a stray space before "@dm" is a typo, not a
  // different intent. A tag anywhere else in the message still does not fire.
  const text = raw.replace(/^\s+/, '');
  const boundary = text.search(/\s/);
  return boundary === -1
    ? { tag: text, rest: '' }
    : { tag: text.slice(0, boundary), rest: text.slice(boundary + 1).trim() };
}

const table = (content: string): RoutingDecision => ({
  kind: 'route',
  recipientType: 'table',
  recipientIds: [],
  visibility: 'public',
  channel: 'in_character',
  content,
  argument: content,
});

function resolveNpc(roster: Roster, name: string): RosterNpc[] {
  const needle = name.toLowerCase();
  const byName = roster.npcs.filter((npc) => npc.name.toLowerCase() === needle);
  if (byName.length > 0) return byName;
  return roster.npcs.filter((npc) => npc.aliases.some((a) => a.toLowerCase() === needle));
}

export function parseMessage(
  raw: string,
  roster: Roster,
  registry: readonly TriggerDefinition[] = TRIGGER_REGISTRY,
  sender: { role: MembershipRole } = { role: 'player' },
): RoutingDecision {
  const content = raw.trim();
  if (content.length === 0) {
    return { kind: 'reject', code: 'EMPTY_MESSAGE', message: 'A message needs some text.' };
  }

  const { tag, rest } = head(content);
  const lowerTag = tag.toLowerCase();

  // 1. Registered triggers first, in registry order — rule 6, first match wins.
  //    A disabled trigger is simply absent from `registry`, so it behaves
  //    exactly like an unknown tag (rule 7).
  const definition = registry.find(
    (d) =>
      (d.kind === 'mention_tag' || d.kind === 'command_tag') &&
      d.match?.tag.toLowerCase() === lowerTag,
  );

  if (definition?.match) {
    // Rule 5: scope is checked here, before any graph run and before any spend.
    if (definition.requiredScope === 'host' && sender.role !== 'host' && sender.role !== 'admin') {
      return {
        kind: 'reject',
        code: 'SCOPE_DENIED',
        message: `${tag} is available to the host only.`,
      };
    }

    if (definition.match.argument === 'entity') {
      const { tag: name, rest: speech } = head(rest);
      if (name.length === 0) {
        return {
          kind: 'reject',
          code: 'UNKNOWN_NPC',
          message: `${tag} needs a name, as in "${tag} Klarg hello".`,
        };
      }

      // Rule 4: exact name, then unique alias. Anything else is not a trigger,
      // and the player is told which it was.
      const matches = resolveNpc(roster, name);
      if (matches.length === 0) {
        return { kind: 'reject', code: 'UNKNOWN_NPC', message: `No NPC here is called "${name}".` };
      }
      if (matches.length > 1) {
        return {
          kind: 'reject',
          code: 'AMBIGUOUS_NPC',
          message: `"${name}" matches ${matches.length} NPCs. Use their full name.`,
        };
      }

      return {
        kind: 'route',
        recipientType: 'dm',
        recipientIds: [],
        visibility: 'public',
        channel: 'in_character',
        content,
        argument: speech,
        dmTrigger: {
          definitionId: definition.id,
          entryProfile: definition.entryProfile,
          args: { text: speech, entityId: matches[0]!.id },
        },
      };
    }

    if (definition.match.argument === 'text' && rest.length === 0) {
      return {
        kind: 'reject',
        code: 'EMPTY_TRIGGER',
        message: `${tag} needs something after it.`,
      };
    }

    return {
      kind: 'route',
      recipientType: 'dm',
      recipientIds: [],
      visibility: 'public',
      channel: 'in_character',
      content,
      argument: rest,
      dmTrigger: {
        definitionId: definition.id,
        entryProfile: definition.entryProfile,
        args: { text: rest },
      },
    };
  }

  // 2. Built-in non-trigger routes. None of these wake the DM (FR-304, FR-207).
  switch (lowerTag) {
    case '/roll':
      return {
        kind: 'route',
        recipientType: 'dice',
        recipientIds: [],
        visibility: 'public',
        channel: 'in_character',
        content,
        argument: rest,
      };
    case '/sheet':
      return {
        kind: 'route',
        recipientType: 'sheet',
        recipientIds: [],
        visibility: 'public',
        channel: 'in_character',
        content,
        argument: rest,
      };
    case '/ooc':
      return {
        kind: 'route',
        recipientType: 'ooc',
        recipientIds: [],
        visibility: 'public',
        channel: 'ooc',
        content,
        argument: rest,
      };
    case '/whisper': {
      const { tag: target, rest: body } = head(rest);
      const member = roster.members.find(
        (m) => `@${m.handle}` === target.toLowerCase() || m.handle === target.toLowerCase(),
      );
      if (!member) {
        return {
          kind: 'reject',
          code: 'UNKNOWN_PLAYER',
          message: `No one here is called "${target}".`,
        };
      }
      return {
        kind: 'route',
        recipientType: 'whisper',
        recipientIds: [member.userId],
        visibility: 'private',
        channel: 'in_character',
        content: body,
        argument: body,
      };
    }
  }

  if (lowerTag === '@party') {
    return {
      kind: 'route',
      recipientType: 'party',
      recipientIds: roster.members.map((m) => m.userId),
      visibility: 'public',
      channel: 'in_character',
      content,
      argument: rest,
    };
  }

  if (lowerTag.startsWith('@')) {
    const member = roster.members.find((m) => m.handle === lowerTag.slice(1));
    if (member) {
      return {
        kind: 'route',
        recipientType: 'player',
        recipientIds: [member.userId],
        visibility: 'public',
        channel: 'in_character',
        content,
        argument: rest,
      };
    }
  }

  // 3. Rule 2: an unknown tag falls through to table chat. No error, no DM call,
  //    and not a dead end — the message is still delivered as typed.
  return table(content);
}
