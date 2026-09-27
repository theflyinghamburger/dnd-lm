import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { PendingRoll } from './pending';

/**
 * An open request for a check (U1.1, FR-305, spec-doc.md §5.4). Everyone at the
 * table sees it; only an authorized character gets the button. Rolling sends
 * the ordinary ROLL_DICE — the server closes the request by character and the
 * card clears when PENDING_ACTION_COMPLETED arrives, never optimistically.
 */
export function PendingRollCard({
  pending,
  campaignId,
  characterId,
  canRoll,
  onRoll,
}: {
  pending: PendingRoll[];
  campaignId: string;
  characterId: string | null;
  /** False while the session refuses mutations — the same gate as the sheet (U1.0). */
  canRoll: boolean;
  onRoll: (expression: string) => void;
}) {
  // Same key as SheetPanel, so this is a cache hit, not a second fetch.
  const characters = useQuery({
    queryKey: ['characters', campaignId],
    queryFn: () => api.characters(campaignId),
  });
  const nameOf = (id: string) => characters.data?.find((c) => c.id === id)?.name ?? 'a character';

  // The live region stays mounted even when empty: a screen reader announces
  // content added to an existing region, not one that appears with it (NFR-402).
  return (
    <section role="status" aria-label="Roll requests">
      {pending.map((request) => (
        <p key={request.pendingActionId}>
          {/* Glyph and label, never colour alone (NFR-403). */}
          <span className="role">
            <span aria-hidden="true">⬢</span> Roll requested
          </span>{' '}
          <strong>{request.prompt}</strong> ({request.expression}){' '}
          {characterId && request.authorizedCharacterIds.includes(characterId) ? (
            <button type="button" disabled={!canRoll} onClick={() => onRoll(request.expression)}>
              Roll {request.expression}
            </button>
          ) : (
            <em>Waiting on {request.authorizedCharacterIds.map(nameOf).join(', ')}</em>
          )}
        </p>
      ))}
    </section>
  );
}
