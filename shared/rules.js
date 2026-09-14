export const WIDTH = 20;
export const HEIGHT = 20;
export const TURN_MS = 60_000;
// Legacy default turn limit.  Matches are unlimited by default now; the
// host sets a per-game `maxTurns` (null = unlimited) in settings.
export const MAX_TURNS = 40;
export const BOMBARD_RANGE = 2;
export const RESOURCE_PER_POP = 5;
// Economy-v2 contract.  These values are intentionally explicit in the
// shared rules so the UI, API clients and server show the same provisional
// balance while the detailed convoy system remains deferred.
export const MILITARY_FOOD_MULTIPLIER = 2;
export const NITER_UPKEEP_PER_UNIT = 1;
// Two starting powder units get four full upkeep rounds to establish supply.
// This is a new-match allowance, never a refill when restoring/upgrading saves.
export const EXPANSION_START_NITER = 8;
export const FOOD_STORAGE_PER_POP = 8;
export const CITIZEN_YIELD_BONUS = 1;
// Produced units reserve half a population-equivalent from their home city.
// A city never falls below one resident from production; starvation can only
// remove population above that floor.  Existing serialized units migrate as
// grandfathered zero-cost units, so an update cannot mint free population.
export const UNIT_MANPOWER_COST = 0.5;
export const MIN_CITY_POPULATION = 1;
// Expansion-v1 keeps city territory local and predictable.  A city starts
// with its center plus the first eligible ring, then earns one adjacent tile
// whenever it crosses each half-population growth threshold.  The cap is a
// distance cap rather than a number of tiles so a city cannot grow a thin
// linear corridor beyond its intended footprint.
export const TERRITORY_MAX_RADIUS = 3;
export const TERRITORY_BASE_RADIUS = 1;
export const MAX_CIVILIZATIONS = 8;
export const START_GRACE_TURNS = 6;
export const XP_THRESHOLDS = [0, 8, 20, 38, 62];
export const TYPES = {
  spearman: {
    name: "창병",
    movement: 4,
    vision: 2,
    range: 1,
    attack: 21,
    defense: 25,
    cost: 20,
    resources: {},
    description: "기병에 강한 방어 병력 · 전략 자원 불필요",
  },
  musketeer: {
    name: "머스킷병",
    movement: 4,
    vision: 2,
    range: 2,
    attack: 28,
    defense: 22,
    cost: 28,
    resources: { niter: 2 },
    description: "2칸 사거리의 화약 보병 · 기병 돌격에 취약",
  },
  cavalry: {
    name: "기병",
    movement: 10,
    vision: 4,
    range: 1,
    attack: 25,
    defense: 21,
    cost: 32,
    resources: { horses: 2 },
    description: "머스킷병에 강한 기동 병력 · 창병에 취약",
  },
  artillery: {
    name: "포병",
    movement: 4,
    vision: 2,
    range: BOMBARD_RANGE,
    attack: 34,
    defense: 10,
    cost: 40,
    resources: { iron: 2, niter: 2 },
    description: "2칸 간접 포격과 1칸 재배치 · 근접 직접 공격에 매우 취약",
  },
  builder: {
    name: "건축자",
    civilian: true,
    movement: 4,
    vision: 2,
    range: 0,
    attack: 0,
    defense: 8,
    cost: 18,
    resources: {},
    description: "농지·자원 시설·요새 건설 · 건설 3회",
  },
  settler: {
    name: "개척자",
    civilian: true,
    movement: 4,
    vision: 3,
    range: 0,
    attack: 0,
    defense: 6,
    cost: 40,
    resources: {},
    description: "새 도시 건설 · 정착 시 소모 · 전투 부대와 동행 가능",
  },
  merchant: {
    name: "상인", civilian: true, movement: 5, vision: 2, range: 0,
    attack: 0, defense: 6, cost: 24, resources: {},
    description: "교역소당 1명 · 도시 사이 실제 화물 운송 · 통과한 길 개척",
  },
  convoy: {
    name: "보급 수송대", civilian: true, internal: true,
    movement: 4, vision: 1, range: 0, attack: 0, defense: 4,
    cost: 0, resources: {},
    description: "자동 생성되는 실물 수송대 · 도시·부대에 보급품 전달 · 적에게 갈취될 수 있음",
  },
};
/**
 * Host-adjustable combat numbers. Every value has a default equal to the
 * shipped rule so an omitted or partial `balance` object changes nothing.
 * `unitAttack` overrides TYPES[type].attack; `counterMultiplier` scales the
 * damage a melee attacker receives from a defending unit; a city returns
 * fire on an adjacent attacker with `cityBaseAttack + population ×
 * cityAttackPerPop` before the usual ±12% roll.
 */
