import {
  TYPES,
  unitStat,
  TERRAINS,
  level,
  maxHealth,
  distance,
  edgeKey,
  siegePenalty,
  cityMaxHealth,
  wallMaxHealth,
  equal,
  isCivilian,
  unitAttackValue,
  counterMultiplier,
  cityCounterAttack,
  neighbors,
  findRoute,
  movementCost,
  label,
  blocksUnit,
} from "./rules.js";
import {
  fortBonus,
  structureAt,
  structureKind,
  structurePositionBonus,
  structureShieldsGarrison,
  structureWallHp,
} from "./structures.js";


// ---------------------------------------------------------------------------
// Combat outcome rules (2026-09-15 user request).
//
// 1. No mutual annihilation: a unit-vs-unit exchange never leaves both sides
//    at 0 HP. The side with the higher remaining strength before clamping
//    (hp − damage taken, i.e. the side that was overkilled less) survives
//    with MIN_SURVIVOR_HP. A tie goes to the attacker in melee. Ranged attacks
//    (bombard, musket range 2) receive no return fire in this engine, so the
//    tie rule only ever applies to a melee exchange.
// 2. Experience: +1 for every unit taking part in a combat, +3 for
//    destroying an enemy unit, +5 instead when the fight was clearly
//    unfavorable for the destroyer.
// 3. "Unfavorable" means at least one of: the enemy's effective strength at
//    resolution was ≥ UNDERDOG_STRENGTH_RATIO × ours, the enemy had a
//    counter-type advantage against us, or the enemy formation was larger.
// ---------------------------------------------------------------------------
export const MIN_SURVIVOR_HP = 1;

// Counter-type (상성) balance. An attacker with the type advantage deals
// COUNTER_ADVANTAGE_MULTIPLIER × normal damage; an attacker striking into a
// type that counters it deals COUNTER_DISADVANTAGE_MULTIPLIER × normal damage.
// The host balance setting `counterMultiplier` still scales melee return fire
// on top of these. Veteran matchup mastery (up to +12%) stacks on the
// advantage only.
// Legacy multiplier view of the Civ6 anti-cavalry bonus (+10 CS ≈ e^(10/25) ≈ 1.49×).
export const COUNTER_ADVANTAGE_MULTIPLIER = Math.exp(10 / 25);
export const COUNTER_DISADVANTAGE_MULTIPLIER = Math.exp(-10 / 25);

// Attack and defense strength scale linearly with remaining HP and no floor:
// 50% HP → −50%, 10% HP → −90%. `woundedPenalty` (experiment stat) is the
// penalty at 0 HP in percent; the default of 100 gives factor = hp / maxHp.
// Superseded by the Civ6 wounded rule (−10 CS at 0 HP); kept as a ratio helper.
export const woundedFactor = (u) =>
  Math.max(0, Math.min(1, (u?.hp ?? 0) / maxHealth(u)));
export const COMBAT_XP_PARTICIPATION = 1;
export const COMBAT_XP_KILL = 3;
export const COMBAT_XP_UNDERDOG_KILL = 5;
// Additive CS scale: an enemy 10 CS stronger deals ≈1.5× (e^(10/25)) damage.
export const UNDERDOG_STRENGTH_GAP = 10;
export const UNDERDOG_STRENGTH_RATIO = Math.exp(UNDERDOG_STRENGTH_GAP / 25);

/** Formation tiers: 1 unit = 대대, 2 = 여단, 4 = 사단. Size 3 is a legacy formation. */
export const FORMATION_TIERS = { 1: "battalion", 2: "brigade", 4: "division" };
export const FORMATION_TIER_NAMES = {
  battalion: "대대",
  brigade: "여단",
  division: "사단",
  legacy: "기존 편성",
};
export const formationTier = (size) => FORMATION_TIERS[size] ?? "legacy";
export const formationTierName = (size) => FORMATION_TIER_NAMES[formationTier(size)];

/**
 * Resolve a would-be mutual death. `attackerLoss`/`defenderLoss` are the raw
 * damages already computed for the exchange. Returns the clamped losses; the
 * survivor keeps at least MIN_SURVIVOR_HP.
 */
export function preventMutualDeath({ attackerHp, attackerLoss, defenderHp, defenderLoss }) {
  if (attackerLoss < attackerHp || defenderLoss < defenderHp)
    return { attackerLoss, defenderLoss, survivor: null };
  const attackerRemaining = attackerHp - attackerLoss;
  const defenderRemaining = defenderHp - defenderLoss;
  // Higher remaining strength survives; a tie favours the attacker.
  const survivor = attackerRemaining >= defenderRemaining ? "attacker" : "defender";
  return survivor === "attacker"
    ? { attackerLoss: Math.max(0, attackerHp - MIN_SURVIVOR_HP), defenderLoss, survivor }
    : { attackerLoss, defenderLoss: Math.max(0, defenderHp - MIN_SURVIVOR_HP), survivor };
}

/**
 * Whether destroying `enemy` counts as an underdog kill for `us`, judged from
 * the state at resolution (before damage is applied). `usAttacking` selects
 * which side uses attack vs. defense strength.
 */
