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

export const COMBAT_ROLL_MIN = 0.88;
export const COMBAT_ROLL_MAX = 1.12;
export const VETERAN_LUCK_PER_LEVEL = 0.015;
export const VETERAN_LUCK_CAP = 0.06;
export const VETERAN_ATTACK_PER_LEVEL = 0.1;
export const COUNTER_MATCHUP_VETERAN_PER_LEVEL = 0.03;

// Experience shifts the same seeded distribution slightly upward. It is a
// small luck edge, while the level multiplier in combatStrength remains the
// main source of veteran advantage; this cannot turn a bad matchup into a
// coin flip.
export function combatRollRange(u) {
  const luck = Math.min(
    VETERAN_LUCK_CAP,
    Math.max(0, level(u?.xp ?? 0) - 1) * VETERAN_LUCK_PER_LEVEL,
  );
  return [
    Number((COMBAT_ROLL_MIN + luck).toFixed(2)),
    Number((COMBAT_ROLL_MAX + luck).toFixed(2)),
  ];
}

export function veteranAttackMultiplier(u) {
  return 1 + Math.min(
    0.4,
    Math.max(0, level(u?.xp ?? 0) - 1) * VETERAN_ATTACK_PER_LEVEL,
  );
}

const tileAt = (view, p) =>
  (view?.tiles ?? []).find((t) => equal(t, p));

/**
 * Position modifiers apply to the attacker's origin only. Defensive terrain,
 * fortification and occupied-fort bonuses stay in the defending branch below,
 * so a hill target is never counted twice as an attacker advantage.
 */
export function attackPositionBonus(a, target, view = {}) {
  if (!a || !target) return { value: 0, reasons: [] };
  let value = 0;
  const reasons = [];
  const origin = tileAt(view, a), destination = tileAt(view, target);
  if (origin?.terrain === "hills" && destination?.terrain === "plains") {
    value += 0.1;
    reasons.push("구릉지 고지 공격 +10%");
  }
  const city = (view.cities ?? []).find(
    (c) => c.owner === a.owner && c.hp > 0 && equal(c, a),
  );
  if (city) {
    value += 0.1;
    // A surviving city remains a useful firing position after its wall falls;
    // wallHP controls bombard capability/defense, not this origin bonus.
    reasons.push("아군 도시 주둔 공격 +10%");
  }
  const structure = structureAt(view, a);
  if (structurePositionBonus(view, a)) {
    value += structurePositionBonus(view, a);
    reasons.push(
      structureKind(structure) === "encampment"
        ? "아군 주둔지 위치 공격 +10%"
        : "아군 요새 주둔 공격 +10%",
    );
  }
  return { value: Math.min(0.3, value), reasons };
}

export function combatStrength(u, defending, view = {}, target = null) {
  const safeView = { ...view, tiles: view.tiles ?? [] };
  const tile = tileAt(safeView, u);
  const bonus = defending
    ? (TERRAINS[tile?.terrain]?.defense ?? 0) +
      (u.fortified ? 0.25 : 0) +
      fortBonus(safeView, u)
    : attackPositionBonus(u, target, safeView).value;
  return (
    (defending ? unitStat(u, "defense", TYPES[u.type].defense) : unitStat(u, "attack", unitAttackValue(safeView, u.type))) *
    // A formation's attack and health are literal sums of its constituent
    // units. No legacy diminishing/soft cap remains here.
    u.size *
    (defending ? 1 : veteranAttackMultiplier(u)) *
    (1 + bonus) *
    (1 - unitStat(u, "woundedPenalty", 40) / 100 * (1 - u.hp / maxHealth(u))) *
    (1 - (u.isolation ? unitStat(u, "isolationPenalty", siegePenalty(u.isolation) * 100) / 100 : 0)) *
    (u.riverTurns > 0 ? 1 - unitStat(u, "riverPenalty", 20) / 100 : 1) *
    (defending ? 1 - jointAttackPenalty(view, u, target).penalty : 1)
  );
}