export const BALANCE_DEFAULTS = Object.freeze({
  unitAttack: Object.freeze(
    Object.fromEntries(
      Object.entries(TYPES)
        .filter(([, t]) => t.attack > 0)
        .map(([type, t]) => [type, t.attack]),
    ),
  ),
  counterMultiplier: 1,
  cityBaseAttack: 20,
  cityAttackPerPop: 3,
});
export const BALANCE_LIMITS = Object.freeze({
  unitAttack: [1, 200],
  counterMultiplier: [0, 3],
  cityBaseAttack: [0, 200],
  cityAttackPerPop: [0, 50],
});
export function normalizeBalance(input) {
  const out = {
    unitAttack: { ...BALANCE_DEFAULTS.unitAttack },
    counterMultiplier: BALANCE_DEFAULTS.counterMultiplier,
    cityBaseAttack: BALANCE_DEFAULTS.cityBaseAttack,
    cityAttackPerPop: BALANCE_DEFAULTS.cityAttackPerPop,
  };
  if (!input || typeof input !== "object") return out;
  const clamp = (value, [min, max], fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
  };
  for (const type of Object.keys(out.unitAttack))
    if (input.unitAttack?.[type] !== undefined)
      out.unitAttack[type] = clamp(
        input.unitAttack[type],
        BALANCE_LIMITS.unitAttack,
        out.unitAttack[type],
      );
  for (const field of ["counterMultiplier", "cityBaseAttack", "cityAttackPerPop"])
    if (input[field] !== undefined)
      out[field] = clamp(input[field], BALANCE_LIMITS[field], out[field]);
  return out;
}
export const unitAttackValue = (view, type) =>
  Number.isFinite(Number(view?.balance?.unitAttack?.[type]))
    ? Number(view.balance.unitAttack[type])
    : (TYPES[type]?.attack ?? 0);
export const counterMultiplier = (view) =>
  Number.isFinite(Number(view?.balance?.counterMultiplier))
    ? Number(view.balance.counterMultiplier)
    : BALANCE_DEFAULTS.counterMultiplier;
/** Deterministic return fire of a city against an adjacent attacker. */
export const cityCounterAttack = (city, view) => {
  const base = Number.isFinite(Number(view?.balance?.cityBaseAttack))
    ? Number(view.balance.cityBaseAttack)
    : BALANCE_DEFAULTS.cityBaseAttack;
  const perPop = Number.isFinite(Number(view?.balance?.cityAttackPerPop))
    ? Number(view.balance.cityAttackPerPop)
    : BALANCE_DEFAULTS.cityAttackPerPop;
  const population = Math.max(0, Number(city?.population) || 0);
  return Math.max(0, base + population * perPop);
};
export const isCivilian = (u) =>
  !!TYPES[typeof u === "string" ? u : u?.type]?.civilian;
