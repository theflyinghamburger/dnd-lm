import {
  TRIGGER_REGISTRY,
  type CampaignTriggersResponse,
  type TriggerDefinition,
} from '@dnd-lm/contracts';

/**
 * The registry narrowed to what this campaign has enabled (MVP.md §4.3 rule 7:
 * a disabled trigger behaves exactly like an unknown tag). The composer's
 * autocomplete and its routing preview both read this, so a disabled tag is
 * neither advertised nor previewed as a DM turn. No data yet → no triggers.
 */
export function enabledRegistry(data: CampaignTriggersResponse | undefined): TriggerDefinition[] {
  if (!data) return [];
  const enabled = new Set(data.triggers.filter((t) => t.enabled).map((t) => t.id));
  return TRIGGER_REGISTRY.filter((d) => enabled.has(d.id));
}

/**
 * What each trigger does, in the words a host needs to decide whether to turn
 * it off (U1.3). The tag alone means nothing to anyone who did not write the
 * registry, and two entries have no tag at all.
 */
export const TRIGGER_LABELS: Record<string, { does: string; warning?: string }> = {
  dm_mention: { does: 'Address the Dungeon Master; the DM resolves the action.' },
  npc_mention: { does: 'Speak to a campaign NPC by name; the DM answers in character.' },
  ask_command: { does: 'Ask an out-of-fiction rules question.' },
  recap_command: { does: 'Ask for a summary of play so far.' },
  pending_action_completed: {
    does: 'A roll that answers the DM wakes it again.',
    warning: 'Off means a DM turn waiting on a roll never resumes from that roll.',
  },
  host_turn: { does: 'The host can take a DM turn with no player message.' },
};
