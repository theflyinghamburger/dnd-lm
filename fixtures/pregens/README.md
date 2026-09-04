# Pregenerated characters

Six level-3 SRD 5.1 characters, one per common role, for MVP play and tests
(M4.2, D-3 — there is no creation wizard in the MVP).

Each file is the body of `POST /api/campaigns/:campaignId/characters/import`
minus `campaignId`, which the route supplies:

```sh
curl -X POST "$API/api/campaigns/$CAMPAIGN/characters/import" \
  -H 'content-type: application/json' -b cookies.txt \
  --data @fixtures/pregens/aria-sunhollow.json
```

`sheet` holds **inputs only**. Modifiers, saves, passive Perception and
initiative are computed by `deriveSheet` on every read and are never stored — an
import that tries to supply one is rejected, not ignored.

SRD 5.1 content is used under CC-BY-4.0; see the notice in
`packages/contracts/src/srd.ts`.
