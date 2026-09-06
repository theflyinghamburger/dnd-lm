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

## Run it locally

```sh
pnpm install
docker compose up -d                        # Postgres 16 on :5432
cp .env.example .env
sed -i "s|^PROVIDER_KEY_ENCRYPTION_KEY=$|PROVIDER_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
pnpm build                                  # packages/contracts emits dist/ that both apps consume
pnpm db:migrate                             # drizzle reads .env itself

set -a; . ./.env; set +a                    # the API does *not* read .env — export it first
pnpm --filter @dnd-lm/api start:dev         # API on :3000
pnpm --filter @dnd-lm/web dev               # web on :5173 (second terminal), proxies /api and /ws
```

Open <http://localhost:5173>. The API refuses to boot without a valid
`PROVIDER_KEY_ENCRYPTION_KEY` (64 hex chars) — that is the encryption key for
stored provider API keys, and there is no plaintext fallback.

## Playing a session

**1. Sign in.** Register on the landing page (password ≥ 12 characters), then
create a campaign. The creator gets a `host` membership.

**2. Become a platform admin.** Provider connections — base URL and API key —
are admin-only (SSRF and spend blast radius, NFR-301), and admin means *an
`admin` membership in any campaign*. There is no bootstrap UI; promote yourself
once, from the repo:

```sh
pnpm --filter @dnd-lm/api admin:grant you@example.com
```

It promotes your membership in each campaign **you own** and prints them;
memberships in other people's campaigns are left alone, because `admin` also
carries every `host` power inside the campaign it sits in. Run it twice and it
says so rather than reporting a second success.

Reload; a **Providers** button appears in the lobby. `admin` keeps every `host`
power, so nothing you could do before is lost.

**3. Add a DM provider.** Providers → new connection:

| Field | Value |
|---|---|
| kind | `anthropic` or `openai_compatible` |
| base URL | `https://api.anthropic.com` — or `http://localhost:11434/v1` etc. for local inference, which also needs `ALLOW_LOCAL_PROVIDERS=1` in `.env` |
| API key | write-only; stored AES-256-GCM, never read back. Omit for a keyless local endpoint |
| model | e.g. `claude-sonnet-5` |

**Test** fires one real minimal call (it spends money — nothing does it
implicitly). Then enable the connection.

**4. Point the campaign at it.** Lobby → **DM settings** on the campaign →
pick the provider from the redacted list, set style/tone/difficulty. Without a
provider the campaign has no DM and triggers go nowhere.

**5. Get everyone a character.** There is no creation wizard in the MVP — import
one of the six pregens, over the API:

```sh
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' -d '{"email":"you@example.com","password":"..."}'
curl -b cookies.txt http://localhost:3000/api/campaigns          # find the campaign id

curl -X POST http://localhost:3000/api/campaigns/$CAMPAIGN_ID/characters/import \
  -H 'content-type: application/json' -b cookies.txt \
  --data @fixtures/pregens/aria-sunhollow.json
```

Each player imports their own — a character belongs to the user who imported
it, and you can only sit down as your own. See `fixtures/pregens/README.md`.

**6. Invite the others.** "Invite a player" mints a single-use token; they paste
it into "Accept invite" in their own lobby.

**7. Enter the session.** Pick your character in the lobby dropdown (or "Watch
only") and hit **Enter session**. The host opens the session; players join the
one that is already open.

### What to type

The composer previews, before you send, who will read the line and whether it
wakes the DM — that badge runs the same routing function the server does.

| Input | What happens |
|---|---|
| plain text | in-character table talk. Does **not** wake the DM |
| `@dm <action>` | the DM resolves your action |
| `@npc <name> <text>` | talk to an NPC |
| `/ask <question>` | rules question |
| `/recap` | recap so far |
| `@party <text>` / `@handle <text>` | party or one player. No DM |
| `/whisper @handle <text>` | private |
| `/ooc <text>` | out of character |
| `/roll 1d20+3 adv` | server-side roll (`NdM`, optional `+K`/`-K`, optional `adv`/`dis`). Never wakes the DM |
| `/sheet` | sheet lookup |

Dice always roll on the server with a CSPRNG; the sheet panel's roll buttons go
through the same path.

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` across every workspace project |
| `pnpm lint` / `pnpm format` | eslint / prettier |
| `pnpm test` | vitest across the workspace |
| `pnpm db:generate` | regenerate Drizzle migrations from `apps/api/src/db/schema.ts` |
| `pnpm db:migrate` | apply migrations to `DATABASE_URL` |
| `pnpm --filter @dnd-lm/api admin:grant <email>` | promote that user to platform admin in the campaigns they own (needs `pnpm build` first) |

CI runs all of the above plus a migration-drift check: if the Drizzle schema no
longer matches the committed migrations, the build fails.
