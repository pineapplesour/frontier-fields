import { TYPES } from "../shared/rules.js";

const isInternal = (unit) =>
  unit?.internal === true || TYPES[unit?.type]?.internal === true;

/**
 * Return the only formation tier the server can merge into.  Formations are
 * deliberately equal-tier: two base units make a brigade and two brigades
 * make a corps.  Legacy size-three formations remain displayable but cannot
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

export function formationDisplaySize(unit) {
  const size = Number(unit?.size);
  return Number.isInteger(size) && size > 0 ? size : 1;
}
