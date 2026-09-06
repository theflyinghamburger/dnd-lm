---
schema_version: 1
id: M7-FU3
title: Restore the classifier test coverage M7-FU2 deleted, and correct three claims
  in its record
type: bug
profile: fast
state: implementing
source: 'github-actions review comments on #46'
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

The independent review passed #46 twice and both passes raised the same finding,
which is correct and is the serious one: **M7-FU2 deleted existing test
coverage.** `apps/api/src/providers/provider-error.test.ts` has existed since
M7.5 (`1e617e3`). M7-FU2 wrote its new cases with `cat >` on the assumption the
path was new, silently replacing the file and taking four regression pins with
it:

- `ENOTFOUND` — only `ECONNREFUSED` survived, so DNS failure had no test.
- `unknown model: llama-99` at 422 — the only cover for `MODEL_MISSING`'s second
  and third alternations, which were left with none.
- A 500 whose body says `model not found in shard` staying `provider_error`,
  with its status preserved — the `status < 500` precedence boundary. The
  replacement's 500 case used the body `nope`, which could never match the
  regex, so the boundary was untested rather than merely under-tested.
- Detail passthrough on a status-carrying error.

Every one of those could have regressed green. That the file was rewritten in a
change whose entire subject was tests that cannot fail is the sharper half of
the finding.

Three smaller findings are corrections to the record rather than to the code:
AC-4's wording claims more than the code does, the change brief says "two
screens" render nothing on a failed read when only one did, and it says "three
SDKs" where there are two plus undici.

## Specification

AC-1  The four dropped cases are back, and `provider-error.test.ts` covers
      everything both the M7.5 original and the M7-FU2 rewrite covered.
AC-2  The SDK connection signature is pinned against the real
      `APIConnectionError` and `APIConnectionTimeoutError` from both
      `@anthropic-ai/sdk` and `openai`, not a hand-written stand-in.
AC-3  The class-name check and the message check are each pinned by a case the
      other cannot satisfy.
AC-4  `docs/changes/M7-FU2.md` states what shipped: AC-4's condition, the number
      of screens fixed, and the number of SDKs.
AC-5  `pnpm test` green against live Postgres, typecheck / lint / format green.

## Decisions

- **D-1 — The corrections are made in `M7-FU2.md` in place, marked and dated.**
  The repository's rule is that corrections are new entries rather than
  rewrites, and this document is that new entry. But an acceptance criterion
  that describes behaviour the code never had is a defect *in the specification*,
  and leaving it to be read as the truth about a merged change serves nobody.
  The three edits are inline and each says it was made post-merge by M7-FU3, so
  the trail stays legible from either document.
- **D-2 — `CONNECTION_ERROR_MESSAGES` gains `'Request timed out.'`.** Verified
  against both SDKs: `APIConnectionTimeoutError` carries it, and the message
  fallback previously knew only `'Connection error.'`, so a timeout that lost
  its class fell through to `provider_error`. It is a set membership test on a
  status-less throw, so a provider body reading "Request timed out." cannot
  reach it — those carry a status.
- **D-3 — Both signals are kept, and tested apart.** Dropping the class-name set
  left the suite green, because every stock SDK error also matches by message —
  the redundancy was hiding a check no test could fail, which is the defect
  M7-FU2 existed to remove. Rather than delete one, each is now pinned by a case
  the other cannot satisfy: an SDK class carrying a non-stock message, and a
  stock message on a plain `Error`. Verified by deleting each set in turn and
  observing red (1 and 3 failures respectively).
- **D-4 — The review's remaining finding is accepted as-is.** The widened
  `MODEL_MISSING` gap admits a dotted token followed by a clause rather than a
  sentence, so `The model \`gpt-4.1\` is great but the request was invalid`
  classifies `model_not_found`. The reviewer marked it informational and "none
  required". It is a false positive on a contrived body, in the direction that
  costs an operator a wrong hint rather than a wrong verdict on reachability,
  and tightening it means bounding the post-dot run — a regex change with its
  own false-negative risk, unwarranted without a real body that trips it.

## Plan

One commit. Restore the file as the union of both versions, using the M7.5
original's `apiError`/`fetchFailure` helpers throughout rather than the
rewrite's inline `Object.assign`; add the real-SDK cases and the two separating
cases; add the timeout message; correct the three claims in `M7-FU2.md`.

*Check:* `pnpm exec vitest run apps/api/src/providers/provider-error.test.ts`,
each signal deleted in turn to confirm red, then the full suite.