// The UI, NPCs and server use the same observed settlement prerequisites.
export function settlementIssue(view, u) {
  if (u?.type !== "settler") return "도시는 개척자로 세울 수 있어요.";
  const t = view.tiles.find((t) => equal(t, u));
  if (!t || !["plains", "hills"].includes(t.terrain)) return "탐사된 평지나 구릉지에 정착해 주세요.";
  if (t.owner && t.owner !== u.owner)
    return "다른 문명의 영토에는 정착할 수 없어요.";
  if (territorialPactBlocks(view, u.owner, u))
    return "최후통첩 합의 지역이에요. 10턴 동안 선전포고 없이 정착할 수 없어요.";
  if (view.cities.some((c) => distance(c, u) < 4))
    return "기존 도시에서 4칸 이상 떨어져야 해요.";
  return null;
}
export const RESOURCES = {
  iron: { name: "철", improvement: "철광산", icon: "iron" },
  horses: { name: "말", improvement: "목장", icon: "horse" },
  niter: { name: "초석", improvement: "초석 광산", icon: "niter" },
};
export const FACTIONS = {
  p1: { name: "들녘", color: "#16846a", symbol: "葉", kind: "player" },
  p2: { name: "솔마루", color: "#d14d43", symbol: "山", kind: "player" },
  p3: {
    name: "청람 연맹",
    color: "#346be0",
    symbol: "波",
    kind: "independent",
  },
  p4: {
    name: "자운 왕국",
    color: "#9651c8",
    symbol: "星",
    kind: "independent",
  },
  cs: {
    name: "금빛항 도시국가",
    color: "#bc8a12",
    symbol: "港",
    kind: "citystate",
  },
  barb: { name: "야만인", color: "#45434a", symbol: "斧", kind: "barbarian" },
};
const EXTRA_FACTION_PALETTE = [
  ["#c65b2e", "火"],
  ["#2c8f9c", "潮"],
  ["#b33b72", "花"],
  ["#6b7d32", "森"],
];
/**
 * Build safe faction metadata for a lobby-defined civilization list.  The
 * base game continues to use FACTIONS directly; expansion-v1 stores this
 * generated map on the game so observations never need to infer missing
 * metadata for p5–p8.
 */
export function factionsFor(ids = Object.keys(FACTIONS), definitions = {}) {
  const result = {};
  let extra = 0;
  for (const id of ids) {
    if (FACTIONS[id]) {
      result[id] = { ...FACTIONS[id], ...(definitions[id] ?? {}) };
      continue;
    }
    const [color, symbol] =
      EXTRA_FACTION_PALETTE[extra % EXTRA_FACTION_PALETTE.length];
    result[id] = {
      name: definitions[id]?.name ?? `신흥 문명 ${extra + 1}`,
      color: definitions[id]?.color ?? color,
      symbol: definitions[id]?.symbol ?? symbol,
      kind: definitions[id]?.kind ?? "independent",
      ...definitions[id],
    };
    extra++;
  }
  return result;
}
export const RELATIONS = {
  self: "내 문명",
  war: "전쟁",
  alliance: "동맹",
  good: "좋음",
  neutral: "보통",
  bad: "사이나쁜",
  denounced: "공개비난",
};
export const cityMaxHealth = (city) =>
  city.camp ? 80 : 160;
export const wallMaxHealth = (city) =>
  city.camp
    ? 0
    : Math.max(0, Math.min(3, Number.isFinite(city.wallLevel) ? city.wallLevel : 0) * 50);
export const productionType = (type, city = {}) =>
  type === "walls"
    ? {
        name: `성벽 ${Math.min(3, (city.wallLevel ?? 0) + 1)}레벨`,
        cost: 30 + (city.wallLevel ?? 0) * 25,
        resources: {},
        description: "성벽 +50 · 원거리 방어 강화 · 사거리 2의 도시 포격",
      }
    : type === "wallRepair"
      ? {
          name: city.productionTarget ? "주둔지 성벽 수리" : "성벽 수리",
          cost: Math.max(
            1,
            (city.productionTargetWallMaxHp ?? wallMaxHealth(city)) -
              (city.wallRepairStartHp ?? city.wallHp ?? 0),
          ),
          resources: {},
          description: "공격이 멈춘 뒤 생산력으로 손상된 성벽을 수리",
        }
      : type === "builder" && city.rulesVersion === "expansion-v1"
      ? {
          ...TYPES.builder,
          cost: TYPES.builder.cost * 2,
          description: "농지·자원 시설·요새 건설 · 건설 3회 · 확장 규칙 생산력 2배",
        }
      : type === "tradingPost"
        ? { name: "교역소", cost: 30, resources: {}, description: "도시당 1개 · 상인 1명 생산 가능" }
        : type === "encampment"
          ? { name: "주둔지", cost: 50, resources: { iron: 2 }, requiresTarget: true, description: "도심 밖의 아군 타일 · 건물 체력 80 · 성벽 체력 50" }
          : TYPES[type];
