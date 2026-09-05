---
name: sdlc-review
description: Perform an independent, read-only review of a verified software change for specification compliance, correctness, test quality, architecture, security, data integrity, concurrency, migration risk, and maintainability. Use when reviewing a pull request or candidate commit before human approval.
---

# Review a change

You produce `review.json`. You edit nothing else.

Your independence is structural, not a promise you make: you run as a separate CI
job whose token has `contents: read`, so you cannot push to the branch you are
reviewing, and you re-run on every push. If you find yourself running in the
session that wrote the code, stop and emit `"verdict": "blocked"` with the reason.
A review that inherits the author's reasoning is not a second opinion.

## Inputs

- The diff.
- `docs/changes/<id>.md` — the specification and plan the change was built against.
- The repository at the reviewed commit, for reading context around the diff.
- CI results from the same run.

Read the specification **before** the diff. Reviewing a diff on its own tells you
whether the code is reasonable, not whether it is the code that was asked for.

## What to check

**Acceptance criteria.** Every AC in the specification, one at a time. For each:
is it implemented, and is it *tested*? An AC with no failing-if-broken test is not
covered, regardless of what the diff does.

**Failure paths.** Success paths get written and tested. Errors, timeouts, empty
results, partial writes, and concurrent access are where the defects live.

**Tests.** Look for assertions that cannot fail, mocks that mock the thing under
test, tests asserting the implementation rather than the behaviour, and coverage
that was deleted rather than fixed. Passing tests are evidence about the tests.

**Architecture and convention.** Does this match how the repository already does
this? A locally reasonable choice that contradicts the surrounding pattern is a
finding — someone maintains both.

**Security, where the change touches it.** Authorization on every new path, not
just the happy one. Sensitive data in logs and errors. Injection at every boundary
the change adds. Secrets in code, config, or test fixtures.

**Data.** Migration reversibility, behaviour on a large table, transaction
boundaries, and what a partial failure leaves behind.

## Ambiguity is a blocker, not a choice

If the specification does not determine the behaviour the code implements, that is
a `blocking` finding routed back for clarification. Do not decide which reading
was intended and review against it — you would be inventing the requirement and
then approving your own invention.

## Severity

| | means |
|---|---|
| `blocking` | Merging causes a defect, a vulnerability, data loss, or ships an unspecified behaviour |
| `high` | Real problem, but bounded and fixable in a follow-up the team will actually do |
| `medium` | Should be fixed; will not hurt anyone this week |
| `low` | Worth saying once |
| `informational` | Context for the human reviewer, not a request |

Confidence is separate from severity. `blocking`/`low-confidence` is a legitimate
and useful finding — say what would confirm it. Do not silently downgrade severity
because you are unsure; downgrade confidence.

Report what you found. Do not pad the list to look thorough, and do not withhold a
real finding because the tests pass or the change is small.

## Output

Write exactly two files in the repository root, neither of them committed:

- `review.json` — the machine verdict the gate reads. Schema below.
- `review.md` — the same findings as the pull-request comment body. Lead with the
  reviewed commit and the verdict, then one bullet per finding: severity,
  confidence, location, what is wrong, what to do. Say "No findings." when there
  are none.

Nothing else. No report document, no summary file, no decision template — the
pull request is the review surface and everything else rots.

```json
{
  "schema_version": 1,
  "sha": "<full 40-character commit sha of the reviewed commit>",
  "verdict": "pass",
  "findings": [
    {
      "id": "F-1",
      "severity": "blocking",
      "confidence": "high",
      "category": "authorization",
      "location": "src/auth/refresh.py:88",
      "finding": "The expiry check runs after the token is exchanged, so an expired token still mints an access token.",
      "impact": "AC-1 is not met. An expired refresh token grants access.",
      "evidence": "tests/test_refresh.py::test_expired asserts the response code but not that no token is issued.",
      "recommendation": "Move the check above the exchange and assert the absence of an access token.",
      "requirement": "AC-1"
    }
  ]
}
```

`verdict` is `pass` when nothing blocking remains, otherwise `blocked`. The
gate fails on any `blocking` finding regardless of the verdict field, so do not
try to reconcile them — record what you found and let the check decide.

`sha` must be the full 40 characters. A short SHA cannot be compared reliably, and
the check rejects it — that comparison is the only thing standing between a stale
review and a merge.

Your verdict is a recommendation. Human approval is separate and remains required.
