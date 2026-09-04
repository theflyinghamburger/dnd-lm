# LLM Dungeon Master Platform — Product and Engineering Specification

**Status:** Draft
**Version:** 0.1
**Last updated:** 2026-09-04
**Related document:** `architecture.md`

## 1. Product summary

The product is a persistent, browser-based, multiplayer Dungeons & Dragons 5e experience in which an LLM acts as Dungeon Master. Players communicate through text, address the DM or one another explicitly, maintain persistent character sheets, and execute verifiable dice rolls through backend tools.

Campaign owners may upload campaign material they are authorized to use. The platform converts it into a structured, searchable campaign workspace used by a dedicated Campaign Librarian and the DM context builder.

## 2. Goals

### Product goals

- Support an enjoyable text-first campaign for a remote party.
- Prevent the DM from replying to ordinary player-to-player conversation.
- Provide trusted dice and persistent, mechanically consistent character state.
- Run both imported published adventures and original campaigns.
- Preserve campaign continuity across sessions and model calls.
- Keep context size, latency, and inference cost controlled.
- Make important AI decisions traceable to game state, tools, and campaign sources.

### Engineering goals

- Deterministic routing and state mutation around a probabilistic narrator.
- Transactional, auditable canonical state.
- Ordered realtime processing with reconnect and replay support.
- Model-provider portability.
- Versioned D&D 5e rules and configurable house rules.
- Incremental delivery through playable vertical slices.

## 3. Non-goals for the initial release

- Full 3D virtual tabletop functionality.
- Automated tactical map generation and token movement.
- Voice or video chat.
- Training or fine-tuning a proprietary foundation model.
- Perfect automation of every subclass, spell, item, and edge-case rule.
- Distribution of copyrighted campaign books by the platform.
- Autonomous modification of canonical state by any LLM agent.

## 4. Users and roles

| Role | Capabilities |
| --- | --- |
| Player | Join sessions, chat, control assigned characters, roll, inspect permitted state |
| Campaign host | Create campaigns, invite players, configure rules, start or pause sessions, override or retcon state |
| Content administrator | Upload and review campaign sources, correct extraction, configure spoilers and handouts |
| Platform administrator | Manage accounts, service configuration, safety, quotas, and operational support |
| LLM Dungeon Master | Narrate and propose actions through approved tools; no direct persistence authority |
| Campaign Librarian | Read and retrieve campaign sources; no narration or state mutation authority |

The campaign host and content administrator may be the same human.

## 5. Primary user journeys

### 5.1 Start a new campaign

1. Host creates a campaign.
2. Host selects the D&D 5e ruleset version and house rules.
3. Host creates an original campaign or uploads authorized source material.
4. System processes the source and presents a review report.
5. Host invites players.
6. Players create or import characters.
7. Host opens the first session.

### 5.2 Address the DM

1. Player sends `@dm I inspect the desk for a hidden compartment.`
2. Backend router identifies a DM trigger.
3. Session orchestrator serializes the action.
4. Context builder assembles current state and relevant campaign material.
5. DM narrates directly or requests a check.
6. Any roll and state change is executed by deterministic tools.
7. All authorized clients receive the committed result.

### 5.3 Talk to another player

1. Player sends `@Aria Do you still have the silver key?`
2. Router identifies Aria as the recipient.
3. Message is stored and delivered.
4. No DM call occurs.

### 5.4 Complete a DM-requested roll

1. DM requests a Perception check from an authorized character.
2. Player receives a pending-roll card.
3. Player confirms the roll.
4. Server calculates modifiers and generates the random result.
5. Roll is recorded and displayed.
6. Pending DM resolution resumes automatically.

### 5.5 Resume a campaign

1. Players reconnect to a campaign after an interruption or between sessions.
2. Client requests events after its last known sequence.
3. Backend restores the latest snapshot plus missing events.
4. Context builder uses current state, session recap, unresolved threads, and relevant memories.
5. Play resumes without loading the complete historical transcript into the LLM.

