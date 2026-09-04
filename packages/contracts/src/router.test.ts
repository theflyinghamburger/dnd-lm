import { describe, expect, it } from 'vitest';
import { TRIGGER_REGISTRY, type Roster, buildRoster, parseMessage } from './router';

const aria = { userId: 'u-aria', displayName: 'Aria', role: 'player' as const };
const brann = { userId: 'u-brann', displayName: 'Brann', role: 'player' as const };
const gm = { userId: 'u-gm', displayName: 'Ferris', role: 'host' as const };

const roster: Roster = buildRoster(
  [aria, brann, gm],
  [
    { id: 'npc.klarg', name: 'Klarg', aliases: ['Boss'] },
    { id: 'npc.sildar', name: 'Sildar Hallwinter', aliases: ['Sildar'] },
  ],
);

/** Narrow helper: every table row below asserts on a routed decision. */
function route(raw: string, sender = { role: 'player' as const }, reg = TRIGGER_REGISTRY) {
  const decision = parseMessage(raw, roster, reg, sender);
  if (decision.kind !== 'route') throw new Error(`expected a route, got ${decision.code}`);
  return decision;
}

function reject(raw: string, sender = { role: 'player' as const }, reg = TRIGGER_REGISTRY) {
  const decision = parseMessage(raw, roster, reg, sender);
  if (decision.kind !== 'reject') throw new Error('expected a rejection');
  return decision;
}

describe('parseMessage — the M3.1 table', () => {
  it.each([
    ['@dm I inspect the altar.', 'dm', 'dm_mention', 'resolve_action'],
    ['@npc Klarg We surrender.', 'dm', 'npc_mention', 'npc_dialogue'],
    ['/ask Does a shove need an action?', 'dm', 'ask_command', 'rules_answer'],
    ['/recap', 'dm', 'recap_command', 'recap'],
  ])('%s routes to %s and fires %s', (raw, recipientType, definitionId, entryProfile) => {
    const decision = route(raw);
    expect(decision.recipientType).toBe(recipientType);
    expect(decision.dmTrigger).toEqual({
      definitionId,
      entryProfile,
      args: expect.objectContaining({ text: expect.any(String) }),
    });
  });

  it.each([
    ['@aria Do you have the key?', 'player'],
    ['@party We should retreat.', 'party'],
    ['We should retreat.', 'table'],
    ['/roll perception', 'dice'],
    ['/sheet equip longsword', 'sheet'],
    ['/ooc We should stop at ten.', 'ooc'],
    ['/whisper @aria meet me outside', 'whisper'],
    ['@wizard hello?', 'table'],
    ['/dance', 'table'],
  ])('%s routes to %s and never wakes the DM', (raw, recipientType) => {
    const decision = route(raw);
    expect(decision.recipientType).toBe(recipientType);
    expect(decision.dmTrigger).toBeUndefined();
  });
});

describe('rule 1 — tag position is significant', () => {
  it('does not fire for a tag mid-message', () => {
    expect(route('I told the @dm about it').dmTrigger).toBeUndefined();
    expect(route('I told the @dm about it').recipientType).toBe('table');
  });

  it('does not fire for a tag inside a code span or a quotation', () => {
    expect(route('`@dm` is how you address the DM').dmTrigger).toBeUndefined();
    expect(route('"@dm I inspect the altar" is what I typed').dmTrigger).toBeUndefined();
  });

  it('tolerates leading whitespace — a stray space is a typo, not an intent', () => {
    expect(route('   @dm I inspect the altar').dmTrigger?.definitionId).toBe('dm_mention');
  });

  it('requires a word boundary after the tag', () => {
    expect(route('@dmitri hello').recipientType).toBe('table');
  });
});

describe('rule 2 — unknown tags fall through', () => {
  it('delivers the message as typed rather than erroring or dead-ending', () => {
    const decision = route('@wizard can you help');
    expect(decision.recipientType).toBe('table');
    expect(decision.content).toBe('@wizard can you help');
  });
});

describe('rule 3 — roster beats registry', () => {
  const shadowed = buildRoster([
    { userId: 'u-1111-2222', displayName: 'dm', role: 'player' },
    { userId: 'u-3333-4444', displayName: 'Aria', role: 'player' },
  ]);

  it('keeps @dm for the registry when a player is called "dm"', () => {
    const decision = parseMessage('@dm I inspect the altar', shadowed, TRIGGER_REGISTRY);
    expect(decision.kind === 'route' && decision.dmTrigger?.definitionId).toBe('dm_mention');
  });

  it('gives that player a disambiguated handle that still addresses them', () => {
    const player = shadowed.members.find((m) => m.displayName === 'dm')!;
    expect(player.handle).not.toBe('dm');

    const decision = parseMessage(`@${player.handle} hello`, shadowed, TRIGGER_REGISTRY);
    expect(decision.kind === 'route' && decision.recipientType).toBe('player');
    expect(decision.kind === 'route' && decision.recipientIds).toEqual(['u-1111-2222']);
  });

  it('separates two players whose display names normalize alike', () => {
    const twins = buildRoster([
      { userId: 'aaaa-1111', displayName: 'Aria', role: 'player' },
      { userId: 'bbbb-2222', displayName: 'aria', role: 'player' },
    ]);
    const handles = twins.members.map((m) => m.handle);
    expect(new Set(handles).size).toBe(2);
  });
});

