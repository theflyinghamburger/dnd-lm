import { describe, expect, it } from 'vitest';
import { ClientCommand, DmOutput, EventEnvelope, RollResult, TriggerDefinition } from './index';

describe('ClientCommand', () => {
  it('accepts the spec-doc.md §9.1 envelope', () => {
    const parsed = ClientCommand.parse({
      command_id: 'cmd_01J',
      type: 'SEND_MESSAGE',
      session_id: 'session_12',
      expected_state_version: 248,
      payload: { content: '@dm I inspect the altar.', channel: 'in_character' },
    });
    expect(parsed.type).toBe('SEND_MESSAGE');
  });

  it('rejects a sender_id smuggled in the payload envelope', () => {
    // The server derives sender_id from the connection (spec-doc.md §9.1).
    const command = ClientCommand.parse({
      command_id: 'cmd_2',
      type: 'SEND_MESSAGE',
      session_id: 's1',
      expected_state_version: 0,
      payload: { content: 'hi', channel: 'in_character' },
      sender_id: 'player_impersonated',
    });
    expect(command).not.toHaveProperty('sender_id');
  });

  it('does not accept RESUME as a command — it mutates nothing (M2.4)', () => {
    expect(
      ClientCommand.safeParse({
        command_id: 'c',
        type: 'RESUME',
        session_id: 's',
        expected_state_version: 1,
        payload: { last_sequence: 3 },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown command type', () => {
    expect(
      ClientCommand.safeParse({
        command_id: 'c',
        type: 'DELETE_EVERYTHING',
        session_id: 's',
        expected_state_version: 1,
        payload: {},
      }).success,
    ).toBe(false);
  });
});

describe('RollResult', () => {
  it('reconstructs its total from stored dice and modifiers (spec-doc.md §9.3)', () => {
    const roll = RollResult.parse({
      roll_id: 'roll_9381',
      expression: '1d20+5',
      dice: [12],
      modifiers: [
        { source: 'Wisdom', value: 3 },
        { source: 'Proficiency', value: 2 },
      ],
      total: 17,
      visibility: 'public',
      state_version: 248,
    });
    const sum =
      roll.dice.reduce((a, b) => a + b, 0) + roll.modifiers.reduce((a, m) => a + m.value, 0);
    expect(sum).toBe(roll.total);
  });

  it('requires a source on every modifier (FR-302)', () => {
    expect(
      RollResult.safeParse({
        roll_id: 'r',
        expression: '1d20',
        dice: [1],
        modifiers: [{ value: 3 }],
        total: 4,
        visibility: 'public',
        state_version: 0,
      }).success,
    ).toBe(false);
  });
});

describe('EventEnvelope', () => {
  it('accepts the spec-doc.md §9.4 envelope', () => {
    const event = EventEnvelope.parse({
      event_id: 'evt_01J',
      type: 'DOOR_UNLOCKED',
      campaign_id: 'campaign_4',
      session_id: 'session_12',
      sequence: 185,
      state_version: 249,
      actor: { type: 'character', id: 'character_7' },
      source: { type: 'resolution', id: 'resolution_31' },
      payload: { door_id: 'door.crypt_west' },
      created_at: '2026-09-04T12:00:00Z',
    });
    expect(event.sequence).toBe(185);
  });
});

describe('DmOutput', () => {
  it('accepts the architecture.md §6.4 example and defaults the optional arrays', () => {
    const output = DmOutput.parse({
      narration: 'The lock gives a faint metallic click.',
      addressed_to: ['party'],
      tool_requests: [],
      proposed_state_changes: [{ operation: 'mark_door_unlocked', target_id: 'door.crypt_west' }],
      memory_candidates: [{ fact: 'The party unlocked the western crypt door.', importance: 0.55 }],
      next_state: 'WAITING_FOR_PLAYERS',
    });
    expect(output.proposed_state_changes[0]?.payload).toEqual({});
  });

  it('rejects a next_state outside the MVP state machine (M5.1)', () => {
    expect(
      DmOutput.safeParse({
        narration: '',
        addressed_to: [],
        next_state: 'COMBAT_TURN',
      }).success,
    ).toBe(false);
  });
});

describe('TriggerDefinition', () => {
  it('accepts the MVP.md §4.2 shape', () => {
    const def = TriggerDefinition.parse({
      id: 'dm_mention',
      kind: 'mention_tag',
      match: { tag: '@dm', argument: 'text' },
      entryProfile: 'resolve_action',
      requiredScope: 'member',
      defaultEnabled: true,
    });
    expect(def.entryProfile).toBe('resolve_action');
  });

  it('rejects an unknown entry profile', () => {
    expect(
      TriggerDefinition.safeParse({
        id: 'x',
        kind: 'mention_tag',
        match: { tag: '@x' },
        entryProfile: 'freeform',
        requiredScope: 'member',
        defaultEnabled: true,
      }).success,
    ).toBe(false);
  });
});
