# Build summary — DnD LM

**Repo:** [theflyinghamburger/dnd-lm](https://github.com/theflyinghamburger/dnd-lm) (private)
**As of:** 2026-09-04
**Progress:** M0–M4 merged. M5 partially done on a branch. M6–M9 not started.

---

## 1. Where things stand

| Task | Issue | State | PR |
|---|---|---|---|
| M0 — Repository, contracts, CI | [#1](https://github.com/theflyinghamburger/dnd-lm/issues/1) | **merged** | [#11](https://github.com/theflyinghamburger/dnd-lm/pull/11) |
| M1 — Identity, campaigns, memberships | [#2](https://github.com/theflyinghamburger/dnd-lm/issues/2) | **merged** | [#13](https://github.com/theflyinghamburger/dnd-lm/pull/13) |
| M2 — Realtime gateway, ordering, idempotency, replay | [#3](https://github.com/theflyinghamburger/dnd-lm/issues/3) | **merged** | [#14](https://github.com/theflyinghamburger/dnd-lm/pull/14) |
| M3 — Deterministic router, trigger registry, messaging | [#4](https://github.com/theflyinghamburger/dnd-lm/issues/4) | **merged** | [#15](https://github.com/theflyinghamburger/dnd-lm/pull/15) |
| M4 — Characters and dice | [#5](https://github.com/theflyinghamburger/dnd-lm/issues/5) | **merged** | [#16](https://github.com/theflyinghamburger/dnd-lm/pull/16) |
| M5 — Session orchestrator | [#6](https://github.com/theflyinghamburger/dnd-lm/issues/6) | **partial**, branch `m5-orchestrator` | none yet |
| M6 — The LangGraph DM | [#7](https://github.com/theflyinghamburger/dnd-lm/issues/7) | not started | |
| M7 — Provider configuration and secrets | [#8](https://github.com/theflyinghamburger/dnd-lm/issues/8) | not started | |
| M8 — Manual campaign notes and retrieval | [#9](https://github.com/theflyinghamburger/dnd-lm/issues/9) | not started | |
| M9 — MVP acceptance | [#10](https://github.com/theflyinghamburger/dnd-lm/issues/10) | not started | |

179 tests on `main` + the M5 branch: 137 unit, 42 integration. CI runs build → typecheck → lint → format → migrate → test → migration-drift on every push, against a real Postgres 16 service.

### PR #12 is dead

GitHub auto-closed it when its base branch was deleted on merge of #11. #13 is the same commit rebased onto `main`. **Do not use `--delete-branch` while a stacked PR still points at that branch.**

---

## 2. What exists

```
apps/api            NestJS 12 — auth, campaigns, session, router, dice, characters
apps/web            React 19 + Vite + TanStack Query — lobby, chat, character sheet
packages/contracts  Zod schemas AND the pure logic both sides must agree on
fixtures/pregens    Six level-3 SRD characters
```

**Postgres tables:** `users`, `auth_sessions`, `campaigns`, `memberships`, `invites`, `sessions`, `session_events`, `commands`, `messages`, `characters`, `rolls`, `pending_actions`. Five migrations, drift-checked.

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

## 4. Start here: finishing M5

Branch `m5-orchestrator` is green and pushed. Done: **M5.1** (state machine, 18 tests), the `pending_actions` table with `graph_thread_id` ready for M6's checkpoint, and `sessions.paused_from`.

Remaining, in order:

### M5.2 — Advisory lock

`SELECT pg_advisory_xact_lock(hashtext($session_id))` as the first statement of a **mutating** resolution, inside `SessionService.runCommand`. Transaction-scoped, so it releases on commit or rollback with no cleanup path to forget. Carry over MVP.md's own note: the key is a 32-bit hash, so two unrelated sessions can serialize — harmless at MVP scale, revisit with a lock table if it ever measures.

### M5.4 — Enforce `expected_state_version`

**Read this before writing it.** M2 deliberately carries the field without enforcing it, because enforcing it there makes M2's own acceptance criterion — *two concurrent commands produce two events with contiguous sequences* — unsatisfiable: the second command is stale the moment the first commits.

The reconciliation is the mutating/non-mutating split MVP.md M5.2 already draws:

- **Non-mutating** (table chat, `@player`, `@party`, `/ooc`, `/whisper`): no advisory lock, no version check, and **does not bump `state_version`**. It allocates a sequence and appends. Chat stays responsive while the DM generates, and a chatty table does not invalidate every client's version.
- **Mutating** (DM resolutions, rolls, host controls, HP): takes the lock, checks `expected_state_version`, bumps it.

So `runCommand` needs a `mutating: boolean`, and `allocate()` needs a `bumpVersion` flag. The `STATE_CONFLICT` contract already exists in `packages/contracts` and is currently unused.

### M5.5 — Pending actions and the resume trigger

A roll closes a pending action only when the action is `open` **and** the rolling character is in `authorized_character_ids`. An unrelated or unauthorized roll changes nothing and resumes nothing. Closing one emits `PENDING_ACTION_COMPLETED`, which is where M6 attaches the graph resume.

Nothing creates a pending action yet — the graph that would interrupt does not exist. Add a **host-only `REQUEST_ROLL` command**: it is a real feature (a host asking the party for a check), it exercises the whole mechanism now, and it is the exact seam M6's interrupt reuses.

### M5.6 — Host controls

`PAUSE_SESSION`, `RESUME_SESSION`, `END_SESSION`, `FORCE_DM_TURN`, all host-only and all mutating. Pause must reject mutating commands and block **all** triggers while leaving chat live — so the gateway checks `acceptsMutations(session.status)` for mutating commands and for any decision carrying a `dmTrigger`, and lets everything else through. Resume returns to `paused_from`.

`FORCE_DM_TURN` has no graph to call yet; emit `DM_TRIGGERED` with the `host_turn` definition and return to `WAITING_FOR_PLAYERS`. M6 makes it generate.

New error codes needed: `SESSION_PAUSED`, `ILLEGAL_TRANSITION`, `NOT_AUTHORIZED_TO_ROLL`.

### The four acceptance tests

1. **Two simultaneous mutating commands cannot double-spend** — with real parallel connections, not sequential calls. The cleanest subject is two rolls racing to close one pending action: exactly one closes it.
2. **A thrown error anywhere in a resolution leaves `state_version` and the event log untouched** — drive it with a `produce()` that throws.
3. **A killed API mid-resolution leaves no partial state**; retrying the same `command_id` returns a clean result. The idempotency ledger from M2.3 already covers the retry half.
4. **A roll by an unauthorized character does not resume a parked run.**

---

## 5. Environment caveats

**There is no Docker and no sudo on this machine**, so the 42 integration tests have never run locally — CI is their only execution. That is not theoretical: CI caught three real bugs that unit tests could not.

- The global `AuthGuard` was running on WebSocket message handlers, finding no cookies, and rejecting every frame. Handshake tests passed the whole time because they never reach a handler. Fixed by scoping the guard to HTTP; there is now a unit test with a stubbed ws `ExecutionContext` so it needs no database.
- The character import schema required a `campaignId` the route already supplied, and the pipe validated the body first — every import was a 400.
- A `/roll ...` typed in chat emitted its event but never wrote its `messages` row, so transcript and event log disagreed (an M3.3 violation).

**Practical consequence:** expect a red first CI run on anything touching the gateway or a transaction, and read the log rather than assuming the code is right. Getting a local Postgres (Docker Desktop WSL integration, or `apt install postgresql-16`) would pay for itself immediately.

`.claude/settings.local.json` currently has a **JSON syntax error** — a missing comma after the first entry. A malformed settings file silently disables every setting in it, so the `gh pr merge` permission is not reliably in effect.

---

## 6. Known gaps, deliberate

| Gap | Lands in |
|---|---|
| `@npc <name>` always answers "no NPC here is called that" — the roster's NPC list is empty until campaign notes exist. Alias and ambiguity logic is unit-tested against a populated roster. | M8 (#9) |
| `rolls.pending_action_id` has no foreign key — `pending_actions` only arrives with M5.5. | M5 (#6) |
| `ProposedStateChange.operation` is an open string; only the validator may accept one. | M6.5 (#7) |
| No provider, so nothing consumes `DM_TRIGGERED` yet. | M6 (#7) |
| Whispers are hard-coded never DM-visible — the strictest reading of FR-207, and spec-doc.md §16's open question is untouched. | product decision |

Nothing in `spec-doc.md` §16 has been resolved implicitly in code. D-2 (2014 SRD 5.1) is the only one settled, and MVP.md settles it explicitly.
