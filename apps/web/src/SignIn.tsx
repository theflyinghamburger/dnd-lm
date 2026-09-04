import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from './api';

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'That email and password do not match an account.',
  EMAIL_TAKEN: 'An account already exists for that email.',
  INVALID_PAYLOAD: 'Check the form — a password needs at least 12 characters.',
};

export function SignIn() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const queryClient = useQueryClient();

  const submit = useMutation({
    mutationFn: (form: { email: string; password: string; displayName: string }) =>
      mode === 'login'
        ? api.login({ email: form.email, password: form.password })
        : api.register(form),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit.mutate({
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
      displayName: String(data.get('displayName') ?? ''),
    });
  }

  const error = submit.error;
  const message = error instanceof ApiError ? (MESSAGES[error.code] ?? error.code) : null;

  return (
    <form onSubmit={onSubmit}>
      <h1>{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>

      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="email" required />

      {mode === 'register' && (
        <>
          <label htmlFor="displayName">Display name</label>
          <input id="displayName" name="displayName" required maxLength={64} />
        </>
      )}

      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        required
        minLength={mode === 'register' ? 12 : 1}
      />

      <button type="submit" disabled={submit.isPending}>
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </button>

      {message && (
        <p role="alert" className="error">
          {message}
        </p>
      )}

      <button
        type="button"
        className="linkish"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
      >
        {mode === 'login' ? 'Create an account instead' : 'I already have an account'}
      </button>
    </form>
  );
}
