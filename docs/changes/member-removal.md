---
schema_version: 1
id: member-removal
title: Remove a member from a campaign (FR-102's missing half)
type: feature
profile: high-assurance
state: verifying
source: github:theflyinghamburger/dnd-lm#79
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

FR-102: "A host shall create a campaign and invite **or remove** members." Invites
shipped in M1; removal never existed. `memberships` rows were insert-only, so a
member added by mistake kept every campaign route, their WebSocket, the
transcript and their character forever.

This adds `DELETE /api/campaigns/:campaignId/members/:userId` (host or admin,
204) and a member list with a Remove control in the Lobby. The security-relevant
half is the gateway: identity is settled once at handshake, so the removal also
disconnects the member's live sockets for that campaign, after the delete
commits.

## Specification

- **AC-1** After a host removes a member, that user's `GET /api/campaigns` no
  longer lists the campaign and every campaign route returns 403.
- **AC-2** A removed member who is connected at the time is disconnected by the
  server, other members stay connected, and a reconnect is refused at the
  handshake with `NOT_A_MEMBER`.
- **AC-3** A socket whose removal commits between its handshake's membership
  read and its room join is still disconnected.
- **AC-4** Removing the owner is refused 409 `OWNER_NOT_REMOVABLE`; removing the
  last host/admin is refused 409 `LAST_HOST`. Removing a host while another
  remains is 204.
- **AC-5** Removing a non-member (or the same member twice) is 204; a malformed
  user id is 400.
- **AC-6** A player calling the endpoint gets 403.
- **AC-7** The removed member's characters still exist, still name them as
  owner, and nobody (not even the host) can act as them; their past messages
  are still in the event log.
- **AC-8** A host or admin sees the campaign's members in the Lobby with a
  Remove control (not on the owner), behind a `confirm()`.

## Decisions

- **"Host" in the last-host rule means host or admin.** Every host-only route
  admits `@CampaignRoles('host', 'admin')`, and `grant-admin` turns an owner's
  own row into `admin`; counting `host` alone would refuse to remove the only
  `host` in a campaign still run by its admin owner.
- **The route lives in the session module** (`MembersController` in
  `session.controller.ts`). It needs the gateway to evict, and
  `CampaignsModule` cannot import `SessionModule` without a cycle
  (`SessionModule` already imports it). `CampaignsService` is exported for it.
- **Eviction uses a new per-campaign-member room**, `campaign:<id>:u:<userId>`,
  joined on connect. The issue suggested the per-session user room; a campaign
  has many sessions, so that would need a session lookup per removal. One room
  addressed by `server.in(...).disconnectSockets(true)` also stays correct under
  the Phase 3 Redis adapter.
- **The handshake race is closed by a re-check after join.** `handleConnection`
  re-reads the membership after joining the rooms and disconnects on
  none (fails closed on a DB error). Either the removal commits before the
  re-check (re-check sees it) or after the join (`evict` finds the socket).
- **Refusals are 409 with `code` + `message`**, the same shape as
  `CHARACTER_HAS_OPEN_ACTION`.
- **A host may remove themselves** through this endpoint, subject to the owner
  and last-host rules. Nothing in the issue forbids it and the rules that make
  it safe are the same; a player-facing "leave campaign" stays out of scope.
- **Pending rolls are left alone.** The issue's rule is that removal changes
  membership and nothing else (characters stay, history stays). An open pending
  action that names the removed member's character stays open; if that
  character was the only one authorized, nobody can satisfy it (`requireOwned`
  refuses the host) and the session waits in `WAITING_FOR_ROLL` until the host
  ends it. This is the same inert-id outcome M4.7's threat model accepts for a
  deleted character, and there is still no cancel path for pending actions.
  Auto-cancelling would be a game-state mutation this issue does not ask for.
  Follow-up: a host cancel for pending actions.
- **Whispers**: past whispers stay in the log; the removed user can no longer
  connect, so replay never reaches them. The router roster cache is invalidated
  on removal, so they can no longer be `@`-mentioned or whispered to.
- **In-flight work is not unwound.** A command already being handled when the
  removal lands may still commit; a DM turn they triggered runs to completion.
  Both are resolutions that began while they were a member.
- **Confirmed, not assumed:** `nameOf()` in `apps/web/src/session/Chat.tsx`
  falls back to "Someone" for a sender not on the roster; `SheetPanel`'s `mine`
  is `ownerUserId === user.id`, false for everyone once the owner is gone.

## Plan

1. `CampaignsService.removeMember` — campaign row `FOR UPDATE`, owner and
   last-host refusals, idempotent delete, roster cache invalidation (AC-1, 4, 5).
2. `SessionGateway` — member room on connect, post-join re-check, `evict`
   (AC-2, AC-3).
3. `MembersController` — `DELETE`, `@CampaignRoles('host','admin')`,
   `ParseUUIDPipe`, evict after commit (AC-5, AC-6).
4. `apps/api/test/member-removal.e2e.test.ts` against live Postgres (AC-1–7).
5. Lobby `Members` list + `api.removeMember` (AC-8).

## Traceability

| AC | Satisfied by | Proven by (`member-removal.e2e.test.ts`) |
|---|---|---|
| AC-1 | `CampaignsService.removeMember`; `CampaignMemberGuard` re-reads membership per request | "takes every campaign route away from the removed member" |
| AC-2 | `SessionGateway.evict`, called by `MembersController.remove` after commit | "disconnects a connected member and refuses their reconnect" (fails with `evict` removed) |
| AC-3 | post-join re-check in `handleConnection` | "drops a socket whose removal landed between its handshake and its join" (fails with the re-check removed) |
| AC-4 | owner / last-host checks under `FOR UPDATE` | "refuses to remove the owner, and the last host, naming why"; "lets a host remove another host while one remains" |
| AC-5 | early return on no membership; `ParseUUIDPipe` | "is idempotent: removing a non-member is 204" |
| AC-6 | `@CampaignRoles('host', 'admin')` | "is refused to a player, whatever the UI shows" |
| AC-7 | no character/event writes in `removeMember` | "leaves their characters and their history in place" |
| AC-8 | `Members` in `apps/web/src/Lobby.tsx` | typecheck/lint only; no web component test harness exists |

**Requirements:** FR-102 (remove members), FR-105 (control only your own
characters — a removed owner's character is controllable by no one), NFR-302
(authorization re-checked server-side).
