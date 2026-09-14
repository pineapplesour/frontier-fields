import {
  CITIZEN_YIELD_BONUS,
  FOOD_STORAGE_PER_POP,
  MILITARY_FOOD_MULTIPLIER,
  NITER_UPKEEP_PER_UNIT,
  TYPES,
  RESOURCES,
  TERRITORY_MAX_RADIUS,
  distance,
  equal,
  growthTarget,
  isCivilian,
  key,
  productionType,
  farmTerrainYield,
} from "../shared/rules.js";

/**
 * Economy v2 is deliberately a small, serializable contract.  It is used by
 * the engine and is also safe to use while rendering an observation: all
 * inputs come from the current game snapshot and no hidden map is consulted.
 * Physical supply convoys and merchant routes are intentionally outside this
 * module (see docs/design/LOGISTICS-FOLLOWUP.md).
 */
export const SUPPLY_MODES = Object.freeze({ OFF: "off", ON: "on" });
export const DEFAULT_SUPPLY_MODE = SUPPLY_MODES.OFF;
export const MILITARY_FOOD_FACTOR = MILITARY_FOOD_MULTIPLIER;
export const NITER_UPKEEP = NITER_UPKEEP_PER_UNIT;

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export function ensureEconomyState(g) {
  if (!Object.values(SUPPLY_MODES).includes(g.supplyMode))
    g.supplyMode = DEFAULT_SUPPLY_MODE;
  g.supplySettings ??= {
    mode: g.supplyMode,
    changedAtTurn: null,
    changedBy: null,
  };
  g.supplySettings.mode = g.supplyMode;
  for (const city of g.cities ?? []) {
    city.food = Math.max(0, finite(city.food));
    city.growthProgress = Math.max(0, finite(city.growthProgress));
    city.growthHalfGranted = !!city.growthHalfGranted;
    city.starvationTurns = Math.max(0, finite(city.starvationTurns));
    city.citizenPolicy ??= {
      auto: true,
      lockedSlots: [],
      priority: [],
    };
    if (!Array.isArray(city.citizenPolicy.lockedSlots))
      city.citizenPolicy.lockedSlots = [];
    if (!Array.isArray(city.citizenPolicy.priority))
      city.citizenPolicy.priority = [];
    city.citizenPolicy.auto = city.citizenPolicy.auto !== false;
    if (!Array.isArray(city.mobilizationQueue)) city.mobilizationQueue = [];
    // Observation, save migration and turn settlement all call this helper.
    // Normalize each valid entry in place instead of mapping to a fresh
    // reduced object: blockedReason (and future diagnostic fields such as
    // blockedAt/lastAttemptTurn) must survive repeated observations and a
    // retry.  Public queue views still clone at their boundary.
    for (let index = city.mobilizationQueue.length - 1; index >= 0; index--) {
      const entry = city.mobilizationQueue[index];
      if (!entry || typeof entry.id !== "string") {
        city.mobilizationQueue.splice(index, 1);
        continue;
      }
      entry.requestedTurn = finite(entry.requestedTurn, 0);
      entry.requestedBy ??= null;
      if (!["pending", "blocked"].includes(entry.status))
        entry.status = "pending";
      // Older queue writers called this field `reason`; retain both spellings
      // so a blocked explanation cannot disappear at an observation boundary.
      if (entry.blockedReason == null && entry.reason != null)
        entry.blockedReason = entry.reason;
      if (entry.reason == null && entry.blockedReason != null)
        entry.reason = entry.blockedReason;
      entry.blockedReason ??= null;
      entry.dispatchedTurn ??= null;
    }
    city.mobilizationLastDispatchTurn ??= null;
  }
  for (const unit of g.units ?? []) {
    // Existing serialized units are grandfathered.  They still carry an
    // ongoing food burden once the new economy is enabled, but enabling the
    // setting never creates a second manpower reservation.
    unit.recruitmentMode ??=
      unit.mobilized === true
        ? "supply-on"
        : Number(unit.manpowerCost) > 0
          ? "legacy"
          : "grandfathered";
    unit.ammoPaidTurn ??= null;
    unit.ammoShortfall = Math.max(0, finite(unit.ammoShortfall));
  }
  return g;
}

export function isSupplyOn(g) {
  return g?.supplyMode === SUPPLY_MODES.ON;
}

export function mobilizationCost(type) {
  return Object.hasOwn(TYPES, type) && !isCivilian(type)
    ? 0.5
    : null;
}

export function pendingMobilizationCost(city) {
  return (city?.mobilizationQueue ?? []).reduce(
    (sum, entry) => sum + (mobilizationCost(entry.type) ?? 0),
    0,
  );
}

