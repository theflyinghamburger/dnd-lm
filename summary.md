# Build summary — DnD LM

**Repo:** [theflyinghamburger/dnd-lm](https://github.com/theflyinghamburger/dnd-lm) (private)
**As of:** 2026-09-04
**Progress:** M0–M6 (M6 on branch `m6-langgraph-dm`, all gates green, PR in flight). M7–M9 not started.

---

## 1. Where things stand

| Task | Issue | State | PR |
|---|---|---|---|
| M0 — Repository, contracts, CI | [#1](https://github.com/theflyinghamburger/dnd-lm/issues/1) | **merged** | [#11](https://github.com/theflyinghamburger/dnd-lm/pull/11) |
| M1 — Identity, campaigns, memberships | [#2](https://github.com/theflyinghamburger/dnd-lm/issues/2) | **merged** | [#13](https://github.com/theflyinghamburger/dnd-lm/pull/13) |
| M2 — Realtime gateway, ordering, idempotency, replay | [#3](https://github.com/theflyinghamburger/dnd-lm/issues/3) | **merged** | [#14](https://github.com/theflyinghamburger/dnd-lm/pull/14) |
| M3 — Deterministic router, trigger registry, messaging | [#4](https://github.com/theflyinghamburger/dnd-lm/issues/4) | **merged** | [#15](https://github.com/theflyinghamburger/dnd-lm/pull/15) |
| M4 — Characters and dice | [#5](https://github.com/theflyinghamburger/dnd-lm/issues/5) | **merged** | [#16](https://github.com/theflyinghamburger/dnd-lm/pull/16) |
| M5 — Session orchestrator | [#6](https://github.com/theflyinghamburger/dnd-lm/issues/6) | **complete**, branch `m5-orchestrator` | none yet |
| M6 — The LangGraph DM | [#7](https://github.com/theflyinghamburger/dnd-lm/issues/7) | **complete**, branch `m6-langgraph-dm` (stacked on `m5-orchestrator`) | opening |
| M7 — Provider configuration and secrets | [#8](https://github.com/theflyinghamburger/dnd-lm/issues/8) | not started | |
| M8 — Manual campaign notes and retrieval | [#9](https://github.com/theflyinghamburger/dnd-lm/issues/9) | not started | |
| M9 — MVP acceptance | [#10](https://github.com/theflyinghamburger/dnd-lm/issues/10) | not started | |

230 tests on the M6 branch: 166 unit, 64 integration — all of them run, locally and in CI. CI runs build → typecheck → lint → format → migrate → test → migration-drift on every push, against a real Postgres 16 service.

### PR #12 is dead

GitHub auto-closed it when its base branch was deleted on merge of #11. #13 is the same commit rebased onto `main`. **Do not use `--delete-branch` while a stacked PR still points at that branch.**

---

## 2. What exists

```
apps/api            NestJS 12 — auth, campaigns, session, router, dice, characters, dm (LangGraph)
apps/web            React 19 + Vite + TanStack Query — lobby, chat, character sheet
packages/contracts  Zod schemas AND the pure logic both sides must agree on
fixtures/pregens    Six level-3 SRD characters
```

**Postgres tables:** `users`, `auth_sessions`, `campaigns`, `memberships`, `invites`, `sessions`, `session_events`, `commands`, `messages`, `characters`, `rolls`, `pending_actions`, `provider_connections` (M7.1; key material is AES-GCM `bytea`, never plaintext). Six migrations, drift-checked.

### Running it

```sh
pnpm install
docker compose up -d          # Postgres 16 on :5432 — see the caveat in §5
cp .env.example .env
pnpm build && pnpm db:migrate
pnpm --filter @dnd-lm/api start:dev    # :3000
pnpm --filter @dnd-lm/web dev          # :5173, proxies /api and /ws
```

---

## 3. Decisions worth knowing before you touch anything

**`packages/contracts` holds pure logic, not only schemas.** `parseMessage`, `deriveSheet`, `parseDiceExpression` and the state machine live there because the client must reach the *same* answer as the server — the chat composer previews the real routing decision (FR-209), and a second implementation is the drift that would eventually break FR-202. The rule that keeps it honest: **that package has no CSPRNG and no database handle.** Dice *parsing* is there; dice *rolling* is not. FR-301 is therefore a property of where code lives rather than a convention someone must remember.

**`state_version` and `sequence` are different things.** `sequence` is the append-only log position; `state_version` tracks state. Chat appends to the log; it does not change state. That distinction is what M5.4 depends on — see §4.

**Login sessions are `auth_sessions`.** `sessions` means game sessions (M2.1). Two things called "session" in one schema is a bug waiting to happen.

**The campaign owner also gets a real `host` membership row**, so ownership is never a special case in `CampaignMemberGuard` — one lookup answers every authorization question.

**A DM activation is its own `DM_TRIGGERED` event.** That is what makes the release gate assertable before any provider exists, and it is the hook M6 consumes.

**Privacy is a `WHERE` predicate, including in replay.** A bystander who reconnects must never be *sent* a whisper to drop client-side.

**No `EventBus` interface**, though MVP.md §3 names one. socket.io's adapter API already is that seam: Phase 3 fanout is `@socket.io/redis-adapter` on the server, no caller changes. Flagged in #14 for review — say the word and it gets an explicit interface.

**Two toolchain constraints, both from NestJS.** Vitest transforms with SWC (Nest DI reads `design:paramtypes`, which esbuild does not emit), and the `consistent-type-imports` lint rule is deliberately absent (its autofix erases that metadata and turns DI into a runtime failure).

---

## 4. Start here: M6 is done; M7 (provider config) is next

M6 shipped the whole DM turn and its tests. What is in place for M7:

- **The turn is live end to end.** Three things emit `DM_TRIGGERED` (registered
  tag, closed pending action, `FORCE_DM_TURN`); the gateway dispatches it to
  `DmOrchestrator`, which runs the LangGraph state graph
  (context → provider → validate → commit-or-retry) and writes
  `DM_NARRATION` / `DM_RESOLUTION_FAILED` through `runCommand`. Prose streams
  to the room as a `dm_stream` socket event before the commit, so the web's
  provisional bubble disappears atomically with the authoritative event.
- **`pending_actions.graph_thread_id` is now read.** The roll interrupt parks
  in a `PGCheckpointSaver` row under that thread id; closing the action
  re-invokes with a `Command`, so a server restart resumes from the
  checkpoint — it does not re-roll or re-run the context nodes. The M6.8 e2e
  test covers the close→restart→resume path.
- **Provider config is env, and that is M7's job.** `DmProviderSource.get()`
  reads `DM_PROVIDER_KIND` / `DM_PROVIDER_API_KEY` / `DM_PROVIDER_BASE_URL` /
  `DM_PROVIDER_MODEL` / `DM_PROVIDER_MAX_TOKENS` at turn start; no provider
  configured is a clean `NO_PROVIDER` failure, not a crash. M7 moves this to
  per-connection rows with a UI and makes keys write-only — the injection
  point is one Symbol provider, `DM_PROVIDER_SOURCE`, so the swap touches one
  class, not the graph.
- **`runCommand`'s `mode` carried the turn as `'mutation'` as M5 intended**,
  with one deliberate extension: a `null` `expected_state_version` marks a
  server-internal resolution. The client version gate is skipped (a pending
  resolution must not be invalidated by a player's concurrent chat) while the
  optimistic lock and every other guarantee stay intact.

### What M5 and M6 decided that should not be re-litigated

**Chat does not bump `state_version`; mutations do.** This is the reconciliation
M2 deferred. `sequence` is log position, `state_version` is state — a chatty
table allocates sequences without invalidating anyone's version, so
`expected_state_version` can finally be enforced without making M2's own
contiguous-sequence criterion unsatisfiable. A message carrying a `dmTrigger`
counts as a mutation, because it starts a DM turn.

**A pause is enforced in `runCommand`, not in the gateway.** One check covers
every mutating path, including the ones M6 adds. Host controls are exempt so
RESUME and END are reachable from `PAUSED`; `FORCE_DM_TURN` is *not* exempt,
because a pause blocks all triggers.

**A pending action is closed by character, not by expression.** An authorized
player rolling `1d4` closes a requested Perception check. Marked with a
`ponytail:` comment — matching the expression is M6's call, once the graph
states what it asked for.

**The DM's output channel is structured output, not native provider tool calls.**
One narrow `DmProvider` interface (not a LangChain `ChatModel`) returns prose
plus a fenced ` ```dm-json ` block; `parseDmOutput` is the single parser, and a
delta gate streams only prose so the block can never leak into the transcript.
A malformed block is a retryable `INVALID_OUTPUT`, not an exception. This keeps
the turn identical across the `anthropic` and `openai_compatible` adapters —
a real design deviation from "the provider's tool channel", deliberate and
tested.

**`WAITING_FOR_PLAYERS → WAITING_FOR_ROLL` was added to the transition table.**
A host can ask an idle table for a check without a DM turn first.
architecture.md §6.3 lists the states but defines no edges, so
`packages/contracts/src/session-state.ts` is the only definition of them — not
a contradiction with the doc, but worth knowing it is not from the doc either.

## 5. Environment caveats

**Docker works now** (Docker Desktop WSL integration), so all 64 integration tests run locally: `docker compose up -d`, then `pnpm db:migrate && pnpm test`. Before that, CI was their only execution — and it caught three real bugs unit tests could not.

- The global `AuthGuard` was running on WebSocket message handlers, finding no cookies, and rejecting every frame. Handshake tests passed the whole time because they never reach a handler. Fixed by scoping the guard to HTTP; there is now a unit test with a stubbed ws `ExecutionContext` so it needs no database.
- The character import schema required a `campaignId` the route already supplied, and the pipe validated the body first — every import was a 400.
- A `/roll ...` typed in chat emitted its event but never wrote its `messages` row, so transcript and event log disagreed (an M3.3 violation).

**Practical consequence:** run the integration suite before pushing anything that touches the gateway or a transaction. It is the only thing that catches this class of bug — M5 found two more that way: two parallel rolls both committed until the advisory lock went in, and the e2e files were deleting each other's rows.

**Test files run serially** (`fileParallelism: false` in `vitest.config.ts`). The integration suites share one database and each TRUNCATEs it in `beforeEach`, so two at once collide on `users_email_key` and on each other's rows. This was latent — it only surfaced when a fifth e2e file made the overlap likely. Do not re-enable parallelism without giving each file its own database.

`.claude/settings.local.json` may still have a **JSON syntax error** — a missing comma after the first entry. A malformed settings file silently disables every setting in it, so the `gh pr merge` permission is not reliably in effect.

---

## 6. Known gaps, deliberate

| Gap | Lands in |
|---|---|
| `@npc <name>` always answers "no NPC here is called that" — the roster's NPC list is empty until campaign notes exist. Alias and ambiguity logic is unit-tested against a populated roster. | M8 (#9) |
| A pending action is closed by character, not by the requested expression. The resumed turn is told the roll result as data; it never re-validates the expression. | product decision (M5 ponytail, kept) |
| Provider config is env vars; nothing stores, selects, or displays credentials in the UI yet. | M7 (#8) |
| No host-control UI. Pause/resume/end/force and `REQUEST_ROLL` are server-side only; M5 has no UI subtask. | M9 (#10) |
| Whispers are hard-coded never DM-visible — the strictest reading of FR-207, and spec-doc.md §16's open question is untouched. | product decision |

Nothing in `spec-doc.md` §16 has been resolved implicitly in code. D-2 (2014 SRD 5.1) is the only one settled, and MVP.md settles it explicitly.
