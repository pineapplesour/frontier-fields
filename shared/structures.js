import { equal, isCivilian } from "./rules.js";

// Structures are deliberately small, serializable records. The engine may
// add bookkeeping fields to them, but combat and public observation only need
// the fields described here.
export const FORT_HP = 80;
export const FORT_DEFENSE = 0.25;
export const STRUCTURE_ATTACK_BONUS = 0.1;
export const ENCAMPMENT_HP = 80;
export const ENCAMPMENT_WALL_HP = 50;
export const ENCAMPMENT_DEFENSE = FORT_DEFENSE;

export const STRUCTURE_KINDS = Object.freeze({
  FORT: "fort",
  ENCAMPMENT: "encampment",
});

const finite = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;

/** Return the observed structure on a tile, preferring the newer encampment. */
export function structureAt(view, point) {
  const tile = (view?.tiles ?? []).find((candidate) => equal(candidate, point));
  return tile?.encampment ?? tile?.fort ?? tile?.bastion ?? null;
}

export function structureKind(structure, tile = null) {
  if (!structure) return null;
  if (structure.kind === STRUCTURE_KINDS.ENCAMPMENT) return "encampment";
  if (structure.kind === STRUCTURE_KINDS.FORT) return "fort";
  if (structure.type === STRUCTURE_KINDS.ENCAMPMENT) return "encampment";
  if (tile?.encampment === structure) return "encampment";
  return "fort";
}

export function structureMaxHp(structure, kind = structureKind(structure)) {
  if (!structure) return 0;
  const fallback = kind === "encampment" ? ENCAMPMENT_HP : FORT_HP;
  return Math.max(0, finite(structure.maxHp, fallback));
}

export function structureWallMaxHp(structure, kind = structureKind(structure)) {
  if (!structure || kind !== "encampment") return 0;
  return Math.max(
    0,
    finite(
      structure.wallMaxHp ?? structure.wallsMaxHp,
      ENCAMPMENT_WALL_HP,
    ),
  );
}

export function structureHp(structure) {
  return Math.max(0, Math.min(structureMaxHp(structure), finite(structure?.hp)));
}

export function structureWallHp(structure) {
  const maximum = structureWallMaxHp(structure);
  if (!maximum) return 0;
  return Math.max(
    0,
    Math.min(maximum, finite(structure?.wallHp ?? structure?.wallsHp)),
  );
}

/** A captured, physically damaged structure remains a usable firing position. */
export function structureUsablePosition(structure, owner = null) {
  if (!structure || owner == null || structure.owner !== owner) return false;
  return structureHp(structure) > 0 || structure.captured === true;
}

export function structureShieldsGarrison(structure) {
  return structureWallHp(structure) > 0;
}

/** Defensive bonus for a military unit on an owned fort/encampment. */
export function structureDefenseBonus(view, unit) {
  if (!unit || isCivilian(unit)) return 0;
  const structure = structureAt(view, unit);
  return structureUsablePosition(structure, unit.owner)
    ? (structureKind(structure) === "encampment"
        ? ENCAMPMENT_DEFENSE
        : FORT_DEFENSE)
    : 0;
}

export function structurePositionBonus(view, unit) {
  if (!unit || isCivilian(unit)) return 0;
  return structureUsablePosition(structureAt(view, unit), unit.owner)
    ? STRUCTURE_ATTACK_BONUS
    : 0;
}

// Compatibility export used by existing engine/tests for a fort's defensive
// bonus. It now also understands an encampment at the same coordinate.
export function fortBonus(view, unit) {
  return structureDefenseBonus(view, unit);
}

function canBuildOnEmptyTile(view, unit, { allowResource = true } = {}) {
  const tile = (view?.tiles ?? []).find((candidate) => equal(candidate, unit));
  if (!tile || tile.owner !== unit.owner || tile.terrain === "mountain")
    return false;
  if (!allowResource && tile.resource) return false;
  if (
    tile.farm ||
    tile.developed ||
    tile.encampment ||
    (tile.fort && (structureHp(tile.fort) > 0 || tile.fort.owner)) ||
    (view.cities ?? []).some((city) => equal(city, unit))
  )
    return false;
  return true;
}

export function fortIssue(view, unit) {
  if (unit?.type !== "builder" || finite(unit.charges) < 1)
    return "건설 횟수가 남은 건축자가 필요해요.";
  if (!canBuildOnEmptyTile(view, unit))
    return "도시·농지·시설이 없는 빈 칸에 지어 주세요.";
  return null;
}

/** A serializable public shape shared by the API and frontend helpers. */
export function structureObservation(structure, tile = null) {
  if (!structure) return null;
  const kind = structureKind(structure, tile);
  const hp = structureHp(structure);
  const maxHp = structureMaxHp(structure, kind);
  const wallMaxHp = structureWallMaxHp(structure, kind);
  const wallHp = structureWallHp(structure);
  const captured = structure.captured === true;
  const usablePosition =
    structure.owner != null && (hp > 0 || captured === true);
  return {
    kind,
    owner: structure.owner ?? null,
    hp,
    maxHp,
    wallHp,
    wallsHp: wallHp,
    wallMaxHp,
    wallsMaxHp: wallMaxHp,
    captured,
    status:
      structure.status ??
      (captured ? "captured" : hp > 0 ? "active" : "ruined"),
    usablePosition,
    repairRequired: hp < maxHp || (wallMaxHp > 0 && wallHp < wallMaxHp),
    repairAction: hp < maxHp ? "repairStructure" : "wallRepair",
  };
}