## 6. Functional requirements

Priority definitions:

- **P0:** Required for a playable MVP.
- **P1:** Required for a reliable beta.
- **P2:** Important after beta or for advanced campaigns.

### 6.1 Identity, campaigns, and sessions

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-101 | P0 | Users shall authenticate before joining a campaign or session. |
| FR-102 | P0 | A host shall create a campaign and invite or remove members. |
| FR-103 | P0 | Membership shall assign player, host, or administrator permissions. |
| FR-104 | P0 | A campaign shall contain one or more persistent sessions. |
| FR-105 | P0 | A player shall control only characters assigned to that player unless host permissions override this. |
| FR-106 | P1 | The host shall pause, resume, end, restore, or branch a session. |
| FR-107 | P1 | A reconnecting client shall resume from its last acknowledged event sequence. |

### 6.2 Messaging and addressing

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-201 | P0 | The system shall support `@dm`, player mentions, `@party`, `/ooc`, and `/whisper`. |
| FR-202 | P0 | Only explicit DM-addressed messages and approved system events shall invoke the DM. |
| FR-203 | P0 | Untagged messages shall default to table chat without invoking the DM. |
| FR-204 | P0 | Player-addressed messages shall be delivered without invoking the DM. |
| FR-205 | P0 | Every message shall store sender, recipients, channel, visibility, timestamp, and sequence. |
| FR-206 | P0 | The router shall operate deterministically without an LLM. |
| FR-207 | P1 | Private messages shall be excluded from DM context unless campaign policy explicitly allows visibility. |
| FR-208 | P1 | Public player dialogue may be available for later context without triggering an immediate model call. |
| FR-209 | P1 | The client shall display mention autocomplete and visibility before submission. |

### 6.3 Dice and game tools

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-301 | P0 | Dice rolls shall execute on the server, not inside the LLM. |
| FR-302 | P0 | The system shall store individual dice, modifiers, total, requester, visibility, and reason. |
| FR-303 | P0 | Character-based rolls shall calculate modifiers from authoritative character state. |
| FR-304 | P0 | Arbitrary rolls shall not automatically invoke the DM. |
| FR-305 | P0 | Completion of an authorized pending roll may resume DM resolution. |
| FR-306 | P1 | The system shall support advantage, disadvantage, critical results, saving throws, attacks, damage, and initiative. |
| FR-307 | P1 | Hidden DM rolls shall be auditable while remaining invisible to unauthorized players. |
| FR-308 | P2 | A campaign may enable independently verifiable roll proofs. |

### 6.4 Character sheets and encounters

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-401 | P0 | Character sheets shall persist ability scores, skills, saves, HP, AC, inventory, and basic resources. |
| FR-402 | P0 | All mutations shall be validated against ownership and state version. |
| FR-403 | P1 | Sheets shall support spells, features, equipment, charges, ammunition, hit dice, and rests. |
| FR-404 | P1 | Encounters shall track initiative order, round, active turn, combatants, HP, and conditions. |
| FR-405 | P1 | Damage resolution shall account for temporary HP, resistance, immunity, and vulnerability. |
| FR-406 | P1 | The host shall inspect and override state with an audit reason. |
| FR-407 | P2 | The mechanics engine shall support plug-in modules for additional classes, subclasses, and house rules. |

### 6.5 LLM Dungeon Master

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-501 | P0 | The DM shall receive a structured context package rather than the complete campaign history. |
| FR-502 | P0 | The DM shall return schema-valid narration, tool requests, proposed mutations, and next workflow state. |
| FR-503 | P0 | The DM shall have no direct database or random-number access. |
| FR-504 | P0 | Invalid tool calls or mutations shall be rejected without changing canonical state. |
| FR-505 | P0 | Narration describing a rejected mutation shall not be published as a committed outcome. |
| FR-506 | P1 | The host shall configure DM style, tone, difficulty, safety settings, and house rules. |
| FR-507 | P1 | The system shall support switching model providers without migrating game state. |
| FR-508 | P1 | Model responses shall retain trace links to triggering messages, retrieved sources, tool calls, and state versions. |

