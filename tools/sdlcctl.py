#!/usr/bin/env python3
"""sdlcctl - lifecycle gate for AI-driven changes.

Authoritative only as a required CI status check. A local run is ADVISORY: it
previews the same result, but nothing here can bind an agent that holds write
credentials on this machine. See the plan, section 2.

Facts that live in git or GitHub are queried, never stored. The work-item file
holds intent, decisions, clarifications, profile, and state - nothing else.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

SCHEMA_VERSION = 1

# Ordered weakest -> strongest. Comparison is by index.
PROFILES = ["fast", "standard", "high-assurance"]

STATES = ["intake", "specified", "implementing", "verifying", "reviewing", "done", "blocked"]
MERGEABLE_STATE = "reviewing"

TRANSITIONS = {
    "intake": {"specified", "blocked"},
    "specified": {"implementing", "intake", "blocked"},
    "implementing": {"verifying", "specified", "blocked"},
    "verifying": {"reviewing", "implementing", "specified", "blocked"},
    "reviewing": {"done", "implementing", "specified", "blocked"},
    "done": set(),
    "blocked": set(),  # unblocking returns to blocked_from; see do_transition
}

INTENT_FIELDS = [
    "objective", "subject", "current_behavior", "expected_behavior",
    "scope", "constraints", "verification",
]
INTENT_OK = {"clear", "assumable"}
INTENT_STATUSES = INTENT_OK | {"needs-clarification", "conflicting"}

SECTIONS_BY_PROFILE = {
    "fast": [],
    "standard": ["Change brief", "Specification", "Plan"],
    "high-assurance": ["Change brief", "Specification", "Plan", "Traceability"],
}

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DOWNGRADE_LABEL = "sdlc-profile-downgrade"

ITEM_TEMPLATE = """---
schema_version: 1
id: {id}
title: TODO
type: feature
profile: {profile}
state: intake
source: TODO
intent:
  objective: needs-clarification
  subject: needs-clarification
  current_behavior: needs-clarification
  expected_behavior: needs-clarification
  scope: needs-clarification
  constraints: needs-clarification
  verification: needs-clarification
clarifications: []
---

## Change brief

## Specification

## Decisions

