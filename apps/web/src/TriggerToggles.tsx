import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeApiError } from './api';
import { TRIGGER_LABELS } from './triggers';

/**
 * Per-campaign trigger enable/disable (U1.3, MVP.md §4.3 rule 7). Shown inside
 * the host/admin settings panel only; the server refuses anyone else (403).
 *
 * Every entry is listed, host-scoped ones included: `requiredScope` governs who
 * may *fire* a trigger, not who may configure it. The query key is the one
 * `Chat` reads, so invalidating it on success stops the composer advertising a
 * disabled tag without a reload — the server drops its own context cache on
 * the same write.
 */
export function TriggerToggles({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const triggers = useQuery({
    queryKey: ['triggers', campaignId],
    queryFn: () => api.triggers(campaignId),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateTriggers(campaignId, { triggers: { [id]: enabled } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['triggers', campaignId] }),
  });

  const error = triggers.error ?? toggle.error;

  return (
    <fieldset disabled={toggle.isPending}>
      <legend>DM triggers</legend>
      {triggers.isPending && <p>Loading triggers…</p>}
      {triggers.data?.triggers.map((trigger) => {
        const label = TRIGGER_LABELS[trigger.id];
        const inputId = `trigger-${campaignId}-${trigger.id}`;
        return (
          <p key={trigger.id}>
            <label htmlFor={inputId}>
              <input
                id={inputId}
                type="checkbox"
                checked={trigger.enabled}
                aria-describedby={label?.warning ? `${inputId}-warning` : undefined}
                onChange={(event) =>
                  toggle.mutate({ id: trigger.id, enabled: event.target.checked })
                }
              />{' '}
              <code>{trigger.tag ?? '(no tag)'}</code> — {label?.does ?? trigger.id}
            </label>
            {label?.warning && (
              <>
                <br />
                <small id={`${inputId}-warning`}>{label.warning}</small>
              </>
            )}
          </p>
        );
      })}
      {error && (
        <p role="alert" className="error">
          {describeApiError(error)}
        </p>
      )}
    </fieldset>
  );
}