export function unfavorableFight(view, us, enemy, usAttacking = true) {
  if (!us || !enemy) return false;
  const ours = combatStrength(us, !usAttacking, view, enemy);
  const theirs = combatStrength(enemy, usAttacking, view, us);
  return (
    theirs - ours >= UNDERDOG_STRENGTH_GAP ||
    combatMatchup(enemy, us) > 1 ||
    (Number(enemy.size) || 1) > (Number(us.size) || 1)
  );
}

export const killXp = (unfavorable) =>
  unfavorable ? COMBAT_XP_UNDERDOG_KILL : COMBAT_XP_KILL;


// ---------------------------------------------------------------------------
// Civilization VI combat model (user decision 2026-09-15: "문명6 시스템 그대로").
// Sources: civilization.fandom.com/wiki/Combat_(Civ6), City_combat_(Civ6),
// Corps_(Civ6), Walls_(Civ6); forums.civfanatics.com "Hans Lemurson figures
// out the Combat Formula".
//   damage = 30 · e^((attackerCS − defenderCS) / 25) · U(0.75, 1.25)
//   melee: both sides roll the same formula against each other (attacker's
//   CS vs defender's CS and the reverse); ranged/bombard: only the attacker
//   deals damage. Modifiers are additive combat strength (CS).
// ---------------------------------------------------------------------------
export const CIV6 = Object.freeze({
  BASE_DAMAGE: 30,
  EXP_DIVISOR: 25,
  ROLL_MIN: 0.75,
  ROLL_MAX: 1.25,
  WOUND_PENALTY_MAX: 10, // linear, −10 CS at 0 HP
  FORTIFY_ONE_TURN: 3,
  FORTIFY_TWO_TURNS: 6,
  HILLS_DEFENSE: 3,
  FORT_DEFENSE: 4,
  RIVER_ATTACK: -5,
  RECENT_CROSSING: -3, // this game's "도하 후" state, mapped onto the CS scale
  ISOLATION_MAX: -10, // supply cut-off, scaled from the game's siege penalty
  FLANK_PER_UNIT: 2,
  SUPPORT_PER_UNIT: 2,
  ANTI_CAVALRY_VS_CAVALRY: 10, // spearman vs cavalry, attacking or defending
  MELEE_VS_ANTI_CAVALRY: 5, // cavalry vs spearman
  BOMBARD_VS_UNITS: -17, // artillery attacking a unit
  VETERAN_PER_LEVEL: 1, // this game's XP levels, +1 CS per level above 1
  CORPS_BONUS: 10, // 여단 (2 units)
  ARMY_BONUS: 17, // 사단 (4 units; legacy 3-unit formations too)
  // 2026-09-18 user request: "성벽이 너무 약한듯 문명처럼 좀더 강하게".
  // Wall HP and combat strength per level are doubled / raised so a walled city
  // cannot be cracked in one or two hits, matching Civilization's feel where
  // walls must be reduced before the city body is exposed.
  WALL_HP_PER_LEVEL: 100,
  WALL_CS_PER_LEVEL: 5,
  MELEE_VS_WALLS: 0.15,
  RANGED_VS_WALLS: 0.5,
  BOMBARD_VS_WALLS: 1,
  RANGED_VS_CITY_HP: 0.4,
  CITY_HEAL_PER_TURN: 20,
});
export const COMBAT_ROLL_MIN = CIV6.ROLL_MIN;
export const COMBAT_ROLL_MAX = CIV6.ROLL_MAX;

/** Deterministic roll range; the engine draws inside it from the seeded RNG. */
export function combatRollRange() {
  return [CIV6.ROLL_MIN, CIV6.ROLL_MAX];
}
export const rollFromRandom = (random) =>
  CIV6.ROLL_MIN + Math.max(0, Math.min(1, random)) * (CIV6.ROLL_MAX - CIV6.ROLL_MIN);

/** Civ6 damage for one side of a combat. */
export function civDamage(attackerStrength, defenderStrength, roll = 1) {
  return Math.max(
    1,
    Math.round(
      CIV6.BASE_DAMAGE *
        Math.exp((attackerStrength - defenderStrength) / CIV6.EXP_DIVISOR) *
        roll,
    ),
  );
}

export function formationBonus(u) {
  const size = Number(u?.size) || 1;
  return size >= 3 ? CIV6.ARMY_BONUS : size === 2 ? CIV6.CORPS_BONUS : 0;
}
export function woundedPenalty(u) {
  const ratio = Math.max(0, Math.min(1, (u?.hp ?? 0) / maxHealth(u)));
  return -CIV6.WOUND_PENALTY_MAX * (1 - ratio);
}
export const veteranBonus = (u) =>
  Math.max(0, level(u?.xp ?? 0) - 1) * CIV6.VETERAN_PER_LEVEL;
export const isRangedType = (u) => (TYPES[u?.type]?.range ?? 1) > 1;

const tileAt = (view, p) =>
  (view?.tiles ?? []).find((t) => equal(t, p));
