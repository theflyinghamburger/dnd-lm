# Build summary — DnD LM

**Repo:** [theflyinghamburger/dnd-lm](https://github.com/theflyinghamburger/dnd-lm) (private)
**As of:** 2026-09-05
**Progress:** M0–M7.9. M5–M7.7 merged (#17, #18, #28–#32). The rest of M7 is open as one stack: #35 (gate fix) → #34 (M7.5) → #36 (M7.8) → #37 (M7.9) → #38 (M7.6), all tests passing on live Postgres. M8 and M9 not started.

---

## 1. Where things stand

| Task | Issue | State | PR |
|---|---|---|---|
| M0 — Repository, contracts, CI | [#1](https://github.com/theflyinghamburger/dnd-lm/issues/1) | **merged** | [#11](https://github.com/theflyinghamburger/dnd-lm/pull/11) |
| M1 — Identity, campaigns, memberships | [#2](https://github.com/theflyinghamburger/dnd-lm/issues/2) | **merged** | [#13](https://github.com/theflyinghamburger/dnd-lm/pull/13) |
| M2 — Realtime gateway, ordering, idempotency, replay | [#3](https://github.com/theflyinghamburger/dnd-lm/issues/3) | **merged** | [#14](https://github.com/theflyinghamburger/dnd-lm/pull/14) |
| M3 — Deterministic router, trigger registry, messaging | [#4](https://github.com/theflyinghamburger/dnd-lm/issues/4) | **merged** | [#15](https://github.com/theflyinghamburger/dnd-lm/pull/15) |
| M4 — Characters and dice | [#5](https://github.com/theflyinghamburger/dnd-lm/issues/5) | **merged** | [#16](https://github.com/theflyinghamburger/dnd-lm/pull/16) |
| M5 — Session orchestrator | [#6](https://github.com/theflyinghamburger/dnd-lm/issues/6) | **merged** | [#17](https://github.com/theflyinghamburger/dnd-lm/pull/17) |
| M6 — The LangGraph DM | [#7](https://github.com/theflyinghamburger/dnd-lm/issues/7) | **merged** | [#18](https://github.com/theflyinghamburger/dnd-lm/pull/18) |
| M7.1 — Provider connections data model | [#19](https://github.com/theflyinghamburger/dnd-lm/issues/19) | **merged** | [#28](https://github.com/theflyinghamburger/dnd-lm/pull/28) |
| M7.2 — Secret handling (AES-256-GCM, write-only keys) | [#20](https://github.com/theflyinghamburger/dnd-lm/issues/20) | **merged** | [#29](https://github.com/theflyinghamburger/dnd-lm/pull/29) |
| M7.3 — Base URL validation (SSRF) | [#21](https://github.com/theflyinghamburger/dnd-lm/issues/21) | **merged** | [#30](https://github.com/theflyinghamburger/dnd-lm/pull/30) |
| M7.4 — Authorization: admin-managed connections | [#22](https://github.com/theflyinghamburger/dnd-lm/issues/22) | **merged** | [#31](https://github.com/theflyinghamburger/dnd-lm/pull/31) |
| M7.7 — Adapter wiring from connections | [#25](https://github.com/theflyinghamburger/dnd-lm/issues/25) | **merged** | [#32](https://github.com/theflyinghamburger/dnd-lm/pull/32) |
| M7.5 — Test connection | [#23](https://github.com/theflyinghamburger/dnd-lm/issues/23) | PR open, stacked on #35 | [#34](https://github.com/theflyinghamburger/dnd-lm/pull/34) |
| M7.8 — Audit and attribution | [#26](https://github.com/theflyinghamburger/dnd-lm/issues/26) | PR open, stacked on #34 | [#36](https://github.com/theflyinghamburger/dnd-lm/pull/36) |
| M7.9 — Provider failure behaviour | [#27](https://github.com/theflyinghamburger/dnd-lm/issues/27) | PR open, stacked on #36 | [#37](https://github.com/theflyinghamburger/dnd-lm/pull/37) |
| M7.6 — Config UI | [#24](https://github.com/theflyinghamburger/dnd-lm/issues/24) | PR open, stacked on #37 | [#38](https://github.com/theflyinghamburger/dnd-lm/pull/38) |
| The gate could not find a dotted work-item id (`M7.5.md`) | — | PR open, base of the stack | [#35](https://github.com/theflyinghamburger/dnd-lm/pull/35) |
| M8 — Manual campaign notes and retrieval | [#9](https://github.com/theflyinghamburger/dnd-lm/issues/9) | not started | |
| M9 — MVP acceptance | [#10](https://github.com/theflyinghamburger/dnd-lm/issues/10) | not started | |

285 tests on the M7.7 branch (top of the stack): unit + integration, all of them run, locally and in CI. CI runs build → typecheck → lint → format → migrate → test → migration-drift on every push, against a real Postgres 16 service. The integration suite silently skips without `DATABASE_URL` in the environment — always `set -a; source .env; set +a` first.

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

## 4. Start here: M7.7 lands the adapters on the connections; M7.5, M7.6, M7.8, M7.9 remain

- **The DM runs on the campaign's selected connection (M7.7).**
  `DmProviderSource.get(campaignId)` re-reads the row on *every* turn — decrypt the key,
  build the adapter — so a rekey or model change takes effect on the next turn, no restart.
  `openai_compatible` fetches through `resolvedIpFetch` (the M7.3 wall with the connect
  pinned to the address the check just approved — the DNS TOCTOU is closed, the
  request goes to the checked IP, SNI/Host stay the original host); a keyless row
  crosses a placeholder, never a secret. The `DM_PROVIDER_*` env vars are gone
  (`DM_PROMPT_BUDGET` stays, context assembly). No selection — or a disabled, or
  invalid-URL — row is a clean typed `NO_PROVIDER` failure, and the state never moves.
  E2E: `apps/api/test/dm-connections.e2e.test.ts` runs the *real* `DmProviderSource`
  (no override) against local mock OpenAI-compatible SSE servers — the seam M7.5's
  "test connection" reuses, per that issue's own dependency note.
- **The key material lives in `ProviderSecrets` only** (`apps/api/src/providers/`):
  encrypt/decrypt/replace-key over node:crypto AES-256-GCM, fresh nonce per write, master key
  from `PROVIDER_KEY_ENCRYPTION_KEY` (64 hex, validated at startup). Keys are write-only at
  every seam; `redact` is the choke point every provider-facing string passes through (M6's
  orchestrator already calls it).
- **The SSRF wall is `BaseUrlService.validate` + `guardedFetch` + `resolvedIpFetch`**
  (M7.3, `apps/api/src/providers/base-url.ts`), and it is fully wired now (M7.7):
  save-time validation in the admin create/update; at request time
  `openai_compatible` goes through `resolvedIpFetch` (allowlist/loopback opt-in
  connects by name, everything else by the approved address), and a redirect that
  crosses hosts is refused before any second request; `anthropic` re-validates the
  URL before each call — the SDK does its own DNS, so the residual TOCTOU is the
  documented one, named at the call site.
- **Authorization is done** (M7.4): platform admin = an `admin` membership in *any*
  campaign (option (a), zero new columns; decided as the in-thread default). `/api/admin/providers`
  is the admin CRUD surface; `GET /api/providers` returns the redacted enabled list whose
  `HostConnection` shape structurally cannot carry a URL or key; `PATCH /campaigns/:id/provider`
  (host-or-admin on that campaign) writes `settings.provider_connection_id`. Deleting a
  connection a campaign references is 409 naming the campaign, deliberately *not* a silent clear.

### What M5–M7 decided that should not be re-litigated

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

**Connection reads and writes are plain DB transactions, not `runCommand`.**
A `provider_connections` row is not a session state mutation (M7.4 process,
step 2), so the admin surface never claims a `commands` row or touches
`state_version`. "One state-mutating resolution per session" is unchanged.

**The host-facing redaction is the missing columns, not a filter.** The
`HostConnection` DTO (id, label, kind, modelId, enabled) has no URL and no
key field to strip — the projection never selects them. A filter that could
leak is worse than a shape that couldn't.

**The campaign-settings writer takes only `providerConnectionId`.** M7.4's
endpoint does not also write DM style/tone/difficulty (FR-506's broader
surface) — that shape is undefined and lands with the M7.6 config UI (#24).
Said in PR #31, not silently skipped.

### The rest of M7, in one stack

Merge in order: **#35 → #34 → #36 → #37 → #38.** Each is based on the one
before it, so merging out of order rebases the rest.

- **#35 first, and it is not optional.** `find_item` accepted a work item only
  if its filename had exactly one dot, so `docs/changes/M7.5.md` was invisible
  and the gate reported "no work-item file" on a change whose work item was in
  the diff. Every `M7.x` pull request fails the `sdlc` job until this lands.
  The same bug is in the upstream suite and in every other install of it.
- **M7.5 (#34)** — `POST /api/admin/providers/:id/test`: one real minimal call
  through the *same* row→provider path a turn uses, reported as five
  independently falsifiable fields. `DmProviderSource` now builds through
  `ProviderConnectionsService.sourceFromRow`, so the test cannot drift from the
  path a turn takes. `classifyProviderError` lands here and M7.9 reuses it.
- **M7.8 (#36)** — `provider_connection_audit`, one row per mutation in that
  mutation's transaction, field *names* only. No foreign key to
  `provider_connections` on purpose: an audit row outlives the row it audits.
  Resolution events carry `provider_connection_id` and `model_id`, and the
  per-connection failure/cost roll-up query runs in the e2e suite.
- **M7.9 (#37)** — provider failures are classified in `callDm` (a 401 used to
  escape the graph and be reported as `INTERNAL`), and every failed resolution
  writes one greppable operator line: reason, class, resolution, session,
  connection, model, redacted detail. Three ad-hoc failure logs were removed in
  favour of it. No fallback chain, asserted.
- **M7.6 (#38)** — the two screens. Admin → Providers (list, test, edit,
  replace key, delete) and Campaign → Settings (provider dropdown over the
  redacted list, plus the FR-506 knobs). The knobs' vocabulary was undefined
  anywhere and is now three enums; they are inert until someone wires them into
  the prompt. The write-only key rule is asserted by a source scan over
  `apps/web/src`, not a DOM test.

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
| The FR-506 DM knobs (style, tone, difficulty) are stored and displayed but do not reach the DM's prompt. Deliberate: host-chosen values entering the system prompt need invariant-7 treatment, and #24 did not ask for it. | a later change |
| No host-control UI. Pause/resume/end/force and `REQUEST_ROLL` are server-side only; M5 has no UI subtask. | M9 (#10) |
| Whispers are hard-coded never DM-visible — the strictest reading of FR-207, and spec-doc.md §16's open question is untouched. | product decision |

Nothing in `spec-doc.md` §16 has been resolved implicitly in code. D-2 (2014 SRD 5.1) is the only one settled, and MVP.md settles it explicitly.