export const unitPurchasePrice = (type, city = {}) =>
  productionType(type, city)?.cost ?? Infinity;
export const MARKET = {
  food: { buy: 4, sell: 2 },
  iron: { buy: 12, sell: 7 },
  horses: { buy: 12, sell: 7 },
  niter: { buy: 14, sell: 8 },
};
export const TERRAINS = {
  unknown: { name: "미탐사", cost: 1, defense: 0 },
  plains: { name: "평지", cost: 1, defense: 0 },
  hills: { name: "구릉지", cost: 2, defense: 0.2 },
  mountain: { name: "산지", cost: Infinity, defense: 0 },
};
// Hill farms exchange one base food for one city production. Fertility,
// adjacent farms and assigned-citizen bonuses are unchanged.
export function farmTerrainYield(tile) {
  const hills = tile?.terrain === "hills";
  return {
    base: hills ? 0 : 1,
    production: hills ? 1 : 0,
    name: hills ? "구릉지 농지" : "농지",
  };
}
export const DIRECTIONS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];
export const key = ({ q, r }) => `${q},${r}`;
export const equal = (a, b) => !!a && !!b && a.q === b.q && a.r === b.r;
// Flat bounded map: neither axis wraps. Callers reject absent edge tiles the
// same way on every side. `wrap` keeps its name for existing callers but only
// normalizes the coordinate object.
export const wrap = ({ q, r }) => ({ q, r });
export const neighbors = ({ q, r }) =>
  DIRECTIONS.map(([dq, dr]) => wrap({ q: q + dq, r: r + dr }));
const axialDistance = (a, b) =>
  (Math.abs(a.q - b.q) +
    Math.abs(a.r - b.r) +
    Math.abs(a.q + a.r - b.q - b.r)) /
  2;
export const distance = (a, b) => axialDistance(a, b);
export const blocksUnit = (mover, occupant) =>
  mover.id !== occupant.id &&
  (mover.owner !== occupant.owner ||
    isCivilian(mover) === isCivilian(occupant));
export const fromOffset = (col, row) => ({
  q: col,
  r: row - Math.floor(col / 2),
});
export const label = ({ q, r }) =>
  `${String.fromCharCode(65 + q)}${r + Math.floor(q / 2) + 1}`;
export const level = (xp) =>
  XP_THRESHOLDS.filter((threshold) => xp >= threshold).length;
export const unitStat = (unit, name, fallback) => unit?.experimentStats?.[name] ?? fallback;
export const unitMovement = (unit) => unitStat(unit, "movement", TYPES[unit.type].movement);
export const unitAttacks = (unit) => unitStat(unit, "attacks", 1);
export const maxHealth = (unit) => unitStat(unit, "maxHealth", 100) * unit.size;
export const growthTarget = (population) => 12 + population * 4;
export const growthHalfTarget = (population) => growthTarget(population) / 2;
export const landPrice = (tile, city) =>
  25 + distance(tile, city) * 10 + tile.fertility * 5;
export const formationName = (size) =>
  ({ 1: "대대", 2: "여단 · 대대 2개 합병", 4: "사단 · 여단 2개 합병" })[size] ??
  `기존 편성 · ${size}개 병력`;
