import {
  distance,
  equal,
  key,
} from "../shared/rules.js";
import {
  ENCAMPMENT_DEFENSE,
  ENCAMPMENT_HP,
  ENCAMPMENT_WALL_HP,
  STRUCTURE_KINDS,
  structureAt,
  structureHp,
  structureKind,
  structureMaxHp,
  structureObservation,
  structureShieldsGarrison,
  structureWallHp,
  structureWallMaxHp,
} from "../shared/structures.js";

export const WALL_REPAIR_QUIET_TURNS = 5;
export const ENCAMPMENT_PRODUCTION = Object.freeze({
  type: STRUCTURE_KINDS.ENCAMPMENT,
  name: "주둔지",
  cost: 50,
  resources: Object.freeze({ iron: 2 }),
  placement: "offCenter",
  requiresTarget: true,
  hp: ENCAMPMENT_HP,
  wallHp: ENCAMPMENT_WALL_HP,
  wallMaxHp: ENCAMPMENT_WALL_HP,
  defense: ENCAMPMENT_DEFENSE,
  description: "도시 생산으로 도심 밖에 짓는 성벽 주둔지",
});

export class StructureError extends Error {
  constructor(message, code = "invalidStructure") {
    super(message);
    this.name = "StructureError";
    this.code = code;
  }
}

const finite = (value, fallback = null) =>
  Number.isFinite(value) ? value : fallback;
const point = (value) =>
  value && Number.isInteger(value.q) && Number.isInteger(value.r)
    ? { q: value.q, r: value.r }
    : null;
const tileAt = (view, target) =>
  (view?.tiles ?? []).find((tile) => equal(tile, target)) ?? null;
const cityAt = (view, cityId) =>
  (view?.cities ?? []).find((city) => city.id === cityId) ?? null;

export function structureProductionDefinition(type, context = {}) {
  if (type === STRUCTURE_KINDS.ENCAMPMENT || type === "encampment")
    return { ...ENCAMPMENT_PRODUCTION, resources: { ...ENCAMPMENT_PRODUCTION.resources } };
  if (type === "wallRepair") {
    const structure = context.structure ?? context;
    const maximum = structureWallMaxHp(structure);
    const current = structureWallHp(structure);
    if (!maximum || current >= maximum) return null;
    return {
      type: "wallRepair",
      name: "주둔지 성벽 수리",
      cost: Math.max(1, maximum - current),
      resources: {},
      placement: "existingStructure",
      requiresTarget: true,
      description: "공격이 멈춘 뒤 생산력으로 주둔지 성벽을 수리",
    };
  }
  return null;
}

// Names used by the engine integration are intentionally aliases, so a
// client can depend on one stable hook while the production dispatcher uses
// its preferred terminology.
export const militaryProductionDefinition = structureProductionDefinition;
export const productionDefinition = structureProductionDefinition;

export function normalizeStructure(structure, kind = structureKind(structure)) {
  if (!structure || typeof structure !== "object")
    throw new StructureError("구조물 상태가 필요해요.", "missingStructure");
  const resolved = kind ?? "encampment";
  structure.kind = resolved;
  structure.type = resolved;
  structure.maxHp = structureMaxHp(structure, resolved);
  structure.hp = structureHp(structure);
  if (resolved === "encampment") {
    structure.wallMaxHp =
      finite(structure.wallMaxHp ?? structure.wallsMaxHp, ENCAMPMENT_WALL_HP);
    structure.wallsMaxHp = structure.wallMaxHp;
    structure.wallHp = structureWallHp(structure);
    structure.wallsHp = structure.wallHp;
  } else {
    structure.wallMaxHp = 0;
    structure.wallsMaxHp = 0;
    structure.wallHp = 0;
    structure.wallsHp = 0;
  }
  structure.owner ??= null;
  structure.captured = structure.captured === true;
  structure.status ??= structure.captured
    ? "captured"
    : structure.hp > 0
      ? "active"
      : "ruined";
  structure.lastIncomingAttackTurn ??= null;
  structure.wallRepairStartedTurn ??= null;
  structure.wallRepairStartHp ??= null;
  structure.wallRepairProgress ??= 0;
  return structure;
}

const invalidPlacement = (message, code) => ({ message, code });

/**
 * Validate a city-production target. `cityId` is optional for callers that
 * already validated a city, but when supplied it enforces an owned, off-center
 * tile within the normal three-hex production footprint.
 */
