---
schema_version: 1
id: M7-review-followups
title: Act on the independent review's findings for M7.5 and M7.8
type: bug
profile: standard
source: CI review comments on PRs
state: reviewing
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

The independent reviewer passed #34 and #36 and raised findings on both. Both
pull requests merged before the findings were acted on, so this is the corrective
change — a new record rather than an edit to theirs, which is the same rule the
event log follows: corrections are new entries, never rewrites of old ones.

Three findings are addressed here. The fourth and fifth (M7.9's) travel with
that change, which is still open.

**A stored test result outlived the configuration it tested.** Neither
`replaceKey` nor `update` touched `last_test_result`, so after an admin rotated
a key or moved the base URL, `AdminConnection.lastTest` still reported
`authenticated: true` about a setup that no longer existed — and M7.6 renders
exactly that as the connection's verdict. This is the stale overclaim the five
independently falsifiable fields exist to prevent, reintroduced one layer up.

**The rate-limit map could be grown by ids that do not exist.** The token was
taken before the row was read, so a press against any UUID minted a bucket that
nothing ever evicts.

**The AC-10 rollup asserted half of what it computed.** `failures` and
`output_tokens` were selected and never checked — including the failure-rate
half, which AC-10 names first.

## Specification

AC-1  Replacing a connection's key clears its stored test result; so does
      changing `base_url` or `model_id`. Renaming it or toggling `enabled`
      does not (NFR-502).
AC-2  A test against a connection id that does not exist returns 404 and
      creates no rate-limit state.
AC-3  A keyless connection (no key at all, the M7.3 local-inference row) can be
      tested, and an empty key redacts nothing: the provider's message survives
      intact.
AC-4  The per-connection rollup query asserts every column it selects,
      `failures` and `output_tokens` included.
AC-5  `pnpm test` green against live Postgres, `pnpm db:check` clean,
      typecheck / lint / format green.

## Decisions

- **Clearing beats recording.** The alternative to dropping a stale result is
  storing which configuration each result tested, which buys staleness
  *detection* where clearing buys staleness *prevention*. The UI renders what is
  stored; the cheapest way to keep it honest is for nothing dishonest to be
  stored.

- **Invalidation follows the diff, not the request.** M7.8 made `update`
  compute what actually changed against the stored row, so a PATCH re-sending
  the current base URL changes nothing and invalidates nothing.

- **The two merged work items are not edited.** `docs/changes/M7.5.md` and
  `docs/changes/M7.8.md` record what those changes were when they were made.
  Amending them would also put three work items in one pull request, which the
  gate refuses — correctly, and that refusal is what produced this record.

- **Two findings are answered with words rather than code**, and both are
  recorded where a reader will meet them:
  - *M7.8's AC-9 (the span attribute) has no failing-if-broken test.* Asserting
    it needs an in-memory OpenTelemetry exporter, and this repository carries
    only `@opentelemetry/api` on purpose (spans cost nothing with no exporter
    registered). The attribute sits beside two asserted event payloads carrying
    the same value. The reviewer's own alternative — say plainly that it is
    untested — is what M7.8's traceability table should have said, and this
    entry is that correction.
  - *M7.8's delete is not atomic across tables.* The in-use check does not lock
    the campaign rows, so a concurrent provider selection can commit between the
    check and the delete. Now recorded in `M7.8.threat-model.md` with its
    bounded consequence: the next turn fails a typed `NO_PROVIDER`, no state
    moves, nothing is silently rewired.

## Plan

1. `update` clears `last_test_result` when `base_url` or `model_id` moved;
   `replaceKey` clears it inside its existing transaction. — AC-1
2. The rate-limit token is taken after the row read. — AC-2
3. Three e2e cases: invalidation, the keyless path, the missing id. — AC-1..AC-3
4. The rollup assertion covers every selected column. — AC-4
5. The delete race into M7.8's threat model. — (documentation)
6. Full suite, `db:check`, typecheck / lint / format. — AC-5

## Traceability

| AC | Where it is satisfied | Test |
|---|---|---|
| AC-1 | `ProviderConnectionsService.update` / `replaceKey` | `connection-test.e2e.test.ts` "drops the stored result when the configuration it attested changes" |
| AC-2 | `ConnectionTestService.test` reads the row before taking a token | "a test against an id that does not exist is a 404, not a rate-limit entry" |
| AC-3 | `redactSecrets` skips an empty secret | "tests a keyless endpoint — an empty key redacts nothing and hides nothing" |
| AC-4 | the AC-10 rollup assertion | `dm-connections.e2e.test.ts` "two campaigns on two connections never cross wires" |
| AC-5 | — | `pnpm test` (333), `db:check`, typecheck / lint / format |
