import type { CommandAck, HostControlAction, ServerError, SessionState } from '@dnd-lm/contracts';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { hostActions } from './status';

type Result = CommandAck | ServerError | null;

/**
 * Host controls and asking the party for a check (U1.2, FR-801, M5.5). Shown
 * only to a host or admin, but the server's NOT_THE_HOST is the control — not
 * rendering the bar is courtesy. Every button is gated by `hostActions`, which
 * reads the shared transition table, and every rejection is shown in the
 * server's own words: a button that silently does nothing is the worst case.
 */
export function HostBar({
  status,
  campaignId,
  onControl,
  onRequestRoll,
}: {
  status: SessionState;
  campaignId: string;
  onControl: (action: HostControlAction) => Promise<Result>;
  onRequestRoll: (prompt: string, expression: string, characterIds: string[]) => Promise<Result>;
}) {
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** One command at a time: a double press would quote a stale version. */
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [expression, setExpression] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  // Same key as SheetPanel and PendingRollCard: a cache hit, not a new fetch.
  const characters = useQuery({
    queryKey: ['characters', campaignId],
    queryFn: () => api.characters(campaignId),
  });
  const allowed = hostActions(status);

  /** Shows a rejection and reports whether the command went through. */
  function landed(result: Result): boolean {
    if (result === null) {
      setFailure('Not connected — try again once the session reconnects.');
      return false;
    }
    if ('code' in result) {
      setFailure(`${result.code}: ${result.message}`);
      return false;
    }
    setFailure(null);
    return true;
  }

  async function control(action: HostControlAction) {
    setConfirmingEnd(false);
    setBusy(true);
    landed(await onControl(action));
    setBusy(false);
  }

  async function onAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Caps (200-char prompt, 12 characters) are the server's to enforce and explain.
    setBusy(true);
    if (landed(await onRequestRoll(prompt.trim(), expression.trim(), chosen))) {
      setPrompt('');
      setExpression('');
      setChosen([]);
    }
    setBusy(false);
  }

  return (
    <section aria-label="Host controls">
      <h2>Host</h2>
      <p>
        <button
          type="button"
          disabled={busy || !allowed.PAUSE}
          onClick={() => void control('PAUSE')}
        >
          Pause
        </button>{' '}
        <button
          type="button"
          disabled={busy || !allowed.RESUME}
          onClick={() => void control('RESUME')}
        >
          Resume
        </button>{' '}
        {/* host_turn is the one trigger with no chat tag (contracts router.ts):
            this button is the only way to fire it. */}
        <button
          type="button"
          disabled={busy || !allowed.FORCE_DM_TURN}
          onClick={() => void control('FORCE_DM_TURN')}
        >
          Force DM turn
        </button>{' '}
        {/* SESSION_ENDED is terminal, so End takes two presses. */}
        {confirmingEnd ? (
          <>
            <span role="alert"> End this session for everyone? This cannot be undone. </span>
            <button
              type="button"
              disabled={busy || !allowed.END}
              onClick={() => void control('END')}
            >
              Confirm end
            </button>{' '}
            <button type="button" onClick={() => setConfirmingEnd(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy || !allowed.END}
            onClick={() => setConfirmingEnd(true)}
          >
            End session
          </button>
        )}
      </p>

      <form onSubmit={(event) => void onAsk(event)}>
        <fieldset disabled={busy || !allowed.REQUEST_ROLL}>
          <legend>Ask for a check</legend>
          <label htmlFor="check-prompt">Prompt</label>
          <input
            id="check-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Make a Perception check"
            required
          />
          <label htmlFor="check-expression">Roll</label>
          <input
            id="check-expression"
            value={expression}
            onChange={(event) => setExpression(event.target.value)}
            placeholder="Perception or 1d20+2"
            required
          />
          {(characters.data ?? []).map((character) => (
            <label key={character.id}>
              <input
                type="checkbox"
                checked={chosen.includes(character.id)}
                onChange={(event) =>
                  setChosen((current) =>
                    event.target.checked
                      ? [...current, character.id]
                      : current.filter((id) => id !== character.id),
                  )
                }
              />{' '}
              {character.name}
            </label>
          ))}
          <button type="submit" disabled={busy || chosen.length === 0}>
            Ask
          </button>
        </fieldset>
      </form>

      {failure && <p role="alert">Refused — {failure}</p>}
    </section>
  );
}