const militaryUnit = (u) => u && u.hp > 0 && !isCivilian(u) && TYPES[u.type]?.attack;

/** Number of the attacker's other military units adjacent to the target. */
export function flankingCount(view, attacker, target) {
  if (!attacker || !target) return 0;
  const seen = new Set();
  for (const u of view?.units ?? [])
    if (militaryUnit(u) && u.owner === attacker.owner && u.id !== attacker.id &&
        distance(u, target) === 1 && !equal(u, attacker)) seen.add(`${u.q},${u.r}`);
  return seen.size;
}
/** Number of the defender's other military units adjacent to it. */
export function supportCount(view, defender) {
  if (!defender) return 0;
  const seen = new Set();
  for (const u of view?.units ?? [])
    if (militaryUnit(u) && u.owner === defender.owner && u.id !== defender.id &&
        distance(u, defender) === 1) seen.add(`${u.q},${u.r}`);
  return seen.size;
}

function typeBonus(u, other) {
  if (!u || !other || !other.type) return 0;
  if (u.type === "spearman" && other.type === "cavalry") return CIV6.ANTI_CAVALRY_VS_CAVALRY;
  if (u.type === "cavalry" && other.type === "spearman") return CIV6.MELEE_VS_ANTI_CAVALRY;
  return 0;
}

/**
 * Additive combat-strength breakdown of one side. `defending` selects the
 * defense stat and defensive modifiers; `target` is the other side (a unit or
 * a city) and may be null for a context-free display value.
 */
export function strengthBreakdown(u, defending, view = {}, target = null) {
  const safeView = { ...view, tiles: view.tiles ?? [] };
  const terms = [];
  const add = (label, value) => { if (value) terms.push({ label, value: Math.round(value * 10) / 10 }); };
  // Civ6 semantics: a melee unit has one combat strength used both ways; a
  // ranged unit fires with its ranged strength (attack) and defends with its
  // weaker melee strength (defense).
  const base = defending && isRangedType(u)
    ? unitStat(u, "defense", TYPES[u.type]?.defense ?? 0)
    : unitStat(u, "attack", unitAttackValue(safeView, u.type));
  add(formationTierName(u.size) + " 편제", formationBonus(u));
  add("베테랑", veteranBonus(u));
  add("부상", woundedPenalty(u));
  if (u.isolation)
    add("보급 단절", Math.max(CIV6.ISOLATION_MAX, -Math.round(siegePenalty(u.isolation) * 20)));
  if (u.riverTurns > 0) add("도하 직후", CIV6.RECENT_CROSSING);
  const tile = tileAt(safeView, u);
  const targetIsUnit = !!target?.type;
  if (defending) {
    if (tile?.terrain === "hills") add("구릉지 방어", CIV6.HILLS_DEFENSE);
    if (u.fortified) add("방어 태세", CIV6.FORTIFY_TWO_TURNS);
    else if (u.fortifyPending) add("방어 준비", CIV6.FORTIFY_ONE_TURN);
    if (fortBonus(safeView, u) > 0)
      add(structureKind(structureAt(safeView, u)) === "encampment" ? "주둔지" : "요새", CIV6.FORT_DEFENSE);
    const support = supportCount(safeView, u);
    if (support) add(`지원 ${support}부대`, support * CIV6.SUPPORT_PER_UNIT);
    if (targetIsUnit) add("병종 상성", typeBonus(u, target));
  } else {
    if (target && u.type !== "artillery" && riverBetween(safeView, u, target)) add("강 건너 공격", CIV6.RIVER_ATTACK);
    if (target) {
      const flank = flankingCount(safeView, u, target);
      if (flank) add(`측면 ${flank}부대`, flank * CIV6.FLANK_PER_UNIT);
    }
    if (targetIsUnit) {
      add("병종 상성", typeBonus(u, target));
      if (u.type === "artillery") add("포병 대유닛", CIV6.BOMBARD_VS_UNITS);
    }
  }
  const total = base + terms.reduce((n, t) => n + t.value, 0);
  return { base, terms, total: Math.round(total * 10) / 10 };
}

/** Numeric combat strength (additive CS). */
export function combatStrength(u, defending, view = {}, target = null) {
  return strengthBreakdown(u, defending, view, target).total;
}

/** City combat strength: the better of its garrison and its own defenses. */
export function cityStrength(view, city, attacker = null) {
  if (!city) return 0;
  const own = cityCounterAttack(city, view) +
    (cityWallHp(city) > 0 ? (city.wallLevel ?? 0) * CIV6.WALL_CS_PER_LEVEL : 0);
  const garrison = (view?.units ?? [])
    .filter((u) => u.owner === city.owner && u.hp > 0 && militaryUnit(u) && equal(u, city))
    .map((u) => strengthBreakdown(u, true, view, attacker).total);
  return Math.round(Math.max(own, ...garrison) * 10) / 10;
}