### 6.6 Campaign ingestion and Librarian

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-601 | P1 | Administrators shall upload authorized PDF, EPUB, HTML, or Markdown campaign material. |
| FR-602 | P1 | The system shall extract text, headings, tables, boxed text, images, and page references. |
| FR-603 | P1 | Scanned sources shall support OCR. |
| FR-604 | P1 | Ingestion shall classify chapters, locations, encounters, NPCs, items, clues, and read-aloud text. |
| FR-605 | P1 | The system shall generate normalized Markdown with structured frontmatter. |
| FR-606 | P1 | The system shall build lexical, vector, entity, and cross-reference indexes. |
| FR-607 | P1 | Low-confidence or conflicting extractions shall enter a human review queue. |
| FR-608 | P1 | Retrieval shall apply campaign, ruleset, progression, location, visibility, and spoiler filters before ranking. |
| FR-609 | P1 | The Librarian shall return cited, token-bounded source packets. |
| FR-610 | P1 | The Librarian shall not narrate, roll, or mutate game state. |
| FR-611 | P2 | The host shall edit or override normalized campaign records without editing the original upload. |

### 6.7 Context and memory

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-701 | P0 | Each DM call shall enforce an explicit input and output token budget. |
| FR-702 | P0 | Current structured state and the unresolved action shall have priority over historical conversation. |
| FR-703 | P0 | The platform shall maintain a rolling session summary. |
| FR-704 | P1 | Scene closure shall create a recap, durable-memory candidates, and unresolved-thread updates. |
| FR-705 | P1 | Durable memories shall retain source-event provenance. |
| FR-706 | P1 | Retrieval shall combine metadata filtering, lexical search, semantic similarity, importance, and recency. |
| FR-707 | P1 | Summaries shall not override canonical state or source events. |
| FR-708 | P1 | Complete transcripts shall remain queryable without being included in every prompt. |
| FR-709 | P2 | The system shall detect candidate memory contradictions and route them for correction. |

### 6.8 Administration and exports

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-801 | P0 | Hosts shall start, pause, resume, and end sessions. |
| FR-802 | P1 | Hosts shall view recent resolutions, rolls, mutations, and source references. |
| FR-803 | P1 | Hosts shall retcon or restore state through append-only corrective events. |
| FR-804 | P1 | Users shall export permitted transcripts, recaps, characters, and campaign state. |
| FR-805 | P1 | Administrators shall configure model providers, quotas, safety, and content policies. |
| FR-806 | P2 | Hosts shall branch a campaign from a prior snapshot without modifying the original branch. |

## 7. Non-functional requirements

### Performance

| ID | Requirement |
| --- | --- |
| NFR-101 | Non-DM chat should be delivered to connected recipients within 500 ms at the 95th percentile under expected beta load. |
| NFR-102 | Server-side dice results should be returned within 750 ms at the 95th percentile. |
| NFR-103 | DM narration should begin streaming within 5 seconds at the 95th percentile, excluding provider incidents and exceptionally large retrieval operations. |
| NFR-104 | A session reconnect should restore usable state within 3 seconds for a current snapshot plus 1,000 missed events. |

### Reliability and consistency

| ID | Requirement |
| --- | --- |
| NFR-201 | Commands shall be idempotent. |
| NFR-202 | State-changing session resolutions shall be serialized. |
| NFR-203 | Event append and snapshot projection shall be transactionally consistent or recoverable by replay. |
| NFR-204 | A failed LLM call shall not alter canonical state. |
| NFR-205 | A failed broadcast shall be recoverable through event replay on reconnect. |

### Security and privacy

