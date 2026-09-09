# Expansion-v1 contract

This document describes the staged future rules.  A game is opted in with
`rulesVersion: "expansion-v1"` (or `setup: "expansion"`).  Existing legacy
games keep their existing world and production rules when restored; the
runtime checkpoint path preserves them instead of silently rewriting a live
match.

## Lobby and starts

- A lobby has at most eight player seats (`p1` through `p8`).  `p1` is the
  human host.  Other seats are explicitly `human`, `agent`, or `npc`; agents
  are direct controllers and are never represented by a fake bot seat.
- Invite codes are generated per seat and are returned only to the host.  A
  code redeems exactly one seat.  Redeeming an NPC seat changes only its
  controller metadata; its cities, units, tiles, and history remain intact.
- Player seats begin with a settler, builder, spearman, musketeer, cavalry,
  and artillery on a separated 20x20 map.  There are no pre-founded player
  capitals.  A six-turn start grace keeps a settler-start match from ending
  before players have a legal chance to found a city.  Start coordinates stay
  server-private.

## Territory and growth

- Founding grants the city center plus its eligible first ring.  Each 0.5
  population-equivalent growth crossing grants exactly one adjacent eligible
  tile: the halfway food threshold grants one, and the next integer-population
  threshold grants the next one.
- A city setting may name the next adjacent candidate.  If it becomes
  invalid, deterministic fallback selection is used.  Expansion never revokes
  existing land, and future automatic growth or purchases stay contiguous and
  within radius three.  Mountains, foreign-owned tiles, and non-contiguous
  tiles are not candidates.

## Population and production

- Expansion production and instant purchase reserve 0.5 population from the
  producing city, leaving a minimum of one resident.  This is shown as
  `manpowerReserved`/`manpowerAvailable` in the private city observation.
- Produced units carry a source ledger (`manpowerSources`, `homeCityId`).
  Merging sums ledgers.  Disbanding returns the tracked ledger to a surviving
  city of the current controller; combat death and selling never refund it.
  Unit trades transfer the ledger's controller, while preserving source-city
  history.  Units loaded from older saves are grandfathered with zero cost.
- Builder production costs twice the normal builder production in
  expansion-v1.  `unitPurchasePrice` and `productionType` are the authoritative
  server price/resource definitions; instant purchase still checks gold,
  resources, manpower, capacity, and the civilian/military city slot.
- Observations include fractional food net, growth half-target, production
  ETA, starvation ETA, and authoritative unit prices so clients can explain
  affordability without inventing a second economy.

## Economy foundation

- The host may change `supplyMode` (`"off"` or `"on"`) only while a match is
  paused.  New and legacy saves default to OFF.  A mode change is atomic and
  converts the old ledger once; repeating the toggle cannot mint population or
  food.
- OFF has no physical city food stock: each city computes its own production
  minus its civilian population consumption, and positive surplus advances a
  growth-progress ledger.  Surplus cannot be transported or sold as stored
  food.  Higher population uses the existing `growthTarget` requirement;
  shortage pauses progress and sustained deficit can reduce population.
- ON separates `foodStock` from `growthProgress`.  A fed city advances one
  growth turn, while an unfed city pauses at its current progress and consumes
  its stock before bounded starvation.  Military units are charged a
  provisional 2x civilian food burden from their conserved manpower ledger;
  moved manpower is not counted as city civilians a second time.
- ON military recruitment is a city-local sequential mobilization queue, not
  an instant production queue.  Each item costs 0.5 population plus the
  authoritative unit resources only when it legally dispatches; pending items
  keep their citizens working and at most one item per city dispatches on that
  city's turn.  A blocked item remains visible with its reason and can be
  cancelled before dispatch.  Builder/settler production remains available.
  Disband returns only surviving recorded manpower; a mobilized unit's level
  resets, while combat death and sale never refund it.  A merged formation may
  pass `retainVeteranCount` to keep a selected surviving veteran slice (and
  its XP) while only the released slice's manpower returns.
- Citizens are whole-person assignments over existing farm, developed
  resource, trading-post (if present), and one city-worksite slots.  AUTO
  fills unclaimed slots, while host/player locks and priorities are validated
  against current slots.  A citizen boosts the facility's existing base yield;
  it does not create a facility or double-count a worker.
- Owned farms and developed resource facilities can be `scorch`ed, while
  `pillage` is restricted to visible facilities of a civilization at war.
  Either action consumes the unit's movement/action, heals that unit by up to
  50 HP, gives one finite corresponding reward, and leaves a repairable ruin.
  Scorch farm food is city stock only in ON (OFF is bounded growth
  contribution); a builder spends one charge to restore the original
  improvement.  Ruins give no passive income or repeat reward, and neutral or
  allied third-party facilities are not targets.
- Musketeers and artillery pay one niter per surviving base unit at their
  first legal attack each own turn.  A failed attack remains blocked with its
  shortfall; movement and defense remain legal, and a same-turn inventory
  top-up can satisfy the idempotent retry.
- An owned tile may be reassigned between its own cities only when both
  radius-three footprints remain connected to their centers.  Farms, resource
  income, per-city `resourceIncome`, citizen slots, and future expansion then
  follow the explicit `cityId`; old saves with no city ID use a deterministic
  read-only fallback.  Turning detailed supply OFF cancels un-dispatched
  mobilization entries atomically (they have spent no population or resources)
  and records that boundary; already-dispatched units remain existing units.

Physical trader, road, cargo, and supply-convoy simulation is deliberately
deferred to `docs/design/LOGISTICS-FOLLOWUP.md`.

## Public independence guarantees

- `guarantee` creates one directed public edge from the issuing civilization
  to a civilization or the city-state (`targetKind: "civilization"` or
  `"citystate"`).  Self-edges, barbarian targets, duplicates, and edges
  issued while already at war are rejected.  Issuing and withdrawing are
  unilateral own-turn diplomacy actions; the target's consent is not needed.
- A new `attacker -> protected` war creates one private pending call for each
  active edge whose protected side is the defender.  The call is not created
  when the protected side initiated the war, and the same edge/war pair can
  never create a second call.  The guarantor sees its own pending call and
  history; all players see the public edge and its withdrawal status.
- `acceptGuarantee` atomically adds the guarantor to the existing war against
  the attacker, updates public relations, and broadcasts an official
  defensive-entry announcement.  `rejectGuarantee` and expiry are recorded
  without adding a war pair.  A defensive entry never recursively fires other
  guarantees, so a chain cannot cascade across the world.
- Rule NPCs choose accept/reject from their scoped observation.  Before a war
  declaration or war-entry trade they include visible target strength, public
  guarantor edges, visible backer strength, public relations, and a bounded
  coalition-risk penalty; unseen units are never read from the server game.

## Rolling local-development restart

When `FIELDLINE_RUNTIME_CHECKPOINT_DIR` is configured, the host can request a
checkpoint or the process writes one during SIGINT/SIGTERM.  The checkpoint is
versioned, written through a private 0700 directory and atomic rename, and is
not served by the static app.  It retains game state, orders, turn/deadline
boundary, player sessions, and seat invites.  `FIELDLINE_RESUME_RUNTIME=1`
rehydrates matches into a paused reconnect boundary with the same tokens and
remaining time; clients using their session token poll and reconnect without
receiving hidden world state.