export function encampmentIssue(
  view,
  owner,
  target,
  { cityId = null, radius = 3 } = {},
) {
  if (typeof owner !== "string")
    return "주둔지를 지을 문명이 필요해요.";
  const destination = point(target);
  if (!destination) return "주둔지 위치가 필요해요.";
  const tile = tileAt(view, destination);
  if (!tile) return "탐사된 주둔지 위치가 아니에요.";
  if (tile.explored === false) return "탐사한 타일에 주둔지를 지어 주세요.";
  if (tile.owner !== owner)
    return "아군 영토 밖에는 주둔지를 지을 수 없어요.";
  if (!["plains", "hills"].includes(tile.terrain))
    return "평지나 구릉지에 주둔지를 지어 주세요.";
  if (tile.farm || tile.developed)
    return "농지·시설이 있는 칸에는 주둔지를 지을 수 없어요.";
  if (tile.encampment || tile.fort || tile.bastion)
    return "이미 구조물이 있는 칸에는 주둔지를 지을 수 없어요.";
  if ((view.cities ?? []).some((city) => equal(city, destination)))
    return "도시 중심 타일 밖에 주둔지를 지어 주세요.";
  if (cityId != null) {
    const city = cityAt(view, cityId);
    if (!city || city.owner !== owner)
      return "아군 도시의 생산으로만 주둔지를 지을 수 있어요.";
    if (distance(city, destination) > radius)
      return "도시에서 너무 먼 타일에는 주둔지를 지을 수 없어요.";
  }
  return null;
}

export function encampmentCandidates(view, city, { radius = 3 } = {}) {
  if (!city || typeof city.owner !== "string") return [];
  // A tile beyond the radius always fails encampmentIssue (with `cityId`), so
  // skipping it first only avoids the per-tile lookups; the result set is the
  // same.  The lookup used to cost 400 x 400 tile scans per city.
  return (view?.tiles ?? [])
    .filter(
      (tile) =>
        (city.id == null || distance(city, tile) <= radius) &&
        !encampmentIssue(view, city.owner, tile, {
          cityId: city.id,
          radius,
        }),
    )
    .sort((a, b) => key(a).localeCompare(key(b)));
}

export function placeEncampment(
  game,
  owner,
  target,
  { cityId = null, builtTurn = null, radius = 3 } = {},
) {
  const issue = encampmentIssue(game, owner, target, { cityId, radius });
  if (issue)
    throw new StructureError(issue, "invalidEncampmentPlacement");
  const tile = tileAt(game, target);
  const structure = normalizeStructure({
    kind: "encampment",
    type: "encampment",
    owner,
    hp: ENCAMPMENT_HP,
    maxHp: ENCAMPMENT_HP,
    wallHp: ENCAMPMENT_WALL_HP,
    wallsHp: ENCAMPMENT_WALL_HP,
    wallMaxHp: ENCAMPMENT_WALL_HP,
    captured: false,
    status: "active",
    builtTurn: finite(builtTurn),
    cityId,
  }, "encampment");
  tile.encampment = structure;
  return structure;
}

export function captureStructure(
  structure,
  newOwner,
  { turn = null, preserveHealth = false } = {},
) {
  if (!structure || typeof newOwner !== "string")
    throw new StructureError("새 주인이 필요해요.", "missingOwner");
  normalizeStructure(structure);
  structure.owner = newOwner;
  structure.captured = true;
  structure.status = "captured";
  structure.capturedTurn = finite(turn);
  structure.lastIncomingAttackTurn = finite(turn);
  // A capture transfers the physical position, not a repaired building. The
  // engine normally calls this after the hostile structure has been reduced
  // to zero; preserveHealth is an explicit migration escape hatch for a
  // legacy save that records a live building being transferred.
  if (!preserveHealth) {
    structure.hp = 0;
    structure.wallHp = 0;
    structure.wallsHp = 0;
  }
  structure.wallRepairStartedTurn = null;
  structure.wallRepairStartHp = null;
  structure.wallRepairProgress = 0;
  return structure;
}

export function ruinStructure(structure, { turn = null } = {}) {
  if (!structure) return null;
  normalizeStructure(structure);
  structure.owner = null;
  structure.captured = false;
  structure.status = "ruined";
  structure.ruinedTurn = finite(turn);
  structure.hp = 0;
  structure.wallHp = 0;
  structure.wallsHp = 0;
  structure.wallRepairStartedTurn = null;
  structure.wallRepairStartHp = null;
  structure.wallRepairProgress = 0;
  return structure;
}

/** Apply a single incoming hit, always consuming wall HP before body HP. */
export function recordStructureHit(
  structure,
  damage,
  { turn = null, wallOnly = false } = {},
) {
  normalizeStructure(structure);
  const incoming = Math.max(0, finite(damage, 0));
  const beforeHp = structure.hp;
  const beforeWallHp = structure.wallHp;
  const wasRepairing =
    structure.wallRepairStartedTurn != null ||
    structure.wallRepairStartHp != null ||
    structure.wallRepairProgress > 0;
  const wallDamage = Math.min(beforeWallHp, incoming);
  const bodyDamage = wallOnly
    ? 0
    : Math.min(beforeHp, Math.max(0, incoming - wallDamage));
  structure.wallHp = Math.max(0, beforeWallHp - wallDamage);
  structure.wallsHp = structure.wallHp;
  structure.hp = Math.max(0, beforeHp - bodyDamage);
  if (Number.isFinite(turn)) structure.lastIncomingAttackTurn = turn;
  structure.wallRepairStartedTurn = null;
  structure.wallRepairStartHp = null;
  structure.wallRepairProgress = 0;
  structure.status =
    structure.captured ? "captured" : structure.hp > 0 ? "active" : "ruined";
  return {
    damage: wallDamage + bodyDamage,
    wallDamage,
    bodyDamage,
    hp: structure.hp,
    wallHp: structure.wallHp,
    wallBroken: beforeWallHp > 0 && structure.wallHp === 0,
    buildingDestroyed: beforeHp > 0 && structure.hp === 0,
    interruptedRepair: wasRepairing,
  };
}

