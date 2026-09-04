# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What the system is

A persistent multiplayer text D&D 5e platform where an LLM plays the Dungeon Master. React + Vite + TS frontend, NestJS modular monolith backend, socket.io realtime, PostgreSQL (Drizzle), and LangGraphJS bounded inside the DM module only. Redis, BullMQ workers, pgvector and S3 are in the architecture but not yet in the code.

## Documents, and which one answers what

- `spec-doc.md` — requirements (`FR-xxx` by P0/P1/P2, `NFR-xxx`), journeys, JSON contracts, delivery phases, release gates. §16 is the open-decisions list, §17 the MVP scope.
- `architecture.md` — stack, module responsibilities, data model, context/memory design, runtime flows, trust boundaries.
- `MVP.md` — the Phase 0–2 task plan, M0–M9, each with acceptance criteria. Decisions locked for the MVP are §2, the DM trigger registry §4, deliberate gaps §7. Read it before implementation work; repo issues mirror it one-to-one.
- `summary.md` — **current progress and the handoff for the next milestone.** Which tasks are done, what the last one decided, environment caveats. Start here.

Cite the requirement ID a change satisfies (`FR-206`, `NFR-202`) in code comments and commits. Contradictions between the docs are real bugs — flag them rather than silently picking one.

## Commands

```sh
pnpm install
docker compose up -d                  # Postgres 16 on :5432
cp .env.example .env
pnpm db:migrate                       # needs DATABASE_URL
pnpm test                             # 193 tests: unit + integration
```

| Command | Notes |
|---|---|
| `pnpm test` | vitest across the workspace. Needs no `pnpm build` — vitest aliases `@dnd-lm/contracts` to source |
| `pnpm exec vitest run apps/api/test/routing.e2e.test.ts` | one file |
| `pnpm exec vitest run <file> -t "substring"` | one test |
| `pnpm build` | `packages/contracts` emits `dist/` that both apps consume; required before `start:dev` |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | `tsc --noEmit` per project / eslint / prettier `--check` |
| `pnpm --filter @dnd-lm/api start:dev` | API on :3000 |
| `pnpm --filter @dnd-lm/web dev` | web on :5173, proxies `/api` and `/ws` |
| `pnpm db:generate` | regenerate migrations from `apps/api/src/db/schema.ts` |

**The integration tests are the ones that find real bugs.** Without `DATABASE_URL` they silently skip (and CI fails rather than skipping). Every gateway or transaction change must be run against a real Postgres before pushing — unit tests have repeatedly passed while the same code was broken end to end.

CI runs build → typecheck → lint → format → migrate → test → migration-drift on every push.

## Invariants that constrain every design decision

These are the point of the architecture. Violating one is not a style disagreement:

1. **The LLM does not own game state.** It narrates and *proposes*; deterministic backend tools validate and commit. No direct DB or RNG access from the model (FR-503). LangGraph is bounded inside one DM turn and holds no write handle — the orchestrator owns state, locking, and commits (architecture.md §14 decision 5).
2. **Routing is deterministic, never LLM-based.** The DM runs only when a message matches the trigger registry (MVP.md §4); player mentions, `@party`, untagged chat, `/ooc`, `/whisper`, arbitrary `/roll`, and any unrecognized tag do not (FR-202/206, router table in architecture.md §6.2).
3. **Dice roll server-side with a CSPRNG**, with full modifier provenance stored (FR-301/302).
4. **Narration and mutations commit as one logical resolution.** A rejected mutation must not ship as published narration (FR-505).
5. **Events are append-only truth; snapshots and Markdown recaps are derived projections.** Corrections are new corrective events, never edits.
6. **One state-mutating resolution per session at a time**, guarded by `state_version` + idempotent `command_id` (NFR-201/202). Non-mutating chat runs concurrently.
7. **Uploaded books, retrieved chunks, and player text are untrusted data**, never instructions. Hard metadata/spoiler filters run *before* semantic ranking so future-chapter and cross-campaign content cannot leak.
8. **Context is assembled per turn under explicit token budgets** (architecture.md §8.2). Full transcript and full campaign book are never sent. Live state beats source-book text; canonical state beats summaries.

## Architecture facts that span files