describe('rule 4 — entity arguments resolve deterministically', () => {
  it('resolves an exact name', () => {
    expect(route('@npc Klarg we surrender').dmTrigger?.args.entityId).toBe('npc.klarg');
  });

  it('resolves a unique alias', () => {
    expect(route('@npc Boss we surrender').dmTrigger?.args.entityId).toBe('npc.klarg');
  });

  it('tells the player when the NPC is unknown, and fires nothing', () => {
    expect(reject('@npc Gandalf hello').code).toBe('UNKNOWN_NPC');
  });

  it('tells the player when a name is ambiguous, and fires nothing', () => {
    const ambiguous = buildRoster(
      [aria],
      [
        { id: 'npc.a', name: 'Grick', aliases: [] },
        { id: 'npc.b', name: 'Grick', aliases: [] },
      ],
    );
    const decision = parseMessage('@npc Grick hello', ambiguous, TRIGGER_REGISTRY);
    expect(decision.kind === 'reject' && decision.code).toBe('AMBIGUOUS_NPC');
  });

  it('asks for a name when none was given', () => {
    expect(reject('@npc').code).toBe('UNKNOWN_NPC');
  });
});

describe('rule 5 — scope is checked before activation', () => {
  const hostOnly = [
    {
      id: 'host_only_probe',
      kind: 'command_tag' as const,
      match: { tag: '/forceturn', argument: 'none' as const },
      entryProfile: 'resolve_action' as const,
      requiredScope: 'host' as const,
      defaultEnabled: true,
    },
  ];

  it('refuses a player firing a host-only trigger', () => {
    expect(reject('/forceturn', { role: 'player' }, hostOnly).code).toBe('SCOPE_DENIED');
  });

  it('allows the host', () => {
    const decision = parseMessage('/forceturn', roster, hostOnly, { role: 'host' });
    expect(decision.kind === 'route' && decision.dmTrigger?.definitionId).toBe('host_only_probe');
  });
});

describe('rule 6 — one trigger per message', () => {
  it('fires only the tag at position 0, never a second mention', () => {
    const decision = route('@dm ask @npc Klarg about the map');
    expect(decision.dmTrigger?.definitionId).toBe('dm_mention');
    expect(decision.dmTrigger?.args.text).toBe('ask @npc Klarg about the map');
  });
});

describe('rule 7 — disabled triggers are invisible', () => {
  it('treats a disabled trigger exactly like an unknown tag', () => {
    const withoutDm = TRIGGER_REGISTRY.filter((d) => d.id !== 'dm_mention');
    const decision = parseMessage('@dm I inspect the altar', roster, withoutDm);
    expect(decision.kind === 'route' && decision.recipientType).toBe('table');
    expect(decision.kind === 'route' && decision.dmTrigger).toBeUndefined();
  });
});

describe('visibility and privacy', () => {
  it('marks a whisper private and addresses only the target', () => {
    const decision = route('/whisper @aria meet me outside');
    expect(decision.visibility).toBe('private');
    expect(decision.recipientIds).toEqual(['u-aria']);
    expect(decision.content).toBe('meet me outside');
  });

  it('rejects a whisper to someone not in this session', () => {
    expect(reject('/whisper @nobody hello').code).toBe('UNKNOWN_PLAYER');
  });

  it('puts /ooc on the out-of-character channel and keeps it public', () => {
    const decision = route('/ooc back in five');
    expect(decision.channel).toBe('ooc');
    expect(decision.visibility).toBe('public');
  });

  it('does not treat a mention of a non-member as addressing anyone', () => {
    expect(route('@nobody hello').recipientType).toBe('table');
  });
});

describe('degenerate input', () => {
  it('rejects an empty message', () => {
    expect(reject('   ').code).toBe('EMPTY_MESSAGE');
  });

  it('asks for text when a text trigger has none', () => {
    expect(reject('@dm').code).toBe('EMPTY_TRIGGER');
    expect(reject('/ask').code).toBe('EMPTY_TRIGGER');
  });

  it('ignores trailing argument on an argument-free trigger', () => {
    expect(route('/recap of everything').dmTrigger?.definitionId).toBe('recap_command');
  });

  it('matches tags case-insensitively', () => {
    expect(route('@DM I inspect the altar').dmTrigger?.definitionId).toBe('dm_mention');
    expect(route('/RECAP').dmTrigger?.definitionId).toBe('recap_command');
  });
});

describe('the release gate — a trigger-free conversation', () => {
  it('never produces a dmTrigger across a whole table conversation', () => {
    const conversation = [
      'We should retreat.',
      '@aria Do you have the key?',
      '@party We should retreat.',
      '/roll perception',
      '/sheet equip longsword',
      '/ooc back in five',
      '/whisper @brann cover me',
      '@wizard hello?',
      '/dance',
      'I told the @dm about it',
      '`@dm` is the tag',
      'Klarg is watching us',
    ];

    for (const line of conversation) {
      const decision = parseMessage(line, roster, TRIGGER_REGISTRY);
      expect(decision.kind === 'route' && decision.dmTrigger).toBeUndefined();
    }
  });
});
