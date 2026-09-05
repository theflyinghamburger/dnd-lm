---
name: sdlc-change
description: Run a software feature, bug fix, refactor, or incident remediation from intake through clarified intent, specification, planning, implementation, testing, and CI verification. Use when asked to implement or continue a software change under an evidence-gated workflow. Stop before independent review.
---

# Run a change

You take a request to a verified candidate pull request. You do not review it and
you do not merge it.

State lives in `docs/changes/<id>.md`. Read it first — it is how you resume after
an interruption. Chat history is not state.

```bash
python3 tools/sdlcctl.py status <id>     # where you are, plus facts from git/gh
python3 tools/sdlcctl.py check --json    # what still fails. Advisory locally
```

`check` locally is a preview. The gate is the same command run in CI, where you
cannot edit the result. Never tell the user a local pass means anything more.

## Stages

`intake → specified → implementing → verifying → reviewing`

Move with `sdlcctl transition <id> <state>`. It rejects anything illegal, which
is how you find out you skipped a step.

---

## 1. Intake

Inspect before you ask anything. In this order:

1. The request and the visible conversation.
2. The issue or ticket, if one is referenced and reachable.
3. `AGENTS.md`, `CLAUDE.md`, and the docs they point to.
4. The source tree, for the named component or behaviour.
5. Existing tests, contracts, schemas, and recent related changes.
6. Logs or reproduction evidence, if the request is a bug or incident.

Never ask for a path, a convention, or a behaviour that step 3–5 would have told
you. Asking a question the repository already answers is the most common way this
workflow wastes a person's time.

Then create the work item:

```bash
python3 tools/sdlcctl.py new <id> --profile standard
```

Use the tracker's ID when there is one. Otherwise a short slug.

## 2. Assess intent

Score each field in the frontmatter as `clear`, `assumable`, `needs-clarification`,
or `conflicting`. No confidence numbers — a percentage is a way of avoiding the
judgement, not making it.

| Field | The question it answers |
|---|---|
| `objective` | What outcome does the user want? |
| `subject` | Which component or behaviour changes? |
| `current_behavior` | What happens today? |
| `expected_behavior` | What should happen instead? |
| `scope` | What is explicitly not in this change? |
| `constraints` | Compatibility, performance, deadline, dependency limits |
| `verification` | How will we know it worked? |

`assumable` means you inferred a default and recorded it under `## Decisions`.
You may only do that when the choice is **all** of: low-risk, reversible,
consistent with an existing repository convention, not externally visible, not
security-sensitive, not destructive, and covered by an automated check.

Everything else is `needs-clarification`, and CI will hold the change until it
is resolved.

## 3. Ask, when it matters

Ask when an unresolved choice could materially change any of:

user-visible behaviour · business rules · public APIs or event contracts · data
representation, retention, deletion, or migration · authentication, authorization,
privacy, or secrets · architectural boundaries or dependency choice · backward
compatibility · destructive or irreversible operations · production rollout ·
acceptance criteria · significant performance or cost trade-offs · scope beyond
the request

Rules: at most three questions at a time, most blocking first, one decision each,
each carrying the evidence you already found, each offering two or three concrete
options with a recommendation where the evidence supports one. Say which stage is
blocked. Never ask "can you provide more details".

```markdown
### Decision needed: expired-token error response

The endpoint currently returns `TOKEN_INVALID` for both malformed and expired
refresh tokens (`src/auth/token.py:88`). The ticket does not say whether the
public contract should change.

1. Preserve `TOKEN_INVALID` — maintains compatibility.
2. Return `TOKEN_EXPIRED` — clearer for clients, but breaks the contract.

I recommend 1 unless existing clients already handle the new code. This blocks
the specification.
```

If the user delegates the judgement back to you, take the most conservative
compatible option and record it. Still ask before anything destructive,
security-sensitive, or production-facing — delegation is not consent for those.

Record every answer under `## Decisions` and in `clarifications:`:

```yaml
clarifications:
  - id: CL-001
    category: compatibility
    blocking: true
    status: resolved
    question: Should expired tokens use a new public error code?
    decision: Preserve the existing TOKEN_INVALID code.
    source: jira:AUTH-142#comment-18
    affects: [specification, contract-tests]
```

## 4. Profile

You do not pick the floor; the changed paths do, via `.sdlc/policy.yaml`. You may
raise the profile and you must raise it when inspection reveals more risk than the
paths suggest. You cannot lower it — that needs a human to apply the
`sdlc-profile-downgrade` label. Do not apply that label yourself, even if your
token permits it.

| | requires |
|---|---|
| `fast` | PR description, focused tests, one human review. No work-item file needed for a docs-only change |
| `standard` | `## Change brief`, `## Specification`, `## Plan`, tests, CI, independent review |
| `high-assurance` | the above plus `## Traceability` and `<id>.threat-model.md`; migration and rollback plans when the paths demand them |

## 5. Specify

`## Specification` holds numbered acceptance criteria that a test can fail.

```markdown
AC-1  An expired refresh token returns 401 with body `{"error":"TOKEN_INVALID"}`.
AC-2  A valid refresh token within its window still returns a new access token.
AC-3  Expiry is evaluated against the token's `exp` claim, not server receipt time.
```

"Handles expiry correctly" is not an acceptance criterion. If you cannot write the
test from the line, it is not specific enough yet.

Then `sdlcctl transition <id> specified`.

## 6. Plan

`## Plan` is the sequence of bounded tasks, each ending at a runnable check. Read
only — no edits during planning. Keep it short; a plan longer than the change is
a sign you have not understood the change.

Note which acceptance criterion each task serves. That mapping becomes
`## Traceability` under high-assurance.

## 7. Implement

`sdlcctl transition <id> implementing`, then:

- Confirm a clean baseline first. Existing failures are not yours to inherit
  silently — say so before you start.
- Work on a branch or worktree. Never on the default branch.
- For a bug: write the failing test or a reliable reproduction **before** the fix.
  A fix without a red-first test is a guess with good posture.
- Smallest coherent change. Reuse what is already in the repository before adding
  anything, and match the surrounding code's idiom.
- Run the focused check after each bounded task, the broader suite before handoff.
- If reality contradicts the plan, record the deviation under `## Decisions` and
  keep going. If it contradicts the *specification*, stop and go back to step 3.

Never implement through unresolved material ambiguity. `sdlcctl check` will catch
it, but by then you have written code against a guess.

## 8. Verify and hand off

`sdlcctl transition <id> verifying`, run the full required checks, then open the
PR. Description carries: the objective, the acceptance criteria and how each is
covered, what you deliberately did not do, and anything you assumed.

`sdlcctl transition <id> reviewing` and stop.

Do not review your own change. Do not approve it. Do not merge it. The review is
a separate CI job with a token that cannot write code — that separation is the
whole point, and pre-empting it in this session defeats it.

## When you are stuck

`sdlcctl transition <id> blocked` records where you were, and unblocking returns
you there. Say plainly what you need and from whom. A blocked change with a clear
question beats a finished change built on a wrong assumption.
