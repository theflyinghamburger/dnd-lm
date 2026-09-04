import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from './api';
import { Lobby } from './Lobby';
import { SignIn } from './SignIn';
import { Chat } from './session/Chat';

export type Seat = { campaignId: string; sessionId: string; characterId: string | null };

export function App() {
  const [seat, setSeat] = useState<Seat | null>(null);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    // A 401 is the signed-out answer, not a transient failure worth retrying.
    retry: (_count, error) => !(error instanceof ApiError && error.status === 401),
  });

  if (me.isPending) return <p>Loading…</p>;
  if (!me.data) return <SignIn />;

  return seat ? (
    <Chat
      user={me.data}
      campaignId={seat.campaignId}
      sessionId={seat.sessionId}
      characterId={seat.characterId}
      onLeave={() => setSeat(null)}
    />
  ) : (
    <Lobby user={me.data} onEnter={setSeat} />
  );
}
