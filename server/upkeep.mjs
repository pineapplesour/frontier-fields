import {
  NITER_UPKEEP_PER_UNIT,
  RESOURCES,
  isCivilian,
} from "../shared/rules.js";
import { experimentCosts } from "./experiment.mjs";

/**
 * Turn-scoped ammunition accounting.  A musketeer/artillery base unit pays
 * one niter per size every own turn, whether or not it attacks.  The attack
 * validator may settle that same turn's amount early; the settlement helper
 * then observes the marker and does not charge twice.  This keeps the upkeep
 * rule visible instead of reducing it to an attack-only fee.
 */
export function ammunitionCost(unit) {
  if (!unit || isCivilian(unit) || !["musketeer", "artillery"].includes(unit.type))
    return 0;
  return NITER_UPKEEP_PER_UNIT * Math.max(1, Number(unit.size) || 1);
}

function paidForTurn(unit, cost, turn) {
  if (unit?.upkeepPaidTurn !== turn && unit?.ammoPaidTurn !== turn) return 0;
  // Old saves only have the boolean turn marker; that marker represented the
  // full old cost. New merges carry the exact paid amount here.
  return Math.min(
    cost,
    Number.isFinite(Number(unit.upkeepPaidAmount))
      ? Math.max(0, Number(unit.upkeepPaidAmount))
      : cost,
  );
}

function markPaid(unit, turn, amount, cost) {
  unit.upkeepPaidTurn = turn;
  unit.upkeepPaidAmount = Math.min(cost, Math.max(0, amount));
  unit.upkeepShortfallTurn = null;
  unit.ammoShortfall = 0;
  unit.ammoPaidTurn = unit.upkeepPaidAmount >= cost ? turn : null;
}

export function ensureAmmunition(g, unit) {
  if (!experimentCosts(g).attack)
    return { ready: true, cost: 0, charged: 0, shortfall: 0 };
  const cost = ammunitionCost(unit);
  if (!cost) return { ready: true, cost: 0, charged: 0, shortfall: 0 };
  const turn = g.turn;
  // A successful end-of-turn/own-turn settlement already covers the attack
  // ammunition for this turn. A formation merge may carry a partial amount,
  // so charge only the remainder rather than trusting a boolean marker.
  const paidAmount = g.experiment && !experimentCosts(g).upkeep ? 0 : paidForTurn(unit, cost, turn);
  const remaining = Math.max(0, cost - paidAmount);
  if (remaining <= 0)
    return {
      ready: true,
      cost,
      charged: 0,
      shortfall: 0,
      paidAmount,
      source: unit.upkeepPaidTurn === turn ? "turn-upkeep" : "attack-settlement",
    };
  g.stockpiles ??= {};
  g.stockpiles[unit.owner] ??= {};
  const available = Number(g.stockpiles?.[unit.owner]?.niter) || 0;
  if (available < remaining) {
    unit.ammoShortfall = remaining - available;
    unit.upkeepShortfallTurn = turn;
    return {
      ready: false,
      cost,
      charged: 0,
      shortfall: unit.ammoShortfall,
      paidAmount,
      source: "insufficient-niter",
    };
  }
  g.stockpiles[unit.owner].niter = available - remaining;
  markPaid(unit, turn, paidAmount + remaining, cost);
  return {
    ready: true,
    cost,
    charged: remaining,
    shortfall: 0,
    paidAmount: cost,
    source: "attack-settlement",
  };
}

export function ammunitionPreview(g, unit) {
  if (!experimentCosts(g).attack)
    return { cost: 0, paid: true, ready: true, available: 0, shortfall: 0, description: "실험 모드 · 공격 자원 소모 없음" };
  const cost = ammunitionCost(unit);
  const paidAmount = g.experiment && !experimentCosts(g).upkeep ? 0 : paidForTurn(unit, cost, g.turn);
  const remaining = Math.max(0, cost - paidAmount);
  const paid = remaining <= 0;
  const available = Number(g.stockpiles?.[unit?.owner]?.niter) || 0;
  return {
    cost,
    paid,
    ready: !cost || paid || available >= remaining,
    available,
    paidAmount,
    shortfall: paid ? 0 : Math.max(0, remaining - available),
    resource: RESOURCES.niter.name,
    description: cost
      ? `이번 자기 턴 초석 유지비 ${cost}개 · 부대 규모 ${unit.size ?? 1}`
      : "이 병종은 초석 유지비가 없어요.",
  };
}

/**
 * Settle niter upkeep for every surviving eligible unit owned by `player`.
 * `units` is an optional engine-provided subset for a phase-local call; the
 * default is the complete authoritative unit list.  Repeated calls for the
 * same turn are no-ops per unit, and a shortage never deducts a partial fee.
 */