/** Legacy hook kept for callers; Civ6 has no attacker position bonus. */
export function attackPositionBonus() {
  return { value: 0, reasons: [] };
}
export function jointAttackPenalty(view, defender, attacker) {
  const count = attacker ? flankingCount(view, attacker, defender) + 1 : 0;
  return { count, penalty: 0 };
}

/** Return the straight hex line on the flat map, including both endpoints. */
export function hexLine(a, b) {
  if (!a || !b) return [];
  const n = distance(a, b);
  if (!n) return [{ q: a.q, r: a.r }];
  const end = { q: b.q, r: b.r };
  const points = [{ q: a.q, r: a.r }];
  for (let i = 1; i <= n; i++) {
    const x = a.q + ((end.q - a.q) * i) / n,
      z = a.r + ((end.r - a.r) * i) / n,
      y = -x - z;
    let rx = Math.round(x),
      ry = Math.round(y),
      rz = Math.round(z);
    const dx = Math.abs(rx - x),
      dy = Math.abs(ry - y),
      dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    const point = { q: rx, r: rz };
    // Keep the supplied endpoint exact regardless of rounding.
    if (i === n) point.q = b.q, point.r = b.r;
    points.push(point);
  }
  return points;
}

/**
 * Interior hexes of the straight line between `a` and `b` (both endpoints
 * excluded). Each step yields the candidate hexes it passes through: one hex
 * normally, or both neighbours when the line runs exactly along the edge
 * between two hexes.
 */
export function hexLineCandidates(a, b) {
  if (!a || !b) return [];
  const n = distance(a, b);
  const steps = [];
  for (let i = 1; i < n; i++) {
    const x = a.q + ((b.q - a.q) * i) / n,
      z = a.r + ((b.r - a.r) * i) / n,
      y = -x - z;
    const fx = x - Math.floor(x), fy = y - Math.floor(y), fz = z - Math.floor(z);
    const tie = (f) => Math.abs(f - 0.5) < 1e-9;
    const rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const candidates = [];
    if (tie(fx) && tie(fz) && !tie(fy)) {
      candidates.push({ q: Math.floor(x), r: Math.ceil(z) }, { q: Math.ceil(x), r: Math.floor(z) });
    } else if (tie(fx) && tie(fy) && !tie(fz)) {
      candidates.push({ q: Math.floor(x), r: rz }, { q: Math.ceil(x), r: rz });
    } else if (tie(fy) && tie(fz) && !tie(fx)) {
      candidates.push({ q: rx, r: Math.floor(z) }, { q: rx, r: Math.ceil(z) });
    } else {
      const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
      let cq = rx, cr = rz;
      if (dx > dy && dx > dz) cq = -ry - rz;
      else if (dy > dz) { /* y adjusted; q,r unchanged */ }
      else cr = -rx - ry;
      candidates.push({ q: cq, r: cr });
    }
    steps.push(candidates);
  }
  return steps;
}

export const RANGED_MOUNTAIN_BLOCK_MESSAGE = "산에 가려 사격할 수 없어요.";

/**
 * A ranged shot (any distance ≥ 2) cannot pass over a mountain. A step whose
 * line runs exactly between two hexes is blocked only if BOTH are mountains.
 * Unknown/unexplored tiles never block; only observed mountains do.
 */
export function mountainBlocksLine(view, from, to) {
  if (!from || !to) return false;
  const tiles = view?.tiles ?? [];
  const mountain = (p) => tiles.find((t) => equal(t, p))?.terrain === "mountain";
  return hexLineCandidates(from, to).some(
    (candidates) => candidates.length > 0 && candidates.every(mountain),
  );
}

/** Null when the shot is clear; otherwise the player-facing reason. */
export function rangedTargetIssue(view, from, to) {
  return mountainBlocksLine(view, from, to) ? RANGED_MOUNTAIN_BLOCK_MESSAGE : null;
}

export function riverBetween(view, a, b) {
  const rivers = view?.rivers ?? [];
  const line = hexLine(a, b);
  for (let i = 1; i < line.length; i++)
    if (rivers.some((e) => edgeKey(e.a, e.b) === edgeKey(line[i - 1], line[i])))
      return true;
  return false;
}

/**
 * Musketeer line of sight uses only the supplied unit observation. A hidden
 * intervening unit therefore cannot be named or exposed to a player.
 */
export function hasLineOfSight(view, a, b) {
  const blockers = view?.units ?? [];
  return hexLine(a, b)
    .slice(1, -1)
    .every((point) => !blockers.some((u) => equal(u, point)));
}

/** Counter-type relation as a CS advantage (kept for the XP underdog rule). */
export function combatMatchup(a, b) {
  return a && b && typeBonus(a, b) > typeBonus(b, a) ? 1 + typeBonus(a, b) / 25 : 1;
}
export function matchupDisadvantage(a, b) {
  return combatMatchup(b, a) > 1 ? 1 - typeBonus(b, a) / 25 : 1;
}
export function effectiveCombatMatchup(a, b) {
  return combatMatchup(a, b);
}

export const ammunitionCost = (unit) =>
  unit && ["musketeer", "artillery"].includes(unit.type)
    ? Math.max(1, Number(unit.size) || 1)
    : 0;

