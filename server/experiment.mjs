import { TYPES, maxHealth, unitMovement, unitAttacks } from "../shared/rules.js";

export const experimentCosts = (g) => ({
  upkeep: !g.experiment || g.experimentCosts?.upkeep === true,
  attack: !g.experiment || g.experimentCosts?.attack === true,
});

const limits = {
  movement: [0, 100], attacks: [0, 100], attack: [0, 1000],
  defense: [1, 1000], maxHealth: [1, 10000],
  isolationPenalty: [0, 90], riverPenalty: [0, 90],
  crossingPenalty: [0, 90], woundedPenalty: [0, 100], jointPenalty: [0, 90],
};

export function refreshExperimentUnit(g, unit) {
  if (!g.experiment) return;
  unit.experimentStats = {
    ...(g.experimentDefaults?.[unit.type] ?? {}),
    ...(unit.experimentBase ?? {}),
    ...(unit.experimentTemporary ?? {}),
  };
  unit.hp = Math.min(unit.hp, maxHealth(unit));
}

export function resetUnitActions(g, unit) {
  delete unit.experimentTemporary;
  refreshExperimentUnit(g, unit);
  unit.movesLeft = unitMovement(unit);
  unit.attacksSpent = 0;
  unit.attacksLeft = unitAttacks(unit);
  unit.attackUsed = unit.attacksLeft <= 0;
}

// Validation completes before mutation. The engine supplies the host/mode gate.
export function editExperiment(g, raw) {
  if (raw.action === "experimentCosts") {
    if (typeof raw.upkeep !== "boolean" || typeof raw.attack !== "boolean")
      throw new Error("유지비와 공격 소비 여부를 선택해 주세요.");
    g.experimentCosts = { upkeep: raw.upkeep, attack: raw.attack };
    return;
  }
  const unit = g.units.find((u) => u.id === raw.unitId && u.hp > 0);
  if (!unit) throw new Error("변경할 유닛을 선택해 주세요.");
  const scope = raw.scope;
  if (!["temporary", "unit", "type", "current"].includes(scope))
    throw new Error("이번 턴·선택 유닛·병종 전체 중 적용 범위를 선택해 주세요.");
  const range = scope === "current"
    ? { movesLeft: [0, 100], attacksLeft: [0, 100], hp: [1, maxHealth(unit)], isolation: [0, 10], riverTurns: [0, 20] }
    : limits;
  if (!raw.values || Array.isArray(raw.values) || typeof raw.values !== "object")
    throw new Error("변경할 수치가 필요해요.");
  const values = {};
  for (const [key, value] of Object.entries(raw.values)) {
    if (!Object.hasOwn(range, key) || !Number.isFinite(value) || !Number.isInteger(value) || value < range[key][0] || value > range[key][1])
      throw new Error(`수치 범위를 확인해 주세요: ${key}`);
    values[key] = value;
  }
  if (scope === "current") {
    Object.assign(unit, values);
    if (values.attacksLeft != null) unit.attackUsed = values.attacksLeft <= 0;
    return;
  }
  let affected = [unit];
  if (scope === "type") {
    g.experimentDefaults ??= {};
    g.experimentDefaults[unit.type] = { ...g.experimentDefaults[unit.type], ...values };
    affected = g.units.filter((u) => u.type === unit.type && u.hp > 0);
  } else {
    const field = scope === "temporary" ? "experimentTemporary" : "experimentBase";
    unit[field] = { ...unit[field], ...values };
  }
  for (const target of affected) {
    const before = { movement: unitMovement(target), attacks: unitAttacks(target), hp: maxHealth(target), currentHp: target.hp };
    refreshExperimentUnit(g, target);
    target.movesLeft = Math.max(0, target.movesLeft + unitMovement(target) - before.movement);
    const remaining = target.attacksLeft ?? (target.attackUsed ? 0 : before.attacks);
    target.attacksLeft = Math.max(0, remaining + unitAttacks(target) - before.attacks);
    target.attackUsed = target.attacksLeft <= 0;
    if (values.maxHealth != null) target.hp = Math.min(maxHealth(target), Math.max(1, before.currentHp + maxHealth(target) - before.hp));
  }
}
