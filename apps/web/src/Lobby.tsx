import type { ImportCharacterRequest, PublicUser } from '@dnd-lm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { Seat } from './App';
import { AdminProviders } from './AdminProviders';
import { CampaignSettings } from './CampaignSettings';
import { ApiError, api, describeApiError } from './api';
import { PREGENS } from './pregens';

export function Lobby({ user, onEnter }: { user: PublicUser; onEnter: (seat: Seat) => void }) {
  const queryClient = useQueryClient();
  const [invite, setInvite] = useState<string | null>(null);
  /** Which campaign's DM settings are open, and whether the admin page is. */
  const [openSettings, setOpenSettings] = useState<string | null>(null);
  const [showProviders, setShowProviders] = useState(false);
  /** M1.4's "pick a character", now that M4 has characters to pick. */
  const [seats, setSeats] = useState<Record<string, string>>({});

  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: api.campaigns });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['campaigns'] });

  const createCampaign = useMutation({ mutationFn: api.createCampaign, onSuccess: refresh });
  const acceptInvite = useMutation({ mutationFn: api.acceptInvite, onSuccess: refresh });
  const createInvite = useMutation({
    mutationFn: api.createInvite,
    onSuccess: (result) => setInvite(result.token),
  });
  const enterSession = useMutation({
    // Reuse the campaign's open session, or open one if the host has not yet.
    mutationFn: async (campaign: { id: string; role: string }): Promise<Seat> => {
      const existing = await api.sessions(campaign.id);
      const live = existing.find((s) => s.status !== 'SESSION_ENDED');
      const characterId = seats[campaign.id] ?? null;
      if (live) return { campaignId: campaign.id, sessionId: live.session_id, characterId };
      if (campaign.role === 'player') throw new ApiError(409, 'NO_OPEN_SESSION');
      const created = await api.createSession(campaign.id);
      return { campaignId: campaign.id, sessionId: created.session_id, characterId };
    },
    onSuccess: onEnter,
  });

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.invalidateQueries(),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>, run: (value: string) => void) {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem('value');
    if (field instanceof HTMLInputElement && field.value.trim()) {
      run(field.value.trim());
      field.value = '';
    }
  }

  /**
   * Platform admin, the same way the API decides it (M7.4, option (a)): an
   * `admin` membership in any campaign. The page is guarded server-side; not
   * offering the button is courtesy, not the control.
   */
  const isPlatformAdmin = (campaigns.data ?? []).some((campaign) => campaign.role === 'admin');

  const failure = [
    createCampaign.error,
    acceptInvite.error,
    createInvite.error,
    enterSession.error,
  ].find(Boolean);

  if (showProviders) return <AdminProviders onClose={() => setShowProviders(false)} />;

  return (
    <main>
      <header>
        <h1>Campaigns</h1>
        <p>
          Signed in as {user.displayName} ({user.email}){' '}
          <button type="button" onClick={() => logout.mutate()}>
            Sign out
          </button>{' '}
          {isPlatformAdmin && (
            <button type="button" onClick={() => setShowProviders(true)}>
              Providers
            </button>
          )}
        </p>
      </header>

      {campaigns.isPending && <p>Loading campaigns…</p>}
      {campaigns.data?.length === 0 && <p>No campaigns yet. Create one, or accept an invite.</p>}

      <ul>
        {campaigns.data?.map((campaign) => (
          <li key={campaign.id}>
            <strong>{campaign.name}</strong> <span className="role">{campaign.role}</span>
            {(campaign.role === 'host' || campaign.role === 'admin') && (
              <button type="button" onClick={() => createInvite.mutate(campaign.id)}>
                Invite a player
              </button>
            )}
            <CharacterPicker
              user={user}
              campaignId={campaign.id}
              value={seats[campaign.id] ?? ''}
              onChange={(characterId) =>
                setSeats((current) => ({ ...current, [campaign.id]: characterId }))
              }
            />
            <button
              type="button"
              onClick={() => enterSession.mutate({ id: campaign.id, role: campaign.role })}
              disabled={enterSession.isPending}
            >
              Enter session
            </button>
            {(campaign.role === 'host' || campaign.role === 'admin') && (
              <button
                type="button"
                onClick={() => setOpenSettings(openSettings === campaign.id ? null : campaign.id)}
              >
                {openSettings === campaign.id ? 'Close settings' : 'DM settings'}
              </button>
            )}
            {openSettings === campaign.id && <CampaignSettings campaignId={campaign.id} />}
          </li>
        ))}
      </ul>

      {invite && (
        <p role="status">
          Invite token: <code>{invite}</code> — single use.
        </p>
      )}

      <form onSubmit={(e) => onSubmit(e, createCampaign.mutate)}>
        <label htmlFor="new-campaign">New campaign name</label>
        <input id="new-campaign" name="value" maxLength={120} required />
        <button type="submit">Create campaign</button>
      </form>

      <form onSubmit={(e) => onSubmit(e, acceptInvite.mutate)}>
        <label htmlFor="invite-token">Invite token</label>
        <input id="invite-token" name="value" required />
        <button type="submit">Accept invite</button>
      </form>

      {failure && (
        <p role="alert" className="error">
          {failure instanceof ApiError ? failure.code : 'Something went wrong.'}
        </p>
      )}
    </main>
  );
}

/**
 * Only your own characters are selectable — you cannot sit down as someone else.
 *
 * The chooser beside it is #61: the six pregens M4.2 shipped, posted to the
 * import endpoint that until now was reachable only by curl. It is not the
 * creation wizard MVP.md §7 defers — picking a shipped sheet authors nothing,
 * and no derived value is computed or sent here (D-3).
 */
function CharacterPicker({
  user,
  campaignId,
  value,
  onChange,
}: {
  user: PublicUser;
  campaignId: string;
  value: string;
  onChange: (characterId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [pregenName, setPregenName] = useState(PREGENS[0]?.name ?? '');

  const characters = useQuery({
    queryKey: ['characters', campaignId],
    queryFn: () => api.characters(campaignId),
  });
  const importCharacter = useMutation({
    mutationFn: (pregen: ImportCharacterRequest) => api.importCharacter(campaignId, pregen),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['characters', campaignId] }),
  });

  const mine = (characters.data ?? []).filter((c) => c.ownerUserId === user.id);
  const selectId = `character-${campaignId}`;
  const pregenId = `pregen-${campaignId}`;

  return (
    <>
      {mine.length === 0 ? (
        <span className="role">no character</span>
      ) : (
        <>
          <label htmlFor={selectId} className="visually-hidden">
            Character
          </label>
          <select id={selectId} value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">Watch only</option>
            {mine.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </>
      )}

      <label htmlFor={pregenId} className="visually-hidden">
        Pregenerated character
      </label>
      <select
        id={pregenId}
        value={pregenName}
        onChange={(event) => setPregenName(event.target.value)}
      >
        {PREGENS.map((pregen) => (
          <option key={pregen.name} value={pregen.name}>
            {pregen.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={importCharacter.isPending}
        onClick={() => {
          const pregen = PREGENS.find((candidate) => candidate.name === pregenName);
          if (pregen) importCharacter.mutate(pregen);
        }}
      >
        Add character
      </button>
      {importCharacter.error && (
        <span role="alert" className="error">
          {describeApiError(importCharacter.error)}
        </span>
      )}
    </>
  );
}