/**
 * Read only public ammunition state. Observations normally carry the nested
 * `unit.ammunition` record; raw engine fixtures may expose stockpiles instead.
 * If neither is present, leave the preview usable for legacy non-supply
 * fixtures rather than inventing a hidden resource balance.
 */
export function ammunitionState(view, unit) {
  if (view.experiment && view.experimentCosts?.attack !== true)
    return { cost: 0, ready: true, available: Infinity, shortfall: 0, paid: true };
  const cost = ammunitionCost(unit);
  if (!cost) return { cost: 0, ready: true, available: Infinity, shortfall: 0 };
  const supplied = unit?.ammunition;
  if (supplied && typeof supplied === "object") {
    const available = Number.isFinite(supplied.available)
      ? supplied.available
      : null;
    const paid = supplied.paid === true;
    // Imported shortage flags describe upkeep; they never prohibit firing.
    const ready = true;
    return {
      cost,
      ready,
      available: available ?? (ready ? cost : 0),
      shortfall: Number.isFinite(supplied.shortfall)
        ? Math.max(0, supplied.shortfall)
        : ready
          ? 0
          : cost,
      paid,
    };
  }
  const ownerStock = view?.stockpiles?.[unit?.owner]?.niter;
  const observedStock = view?.economy?.resources?.niter;
  const available = Number.isFinite(ownerStock)
    ? ownerStock
    : Number.isFinite(observedStock)
      ? observedStock
      : null;
  if (available == null)
    return { cost, ready: true, available: Infinity, shortfall: 0 };
  const paid = unit?.upkeepPaidTurn === view?.turn || unit?.ammoPaidTurn === view?.turn;
  return {
    cost,
    ready: true,
    available,
    shortfall: paid ? 0 : Math.max(0, cost - available),
    paid,
  };
}

export function unitDamage(a, b, view, roll = 1) {
  return civDamage(
    strengthBreakdown(a, false, view, b).total,
    strengthBreakdown(b, true, view, a).total,
    roll,
  );
}
/** Damage the defender deals back in melee (before the host counterMultiplier). */
export function counterDamage(a, b, view, roll = 1) {
  return civDamage(
    strengthBreakdown(b, true, view, a).total,
    strengthBreakdown(a, false, view, b).total,
    roll,
  );
}

/**
 * One full unit-vs-unit exchange: the single source of truth for both the
 * engine and the hover forecast. Rolls default to the exact expected value.
 */
export function unitExchange(view, a, b, { attackRoll = 1, counterRoll = 1 } = {}) {
  const attacker = strengthBreakdown(a, false, view, b);
  const defender = strengthBreakdown(b, true, view, a);
  const melee = !isRangedType(a) && distance(a, b) === 1 && !!militaryUnit(b);
  const dealt = civDamage(attacker.total, defender.total, attackRoll);
  const received = melee
    ? Math.round(civDamage(defender.total, attacker.total, counterRoll) * counterMultiplier(view))
    : 0;
  return { attacker, defender, melee, dealt, received };
}

export function cityWallHp(c) {
  const maximum = wallMaxHealth(c);
  if (!maximum) return 0;
  if (Number.isFinite(c.wallHp)) return Math.max(0, Math.min(maximum, c.wallHp));
  // Legacy saves represented body+wall as one hp field. Interpret only the
  // amount above the new body maximum as wall HP during migration.
  return Math.max(
    0,
    Math.min(
      maximum,
      Number.isFinite(c.hp) && c.hp > cityMaxHealth(c)
        ? c.hp - cityMaxHealth(c)
        : Number.isFinite(c.hp) && c.hp === cityMaxHealth(c)
          ? maximum
          : 0,
    ),
  );
}

export const cityAttackKind = (a) =>
  a?.type === "artillery" ? "bombard" : isRangedType(a) ? "ranged" : "melee";

/**
 * One attack on a city (Civ6 walls model): while walls stand the hit lands on
 * the wall pool scaled by attack kind (melee 15%, ranged 50%, bombard 100%);
 * once walls are down the body takes it (ranged 50%). An adjacent melee
 * attacker takes the city's return blow with the same formula.
 */
