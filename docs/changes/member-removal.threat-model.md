# member-removal threat model — removing a campaign member (#79)

One new write path (deleting a `memberships` row) and one new gateway power
(server-side disconnect). The asset is campaign access: transcript, whispers,
characters, and the ability to post into a live session.

## 1. Who can remove whom

| Risk | Control |
|---|---|
| A player removes someone | `@CampaignRoles('host', 'admin')` behind `CampaignMemberGuard`, the same pair every host route uses. Asserted: a player gets 403 and the target stays a member. |
| A host of campaign A removes a member of campaign B | The guard resolves the caller's role from the route's `campaignId`, and the delete is scoped by the same `campaignId`. |
| Removing the owner, or leaving the campaign with no host | Refused 409 `OWNER_NOT_REMOVABLE` / `LAST_HOST`. The campaign row is locked `FOR UPDATE`, so two concurrent removals cannot both pass the last-host check. |
| Removing a platform admin demotes them platform-wide (`isPlatformAdmin` is "an admin row anywhere") | `admin` rows exist only on campaigns the admin owns (`grant-admin` promotes owned rows only; invites cannot grant `admin`), and the owner is never removable. |
| Probing for member ids | Non-members get 403 before the id is looked at; for a host, a non-member id and a removed one both answer 204. A malformed id is 400 (`ParseUUIDPipe`), not a Postgres cast error. |

## 2. Access after removal

| Risk | Control |
|---|---|
| HTTP access continues | `CampaignMemberGuard` re-reads membership on every request (M1.3); nothing is cached in the cookie. Asserted across five routes. |
| A connected socket keeps working (the handshake is the only identity check) | `evict` disconnects every socket in `campaign:<id>:u:<userId>`, after the delete commits. Asserted end to end, and the test fails with `evict` removed. |
| Reconnect | The handshake's `roleFor` finds no row: `NOT_A_MEMBER`. Asserted. |
| Race: removal commits between the handshake's read and the room join | `handleConnection` re-reads membership after joining, failing closed. Asserted by forcing the second read to miss; fails with the re-check removed. |
| Being whispered to or @-mentioned after removal | The router roster cache is invalidated on removal. |
| Replay of old whispers | Needs a socket, which the handshake refuses. |
| Acting as their character | `requireOwned` compares `owner_user_id` to the caller; the removed owner cannot reach any route, and a host is not the owner. Asserted (host HP write is 403). |

## Residuals, accepted

- **In-flight commands.** A command already inside `onCommand` when the removal
  lands can still commit. It started while they were a member; the window is one
  request. Likewise, a socket whose removal committed between its handshake read
  and its room join can send commands during the one-query window before the
  post-join re-check disconnects it (Nest binds message handlers without
  waiting for `handleConnection`). Closing that would need a membership read on
  every frame, which the chat latency budget (NFR-101) is why the gateway does
  not do.
- **Multi-instance.** `disconnectSockets` on a room is adapter-wide, so Phase 3's
  Redis adapter keeps eviction correct. The roster cache is per-process (existing
  `ponytail:` note in `SessionContextService`), so a second instance could route
  a whisper to a removed member until its own invalidation; that member has no
  socket to receive it on.
- **Stranded pending roll.** If the removed member's character was the only one
  authorized on an open pending action, it cannot be satisfied and the session
  waits until the host ends it. Inert, not corrupting; a host cancel is a
  follow-up.
