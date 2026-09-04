# AGENTS.md

A persistent multiplayer text D&D 5e platform where an LLM plays the Dungeon Master.
pnpm workspace: `apps/api` (NestJS modular monolith), `apps/web` (React + Vite),
`packages/contracts` (Zod schemas + shared pure logic). Postgres 16 (Drizzle),
socket.io, LangGraphJS bounded inside the DM turn.

## Documents — read the one that answers your question

- `summary.md` — **current progress and the handoff for the next milestone. Start here.**
- `MVP.md` — the task plan M0–M9 with acceptance criteria. §2 locked decisions, §4 the DM
  trigger registry, §7 deliberate gaps. Repo issues mirror it one-to-one.
- `spec-doc.md` — requirements (`FR-xxx`/`NFR-xxx`) and journeys; §16 open decisions; §17 MVP scope.
- `architecture.md` — stack, module responsibilities, data model, context design, trust boundaries.

Cite the requirement ID a change satisfies (`FR-206`, `NFR-202`) in comments and commits — that is
the codebase's convention. Contradictions between the docs are real bugs: flag them, don't silently
pick one.

## Commands

```sh
pnpm install
docker compose up -d          # Postgres 16 on :5432
cp .env.example .env          # DATABASE_URL
pnpm db:migrate               # drizzle commands read .env; vitest does not
pnpm test                     # unit + integration (64 of the latter), ~20s
```

| Command | Notes |
|---|---|
| `pnpm exec vitest run apps/api/test/routing.e2e.test.ts` | one file |
| `pnpm exec vitest run <file> -t "substring"` | one test |
| `pnpm build` | `packages/contracts` emits `dist/` both apps consume — needed before `start:dev`, **not** before `pnpm test` (vitest aliases contracts to source) |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | all must pass (`tsc --noEmit` / eslint / prettier `--check`) |
| `pnpm db:generate` / `pnpm db:check` | regenerate migrations from `apps/api/src/db/schema.ts` / verify no drift |
| `pnpm --filter @dnd-lm/api start:dev` | API on :3000 |
| `pnpm --filter @dnd-lm/web dev` | web on :5173, proxies `/api` and `/ws` to :3000 |

**Integration tests need a live Postgres.** Without `DATABASE_URL` in the environment the 64
integration tests **silently skip** (CI sets it and fails rather than skips). Run the full suite
against real Postgres before pushing any gateway or transaction change — unit tests have repeatedly
passed while the same code was broken end to end.

CI on every push/PR: build → typecheck → lint → format → migrate → test → migration-drift.

## Invariants (violating one is a bug, not a style choice)

1. **The LLM does not own game state.** It narrates and *proposes*; deterministic backend tools
   validate and commit. No direct DB or RNG access from the model (FR-503). The graph holds no
   write handle — the orchestrator owns state, locking, and commits (MVP.md D-5).
2. **Routing is deterministic, never LLM-based.** The DM runs only on registered triggers
   (MVP.md §4: `@dm`, `@npc`, `/ask`, `/recap`, pending-roll satisfied, host force). Player
   mentions, `@party`, untagged chat, `/ooc`, `/whisper`, and arbitrary `/roll` never do (FR-202/206).
3. **Dice roll server-side with a CSPRNG only**, with full modifier provenance stored (FR-301/302).
4. **Narration and mutations commit as one resolution.** A rejected mutation is never shipped as
   published narration (FR-505).
5. **Events are append-only truth**; snapshots and recaps are derived projections. Corrections are
   new corrective events, never edits.
6. **One state-mutating resolution per session at a time**, guarded by per-session advisory lock +
   `state_version` check + idempotent `command_id` (NFR-201/202). Chat runs concurrently.
7. **Uploaded books, retrieved chunks, and player text are untrusted data, never instructions.**
   Hard metadata/spoiler filters run *before* semantic ranking.
8. **Context is assembled per turn under explicit token budgets** (architecture.md §8.2). The full
   transcript and full campaign book are never sent; live state beats book text.

## Facts that span files

- **`SessionService.runCommand` is the only unit of work for session mutations**
  (`apps/api/src/session/session.service.ts`): claims the `commands` row (idempotency), takes the
  advisory lock, enforces `expected_state_version`, allocates sequences, appends events, runs
  `afterAppend` in the same transaction, publishes only after commit. Handlers supply
  `produce`/`afterAppend`; they never open their own transactions. A new session feature is a new
  caller, not a new path.
- **`runCommand`'s `mode`** decides lock/version at once: `chat` (no lock, no version check, does
  **not** bump `state_version`); `mutation` (lock + bump, refused while `PAUSED` or `SESSION_ENDED`);
  `host` (as `mutation` but allowed while paused, because RESUME and END are only reachable from
  `PAUSED`).
