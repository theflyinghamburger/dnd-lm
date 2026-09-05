#!/usr/bin/env python3
"""sdlcreview - run the independent review against any OpenAI-style endpoint.

Host URL + API key + model name. Anything speaking POST {base}/chat/completions
works: OpenAI, OpenRouter, Together, Fireworks, a local vLLM or Ollama.

The review procedure is NOT duplicated here - it is read from the sdlc-review
skill, which stays the single source of truth for what a review must check and
what it must emit. This file only carries the diff and the spec to a model and
writes the two files the gate reads.

    REVIEW_BASE_URL   e.g. https://openrouter.ai/api/v1   (no trailing slash)
    REVIEW_API_KEY    sent as `Authorization: Bearer`
    REVIEW_MODEL      e.g. anthropic/claude-opus-5

Exits non-zero on any failure. A review that did not happen must never look
like a review that found nothing.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sdlcctl import Forge, find_item, load_policy  # noqa: E402

SKILL = ".claude/skills/sdlc-review/SKILL.md"
TIMEOUT = 900  # a real review is slow; a gateway that needs longer is misconfigured

SEVERITY_ORDER = ["blocking", "high", "medium", "low", "informational"]


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"{name} is not set")
    return v


def build_prompt(root: Path, diff: str, sha: str) -> str:
    skill = (root / SKILL).read_text(encoding="utf-8")

    forge = Forge(root)
    policy = load_policy(root)
    specs = []
    for rel in find_item(root, policy, forge.changed_files()):
        p = root / rel
        if p.exists():
            specs.append(f"### {rel}\n\n{p.read_text(encoding='utf-8')}")

    spec = "\n\n".join(specs) if specs else (
        "No work-item file is in this change. If the profile required one, that "
        "itself is a blocking finding."
    )

    # The skill says: read the specification before the diff. So does this prompt.
    return f"""{skill}

---

You are running as the independent reviewer described above. You have no write
access to this repository and cannot fix anything you find.

Reply with ONE JSON object and nothing else - no prose, no code fence. Use the
schema in the procedure above. Omit `sha`; it is filled in from git.

## The specification this change was built against

{spec}

## The diff, at commit {sha}

```diff
{diff}
```
"""


def call(base_url: str, api_key: str, model: str, prompt: str) -> str:
    body = json.dumps({
        "model": model,
        # No response_format: not every OpenAI-style host accepts it, and one
        # that rejects it fails the whole call. extract_json handles the rest.
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            payload = json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{base_url}: HTTP {e.code} {e.read(2000).decode('utf-8', 'replace')}")
    except OSError as e:
        raise SystemExit(f"{base_url}: {e}")

    try:
        return payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise SystemExit(f"unexpected response shape: {json.dumps(payload)[:2000]}")


def extract_json(text: str) -> dict:
    """Models wrap JSON in prose or fences however they like. Take the object."""
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text.strip())
    start = text.find("{")
    if start == -1:
        raise SystemExit(f"no JSON object in the model's reply: {text[:500]}")
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if esc:
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == '"':
            in_str = not in_str
        elif not in_str:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return json.loads(text[start:i + 1])
    raise SystemExit(f"unterminated JSON object in the model's reply: {text[:500]}")


def render_md(review: dict) -> str:
    sha, verdict = review["sha"], review.get("verdict", "?")
    lines = [f"**Review of `{sha[:12]}` - verdict: `{verdict}`**", ""]
    findings = sorted(
        review.get("findings") or [],
        key=lambda f: SEVERITY_ORDER.index(f.get("severity"))
        if f.get("severity") in SEVERITY_ORDER else len(SEVERITY_ORDER))
    if not findings:
        lines.append("No findings.")
    for f in findings:
        lines.append(
            f"- **{f.get('severity', '?')}** / {f.get('confidence', '?')} confidence"
            f" - `{f.get('location', '?')}`  \n"
            f"  {f.get('finding', '')}  \n"
            f"  *Fix:* {f.get('recommendation', '-')}")
    lines += ["", "_Advisory. Human approval is still required._"]
    return "\n".join(lines) + "\n"


def main() -> int:
    root = Path(os.environ.get("REVIEW_ROOT", ".")).resolve()
    diff = sys.stdin.read()
    if not diff.strip():
        raise SystemExit("empty diff on stdin")

    sha = Forge(root).head_sha()
    review = extract_json(call(
        env("REVIEW_BASE_URL"), env("REVIEW_API_KEY"), env("REVIEW_MODEL"),
        build_prompt(root, diff, sha)))

    # The gate compares this against HEAD. The script knows HEAD; the model does
    # not need to be trusted with it.
    review["sha"] = sha
    review.setdefault("schema_version", 1)
    review.setdefault("findings", [])
    if any(f.get("severity") == "blocking" for f in review["findings"]):
        review["verdict"] = "blocked"
    review.setdefault("verdict", "pass")

    (root / "review.json").write_text(json.dumps(review, indent=2) + "\n", encoding="utf-8")
    (root / "review.md").write_text(render_md(review), encoding="utf-8")
    print(f"{review['verdict']}: {len(review['findings'])} finding(s) at {sha[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