| ID | Requirement |
| --- | --- |
| NFR-301 | All access shall be authenticated and authorized server-side. |
| NFR-302 | Message and roll visibility shall be enforced during storage, retrieval, context assembly, and broadcast. |
| NFR-303 | Uploaded content and retrieved text shall be treated as untrusted model input. |
| NFR-304 | Model providers shall receive only context required for the current resolution. |
| NFR-305 | Secrets and provider credentials shall never be stored in campaign content or prompts. |
| NFR-306 | The platform shall provide deletion and export mechanisms appropriate to its deployment jurisdiction. |

### Accessibility and usability

| ID | Requirement |
| --- | --- |
| NFR-401 | Core gameplay shall be usable by keyboard. |
| NFR-402 | Dynamic roll and state updates shall have screen-reader announcements. |
| NFR-403 | Recipient and visibility state shall not depend on colour alone. |
| NFR-404 | The interface shall support desktop and mobile-width browsers. |

### Observability

| ID | Requirement |
| --- | --- |
| NFR-501 | A resolution shall be traceable across message, queue, context, model call, tools, events, and broadcast. |
| NFR-502 | Telemetry shall record latency, prompt size, retrieval composition, tool errors, state conflicts, and model cost. |
| NFR-503 | Ordinary logs shall avoid raw private chat and copyrighted campaign text. |

## 8. Core data entities

| Entity | Key fields |
| --- | --- |
| User | ID, account identity, preferences, status |
| Campaign | ID, owner, ruleset, house rules, settings, active branch |
| Membership | Campaign, user, role, permissions |
| Session | Campaign, status, scene, sequence, state version, timestamps |
| Message | Sender, recipients, channel, visibility, content, sequence |
| Character | Owner, attributes, derived stats, resources, inventory, spells |
| Encounter | Scene, participants, initiative, round, active turn, status |
| PendingAction | Requester, authorized actors, action type, deadline, state |
| Roll | Expression, dice, modifiers, total, visibility, provenance |
| WorldEntity | NPC, location, item, faction, quest, clue, relationship |
| StateEvent | Aggregate, event type, payload, actor, source, state version |
| Snapshot | Aggregate, version, projected state |
| Memory | Fact, entities, scope, importance, status, source events |
| CampaignSource | File, rights metadata, ruleset, ingestion state |
| SourceChunk | Source, hierarchy, text, page, entities, spoiler metadata |

## 9. Command and event contracts

### 9.1 Client command envelope

```json
{
  "command_id": "cmd_01J...",
  "type": "SEND_MESSAGE",
  "session_id": "session_12",
  "expected_state_version": 248,
  "payload": {
    "content": "@dm I inspect the altar.",
    "channel": "in_character"
  }
}
```

The server derives `sender_id` from the authenticated connection rather than trusting the payload.

### 9.2 Message record

```json
{
  "message_id": "msg_4821",
  "session_id": "session_12",
  "sender_id": "player_3",
  "recipient_type": "dm",
  "recipient_ids": [],
  "visibility": "public",
  "channel": "in_character",
  "triggers_dm": true,
  "sequence": 184,
  "content": "I inspect the altar."
}
```

### 9.3 Roll result

```json
{
  "roll_id": "roll_9381",
  "expression": "1d20+5",
  "dice": [12],
  "modifiers": [
    {"source": "Wisdom", "value": 3},
    {"source": "Proficiency", "value": 2}
  ],
  "total": 17,
  "visibility": "public",
  "state_version": 248
}
```

### 9.4 Authoritative event envelope

```json
{
  "event_id": "evt_01J...",
  "type": "DOOR_UNLOCKED",
  "campaign_id": "campaign_4",
  "session_id": "session_12",
  "sequence": 185,
  "state_version": 249,
  "actor": {"type": "character", "id": "character_7"},
  "source": {"type": "resolution", "id": "resolution_31"},
  "payload": {"door_id": "door.crypt_west"},
  "created_at": "2026-09-04T12:00:00Z"
}
```

