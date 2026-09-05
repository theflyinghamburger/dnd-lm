---
schema_version: 1
id: sdlc-install
title: Install the SDLC gate (agent change workflow + independent CI review)
type: feature
profile: high-assurance
state: reviewing
source: direct request, 2026-09-05
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

Agent-written changes currently land with no structural check that the agent
understood the request or that anything independent reviewed the result. The
existing `check` job proves the build is green, which is a statement about the
build, not about whether the code is what was asked for.

This installs a two-part control: an agent procedure that turns a request into a
written specification before code exists (`sdlc-change`), and a separate CI job
that reviews the diff against that specification with no ability to edit it
(`sdlc-review`). `tools/sdlcctl.py` is the gate that refuses the merge until both
have produced evidence at the reviewed commit.

The reviewer's independence is structural, not promised: it runs in a job with
`contents: read`, so it cannot push to the branch it is reviewing.

## Specification

AC-1  `python3 tools/sdlcctl.py check-repo` exits 0 against this repository,
      with branch protection readable (no warning).
AC-2  A profile floor of `high-assurance` is computed for changes touching
      `apps/api/src/{auth,session,admin,db}/**`, `apps/api/drizzle/**`,
      `packages/contracts/src/**`, `.github/workflows/**`, `.sdlc/policy.yaml`;
      `fast` for `apps/web/**` and `**/*.md`.
AC-3  `sdlcreview.py` writes a `review.json` whose `sha` equals `git rev-parse
      HEAD`, regardless of what the model returns.
AC-4  `sdlcreview.py` sets `verdict: blocked` whenever any finding has
      `severity: blocking`, overriding a model that claims otherwise.
AC-5  `sdlcreview.py` exits non-zero on transport failure, an unparseable reply,
      or an empty diff — a review that did not happen never looks like a review
      that found nothing.
AC-6  `.claude/skills/**` is committed; `.claude/settings.local.json` is not.
AC-7  The existing `check` job is unchanged: build, typecheck, lint, format,
      migrate, test, and Drizzle drift all still run on every push.

## Decisions

- **The sdlc jobs are appended to `ci.yml`, not a separate `sdlc.yml`.** The
  suite ships a standalone workflow. Two reasons to deviate: `check` already
  performs every verification a `verify` job would, backed by a Postgres service
  block that would have to be maintained twice; and jobs in one workflow run see
  one commit, so `needs:` is the evidence contract. A review in a second workflow
  could be about a different commit. Recorded rather than assumed.
- **`scan` omits secret scanning.** It is a repository setting (push protection,
  now enabled), not a job. Reimplementing it in CI would be weaker and slower.
- **The reviewer is provider-agnostic.** `tools/sdlcreview.py` speaks OpenAI-style
  `POST {base}/chat/completions` over stdlib only, rather than depending on a
  specific vendor CLI. Currently `z-ai/glm-5.3-flash` via OpenRouter.
- **`enforce_admins: false`.** There is one maintainer and nobody can approve
  their own pull request; without the bypass nothing would ever merge. The
  consequence is stated in SDLC.md rather than hidden.
- **CODEOWNERS names a single user, not a team.** Placeholder until there is a
  second maintainer; marked TODO in the file.

## Plan

1. Copy `sdlcctl.py`, `sdlcreview.py`, and both skills into the repo. → AC-6
2. Write `.sdlc/policy.yaml` with paths verified against the real tree. → AC-2
3. Append `scan`, `review`, `sdlc` jobs to `ci.yml`, leaving `check` untouched. → AC-7
4. Write CODEOWNERS covering the control files. → AC-1
5. Enable branch protection and secret scanning. → AC-1
6. Document usage and the residual risks in SDLC.md; link from AGENTS.md.

## Traceability

| AC | Verified by |
|---|---|
| AC-1 | `python3 tools/sdlcctl.py check-repo` — passes, no warning |
| AC-2 | `sdlcctl.profile_floor` exercised over all seven path classes |
| AC-3 | `sdlcreview.py` sets `review["sha"]` from `Forge.head_sha()`; end-to-end run against a stub server confirmed |
| AC-4 | Stub server returned `verdict: pass` alongside a blocking finding; output was `blocked` |
| AC-5 | `tests/test_sdlcreview.py::test_extract_json_refuses_junk`; empty-stdin path raises `SystemExit` |
| AC-6 | `.gitignore` `.claude/*` + `!.claude/skills/`; `git status --untracked-files=all` lists only the two SKILL.md files |
| AC-7 | `ci.yml` diff touches no step inside `check`; the three new jobs are `if: github.event_name == 'pull_request'` |
