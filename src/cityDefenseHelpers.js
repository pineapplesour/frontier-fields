import { cityMaxHealth, wallMaxHealth } from "../shared/rules.js";

const finite = (...values) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
};

const hasAny = (value, names) =>
  !!value && names.some((name) => Object.prototype.hasOwnProperty.call(value, name));

/**
 * Keep the city body and its wall as separate public values.  The server
 * exposes `hp`/`maxHp` for the body and `wallHp`/`wallMaxHp` for the wall;
 * aliases are accepted for imported/older observations without deriving wall
 * damage from the body's current HP.
 */
export function cityDefenseSummary(city) {
  if (!city) return { available: false };
  const body = finite(city.bodyHp, city.cityHp, city.hp);
  const bodyMax =
    finite(city.bodyMaxHp, city.cityMaxHp, city.maxHp) ?? cityMaxHealth(city);
  const hasWallCurrent = hasAny(city, ["wallHp", "wallHP", "wallsHp", "wallsHP"]);
  const hasWallMaximum = hasAny(city, [
    "wallMaxHp",
    "wallMaxHP",
    "wallsMaxHp",
    "wallCapacity",
  ]);
  const wallMaximum =
    finite(city.wallMaxHp, city.wallMaxHP, city.wallsMaxHp, city.wallCapacity) ??
    wallMaxHealth(city);
  const wall = finite(city.wallHp, city.wallHP, city.wallsHp, city.wallsHP) ?? 0;
  const hasWall =
    hasWallCurrent || hasWallMaximum || Number(city.wallLevel) > 0 || wallMaximum > 0;
  return {
    available: body != null || hasWall,
    body,
    bodyMax,
    wall: Math.max(0, wall),
    wallMax: Math.max(0, wallMaximum),
    hasWall,
    wallLevel: Number.isFinite(Number(city.wallLevel)) ? Number(city.wallLevel) : 0,
  };
}

/**
 * Mirror the server's public wall-repair gate.  This is a display decision
 * only; `orders` remains authoritative and revalidates the five quiet turns.
 */
export function wallRepairEligibility(city, currentTurn) {
  const defense = cityDefenseSummary(city);
  if (!defense.available || !defense.hasWall || defense.wallMax <= 0)
    return { available: false, eligible: false, reason: "성벽 정보가 없어요." };
  const turn = Number(currentTurn);
  const lastAttack = Number(city.lastIncomingAttackTurn);
  const quietTurns =
    city.lastIncomingAttackTurn == null ||
    !Number.isFinite(turn) ||
    !Number.isFinite(lastAttack)
      ? null
      : Math.max(0, turn - lastAttack);
  if (defense.wall <= 0)
    return { ...defense, available: true, eligible: false, quietTurns, reason: "수리할 손상된 성벽이 없어요." };
  if (defense.wall >= defense.wallMax)
    return { ...defense, available: true, eligible: false, quietTurns, reason: "성벽이 이미 완전히 수리됐어요." };
  if (quietTurns != null && quietTurns < 5)
    return {
      ...defense,
      available: true,
      eligible: false,
      quietTurns,
      reason: `공격이 멈춘 뒤 5턴이 지나야 수리할 수 있어요 · 현재 ${quietTurns}턴`,
    };
  return {
    ...defense,
    available: true,
    eligible: true,
    quietTurns,
    reason: quietTurns == null ? "수리 가능" : `평화로운 턴 ${quietTurns}턴 · 수리 가능`,
  };
}

/**
 * The server sends an ammunition preview only for observations where ammo is
 * relevant. Shortfalls are informational: existing troops can attack even
 * when their per-turn niter upkeep is unpaid. Ignore legacy blocking flags.
 */
export function attackReadiness(unit) {
  const ammo = unit?.ammunition;
  if (!ammo || typeof ammo !== "object")
    return { available: false, ready: true, reason: null };
  const shortfall = finite(ammo.shortfall, unit.ammoShortfall) ?? 0;
  const ready = true;
  return {
    available: true,
    ready,
    shortfall: Math.max(0, shortfall),
    reason: shortfall > 0
      ? `초석 유지비 ${shortfall}개 부족 · 기존 부대는 공격 가능 · 공격 시 추가 소모 없음`
      : null,
    cost: finite(ammo.cost, unit.ammoCost) ?? 0,
    availableNiter: finite(ammo.available),
  };
}
