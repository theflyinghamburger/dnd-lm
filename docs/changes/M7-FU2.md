---
schema_version: 1
id: M7-FU2
title: Act on the surviving independent-review findings across the M7 pull requests
type: bug
profile: standard
state: implementing
source: 'github-actions review comments on #34, #36, #37, #38, #39, #40, #41; triaged
  in #42; subtasks #43, #44, #45'
intent:
  objective: clear
  subject: clear
  current_behavior: clear
  expected_behavior: clear
  scope: clear
  constraints: clear
  verification: clear
clarifications: []
---

## Change brief

Every M7 pull request merged on an *advisory* pass. The reviewer raised roughly
twenty-seven findings across twelve comments and nothing forced them to be
answered, so they merged with the code. #39 cleared three of them. This change
clears the rest that survived re-checking against `main` — a new record rather
than edits to the closed changes, the same rule the event log follows:
corrections are new entries, never rewrites of old ones.

Twelve findings are live and acted on here. Fifteen are dismissed, each with its
reason recorded in #42 — among them three raised repeatedly (the missing
`coalesce` on the jsonb knob merge, the `maxTokens` default said to invent a
value, and the untested span attribute), because the column is `NOT NULL DEFAULT
'{}'`, the other is `NOT NULL DEFAULT 1024`, and the third is already recorded
as accepted residual in M7.8. A finding raised three times is not thereby true.

**A classifier that is confident in the wrong direction.** `classifyProviderError`
turns three SDKs' error types into the four classes that M7.5's verdict card and
M7.9's operator line both read, and its last rule is `status === null` ⇒
`unreachable`. It cannot tell *nothing answered* from *something answered and we
could not handle the reply*, so a malformed body, a mid-stream decode failure,
an adapter bug and a non-`Error` throw all report `reachable: false` about an
endpoint that demonstrably answered. This is not hypothetical: the suite already
contains a case that trips it. `dm.e2e.test.ts:454` throws the shape an SDK
gives an auth rejection — ``401 authentication_error: … rejected by the
provider`` — and the operator line it produces today reads
`class=unreachable`, telling an operator to go chase DNS for a bad key.

Alongside it, `MODEL_MISSING` uses `model[^.]{0,40}…`, a gap that cannot contain
a dot. `The model 'llama-3.1-8b' does not exist` therefore fails to match.
OpenAI answers 404 for an unknown model and is covered by status alone, but
OpenAI-*compatible* servers routinely answer 400 or 422 with the reason in the
body — and dotted model ids are the naming convention of the field, not an edge
case.

**Three write paths whose transactions imply more than they deliver.** The test
result is written with no condition on the configuration it tested, so a
`replaceKey` committing while a test is in flight is overwritten by the old
credential's `authenticated: true` — the stale overclaim #39 existed to remove,
restored through the one interleaving it was written for. `update()` diffs
against an unlocked `SELECT` inside its transaction, so two concurrent PATCHes
diff the same snapshot and the loser writes a real change with an audit row that
records `changed_fields: []`. And `explainNoProvider` runs two unguarded reads
*as an argument to* `reportFailure`, so a DB blip in that window means no event,
no operator line, no failure record at all — the exact invariant `reportFailure`
states in its own comment.

**Five tests that pass whether or not the thing they pin is present**, and two
screens that render nothing when a read fails. The missing-id rate-limit test
produces identical output on the fixed and the reverted code. The invalidation
test covers three of its five branches. The 401 case never asserts `modelExists`,
the retry count is `>= 1` where the decision says exactly two, and the rollup's
failure column is only ever asserted as zero — a predicate matching nothing
passes it forever, and the comment claiming another file covers it names a file
that never runs the query. On the web side, a failed `GET /api/providers` leaves
the campaign settings panel blank, because `connections.error` is unrendered and
the empty-state hint is gated on `data?.length === 0`, which is false when `data`
is `undefined`.

## Specification

AC-1   A status-less, non-transport throw classifies as `provider_error`, not
       `unreachable`: an endpoint that answered keeps `reachable: true` (FR-507).
AC-2   A transport-coded failure, and each SDK's own connection-error wrapper,
       still classify as `unreachable` — including the loopback port-1 path
       M7.5's AC-5 covers (FR-507).
AC-3   `MODEL_MISSING` matches when a dotted model id sits between `model` and
       the failure phrase; a sentence boundary still breaks the match (FR-507).
AC-4   A test verdict is stored only if the row has not been mutated since the
       test began. A verdict about a superseded configuration is dropped, not
       written (NFR-502).