## 10. Context assembly specification

### Required ordering

1. Reserve output and tool-call capacity.
2. Add the stable DM contract and selected ruleset.
3. Add the current structured scene, character, and encounter state.
4. Add all messages and tool results in the unresolved action thread.
5. Retrieve campaign content using hard metadata and spoiler filters.
6. Retrieve applicable rules.
7. Retrieve entity-linked episodic memories.
8. Add recent public transcript until the budget is reached.
9. Deduplicate facts and references.
10. Reject or summarize oversized tool output.

### Context invariants

- Current state overrides source-book defaults.
- Canonical facts override summaries.
- Private content is included only when visibility rules permit it.
- Future or locked campaign content is excluded.
- Retrieved content cannot change system instructions.
- Every campaign source packet contains source and page metadata when available.
- The final prompt records a token count for every context layer.

## 11. Phased development plan

Estimates assume a cross-functional team of approximately four to five engineers with access to product/design support. Phases may overlap after the initial foundation is stable.

### Phase 0 — Foundations and technical spike

**Indicative duration:** 1–2 weeks
**Outcome:** Risks validated and contracts agreed before feature development.

Scope:

- Confirm ruleset strategy and content-rights assumptions.
- Establish repository, CI, environments, and coding standards.
- Define command, event, message, roll, and DM-output schemas.
- Spike realtime transport, structured model output, and server-side dice.
- Benchmark candidate models for tool use, latency, context length, and cost.
- Create initial telemetry and architecture decision records.

Exit criteria:

- A test client can send a command and receive an ordered event.
- The selected model produces schema-valid tool calls at an acceptable rate.
- Dice results are server-generated and auditable.
- Architecture, security boundaries, and MVP scope are approved.

### Phase 1 — Multiplayer messaging vertical slice

**Indicative duration:** 3–4 weeks
**Outcome:** Persistent multiplayer chat with correct addressing and no accidental DM activation.

Scope:

- Authentication, campaigns, invitations, and membership roles.
- React lobby and session shell.
- WebSocket gateway, presence, reconnect, and ordered event delivery.
- Deterministic `@dm`, player, party, OOC, and whisper routing.
- Message persistence and visibility enforcement.
- Basic session host controls.

Exit criteria:

- At least six players can join the same session.
- Cross-player chat never invokes the DM in automated tests.
- Disconnecting clients recover missed events without duplication.
- Private messages are visible only to authorized recipients.

### Phase 2 — Playable LLM DM MVP

**Indicative duration:** 4–5 weeks
**Outcome:** A party can complete a persistent text-only one-shot using original or manually prepared campaign notes.

Scope:

- Deterministic session orchestrator and state machine.
- Provider-neutral LLM adapter.
- Structured DM input and output contracts.
- Basic context builder with recent turns, state snapshot, and session summary.
- Server-authoritative dice expressions and pending roll requests.
- Basic character sheet: attributes, skills, saves, HP, AC, and inventory.
- Narration streaming and tool-validation failure handling.
- Manual campaign Markdown and rules retrieval.

Exit criteria:

- A four-to-six-player one-shot can run for at least three hours.
- All published roll results originate from the dice service.
- Failed model calls do not mutate state.
- Session restart restores messages, sheets, rolls, and current scene.
- Prompt size remains within the configured budget throughout the session.

### Phase 3 — Deterministic 5e mechanics and reliable sessions

**Indicative duration:** 4–6 weeks
**Outcome:** The system reliably handles common D&D 5e exploration and combat mechanics.

Scope:

- Event log and materialized snapshots.
- State-version and idempotency enforcement.
- Initiative, turns, attacks, damage, conditions, death saves, and rests.
- Spells, slots, equipment, charges, ammunition, and derived statistics.
- Hidden rolls and DM-visible state.
- Host overrides, corrective events, and restore points.
- Automated rule and concurrency tests.