export function pendingMobilizationResources(city) {
  const result = {};
  for (const entry of city?.mobilizationQueue ?? []) {
    const definition = productionDefinition(entry.type, city);
    for (const [resource, amount] of Object.entries(definition?.resources ?? {}))
      result[resource] = (result[resource] ?? 0) + amount;
  }
  return result;
}

export function mobilizationQueueView(city) {
  return {
    pending: (city?.mobilizationQueue ?? []).map((entry) => ({ ...entry })),
    pendingCount: city?.mobilizationQueue?.length ?? 0,
    pendingManpower: pendingMobilizationCost(city),
    lastDispatchTurn: city?.mobilizationLastDispatchTurn ?? null,
  };
}

export function militaryFoodCost(unit) {
  if (!unit || isCivilian(unit)) return 0;
  // A missing ledger is an intentionally grandfathered unit, not free food:
  // use one half population-equivalent per surviving base unit.  A tracked
  // formation uses its conserved ledger instead of size*0.5 when larger.
  const ledger = finite(unit.manpowerCost);
  const manpower = Math.max(ledger, 0.5 * Math.max(1, finite(unit.size, 1)));
  return manpower * MILITARY_FOOD_FACTOR;
}

function assignedCity(g, tile, cities = g.cities ?? []) {
  if (!tile?.owner) return null;
  const explicit = cities.find(
    (city) => city.owner === tile.owner && city.id === tile.cityId,
  );
  if (explicit) return explicit;
  // Older snapshots may not have cityId.  Keep this fallback deterministic
  // and read-only; only an explicit assignment is authoritative after a
  // player uses the city-reassignment action.
  return [...cities]
    .filter((city) => city.owner === tile.owner && !city.camp)
    .sort(
      (a, b) =>
        distance(a, tile) - distance(b, tile) || a.id.localeCompare(b.id),
    )[0] ?? null;
}

function farmBase(g, tile) {
  const ownerCity = assignedCity(g, tile);
  const adjacent = (g.tiles ?? []).filter(
    (candidate) =>
      candidate.farm &&
      !candidate.ruin &&
      candidate.owner === tile.owner &&
      (candidate.q !== tile.q || candidate.r !== tile.r) &&
      distance(candidate, tile) === 1 &&
      assignedCity(g, candidate)?.id === ownerCity?.id,
  ).length;
  return farmTerrainYield(tile).base + finite(tile.fertility) + adjacent;
}

function inCityFootprint(g, city, tile) {
  const withinRadius = distance(tile, city) <= TERRITORY_MAX_RADIUS;
  const belongs = assignedCity(g, tile)?.id === city.id;
  return (
    tile.owner === city.owner &&
    withinRadius &&
    belongs &&
    !equal(tile, city)
  );
}