export const edgeKey = (a, b) => [key(a), key(b)].sort().join("|");
// Directional permission: the territory owner grants the visitor entry.
// Observations carry entryAllowed only for their own player and known tiles.
export function territoryEntryAllowed(view, player, tile) {
  if (!tile?.owner || tile.owner === player) return true;
  if (typeof tile.entryAllowed === "boolean") return tile.entryAllowed;
  if (!view.wars && !view.factions) return true; // terrain-only preview
  const war = tile.owner === "barb" || player === "barb" ||
    (view.wars ?? []).includes([player, tile.owner].sort().join("|")) ||
    (Array.isArray(view.factions) && view.factions.some(f => f.id === tile.owner && f.hostile));
  return !!war || (view.openBorders?.[`${tile.owner}>${player}`] ?? 0) > view.turn;
}
export function canCrossBorder(view, unit, from, to) {
  if (TYPES[unit.type] && !isCivilian(unit) && territorialPactBlocks(view, unit.owner, to)) return false;
  const tile = view.tiles?.find(t => equal(t, to));
  if (territoryEntryAllowed(view, unit.owner, tile)) return true;
  const source = view.tiles?.find(t => equal(t, from));
  if (source?.owner !== tile.owner) return false;
  // Existing visitors may withdraw after expiry/peace/ownership changes.
  // Use known exit tiles only; no hidden ownership is consulted by previews.
  const exits = view.tiles.filter(t => t.terrain !== "mountain" && t.terrain !== "unknown" &&
    t.owner !== tile.owner && territoryEntryAllowed(view, unit.owner, t));
  if (!exits.length) return false;
  const terrain = new Map(view.tiles.map(t => [key(t), t]));
  const distances = new Map(exits.map(t => [key(t), 0]));
  const queue = [...exits];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const next of neighbors(current)) {
      const t = terrain.get(key(next));
      if (!t || t.owner !== tile.owner || t.terrain === "mountain" || t.terrain === "unknown" || distances.has(key(t))) continue;
      distances.set(key(t), distances.get(key(current)) + 1);
      queue.push(t);
    }
  }
  return (distances.get(key(to)) ?? Infinity) < (distances.get(key(from)) ?? Infinity);
}
// The server stores the full protected zone; observations expose only known
// zone tiles. Unknown geography never enters browser or NPC path previews.
export function territorialPactBlocks(view, player, target) {
  const agreements = view.territorialAgreements ?? view.territorialDiplomacy?.agreements ?? [];
  return agreements.some(p => {
    if (p.to !== player || p.until <= view.turn) return false;
    const edge = [p.from, p.to].sort().join("|");
    const war = (view.wars ?? []).includes(edge) ||
      (view.conflicts ?? []).some(([a,b]) => [a,b].sort().join("|") === edge);
    return !war && (p.fullZoneKeys ?? p.zoneKeys ?? []).includes(key(target));
  });
}
/**
 * Cost of entering the destination of an adjacent edge. A river crossing is
 * a fixed three-point movement event, independent of destination terrain.
 * Keep this in shared rules so the engine, route previews, and NPCs agree.
 */
export function movementCost(edge, view = {}) {
  const from = edge?.a ?? edge?.from ?? edge?.[0];
  const to = edge?.b ?? edge?.to ?? edge?.[1];
  const tiles = Array.isArray(view) ? view : view.tiles ?? [];
  const rivers = Array.isArray(view) ? [] : view.rivers ?? [];
  if (from && to && distance(from, to) !== 1) return Infinity;
  const tile = to && tiles.find((t) => equal(t, to));
  if (!tile || tile.terrain === "mountain") return Infinity;
  if (
    from &&
    rivers.some((river) => edgeKey(river.a, river.b) === edgeKey(from, to))
  )
    return 3;
  const base = TERRAINS[tile.terrain]?.cost ?? Infinity;
  const roads = Array.isArray(view) ? [] : view.roads ?? view.logistics?.roads ?? [];
  const road = from && roads.some(entry =>
    (typeof entry === "string" ? entry : entry?.edge ?? (entry?.from && entry?.to ? edgeKey(entry.from, entry.to) : null)) === edgeKey(from, to));
  return road ? Math.max(0.5, base / 2) : base;
}
export const siegePenalty = (isolation = 0) => Math.min(0.6, isolation * 0.12);