**`SessionService.runCommand` is the single unit of work** for anything that touches a session (`apps/api/src/session/session.service.ts`). It claims the `commands` row for idempotency, optionally takes the per-session advisory lock, enforces `expected_state_version`, allocates sequences, appends events, runs an `afterAppend` hook in the same transaction, and publishes only after commit. Handlers supply `produce`/`afterAppend`; they do not open their own transactions. Adding a session-mutating feature means a new caller, not a new path.

**`runCommand` takes a `mode`**, and it decides three things at once:
- `chat` — table talk, `@player`, `@party`, `/ooc`, `/whisper`. No lock, no version check, and **does not bump `state_version`**.
- `mutation` — rolls, DM turns, anything starting one. Lock + version check + bump, and refused while the session is paused or ended.
- `host` — as `mutation`, but permitted while paused, because RESUME and END are only reachable from `PAUSED`.

**`sequence` and `state_version` are different counters.** `sequence` is append-only log position; `state_version` tracks state. Chat allocates a sequence without moving the version — that is what makes `expected_state_version` enforceable without a chatty table invalidating every client. A message carrying a `dmTrigger` counts as a mutation, because it starts a DM turn.

**`packages/contracts` holds pure logic, not only Zod schemas.** `parseMessage`, `deriveSheet`, `parseDiceExpression` and the session state machine live there because the client must reach the *same* answer as the server — the composer previews the real routing decision (FR-209), and a second implementation is the drift that would break FR-202. The rule that keeps it honest: **that package has no CSPRNG and no database handle.** Dice *parsing* is there; dice *rolling* is not. FR-301 is therefore a property of where code lives rather than a convention someone must remember.

**A DM activation is its own `DM_TRIGGERED` event**, carrying `definition_id` and `entry_profile`. It is what makes the release gate assertable with no provider configured, and it is the single entry point M6 consumes.

**Privacy is a `WHERE` predicate, including in replay.** A bystander who reconnects must never be *sent* a whisper to drop client-side.

**Login sessions are `auth_sessions`; `sessions` means game sessions.** Two things called "session" in one schema is a bug waiting to happen.

**The campaign owner also gets a real `host` membership row**, so ownership is never a special case in `CampaignMemberGuard` — one lookup answers every authorization question.

**Neither the `EventBus` nor the `SessionLock` interface MVP.md §3 names exists**, deliberately. socket.io's adapter API already is the fanout seam (Phase 3 is `@socket.io/redis-adapter` on the server, no caller changes), and the advisory lock is three lines inside `runCommand`, which is the only caller an interface would have had. Both are single-implementation abstractions until Phase 3 needs a second.

**The session state machine's transition table is the only definition of its edges** (`packages/contracts/src/session-state.ts`). architecture.md §6.3 lists the states but no transitions, so adding an edge is a design decision to make deliberately, not a gap to fill in passing.

## Toolchain constraints that look like bugs

- **Vitest transforms with SWC, not esbuild.** Nest DI reads `design:paramtypes`, which esbuild does not emit.
- **`consistent-type-imports` is deliberately absent from the eslint config.** Its autofix erases that same metadata and turns DI into a runtime failure. Do not add it.
- **`fileParallelism: false` in `vitest.config.ts` is load-bearing.** The integration suites share one database and each `TRUNCATE`s it in `beforeEach`, so two files at once collide on `users_email_key` and delete each other's rows. Do not re-enable parallelism without giving each file its own database.

## Migrations

Edit `apps/api/src/db/schema.ts`, then `pnpm db:generate`, then commit the generated SQL and snapshot together. CI fails if the schema no longer matches the committed migrations. Never hand-write a migration.

## LLM providers

Configured at runtime through the UI (MVP.md M7), not by env or code: an operator supplies a host URL and API key per connection. Treat that URL as an SSRF boundary and the key as write-only across the API.

## Build order and open decisions

`MVP.md` sequences M0–M9; `summary.md` says where that has got to. Beyond the MVP, phases in spec-doc.md §11 are ordered by dependency, not preference — routing and state correctness precede ingestion. Each phase's exit criteria are the definition of done. Campaign-book ingestion is explicitly post-MVP.

spec-doc.md §16 lists unresolved product decisions (2014 vs 2024 5e ruleset, hosted vs local inference, character creation scope, and others). Only D-2 (2014 SRD 5.1) is settled, and MVP.md settles it explicitly. Don't resolve one implicitly in code — ask.
