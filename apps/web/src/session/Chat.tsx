import {
  type PublicUser,
  type Roster,
  acceptsMutations,
  isTerminal,
  parseMessage,
} from '@dnd-lm/contracts';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { api } from '../api';
import { enabledRegistry } from '../triggers';
import { SheetPanel } from './SheetPanel';
import { canSend, statusNotice } from './status';
import { useSession } from './useSession';

/** Label and icon, never colour alone (NFR-403). */
const VISIBILITY: Record<string, { icon: string; label: string }> = {
  table: { icon: '◯', label: 'Everyone' },
  party: { icon: '◯', label: 'Party' },
  player: { icon: '◐', label: 'Addressed' },
  dm: { icon: '★', label: 'Dungeon Master' },
  whisper: { icon: '●', label: 'Private' },
  ooc: { icon: '◌', label: 'Out of character' },
  dice: { icon: '⬢', label: 'Dice' },
  sheet: { icon: '▤', label: 'Sheet' },
};

export function Chat({
  user,
  campaignId,
  sessionId,
  characterId,
  onLeave,
}: {
  user: PublicUser;
  campaignId: string;
  sessionId: string;
  characterId: string | null;
  onLeave: () => void;
}) {
  const [draft, setDraft] = useState('');
  const { snapshot, lines, rolls, connected, dmNarration, send, roll } = useSession(
    sessionId,
    characterId,
  );

  const roster = useQuery({
    queryKey: ['roster', campaignId],
    queryFn: () => api.roster(campaignId),
  });
  const triggers = useQuery({
    queryKey: ['triggers', campaignId],
    queryFn: () => api.triggers(campaignId),
  });

  /** Only the triggers this campaign has enabled — a disabled tag must not be advertised. */
  const registry = useMemo(() => enabledRegistry(triggers.data), [triggers.data]);

  /**
   * The same pure function the server runs (M3.1). The badge and the DM warning
   * are therefore a preview of the real decision, not a second guess at it.
   */
  const preview = useMemo(() => {
    if (!roster.data || draft.trim().length === 0) return null;
    return parseMessage(draft, roster.data as Roster, registry, {
      role: roster.data.members.find((m) => m.userId === user.id)?.role ?? 'player',
    });
  }, [draft, roster.data, registry, user.id]);

  const suggestions = useMemo(() => {
    const token = draft.slice(draft.lastIndexOf(' ') + 1).toLowerCase();
    if (token.length < 1 || !(token.startsWith('@') || token.startsWith('/'))) return [];
    const all = [
      ...registry.flatMap((d) => (d.match ? [d.match.tag] : [])),
      '@party',
      '/roll',
      '/sheet',
      '/ooc',
      '/whisper',
      ...(roster.data?.members ?? []).map((m) => `@${m.handle}`),
    ];
    return all.filter((candidate) => candidate.toLowerCase().startsWith(token)).slice(0, 6);
  }, [draft, registry, roster.data]);

  const nameOf = (userId: string): string =>
    userId === 'me'
      ? user.displayName
      : userId === 'dm'
        ? 'The Dungeon Master'
        : (roster.data?.members.find((m) => m.userId === userId)?.displayName ?? 'Someone');

  // U1.0: every gate reads the live status, which SESSION_STATE_CHANGED keeps
  // current. Nothing is offered before the first snapshot says where we are.
  const status = snapshot?.status ?? null;
  const notice = status && statusNotice(status);
  const sendable = status !== null && canSend(status, preview);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (content.length === 0 || !sendable) return;
    setDraft('');
    void send(content);
  }

  return (
    <main>
      <header>
        <h1>Session</h1>
        <p>
          <span className="role">{connected ? 'connected' : 'reconnecting'}</span>{' '}
          {snapshot ? `${snapshot.status} · v${snapshot.state_version}` : 'loading…'}{' '}
          <button type="button" onClick={onLeave}>
            Leave
          </button>
        </p>
      </header>

      {notice && (
        <p role="status">
          <strong>{notice}</strong>
        </p>
      )}

      <ol className="transcript" aria-live="polite">
        {lines.map((line) => {
          const badge = VISIBILITY[line.recipientType] ?? VISIBILITY['table']!;
          return (
            <li key={line.key} data-delivery={line.delivery}>
              <span className="role" aria-label={`Visibility: ${badge.label}`}>
                <span aria-hidden="true">{badge.icon}</span> {badge.label}
              </span>{' '}
              <strong>{nameOf(line.senderId)}</strong> {line.content}
              {line.triggersDm && <span className="role"> ★ DM</span>}
              {line.delivery !== 'delivered' && (
                <em> — {line.delivery === 'sending' ? 'sending…' : `rejected: ${line.error}`}</em>
              )}
            </li>
          );
        })}
        {Object.entries(dmNarration)
          .filter(([, text]) => text.length > 0)
          .map(([resolutionId, text]) => (
            <li key={resolutionId} data-delivery="provisional">
              <span className="role" aria-label="Visibility: Dungeon Master">
                <span aria-hidden="true">★</span> Dungeon Master
              </span>{' '}
              <em>{text}…</em>
            </li>
          ))}
        {status === 'DM_GENERATING' && (
          <li data-delivery="provisional">
            <em>The Dungeon Master is thinking…</em>
          </li>
        )}
      </ol>

      {rolls.length > 0 && (
        <section>
          <h2>Rolls</h2>
          <ul aria-live="polite">
            {rolls.slice(-8).map((entry) => (
              <li key={entry.key}>
                <strong>{entry.total}</strong> — {entry.label} ({entry.expression}):{' '}
                {entry.dice.join(', ')}
                {entry.modifiers.map((m) => ` ${m.value >= 0 ? '+' : ''}${m.value} ${m.source}`)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <form onSubmit={onSubmit}>
        <label htmlFor="draft">Message</label>
        <input
          id="draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoComplete="off"
          disabled={status !== null && isTerminal(status)}
          placeholder="Say something, or @dm to act"
        />

        {suggestions.length > 0 && (
          <p className="suggestions">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="linkish"
                onClick={() =>
                  setDraft(`${draft.slice(0, draft.lastIndexOf(' ') + 1)}${suggestion} `)
                }
              >
                {suggestion}
              </button>
            ))}
          </p>
        )}

        {/* FR-209: the player sees who will read this before they send it. */}
        <p role="status">
          {preview === null && 'Nothing to send yet.'}
          {preview?.kind === 'reject' && <strong>Will not send: {preview.message}</strong>}
          {preview?.kind === 'route' && (
            <>
              <span aria-hidden="true">
                {(VISIBILITY[preview.recipientType] ?? VISIBILITY['table']!).icon}
              </span>{' '}
              Goes to {(VISIBILITY[preview.recipientType] ?? VISIBILITY['table']!).label}
              {preview.dmTrigger && (
                <strong>
                  {' '}
                  · ★ This will wake the Dungeon Master ({preview.dmTrigger.definitionId})
                </strong>
              )}
              {status && !sendable && (
                <strong>
                  {' '}
                  ·{' '}
                  {status === 'PAUSED'
                    ? 'Not while paused — only table chat sends.'
                    : 'The session has ended.'}
                </strong>
              )}
            </>
          )}
        </p>

        <button type="submit" disabled={!sendable}>
          Send
        </button>
      </form>
      <SheetPanel
        user={user}
        campaignId={campaignId}
        characterId={characterId}
        canRoll={status !== null && acceptsMutations(status)}
        onRoll={(expression) => void roll(expression)}
      />
    </main>
  );
}
