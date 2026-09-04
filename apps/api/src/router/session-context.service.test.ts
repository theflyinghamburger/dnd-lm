import { TRIGGER_REGISTRY } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { resolveRegistry } from './session-context.service';

describe('resolveRegistry', () => {
  it('returns every default-enabled definition when a campaign has no overrides', () => {
    expect(resolveRegistry(null).map((d) => d.id)).toEqual(TRIGGER_REGISTRY.map((d) => d.id));
    expect(resolveRegistry({}).map((d) => d.id)).toEqual(TRIGGER_REGISTRY.map((d) => d.id));
  });

  it('removes a disabled trigger rather than flagging it (rule 7)', () => {
    const ids = resolveRegistry({ triggers: { dm_mention: false } }).map((d) => d.id);
    expect(ids).not.toContain('dm_mention');
    expect(ids).toContain('npc_mention');
  });

  it('ignores overrides for definitions that do not exist', () => {
    expect(resolveRegistry({ triggers: { made_up: true } })).toHaveLength(TRIGGER_REGISTRY.length);
  });

  it('survives settings of the wrong shape', () => {
    expect(resolveRegistry('nonsense')).toHaveLength(TRIGGER_REGISTRY.length);
    expect(resolveRegistry({ triggers: null })).toHaveLength(TRIGGER_REGISTRY.length);
  });
});
