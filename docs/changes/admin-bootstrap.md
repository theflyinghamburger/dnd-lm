---
schema_version: 1
id: admin-bootstrap
title: "Platform admin bootstrap \u2014 first admin without hand-written SQL"
type: feature
profile: standard
state: reviewing
source: 'github:#60 (blocks #54)'
intent:
  objective: clear
  subject: clear
  current_behavior: clear
  expected_behavior: clear
  scope: clear
  constraints: clear
  verification: clear
clarifications:
- id: CL-001
  category: authorization
  blocking: true
  status: resolved
  question: "Which membership rows should the grant promote \u2014 every membership\
    \ the user holds (what the README's SQL does today), or only the campaigns they\
    \ own?"
  decision: "Only memberships in campaigns the user owns. `admin` is not merely the\
    \ platform flag \u2014 `@CampaignRoles('host', 'admin')` and `session.gateway.ts:671`\
    \ treat it as host *inside that campaign*, so promoting every membership escalates\
    \ the user to host in campaigns belonging to other people. One owned-campaign\
    \ row is enough for `isPlatformAdmin`."
  source: in-thread, 2026-09-07
  affects:
  - specification
  - implementation
---

## Change brief

M7.4 (#22) defined a platform admin as an `admin` membership in any campaign and
gave admins sole power over provider connections. It never said how the *first*
one comes to exist. Today the only path is the raw `UPDATE` the README prints:

```sh
docker compose exec postgres psql -U dnd -d dnd_lm -c \
  "UPDATE memberships SET role='admin' WHERE user_id=(SELECT id FROM users WHERE email='...');"
```

Hand-typed SQL against a live table, with no check that it matched anything —
and it is the first step of every playtest host's setup, so #54 cannot start
without it.

This replaces it with `pnpm --filter @dnd-lm/api admin:grant <email>`: a script
that promotes by the existing definition rather than inventing a second one. No
new column, no new table, no `ADMIN_EMAILS` env — a second source of truth for
"who is an admin" is exactly what M7.4 chose option (a) to avoid, and the guard
reads `memberships`, not an env var.

The uncommitted README rewrite (the local play path, which is what surfaced both
this and #61) lands here, with its step 2 written against the command instead of
the SQL. Committing the SQL step first and deleting it in the next commit would
publish an instruction this change exists to retract.

## Specification

AC-1  `pnpm --filter @dnd-lm/api admin:grant <email>` sets `role='admin'` on the
      caller's memberships in campaigns they own, prints each campaign by name,
      and exits 0 (FR-105, NFR-301).
AC-2  A membership in a campaign the user does **not** own is left at its
      existing role and reported as left alone (CL-001).
AC-3  A second run promotes nothing, says so, and exits 0 — idempotent, not a
      second reported success.
AC-4  An email with no `users` row exits non-zero with a message naming the
      email. A known user who owns no campaign exits non-zero saying to create a
      campaign first.
AC-5  After AC-1 the promoted user satisfies `MembershipService.isPlatformAdmin`
      and `GET /api/admin/providers` returns 200 for them, through the unmodified
      `AdminGuard` — the row is admin because the guard's own query says so.
AC-6  No schema change: `pnpm db:check` reports no drift and `apps/api/drizzle/`
      is untouched.
AC-7  README's "Become a platform admin" step invokes the command; no raw SQL
      remains as the documented path.
AC-8  `pnpm test` green against live Postgres, `pnpm typecheck` / `pnpm lint` /
      `pnpm format` green.

## Decisions

- **D-1 — Owned campaigns only.** CL-001. The narrower grant is also the one
  that keeps the message honest: "promoted admin in *N* campaigns you own" is a
  claim the operator can check, where the current SQL's silent all-rows update
  is not.
- **D-2 — Promotion, never invention.** If the email has no `users` row the
  script fails; it does not create a user, a campaign, or a membership. A
  bootstrap tool that can mint an account is a much larger thing than the gap
  being closed, and the registration endpoint already exists.
- **D-3 — `--env-file=../../.env`, not `.env`.** The issue's snippet says
  `.env`, but `pnpm --filter @dnd-lm/api` runs with `apps/api` as cwd and there
  is no `apps/api/.env`; `node --env-file` on a missing file is a hard error.
  The env file lives at the repo root, which is where `set -a; . ./.env` in the
  README points too.
- **D-4 — The script runs against `dist/`, per the issue.** It is a plain
  `postgres`+`drizzle` handle, not a Nest context: nothing here needs DI, and
  booting `AppModule` would drag in the socket.io server and the provider master
  key to run one `UPDATE`. Cost is that `pnpm build` must have run — the README
  step already does, one line above.
- **D-5 — `grantAdmin(db, email)` is exported and tested; `main()` only wires
  argv, stdout and the exit code.** The branches worth pinning (unknown email,
  no owned campaign, second run) are all in the exported function.
- **D-6 — Profile held at `standard`, above the computed floor.** No changed
  path matches a `high-assurance` pattern (`apps/api/src/scripts/**` is not in
  `.sdlc/policy.yaml`), but the change is a privilege-granting tool, so it is
  not run at `fast` either. It is not raised to `high-assurance`: it adds no
  code path reachable from a request, and anyone who can run it already holds
  `DATABASE_URL` and could issue the `UPDATE` by hand.

## Plan

1. `apps/api/src/scripts/grant-admin.ts` — exported `grantAdmin(db, email)`
   returning what it changed, plus a `main()` behind
   `require.main === module`. *Check:* `pnpm --filter @dnd-lm/api typecheck`.
   Serves AC-1..AC-4.
2. `"admin:grant"` in `apps/api/package.json`. *Check:* run it end to end
   against the local database — unknown email, known user with no campaign,
   first run, second run. Serves AC-1, AC-3, AC-4.
3. `apps/api/test/grant-admin.e2e.test.ts` — register two users through the API,
   own a campaign each, join the other's, then assert the four outcomes and that
   `GET /api/admin/providers` flips 403 → 200. *Check:* `pnpm exec vitest run
   apps/api/test/grant-admin.e2e.test.ts`. Serves AC-1..AC-5.
4. README: fold in the local play path with step 2 written against the command.
   *Check:* AC-7 by reading; `pnpm format`. Serves AC-7.
5. Full gate: `pnpm test`, `pnpm db:check`, typecheck / lint / format.
   Serves AC-6, AC-8.

## Verification

Baseline before the change: 354 tests green against live Postgres.

| AC | Covered by |
|---|---|
| AC-1, AC-2 | `grant-admin.e2e.test.ts` "promotes the campaigns the user owns…" — plus the CLI end to end: two owned campaigns promoted by name, the third-party `player` row still `player` in the database afterwards |
| AC-3 | "is idempotent on a second run"; CLI second run prints `already admin in 2 campaign(s)` and exits 0 |
| AC-4 | "refuses an unknown email, naming it" and "refuses a known user who owns no campaign"; CLI exits 1 on both, and on no argument |
| AC-5 | "flips GET /api/admin/providers from 403 to 200 through the real guard" — `AdminGuard` and `MembershipService` are unmodified |
| AC-6 | `pnpm db:check` — "Everything's fine"; no file under `apps/api/drizzle/` changed |
| AC-7 | README step 2 and the commands table |
| AC-8 | 360 tests green (354 + 6), typecheck / lint / format green |

CL-001 is pinned, not merely implemented: replacing `owned` with every
membership row turns two of the six tests red (AC-1/AC-2 and the
owns-no-campaign case), verified locally and reverted.

**Not covered.** `report()`'s exact wording is exercised only by the manual CLI
run above; the tests assert the `GrantResult` it formats, not the strings. A
message-only regression would ship green — cheap to catch, and not worth
freezing the phrasing of an operator message in an assertion.
