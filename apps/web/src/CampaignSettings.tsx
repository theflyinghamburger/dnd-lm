import type { CampaignDmSettings, DmDifficulty, DmStyle, DmTone } from '@dnd-lm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, describeApiError } from './api';

/**
 * Campaign → Settings (M7.6, FR-506). A host picks a provider from the
 * *redacted* enabled list — identity and model, never a URL or a key, because
 * the shape `GET /api/providers` returns has no field for either (M7.4) — and
 * sets the DM knobs.
 *
 * The knobs are stored and shown; they do not reach the DM's prompt yet. That
 * wiring is its own change, with its own untrusted-input treatment.
 */

const STYLES: DmStyle[] = ['gritty', 'heroic', 'comedic', 'mysterious'];
const TONES: DmTone[] = ['light', 'balanced', 'dark'];
const DIFFICULTIES: DmDifficulty[] = ['easy', 'standard', 'hard', 'deadly'];

export function CampaignSettings({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);

  const settings = useQuery({
    queryKey: ['dm-settings', campaignId],
    queryFn: () => api.dmSettings(campaignId),
  });
  const connections = useQuery({ queryKey: ['providers'], queryFn: api.providers });

  const done = (next: CampaignDmSettings | unknown) => {
    void next;
    setSaved(true);
    return queryClient.invalidateQueries({ queryKey: ['dm-settings', campaignId] });
  };

  const chooseProvider = useMutation({
    mutationFn: (providerConnectionId: string | null) =>
      api.setProvider(campaignId, providerConnectionId),
    onSuccess: done,
  });
  const saveKnobs = useMutation({
    mutationFn: (knobs: Partial<CampaignDmSettings>) =>
      api.updateDmSettings(campaignId, {
        style: knobs.style ?? null,
        tone: knobs.tone ?? null,
        difficulty: knobs.difficulty ?? null,
      }),
    onSuccess: done,
  });

  if (settings.isPending) return <p>Loading settings…</p>;
  if (!settings.data) return <p className="error">Settings unavailable.</p>;

  const current = settings.data;
  const failure = [chooseProvider.error, saveKnobs.error].find(Boolean);

  return (
    <section className="settings">
      <h3>DM settings</h3>

      <label htmlFor={`provider-${campaignId}`}>Provider</label>
      <select
        id={`provider-${campaignId}`}
        value={current.providerConnectionId ?? ''}
        disabled={connections.isPending || chooseProvider.isPending}
        onChange={(event) => {
          setSaved(false);
          chooseProvider.mutate(event.target.value || null);
        }}
      >
        <option value="">No DM provider</option>
        {(connections.data ?? []).map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.label} — {connection.modelId}
          </option>
        ))}
      </select>
      {connections.data?.length === 0 && (
        <p className="role">No enabled connections yet — ask a platform admin.</p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          const form = new FormData(event.currentTarget);
          const value = <T,>(name: string) => (form.get(name) || null) as T | null;
          saveKnobs.mutate({
            style: value<DmStyle>('style'),
            tone: value<DmTone>('tone'),
            difficulty: value<DmDifficulty>('difficulty'),
          });
        }}
      >
        <Knob
          id={`style-${campaignId}`}
          name="style"
          label="Style"
          options={STYLES}
          value={current.style}
        />
        <Knob
          id={`tone-${campaignId}`}
          name="tone"
          label="Tone"
          options={TONES}
          value={current.tone}
        />
        <Knob
          id={`difficulty-${campaignId}`}
          name="difficulty"
          label="Difficulty"
          options={DIFFICULTIES}
          value={current.difficulty}
        />
        <button type="submit" disabled={saveKnobs.isPending}>
          Save DM settings
        </button>
      </form>

      {saved && !failure && <p role="status">Saved.</p>}
      {failure && (
        <p role="alert" className="error">
          {describeApiError(failure)}
        </p>
      )}
    </section>
  );
}

/** One closed-vocabulary knob. `key` here is a React key, never a credential. */
function Knob<T extends string>({
  id,
  name,
  label,
  options,
  value,
}: {
  id: string;
  name: string;
  label: string;
  options: T[];
  value: T | null;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={value ?? ''}>
        <option value="">Not set</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </>
  );
}