export function wallRepairEligibility(
  structure,
  { owner = null, turn = null, quietTurns = WALL_REPAIR_QUIET_TURNS } = {},
) {
  if (!structure)
    return invalidPlacement("수리할 주둔지 성벽이 없어요.", "missingStructure");
  normalizeStructure(structure);
  const maximum = structureWallMaxHp(structure);
  if (!maximum)
    return invalidPlacement("성벽이 없는 구조물이에요.", "noWalls");
  if (owner != null && structure.owner !== owner)
    return invalidPlacement("소유한 문명만 성벽을 수리할 수 있어요.", "notOwner");
  if (structureWallHp(structure) >= maximum)
    return invalidPlacement("성벽이 이미 온전해요.", "wallIntact");
  if (
    Number.isFinite(turn) &&
    Number.isFinite(structure.lastIncomingAttackTurn) &&
    turn - structure.lastIncomingAttackTurn < quietTurns
  )
    return invalidPlacement(
      `최근 공격 뒤 ${quietTurns}턴을 기다려야 해요.`,
      "underAttack",
    );
  return {
    ok: true,
    current: structureWallHp(structure),
    maximum,
    quietTurns,
  };
}

export function canRepairWalls(structure, options = {}) {
  return wallRepairEligibility(structure, options).ok === true;
}

export function beginWallRepair(structure, options = {}) {
  const eligibility = wallRepairEligibility(structure, options);
  if (!eligibility.ok) return { ...eligibility, started: false };
  const turn = finite(options.turn);
  structure.wallRepairStartedTurn = turn;
  structure.wallRepairStartHp = structureWallHp(structure);
  structure.wallRepairProgress = 0;
  return {
    ...eligibility,
    started: true,
    turn,
    startHp: structure.wallRepairStartHp,
  };
}

export const startWallRepair = beginWallRepair;

export function repairWalls(
  structure,
  amount,
  { owner = null, turn = null, quietTurns = WALL_REPAIR_QUIET_TURNS } = {},
) {
  normalizeStructure(structure);
  const eligibility = wallRepairEligibility(structure, {
    owner,
    turn,
    quietTurns,
  });
  if (!eligibility.ok) {
    const interrupted =
      structure.wallRepairStartedTurn != null ||
      structure.wallRepairStartHp != null ||
      structure.wallRepairProgress > 0;
    if (interrupted) {
      structure.wallRepairStartedTurn = null;
      structure.wallRepairStartHp = null;
      structure.wallRepairProgress = 0;
    }
    return {
      repaired: 0,
      wallHp: structure.wallHp,
      complete: false,
      interrupted,
      reason: eligibility.message,
      code: eligibility.code,
    };
  }
  if (structure.wallRepairStartedTurn == null) {
    const started = beginWallRepair(structure, { owner, turn, quietTurns });
    if (!started.started) return { repaired: 0, ...started };
  }
  const repair = Math.max(0, finite(amount, 0));
  const before = structure.wallHp;
  const after = Math.min(eligibility.maximum, before + repair);
  structure.wallHp = after;
  structure.wallsHp = after;
  structure.wallRepairProgress += after - before;
  const complete = after >= eligibility.maximum;
  if (complete) {
    structure.wallRepairStartedTurn = null;
    structure.wallRepairStartHp = null;
    structure.wallRepairProgress = 0;
  }
  return {
    repaired: after - before,
    wallHp: after,
    complete,
    interrupted: false,
    reason: null,
  };
}

export const wallRepairStep = repairWalls;

/** Repair the building body only; never heal an occupying unit implicitly. */
export function repairStructure(structure, amount, { owner = null } = {}) {
  normalizeStructure(structure);
  if (owner != null && structure.owner !== owner)
    return { repaired: 0, hp: structure.hp, reason: "notOwner" };
  const before = structure.hp;
  const after = Math.min(structureMaxHp(structure), before + Math.max(0, finite(amount, 0)));
  structure.hp = after;
  if (after > 0) structure.status = structure.captured ? "captured" : "active";
  return {
    repaired: after - before,
    hp: after,
    complete: after >= structureMaxHp(structure),
    captured: structure.captured === true,
  };
}

export function structureState(structure, tile = null) {
  return structureObservation(structure, tile);
}

export {
  structureAt,
  structureHp,
  structureKind,
  structureMaxHp,
  structureObservation,
  structureShieldsGarrison,
  structureWallHp,
  structureWallMaxHp,
};
