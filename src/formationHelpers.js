import { TYPES, distance } from "../shared/rules.js";

const isInternal = (unit) =>
  unit?.internal === true || TYPES[unit?.type]?.internal === true;

/**
 * Return the only formation tier the server can merge into.  Formations are
 * deliberately equal-tier: two battalions make a brigade and two brigades
 * make a division.  Legacy size-three formations remain displayable but cannot
 * be silently folded into a new tier.
 */
export function mergedFormationSize(source, target) {
  const sourceSize = Number(source?.size);
  const targetSize = Number(target?.size);
  if (sourceSize === 1 && targetSize === 1) return 2;
  if (sourceSize === 2 && targetSize === 2) return 4;
  return null;
}

export function canMergeEqualTier(source, target) {
  return (
    !!source &&
    !!target &&
    source.id !== target.id &&
    !isInternal(source) &&
    !isInternal(target) &&
    source.type === target.type &&
    mergedFormationSize(source, target) != null
  );
}

export function canMergeFromTier(unit) {
  return !isInternal(unit) && mergedFormationSize(unit, unit) != null;
}

export const NO_MERGE_PARTNER_TIP = "인접한 같은 병종·같은 편제 부대가 없어요";

/**
 * Own military units adjacent to `unit` that the server would accept as an
 * equal-tier merge target (same type, same formation tier, alive).
 */
export function mergePartners(game, unit) {
  if (
    !game ||
    !unit ||
    unit.owner !== game.playerId ||
    TYPES[unit.type]?.civilian ||
    !canMergeFromTier(unit)
  )
    return [];
  return (game.units ?? []).filter(
    (candidate) =>
      candidate.owner === unit.owner &&
      (candidate.hp ?? 1) > 0 &&
      !TYPES[candidate.type]?.civilian &&
      distance(candidate, unit) <= 1 &&
      canMergeEqualTier(unit, candidate),
  );
}

export function formationDisplaySize(unit) {
  const size = Number(unit?.size);
  return Number.isInteger(size) && size > 0 ? size : 1;
}
