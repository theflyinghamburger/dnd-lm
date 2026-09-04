import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { Lobby } from './Lobby';
import { SignIn } from './SignIn';

export function App() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    // A 401 is the signed-out answer, not a transient failure worth retrying.
    retry: (_count, error) => !(error instanceof ApiError && error.status === 401),
  });

  if (me.isPending) return <p>Loading…</p>;
  return me.data ? <Lobby user={me.data} /> : <SignIn />;
}
