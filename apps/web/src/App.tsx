import { SessionState } from '@dnd-lm/contracts';

/**
 * Placeholder shell. Its only job at M0 is to prove the web app consumes
 * `packages/contracts` so a contract change that breaks it fails CI.
 */
export function App() {
  return (
    <main>
      <h1>DnD LM</h1>
      <p>Session states this MVP knows about:</p>
      <ul>
        {SessionState.options.map((state) => (
          <li key={state}>{state}</li>
        ))}
      </ul>
    </main>
  );
}
