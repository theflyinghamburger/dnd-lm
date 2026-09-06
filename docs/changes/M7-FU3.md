---
schema_version: 1
id: M7-FU3
title: Restore the classifier test coverage M7-FU2 deleted, and correct three claims
  in its record
type: bug
profile: fast
state: reviewing
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
AC-4  Three claims in M7-FU2's record that do not match what shipped are
      corrected in this document, quoting what each originally said:
      AC-4's condition, the number of screens fixed, and the number of SDKs.
      `docs/changes/M7-FU2.md` itself is unmodified.
AC-5  `pnpm test` green against live Postgres, typecheck / lint / format green.

## Decisions

- **D-1 — The corrections live here, and `M7-FU2.md` is not touched.** The first
  attempt edited that document in place, on the reasoning that an acceptance
  criterion describing behaviour the code never had is a defect in the
  specification and should be fixed where a reader will look. The gate refused
  it: `find_item` counts every changed `.md` under `docs/changes` that is not a
  sibling-kind document, so editing a merged work item makes a change contain two
  of them, and the run failed with *more than one work item in this change*.
  The gate is right and the reasoning was wrong. "Corrections are new entries,
  never rewrites" is not a filing convention that a good enough reason can
  suspend — it is what makes a merged work item readable as the record of what
  was believed at the time it merged. `M7-FU2.md` keeps its wording; the
  corrections are in **§ Corrections to the M7-FU2 record** below, and anything
  reading M7-FU2 forward through the change log meets them.
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
cases; add the timeout message; record the three corrections to M7-FU2's claims
in this document.

*Check:* `pnpm exec vitest run apps/api/src/providers/provider-error.test.ts`,
each signal deleted in turn to confirm red, then the full suite.

## Corrections to the M7-FU2 record

`docs/changes/M7-FU2.md` is left exactly as it merged (see D-1). Three of its
statements do not match what the change shipped, and this section is the
correction of record for them.

**M7-FU2 AC-4 overstates its own condition.** It reads *"A test verdict is
stored only if the row has not been mutated since the test began."* The shipped
`WHERE` clause asserts the key nonce, `base_url` and `model_id` — the
configuration a verdict is a statement about — and nothing else. A label-only
PATCH landing mid-test therefore leaves the verdict stored, which is correct
behaviour and better than the AC describes: the label is not something the
verdict claims anything about. M7-FU2's own D-2 explains the implementation but
never reconciles the AC's wording with it. Read AC-4 as: *stored only if the key
nonce, `base_url` and `model_id` are unchanged since the test began.*

**M7-FU2's change brief says two screens where only one was broken.** It reads
*"two screens that render nothing when a read fails"*. The admin list already
rendered its error — that was fixed during #38's own review round, and it is
`AdminProviders.tsx:63` on `main` today. Only `CampaignSettings` rendered
nothing, and only it was fixed. This also explains something the brief leaves
looking odd: the source scan M7-FU2 added asserts *both* components reference
`connections.error`, and it passed on a diff that touched one of them, because
the other already complied.

**M7-FU2's change brief says three SDKs where there are two.** It reads
*"turns three SDKs' error types into the four classes"*. There are two provider
SDKs — `@anthropic-ai/sdk` and `openai` — plus undici, which is not an SDK and
whose failures are covered by `TRANSPORT_CODES` rather than by a class
signature. The reviewer flagged this as a possible gap in
`CONNECTION_ERROR_NAMES`; it is not. Both SDKs name their connection classes
identically (`APIConnectionError`, `APIConnectionTimeoutError`), both leave
`name` unset on the instance so `constructor.name` is the only class signature
available, and AC-2's cases now pin all four against the real classes.