export function jointAttackPenalty(view, defender, attacker) {
  if (!attacker || isCivilian(defender)) return { count: 0, penalty: 0 };
  const adjacent = new Set((view.units ?? []).filter((u) =>
    u.hp > 0 && u.owner === attacker.owner && !isCivilian(u) && distance(u, defender) === 1,
  ).map((u) => `${u.q},${u.r}`));
  const count = adjacent.size;
  return { count, penalty: count < 2 ? 0 : Math.min(0.5, (count - 1) * unitStat(defender, "jointPenalty", 10) / 100) };
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

export function combatMatchup(a, b) {
  if (!a || !b) return 1;
  if (a.type === "cavalry" && b.type === "musketeer") return 1.5;
  if (a.type === "spearman" && b.type === "cavalry") return 1.7;
  if (b.type === "artillery" && distance(a, b) === 1 && a.type !== "artillery")
    return 1.6;
  return 1;
}

export function effectiveCombatMatchup(a, b) {
  const base = combatMatchup(a, b);
  if (base <= 1) return base;
  const veteranLevels = Math.max(0, level(a?.xp ?? 0) - 1);
  return base * (1 + Math.min(0.12, veteranLevels * COUNTER_MATCHUP_VETERAN_PER_LEVEL));
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
  return Math.max(
    6,
    Math.round(
      ((27 * combatStrength(a, false, view, b)) /
        Math.max(8, combatStrength(b, true, view, a))) *
        effectiveCombatMatchup(a, b) *
        (a.type !== "artillery" && riverBetween(view, a, b) ? 1 - unitStat(a, "crossingPenalty", 25) / 100 : 1) *
        roll,
    ),
  );
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

export function cityDamage(a, c, view, roll = 1) {
  const activeWalls = cityWallHp(c) > 0;
  return Math.max(
    1,
    Math.round(
      (26 *
        (combatStrength(a, false, view, c) / 28) *
        (a.type === "artillery" ? 1.35 : 1) *
        (a.type !== "artillery" && riverBetween(view, a, c) ? 0.75 : 1) *
        roll) /
        (1 +
          (activeWalls ? c.wallLevel ?? 0 : 0) *
            (a.type === "artillery" ? 0.1 : 0.2)),
    ),
  );
}

export function cityDamageRange(a, c, view) {
  const [low, high] = combatRollRange(a);
  return [cityDamage(a, c, view, low), cityDamage(a, c, view, high)];
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
export function cityCounterDamage(city, view, roll = 1) {
  return Math.round(cityCounterAttack(city, view) * roll);
}
export function cityCounterRange(city, view) {
  return [
    cityCounterDamage(city, view, COMBAT_ROLL_MIN),
    cityCounterDamage(city, view, COMBAT_ROLL_MAX),
  ];
}

// A rule explanation based solely on a player's observation, never a hidden-
// state simulation or a Monte Carlo estimate.
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
    ammunition.ready &&
    !protectedTarget;
  if (range > TYPES[a.type].range) reasons.push("사거리 밖");
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
  if (a.riverTurns > 0) reasons.push(`도하 후 공격력 −${unitStat(a, "riverPenalty", 20)}%`);
  if (a.type !== "artillery" && riverBetween(view, a, b))
    reasons.push(`강 건너 공격 피해 −${unitStat(a, "crossingPenalty", 25)}%`);
  if (a.isolation)
    reasons.push(
      `공격자 보급 단절 −${unitStat(a, "isolationPenalty", Math.round(siegePenalty(a.isolation) * 100))}%`,
    );
  const injury = Math.max(0, Math.min(1, 1 - a.hp / maxHealth(a))) * unitStat(a, "woundedPenalty", 40);
  if (injury > 0) reasons.push(`부상 · 체력 ${Math.round(a.hp / maxHealth(a) * 100)}% · 공격력 −${Math.round(injury * 10) / 10}%`);
  const position = attackPositionBonus(a, b, view);
  reasons.push(...position.reasons);
  const terrain = tileAt(view, b);
  if (!city && terrain?.terrain === "hills") reasons.push("구릉지 방어력 +20%");
  if (b.fortified) reasons.push("방어 태세 방어력 +25%");
  if (!city && fortBonus(view, b))
    reasons.push(
      `${structureKind(structureAt(view, b)) === "encampment" ? "아군 주둔지" : "아군 요새"} 주둔 방어력 +25%`,
    );
  if (b.riverTurns > 0) reasons.push(`방어자 도하 후 방어력 −${unitStat(b, "riverPenalty", 20)}%`);
  if (b.isolation)
    reasons.push(
      `방어자 보급 단절 −${unitStat(b, "isolationPenalty", Math.round(siegePenalty(b.isolation) * 100))}%`,
    );
  const joint = jointAttackPenalty(view, b, a);
  if (!city && joint.penalty)
    reasons.push(`합동공격 · 인접 ${joint.count}방향 · 방어력 −${Math.round(joint.penalty * 100)}%`);
  if (!city && effectiveCombatMatchup(a, b) > 1)
    reasons.push(
      `병종 상성 피해 +${Math.round((effectiveCombatMatchup(a, b) - 1) * 100)}%`,
    );
  if (!city && effectiveCombatMatchup(a, b) > combatMatchup(a, b))
    reasons.push("베테랑 상성 숙련 보정");
  if (city && b.wallLevel && cityWallHp(b) > 0)
    reasons.push(`성벽 ${b.wallLevel}레벨 방어`);
  if (city && b.wallLevel && cityWallHp(b) <= 0)
    reasons.push("성벽 파괴 · 도시 포격 방어 보너스 없음");

  const rawDealt = city
    ? cityDamageRange(a, cityTarget, view)
    : (() => {
        const [low, high] = combatRollRange(a);
        return [unitDamage(a, b, view, low), unitDamage(a, b, view, high)];
      })();
  const targetHp = city ? cityTarget.hp + cityWallHp(cityTarget) : b.hp;
  const dealt = protectedTarget
    ? [0, 0]
    : rawDealt.map((n) => Math.min(targetHp, n));
  const counter =
    !city && range === 1 && !isCivilian(b) && a.type !== "artillery";
  const cityCounter =
    city && range === 1 && a.type !== "artillery" && cityTarget.hp > 0;
  if (counter && effectiveCombatMatchup(b, a) > 1)
    reasons.push(
      `상대 반격 상성 +${Math.round((effectiveCombatMatchup(b, a) - 1) * 100)}%`,
    );
  if (cityCounter)
    reasons.push(
      `도시 수비 반격 ${cityCounterAttack(cityTarget, view)} · 인구 ${cityTarget.population ?? 0}`,
    );
  const rawReceived = counter
    ? (() => {
        const [low, high] = combatRollRange(b);
        const scale = counterMultiplier(view);
        return [
          Math.max(4, Math.round(unitDamage(b, a, view, low) * scale)),
          Math.max(4, Math.round(unitDamage(b, a, view, high) * scale)),
        ];
      })()
    : cityCounter
      ? cityCounterRange(cityTarget, view)
      : [0, 0];
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
    attack: combatStrength(a, false, view, b),
    defense: city
      ? cityTarget.structure
        ? cityTarget.maxHp
        : cityMaxHealth(cityTarget) + cityWallHp(cityTarget)
      : combatStrength(b, true, view, a),
    targetOutcome,
    attackerOutcome,
    ammunition,
    wallProtected: structureProtected,
    garrisonProtected: cityProtected,
    // Aliases keep the contract readable for both the board and compact
    // panel without making either client infer lethal risk from bounds.
    kill: targetOutcome,
    outcome: { target: targetOutcome, attacker: attackerOutcome },
    uncertainty: city
      ? cityProtected
        ? "현재 보이는 도시 성벽·몸체 상태 기준 · 주둔군은 도시 파괴 전까지 보호 · 피해 무작위 ±12%"
        : "현재 보이는 성벽·도시 상태 기준 · 피해 무작위 ±12%"
      : "피해 무작위 ±12% · 현재 보이는 상태 기준",
  };
  if (city) {
    result.capture = cityCapturePreview(
      a,
      cityTarget,
      rawDealt,
      { legal, garrisonProtected: cityProtected },
    );
    result.wallDamage = rawDealt.map((n) =>
      Math.min(cityWallHp(cityTarget), n),
    );
    result.bodyDamage = rawDealt.map((n) =>
      Math.min(cityTarget.hp, Math.max(0, n - cityWallHp(cityTarget))),
    );
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
