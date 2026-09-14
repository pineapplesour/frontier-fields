import {
  FOREST_CHANCE,
  WHEAT_CHANCE,
  WHEAT_MIN_FERTILITY,
  equal,
} from "../shared/rules.js";

// Deterministic per-tile roll derived from the map seed only.  Feature
// placement must never consume the game's shared random stream, so seeded
// worlds and replayed tests keep their existing unit/terrain outcomes.
export function featureRoll(seed, q, r) {
  let h = (Number(seed) >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (q + 0x7f4a7c15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (r + 0x165667b1), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function rollFeature(seed, tile) {
  if (!tile || tile.terrain === "mountain") return null;
  const v = featureRoll(seed, tile.q, tile.r);
  if (v < FOREST_CHANCE) return "forest";
  if (
    tile.terrain === "plains" &&
    (tile.fertility ?? 0) >= WHEAT_MIN_FERTILITY &&
    v < FOREST_CHANCE + WHEAT_CHANCE
  )
    return "wheat";
  return null;
}

// A tile can carry a feature only while it is plain land: no city centre,
// camp, resource deposit, farm, developed facility, ruin or structure.
export function featureEligible(g, tile) {
  return (
    !!tile &&
    ["plains", "hills"].includes(tile.terrain) &&
    !tile.resource &&
    !tile.farm &&
    !tile.developed &&
    !tile.ruin &&
    !tile.camp &&
    !(tile.fort?.hp > 0) &&
    !tile.encampment &&
    !(g.cities ?? []).some((c) => equal(c, tile))
  );
}

// Fresh worlds: every eligible tile rolls once.  Called after cities, start
// staging tiles and belts are normalized, so features never land on them.
export function seedTileFeatures(g) {
  for (const t of g.tiles)
    t.feature = featureEligible(g, t) ? rollFeature(g.seed, t) : null;
}

// Old saves (pre-feature maps) carry no `feature` key.  Only unowned,
// unimproved plains/hills receive a lazily rolled feature; anything a player
// already owns or improved stays exactly as it was.  Idempotent.
export function ensureTileFeatures(g) {
  let migrated = 0;
  for (const t of g.tiles ?? []) {
    if (t.feature !== undefined) continue;
    t.feature =
      t.owner == null && featureEligible(g, t) ? rollFeature(g.seed ?? 0, t) : null;
    migrated++;
  }
  return migrated;
}
