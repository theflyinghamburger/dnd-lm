---
schema_version: 1
id: gate-dotted-ids
title: The gate cannot find a work item whose id contains a dot
type: bug
profile: fast
source: found while running M7.5 (#23) through the gate, 2026-09-05
state: reviewing
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

`find_item` accepted a changed file as a work item only when its name contained
exactly one dot. That was the trick for telling `<id>.md` apart from its sibling
documents (`<id>.threat-model.md`), and it silently excludes every id that has a
dot in it — which in this repository is all of them: milestones are `M7.5`,
`M3.2`, `M7.9`. `SDLC.md` documents `sdlcctl.py new M3.2` as the usage example.

The failure mode is what makes it worth fixing rather than working around. The
gate does not say "your id has a dot"; it reports

    fail: no work-item file, but high-assurance profile is required

on a change whose work item is right there in the diff, which reads as "the
agent skipped the process" rather than "the gate cannot see the file".

`item_path` and the sibling-document lookup already handle dotted ids correctly
(`Path("M7.5.md").stem` is `M7.5`), so `find_item` was the only place that
disagreed.

## Specification

AC-1  `docs/changes/M7.5.md` in a change is found as its work item.
AC-2  `docs/changes/M7.5.threat-model.md`, `.migration-plan.md` and
      `.rollback-plan.md` are still **not** work items of their own.
AC-3  A dot-free id (`sdlc-install`) keeps working exactly as before.
AC-4  The kinds excluded come from `.sdlc/policy.yaml`'s `requires:` keys plus
      the threat model, so a repository that adds a conditional document does
      not have to also teach `find_item` about it.

## Decisions

- **Excluded by kind, not by shape.** The alternative — renaming work items to
  dot-free ids (`M7-5`) — leaves the trap for the next person and makes the
  documented `M3.2` example wrong. The vocabulary of sibling kinds already
  exists in `do_check`; this reuses it instead of inventing a second rule.
- **`"threat-model"` becomes a constant.** It was a literal in `do_check` and
  now has a second reader, and two spellings of one required document is the
  kind of drift that is invisible until it fails.
- **Not fixed by loosening the id rule.** `ID_RE` already allows dots, which is
  the evidence that dotted ids were intended all along.

## Plan

1. `sibling_doc_kinds(policy)`; `find_item` excludes by kind. — AC-1..AC-4
2. `THREAT_MODEL` constant, used by both readers. — AC-4
3. Verify against this repository's own changed-file list, both a dotted work
   item and the existing dot-free one. — AC-1, AC-3

## Traceability

Not required at the `fast` floor; the acceptance criteria map one-to-one onto
`find_item`'s two rules (prefix and kind).
