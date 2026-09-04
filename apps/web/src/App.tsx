import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from './api';
import { Lobby } from './Lobby';
import { SignIn } from './SignIn';
import { Chat } from './session/Chat';

export function App() {
  const [at, setAt] = useState<{ campaignId: string; sessionId: string } | null>(null);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    // A 401 is the signed-out answer, not a transient failure worth retrying.
    retry: (_count, error) => !(error instanceof ApiError && error.status === 401),
  });

  if (me.isPending) return <p>Loading…</p>;
  if (!me.data) return <SignIn />;

  return at ? (
    <Chat
      user={me.data}
      campaignId={at.campaignId}
      sessionId={at.sessionId}
      onLeave={() => setAt(null)}
    />
  ) : (
    <Lobby user={me.data} onEnter={(campaignId, sessionId) => setAt({ campaignId, sessionId })} />
  );
}
