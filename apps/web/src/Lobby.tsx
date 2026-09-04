import type { PublicUser } from '@dnd-lm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from './api';

export function Lobby({ user }: { user: PublicUser }) {
  const queryClient = useQueryClient();
  const [invite, setInvite] = useState<string | null>(null);

  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: api.campaigns });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['campaigns'] });

  const createCampaign = useMutation({ mutationFn: api.createCampaign, onSuccess: refresh });
  const acceptInvite = useMutation({ mutationFn: api.acceptInvite, onSuccess: refresh });
  const createInvite = useMutation({
    mutationFn: api.createInvite,
    onSuccess: (result) => setInvite(result.token),
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

  const failure = [createCampaign.error, acceptInvite.error, createInvite.error].find(Boolean);

  return (
    <main>
      <header>
        <h1>Campaigns</h1>
        <p>
          Signed in as {user.displayName} ({user.email}){' '}
          <button type="button" onClick={() => logout.mutate()}>
            Sign out
          </button>
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
            {/* Character selection lands with M4 and the session itself with M2. */}
            <button type="button" disabled title="Sessions arrive with M2">
              Enter session
            </button>
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
