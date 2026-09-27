---
schema_version: 1
id: deps-multer
title: Bump @nestjs/* to 12.1.0 so multer resolves to 2.4.0
type: bug
profile: standard
state: verifying
source: github:dependabot-alerts#2-#5
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

Dependabot alerts #2–#5: `multer` 2.2.0 carries three high-severity DoS
advisories and one low, fixed in 2.3.0. It arrives only transitively, through
`@nestjs/platform-express@12.0.1`. Since M4.7 (#81) the sheet-PDF import
endpoint (`POST .../characters/import-pdf`, `FileInterceptor` in
`characters.controller.ts`) parses multipart bodies with it, so this is real
runtime exposure on an authenticated but player-reachable route.

`@nestjs/platform-express@12.1.0` depends on `multer@2.4.0`. The fix is bumping
the six runtime/testing `@nestjs/*` packages together to `^12.1.0` — no pnpm
override, no source change.

## Specification

AC-1  `@nestjs/common`, `core`, `platform-express`, `platform-socket.io`,
      `websockets`, and `testing` are all `^12.1.0` in `apps/api/package.json`
      and resolve to 12.1.0 in `pnpm-lock.yaml`.
AC-2  `pnpm why -r multer` reports exactly one multer, at a version >= 2.3.0.
AC-3  No `pnpm.overrides` entry is added, and no unrelated direct dependency
      changes version.
AC-4  `apps/api/test/character-pdf.e2e.test.ts` passes against live Postgres,
      including the oversized-upload case that must still return 413 from
      multer's `limits.fileSize`.
AC-5  `pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test`
      green with `DATABASE_URL` exported (integration suites run, not skip).

## Decisions

- **D-1 — Profile raised from the computed `fast` floor to `standard`.** Neither
  `apps/api/package.json` nor `pnpm-lock.yaml` matches a policy pattern, but a
  framework minor bump under a security-driven, runtime-reachable upload path
  warrants a spec and independent review.
- **D-2 — `@nestjs/cli` and `@nestjs/schematics` stay at `^12.0.0`.** Neither has
  a 12.1 release (latest 12.0.7 / 12.0.5); both are dev-only tooling.
- **D-3 — Changelog read, nothing breaking for us.** v12.0.2–v12.1.0 are fixes and
  opt-in features (array global prefixes, built-in cookies/CSRF, fastify
  multipart). Relevant to us: #17818 merges multer `limits` key-by-key (we set
  limits only per-interceptor, no `MulterModule`), and multer 2.4.0 now rejects
  non-integer `fileSize` limits at construction — `MAX_SHEET_BYTES` is
  `8 * 1024 * 1024`, an integer. Transitive `file-type` moves 22.0.2 -> 22.1.1
  (via `@nestjs/common`); multer 2.4.0 drops `concat-stream` and its subtree.
- **D-4 — Pre-existing peer warning left alone.** `@nestjs/schematics@12.0.0`
  wants `typescript >=6`; identical on `main`, out of scope.

## Plan

1. Bump the six packages, `pnpm install`, `pnpm why -r multer` (AC-1..3).
2. Full gate with `DATABASE_URL`, confirm `character-pdf.e2e.test.ts` ran
   (AC-4, AC-5).
