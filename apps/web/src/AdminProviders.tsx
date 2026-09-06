import type { AdminConnection, ConnectionTestResult, ProviderKind } from '@dnd-lm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, describeApiError as describe } from './api';

/**
 * Admin → Providers (M7.6, FR-805). Platform admins only; the guard is the
 * API's (M7.4), and this page is simply not offered to anyone else.
 *
 * The one rule that shapes every form here: **the key is write-only**. It is
 * entered once on creation, replaced by typing a new value, and never read
 * back — there is no field bound to it, no "show" toggle, and nothing to
 * reveal, because no response this page receives contains it. `••••{last4}` is
 * the whole display.
 */
export function AdminProviders({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ['admin-providers'], queryFn: api.adminProviders });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-providers'] });

  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [results, setResults] = useState<Record<string, ConnectionTestResult>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: api.testConnection,
    onMutate: () => setFailure(null),
    onSuccess: (result, id) => {
      setResults((current) => ({ ...current, [id]: result }));
      // The row's "last tested" column reads the same stored result.
      void refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: api.deleteConnection,
    onMutate: () => setFailure(null),
    onSuccess: () => {
      setConfirming(null);
      void refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  return (
    <main>
      <header>
        <h1>Providers</h1>
        <p>
          Connections the DM can run on.{' '}
          <button type="button" onClick={onClose}>
            Back to campaigns
          </button>
        </p>
      </header>

      {connections.isPending && <p>Loading connections…</p>}
      {/* A failed list read left the page blank: no loading line, no empty
          state, no alert. It renders through the same describer as every
          other failure here. */}
      {connections.error && (
        <p role="alert" className="error">
          {describe(connections.error)}
        </p>
      )}
      {connections.data?.length === 0 && <p>No connections yet.</p>}

      <ul>
        {connections.data?.map((connection) => (
          <li key={connection.id}>
            <strong>{connection.label}</strong>{' '}
            <span className="role">
              {connection.kind} · {connection.modelId} ·{' '}
              {connection.enabled ? 'enabled' : 'disabled'}
            </span>
            <p className="role">
              Key: {connection.apiKeyLast4 ? `••••${connection.apiKeyLast4}` : 'none (keyless)'} ·{' '}
              {connection.baseUrl}
            </p>
            <LastTested result={results[connection.id] ?? connection.lastTest} />
            <button
              type="button"
              onClick={() => test.mutate(connection.id)}
              disabled={test.isPending}
            >
              Test
            </button>
            <button
              type="button"
              onClick={() => setEditing(editing === connection.id ? null : connection.id)}
            >
              {editing === connection.id ? 'Close' : 'Edit'}
            </button>
            {confirming === connection.id ? (
              <>
                <span role="alert"> Delete {connection.label}? </span>
                <button
                  type="button"
                  onClick={() => remove.mutate(connection.id)}
                  disabled={remove.isPending}
                >
                  Confirm delete
                </button>
                <button type="button" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setFailure(null);
                  setConfirming(connection.id);
                }}
              >
                Delete
              </button>
            )}
            {editing === connection.id && (
              <ConnectionForm
                connection={connection}
                onSaved={() => {
                  setEditing(null);
                  void refresh();
                }}
              />
            )}
          </li>
        ))}
      </ul>

      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}

      <button type="button" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
        {editing === 'new' ? 'Cancel' : 'Add a connection'}
      </button>
      {editing === 'new' && (
        <ConnectionForm
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </main>
  );
}

/** The five fields M7.5 measures, or nothing if this one was never tested. */
function LastTested({ result }: { result: ConnectionTestResult | null | undefined }) {
  if (!result) return <p className="role">Never tested.</p>;
  const fields: Array<[string, boolean]> = [
    ['reachable', result.reachable],
    ['authenticated', result.authenticated],
    ['model', result.modelExists],
    ['structured output', result.structuredOutput],
  ];
  return (
    <p className="role">
      Tested {new Date(result.at).toLocaleString()}:{' '}
      {fields.map(([name, ok]) => `${ok ? '✓' : '✗'} ${name}`).join(' · ')} · {result.latencyMs}ms
      {result.detail && <> — {result.detail}</>}
    </p>
  );
}

/**
 * Create and edit are the same fields with different starting values, and one
 * real difference: **create takes the key once, edit never shows a key field
 * at all.** Replacing a key is its own deliberate action below, so "save the
 * label" can never silently blank a credential.
 */
