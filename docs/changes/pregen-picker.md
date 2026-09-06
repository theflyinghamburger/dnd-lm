---
schema_version: 1
id: pregen-picker
title: "Pregen character picker in the lobby \u2014 a seat without curl"
type: feature
profile: standard
state: verifying
source: 'github:#61 (blocks #54)'
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

D-3 locked "characters arrive as JSON — no creation wizard", and M4.2 shipped
the six pregens plus `POST /campaigns/:campaignId/characters/import`. What it
never shipped is a way to *reach* that endpoint from the app: `api.ts` has no
`import` method, and `CharacterPicker` in `Lobby.tsx` renders `no character` and
stops. A new player's only path to a seat is curl with a cookie jar — four to
six people doing that by hand before #54's playtest can start.

This is the picker, not the wizard MVP.md §7 defers. Choosing one of six shipped
sheets is not authoring a character: nothing here computes, accepts, or sends a
derived value, and the server re-validates the body it already validates today.
`characters.controller.ts` is untouched.

## Specification

AC-1  `api.importCharacter(campaignId, body)` POSTs to
      `/campaigns/:campaignId/characters/import` through the existing `post`
      helper (FR-105).
AC-2  A member with no character sees a chooser listing the six pregens by name
      where `no character` renders today, picks one, confirms, and the seat
      dropdown gains it without a page reload. The chooser stays available to a
      member who already has one.
AC-3  The fixtures reach the bundle from `fixtures/pregens/` itself — one copy,
      no `apps/web` duplicate, no new endpoint — and each is validated against
      the shared `ImportCharacterRequest` schema rather than trusted.
AC-4  `pnpm build` succeeds with the fixture glob, and the built bundle actually
      contains a pregen's data (an empty glob also "builds").
AC-5  A rejected import renders the server's own text via `describeApiError`, in
      a `role="alert"` — no client-side re-derivation of the rule.
AC-6  The imported character is owned by the importing user; a second member's
      own-character list does not gain it.
AC-7  Importing the same pregen twice yields two characters, both the caller's.
AC-8  `apps/api/test/pregens.test.ts` still reads `fixtures/pregens/` and is
      unchanged.
AC-9  `pnpm test` green against live Postgres, typecheck / lint / format green.

## Decisions

- **D-1 — The glob pattern is `../../../fixtures/pregens/*.json`, not the
  issue's `../../`.** Measured, not reasoned: the module lives in
  `apps/web/src/`, so `../../` is `apps/`, and the issue's pattern matches zero
  files. Vite reports no error for an empty glob — it compiles to
  `Object.assign({})` and the build succeeds — which is why AC-4 asserts a
  pregen's *data* is in the bundle rather than that the build passed.
- **D-2 — Both `dev` and `build` were confirmed before any UI was written**, per
  the issue's process step 1. `vite build` inlines all six JSON files; the dev
  server serves them as `/@fs/…` modules. No `server.fs.allow` entry was needed
  — the pnpm workspace root is already allowed. So the endpoint fallback the
  issue holds in reserve is not needed and is not built.
- **D-3 — Validated on the client with `ImportCharacterRequest`, the same schema
  the server's pipe uses.** `import.meta.glob` yields `unknown`; a cast would
  make a fixture typo a runtime crash in the lobby. Parsing is one line, uses
  the contract both sides already share, and is not a second validation policy —
  the server still re-validates, and its answer is the one AC-5 renders.
- **D-4 — The chooser is always rendered, next to the seat dropdown.** The issue
  asks for both "where `no character` is today" and "whenever a member wants a
  second character"; one always-present control is smaller than two conditional
  ones.
- **D-5 — No DOM-library test for the component.** The web app has no testing
  library and M7.6 already decided not to add one; `pregens.test.ts` covers the
  data path (AC-3, AC-4, AC-8) and the API e2e covers ownership and duplicates
  (AC-6, AC-7). What stays untested is the rendering itself — stated in
  § Verification rather than papered over.
- **D-6 — The curl path stays documented.** `fixtures/pregens/README.md` and
  README step 5 keep the `curl` recipe; a host scripting six seats should still
  be able to. Step 5 gains the lobby route as the default.

## Plan

1. `apps/web/src/pregens.ts` — the glob, parsed through `ImportCharacterRequest`,
   sorted by name. *Check:* `apps/web/src/pregens.test.ts` (six entries, each
   valid, the set equal to the fixture directory listing). Serves AC-3, AC-8.
2. `api.importCharacter` in `apps/web/src/api.ts`. *Check:* `pnpm typecheck`.
   Serves AC-1.
3. `CharacterPicker` in `Lobby.tsx` gains the chooser and its mutation,
   invalidating `['characters', campaignId]` on success and rendering
   `describeApiError` in a `role="alert"`. *Check:* `pnpm typecheck`, `pnpm lint`.
   Serves AC-2, AC-5.
4. Two assertions in `apps/api/test/characters.e2e.test.ts`' import block:
   ownership, and the same pregen imported twice. *Check:* `pnpm exec vitest run
   apps/api/test/characters.e2e.test.ts`. Serves AC-6, AC-7.
5. `pnpm build`, then grep the emitted bundle for a pregen's name. *Check:* that
   grep. Serves AC-4.
6. README step 5: the lobby first, curl kept below it. Serves D-6.
7. Full gate: `pnpm test`, typecheck / lint / format. Serves AC-9.

## Verification

Baseline before the change: 354 tests green against live Postgres. After: 359
(+3 `pregens.test.ts`, +2 `characters.e2e.test.ts`).

| AC | Covered by |
|---|---|
| AC-1 | `api.importCharacter`, typechecked against `ImportCharacterRequest` from contracts |
| AC-2 | **Not automated** — see below |
| AC-3 | `pregens.test.ts` "is every fixture on disk, and not an empty glob" + "parses each one as the request body the API accepts" |
| AC-4 | `pnpm build` green, then `grep "Aria Sunhollow" apps/web/dist/assets/*.js` → 1 hit, and `Sable Quickfoot` found |
| AC-5 | `describeApiError(importCharacter.error)` in a `role="alert"`, the same path `AdminProviders` uses |
| AC-6 | `characters.e2e.test.ts` "owns the character to the importer, not the host (#61)" |
| AC-7 | `characters.e2e.test.ts` "gives two characters for the same pregen imported twice (#61)" |
| AC-8 | `apps/api/test/pregens.test.ts` untouched — not in the diff |
| AC-9 | 359 tests green, typecheck / lint / format green |

The glob is pinned rather than assumed: restoring the issue's `../../` pattern
turns "is every fixture on disk, and not an empty glob" red — verified locally
and reverted. That test exists because the failure mode here is silence, not an
error.

**Not covered.** AC-2 is the rendering, and the web app has no DOM testing
library (M7.6 decided not to add one, D-5). The chooser's markup, the disabled
state while the mutation is in flight, and the seat dropdown gaining the
character after invalidation were not exercised — by a test or by hand in a
browser. What *is* pinned is everything under the render: the data it lists, the
call it makes, the ownership the server enforces, and that the fixtures reach
the bundle at all.

## Corrections

- **D-7 — README step 5 is not in this diff, and should be.** The play-path
  walkthrough that contains it is unmerged, in PR #62 (#60). On `main` the README
  has no character section to amend, so `fixtures/pregens/README.md` carries the
  lobby route here instead. **Whichever of #62 and this PR merges second must add
  the lobby line to README step 5** — it currently reads as though `curl` is the
  only way in. Flagged in both PR descriptions rather than fixed by a
  speculative merge.