Exit criteria:

- Common combat scenarios produce repeatable validated state transitions.
- Simultaneous commands cannot double-spend resources or corrupt turns.
- State can be rebuilt from the event log.
- Host corrections preserve audit history.
- Character-sheet calculations pass the agreed rules fixture suite.

### Phase 4 — Campaign ingestion and Librarian

**Indicative duration:** 5–7 weeks
**Outcome:** An authorized campaign book can be transformed into a reviewable, searchable campaign workspace and used during play.

Scope:

- PDF, EPUB, HTML, and Markdown intake.
- OCR, layout reconstruction, and page mapping.
- Entity, encounter, location, clue, item, and read-aloud extraction.
- Normalized Markdown with YAML frontmatter.
- Hybrid lexical/vector retrieval and entity index.
- Campaign Librarian read-only agent.
- Spoiler, progression, location, and ruleset filtering.
- Human review and correction interface.
- Retrieval evaluation dataset built from representative campaign questions.

Exit criteria:

- A representative campaign is ingested end to end.
- All runtime source packets include traceable citations.
- Locked or future content is excluded by automated spoiler tests.
- Cross-references such as rooms, appendices, and NPC aliases resolve correctly above the agreed quality threshold.
- The host can correct an extraction without re-uploading the source.

### Phase 5 — Long-running memory and campaign continuity

**Indicative duration:** 4–5 weeks
**Outcome:** Multi-session campaigns retain important history without uncontrolled context growth.

Scope:

- Scene, session, character, NPC relationship, and unresolved-thread summaries.
- Entity-centric durable memories with provenance.
- Memory candidate validation and contradiction handling.
- Archive retrieval from full events and transcripts.
- Context contribution telemetry and adaptive retrieval limits.
- Session and campaign recap exports.

Exit criteria:

- A multi-session evaluation campaign recalls defined facts and unresolved promises.
- Context size stays under configured limits across the complete campaign.
- Memory facts link to source events.
- Summaries cannot override contradictory canonical state.
- Retrieval precision and recall meet agreed evaluation thresholds.

### Phase 6 — Production hardening and closed beta

**Indicative duration:** 3–5 weeks
**Outcome:** The platform is supportable for a controlled external beta.

Scope:

- Load, soak, reconnect, failure-injection, and recovery testing.
- Rate limits, abuse controls, upload scanning, and retention policies.
- Accessibility and responsive UI review.
- Operational dashboards, alerts, backups, and restore drills.
- Model fallback and circuit breakers.
- Cost budgets per campaign and session.
- Data export, deletion, and support tooling.
- Closed beta instrumentation and feedback workflows.

Exit criteria:

- Performance and reliability NFRs pass under target beta load.
- Backup restore and event replay are demonstrated.
- Critical security findings are resolved.
- Operators can diagnose a failed DM resolution from correlated traces.
- Beta hosts can create, run, pause, restore, and export campaigns without engineering intervention.

## 12. Delivery milestones

| Milestone | Included phases | Deliverable |
| --- | --- | --- |
| Technical proof | Phase 0 | Realtime, dice, model-tool, and schema feasibility |
| Multiplayer foundation | Phase 1 | Persistent routed chat with permissions and reconnect |
| Playable MVP | Phase 2 | Original/manual one-shot with LLM DM and basic sheets |
| Rules-complete beta core | Phase 3 | Reliable common mechanics, combat, events, and recovery |
| Campaign-book beta | Phase 4 | Ingestion, review, Librarian, retrieval, and spoiler controls |
| Persistent campaign beta | Phase 5 | Long-running memory, bounded context, and recaps |
| Closed beta release | Phase 6 | Hardened deployment and operations |

Expected sequential delivery is approximately 24–34 weeks. With parallel frontend, mechanics, and ingestion work after Phase 1, a closed beta may be achievable in approximately 18–24 weeks, subject to rules coverage and campaign-ingestion quality.