export function settleAmmunitionUpkeep(
  g,
  player = null,
  { turn = g.turn, units = null } = {},
) {
  const eligible = (units ?? g.units ?? []).filter(
    (unit) =>
      (!player || unit.owner === player) &&
      Number(unit?.hp ?? 1) > 0 &&
      ammunitionCost(unit) > 0,
  );
  const result = {
    turn,
    player,
    charged: 0,
    shortfall: 0,
    settled: 0,
    skipped: 0,
    units: [],
  };
  if (!experimentCosts(g).upkeep) return result;
  g.stockpiles ??= {};
  for (const unit of eligible) {
    const cost = ammunitionCost(unit);
    const paidAmount = paidForTurn(unit, cost, turn);
    const remaining = Math.max(0, cost - paidAmount);
    // If an attack settled ammunition first, that payment also fulfils the
    // once-per-turn upkeep. A merged formation may still owe a remainder.
    if (remaining <= 0) {
      unit.upkeepPaidTurn = turn;
      unit.upkeepPaidAmount = cost;
      unit.ammoPaidTurn = turn;
      unit.upkeepShortfallTurn = null;
      result.skipped += 1;
      result.settled += 1;
      result.units.push({
        unitId: unit.id,
        cost,
        charged: 0,
        paidAmount: cost,
        paid: true,
        shortfall: 0,
      });
      continue;
    }
    g.stockpiles[unit.owner] ??= {};
    const available = Number(g.stockpiles[unit.owner].niter) || 0;
    if (available < remaining) {
      unit.upkeepShortfallTurn = turn;
      unit.ammoShortfall = remaining - available;
      result.shortfall += remaining - available;
      result.units.push({
        unitId: unit.id,
        cost,
        charged: 0,
        paidAmount,
        paid: false,
        shortfall: remaining - available,
      });
      continue;
    }
    g.stockpiles[unit.owner].niter = available - remaining;
    markPaid(unit, turn, paidAmount + remaining, cost);
    result.charged += remaining;
    result.settled += 1;
    result.units.push({
      unitId: unit.id,
      cost,
      charged: remaining,
      paidAmount: cost,
      paid: true,
      shortfall: 0,
    });
  }
  return result;
}

/**
 * Formation merge hook. Call after the target's new size is known. Exact
 * per-unit paid amounts avoid a paid size-1 unit making a newly size-2 unit
 * appear settled for free.
 */
export function mergeAmmunitionUpkeep(
  g,
  target,
  source,
  {
    turn = g.turn,
    // The engine normally calls this after it has assigned the merged size.
    // Callers may provide the pre-merge sizes explicitly; when omitted we
    // infer a valid 1+1/2+2 merge from the still-present source descriptor.
    targetPreviousSize = null,
    sourcePreviousSize = null,
  } = {},
) {
  const targetCost = ammunitionCost(target);
  const sourceCost = ammunitionCost(source);
  const targetSize = Math.max(1, Number(target?.size) || 1);
  const sourceSize = Math.max(1, Number(source?.size) || 1);
  const inferredTargetSize =
    targetPreviousSize == null
      ? targetSize > sourceSize
        ? Math.max(1, targetSize - sourceSize)
        : targetSize
      : Math.max(1, Number(targetPreviousSize) || 1);
  const inferredSourceSize =
    sourcePreviousSize == null
      ? sourceSize
      : Math.max(1, Number(sourcePreviousSize) || 1);
  const paidAtPreviousSize = (unit, cost, previousSize) => {
    const marker = unit?.upkeepPaidTurn === turn || unit?.ammoPaidTurn === turn;
    if (!marker) return 0;
    if (Number.isFinite(Number(unit.upkeepPaidAmount)))
      return Math.min(cost, Math.max(0, Number(unit.upkeepPaidAmount)));
    // Pre-ledger saves only had a boolean turn marker.  It represented the
    // full cost of that unit's old size, not the newly merged formation.
    return Math.min(
      cost,
      ammunitionCost({ ...unit, size: previousSize }),
    );
  };
  const paid = Math.min(
    targetCost,
    paidAtPreviousSize(target, targetCost, inferredTargetSize) +
      paidAtPreviousSize(source, sourceCost, inferredSourceSize),
  );
  target.upkeepPaidAmount = paid;
  target.upkeepPaidTurn = paid > 0 ? turn : null;
  target.ammoPaidTurn = paid >= targetCost ? turn : null;
  target.upkeepShortfallTurn = paid < targetCost ? turn : null;
  target.ammoShortfall = Math.max(0, targetCost - paid);
  return {
    unitId: target.id,
    cost: targetCost,
    paidAmount: paid,
    remaining: Math.max(0, targetCost - paid),
  };
}

// Short name for the engine hook requested by the work plan.
export const settleAmmunition = settleAmmunitionUpkeep;
export const settleTurnAmmunition = settleAmmunitionUpkeep;

export function upkeepPreview(g, player = null, turn = g.turn) {
  const units = (g.units ?? []).filter(
    (unit) => (!player || unit.owner === player) && ammunitionCost(unit) > 0,
  );
  const entries = units.map((unit) => {
    const cost = ammunitionCost(unit);
    const available = Number(g.stockpiles?.[unit.owner]?.niter) || 0;
    const paidAmount = paidForTurn(unit, cost, turn);
    const paid = paidAmount >= cost;
    return {
      unitId: unit.id,
      cost,
      available,
      paid,
      paidAmount,
      shortfall: paid ? 0 : Math.max(0, cost - paidAmount - available),
    };
  });
  return {
    turn,
    player,
    cost: entries.reduce((sum, entry) => sum + entry.cost, 0),
    entries,
  };
}