function ConnectionForm({
  connection,
  onSaved,
}: {
  connection?: AdminConnection;
  onSaved: () => void;
}) {
  const editingExisting = connection !== undefined;
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (form: FormData) => {
      const text = (name: string) => String(form.get(name) ?? '').trim();
      const maxTokens = text('maxTokens');
      if (connection) {
        return api.updateConnection(connection.id, {
          label: text('label'),
          baseUrl: text('baseUrl'),
          modelId: text('modelId'),
          ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
          enabled: form.get('enabled') === 'on',
        });
      }
      const entered = text('newKey');
      return api.createConnection({
        label: text('label'),
        kind: text('kind') as ProviderKind,
        baseUrl: text('baseUrl'),
        modelId: text('modelId'),
        ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
        // Absent, not empty: a keyless local endpoint has no credential, and
        // an empty string is not one.
        ...(entered ? { apiKey: entered } : {}),
      });
    },
    onMutate: () => setFailure(null),
    onSuccess: onSaved,
    // The form is never reset here: a rejected save keeps everything typed,
    // which is the whole point of showing the server's reason next to it.
    onError: (error) => setFailure(describe(error)),
  });

  const replaceKey = useMutation({
    mutationFn: (value: string) => api.replaceConnectionKey(connection!.id, value),
    onMutate: () => setFailure(null),
    onSuccess: onSaved,
    onError: (error) => setFailure(describe(error)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(new FormData(event.currentTarget));
  }

  return (
    <>
      <form onSubmit={onSubmit}>
        <label htmlFor="label">Label</label>
        <input
          id="label"
          name="label"
          defaultValue={connection?.label ?? ''}
          required
          maxLength={128}
        />

        <label htmlFor="kind">Kind</label>
        <select
          id="kind"
          name="kind"
          defaultValue={connection?.kind ?? 'openai_compatible'}
          disabled={editingExisting}
        >
          <option value="openai_compatible">openai_compatible</option>
          <option value="anthropic">anthropic</option>
        </select>

        <label htmlFor="baseUrl">Base URL</label>
        <input id="baseUrl" name="baseUrl" defaultValue={connection?.baseUrl ?? ''} required />

        <label htmlFor="modelId">Model id</label>
        <input
          id="modelId"
          name="modelId"
          defaultValue={connection?.modelId ?? ''}
          required
          maxLength={256}
        />

        <label htmlFor="maxTokens">Max tokens</label>
        <input
          id="maxTokens"
          name="maxTokens"
          type="number"
          min={1}
          defaultValue={connection?.maxTokens ?? 1024}
        />

        {editingExisting ? (
          <p className="role">
            Key: {connection.apiKeyLast4 ? `••••${connection.apiKeyLast4}` : 'none (keyless)'} —
            replace it below. Editing these fields leaves it untouched.
          </p>
        ) : (
          <>
            <label htmlFor="newKey">API key (optional for a keyless endpoint)</label>
            <input id="newKey" name="newKey" type="password" autoComplete="off" maxLength={2048} />
          </>
        )}

        {editingExisting && (
          <>
            <label htmlFor="enabled">
              <input
                id="enabled"
                name="enabled"
                type="checkbox"
                defaultChecked={connection.enabled}
              />{' '}
              Enabled
            </label>
          </>
        )}

        <button type="submit" disabled={save.isPending}>
          {editingExisting ? 'Save changes' : 'Create connection'}
        </button>
      </form>

      {editingExisting && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const field = event.currentTarget.elements.namedItem('replacement');
            if (field instanceof HTMLInputElement && field.value.trim()) {
              // Cleared on success only. Clearing it inline made a rejected
              // replace cost the admin the one value on this page that is
              // painful to retype -- while the form beside it keeps its
              // contents on failure by explicit requirement.
              replaceKey.mutate(field.value.trim(), {
                onSuccess: () => {
                  field.value = '';
                },
              });
            }
          }}
        >
          <label htmlFor="replacement">Replace key</label>
          <input
            id="replacement"
            name="replacement"
            type="password"
            autoComplete="off"
            maxLength={2048}
          />
          <button type="submit" disabled={replaceKey.isPending}>
            Replace key
          </button>
        </form>
      )}

      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}
    </>
  );
}