## 13. Testing strategy

### Unit and property tests

- Mention and command parsing.
- Dice-expression parsing and statistical sanity.
- Character modifiers and resource consumption.
- Damage, condition, and initiative transitions.
- Permission and visibility policies.
- Context-budget allocation.

### Contract tests

- Client command and server event schemas.
- LLM structured output.
- Tool-call arguments and results.
- Provider adapter behaviour.
- Ingestion and normalized Markdown schema.

### Scenario tests

- Cross-player conversation produces no DM call.
- DM action requests and resumes a roll.
- Two simultaneous player actions remain ordered.
- A retry does not duplicate a roll or mutation.
- A model invents an item and the validator rejects it.
- A source-book instruction attempts prompt injection and is ignored.
- Future-chapter content is excluded.
- A session resumes after backend restart.
- A summary contradicts live state and live state wins.

### Evaluation suites

- DM tool-selection accuracy.
- Rules lookup accuracy.
- Campaign retrieval precision and citation correctness.
- Spoiler leakage rate.
- Long-horizon fact and relationship recall.
- Narrative coherence and repetition.
- Context size, latency, and cost per resolved action.

## 14. Release gates

The system must not enter closed beta until:

- No known path allows an LLM to commit state without validation.
- Cross-player messages are proven not to invoke the DM.
- Roll and visibility permissions pass automated tests.
- State reconstruction from events has been tested.
- Campaign retrieval is isolated by campaign and spoiler scope.
- Model and tool failures leave the session recoverable.
- Required data export, deletion, backup, and restoration operations work.
- Uploaded campaign content is governed by an explicit rights and retention policy.

## 15. Principal risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| LLM invents mechanics or state | Inconsistent game | Typed tools, validators, authoritative state, rejection and retry |
| DM reacts to player chatter | Disruptive play | Deterministic routing and explicit invocation policy |
| Context grows without bound | Cost and quality degradation | Layered memory, rolling summaries, explicit budgets, retrieval filters |
| Campaign retrieval reveals spoilers | Broken campaign | Hard progression filters, visibility scopes, adversarial tests |
| Ingestion misreads layout | Incorrect scenes or encounters | Page anchors, confidence scores, human review, source citations |
| Concurrent actions corrupt state | Lost or duplicated changes | Per-session serialization, versions, transactions, idempotency |
| Model provider fails | Session interruption | Timeouts, retries, fallback providers, resumable workflow |
| Copyrighted material leaks | Legal and trust risk | Private storage, strict access control, rights policy, limited source output |
| Summary loses important facts | Continuity problems | Provenance, entity memories, unresolved-thread tracking, full archive |
| Rules scope becomes too large | Schedule overrun | Prioritized mechanics fixtures and plug-in expansion after beta |

## 16. Open decisions

- Initial ruleset: 2014 5e, 2024 5e, or both.
- Character creation in scope versus importing prebuilt characters.
- Whether a human host may silently intervene during active narration.
- Visibility policy for public player dialogue and private whispers in later DM context.
- Permitted campaign-source formats and maximum upload size.
- Hosted-only models versus optional local inference.
- Whether tactical maps are included after beta.
- Required jurisdictions, retention period, and data residency.
- Initial rules coverage threshold for spells, subclasses, feats, and monsters.
- Business model and campaign-content licensing strategy.

## 17. Definition of MVP

The MVP is complete when four to six remote players can:

1. Join a persistent campaign.
2. Chat with each other without invoking the DM.
3. Explicitly address the LLM DM.
4. Receive coherent narration grounded in manually prepared campaign notes.
5. Complete server-authoritative rolls.
6. Maintain basic persistent character sheets.
7. Pause, disconnect, reconnect, and resume play.
8. Complete a three-hour text-only one-shot without state corruption or uncontrolled context growth.

Automated campaign-book ingestion is a post-MVP beta capability because it depends on reliable routing, tools, state, and context assembly being in place first.
