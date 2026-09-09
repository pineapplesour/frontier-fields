# Logistics follow-up (deferred)

This economy-foundation milestone does not enable physical trader or supply
convoy simulation.  The pending contract is recorded here so a later change
does not accidentally turn a UI preview into a teleport or an unbounded
resource source.

## Pending scope

- A trading post is built with city production and permits one physical
  civilian trader.  Supply convoys are physical transport wrappers, not free
  population units.
- Food and resource cargo leave seller escrow and credit the recipient only
  on arrival.  Unit trades transfer ownership immediately but the unit moves
  physically to the buyer's selected city; disabling detailed supply never
  teleports traded units.
- Friendly city exchange and city-to-unit food use finite, observable convoy
  cargo.  Interception or capture keeps loot on the looting unit; death,
  delivery, cancellation and migration must conserve the ledger.
- A host may change detailed supply only while paused.  OFF keeps the current
  connectivity/encirclement rules and has no physical food stock; ON uses the
  city/unit stock and fed-turn growth contracts implemented in the foundation.
  Mode migration is one-time and atomic so repeated toggles cannot mint food,
  population or cargo.

The logistics implementation must add versioned save migration and isolated
tests for both modes before any client menu advertises physical routes.
