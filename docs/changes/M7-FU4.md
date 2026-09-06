---
schema_version: 1
id: M7-FU4
title: Restore the 429 pin M7-FU3 dropped, and tie the SDK message literals to their
  source
type: bug
profile: fast
state: implementing
source: 'github-actions review comments on #47 (verdict blocked, merged over)'
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

The review of #47 returned `blocked` three times on one finding, and #47 was
merged anyway a minute after the last of them. The finding is correct.

**M7-FU3 claimed to restore a deleted test file as the union of two versions,
and dropped a pin doing it.** M7-FU2's rewrite had a status table that included
`429 → provider_error`. M7-FU3 folded that table into prose tests and carried
over 401, 403, 404 and 500; 429 went with the table. So the change whose subject
was *deleted coverage* deleted coverage — the same failure, one level down.

Measured rather than eyeballed this time. The status codes each version pins:

| | codes |
|---|---|
| M7.5 original | 400, 401, 403, 404, 422, 500 |
| M7-FU2 rewrite | 400, 401, 403, 404, 429, 500 |
| M7-FU3 "union" | 400, 401, 403, 404, 422, 500, 503 |
| union, correctly | 400, 401, 403, 404, 422, **429**, 500, 503 |

Nothing else is missing: the transport codes, both connection-error signals, the
detail passthrough and the dotted/dot-free/sentence-boundary cases are all
present, and 503 is M7-FU3's own addition.

Twice now the mechanism was the same — restructuring a file while restoring it,
and checking the result by reading it rather than by comparing what it asserts.
Both times the diff looked complete because the *cases* were there; what went
missing was a row of a table folded into prose.

**Second finding, medium.** `CONNECTION_ERROR_MESSAGES` holds two string
literals the SDKs own, and no test tied either to its source. Every stock SDK
error also matches by class, so if either SDK reworded its message the set entry
would go dead silently and a class-less connection failure would fall through to
`provider_error` — with the suite green. The literals were verified by hand when
they were written, which is not a test.

## Specification

AC-1  `provider-error.test.ts` pins `429 → provider_error`, with its status
      preserved, and the pinned status set is the true union of all three prior
      versions of the file.
AC-2  The two literals in `CONNECTION_ERROR_MESSAGES` are asserted equal to the
      messages the real `APIConnectionError` and `APIConnectionTimeoutError`
      carry, and each is shown to classify `unreachable` through the message
      path with the class stripped.
AC-3  `pnpm test` green against live Postgres, typecheck / lint / format green.

## Decisions

- **D-1 — Nothing is restructured.** The two additions go in beside what is
  already there. Restructuring while restoring is precisely what lost the pin
  twice; a third pass that rearranges the file to be tidier is how a third one
  goes missing. The file is not as tidy as it could be — the status pins are
  spread across four tests rather than gathered in one table — and that is the
  cheaper problem.
- **D-2 — 429 gets its own test rather than a row.** It is the one status whose
  misclassification is plausible in two directions: a rate limit is neither a
  rejected credential nor a model verdict, and both are reachable mistakes for
  someone editing the status ladder. The test says so, and pins the status
  alongside the class.
- **D-3 — The review's low finding is obsolete, not dismissed.** It says D-1 of
  M7-FU3 claimed all three in-place corrections to `M7-FU2.md` carried a
  provenance marker while the SDK-count one did not. True of the commit it read
  (`ea9b963`), but the gate then refused the in-place edits entirely and they
  were withdrawn: `M7-FU2.md` is untouched on `main` and the corrections live in
  M7-FU3's own § Corrections section. There is nothing left to mark.
- **D-4 — AC-5's "unverified CI" note on #47 is informational and stays that
  way.** The reviewer cannot see the run; the run was green.

## Plan

One commit. Add the 429 test beside the 500 boundary; add the SDK-wording test
inside the existing connection-error describe. Verify both by breaking them:
route 429 into the `unauthenticated` branch, and drop the trailing period from
the timeout literal.

*Check:* `pnpm exec vitest run apps/api/src/providers/provider-error.test.ts`
with each break in turn, then the full suite.