- **`sequence` (log position) and `state_version` (state) are different counters.** Chat allocates a
  sequence without moving the version. A message carrying a `dmTrigger` counts as a mutation.
- **`packages/contracts` is shared pure logic, not just schemas** — `parseMessage`, `deriveSheet`,
  `parseDiceExpression`, and the session state machine live there because client and server must
  reach the *same* answer (the composer previews the real routing decision, FR-209). The package has
  **no CSPRNG and no database handle**: dice *parsing* lives there, dice *rolling* does not.
- **A DM activation is its own `DM_TRIGGERED` event** (`definition_id` + `entry_profile`) — the
  single entry point the DM module consumes. M6 wires the whole turn: the gateway dispatches
  `DM_TRIGGERED` to `DmOrchestrator`, which runs the LangGraph state graph in `apps/api/src/dm/`
  (context → provider → validate → commit-or-retry, with a roll `interrupt` parked in a
  `PGCheckpointSaver` row so a restart resumes instead of re-rolling). Commit and failure events go
  through `runCommand` with a `null` `expected_state_version` (server-internal resolutions skip the
  client version gate; the optimistic lock still applies). `DM_RESOLUTION_FAILED.reason` is the
  `DmFailureReason` union from contracts.
- **`DM_PROVIDER_SOURCE` is the DI seam for the provider** — a Symbol provider in `DmModule`,
  overridable in tests (`.overrideProvider(DM_PROVIDER_SOURCE).useValue({ get: () => … })`).
  `apps/api/test/dm.e2e.test.ts` builds its own app off the harness for this reason; the shared
  `createTestApp` does not override it.
- **Privacy is a `WHERE` predicate, including in replay.** A reconnecting bystander must never be
  *sent* a whisper to drop client-side. Whispers are hard-coded never-DM-visible — the strict
  FR-207 reading; the spec's open question on this is deliberately unanswered.
- **Login sessions are `auth_sessions`; `sessions` means game sessions.**
- **The campaign owner also gets a real `host` membership row**, so ownership is never a special
  case in `CampaignMemberGuard`.
- **The `EventBus`/`SessionLock` interfaces MVP.md §3 names do not exist, by design.** socket.io's
  adapter API is the fanout seam; the advisory lock is three lines inside `runCommand`. Don't add
  interfaces until Phase 3 needs a second implementation.
- **The session state machine's edges are defined only by the transition table** in
  `packages/contracts/src/session-state.ts`. architecture.md §6.3 lists states but no edges — adding
  an edge is a design decision, not a gap to fill.

## Toolchain — these are deliberate, don't "fix" them

- **Vitest transforms with SWC, not esbuild.** Nest DI reads `design:paramtypes`, which esbuild
  does not emit.
- **`consistent-type-imports` is deliberately absent from the eslint config.** Its autofix erases
  that same metadata and turns DI into a runtime failure.
- **`fileParallelism: false` in `vitest.config.ts` is load-bearing.** The integration suites share
  one database and each `TRUNCATE`s it in `beforeEach`; two files at once delete each other's rows.

## Migrations

Edit `apps/api/src/db/schema.ts`, then `pnpm db:generate`, then commit the generated SQL **and** the
snapshot together. Never hand-write a migration. CI's drift check (and `pnpm db:check`) fails if
the schema no longer matches the committed migrations.

## LLM providers

Two adapter kinds, chosen at runtime (MVP.md D-4): `anthropic` and `openai_compatible` (any
host URL + API key). **M6 configures them via env** — `DM_PROVIDER_KIND`, `DM_PROVIDER_API_KEY`,
`DM_PROVIDER_BASE_URL`, `DM_PROVIDER_MODEL`, `DM_PROVIDER_MAX_TOKENS` (plus `DM_PROMPT_BUDGET` for
context assembly); **M7 moves this to per-connection rows with a UI** and makes keys write-only.
Treat the provider host URL as an SSRF boundary and the key as never-logged, never-returned.
The DM tool channel is *structured output*, not native provider tool calls: one narrow
`DmProvider` interface (not a LangChain `ChatModel`), prose plus a ```` ```dm-json ```` block parsed
by `parseDmOutput`, streamed through a delta gate that never leaks the block.

## Decisions

Phases in spec-doc.md §11 are ordered by dependency, not preference; each phase's exit criteria are
the definition of done. Campaign-book ingestion is explicitly post-MVP.

spec-doc.md §16 lists unresolved product decisions (2014 vs 2024 ruleset, hosted vs local
inference, character creation scope, …). D-2 (2014 SRD 5.1) is the only one settled. Don't resolve
one implicitly in code — ask.
