# SDLC gate

An agent runs a change with the `sdlc-change` skill; a *different* agent reviews
it in CI with a read-only token (`sdlc-review`); the `sdlc` job refuses to pass
until the evidence for both exists at the reviewed commit.

Read `.claude/skills/sdlc-change/SKILL.md` before using it. This file is only the
repo-specific part.

## Usage

> Use the sdlc-change skill. Implement M3.2.

By hand:

```sh
python3 tools/sdlcctl.py new M3.2 --profile standard   # docs/changes/M3.2.md
python3 tools/sdlcctl.py status M3.2
python3 tools/sdlcctl.py transition M3.2 specified
python3 tools/sdlcctl.py check                         # advisory preview of CI
```

Acceptance criteria in `## Specification` cite the requirement IDs this repo
already uses (`FR-206`, `NFR-202`) — see AGENTS.md. `AC-1` numbering is the
work item's own; the `FR-`/`NFR-` it satisfies goes on the same line.

## Profile floors — `.sdlc/policy.yaml`

`high-assurance` (adds `## Traceability` + `<id>.threat-model.md`):
`apps/api/src/{auth,session,admin,db}/**`, `apps/api/drizzle/**`,
`packages/contracts/src/**`, `.github/workflows/**`, `.sdlc/policy.yaml`.

A migration under `apps/api/drizzle/**` also requires `<id>.migration-plan.md`
and `<id>.rollback-plan.md`.

Agents may raise the floor and must when inspection finds more risk. Lowering it
needs a human to apply the `sdlc-profile-downgrade` label on the PR.

## CI

The jobs are appended to `.github/workflows/ci.yml`, not a separate workflow:
every job in one run sees the same commit, so `needs:` is the evidence contract.

`check` (the existing build) + `scan` → `review` → `sdlc`. All but `check` are
pull-request only. `review` posts `review.md` as a PR comment and uploads
`review.json`; `sdlc` fails on any blocking finding, or if the review's `sha` is
not HEAD.

`review` pipes the diff into `tools/sdlcreview.py`, which carries
`.claude/skills/sdlc-review/SKILL.md` and the work item to a model. It is stdlib
only and speaks plain OpenAI-style `POST {base}/chat/completions`, so any host
works — OpenAI, OpenRouter, Together, a local vLLM. Three settings:

Currently set to `z-ai/glm-5.3-flash` via OpenRouter — $0.075/$0.25 per MTok,
about $0.002 per review. Changing reviewer is one command, no code change:

```sh
gh variable set REVIEW_MODEL --body '<other/model>'
```

Only `REVIEW_API_KEY` is a secret; the base URL and model are repository
variables so they stay readable in CI logs.

Without them the `review` job fails and `sdlc` never runs — a review that did not
happen must never look like a review that found nothing.

Two things the script does not delegate to the model: `sha` is filled in from
git, and `verdict` is forced to `blocked` whenever a blocking finding is present.
The procedure says the gate decides that, not the reviewer.

## Enforcement

On `main`, all four checks are required, plus a code-owner approval that is
dismissed when the branch moves — the same expiry `sdlcctl check` applies to the
agent review. Force pushes and deletions are off. Secret scanning and push
protection are on at the repository level.

`enforce_admins` is **false**, so as repository admin you can merge past a red
check. That is deliberate — there is one maintainer, and nobody can approve their
own pull request, so without the bypass nothing would ever merge. The consequence
is that every control here is an audit trail for you and a hard gate for an agent
holding a non-admin token. Do not describe it as stronger than that.

## What is still not enforced

- An agent running locally with your credentials can edit any file here and skip
  any local command. Only the CI checks and branch protection bind.
- The `review` job's `contents: read` grant is declared in a file inside the
  repository under review. Widening it is a visible diff gated by CODEOWNERS —
  human-reviewed, not machine-prevented.
- An agent can apply the `sdlc-profile-downgrade` label with your token. That is a
  visible audit trail, not a lock.
