---
schema_version: 1
id: pregen-picker
title: "Pregen character picker in the lobby \u2014 a seat without curl"
type: feature
profile: standard
state: reviewing
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

Baseline before the change: 354 tests green against live Postgres. After: **361**
— seven new, five in `pregens.test.ts` and two in `characters.e2e.test.ts`. (The
first version of this section said 359 against a three-test `pregens.test.ts`;
the review-driven work in § Corrections added the vite-config scan and the
cast-vs-parse scan, and D-9's "361" was written before the last of them landed.
361 is the count at the head of this branch.)

| AC | Covered by |
|---|---|
| AC-1 | `api.importCharacter`, typechecked against `ImportCharacterRequest` from contracts |
| AC-2 | Driven by hand in headless Chromium against `pnpm dev` — see § Corrections |
| AC-3 | `pregens.test.ts` "is every fixture on disk, and not an empty glob" + "parses each one as the request body the API accepts" |
| AC-4 | `pnpm build` green, then `grep "Aria Sunhollow" apps/web/dist/assets/*.js` → 1 hit, and `Sable Quickfoot` found |
| AC-5 | `describeApiError(importCharacter.error)` in a `role="alert"`, the same path `AdminProviders` uses |
| AC-6 | `characters.e2e.test.ts` "owns the character to the importer, not the host (#61)" |
| AC-7 | `characters.e2e.test.ts` "gives two characters for the same pregen imported twice (#61)" |
| AC-8 | `apps/api/test/pregens.test.ts` untouched — not in the diff |
| AC-9 | 361 tests green, typecheck / lint / format green |

The glob is pinned rather than assumed: restoring the issue's `../../` pattern
turns "is every fixture on disk, and not an empty glob" red — verified locally
and reverted. That test exists because the failure mode here is silence, not an
error.

**Not covered by an automated test.** AC-2 is the rendering, and the web app has
no DOM testing library (M7.6 decided not to add one, D-5). It was instead driven
by hand — see § Corrections, D-9 — which is a one-off, not a regression guard.
A future change to the chooser's markup or its invalidation wiring has nothing
watching it.

## Corrections

- **D-7 — README step 5 is not in this diff, and should be.** The play-path
  walkthrough that contains it is unmerged, in PR #62 (#60). On `main` the README
  has no character section to amend, so `fixtures/pregens/README.md` carries the
  lobby route here instead. **Whichever of #62 and this PR merges second must add
  the lobby line to README step 5** — it currently reads as though `curl` is the
  only way in. Flagged in both PR descriptions rather than fixed by a
  speculative merge.

- **D-8 — The ownership test now grounds `ownerUserId` to the importer's id**
  (review of `31c12b26f087`, medium). It previously asserted only that the two
  imports had *different* owners and then filtered by the imported character's
  own owner — so ownership assigned to the wrong member, differing per caller,
  would have passed, and the comment claiming it mirrored the lobby's
  `user.id` filter overclaimed. The id now comes from `GET /api/auth/me` on the
  player's cookie, the same place the lobby gets it. Resolving that id from the
  host's cookie instead turns the test red — measured, then reverted.
- **D-9 — AC-2 was driven by hand, and it found a bug no check here could.**
  Both reviewers raised the same high finding: the change's user-facing
  deliverable was verified by nothing. Driving it in headless Chromium against
  `pnpm --filter @dnd-lm/web dev` reproduced all four steps — and the app did
  not load at all.

  `pregens.ts` is the web app's **first value import** from `@dnd-lm/contracts`;
  every other import there is `import type`, erased before it reaches a runtime.
  Contracts builds to CommonJS (apps/api is a CJS Nest app), vite does not
  pre-bundle a linked workspace package, and `cjs-module-lexer` does not see
  through `dist/index.js`'s transitive `export *`. The dev server therefore
  threw `SyntaxError: … does not provide an export named 'ImportCharacterRequest'`
  at module evaluation, and the whole app failed to load — while `pnpm build`,
  `pnpm typecheck`, `pnpm lint` and all 360 tests then in the suite stayed
  green. `vite build`
  resolves the interop itself (the production bundle was confirmed to load), and
  vitest aliases contracts to source, so no check in this repo could see it.

  Fixed with `optimizeDeps: { include: ['@dnd-lm/contracts'] }` in
  `apps/web/vite.config.ts`, and pinned by a source scan in `pregens.test.ts` —
  the same technique `key-handling.test.ts` uses, and the only kind of check
  that can observe a dev-server-only failure.

  Verified after the fix, in the browser: the chooser renders where
  `no character` does and offers all six by name; picking one and pressing
  **Add character** makes the seat dropdown gain it (`Watch only`,
  `Nimbeth Vale`) with a `window` marker set before the click still intact, so
  nothing reloaded; a second import leaves the chooser in place and the dropdown
  at three options; and deleting the membership out from under the page makes
  the next import render `NOT_A_MEMBER` — the server's own code, through
  `describeApiError`, in the `role="alert"`.
- **D-10 — Two low findings taken, one deliberately not.** The fixture count is
  now `toHaveLength(6)` rather than a floor of 4, and the ordering test uses the
  exported `byName` comparator instead of `Array.sort`'s UTF-16 order. The
  informational finding about `ImportCharacterRequest.parse` at module scope
  taking down the whole app rather than the chooser is **accepted as-is**: it is
  the same blast radius the reviewer noted, CI validates every fixture, and
  wrapping it would trade a loud failure for a quiet one.
- **D-11 — The re-review's suggested fix for its own medium finding does not
  work, and the finding is still right.** It asked that `pregens.test.ts` read
  the fixtures off disk, parse them, and compare to `PREGENS`, so that replacing
  `pregens.ts`'s `.parse` with a cast would go red. That was built — and
  measured: it stays **green**. Zod strips nothing from these six, so the parsed
  value is structurally identical to the JSON on disk, and no assertion over
  `PREGENS` can tell a parse from a cast. The difference appears only for a
  fixture that fails the schema, which AC-8 guarantees cannot exist.

  The disk comparison is kept — it pins disk → schema → what the chooser lists,
  which re-parsing `PREGENS` did not. The validation itself is pinned the only
  way it can be, by a source scan beside the `optimizeDeps` one; removing the
  `.parse` turns that red, measured. Both low findings taken as written: the
  fixture directory now resolves from `import.meta.dirname` like the config read
  three lines away, and the counts above are reconciled against the run at this
  commit.