export function cityExchange(view, a, c, { attackRoll = 1, counterRoll = 1 } = {}) {
  const attacker = strengthBreakdown(a, false, view, c);
  const defense = cityStrength(view, c, a);
  const raw = civDamage(attacker.total, defense, attackRoll);
  const kind = cityAttackKind(a);
  const wallHp = cityWallHp(c);
  const bodyHp = Math.max(0, Number(c.hp) || 0);
  const bodyMultiplier = kind === "ranged" ? CIV6.RANGED_VS_CITY_HP : 1;
  let wallDamage = 0, bodyDamage = 0;
  if (wallHp > 0) {
    const scaled = Math.max(1, Math.round(raw * (kind === "melee" ? CIV6.MELEE_VS_WALLS : kind === "ranged" ? CIV6.RANGED_VS_WALLS : CIV6.BOMBARD_VS_WALLS)));
    wallDamage = Math.min(wallHp, scaled);
    // Walls absorb first; only the part that breaks through a falling wall
    // reaches the body, at the body multiplier.
    bodyDamage = Math.min(bodyHp, Math.round((scaled - wallDamage) * bodyMultiplier));
  } else
    bodyDamage = Math.min(bodyHp, Math.max(1, Math.round(raw * bodyMultiplier)));
  const melee = kind === "melee" && distance(a, c) === 1 && bodyHp > 0;
  // A host may zero the city's own strength; with no garrison that city has no return blow.
  const received = melee && defense > 0 ? civDamage(defense, attacker.total, counterRoll) : 0;
  return { attacker, defense, kind, raw, wallDamage, bodyDamage, dealt: wallDamage + bodyDamage, received, melee };
}
export function cityDamage(a, c, view, roll = 1) {
  return cityExchange(view, a, c, { attackRoll: roll }).dealt;
}
export function cityDamageRange(a, c, view) {
  return [cityDamage(a, c, view, CIV6.ROLL_MIN), cityDamage(a, c, view, CIV6.ROLL_MAX)];
}
/** City ranged strike / return fire against a unit. */
export function cityStrikeDamage(view, city, unit, roll = 1) {
  const cs = cityStrength(view, city);
  return cs > 0 ? civDamage(cs, strengthBreakdown(unit, true, view, null).total, roll) : 0;
}

const outcome = (hp, bounds) => ({
  currentHp: hp,
  minDamage: bounds[0],
  maxDamage: bounds[1],
  possible: bounds[1] >= hp,
  guaranteed: bounds[0] >= hp,
  unlikely: bounds[1] < hp,
  status:
    bounds[0] >= hp ? "guaranteed" : bounds[1] >= hp ? "possible" : "unlikely",
});

/**
 * Describe whether a city-destroying attack also occupies the city.
 *
 * A city can be damaged from any legal range, but only an adjacent,
 * non-artillery military unit can occupy it as part of the same attack. The
 * attacker's movement points are intentionally absent from this calculation:
 * attacking consumes the remaining points, yet a unit with zero points may
 * still make the attack and enter on the lethal hit. Ranged/artillery hits
 * leave a destroyed city waiting for a later military entry.
 *
 * `damageBounds` is the public deterministic low/high damage interval already
 * calculated by combatPreview. No hidden HP, seed, or Monte Carlo estimate is
 * used here.
 */
export function cityCapturePreview(
  attacker,
  cityTarget,
  damageBounds = [0, 0],
  { legal = false, garrisonProtected = false } = {},
) {
  if (!attacker || !cityTarget) return null;
  const wallHp = cityWallHp(cityTarget);
  const currentHp = Math.max(0, Number(cityTarget.hp) || 0) + wallHp;
  const low = Math.max(0, Number(damageBounds[0]) || 0);
  const high = Math.max(low, Number(damageBounds[1]) || 0);
  const capturable = cityTarget.camp !== true;
  const canDestroy = currentHp > 0 && high >= currentHp;
  const guaranteedDestroy = currentHp > 0 && low >= currentHp;
  const adjacentNonArtillery =
    !isCivilian(attacker) &&
    ["spearman", "cavalry"].includes(attacker.type) &&
    distance(attacker, cityTarget) === 1;
  const canCaptureNow =
    capturable && !!legal && canDestroy && adjacentNonArtillery;
  const guaranteedCaptureNow =
    capturable && !!legal && guaranteedDestroy && adjacentNonArtillery;
  const requiresEntry = capturable && canDestroy && !adjacentNonArtillery;
  const blockedByAction = canDestroy && !legal;
  const status = !capturable
    ? "blocked"
    : blockedByAction
      ? "blocked"
      : canCaptureNow
        ? guaranteedCaptureNow
          ? "ready"
          : "possible"
        : requiresEntry
          ? "nextTurn"
          : "unlikely";
  return {
    // `canCapture`/`possible` mean a legal roll in the shown interval can
    // capture. `lethal` exposes the raw damage fact for a disabled action
    // (for example, an out-of-ammunition musketeer) without promising it can
    // currently be executed.
    canCapture: canCaptureNow,
    possible: canCaptureNow,
    guaranteed: guaranteedCaptureNow,
    capturable,
    lethal: canDestroy,
    lethalPossible: canDestroy,
    lethalGuaranteed: guaranteedDestroy,
    status,
    message: capturable ? null : "이 거점은 파괴되며 점령되지 않아요.",
    requiresEntry,
    nextTurn: requiresEntry,
    garrisonBlocked: !!garrisonProtected && !canDestroy,
    garrisonProtected: !!garrisonProtected,
    directEntry: adjacentNonArtillery,
    entry: {
      required: requiresEntry,
      nextTurn: requiresEntry,
      adjacent: distance(attacker, cityTarget) === 1,
      artillery: attacker.type === "artillery",
      garrisonBlocked: !!garrisonProtected && !canDestroy,
    },
    city: {
      hp: Math.max(0, Number(cityTarget.hp) || 0),
      wallHp,
      currentHp,
      damage: [low, high],
    },
  };
}