// Only supplied observations are used. No hidden state or future-state simulation.
export function reachable(tiles, unit, units, playerId, rivers = [], roads = []) {
  const terrain = new Map(tiles.map((t) => [key(t), t]));
  const hostiles = units.filter(
    (u) => u.owner !== playerId && u.hostile !== false && !isCivilian(u),
  );
  const occupied = new Set(units.filter((u) => blocksUnit(unit, u)).map(key));
  const view = { tiles, rivers, roads };
  const budget = unit.movesLeft ?? unitMovement(unit);
  const zoc = (point) => hostiles.some((u) => distance(u, point) === 1);
  const startsInZoc = zoc(unit);
  const result = new Map([[key(unit), { cost: 0, path: [] }]]);
  if (budget <= 0) return result;
  const queue = [{ ...unit, cost: 0, path: [] }];
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (current.cost && (startsInZoc || zoc(current))) continue;
    // A zero remaining budget can enter an over-cost destination only for the
    // edge that consumed the last positive point; it cannot fan out further.
    if (current.cost >= budget) continue;
    for (const n of neighbors(current)) {
      const tile = terrain.get(key(n));
      if (!tile || tile.terrain === "mountain" || occupied.has(key(n)))
        continue;
      if (!canCrossBorder(view, unit, current, n)) continue;
      const cost = movementCost({ a: current, b: n }, view);
      if (!Number.isFinite(cost)) continue;
      const spent = Math.min(budget, current.cost + cost);
      if (
        spent >= (result.get(key(n))?.cost ?? Infinity)
      )
        continue;
      const entry = {
        cost: spent,
        path: [...current.path, { q: n.q, r: n.r }],
      };
      result.set(key(n), entry);
      queue.push({ ...n, ...entry });
    }
  }
  return result;
}

// Mechanical path planning uses only the same public observation available to either player.
// It is a game control, not an agent strategy/solver.
export function routeSchedule(
  tiles,
  unit,
  units,
  playerId,
  path = [],
  rivers = [],
) {
  const enemies = units.filter(
    (u) => u.owner !== playerId && u.hostile !== false && !isCivilian(u),
  );
  const controlled = (p) => enemies.some((e) => distance(e, p) === 1);
  const budget = unitMovement(unit);
  const view = { tiles, rivers };
  let turn = 1,
    left = unit.movesLeft ?? budget,
    current = unit,
    startControlled = controlled(unit);
  const steps = [];
  for (const point of path) {
    if (!canCrossBorder(view, unit, current, point)) return { steps: [], turns: 0, valid: false };
    const cost = movementCost({ a: current, b: point }, view);
    if (!Number.isFinite(cost) || distance(current, point) !== 1)
      return { steps: [], turns: 0, valid: false };
    if (left <= 0) {
      turn++;
      left = budget;
      startControlled = controlled(current);
    }
    left = Math.max(0, left - cost);
    steps.push({ q: point.q, r: point.r, turn, remaining: left });
    if (startControlled || controlled(point)) left = 0;
    current = point;
  }
  return {
    steps: steps.map((s, i) => ({
      ...s,
      endOfTurn: i === steps.length - 1 || steps[i + 1].turn !== s.turn,
    })),
    turns: steps.at(-1)?.turn ?? 0,
    valid: true,
  };
}

