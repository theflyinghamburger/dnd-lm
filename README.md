# DnD LM

A persistent multiplayer text D&D 5e platform where an LLM plays the Dungeon Master.

Design documents are the source of truth:

- [`spec-doc.md`](spec-doc.md) — requirements (FR-xxx / NFR-xxx), journeys, delivery phases.
- [`architecture.md`](architecture.md) — stack, modules, data model, runtime flows, trust boundaries.
- [`MVP.md`](MVP.md) — the Phase 0–2 task plan (M0–M9). Issues in this repo mirror it one-to-one.
- [`CLAUDE.md`](CLAUDE.md) — the invariants every change is measured against.

## Layout

```
apps/api            NestJS modular monolith
apps/web            React + Vite
packages/contracts  Zod schemas shared by both — the only definition of a wire shape
```

## Getting started

```sh
pnpm install
docker compose up -d          # Postgres 16 on :5432
cp .env.example .env
pnpm build                    # packages/contracts emits dist/ that both apps consume
pnpm test
```

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` across every workspace project |
| `pnpm lint` / `pnpm format` | eslint / prettier |
| `pnpm test` | vitest across the workspace |
| `pnpm db:generate` | regenerate Drizzle migrations from `apps/api/src/db/schema.ts` |
| `pnpm db:migrate` | apply migrations to `DATABASE_URL` |

CI runs all of the above plus a migration-drift check: if the Drizzle schema no
longer matches the committed migrations, the build fails.