/**
 * Return fire from a standing city on an adjacent non-artillery attacker.
 * Deterministic bounds use the shared ±12% roll; the engine draws the actual
 * roll from the match's seeded random.
 */
export function cityCounterDamage(city, view, roll = 1, unit = null) {
  return unit
    ? cityStrikeDamage(view, city, unit, roll)
    : civDamage(cityStrength(view, city), 0, roll);
}
export function cityCounterRange(city, view, unit = null) {
  return [cityCounterDamage(city, view, CIV6.ROLL_MIN, unit), cityCounterDamage(city, view, CIV6.ROLL_MAX, unit)];
}
// A rule explanation based solely on a player's observation, never a hidden-
// state simulation. Numbers come from the same unitExchange / cityExchange the
// engine resolves with; only the roll differs (0.75 / 1.0 / 1.25 here).
export function combatPreview(view, a, b) {
  if (!a || !b || !TYPES[a.type]?.attack || b.owner === a.owner || b.ghost)
    return null;
  const directCity = !b.type,
    garrisonCity = directCity
      ? null
      : (view?.cities ?? []).find(
          (candidate) =>
            candidate.owner === b.owner &&
            candidate.hp > 0 &&
            equal(candidate, b),
        ),
    city = directCity || !!garrisonCity,
    cityTarget = directCity ? b : garrisonCity,
    range = distance(a, b),
    reasons = [],
    lineOfSight = a.type !== "musketeer" || hasLineOfSight(view, a, b),
    mountainBlocked = mountainBlocksLine(view, a, b),
    ammunition = ammunitionState(view, a),
    targetStructure = city ? null : structureAt(view, b),
    structureProtected =
      !!targetStructure &&
      targetStructure.owner === b.owner &&
      structureShieldsGarrison(targetStructure),
    cityProtected = !!garrisonCity,
    protectedTarget = structureProtected;
  const legal =
    range <= TYPES[a.type].range &&
    !a.attackUsed &&
    b.hostile !== false &&
    (!city || b.hp > 0) &&
    lineOfSight &&
    !mountainBlocked &&
    ammunition.ready &&
    !protectedTarget;
  if (range > TYPES[a.type].range) reasons.push("사거리 밖");
  if (mountainBlocked) reasons.push(RANGED_MOUNTAIN_BLOCK_MESSAGE);
  if (a.attackUsed) reasons.push("이번 턴 공격 사용");
  if (!lineOfSight) reasons.push("사격선이 막혀 있어요");
  if (!ammunition.ready)
    reasons.push(`초석 부족 · 이번 턴 ${ammunition.shortfall}개 필요`);
  if (structureProtected)
    reasons.push(
      `${structureKind(targetStructure) === "encampment" ? "주둔지" : "요새"} 성벽이 주둔 부대를 보호해요`,
    );
  if (cityProtected)
    reasons.push("도시 본체가 파괴될 때까지 주둔 부대가 보호돼요");
  if (b.hostile === false) reasons.push("선전포고 필요");
  if (directCity && b.hp <= 0) reasons.push("도시가 이미 파괴됨");

  const [low, high] = combatRollRange();
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  let exchange, exchangeLow, exchangeHigh, attackStrength, defenseStrength, attackerTerms, defenderTerms = [];
  if (city) {
    exchange = cityExchange(view, a, cityTarget);
    exchangeLow = cityExchange(view, a, cityTarget, { attackRoll: low, counterRoll: low });
    exchangeHigh = cityExchange(view, a, cityTarget, { attackRoll: high, counterRoll: high });
    attackStrength = exchange.attacker.total;
    defenseStrength = exchange.defense;
    attackerTerms = exchange.attacker.terms;
    for (const t of attackerTerms) reasons.push(`공격 ${t.label} ${sign(t.value)}`);
    reasons.push(`도시 전투력 ${defenseStrength}${cityWallHp(cityTarget) > 0 ? ` · 성벽 ${cityTarget.wallLevel ?? 0}레벨` : ""}`);
    if (cityWallHp(cityTarget) > 0)
      reasons.push(
        exchange.kind === "melee"
          ? "성벽이 서 있는 동안 근접 공격은 성벽에 15%만 피해"
          : exchange.kind === "ranged"
            ? "성벽이 서 있는 동안 사격은 성벽에 50% 피해"
            : "포격은 성벽에 100% 피해",
      );
    else if (exchange.kind === "ranged") reasons.push("성벽 파괴 · 사격은 도시 본체에 50% 피해");
    if (exchange.melee) reasons.push(`도시 반격 ${exchangeLow.received}~${exchangeHigh.received}`);
  } else {
    exchange = unitExchange(view, a, b);
    exchangeLow = unitExchange(view, a, b, { attackRoll: low, counterRoll: low });
    exchangeHigh = unitExchange(view, a, b, { attackRoll: high, counterRoll: high });
    attackStrength = exchange.attacker.total;
    defenseStrength = exchange.defender.total;
    attackerTerms = exchange.attacker.terms;
    defenderTerms = exchange.defender.terms;
    for (const t of attackerTerms) reasons.push(`공격 ${t.label} ${sign(t.value)}`);
    for (const t of defenderTerms) reasons.push(`방어 ${t.label} ${sign(t.value)}`);
    if (!exchange.melee) reasons.push(isRangedType(a) ? "원거리 공격 · 반격 없음" : "반격 없음");
  }
  const rawDealt = [exchangeLow.dealt, exchangeHigh.dealt];
  const targetHp = city ? cityTarget.hp + cityWallHp(cityTarget) : b.hp;
  const dealt = protectedTarget ? [0, 0] : rawDealt.map((n) => Math.min(targetHp, n));
  const rawReceived = [exchangeLow.received, exchangeHigh.received];
  const received = rawReceived.map((n) => Math.min(a.hp, n));
  const targetOutcome = outcome(targetHp, protectedTarget ? [0, 0] : rawDealt);
  const attackerOutcome = outcome(a.hp, rawReceived);
  const result = {
    legal,
    reasons,
    dealt,
    received,
    dealtBounds: rawDealt,
    receivedBounds: rawReceived,
    expected: { dealt: exchange.dealt, received: exchange.received },
    attack: attackStrength,
    defense: defenseStrength,
    strengthDifference: Math.round((attackStrength - defenseStrength) * 10) / 10,
    attackerTerms,
    defenderTerms,
    melee: exchange.melee,
    targetOutcome,
    attackerOutcome,
    ammunition,
    wallProtected: structureProtected,
    garrisonProtected: cityProtected,
    kill: targetOutcome,
    outcome: { target: targetOutcome, attacker: attackerOutcome },
    uncertainty: city
      ? cityProtected
        ? "문명6 공식 · 30·e^(전투력 차/25) · 무작위 75~125% · 주둔군은 도시 파괴 전까지 보호"
        : "문명6 공식 · 30·e^(전투력 차/25) · 무작위 75~125% · 현재 보이는 성벽·도시 상태 기준"
      : "문명6 공식 · 30·e^(전투력 차/25) · 무작위 75~125% · 현재 보이는 상태 기준",
  };
  if (city) {
    result.capture = cityCapturePreview(
      a,
      cityTarget,
      rawDealt,
      { legal, garrisonProtected: cityProtected },
    );
    result.wallDamage = [exchangeLow.wallDamage, exchangeHigh.wallDamage];
    result.bodyDamage = [exchangeLow.bodyDamage, exchangeHigh.bodyDamage];
    result.cityPool = {
      id: cityTarget.id ?? null,
      hp: cityTarget.hp,
      wallHp: cityWallHp(cityTarget),
      protectedGarrison: cityProtected,
    };
  }
  if (targetStructure) {
    result.structure = {
      kind: structureKind(targetStructure),
      wallHp: structureWallHp(targetStructure),
      protectedGarrison: structureProtected,
    };
  }
  return result;
}