## Plan
"""


# --------------------------------------------------------------------------
# forge seam: the only place that shells out. Tests substitute a fake.
# --------------------------------------------------------------------------

def _run(args, cwd=None):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout.strip()


class Forge:
    """git + gh. Every method may raise RuntimeError; callers fail closed."""

    def __init__(self, root: Path):
        self.root = root
        self._pr = ...  # sentinel: not yet queried

    def head_sha(self) -> str:
        return _run(["git", "rev-parse", "HEAD"], self.root)

    def default_branch(self) -> str:
        try:
            ref = _run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], self.root)
            return ref.rsplit("/", 1)[-1]
        except RuntimeError:
            return "main"

    def pr(self) -> dict | None:
        if self._pr is ...:
            try:
                fields = "number,headRefOid,files,labels,reviewDecision,body,state"
                self._pr = json.loads(_run(["gh", "pr", "view", "--json", fields], self.root))
            except (RuntimeError, json.JSONDecodeError):
                self._pr = None
        return self._pr

    def changed_files(self) -> list[str]:
        pr = self.pr()
        if pr:
            return [f["path"] for f in pr.get("files", [])]
        base = self.default_branch()
        return [f for f in _run(
            ["git", "diff", "--name-only", f"origin/{base}...HEAD"], self.root
        ).splitlines() if f]

    def label_actors(self, label: str) -> list[str]:
        """Logins that applied `label`, newest last. Empty if unknown."""
        pr = self.pr()
        if not pr:
            return []
        try:
            repo = json.loads(_run(["gh", "repo", "view", "--json", "nameWithOwner"], self.root))
            out = _run([
                "gh", "api", "--paginate",
                f"repos/{repo['nameWithOwner']}/issues/{pr['number']}/timeline",
                "--jq", '.[] | select(.event=="labeled") | [.label.name, .actor.login] | @tsv',
            ], self.root)
        except (RuntimeError, json.JSONDecodeError, KeyError):
            return []
        return [ln.split("\t")[1] for ln in out.splitlines()
                if ln.split("\t")[0] == label and "\t" in ln]

    def branch_protection(self) -> dict | None:
        try:
            repo = json.loads(_run(["gh", "repo", "view", "--json", "nameWithOwner"], self.root))
            return json.loads(_run([
                "gh", "api",
                f"repos/{repo['nameWithOwner']}/branches/{self.default_branch()}/protection",
            ], self.root))
        except (RuntimeError, json.JSONDecodeError, KeyError):
            return None


# --------------------------------------------------------------------------
# work-item file
# --------------------------------------------------------------------------

def split_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        raise ValueError("file does not start with YAML frontmatter")
    end = text.find("\n---", 3)
    if end == -1:
        raise ValueError("unterminated YAML frontmatter")
    meta = yaml.safe_load(text[4:end + 1]) or {}
    if not isinstance(meta, dict):
        raise ValueError("frontmatter is not a mapping")
    return meta, text[end + 4:]


def sections(body: str) -> dict[str, str]:
    out, name, buf = {}, None, []
    for line in body.splitlines():
        if line.startswith("## "):
            if name is not None:
                out[name] = "\n".join(buf).strip()
            name, buf = line[3:].strip(), []
        elif name is not None:
            buf.append(line)
    if name is not None:
        out[name] = "\n".join(buf).strip()
    return out


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def render(meta: dict, body: str) -> str:
    return "---\n" + yaml.safe_dump(meta, sort_keys=False).rstrip() + "\n---" + body


def validate_id(wid: str) -> str:
    if not ID_RE.match(wid) or ".." in wid:
        raise SystemExit(f"invalid work-item id: {wid!r}")
    return wid


def item_path(root: Path, policy: dict, wid: str) -> Path:
    return root / policy.get("work_items", "docs/changes") / f"{validate_id(wid)}.md"


def load_policy(root: Path) -> dict:
    p = root / ".sdlc" / "policy.yaml"
    if not p.exists():
        raise SystemExit("fail: .sdlc/policy.yaml is missing; the repository is not configured")
    return yaml.safe_load(p.read_text(encoding="utf-8")) or {}


# --------------------------------------------------------------------------
# path globs: ** spans separators, * does not
# --------------------------------------------------------------------------

def glob_match(pattern: str, path: str) -> bool:
    rx, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            rx += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            rx += ".*"
            i += 2
        elif pattern[i] == "*":
            rx += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            rx += "[^/]"
            i += 1
        else:
            rx += re.escape(pattern[i])
            i += 1
    return re.fullmatch(rx, path) is not None


def profile_floor(changed: list[str], policy: dict) -> tuple[str, str | None]:
    """Strongest profile any changed path demands. Returns (profile, triggering path)."""
    floor, why = "fast", None
    rules = policy.get("profiles", {})
    for name in PROFILES:
        for pattern in rules.get(name, []) or []:
            for path in changed:
                if glob_match(pattern, path) and PROFILES.index(name) > PROFILES.index(floor):
                    floor, why = name, f"{path} matches {pattern}"
    return floor, why


def required_docs(changed: list[str], policy: dict) -> list[str]:
    out = []
    for doc, patterns in (policy.get("requires") or {}).items():
        if any(glob_match(p, f) for p in patterns or [] for f in changed):
            out.append(doc)
    return out


# --------------------------------------------------------------------------
# check
# --------------------------------------------------------------------------

def find_item(root: Path, policy: dict, changed: list[str]) -> list[str]:
    base = policy.get("work_items", "docs/changes")
    return [f for f in changed
            if f.startswith(base + "/") and f.endswith(".md")
            and Path(f).name.count(".") == 1]


def do_check(root: Path, forge: Forge, review_file: Path | None) -> list[str]:
    """Returns a list of failure messages. Empty means the gate passes."""
    fails: list[str] = []
    policy = load_policy(root)

    try:
        changed = forge.changed_files()
        head = forge.head_sha()
    except RuntimeError as e:
        return [f"cannot determine the change under review: {e}"]

    floor, why = profile_floor(changed, policy)
    found = find_item(root, policy, changed)

    if len(found) > 1:
        return [f"more than one work item in this change: {', '.join(found)}"]

    if not found:
        # A fast-profile change may live entirely in the PR description.
        if floor != "fast":
            return [f"no work-item file, but {floor} profile is required ({why})"]
        body = (forge.pr() or {}).get("body") or ""
        if len(body.strip()) < 30:
            return ["no work-item file and no substantive PR description"]
        return []

    path = root / found[0]
    if not path.exists():
        return [f"work item {found[0]} is in the diff but absent from the tree"]

    try:
        meta, body = split_frontmatter(path.read_text(encoding="utf-8"))
    except ValueError as e:
        return [f"{found[0]}: {e}"]

    if meta.get("schema_version") != SCHEMA_VERSION:
        return [f"{found[0]}: unsupported schema_version {meta.get('schema_version')!r}"]

    wid = str(meta.get("id", ""))
    if not ID_RE.match(wid) or ".." in wid:
        fails.append(f"invalid work-item id {wid!r}")
    elif path.stem != wid:
        fails.append(f"id {wid!r} does not match filename {path.name}")

    # --- state ---
    state = meta.get("state")
    if state not in STATES:
        fails.append(f"unknown state {state!r}")
    elif state != MERGEABLE_STATE:
        fails.append(f"state is {state!r}; must be {MERGEABLE_STATE!r} to merge")

    # --- profile floor ---
    profile = meta.get("profile")
    if profile not in PROFILES:
        return fails + [f"unknown profile {profile!r}"]
    if PROFILES.index(profile) < PROFILES.index(floor):
        actors = [a for a in forge.label_actors(DOWNGRADE_LABEL) if not a.endswith("[bot]")]
        if actors:
            print(f"note: profile downgraded to {profile} below floor {floor} "
                  f"by {actors[-1]} ({why})", file=sys.stderr)
        else:
            fails.append(
                f"profile {profile!r} is below the {floor!r} floor ({why}); "
                f"a human must apply the {DOWNGRADE_LABEL!r} label to downgrade")

    # --- intent ---
    intent = meta.get("intent") or {}
    for field in INTENT_FIELDS:
        status = intent.get(field)
        if status not in INTENT_STATUSES:
            fails.append(f"intent.{field} is {status!r}; expected one of {sorted(INTENT_STATUSES)}")
        elif status not in INTENT_OK:
            fails.append(f"intent.{field} is {status!r}")

    # --- clarifications ---
    for c in meta.get("clarifications") or []:
        if c.get("blocking") and c.get("status") != "resolved":
            fails.append(f"blocking clarification {c.get('id', '?')} is {c.get('status')!r}")

    # --- required sections and conditional documents ---
    have = sections(body)
    for name in SECTIONS_BY_PROFILE[profile]:
        if not have.get(name, "").strip():
            fails.append(f"section '## {name}' is missing or empty (profile {profile})")

    docs = list(required_docs(changed, policy))
    if profile == "high-assurance":
        docs.append("threat-model")
    for doc in sorted(set(docs)):
        side = path.with_name(f"{path.stem}.{doc}.md")
        if not side.exists() or not side.read_text(encoding="utf-8").strip():
            fails.append(f"required document {side.relative_to(root)} is missing or empty")

    # --- independent review (standard and above) ---
    if profile != "fast":
        fails += check_review(review_file, head)

    return fails


def check_review(review_file: Path | None, head: str) -> list[str]:
    if review_file is None or not review_file.exists():
        return ["no independent review verdict for this commit"]
    try:
        r = json.loads(review_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"review verdict is not valid JSON: {e}"]
    sha = str(r.get("sha", ""))
    if not SHA_RE.match(sha):
        return [f"review verdict has no full commit sha (got {sha!r})"]
    if sha != head:
        return [f"review verdict is for {sha[:12]}, HEAD is {head[:12]}; review is stale"]
    out = [f"blocking review finding {f.get('id', '?')}: {f.get('finding', '')[:120]}"
           for f in r.get("findings") or [] if f.get("severity") == "blocking"]
    if r.get("verdict") != "pass" and not out:
        out.append(f"review verdict is {r.get('verdict')!r}")
    return out


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def emit(as_json: bool, ok: bool, fails: list[str], extra: dict | None = None) -> int:
    if as_json:
        print(json.dumps({"result": "pass" if ok else "fail", "failures": fails,
                          **(extra or {})}, indent=2))
    else:
        for f in fails:
            print(f"fail: {f}")
        print("pass" if ok else f"FAILED ({len(fails)} problem{'s' * (len(fails) != 1)})")
    return 0 if ok else 1


def cmd_new(args, root, forge):
    policy = load_policy(root)
    path = item_path(root, policy, args.id)
    if path.exists():
        raise SystemExit(f"{path} already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(path, ITEM_TEMPLATE.format(id=args.id, profile=args.profile))
    print(path)
    return 0


def cmd_status(args, root, forge):
    policy = load_policy(root)
    path = item_path(root, policy, args.id)
    if not path.exists():
        raise SystemExit(f"{path} does not exist")
    meta, body = split_frontmatter(path.read_text(encoding="utf-8"))
    pr = forge.pr() or {}
    changed = forge.changed_files() if pr else []
    floor, why = profile_floor(changed, policy) if changed else ("unknown", None)
    out = {
        "id": meta.get("id"), "state": meta.get("state"), "profile": meta.get("profile"),
        "profile_floor": floor, "floor_reason": why,
        "open_blocking_clarifications": [
            c.get("id") for c in meta.get("clarifications") or []
            if c.get("blocking") and c.get("status") != "resolved"],
        # queried, never stored:
        "commit": forge.head_sha(), "pull_request": pr.get("number"),
        "review_decision": pr.get("reviewDecision"),
        "sections": [k for k, v in sections(body).items() if v.strip()],
    }
    if args.json:
        print(json.dumps(out, indent=2))
    else:
        for k, v in out.items():
            print(f"{k:32} {v}")
    return 0


def cmd_check(args, root, forge):
    review = Path(args.review) if args.review else root / "review.json"
    fails = do_check(root, forge, review)
    if not args.json and os.environ.get("CI") != "true":
        print("advisory: this local run does not satisfy any gate; CI does.", file=sys.stderr)
    return emit(args.json, not fails, fails)


def cmd_transition(args, root, forge):
    policy = load_policy(root)
    path = item_path(root, policy, args.id)
    if not path.exists():
        raise SystemExit(f"{path} does not exist")
    meta, body = split_frontmatter(path.read_text(encoding="utf-8"))
    cur, new = meta.get("state"), args.state
    if new not in STATES:
        raise SystemExit(f"unknown state {new!r}")
    if cur == "blocked":
        allowed = {meta.get("blocked_from", "intake"), "blocked"}
    else:
        allowed = TRANSITIONS.get(cur, set())
    if new not in allowed:
        raise SystemExit(f"illegal transition {cur!r} -> {new!r} (allowed: {sorted(allowed)})")
    if new == "blocked":
        meta["blocked_from"] = cur
    else:
        meta.pop("blocked_from", None)
    meta["state"] = new
    write_atomic(path, render(meta, body))
    print(f"{cur} -> {new}")
    return 0


def cmd_check_repo(args, root, forge):
    fails, warns = [], []
    if not (root / ".sdlc" / "policy.yaml").exists():
        fails.append(".sdlc/policy.yaml is missing")
    else:
        policy = load_policy(root)
        if not (policy.get("profiles") or {}).get("high-assurance"):
            warns.append("policy defines no high-assurance paths; the profile floor is inert")

    owners = next((p for p in [root / "CODEOWNERS", root / ".github" / "CODEOWNERS",
                               root / "docs" / "CODEOWNERS"] if p.exists()), None)
    if owners is None:
        fails.append("no CODEOWNERS file")
    elif ".github/workflows" not in owners.read_text(encoding="utf-8"):
        fails.append("CODEOWNERS does not cover .github/workflows/ "
                     "(the review job's permission grant would be unguarded)")

    prot = forge.branch_protection()
    if prot is None:
        warns.append("branch protection could not be read; without it nothing here is enforced")
    else:
        contexts = (prot.get("required_status_checks") or {}).get("contexts") or []
        if not any("sdlc" in c for c in contexts):
            fails.append(f"sdlc check is not a required status check (found: {contexts})")
        if not (prot.get("required_pull_request_reviews") or {}).get(
                "required_approving_review_count"):
            fails.append("branch protection does not require an approving review")

    for w in warns:
        print(f"warn: {w}", file=sys.stderr)
    return emit(args.json, not fails, fails, {"warnings": warns})


def main(argv=None, forge_factory=Forge):
    # Both `sdlcctl --json check` and `sdlcctl check --json` work. The subparser
    # copies uses SUPPRESS so that omitting the flag after the subcommand does
    # not clobber a value given before it. Do not fold these into one parent and
    # call set_defaults(): that mutates the shared action and reintroduces the
    # clobber.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", default=argparse.SUPPRESS)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS)

    ap = argparse.ArgumentParser(prog="sdlcctl", description=__doc__)
    ap.add_argument("--root", default=".")
    ap.add_argument("--json", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, **kw):
        return sub.add_parser(name, parents=[common], **kw)

    p = add("new"); p.add_argument("id")
    p.add_argument("--profile", choices=PROFILES, default="standard")
    p.set_defaults(fn=cmd_new)
    p = add("status"); p.add_argument("id"); p.set_defaults(fn=cmd_status)
    p = add("check"); p.add_argument("--review"); p.set_defaults(fn=cmd_check)
    p = add("transition"); p.add_argument("id"); p.add_argument("state")
    p.set_defaults(fn=cmd_transition)
    p = add("check-repo"); p.set_defaults(fn=cmd_check_repo)

    args = ap.parse_args(argv)
    root = Path(args.root).resolve()
    return args.fn(args, root, forge_factory(root))


if __name__ == "__main__":
    sys.exit(main())
