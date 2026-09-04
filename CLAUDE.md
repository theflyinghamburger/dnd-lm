# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Design-only. No code, no build system, no tests, no git repo yet. Two documents:

- `spec-doc.md` — product/engineering spec: roles, user journeys, numbered requirements (FR-xxx by P0/P1/P2 priority, NFR-xxx), data entities, JSON contracts, 7-phase delivery plan, testing strategy, release gates, open decisions.
- `architecture.md` — technical architecture: stack, module responsibilities, data model, context/memory design, runtime flows, trust boundaries.
- `MVP.md` — the task plan for Phases 0-2. Decisions locked for the MVP are in its §2, the DM trigger registry in §4, deliberate gaps in §7. Read it before starting implementation work.

LLM providers are configured at runtime through the UI (MVP.md M7), not by env or code: an operator supplies a host URL and API key per connection. Treat that URL as an SSRF boundary and the key as write-only across the API.

When implementing, cite the requirement ID (`FR-206`, `NFR-202`) the code satisfies. Contradictions between the two docs are real bugs — flag them rather than silently picking one.

## What the system is

A persistent multiplayer text D&D 5e platform where an LLM plays the Dungeon Master. Chosen stack (architecture.md §4): React + Vite + TS frontend, NestJS modular monolith backend, WebSocket realtime, PostgreSQL + pgvector + FTS, Redis, BullMQ workers, S3-compatible object storage, LangGraphJS bounded inside the DM module only.

## Invariants that constrain every design decision

These are the point of the architecture. Violating one is not a style disagreement:

1. **The LLM does not own game state.** It narrates and *proposes*; deterministic backend tools validate and commit. No direct DB or RNG access from the model (FR-503). LangGraph is bounded inside one DM turn and holds no write handle — the orchestrator owns state, locking, and commits (architecture.md §14 decision 5).
2. **Routing is deterministic, never LLM-based.** The DM runs only when a message matches the trigger registry (MVP.md §4); player mentions, `@party`, untagged chat, `/ooc`, `/whisper`, arbitrary `/roll`, and any unrecognized tag do not (FR-202/206, router table in architecture.md §6.2).
3. **Dice roll server-side with a CSPRNG**, with full modifier provenance stored (FR-301/302).
4. **Narration and mutations commit as one logical resolution.** A rejected mutation must not ship as published narration (FR-505).
5. **Events are append-only truth; snapshots and Markdown recaps are derived projections.** Corrections are new corrective events, never edits.
6. **One state-mutating resolution per session at a time**, guarded by `state_version` + idempotent `command_id` (NFR-201/202). Non-mutating chat runs concurrently.
7. **Uploaded books, retrieved chunks, and player text are untrusted data**, never instructions. Hard metadata/spoiler filters run *before* semantic ranking so future-chapter and cross-campaign content cannot leak.
8. **Context is assembled per turn under explicit token budgets** (architecture.md §8.2). Full transcript and full campaign book are never sent. Live state beats source-book text; canonical state beats summaries.

## Build order

`MVP.md` breaks Phases 0-2 into tasks M0-M8 with acceptance criteria. Beyond that, phases in spec-doc.md §11 are sequenced by dependency, not preference — routing and state correctness precede ingestion. Each phase has exit criteria; treat them as the definition of done. MVP scope is spec-doc.md §17; campaign-book ingestion is explicitly post-MVP.

## Open decisions

spec-doc.md §16 lists unresolved product decisions (2014 vs 2024 5e ruleset, hosted vs local inference, character creation scope, and others). Don't resolve one implicitly in code — ask.