AC-5   `update()`'s before-read and its write observe the same row version, so a
       concurrent PATCH cannot produce an audit row that under-reports what it
       changed (FR-805).
AC-6   A failing diagnostic read never suppresses a failure report: the
       `DM_RESOLUTION_FAILED` event and the operator line are still emitted, with
       the class degraded to `unspecified` (FR-507, NFR-301).
AC-7   The missing-id test fails if the row-read-before-token order is reverted.
AC-8   The invalidation test covers all five branches it names: rename and
       `enabled` retain the verdict; key, `base_url` and `model_id` clear it.
AC-9   The rejected-key test asserts `modelExists === false`.
AC-10  The 401 no-fallback test pins the exact post-retry call count.
AC-11  The per-connection rollup is asserted against a non-zero failure count.
AC-12  A failed providers read on the campaign settings screen renders the
       server's explanation, and "none configured" is distinguishable from
       "the read failed" (FR-506).
AC-13  The replace-key input is cleared on success only (NFR-305).
AC-14  `pnpm test` green against live Postgres, `pnpm db:check` clean,
       typecheck / lint / format green.

## Decisions

- **D-1 — The profile stays `standard`.** The changed paths are
  `apps/api/src/{providers,dm}/**`, `apps/api/test/**` and `apps/web/src/**`;
  none is on the `high-assurance` floor in `.sdlc/policy.yaml`, and nothing here
  touches the schema, a migration or the contracts package. This matches #39,
  the round-one corrective change, which ran `standard` over the same surface.
  Inspection did not turn up risk the paths understate: the secret-handling and
  SSRF code is read, not modified.
- **D-2 — AC-4's write asserts the columns the verdict attests, not a row
  version.** The plan said `updated_at`, on the reasoning that every mutating
  path bumps it. Implementation contradicted it: Postgres stores the column at
  microsecond precision and Drizzle reads it back as a millisecond `Date`, so
  `eq(updatedAt, row.updatedAt)` never matches a freshly created row and *no*
  verdict was stored at all. The write now compares `base_url`, `model_id` and
  the key's nonce — the three things a verdict is a statement about — which is
  exact, binds through Drizzle's own column types, and is strictly better than
  the plan: a no-op PATCH no longer drops a valid verdict. `kind` is absent
  because it is not in `UPDATABLE`; it is fixed at create, which also closes the
  reviewer's open question about switching protocol under a stored verdict. The
  nonce is null exactly when there is no key, so the keyless M7.3 row compares
  with `IS NULL` rather than an equality that can never hold.
- **D-3 — No status scraping from error text.** The obvious extra for AC-1
  would be to read a leading `401` out of the message, which would classify the
  `dm.e2e.test.ts:454` fixture as `unauthenticated` rather than merely
  `provider_error`. Not done: real SDK errors carry `.status`, which `statusOf`
  already finds through `.cause`, and that fixture is a hand-written `Error`
  rather than evidence that a real adapter loses the status. Parsing English out
  of provider text to make a security-relevant classification is a worse habit
  than the honest answer AC-1 gives, which is `provider_error` — something
  answered, we could not classify it further.
- **D-4 — The `delete()` in-use race is out of scope.** It is recorded as
  accepted risk in `M7.8.threat-model.md:67` and the reviewer concurred with
  that analysis. AC-5 closes the `update()` race only.
- **D-5 — The web behaviour stays covered by source scan, not a DOM library.**
  M7.6 decided against adding one, and this change is not the place to reopen a
  dependency decision. AC-12 and AC-13 are held by extending
  `key-handling.test.ts`'s scan; what that cannot express is stated plainly
  rather than papered over.
- **D-6 — The fifteen dismissed findings are recorded in #42, not here.** Each
  carries its reason there. This document covers what is being changed.
- **D-7 — AC-5's defect is over-reporting, not the under-reporting the finding
  described.** The review said the loser of two concurrent PATCHes "moves a
  field while its audit row records `changed_fields` computed against the
  pre-write row — including the empty array for a write that actually changed
  something". Tested, that cannot happen: `update` puts a field in its `set`
  only when the diff says it moved, so a diff reading "unchanged" also writes
  nothing, and the UPDATE takes the row lock regardless, so no write is lost.
  What the stale diff really produces is the mirror image — an audit row
  claiming a change that the concurrent winner had already made. The lock is
  still the right fix and AC-5 still holds; the criterion is worded to the defect
  that exists rather than the one that was reported.

## Plan

Three bounded tasks, one commit each, each ending at a runnable check.