/** UI-only hypothetical approach; never changes legal orders or NPC choices. */
export function approachCombatPreview(view, a, b) {
  const current = combatPreview(view, a, b);
  if (!current || TYPES[a.type].range !== 1 || distance(a, b) <= 1) return current;
  const candidates = neighbors(b).flatMap(point => {
    const tile = tileAt(view, point);
    if (!tile || tile.terrain === "unknown" || tile.terrain === "mountain" ||
        view.units.some(u => equal(u, point) && blocksUnit(a, u)) ||
        (view.cities ?? []).some(c => c.owner !== a.owner && c.hp > 0 && equal(c, point))) return [];
    const structure = structureAt(view, point);
    if (structure && structure.owner !== a.owner && (structure.hp > 0 || structure.wallHp > 0)) return [];
    const path = findRoute(view, a, point);
    if (!path?.length) return [];
    let from = a, cost = 0, crossing = false;
    for (const to of path) {
      cost += movementCost({from,to},view);
      crossing ||= riverBetween(view,from,to);
      from = to;
    }
    return [{point,path,cost,crossing}];
  }).sort((x,y)=>x.cost-y.cost || x.path.length-y.path.length);
  const approach = candidates[0];
  if (!approach) return {...current, approachUnavailable:true,
    reasons:[...current.reasons,"공개된 지도에서 접근 가능한 교전 칸을 확인할 수 없어요"]};
  const projected = {...a,...approach.point,fortified:false,riverTurns:approach.crossing?3:a.riverTurns};
  const projectedView = {...view,units:view.units.map(u=>u.id===a.id?projected:u)};
  const forecast = combatPreview(projectedView,projected,b);
  return {...forecast,legal:false,approachFrom:approach.point,
    reasons:[`사거리 밖 · ${label(approach.point)} 접근 후 근접 교전 가정`,...forecast.reasons],
    uncertainty:`접근 경로·도착 당시 상태에 따라 달라지는 예측 · ${forecast.uncertainty}`,
    ...(forecast.capture ? {capture:{...forecast.capture,legal:false}} : {})};
}