/** Return stable, public slot identifiers for existing facilities only. */
export function citizenSlots(g, city) {
  if (!city) return [];
  const slots = [];
  for (const tile of g.tiles ?? []) {
    if (!inCityFootprint(g, city, tile) || tile.ruin) continue;
    if (tile.farm)
      slots.push({
        id: `farm:${key(tile)}`,
        kind: "farm",
        q: tile.q,
        r: tile.r,
        baseYield: farmBase(g, tile),
        baseProduction: farmTerrainYield(tile).production,
        bonus: CITIZEN_YIELD_BONUS,
        yield: "food",
      });
    if (tile.developed && RESOURCES[tile.resource])
      slots.push({
        id: `resource:${key(tile)}`,
        kind: "resource",
        resource: tile.resource,
        q: tile.q,
        r: tile.r,
        baseYield: 1,
        bonus: CITIZEN_YIELD_BONUS,
        yield: tile.resource,
      });
    // Trading posts are a future logistics building.  If an imported or
    // later schema already has one, the citizen contract can render it; this
    // foundation never creates posts or free merchants.
    if (tile.tradingPost && tile.tradingPost.owner === city.owner)
      slots.push({
        id: `trade:${key(tile)}`,
        kind: "trade",
        q: tile.q,
        r: tile.r,
        baseYield: 1,
        bonus: CITIZEN_YIELD_BONUS,
        yield: "gold",
      });
  }
  // One ordinary city worksite represents the production specialist slot.
  // It boosts the existing city production rate and does not replace it.
  slots.push({
    id: `worksite:${city.id}`,
    kind: "production",
    q: city.q,
    r: city.r,
    baseYield: 0,
    bonus: CITIZEN_YIELD_BONUS,
    yield: "production",
  });
  return slots.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Allocate whole civilian citizens to unique slots.  A half population can
 * be reserved by a unit but cannot silently become half a worker; it remains
 * in the exact population ledger and is consumed by food normally.
 */
export function allocateCitizens(g, city) {
  const slots = citizenSlots(g, city);
  const budget = Math.max(0, Math.floor(finite(city?.population)));
  const policy = city?.citizenPolicy ?? {
    auto: true,
    lockedSlots: [],
    priority: [],
  };
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const lockedIds = [...new Set(policy.lockedSlots)].filter((id) =>
    byId.has(id),
  );
  const priority = [...new Set(policy.priority)].filter((id) => byId.has(id));
  const selected = [];
  const add = (id, locked = false) => {
    if (selected.some((entry) => entry.id === id) || selected.length >= budget)
      return;
    selected.push({ ...byId.get(id), locked });
  };
  for (const id of lockedIds) add(id, true);
  if (policy.auto !== false) {
    const preferred = [
      ...priority,
      ...slots
        .filter((slot) => !priority.includes(slot.id))
        .sort(
          (a, b) =>
            (b.bonus ?? 0) - (a.bonus ?? 0) ||
            a.kind.localeCompare(b.kind) ||
            a.id.localeCompare(b.id),
        )
        .map((slot) => slot.id),
    ];
    for (const id of preferred) add(id, false);
  }
  const selectedIds = new Set(selected.map((entry) => entry.id));
  return {
    budget,
    slots,
    assignments: selected,
    assigned: selected.length,
    available: Math.max(0, budget - selected.length),
    locked: lockedIds.filter((id) => selectedIds.has(id)),
    policy: {
      auto: policy.auto !== false,
      lockedSlots: lockedIds,
      priority,
    },
  };
}

export function citizenYields(g, city) {
  const allocation = allocateCitizens(g, city);
  const result = {
    food: 0,
    production: 0,
    gold: 0,
    resources: Object.fromEntries(Object.keys(RESOURCES).map((id) => [id, 0])),
  };
  for (const slot of allocation.assignments) {
    const amount = finite(slot.bonus, CITIZEN_YIELD_BONUS);
    if (slot.kind === "farm") result.food += amount;
    else if (slot.kind === "resource") result.resources[slot.resource] += amount;
    else if (slot.kind === "trade") result.gold += amount;
    else if (slot.kind === "production") result.production += amount;
  }
  return { ...allocation, yields: result };
}

export function militaryFoodByCity(g, player) {
  const cities = (g.cities ?? []).filter((city) => city.owner === player);
  const result = new Map(cities.map((city) => [city.id, 0]));
  if (g.experiment && g.experimentCosts?.upkeep !== true)
    return { byCity: result, unassigned: 0, units: [] };
  const units = (g.units ?? []).filter(
    (unit) => unit.hp > 0 && unit.owner === player && !isCivilian(unit),
  );
  let unassigned = 0;
  for (const unit of units) {
    const exact = cities.find((city) => city.id === unit.homeCityId);
    const destination =
      exact ??
      [...cities].sort(
        (a, b) => distance(a, unit) - distance(b, unit) || a.id.localeCompare(b.id),
      )[0];
    const amount = militaryFoodCost(unit);
    if (destination) result.set(destination.id, result.get(destination.id) + amount);
    else unassigned += amount;
  }
  return { byCity: result, unassigned, units };
}

export function cityFoodCapacity(city, militaryFood = 0) {
  const residents = Math.max(1, finite(city?.population) + militaryFood);
  return Math.max(16, Math.ceil(residents * FOOD_STORAGE_PER_POP));
}

export function productionDefinition(type, city) {
  return Object.hasOwn(TYPES, type) ? productionType(type, city) : null;
}

export function ammunitionCost(unit) {
  if (!unit || !["musketeer", "artillery"].includes(unit.type)) return 0;
  return NITER_UPKEEP * Math.max(1, finite(unit.size, 1));
}

export function publicCitizenAllocation(g, city) {
  const info = citizenYields(g, city);
  return {
    budget: info.budget,
    assigned: info.assigned,
    available: info.available,
    locked: info.locked,
    auto: info.policy.auto,
    lockedSlots: [...info.policy.lockedSlots],
    priority: [...info.policy.priority],
    slots: info.slots.map((slot) => ({ ...slot })),
    assignments: info.assignments.map((slot) => ({ ...slot })),
    boosts: { ...info.yields, resources: { ...info.yields.resources } },
  };
}

export function publicEconomyPolicy(g, city) {
  const citizens = publicCitizenAllocation(g, city);
  const queue = mobilizationQueueView(city);
  const militaryFood = queue.pendingManpower * MILITARY_FOOD_FACTOR;
  return {
    citizens,
    mobilization: {
      ...queue,
      // Pending citizens continue to work and consume civilian food.  This
      // preview is informational only; no population is reserved here.
      dispatchPopulationCost: 0.5,
      pendingCivilianFood: 0,
      pendingResourceCost: pendingMobilizationResources(city),
      militaryFoodMultiplier: MILITARY_FOOD_FACTOR,
      examplePendingMilitaryFood: militaryFood,
    },
  };
}