1. **Provider error classification** (#43 — AC-1, AC-2, AC-3).
   Restructure the tail of `classifyProviderError`: transport code *or* an SDK
   connection signature ⇒ `unreachable`; any other status-less throw ⇒
   `provider_error`. Widen the `MODEL_MISSING` gap so a dot only breaks the
   match when it ends a sentence. New unit file
   `apps/api/src/providers/provider-error.test.ts` — no Postgres needed.
   *Check:* `pnpm exec vitest run apps/api/src/providers/provider-error.test.ts`,
   then the M7.5 e2e for the port-1 regression.

2. **Write-path correctness** (#44 — AC-4, AC-5, AC-6).
   Condition `test()`'s result write on the `updated_at` read at the start; take
   `.for('update')` on `update()`'s before-read; wrap `explainNoProvider`'s body
   in `try/catch` returning `'unspecified'` — inside the function, which is the
   smaller diff and holds for any later caller. Red-first on each: assert the
   failure before the fix.
   *Check:* `connection-test.e2e.test.ts`, `provider-connections.e2e.test.ts`,
   `dm-failures.e2e.test.ts`.

3. **Uncovered assertions and the two web surfaces** (#45 — AC-7 … AC-13).
   The five test repairs, then `describeApiError(connections.error)` in a
   `role="alert"` on `CampaignSettings` with the empty hint gated on
   `isSuccess`, and the replace-key clear moved into `onSuccess`. Each test
   repair is verified failing-if-broken by reverting its production line
   locally, confirming red, and restoring — that verification *is* the
   deliverable for AC-7 through AC-11, so it is recorded per criterion.
   *Check:* the full suite against live Postgres, plus typecheck / lint / format.

## Traceability

Not required at `standard`, but AC-7 through AC-11 are repairs to tests that
passed while the thing they named was broken, so "there is a test" is not the
deliverable — "the test fails when the property does" is. Each was verified by
reverting its production line, observing red, and restoring it.

| AC | Covered by | Verified failing-if-broken by |
|---|---|---|
| AC-1 | `provider-error.test.ts` — "an endpoint that answered is never reported unreachable" (3 cases) | Red before the fix: all three returned `unreachable`. |
| AC-2 | same file — transport code, SDK class name, SDK message | Green before and after; the guard against over-correcting AC-1. Plus `connection-test.e2e` AC-5 (port 1) unchanged. |
| AC-3 | same file — dotted id, dot-free id, sentence boundary | Red before the fix on the dotted case. |
| AC-4 | `connection-test.e2e.test.ts` — "drops a verdict whose configuration changed while the test ran" | Red before the fix: the superseded verdict was stored. |
| AC-5 | `provider-audit.e2e.test.ts` — "diffs against a locked row" | Red before `.for('update')`: audit claimed `['label']` for a PATCH that moved nothing. |
| AC-6 | `dm-failures.e2e.test.ts` — "reports the failure even when the diagnostic read itself fails" | Red before the guard: timed out — no event was ever emitted. |
| AC-7 | `connection-test.e2e.test.ts` — the 404 test, now pressed past the limit | Reverted the row-read-before-token order → **red**. The single-press version stayed green. |
| AC-8 | `connection-test.e2e.test.ts` — the invalidation test, now five branches | Deleted `changed.includes('base_url')` → **red**. |
| AC-9 | `connection-test.e2e.test.ts` — the rejected-key test | Set `FIELDS.unauthenticated.modelExists = true` → **red**. |
| AC-10 | `dm-failures.e2e.test.ts` — the no-fallback test | Removed the bounded retry in `graph.ts` → **red**. `>= 1` had stayed green. |
| AC-11 | `dm-failures.e2e.test.ts` — "the rollup counts a real failure" | Typo'd the FILTER's event type → **red**. The zero-failure assertion in `dm-connections.e2e.test.ts` stayed green, which is the point. |
| AC-12 | `key-handling.test.ts` — "gives a failed query somewhere to surface" | Structural only. See below. |
| AC-13 | Not covered by a test. See below. | — |
| AC-14 | `pnpm test` 347 passed / 34 files against live Postgres; `db:check` clean; typecheck, lint, format green. | — |

**Not covered by tests, stated plainly.** AC-12's scan asserts that both
components reference `connections.error` and that the campaign screen gates its
empty state on `isSuccess` — it cannot assert that either element renders, or
what it says. AC-13 has no automated cover at all: that the replace-key input
survives a rejected replace is a behaviour of a mutation callback, and this app
still has no DOM library by M7.6's decision. Both were confirmed by reading the
diff, which is a review step, not a test. Reopening the DOM-library decision is
its own change; it is not smuggled into a corrective one.
