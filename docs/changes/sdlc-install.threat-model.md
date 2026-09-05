# Threat model: the SDLC gate

The gate's purpose is to constrain an agent that holds write credentials. It is
worth being precise about what it does and does not stop.

## What the controls bind

| Actor | Bound by |
|---|---|
| An agent with a repository-scoped token | Required status checks. It cannot merge past a red `sdlc` job. |
| The review job itself | `contents: read`. It cannot push to the branch it reviews, so it cannot fix what it reports. |
| A stale review | `sdlcctl check` compares `review.json`'s `sha` to HEAD. Any new commit invalidates the prior verdict. |
| A silently lowered profile | The floor comes from changed paths. Going below it requires the `sdlc-profile-downgrade` label, applied by a named account, visible in the PR timeline. |

## What they do not bind

**An agent running locally with the maintainer's credentials.** It can edit any
file in this repository, including `policy.yaml` and the workflow, and skip any
local command. Only CI and branch protection bind, and both are enforced after
the code is written, not while it is being written. Local `sdlcctl check` prints
an advisory line saying exactly this.

**The maintainer.** `enforce_admins` is false, so an admin can merge past a red
check. This is deliberate — one maintainer, no self-approval — and it means every
control here is an audit trail for the maintainer and a hard gate for an agent.

**Widening the review job's permissions.** The `contents: read` grant is declared
in `.github/workflows/ci.yml`, a file inside the repository under review. An
agent can propose widening it. That is a visible diff on a CODEOWNERS-guarded
path, human-reviewed rather than machine-prevented.

**The reviewer's judgement.** `verdict` is advisory and the model is
`z-ai/glm-5.3-flash`, chosen for cost. A review that under-reports produces a
green light, not a worse report — the gate cannot distinguish "found nothing"
from "did not look hard enough". Mitigations: the reviewer's severity rules are
in the skill, the verdict is forced to `blocked` on any blocking finding, and
human approval remains required regardless of verdict. Swapping models is one
`gh variable set`, so this is tunable if the reviews prove thin.

## Data exposure

The review job sends the diff and the work item to OpenRouter and whichever
upstream serves the request. This repository is public, so the diff is not
confidential; `REVIEW_API_KEY` is a repository secret and is not exposed to pull
requests from forks. That last point means fork PRs fail the review job and
cannot merge — fail-closed, and intentional.

## Fork pull requests

GitHub withholds secrets from `pull_request` runs originating in a fork. The
`review` job therefore fails for outside contributions and `sdlc` never runs,
blocking the merge. Resolving this with `pull_request_target` would run fork code
with repository secrets in scope and is rejected. If outside contributions become
real, the correct fix is a GitHub Environment with required reviewers holding the
secret.