export function validRoute(view, unit, path, target) {
  if (
    !Array.isArray(path) ||
    !path.length ||
    path.length > WIDTH * HEIGHT ||
    !equal(path.at(-1), target)
  )
    return false;
  const visited = new Set([key(unit)]),
    tiles = new Map(view.tiles.map((t) => [key(t), t]));
  let previous = unit;
  for (const [index, p] of path.entries()) {
    const cost = movementCost({ a: previous, b: p }, view);
    if (
      !p ||
      !Number.isInteger(p.q) ||
      !Number.isInteger(p.r) ||
      visited.has(key(p)) ||
      distance(previous, p) !== 1 ||
      !Number.isFinite(cost)
    )
      return false;
    if (!tiles.has(key(p)) || tiles.get(key(p)).terrain === "mountain")
      return false;
    if (!canCrossBorder(view, unit, previous, p)) return false;
    const occupant = view.units.find((u) => blocksUnit(unit, u) && equal(u, p));
    const city = view.cities?.find(
      (c) => c.owner !== unit.owner && c.hp > 0 && equal(c, p),
    );
    if (
      (occupant || city) &&
      !(
        index === path.length - 1 &&
        !isCivilian(unit) &&
        (!occupant ||
          (occupant.owner !== unit.owner && occupant.hostile !== false)) &&
        (!city || city.hostile !== false)
      )
    )
      return false;
    visited.add(key(p));
    previous = p;
  }
  return true;
}

export function findRoute(view, unit, target, avoid = []) {
  if (!target || equal(unit, target)) return [];
  const tiles = new Map(view.tiles.map((t) => [key(t), t]));
  const blocked = new Set([
    ...view.units.filter((u) => blocksUnit(unit, u)).map(key),
    ...(view.cities ?? [])
      .filter((c) => c.owner !== unit.owner && c.hp > 0)
      .map(key),
    ...avoid.map(key),
  ]);
  const enemyEnd =
    view.units.some(
      (u) => u.owner !== unit.owner && u.hostile !== false && equal(u, target),
    ) ||
    (view.cities ?? []).some(
      (c) => c.owner !== unit.owner && c.hostile !== false && equal(c, target),
    );
  if (!isCivilian(unit) && enemyEnd) blocked.delete(key(target));
  const hostile = view.units.filter(
    (u) => u.owner !== unit.owner && u.hostile !== false && !isCivilian(u),
  );
  const zoc = (p) => hostile.some((e) => distance(e, p) === 1),
    budget = unitMovement(unit);
  const best = new Map([[key(unit), 0]]),
    queue = [{ q: unit.q, r: unit.r, ticks: 0, path: [] }];
  while (queue.length) {
    queue.sort((a, b) => a.ticks - b.ticks || a.path.length - b.path.length);
    const current = queue.shift();
    if (current.ticks !== best.get(key(current))) continue;
    if (equal(current, target)) return current.path;
    for (const n of neighbors(current)) {
      const tile = tiles.get(key(n));
      if (!tile || tile.terrain === "mountain" || blocked.has(key(n))) continue;
      if (!canCrossBorder(view, unit, current, n)) continue;
      const cost = movementCost({ a: current, b: n }, view);
      if (!Number.isFinite(cost)) continue;
      let ticks = current.ticks,
        remaining = budget - (ticks % budget);
      ticks += Math.min(remaining, cost);
      if (zoc(current) || zoc(n)) ticks = Math.ceil(ticks / budget) * budget;
      if (ticks >= (best.get(key(n)) ?? Infinity)) continue;
      best.set(key(n), ticks);
      queue.push({ ...n, ticks, path: [...current.path, n] });
    }
  }
  return null;
}

export function extendRoute(view, unit, path, target) {
  if (equal(unit, target)) return [];
  const index = path.findIndex((p) => equal(p, target));
  if (index >= 0) return path.slice(0, index + 1);
  const from = path.at(-1) ?? unit;
  const segment = findRoute(view, { ...unit, q: from.q, r: from.r }, target, [
    unit,
    ...path.slice(0, -1),
  ]);
  if (!segment) return null;
  const result = [...path, ...segment];
  return validRoute(view, unit, result, target) ? result : null;
}
