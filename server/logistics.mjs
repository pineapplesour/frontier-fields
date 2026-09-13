import { randomUUID } from "node:crypto";
import {
  FOOD_STORAGE_PER_POP,
  HEIGHT,
  RESOURCES,
  RESOURCE_PER_POP,
  TYPES,
  WIDTH,
  distance,
  edgeKey,
  equal,
  blocksUnit,
  isCivilian,
  key,
  movementCost,
  canCrossBorder,
  neighbors,
} from "../shared/rules.js";
import { isSupplyOn } from "./economy.mjs";

/**
 * Physical logistics is deliberately additive.  It owns a finite shipment
 * ledger and the small amount of state needed by a carrier; the engine still
 * owns turn order, combat, production and the public observation envelope.
 *
 * Integration contract for engine.mjs:
 *   ensureLogisticsState(game) after create/restore;
 *   tickLogistics(game, { turn, owner }) once per resolved turn;
 *   publicLogisticsState(game, player, visibility) while observing;
 *   handleLogisticsAction(game, player, raw) from transact.
 *
 * Food is only active in supply ON.  Resource and unit movement remains
 * physical in either mode.  Food is kept in city.food (the existing ON
 * stock) and never mirrored into a second city ledger.
 */
export const LOGISTICS_VERSION = 1;
export const LOGISTICS_ACTIONS = Object.freeze({
  setFoodReserve: "setFoodReserve",
  setUnitReserve: "setUnitReserve",
  shipFood: "shipFood",
  shipFoodToUnit: "shipFoodToUnit",
  shipResource: "shipResource",
  autoSupply: "autoSupply",
  queueMerchant: "queueMerchant",
  merchantRoute: "merchantRoute",
  interceptCargo: "interceptCargo",
  returnCargo: "returnCargo",
});

export const SHIPMENT_STATUS = Object.freeze({
  QUEUED: "queued",
  IN_TRANSIT: "in_transit",
  BLOCKED: "blocked",
  CAPTURED: "captured",
  RETURNING: "returning",
  DELIVERED: "delivered",
  LOST: "lost",
});

const TERMINAL = new Set([
  SHIPMENT_STATUS.DELIVERED,
  SHIPMENT_STATUS.LOST,
]);
const ACTIVE = new Set([
  SHIPMENT_STATUS.QUEUED,
  SHIPMENT_STATUS.IN_TRANSIT,
  SHIPMENT_STATUS.BLOCKED,
  SHIPMENT_STATUS.RETURNING,
]);
const DEFAULT_CIVILIAN_FOOD = 1;
const MAX_HUNGER_PENALTY = 0.75;
const MAX_ROUTE = WIDTH * HEIGHT + 1;

export class LogisticsError extends Error {
  constructor(message) {
    super(message);
    this.name = "LogisticsError";
  }
}

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const point = (value) =>
  value && Number.isInteger(value.q) && Number.isInteger(value.r)
    ? { q: value.q, r: value.r }
    : null;
const clonePoint = (value) => (point(value) ? point(value) : null);
const pair = (a, b) => [a, b].sort().join("|");
const factionIsBarbarian = (g, id) =>
  id === "barb" || g.factions?.[id]?.kind === "barbarian";
const typeIsCivilian = (type) =>
  type === "merchant" || type === "convoy" || !!TYPES[type]?.civilian;
const unitIsCivilian = (unit) =>
  typeIsCivilian(unit?.type) || isCivilian(unit);
const stockpile = (g, owner) => {
  g.stockpiles ??= {};
  g.stockpiles[owner] ??= {};
  for (const resource of Object.keys(RESOURCES))
    g.stockpiles[owner][resource] = Math.max(
      0,
      finite(g.stockpiles[owner][resource]),
    );
  return g.stockpiles[owner];
};
const cityById = (g, id) =>
  (g.cities ?? []).find((city) => city?.id === id) ?? null;
const unitById = (g, id) =>
  (g.units ?? []).find((unit) => unit?.id === id) ?? null;
const cityPoint = (city) => point(city);
const unitPoint = (unit) => point(unit);
// Older snapshots omit hp for cities (and a few civilian descriptors).  A
// missing value means "not yet damaged", while an explicit zero is dead.
const living = (entity) =>
  !!entity && (entity.hp == null || finite(entity.hp, 0) > 0);

/**
 * A food/resource shipment without a player-controlled carrier receives a
 * real, internal convoy.  It is still an ordinary map unit for visibility and
 * interception, but has no production/manpower/food obligation.  The engine
 * may remove it with the normal combat path; delivered convoys are retired by
 * this module so automatic supply never leaves free units in the roster.
 */
function spawnInternalConvoy(
  g,
  { owner, position, homeCityId = null, turn = g.turn } = {},
) {
  const where = point(position);
  if (!where) throw new LogisticsError("수송대 출발 위치를 확인해 주세요.");
  ensureLogisticsState(g);
  g.units ??= [];
  const convoy = {
    id: nextId(g, "convoy"),
    owner,
    type: "convoy",
    q: where.q,
    r: where.r,
    hp: 100,
    size: 1,
    xp: 0,
    movesLeft: TYPES.convoy?.movement ?? 2,
    charges: 0,
    homeCityId,
    logisticsInternal: true,
    logisticsSpawned: true,
    logisticsCreatedTurn: finite(turn, g.turn),
    manpowerCost: 0,
    manpowerSources: [],
    cargo: [],
  };
  normalizeUnit(convoy);
  g.units.push(convoy);
  return convoy;
}

function retireInternalConvoy(g, shipment, turn = g.turn) {
  if (shipment?.carrierType !== "convoy") return false;
  const carrier = unitById(g, shipment.carrierId);
  if (!carrier?.logisticsSpawned) return false;
  carrier.cargo = [];
  carrier.logisticsRetiredTurn = finite(turn, g.turn);
  const index = (g.units ?? []).findIndex((unit) => unit.id === carrier.id);
  if (index >= 0) g.units.splice(index, 1);
  return true;
}

function nextId(g, prefix = "shipment") {
  const state = logisticsState(g);
  const id = `${prefix}-${state.nextId}`;
  state.nextId += 1;
  return id;
}

function logisticsState(g) {
  if (!g || typeof g !== "object") throw new LogisticsError("게임 상태가 필요해요.");
  if (!g.logistics || typeof g.logistics !== "object" || Array.isArray(g.logistics))
    g.logistics = {};
  const state = g.logistics;
  state.version = Number.isInteger(state.version)
    ? state.version
    : LOGISTICS_VERSION;
  if (!Array.isArray(state.shipments)) {
    const legacy = Array.isArray(state.cargo)
      ? state.cargo
      : Array.isArray(g.cargo)
        ? g.cargo
        : [];
    state.shipments = legacy;
  }
  state.roads = Array.isArray(state.roads) ? state.roads : [];
  state.merchantOrders = Array.isArray(state.merchantOrders)
    ? state.merchantOrders
    : [];
  state.events = Array.isArray(state.events) ? state.events : [];
  state.nextId = Number.isInteger(state.nextId) && state.nextId > 0
    ? state.nextId
    : 1;
  state.supported = state.supported !== false;
  return state;
}

function normalizeShipment(shipment, g) {
  if (!shipment || typeof shipment !== "object") return null;
  shipment.id = typeof shipment.id === "string" && shipment.id
    ? shipment.id
    : randomUUID();
  shipment.kind = ["food", "resource", "unit"].includes(shipment.kind)
    ? shipment.kind
    : shipment.resource
      ? "resource"
      : shipment.unitId
        ? "unit"
        : "food";
  shipment.status = Object.values(SHIPMENT_STATUS).includes(shipment.status)
    ? shipment.status
    : SHIPMENT_STATUS.IN_TRANSIT;
  shipment.amount = shipment.kind === "unit"
    ? 1
    : Math.max(0, finite(shipment.amount));
  shipment.resource = shipment.kind === "resource"
    ? (Object.hasOwn(RESOURCES, shipment.resource) ? shipment.resource : null)
    : null;
  shipment.originOwner ??= shipment.owner ?? null;
  shipment.owner ??= shipment.originOwner ?? null;
  shipment.recipient ??= shipment.toOwner ?? null;
  // Keep the original counterparty durable even after a captured load is
  // returned to the captor's city.  Public notices for the seller/buyer must
  // not silently switch to the captor merely because the live recipient was
  // rewritten for the return leg.
  shipment.originalRecipient ??= shipment.recipient ?? null;
  shipment.fromCityId ??= null;
  shipment.toCityId ??= null;
  shipment.toUnitId ??= null;
  shipment.carrierId ??= null;
  shipment.carrierType ??= shipment.kind === "unit" ? "unit" : "convoy";
  shipment.position = clonePoint(shipment.position ?? shipment);
  if (!shipment.position) {
    const origin = cityById(g, shipment.fromCityId);
    shipment.position = clonePoint(origin);
  }
  shipment.path = Array.isArray(shipment.path)
    ? shipment.path.map(point).filter(Boolean).slice(0, MAX_ROUTE)
    : [];
  shipment.pathIndex = Number.isInteger(shipment.pathIndex) && shipment.pathIndex >= 0
    ? shipment.pathIndex
    : 0;
  shipment.pathIndex = Math.min(
    shipment.pathIndex,
    Math.max(0, shipment.path.length - 1),
  );
  shipment.blockedTiles = Array.isArray(shipment.blockedTiles)
    ? shipment.blockedTiles.filter((value) => typeof value === "string").slice(0, MAX_ROUTE)
    : [];
  shipment.paused = shipment.paused === true;
  shipment.delivered = shipment.status === SHIPMENT_STATUS.DELIVERED;
  shipment.settled = shipment.settled === true || shipment.delivered;
  return shipment;
}

function normalizeUnit(unit) {
  if (!unit || typeof unit !== "object") return;
  unit.foodStock = Math.max(0, finite(unit.foodStock));
  const demand = unitFoodDemand(unit);
  const defaultCapacity = Math.max(4, Math.ceil(Math.max(1, demand) * 4));
  unit.foodCapacity = Math.max(
    defaultCapacity,
    finite(unit.foodCapacity, defaultCapacity),
  );
  const requestedReserve =
    unit.targetReserve == null
      ? Math.max(demand, unit.foodCapacity / 2)
      : finite(unit.targetReserve);
  unit.targetReserve = Math.max(
    0,
    Math.min(unit.foodCapacity, requestedReserve),
  );
  unit.hungerTurns = Math.max(0, finite(unit.hungerTurns));
  unit.foodPenalty = Math.max(0, finite(unit.foodPenalty));
  unit.foodConsumedTurn ??= null;
  if (unit.type === "convoy") {
    unit.logisticsInternal = true;
    unit.manpowerCost = 0;
    unit.manpowerSources = [];
    unit.mobilized = false;
    unit.recruitmentMode = "logistics";
  }
}

/** Additive save/restore migration.  Existing ON stocks and shipments stay intact. */
export function ensureLogisticsState(g) {
  const state = logisticsState(g);
  for (const shipment of state.shipments) normalizeShipment(shipment, g);
  state.shipments = state.shipments.filter(Boolean);
  const usedSerials = state.shipments
    .map((shipment) => Number(String(shipment.id).match(/-(\d+)$/)?.[1]))
    .filter(Number.isInteger);
  if (usedSerials.length)
    state.nextId = Math.max(state.nextId, ...usedSerials.map((value) => value + 1));
  // g.cargo is a compatibility alias consumed by older observation helpers;
  // it points at the same ledger and never represents a second inventory.
  g.cargo = state.shipments;
  for (const city of g.cities ?? []) {
    city.food = Math.max(0, finite(city.food));
    if (city.suspendedFoodStock != null)
      city.suspendedFoodStock = Math.max(0, finite(city.suspendedFoodStock));
    if (city.foodTargetReserve != null)
      city.foodTargetReserve = Math.max(0, finite(city.foodTargetReserve));
    if (city.targetReserve != null)
      city.targetReserve = Math.max(0, finite(city.targetReserve));
  }
  for (const unit of g.units ?? []) normalizeUnit(unit);
  return g;
}

export function cityFoodCapacity(city, militaryFood = 0) {
  const residents = Math.max(1, finite(city?.population) + finite(militaryFood));
  return Math.max(16, Math.ceil(residents * FOOD_STORAGE_PER_POP));
}

export function unitFoodDemand(unit, g = {}) {
  if (g.experiment && g.experimentCosts?.upkeep !== true) return 0;
  if (!unit || unit.type === "convoy") return 0;
  if (positive(unit.foodConsumption ?? unit.foodPerTurn ?? unit.foodUse))
    return Math.max(0, finite(unit.foodConsumption ?? unit.foodPerTurn ?? unit.foodUse));
  if (!unitIsCivilian(unit)) {
    const manpower = Math.max(
      0.5,
      finite(unit.manpowerCost, 0.5 * Math.max(1, finite(unit.size, 1))),
    );
    return manpower * 2;
  }
  return DEFAULT_CIVILIAN_FOOD;
}

export function unitFoodCapacity(unit) {
  normalizeUnit(unit);
  return unit.foodCapacity;
}

/** Initial spawn hook: seed a unit's personal reserve without debiting a city. */
export function seedUnitFood(g, unit, { amount = null, targetReserve = null } = {}) {
  ensureLogisticsState(g);
  normalizeUnit(unit);
  const seeded = amount == null ? unit.foodCapacity : Math.max(0, finite(amount));
  unit.foodCapacity = Math.max(unit.foodCapacity, seeded);
  unit.foodStock = Math.min(unit.foodCapacity, seeded);
  unit.targetReserve = Math.max(
    0,
    Math.min(
      unit.foodCapacity,
      targetReserve == null ? unit.foodStock : finite(targetReserve),
    ),
  );
  unit.initialFoodSeeded = true;
  return {
    unitId: unit.id,
    foodStock: unit.foodStock,
    foodCapacity: unit.foodCapacity,
    targetReserve: unit.targetReserve,
  };
}

/**
 * Merge hook for combat formations.  Food and held cargo move with the
 * surviving formation; the source is emptied so removing it cannot duplicate
 * a reserve.  The caller remains responsible for combat XP/manpower rules.
 */
export function mergeUnitLogistics(g, target, source) {
  ensureLogisticsState(g);
  normalizeUnit(target);
  normalizeUnit(source);
  const total = Math.max(0, target.foodStock) + Math.max(0, source.foodStock);
  target.foodCapacity = Math.max(target.foodCapacity, total);
  target.foodStock = total;
  target.targetReserve = Math.min(
    target.foodCapacity,
    Math.max(0, target.targetReserve) + Math.max(0, source.targetReserve),
  );
  target.cargo = Array.isArray(target.cargo) ? target.cargo : [];
  for (const entry of Array.isArray(source.cargo) ? source.cargo : []) {
    if (!target.cargo.some((held) => held.shipmentId === entry.shipmentId))
      target.cargo.push({ ...entry });
  }
  for (const shipment of logisticsState(g).shipments) {
    if (shipment.carrierId === source.id) shipment.carrierId = target.id;
    if (shipment.capturedBy === source.id) shipment.capturedBy = target.id;
  }
  source.foodStock = 0;
  source.targetReserve = 0;
  source.cargo = [];
  return {
    targetId: target.id,
    sourceId: source.id,
    foodStock: target.foodStock,
    cargoCount: target.cargo.length,
  };
}

function localSupplyCity(g, unit) {
  // Local handoff is deliberately limited to a garrison on the city's own
  // tile.  A home-city link is provenance for reserves, not a remote pipe;
  // distant units must receive a physical unit shipment instead.
  return (g.cities ?? []).find(
    (city) =>
      city.owner === unit.owner &&
      !city.camp &&
      living(city) &&
      equal(city, unit),
  );
}

/** Feed an own-city garrison from local city.food before personal consumption. */
export function supplyLocalUnit(g, unit, { turn = g.turn } = {}) {
  ensureLogisticsState(g);
  normalizeUnit(unit);
  if (!isSupplyOn(g) || !living(unit) || !unitFoodDemand(unit, g))
    return { active: false, unitId: unit.id, transferred: 0 };
  if (unit.localSupplyTurn === turn)
    return {
      active: true,
      unitId: unit.id,
      transferred: unit.localSupplyLast ?? 0,
      duplicate: true,
    };
  const city = localSupplyCity(g, unit);
  const target = Math.max(0, Math.min(unit.foodCapacity, unit.targetReserve));
  const transferable = city
    ? Math.max(0, Math.min(city.food, target - unit.foodStock))
    : 0;
  if (transferable > 0) {
    city.food -= transferable;
    unit.foodStock += transferable;
  }
  unit.localSupplyTurn = turn;
  unit.localSupplyLast = transferable;
  return {
    active: true,
    unitId: unit.id,
    cityId: city?.id ?? null,
    transferred: transferable,
    remainingCityFood: city?.food ?? null,
  };
}

export function supplyLocalUnits(g, { owner = null, turn = g.turn } = {}) {
  ensureLogisticsState(g);
  return (g.units ?? [])
    .filter((unit) => (!owner || unit.owner === owner) && living(unit))
    .map((unit) => supplyLocalUnit(g, unit, { turn }));
}

/**
 * Voluntary demobilization/removal hook.  Manpower/XP accounting remains in
 * economy/engine; this hook only prevents personal food and held cargo from
 * being copied when the unit object is removed.  A surviving unit at its own
 * city may return unused food into that city's ON stock up to capacity.  A
 * remote unit (or OFF mode) cannot teleport a reserve home: its remaining
 * personal food is explicitly reported as lost, just like a combat death.
 */
export function demobilizeUnitLogistics(
  g,
  unit,
  { destinationCityId = null, turn = g.turn, reason = "unit-demobilized" } = {},
) {
  ensureLogisticsState(g);
  normalizeUnit(unit);
  const result = {
    unitId: unit?.id ?? null,
    returnedFood: 0,
    lostFood: Math.max(0, finite(unit?.foodStock)),
    lostCargo: [],
    destinationCityId: null,
    active: isSupplyOn(g) && living(unit),
  };
  if (result.active && unit.foodStock > 0) {
    const destination = destinationCityId
      ? cityById(g, destinationCityId)
      : localSupplyCity(g, unit);
    if (
      destination &&
      destination.owner === unit.owner &&
      !destination.camp &&
      equal(destination, unit)
    ) {
      const room = Math.max(0, cityFoodCapacity(destination) - destination.food);
      result.returnedFood = Math.min(room, unit.foodStock);
      destination.food += result.returnedFood;
      result.lostFood -= result.returnedFood;
      result.destinationCityId = destination.id;
    }
  }
  unit.foodStock = 0;
  unit.targetReserve = 0;
  for (const shipment of logisticsState(g).shipments) {
    if (
      (shipment.carrierId === unit.id ||
        (shipment.capturedBy === unit.id && shipment.status === SHIPMENT_STATUS.CAPTURED)) &&
      !TERMINAL.has(shipment.status)
    ) {
      if (markLost(g, shipment, reason, turn)) result.lostCargo.push(shipment.id);
    }
  }
  unit.cargo = [];
  unit.logisticsDemobilizedTurn = finite(turn, g.turn);
  return result;
}

export const releaseUnitLogistics = demobilizeUnitLogistics;

/** Combat/save hook: a destroyed carrier loses held cargo exactly once. */
export function markCarrierDestroyed(g, unitId, turn = g.turn) {
  ensureLogisticsState(g);
  const lost = [];
  for (const shipment of logisticsState(g).shipments) {
    if (TERMINAL.has(shipment.status)) continue;
    // Once a load has been captured, the original carrier no longer owns the
    // cargo.  Destroying that carrier must not destroy the captured load; the
    // captor's later death is the event that loses it.
    const carrierDestroyed =
      shipment.carrierId === unitId &&
      shipment.status !== SHIPMENT_STATUS.CAPTURED &&
      // During a return leg carrierId is the newly spawned return convoy;
      // that carrier's loss is real.  Only the stale pre-capture carrier is
      // ignored while a load is still being held by a looter.
      !(shipment.status === SHIPMENT_STATUS.RETURNING &&
        shipment.returnCarrierId !== unitId);
    const captorDestroyed =
      shipment.capturedBy === unitId && shipment.status === SHIPMENT_STATUS.CAPTURED;
    if (carrierDestroyed || captorDestroyed) {
      if (markLost(g, shipment, "운송 유닛이 파괴됐어요.", turn)) lost.push(shipment.id);
    }
  }
  const unit = unitById(g, unitId);
  if (unit) unit.cargo = [];
  return lost;
}

export function resourceCapacity(g, owner) {
  return (g.cities ?? [])
    .filter((city) => city.owner === owner && !city.camp && living(city))
    .reduce((sum, city) => sum + Math.max(0, finite(city.population)) * RESOURCE_PER_POP, 0);
}

function tileMap(g) {
  return new Map((g.tiles ?? []).map((tile) => [key(tile), tile]));
}

function knownTile(g, tile, knowledge = null) {
  const explicit = knowledge?.knownTiles ?? knowledge?.exploredTiles;
  if (explicit instanceof Set)
    return explicit.has(key(tile));
  if (Array.isArray(explicit))
    return explicit.some((entry) => key(entry) === key(tile));
  if (explicit && typeof explicit === "object")
    return explicit[key(tile)] === true || explicit[key(tile)]?.explored === true;
  const explored = knowledge?.explored ?? g.explored;
  const owner = knowledge?.owner ?? knowledge?.player;
  if (explored == null) return true;
  const map = owner != null && explored?.[owner] != null
    ? explored[owner]
    : explored;
  if (map instanceof Set) return map.has(key(tile));
  if (Array.isArray(map)) return map.some((entry) => key(entry) === key(tile));
  if (map && typeof map === "object")
    return map[key(tile)] === true || map[key(tile)]?.explored === true;
  return false;
}

function route(g, from, to, knowledge = null) {
  if (!from || !to) return null;
  if (equal(from, to)) return [clonePoint(from)];
  const tiles = tileMap(g);
  if (!tiles.size || !tiles.has(key(from)) || !tiles.has(key(to))) return null;
  const queue = [{ point: clonePoint(from), path: [clonePoint(from)] }];
  const seen = new Set([key(from)]);
  const blockedTiles = new Set(knowledge?.blockedTiles ?? []);
  while (queue.length) {
    const current = queue.shift();
    for (const next of neighbors(current.point)) {
      const tile = tiles.get(key(next));
      // Unknown geography is assigned a uniform traversable planning cost.
      // The movement step re-checks the authoritative tile and stalls if it
      // turns out to be a mountain, so a route never reveals hidden terrain
      // through a precomputed public path.
      if (
        !tile ||
        blockedTiles.has(key(next)) ||
        (knownTile(g, tile, knowledge) && tile.terrain === "mountain") ||
        seen.has(key(next))
      )
        continue;
      const path = [...current.path, clonePoint(next)];
      if (path.length > MAX_ROUTE) continue;
      if (equal(next, to)) return path;
      seen.add(key(next));
      queue.push({ point: clonePoint(next), path });
    }
  }
  return null;
}

export function findLogisticsRoute(g, from, to, knowledge = null) {
  return route(g, point(from), point(to), knowledge);
}

function setPath(g, shipment, from, to, knowledge = shipment.routeKnowledge ?? null) {
  const path = route(g, from, to, {
    ...(knowledge ?? {}),
    blockedTiles: shipment.blockedTiles ?? [],
  });
  if (!path) return false;
  shipment.path = path;
  shipment.pathIndex = 0;
  shipment.position = clonePoint(path[0]);
  shipment.routeTarget = clonePoint(to);
  shipment.status = shipment.status === SHIPMENT_STATUS.BLOCKED
    ? SHIPMENT_STATUS.IN_TRANSIT
    : shipment.status;
  shipment.blockedReason = null;
  return true;
}

function recordRoad(g, from, to) {
  if (!from || !to || distance(from, to) !== 1) return;
  const state = logisticsState(g);
  const edge = edgeKey(from, to);
  if (!state.roads.some((entry) =>
    typeof entry === "string" ? entry === edge : entry?.edge === edge,
  ))
    state.roads.push(edge);
}

export function hasRoad(g, from, to) {
  const edge = edgeKey(from, to);
  return logisticsState(g).roads.some((entry) =>
    typeof entry === "string" ? entry === edge : entry?.edge === edge,
  );
}

/** Engine movement hook: an established logistics edge halves edge cost. */
export function logisticsMovementCost(g, from, to, baseCost = 1) {
  const base = Math.max(1, finite(baseCost, 1));
  return hasRoad(g, from, to) ? Math.max(0.5, base / 2) : base;
}

function requireCity(g, id, owner, label = "도시") {
  const city = cityById(g, id);
  if (!city || !living(city)) throw new LogisticsError(`${label}를 확인해 주세요.`);
  if (owner != null && city.owner !== owner)
    throw new LogisticsError(`${label}의 소유권을 확인해 주세요.`);
  return city;
}

function requireUnit(g, id, owner = null) {
  const unit = unitById(g, id);
  if (!unit || !living(unit)) throw new LogisticsError("운송 유닛을 확인해 주세요.");
  if (owner != null && unit.owner !== owner)
    throw new LogisticsError("운송 유닛의 소유권을 확인해 주세요.");
  return unit;
}

function assertAmount(amount, label = "수량") {
  if (!positive(amount) || finite(amount) > 100000)
    throw new LogisticsError(`${label}은 0보다 큰 유한 수량이어야 해요.`);
  return finite(amount);
}

function pushEvent(g, event) {
  const state = logisticsState(g);
  state.events.push({ turn: finite(g.turn, 1), ...event });
  if (state.events.length > 80) state.events.splice(0, state.events.length - 80);
}

function createShipment(g, spec) {
  ensureLogisticsState(g);
  const {
    kind,
    owner,
    recipient,
    fromCityId,
    toCityId = null,
    toUnitId = null,
    amount,
    resource = null,
    carrierId = null,
    carrierType,
    mode = "manual",
    turn = g.turn,
    escrowed = false,
    escrowId = null,
    visibility = null,
  } = spec;
  let shipmentCarrierId = carrierId;
  let shipmentCarrierType = carrierType;
  if (!Object.hasOwn({ food: true, resource: true }, kind))
    throw new LogisticsError("운송 종류를 확인해 주세요.");
  const quantity = assertAmount(amount);
  if (kind === "food" && !isSupplyOn(g))
    throw new LogisticsError("식량 물리 운송은 상세 보급 ON에서만 사용할 수 있어요.");
  if (kind === "resource" && !Object.hasOwn(RESOURCES, resource))
    throw new LogisticsError("운송 자원을 확인해 주세요.");
  const source = requireCity(g, fromCityId, owner, "출발 도시");
  let destination = null;
  let destinationUnit = null;
  if (toUnitId) {
    destinationUnit = requireUnit(g, toUnitId, recipient);
  } else {
    destination = requireCity(g, toCityId, recipient, "도착 도시");
  }
  if (!recipient || factionIsBarbarian(g, recipient))
    throw new LogisticsError("도착 문명을 확인해 주세요.");
  if (carrierId) {
    const carrier = requireUnit(g, carrierId, owner);
    shipmentCarrierType ??= carrier.type;
    if (!['merchant', 'convoy'].includes(shipmentCarrierType))
      throw new LogisticsError("상인 또는 보급 수송대만 일반 화물을 운반할 수 있어요.");
    if (carrier.type !== shipmentCarrierType)
      throw new LogisticsError("운송 유닛의 종류와 화물 운송 방식이 맞지 않아요.");
    if (kind !== "unit" && (stateForActiveCarrier(g, carrierId).length ?? 0) > 0)
      throw new LogisticsError("상인은 한 번에 하나의 운송만 맡을 수 있어요.");
    if (!equal(carrier, source))
      throw new LogisticsError("상인은 출발 도시에 도착한 뒤 화물을 실을 수 있어요.");
  }
  const originPoint = cityPoint(source);
  const destinationPoint = destinationUnit ? unitPoint(destinationUnit) : cityPoint(destination);
  if (!originPoint || !destinationPoint)
    throw new LogisticsError("출발·도착 위치를 확인해 주세요.");
  const path = route(g, originPoint, destinationPoint, visibility ?? { owner });
  if (!path) throw new LogisticsError("운송 가능한 실제 타일 경로가 없어요.");
  if (kind === "food") {
    if (!escrowed && source.food < quantity)
      throw new LogisticsError("출발 도시의 저장 식량이 부족해요.");
  } else if (!escrowed && stockpile(g, owner)[resource] < quantity) {
    throw new LogisticsError("국가 자원이 부족해요.");
  }
  // Every ordinary food/resource dispatch has a physical transport wrapper.
  // A supplied merchant/other carrier remains authoritative; only an absent
  // carrier gets an internal convoy, including manual bulk and unit food.
  if (!shipmentCarrierId && kind !== "unit") {
    const convoy = spawnInternalConvoy(g, {
      owner,
      position: originPoint,
      homeCityId: source.id,
      turn,
    });
    shipmentCarrierId = convoy.id;
    shipmentCarrierType = "convoy";
  }
  const id = nextId(g, kind === "food" ? "food" : "resource");
  const shipment = {
    id,
    kind,
    amount: quantity,
    resource: kind === "resource" ? resource : null,
    originOwner: owner,
    owner,
    recipient,
    originalRecipient: recipient,
    fromCityId: source.id,
    toCityId: destination?.id ?? null,
    toUnitId: destinationUnit?.id ?? null,
    carrierId: shipmentCarrierId,
    carrierType: shipmentCarrierType ?? (shipmentCarrierId ? "merchant" : "convoy"),
    mode,
    status: SHIPMENT_STATUS.IN_TRANSIT,
    position: clonePoint(path[0]),
    path,
    pathIndex: 0,
    createdTurn: finite(turn, g.turn),
    deliveredTurn: null,
    capturedBy: null,
    paused: false,
    settled: false,
    escrowed: !!escrowed,
    escrowId,
    // Keep only serializable identity; explored tile sets are an observation
    // input, never durable hidden state.
    routeKnowledge: visibility
      ? { owner: visibility.owner ?? visibility.player ?? owner }
      : null,
  };
  // Escrow is the only immediate inventory mutation.  Arrival is the only
  // place that credits the recipient, which keeps retries and save/restore exact.
  if (!escrowed) {
    if (kind === "food") source.food -= quantity;
    else stockpile(g, owner)[resource] -= quantity;
  }
  logisticsState(g).shipments.push(shipment);
  pushEvent(g, {
    type: "shipment-created",
    shipmentId: id,
    kind,
    owner,
    recipient,
    amount: quantity,
  });
  return shipment;
}

function stateForActiveCarrier(g, carrierId) {
  return logisticsState(g).shipments.filter(
    (shipment) =>
      shipment.carrierId === carrierId &&
      ACTIVE.has(shipment.status),
  );
}

export function createFoodShipment(g, options) {
  return createShipment(g, { ...options, kind: "food" });
}

export function createResourceShipment(g, options) {
  return createShipment(g, { ...options, kind: "resource" });
}

export const dispatchFood = createFoodShipment;
export const dispatchResource = createResourceShipment;

export function setFoodReserve(g, { owner, cityId, targetReserve }) {
  ensureLogisticsState(g);
  const city = requireCity(g, cityId, owner);
  const target = Math.max(0, Math.min(cityFoodCapacity(city), finite(targetReserve)));
  city.foodTargetReserve = target;
  city.targetReserve = target;
  return { cityId, targetReserve: target };
}

export function setUnitReserve(g, { owner, unitId, targetReserve }) {
  ensureLogisticsState(g);
  const unit = requireUnit(g, unitId, owner);
  normalizeUnit(unit);
  const target = Math.max(0, Math.min(unit.foodCapacity, finite(targetReserve)));
  unit.targetReserve = target;
  return { unitId, targetReserve: target, foodCapacity: unit.foodCapacity };
}

export function dispatchAutomaticFood(g, { owner, turn = g.turn } = {}) {
  ensureLogisticsState(g);
  if (!isSupplyOn(g)) return [];
  const cities = (g.cities ?? []).filter(
    (city) => city.owner === owner && !city.camp && living(city),
  );
  // City food is escrowed when a shipment is created, but incoming cargo is
  // not credited until its physical convoy arrives. Count that in-flight
  // amount against the destination's reserve so repeated turn hooks do not
  // create duplicate automatic convoys for the same deficit.
  const pendingToCity = new Map();
  for (const shipment of logisticsState(g).shipments) {
    if (
      shipment.kind !== "food" ||
      shipment.toUnitId ||
      !shipment.toCityId ||
      shipment.recipient !== owner ||
      !ACTIVE.has(shipment.status)
    )
      continue;
    pendingToCity.set(
      shipment.toCityId,
      (pendingToCity.get(shipment.toCityId) ?? 0) + Math.max(0, finite(shipment.amount)),
    );
  }
  const sources = cities
    .map((city) => ({
      city,
      surplus: Math.max(0, city.food - finite(city.foodTargetReserve ?? city.targetReserve)),
    }))
    .filter((entry) => entry.surplus > 0)
    .sort((a, b) => b.surplus - a.surplus || a.city.id.localeCompare(b.city.id));
  const destinations = cities
    .map((city) => ({
      city,
      pending: pendingToCity.get(city.id) ?? 0,
      deficit: Math.max(
        0,
        finite(city.foodTargetReserve ?? city.targetReserve) -
          city.food -
          (pendingToCity.get(city.id) ?? 0),
      ),
    }))
    .filter((entry) => entry.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit || a.city.id.localeCompare(b.city.id));
  const created = [];
  for (const destination of destinations) {
    const source = sources.find(
      (entry) => entry.city.id !== destination.city.id && entry.surplus > 0,
    );
    if (!source) continue;
    const amount = Math.min(source.surplus, destination.deficit);
    try {
      const shipment = createFoodShipment(g, {
        owner,
        recipient: owner,
        fromCityId: source.city.id,
        toCityId: destination.city.id,
        amount,
        mode: "automatic",
        turn,
      });
      source.surplus -= amount;
      destination.deficit -= amount;
      created.push(shipment);
    } catch {
      // A particular pair can be disconnected or full.  The next pair may
      // still be legal; do not partially debit a failed attempt.
    }
  }
  // Units have their own physical reserves.  After city-to-city balancing,
  // use any remaining city surplus for a deterministic city-to-unit convoy.
  // Pending shipments count toward the target so repeated observations or
  // turn hooks cannot dispatch the same reserve twice.
  const unitSources = sources.filter((entry) => entry.surplus > 0);
  for (const unit of (g.units ?? [])
    .filter((candidate) => candidate.owner === owner && living(candidate))
    .filter((candidate) => unitFoodDemand(candidate, g) > 0)) {
    normalizeUnit(unit);
    const pending = logisticsState(g).shipments
      .filter(
        (shipment) =>
          shipment.kind === "food" &&
          shipment.toUnitId === unit.id &&
          shipment.recipient === owner &&
          ACTIVE.has(shipment.status),
      )
      .reduce((sum, shipment) => sum + shipment.amount, 0);
    const deficit = Math.max(
      0,
      Math.min(unit.foodCapacity, unit.targetReserve) - unit.foodStock - pending,
    );
    if (deficit <= 0) continue;
    const preferred = unitSources.find(
      (entry) => entry.city.id === unit.homeCityId && entry.surplus > 0,
    );
    const source = preferred ?? unitSources.find((entry) => entry.surplus > 0);
    if (!source) continue;
    const amount = Math.min(deficit, source.surplus);
    try {
      const shipment = createUnitFoodShipment(g, {
        owner,
        recipient: owner,
        fromCityId: source.city.id,
        toUnitId: unit.id,
        amount,
        mode: "automatic-unit",
        turn,
      });
      source.surplus -= amount;
      created.push(shipment);
    } catch {
      // A disconnected unit or a just-occupied destination should not prevent
      // other city/unit routes from being planned this turn.
    }
  }
  return created;
}

export function createUnitFoodShipment(g, options) {
  return createShipment(g, {
    ...options,
    kind: "food",
    toCityId: null,
    toUnitId: options.toUnitId ?? options.unitId,
    mode: options.mode ?? "unit-resupply",
  });
}

/**
 * Convert a finite farm/resource salvage reward into a held physical load.
 * The improvement/combat engine owns eligibility, ruin metadata, healing and
 * reward caps; this hook owns the inventory boundary so a pillage/scorch
 * action cannot credit a city or national stock before the load returns.
 * `autoReturn` is the normal path for a completed improvement action.  Pass
 * false only when the caller intentionally wants the military unit to carry
 * the loot and issue `returnCapturedCargo` later.
 */
export function createPillageCargo(
  g,
  {
    unitId,
    kind,
    amount,
    resource = null,
    toCityId,
    sourceTile = null,
    action = "pillage",
    turn = g.turn,
    autoReturn = true,
  } = {},
) {
  ensureLogisticsState(g);
  const unit = requireUnit(g, unitId);
  if (unitIsCivilian(unit))
    throw new LogisticsError("전투 부대만 약탈·청야 보급품을 운반할 수 있어요.");
  if (!isSupplyOn(g) && kind === "food")
    throw new LogisticsError("보급 OFF에서는 식량을 물리 보급품으로 만들 수 없어요.");
  if (!Object.hasOwn({ food: true, resource: true }, kind))
    throw new LogisticsError("약탈 화물 종류를 확인해 주세요.");
  const quantity = assertAmount(amount, "약탈 보상");
  if (kind === "resource" && !Object.hasOwn(RESOURCES, resource))
    throw new LogisticsError("약탈 자원을 확인해 주세요.");
  const destination = toCityId
    ? requireCity(g, toCityId, unit.owner, "보급을 받을 도시")
    : null;
  const path = destination
    ? route(g, unitPoint(unit), cityPoint(destination), { owner: unit.owner })
    : null;
  const shipment = {
    id: nextId(g, "loot"),
    kind,
    amount: quantity,
    resource: kind === "resource" ? resource : null,
    originOwner: unit.owner,
    owner: unit.owner,
    recipient: unit.owner,
    originalRecipient: unit.owner,
    fromCityId: null,
    toCityId: destination?.id ?? null,
    toUnitId: null,
    carrierId: unit.id,
    carrierType: unit.type,
    mode: action === "scorch" ? "scorch-loot" : "pillage-loot",
    status: SHIPMENT_STATUS.CAPTURED,
    position: clonePoint(unit),
    path,
    pathIndex: 0,
    routeTarget: destination ? clonePoint(destination) : null,
    createdTurn: finite(turn, g.turn),
    deliveredTurn: null,
    capturedBy: unit.id,
    cargoOwner: unit.owner,
    paused: false,
    settled: false,
    escrowed: true,
    escrowId: null,
    lootSourceTile: clonePoint(sourceTile ?? unit),
    lootAction: action,
  };
  logisticsState(g).shipments.push(shipment);
  heldCargo(unit, shipment);
  pushEvent(g, {
    type: "pillage-cargo-created",
    shipmentId: shipment.id,
    unitId: unit.id,
    owner: unit.owner,
    kind,
    amount: quantity,
  });
  // A legal improvement action must succeed even while the raider is
  // encircled or has no surviving home city. In that case the loot remains
  // visibly held by the unit; a later explicit return command may choose a
  // reachable own city.
  if (!autoReturn || !destination || !path) return shipment;
  return returnCapturedCargo(g, {
    shipmentId: shipment.id,
    unitId: unit.id,
    toCityId: destination.id,
    turn,
  });
}

export const createLootCargo = createPillageCargo;

export function scheduleUnitTrade(
  g,
  { unitId, fromOwner = null, recipient, toCityId, turn = g.turn } = {},
) {
  ensureLogisticsState(g);
  const unit = requireUnit(g, unitId, fromOwner);
  const destination = requireCity(g, toCityId, recipient, "도착 도시");
  if (unit.owner === recipient) throw new LogisticsError("같은 문명으로 유닛을 넘길 수 없어요.");
  const start = unitPoint(unit);
  const target = cityPoint(destination);
  const path = route(g, start, target, { owner: unit.owner });
  if (!path) throw new LogisticsError("거래 유닛의 실제 이동 경로가 없어요.");
  if (unit.tradeShipmentId) {
    const existing = logisticsState(g).shipments.find(
      (shipment) => shipment.id === unit.tradeShipmentId && ACTIVE.has(shipment.status),
    );
    if (existing) throw new LogisticsError("이 유닛은 이미 이동 중인 거래 명령이 있어요.");
  }
  const originOwner = unit.owner;
  // Controller changes immediately, while the unit remains at its current
  // tile.  Keep manpower sources as historical records; only controller
  // ownership changes, so a later disband cannot mint a second ledger.
  unit.owner = recipient;
  unit.manpowerOwner = recipient;
  unit.controllerTransferHistory = Array.isArray(unit.controllerTransferHistory)
    ? unit.controllerTransferHistory
    : [];
  unit.controllerTransferHistory.push({ from: originOwner, to: recipient, turn });
  unit.tradeDestinationCityId = destination.id;
  unit.order = {
    type: "tradeTransfer",
    toCityId: destination.id,
    shipmentId: null,
  };
  unit.movesLeft = 0;
  unit.attackUsed = true;
  unit.acted = true;
  const shipment = {
    id: nextId(g, "unit-trade"),
    kind: "unit",
    amount: 1,
    resource: null,
    unitId: unit.id,
    originOwner,
    owner: recipient,
    recipient,
    originalRecipient: recipient,
    fromCityId: unit.homeCityId ?? null,
    toCityId: destination.id,
    toUnitId: null,
    carrierId: unit.id,
    carrierType: "unit",
    mode: "trade-unit",
    status: SHIPMENT_STATUS.IN_TRANSIT,
    position: clonePoint(start),
    path,
    pathIndex: 0,
    createdTurn: finite(turn, g.turn),
    deliveredTurn: null,
    capturedBy: null,
    paused: false,
    settled: false,
  };
  logisticsState(g).shipments.push(shipment);
  unit.tradeShipmentId = shipment.id;
  unit.order.shipmentId = shipment.id;
  return shipment;
}

export function scheduleMerchantRoute(
  g,
  {
    merchantId,
    owner = null,
    fromCityId,
    toCityId,
    recipient,
    kind = "resource",
    resource = null,
    amount,
    turn = g.turn,
  } = {},
) {
  const merchant = requireUnit(g, merchantId, owner);
  if (merchant.type !== "merchant")
    throw new LogisticsError("상인 유닛만 교역로를 운행할 수 있어요.");
  return createShipment(g, {
    kind,
    owner: merchant.owner,
    recipient: recipient ?? merchant.owner,
    fromCityId,
    toCityId,
    amount,
    resource,
    carrierId: merchant.id,
    carrierType: "merchant",
    mode: "merchant-route",
    turn,
  });
}

function tradingPost(city) {
  const raw = city?.tradingPost ?? city?.tradePost ?? city?.tradingpost ??
    city?.buildings?.tradingPost ?? city?.buildings?.tradingpost;
  return raw === true || (raw && typeof raw === "object" && raw.built !== false)
    ? (raw === true ? {} : raw)
    : null;
}

export function merchantSummary(g, city) {
  if (!city)
    return {
      built: false,
      capacity: 0,
      active: 0,
      traveling: 0,
      ordered: 0,
      productionQueued: 0,
      inUse: 0,
      remaining: 0,
    };
  const post = tradingPost(city);
  const active = (g.units ?? []).filter(
    (unit) =>
      unit.type === "merchant" &&
      living(unit) &&
      unit.owner === city.owner &&
      (unit.tradingPostCityId === city.id || unit.homeCityId === city.id),
  ).length;
  const traveling = logisticsState(g).shipments.filter(
    (shipment) =>
      shipment.carrierType === "merchant" &&
      shipment.fromCityId === city.id &&
      ACTIVE.has(shipment.status),
  ).length;
  const queuedOrders = logisticsState(g).merchantOrders.filter(
    (order) => order.cityId === city.id && ["queued", "pending"].includes(order.status),
  ).length;
  // The engine's ordinary production queue is authoritative too.  A
  // `queueMerchant` action may be routed through that queue rather than this
  // module's optional merchantOrders ledger; both must occupy the one slot.
  const productionQueued = city.queue === "merchant" ? 1 : 0;
  const ordered = queuedOrders + productionQueued;
  const capacity = post ? 1 : 0;
  const inUse = Math.min(capacity, Math.max(active, traveling + active) + ordered);
  return {
    built: !!post,
    capacity,
    active,
    traveling,
    ordered,
    productionQueued,
    inUse,
    remaining: Math.max(0, capacity - inUse),
  };
}

export function queueMerchant(g, { owner, cityId, turn = g.turn } = {}) {
  ensureLogisticsState(g);
  const city = requireCity(g, cityId, owner);
  const summary = merchantSummary(g, city);
  if (!summary.built) throw new LogisticsError("먼저 도시에 교역소를 건설해 주세요.");
  if (summary.inUse >= 1)
    throw new LogisticsError("도시의 교역소 상인 정원은 1명이에요.");
  const order = {
    id: nextId(g, "merchant-order"),
    owner,
    cityId,
    status: "queued",
    requestedTurn: finite(turn, g.turn),
  };
  logisticsState(g).merchantOrders.push(order);
  return order;
}

/** Called by the engine only after a trading-post production item completed. */
export function registerMerchant(g, { owner, cityId, merchant = null, orderId = null, turn = g.turn } = {}) {
  ensureLogisticsState(g);
  const city = requireCity(g, cityId, owner);
  const summary = merchantSummary(g, city);
  const order = orderId
    ? logisticsState(g).merchantOrders.find((entry) => entry.id === orderId && entry.status === "queued")
    : logisticsState(g).merchantOrders.find((entry) => entry.cityId === cityId && entry.status === "queued");
  // The queued item itself occupies the one slot, but production completion
  // is allowed to consume that reservation.  Existing active/traveling
  // merchants still make a second registration invalid.
  if (!summary.built || summary.active + summary.traveling >= 1)
    throw new LogisticsError("교역소 상인 정원이 가득 찼어요.");
  if (order) order.status = "completed";
  else if (merchant?.productionComplete !== true)
    throw new LogisticsError("생산 완료된 상인만 배치할 수 있어요.");
  const unit = merchant ?? {
    id: randomUUID(),
    owner,
    type: "merchant",
    q: city.q,
    r: city.r,
    hp: 100,
    size: 1,
    xp: 0,
    movesLeft: 3,
  };
  unit.owner = owner;
  unit.type = "merchant";
  unit.tradingPostCityId = city.id;
  unit.homeCityId = city.id;
  // A newly-produced merchant normally arrives with zero manpower.  Do not
  // erase a pre-existing ledger on an imported/active unit if a caller is
  // registering it after a save migration.
  if (!Number.isFinite(unit.manpowerCost)) unit.manpowerCost = 0;
  if (!Array.isArray(unit.manpowerSources)) unit.manpowerSources = [];
  unit.recruitmentMode ??= "logistics";
  unit.mobilized ??= false;
  normalizeUnit(unit);
  if (!(g.units ?? []).some((entry) => entry.id === unit.id)) {
    g.units ??= [];
    g.units.push(unit);
  }
  pushEvent(g, { type: "merchant-registered", merchantId: unit.id, cityId, turn });
  return unit;
}

function shipmentDestination(g, shipment) {
  if (shipment.kind === "unit") {
    return cityPoint(cityById(g, shipment.toCityId));
  }
  if (shipment.toUnitId) return unitPoint(unitById(g, shipment.toUnitId));
  return cityPoint(cityById(g, shipment.toCityId));
}

function warLedgerHasPair(g, left, right) {
  if (!left || !right || left === right) return false;
  const relationship = pair(left, right);
  if (Array.isArray(g.wars) || g.wars instanceof Set)
    return g.wars.includes?.(relationship) || g.wars.has?.(relationship);
  if (g.wars && typeof g.wars === "object")
    return g.wars[relationship] === true || g.wars[relationship]?.active === true;
  return false;
}

function tradeHostile(g, mover, other, isHostile = null) {
  if (!other || other.owner === mover.owner || other.hostile === false) return false;
  if (typeof isHostile === "function")
    return !!isHostile(g, other, {
      owner: mover.owner,
      originOwner: mover.owner,
      cargoOwner: mover.owner,
    });
  if (factionIsBarbarian(g, other.owner)) return true;
  // A saved match with an explicit war ledger treats absent pairs as peace;
  // old fixtures without a ledger retain the shared hostile-by-default rule.
  return Array.isArray(g.wars) || g.wars instanceof Set || (g.wars && typeof g.wars === "object")
    ? warLedgerHasPair(g, mover.owner, other.owner) || other.hostile === true
    : other.hostile !== false;
}

function hostileMilitaryInZone(g, mover, position, isHostile = null) {
  return (g.units ?? []).some(
    (other) =>
      living(other) &&
      !unitIsCivilian(other) &&
      distance(other, position) === 1 &&
      tradeHostile(g, mover, other, isHostile),
  );
}

function tradeStepIssue(g, unit, next, isHostile = null) {
  const tile = tileMap(g).get(key(next));
  if (!tile || tile.terrain === "mountain") return "다음 거래 유닛 경로가 산지로 막혔어요.";
  const cost = movementCost(
    { a: unitPoint(unit), b: next },
    { tiles: g.tiles ?? [], rivers: g.rivers ?? [], roads: logisticsState(g).roads },
  );
  if (!Number.isFinite(cost)) return "다음 거래 유닛 칸의 이동 비용을 계산할 수 없어요.";
  if (
    (g.units ?? []).some(
      (occupant) => living(occupant) && equal(occupant, next) && blocksUnit(unit, occupant),
    )
  )
    return "다음 거래 유닛 칸이 다른 부대로 막혀 있어요.";
  const foreignCity = (g.cities ?? []).find(
    (city) => living(city) && city.owner !== unit.owner && equal(city, next),
  );
  if (foreignCity) return "적대 도시를 통과할 수 없어 거래 유닛이 멈췄어요.";
  if (hostileMilitaryInZone(g, unit, unitPoint(unit), isHostile))
    return "적군 통제구역에서는 거래 유닛이 이동할 수 없어요.";
  return null;
}

function markBlocked(shipment, reason) {
  shipment.status = SHIPMENT_STATUS.BLOCKED;
  shipment.blockedReason = reason;
  shipment.paused = false;
}

function markLost(g, shipment, reason, turn = g.turn) {
  if (TERMINAL.has(shipment.status)) return false;
  shipment.status = SHIPMENT_STATUS.LOST;
  shipment.lostReason = reason;
  shipment.lostTurn = finite(turn, g.turn);
  shipment.settled = true;
  shipment.paused = false;
  const captor = shipment.capturedBy ? unitById(g, shipment.capturedBy) : null;
  if (captor?.cargo)
    captor.cargo = captor.cargo.filter((entry) => entry.shipmentId !== shipment.id);
  retireInternalConvoy(g, shipment, turn);
  pushEvent(g, { type: "shipment-lost", shipmentId: shipment.id, reason });
  return true;
}

function markDelivered(g, shipment, turn = g.turn) {
  if (TERMINAL.has(shipment.status) || shipment.settled) return false;
  shipment.status = SHIPMENT_STATUS.DELIVERED;
  shipment.delivered = true;
  shipment.settled = true;
  shipment.deliveredTurn = finite(turn, g.turn);
  shipment.paused = false;
  if (shipment.kind === "unit") {
    const unit = unitById(g, shipment.unitId);
    if (unit?.tradeShipmentId === shipment.id) {
      unit.tradeShipmentId = null;
      unit.tradeDestinationCityId = null;
      if (unit.order?.type === "tradeTransfer") unit.order = null;
    }
  }
  const captor = shipment.capturedBy ? unitById(g, shipment.capturedBy) : null;
  if (captor?.cargo)
    captor.cargo = captor.cargo.filter((entry) => entry.shipmentId !== shipment.id);
  retireInternalConvoy(g, shipment, turn);
  pushEvent(g, { type: "shipment-delivered", shipmentId: shipment.id, turn });
  return true;
}

function deliverShipment(g, shipment, turn = g.turn) {
  if (shipment.kind === "unit") return markDelivered(g, shipment, turn);
  if (shipment.kind === "food") {
    if (!isSupplyOn(g)) {
      shipment.paused = true;
      shipment.pausedReason = "supply-off";
      return false;
    }
    if (shipment.toUnitId) {
      const unit = unitById(g, shipment.toUnitId);
      if (!unit || !living(unit)) return markLost(g, shipment, "수신 유닛이 사라졌어요.", turn);
      normalizeUnit(unit);
      if (unit.foodStock + shipment.amount > unit.foodCapacity) {
        markBlocked(shipment, "수신 유닛 식량 적재 한도");
        return false;
      }
      unit.foodStock += shipment.amount;
    } else {
      const city = cityById(g, shipment.toCityId);
      if (!city || !living(city)) return markLost(g, shipment, "수신 도시가 사라졌어요.", turn);
      const capacity = cityFoodCapacity(city);
      if (city.food + shipment.amount > capacity) {
        markBlocked(shipment, "수신 도시 식량 저장 한도");
        return false;
      }
      city.food += shipment.amount;
    }
    return markDelivered(g, shipment, turn);
  }
  const city = cityById(g, shipment.toCityId);
  if (!city || !living(city)) return markLost(g, shipment, "수신 도시가 사라졌어요.", turn);
  const stock = stockpile(g, shipment.recipient);
  const capacity = resourceCapacity(g, shipment.recipient);
  if (stock[shipment.resource] + shipment.amount > capacity) {
    markBlocked(shipment, "수신 국가 자원 저장 한도");
    return false;
  }
  stock[shipment.resource] += shipment.amount;
  return markDelivered(g, shipment, turn);
}

function hostileUnitCanCapture(g, unit, shipment, isHostile) {
  if (!living(unit) || unitIsCivilian(unit) || unit.owner === shipment.owner) return false;
  if (factionIsBarbarian(g, unit.owner)) return true;
  if (typeof isHostile === "function") return !!isHostile(g, unit, shipment);
  if (unit.hostile === true) return true;
  if (Array.isArray(g.wars))
    return g.wars.includes(pair(unit.owner, shipment.owner));
  // A missing war ledger is an old-save compatibility case.  An explicit
  // `hostile:false` descriptor still cannot capture neutral cargo, while an
  // otherwise unspecified military unit retains the legacy hostile default.
  return unit.hostile !== false;
}

function heldCargo(unit, shipment) {
  unit.cargo = Array.isArray(unit.cargo) ? unit.cargo : [];
  const existing = unit.cargo.find((entry) => entry.shipmentId === shipment.id);
  if (existing) return existing;
  const entry = {
    shipmentId: shipment.id,
    kind: shipment.kind,
    resource: shipment.resource,
    amount: shipment.amount,
    originOwner: shipment.originOwner,
    originalRecipient: shipment.originalRecipient ?? shipment.recipient,
    status: "captured",
  };
  unit.cargo.push(entry);
  return entry;
}

export function interceptShipment(
  g,
  { shipmentId, unitId, turn = g.turn, isHostile = null } = {},
) {
  ensureLogisticsState(g);
  const shipment = logisticsState(g).shipments.find((entry) => entry.id === shipmentId);
  const unit = requireUnit(g, unitId);
  if (!shipment || !ACTIVE.has(shipment.status) || shipment.kind === "unit")
    throw new LogisticsError("나포할 운송 화물을 확인해 주세요.");
  if (!equal(shipment.position, unit))
    throw new LogisticsError("같은 타일에서만 화물을 나포할 수 있어요.");
  if (!hostileUnitCanCapture(g, unit, shipment, isHostile))
    throw new LogisticsError("적대 관계의 군사 유닛만 화물을 나포할 수 있어요.");
  shipment.status = SHIPMENT_STATUS.CAPTURED;
  shipment.capturedBy = unit.id;
  shipment.capturedTurn = finite(turn, g.turn);
  shipment.cargoOwner = unit.owner;
  shipment.paused = false;
  heldCargo(unit, shipment);
  // Auto-created convoys are transport wrappers, not capturable standing
  // units. Once their load is looted they leave the roster; an explicit
  // merchant or combat-owned carrier remains for the engine to resolve.
  retireInternalConvoy(g, shipment, turn);
  pushEvent(g, {
    type: "shipment-captured",
    shipmentId,
    captor: unit.owner,
    captorUnitId: unit.id,
  });
  return shipment;
}

export const interceptCargo = interceptShipment;

/**
 * Combat integration hook for a direct attack against an adjacent convoy or
 * merchant.  The combat engine decides damage/destruction; this helper only
 * transfers the finite cargo to the attacking unit and deliberately leaves
 * the attacker on its original tile.
 */
export function captureCarrierCargo(
  g,
  { unitId, carrierId, turn = g.turn, isHostile = null } = {},
) {
  ensureLogisticsState(g);
  const captor = requireUnit(g, unitId);
  const carrier = unitById(g, carrierId);
  // The combat resolver may have applied lethal damage immediately before
  // calling this hook; cargo capture is still resolved in that same atomic
  // attack and must not be mistaken for a later resurrection.
  if (!carrier || carrier.id === captor.id)
    throw new LogisticsError("나포할 운송선을 확인해 주세요.");
  if (distance(captor, carrier) > 1)
    throw new LogisticsError("인접한 운송선만 전투로 나포할 수 있어요.");
  const synthetic = {
    owner: carrier.owner,
    originOwner: carrier.owner,
    position: unitPoint(carrier),
  };
  if (!hostileUnitCanCapture(g, captor, synthetic, isHostile))
    throw new LogisticsError("적대 운송선만 나포할 수 있어요.");
  const captured = [];
  for (const shipment of logisticsState(g).shipments) {
    if (
      shipment.carrierId !== carrier.id ||
      shipment.kind === "unit" ||
      !ACTIVE.has(shipment.status)
    )
      continue;
    // The attacker receives the cargo at its current tile.  This is a state
    // handoff, not a movement or a teleport of either combat unit.
    shipment.position = clonePoint(captor);
    captured.push(
      interceptShipment(g, {
        shipmentId: shipment.id,
        unitId: captor.id,
        turn,
        isHostile: () => true,
      }),
    );
  }
  carrier.cargo = [];
  carrier.logisticsCaptured = captured.length > 0;
  return captured;
}

export function returnCapturedCargo(
  g,
  { shipmentId, unitId, toCityId, turn = g.turn } = {},
) {
  ensureLogisticsState(g);
  const shipment = logisticsState(g).shipments.find((entry) => entry.id === shipmentId);
  const unit = requireUnit(g, unitId);
  if (!shipment || shipment.status !== SHIPMENT_STATUS.CAPTURED || shipment.capturedBy !== unit.id)
    throw new LogisticsError("돌려보낼 나포 화물을 확인해 주세요.");
  const destination = requireCity(g, toCityId, unit.owner, "반환 도시");
  // Plan with the looter's explored geography.  The authoritative tile map
  // must not be used to route a return through an unseen mountain; movement
  // will re-check the actual tile when the convoy reaches each edge.
  const path = route(g, unitPoint(unit), cityPoint(destination), {
    owner: unit.owner,
  });
  if (!path) throw new LogisticsError("나포 화물의 반환 경로가 없어요.");
  const returnConvoy = spawnInternalConvoy(g, {
    owner: unit.owner,
    position: unitPoint(unit),
    homeCityId: destination.id,
    turn,
  });
  const previousCarrierId = shipment.carrierId;
  const originalRecipient = shipment.originalRecipient ?? shipment.recipient ?? null;
  shipment.status = SHIPMENT_STATUS.RETURNING;
  shipment.owner = unit.owner;
  shipment.recipient = unit.owner;
  shipment.originalRecipient = originalRecipient;
  shipment.toCityId = destination.id;
  shipment.toUnitId = null;
  shipment.previousCarrierId = previousCarrierId ?? null;
  shipment.carrierId = returnConvoy.id;
  shipment.carrierType = "convoy";
  shipment.returnCarrierId = returnConvoy.id;
  shipment.position = clonePoint(returnConvoy);
  shipment.path = path;
  shipment.pathIndex = 0;
  shipment.routeTarget = clonePoint(destination);
  shipment.returnedBy = unit.id;
  shipment.returnedTurn = finite(turn, g.turn);
  shipment.paused = false;
  // The cargo leaves the looting unit exactly once when the return convoy is
  // dispatched.  It is represented by the shipment ledger until arrival (or
  // another interception), so retaining a second held entry would duplicate
  // inventory in observations and merges.
  unit.cargo = (unit.cargo ?? []).filter((entry) => entry.shipmentId !== shipment.id);
  return shipment;
}

export const returnCargo = returnCapturedCargo;

function processUnitTrade(g, shipment, turn, { isHostile = null } = {}) {
  const unit = unitById(g, shipment.unitId);
  if (!unit || !living(unit)) return markLost(g, shipment, "거래 유닛이 사라졌어요.", turn);
  shipment.position = clonePoint(unit);
  const destination = shipmentDestination(g, shipment);
  if (!destination) return markLost(g, shipment, "거래 목적지가 사라졌어요.", turn);
  if (equal(unit, destination)) return markDelivered(g, shipment, turn);
  if (shipment.lastMovedTurn === turn) return false;
  if (!shipment.path.length || !equal(shipment.routeTarget, destination)) {
    if (!setPath(g, shipment, unitPoint(unit), destination)) {
      markBlocked(shipment, "거래 유닛 경로 막힘");
      shipment.lastMovedTurn = turn;
      return false;
    }
  }
  // A traded unit starts its first automatic leg with its declared movement
  // budget even though scheduleUnitTrade clears movesLeft to prevent a second
  // hand-written order during the transfer.  Subsequent calls in the same
  // turn reuse the exact remainder, while the carrier's owner gets a fresh
  // budget on the next own turn.
  const budget = Math.max(0, finite(TYPES[unit.type]?.movement, 1));
  let movement = shipment.tradeMovementTurn === turn
    ? Math.max(0, finite(shipment.tradeMovementLeft, 0))
    : budget;
  shipment.tradeMovementTurn = turn;
  if (movement <= 0) {
    shipment.lastMovedTurn = turn;
    unit.movesLeft = 0;
    return false;
  }
  let changed = false;
  if (hostileMilitaryInZone(g, unit, unitPoint(unit), isHostile)) {
    markBlocked(shipment, "적군 통제구역에서는 거래 유닛이 이동할 수 없어요.");
    shipment.tradeMovementLeft = 0;
    shipment.lastMovedTurn = turn;
    unit.movesLeft = 0;
    return false;
  }
  while (movement > 0) {
    const next = shipment.path[shipment.pathIndex + 1];
    if (!next) {
      shipment.tradeMovementLeft = movement;
      unit.movesLeft = movement;
      const delivered = markDelivered(g, shipment, turn);
      return changed || delivered;
    }
    const issue = tradeStepIssue(g, unit, next, isHostile);
    const closedBorder = !canCrossBorder(g, unit, unit, next);
    if (issue || closedBorder) {
      markBlocked(shipment, issue || "국경개방이 필요해요.");
      shipment.tradeMovementLeft = 0;
      shipment.lastMovedTurn = turn;
      unit.movesLeft = 0;
      return changed;
    }
    const from = unitPoint(unit);
    const cost = movementCost(
      { a: from, b: next },
      { tiles: g.tiles ?? [], rivers: g.rivers ?? [], roads: logisticsState(g).roads },
    );
    // As with ordinary movement, a positive budget may enter a single
    // over-cost edge (notably a river crossing); the remainder then clamps to
    // zero instead of allowing an extra edge.
    movement = Math.max(0, movement - cost);
    unit.q = next.q;
    unit.r = next.r;
    shipment.position = clonePoint(unit);
    shipment.pathIndex += 1;
    shipment.lastMovedTurn = turn;
    shipment.status = SHIPMENT_STATUS.IN_TRANSIT;
    shipment.blockedReason = null;
    unit.movesLeft = movement;
    shipment.tradeMovementLeft = movement;
    changed = true;
    // Roads are created by physical merchant/convoy traffic only.  A unit
    // changing controller is not a trade-road carrier and must not mint a
    // road as it walks to its receiving city.
    if (unit.type === "merchant" || unit.type === "convoy") recordRoad(g, from, next);
    if (equal(unit, destination)) return markDelivered(g, shipment, turn) || changed;
    if (hostileMilitaryInZone(g, unit, unitPoint(unit), isHostile)) {
      markBlocked(shipment, "적군 통제구역에 들어가 거래 유닛이 멈췄어요.");
      shipment.tradeMovementLeft = 0;
      unit.movesLeft = 0;
      return changed;
    }
    if (movement <= 0) break;
  }
  shipment.tradeMovementLeft = movement;
  unit.movesLeft = movement;
  return changed;
}

function processShipment(g, shipment, turn, { isHostile = null } = {}) {
  if (TERMINAL.has(shipment.status)) return false;
  if (shipment.status === SHIPMENT_STATUS.CAPTURED) {
    const captor = unitById(g, shipment.capturedBy);
    if (!captor || !living(captor)) return markLost(g, shipment, "나포 유닛이 파괴됐어요.", turn);
    return false;
  }
  if (shipment.carrierId && shipment.kind !== "unit") {
    const carrier = unitById(g, shipment.carrierId);
    if (!carrier || !living(carrier)) return markLost(g, shipment, "운송 유닛이 파괴됐어요.", turn);
    shipment.position = clonePoint(carrier);
  }
  if (shipment.kind === "food" && !isSupplyOn(g)) {
    shipment.paused = true;
    shipment.pausedReason = "supply-off";
    return false;
  }
  if (shipment.paused && shipment.pausedReason === "supply-off") {
    shipment.paused = false;
    shipment.pausedReason = null;
  }
  if (shipment.kind !== "unit") {
    const capturable = (g.units ?? []).find(
      (unit) =>
        equal(unit, shipment.position) &&
        hostileUnitCanCapture(g, unit, shipment, isHostile),
    );
    if (capturable) {
      interceptShipment(g, {
        shipmentId: shipment.id,
        unitId: capturable.id,
        turn,
        isHostile,
      });
      return true;
    }
  }
  const destination = shipmentDestination(g, shipment);
  if (!destination) return markLost(g, shipment, "운송 목적지가 사라졌어요.", turn);
  if (shipment.kind === "unit")
    return processUnitTrade(g, shipment, turn, { isHostile });
  if (equal(shipment.position, destination)) return deliverShipment(g, shipment, turn);
  if (shipment.lastMovedTurn === turn) return false;
  const carrier = shipment.carrierId ? unitById(g, shipment.carrierId) : null;
  if (
    !shipment.path.length ||
    !equal(shipment.routeTarget, destination) ||
    !equal(shipment.path[shipment.pathIndex], shipment.position)
  ) {
    if (!setPath(g, shipment, shipment.position, destination)) {
      markBlocked(shipment, "운송 경로 막힘");
      return false;
    }
  }
  // Physical carriers use their declared movement for this controller turn.
  // A river/other over-cost edge is still enterable while positive movement
  // remains (matching the shared movement rule), but no further edge can be
  // taken after the budget reaches zero.  An abstract legacy shipment gets a
  // one-edge fallback budget.
  let movement = Math.max(
    1,
    finite(TYPES[carrier?.type]?.movement, 1),
  );
  let changed = false;
  while (movement > 0) {
    const next = shipment.path[shipment.pathIndex + 1];
    if (!next) {
      const delivered = deliverShipment(g, shipment, turn);
      return changed || delivered;
    }
    const from = clonePoint(shipment.position);
    const tile = tileMap(g).get(key(next));
    if (!canCrossBorder(g, carrier ?? { owner: shipment.owner }, from, next)) {
      markBlocked(shipment, "국경개방이 필요해요.");
      if (carrier) carrier.movesLeft = 0;
      return changed;
    }
    const cost = tile
      ? movementCost(
          { a: from, b: next },
          { tiles: g.tiles ?? [], rivers: g.rivers ?? [], roads: logisticsState(g).roads },
        )
      : Number.POSITIVE_INFINITY;
    if (!tile || tile.terrain === "mountain" || !Number.isFinite(cost)) {
      shipment.blockedTiles = Array.isArray(shipment.blockedTiles)
        ? shipment.blockedTiles
        : [];
      if (!shipment.blockedTiles.includes(key(next))) shipment.blockedTiles.push(key(next));
      shipment.path = [];
      shipment.pathIndex = 0;
      shipment.routeTarget = null;
      markBlocked(shipment, "다음 타일을 통과할 수 없어요.");
      if (carrier) carrier.movesLeft = 0;
      return changed;
    }
    shipment.position = clonePoint(next);
    shipment.pathIndex += 1;
    shipment.lastMovedTurn = turn;
    shipment.status = SHIPMENT_STATUS.IN_TRANSIT;
    shipment.blockedReason = null;
    changed = true;
    recordRoad(g, from, next);
    movement = Math.max(0, movement - cost);
    if (carrier) {
      carrier.q = next.q;
      carrier.r = next.r;
      carrier.movesLeft = movement;
    }
    // A hostile military unit on the entered tile takes the load before a
    // same-tile destination can silently credit it.  The combat engine can
    // also invoke the explicit adjacent capture hook for direct attacks.
    const capturable = (g.units ?? []).find(
      (unit) =>
        equal(unit, shipment.position) &&
        hostileUnitCanCapture(g, unit, shipment, isHostile),
    );
    if (capturable) {
      interceptShipment(g, {
        shipmentId: shipment.id,
        unitId: capturable.id,
        turn,
        isHostile,
      });
      return true;
    }
    if (equal(shipment.position, destination))
      return deliverShipment(g, shipment, turn) || changed;
    // The shared movement helper allows an over-cost edge to consume the
    // remaining positive budget; after that edge the turn ends.
    if (movement <= 0) break;
  }
  return changed;
}

function shipmentController(g, shipment) {
  if (shipment.status === SHIPMENT_STATUS.CAPTURED)
    return shipment.cargoOwner ?? unitById(g, shipment.capturedBy)?.owner ?? shipment.owner;
  return unitById(g, shipment.carrierId)?.owner ?? shipment.owner;
}

export function consumeUnitFood(g, unit, { turn = g.turn } = {}) {
  if (g.experiment && g.experimentCosts?.upkeep !== true)
    return { demand: 0, consumed: 0, shortage: false };
  ensureLogisticsState(g);
  normalizeUnit(unit);
  const demand = unitFoodDemand(unit);
  if (!isSupplyOn(g) || !demand || !living(unit))
    return {
      active: false,
      demand,
      consumed: 0,
      remaining: unit.foodStock,
      hungerTurns: unit.hungerTurns,
      penalty: unit.foodPenalty,
    };
  if (unit.foodConsumedTurn === turn)
    return {
      active: true,
      demand,
      consumed: unit.foodConsumedLast ?? 0,
      remaining: unit.foodStock,
      hungerTurns: unit.hungerTurns,
      penalty: unit.foodPenalty,
      duplicate: true,
    };
  const before = unit.foodStock;
  const consumed = Math.min(before, demand);
  unit.foodStock = before - consumed;
  unit.foodConsumedTurn = turn;
  unit.foodConsumedLast = consumed;
  if (consumed >= demand) {
    unit.hungerTurns = 0;
    unit.foodPenalty = 0;
  } else {
    unit.hungerTurns += 1;
    unit.foodPenalty = Math.min(MAX_HUNGER_PENALTY, unit.hungerTurns * 0.1);
  }
  return {
    active: true,
    demand,
    consumed,
    remaining: unit.foodStock,
    hungerTurns: unit.hungerTurns,
    penalty: unit.foodPenalty,
    shortage: consumed < demand,
  };
}

export function consumeAllUnitFood(g, { owner = null, turn = g.turn } = {}) {
  ensureLogisticsState(g);
  return (g.units ?? [])
    .filter((unit) => !owner || unit.owner === owner)
    .filter(living)
    .map((unit) => ({ unitId: unit.id, ...consumeUnitFood(g, unit, { turn }) }));
}

/** Explicit hook for root's ON/OFF migration.  It never converts food to growth. */
export function onSupplyModeChanged(g, previousMode, nextMode, turn = g.turn) {
  ensureLogisticsState(g);
  const previous = previousMode === "on";
  const next = nextMode === "on";
  logisticsState(g).modeTransition = { from: previousMode, to: nextMode, turn };
  for (const shipment of logisticsState(g).shipments) {
    if (shipment.kind !== "food" || TERMINAL.has(shipment.status)) continue;
    if (!next) {
      shipment.paused = true;
      shipment.pausedReason = "supply-off";
    } else if (previous !== next || shipment.pausedReason === "supply-off") {
      shipment.paused = false;
      shipment.pausedReason = null;
    }
  }
  return {
    previous: previous ? "on" : "off",
    next: next ? "on" : "off",
    preservedFoodShipments: logisticsState(g).shipments.filter(
      (shipment) => shipment.kind === "food" && !TERMINAL.has(shipment.status),
    ).length,
  };
}

export function tickLogistics(
  g,
  {
    turn = g.turn,
    owner = null,
    consumeUnits = true,
    supplyLocalUnits: feedLocalUnits = true,
    automaticSupply = true,
    isHostile = null,
  } = {},
) {
  ensureLogisticsState(g);
  const currentTurn = finite(turn, g.turn);
  if (feedLocalUnits) supplyLocalUnits(g, { owner, turn: currentTurn });
  if (consumeUnits) consumeAllUnitFood(g, { owner, turn: currentTurn });
  if (automaticSupply && owner) dispatchAutomaticFood(g, { owner, turn: currentTurn });
  const moved = [];
  const delivered = [];
  const captured = [];
  const lost = [];
  const before = new Map(logisticsState(g).shipments.map((shipment) => [shipment.id, shipment.status]));
  for (const shipment of [...logisticsState(g).shipments]) {
    // Delivery does not grant the recipient an extra movement phase.  A
    // shipment advances once on its actual carrier's controller turn (or the
    // shipment owner when an imported save has no carrier).  Captured cargo
    // waits for the looter's explicit return command.
    if (owner) {
      const controller = shipmentController(g, shipment);
      const capturedParty =
        shipment.status === SHIPMENT_STATUS.CAPTURED &&
        (shipment.originOwner === owner || shipment.cargoOwner === owner);
      if (controller !== owner && !capturedParty) continue;
    }
    const oldStatus = shipment.status;
    const changed = processShipment(g, shipment, currentTurn, { isHostile });
    if (changed && shipment.lastMovedTurn === currentTurn) moved.push(shipment.id);
    if (oldStatus !== SHIPMENT_STATUS.DELIVERED && shipment.status === SHIPMENT_STATUS.DELIVERED)
      delivered.push(shipment.id);
    if (oldStatus !== SHIPMENT_STATUS.CAPTURED && shipment.status === SHIPMENT_STATUS.CAPTURED)
      captured.push(shipment.id);
    if (oldStatus !== SHIPMENT_STATUS.LOST && shipment.status === SHIPMENT_STATUS.LOST)
      lost.push(shipment.id);
    before.delete(shipment.id);
  }
  return {
    turn: currentTurn,
    owner,
    moved,
    delivered,
    captured,
    lost,
    pausedFood: logisticsState(g).shipments.filter(
      (shipment) => shipment.kind === "food" && shipment.paused && !TERMINAL.has(shipment.status),
    ).length,
  };
}

function shipmentVisible(g, shipment, player, options) {
  const capturedState =
    shipment.status === SHIPMENT_STATUS.CAPTURED ||
    shipment.status === SHIPMENT_STATUS.RETURNING;
  const cargoOwner =
    shipment.cargoOwner ?? unitById(g, shipment.capturedBy)?.owner ?? null;
  // Before capture both parties know their pending shipment.  After capture
  // the former owner receives only a static status notice; the captor alone
  // may see the live position and cargo contents.
  if (capturedState) {
    if (cargoOwner === player) return { own: true, full: true, observed: true };
    if (
      shipment.originOwner === player ||
      shipment.recipient === player ||
      shipment.originalRecipient === player
    )
      return { own: false, full: false, staticOnly: true, observed: true };
  } else if (
    shipment.originOwner === player ||
    shipment.owner === player ||
    shipment.recipient === player
  ) {
    return { own: true, full: true, observed: true };
  }
  if (typeof options?.canSeeShipment === "function")
    return {
      own: false,
      full: false,
      observed: !!options.canSeeShipment(shipment, g, player),
    };
  const visibleTiles = options?.visibleTiles ?? options?.exploredTiles;
  if (visibleTiles instanceof Set && shipment.position)
    return {
      own: false,
      full: false,
      observed: visibleTiles.has(key(shipment.position)),
    };
  return { own: false, full: false, observed: false };
}

function publicShipment(g, shipment, player, options) {
  const visibility = shipmentVisible(g, shipment, player, options);
  if (!visibility.own && !visibility.observed) return null;
  const full = visibility.full === true;
  const staticOnly = visibility.staticOnly === true;
  return {
    id: shipment.id,
    kind: shipment.kind,
    status: shipment.status,
    amount: full || staticOnly ? shipment.amount : null,
    resource: full || staticOnly ? shipment.resource : null,
    owner: visibility.own || staticOnly ? shipment.originOwner : null,
    currentOwner: full ? (shipment.cargoOwner ?? shipment.owner) : null,
    recipient: visibility.own || staticOnly ? shipment.recipient : null,
    fromCityId: visibility.own || staticOnly ? shipment.fromCityId : null,
    toCityId: visibility.own || staticOnly ? shipment.toCityId : null,
    toUnitId: visibility.own || staticOnly ? shipment.toUnitId : null,
    carrierId: full ? shipment.carrierId : null,
    carrierType: shipment.carrierType,
    position: staticOnly ? null : clonePoint(shipment.position),
    path: full ? observedPath(g, shipment, player, options) : [],
    pathIndex: full
      ? Math.min(
          shipment.pathIndex,
          Math.max(0, observedPath(g, shipment, player, options).length - 1),
        )
      : null,
    paused: !!shipment.paused,
    pausedReason: visibility.own ? shipment.pausedReason ?? null : null,
    blockedReason: visibility.own ? shipment.blockedReason ?? null : null,
    originalRecipient:
      visibility.own || staticOnly
        ? shipment.originalRecipient ?? shipment.recipient
        : null,
    staticNotice: staticOnly
      ? shipment.status === SHIPMENT_STATUS.CAPTURED
        ? "화물이 적에게 나포됐어요."
        : "나포된 화물이 반환 중이에요."
      : null,
  };
}

function publicRoad(edge) {
  if (typeof edge !== "string") return edge;
  const [a, b] = edge.split("|");
  const parse = (value) => {
    const [q, r] = String(value).split(",").map(Number);
    return Number.isInteger(q) && Number.isInteger(r) ? { q, r } : null;
  };
  return { edge, from: parse(a), to: parse(b) };
}

function roadVisible(g, road, player, visibility) {
  const value = typeof road === "string" ? publicRoad(road) : road;
  if (!value?.from || !value?.to) return false;
  const canSee = (tile) => {
    if (typeof visibility?.canSeeTile === "function")
      return !!visibility.canSeeTile(tile, g, player);
    if (visibility?.visibleTiles instanceof Set)
      return visibility.visibleTiles.has(key(tile));
    if (visibility?.exploredTiles instanceof Set)
      return visibility.exploredTiles.has(key(tile));
    return knownTile(g, tile, {
      owner: player,
      explored: visibility?.explored ?? g.explored,
    });
  };
  // A road is a public observed edge only after both endpoints are known.
  return canSee(value.from) && canSee(value.to);
}

function observedPath(g, shipment, player, visibility) {
  if (!Array.isArray(shipment.path)) return [];
  const knowledge = {
    owner: player,
    explored: visibility?.explored ?? g.explored,
    knownTiles: visibility?.visibleTiles ?? visibility?.exploredTiles,
  };
  const result = [];
  for (const tile of shipment.path) {
    if (!knownTile(g, tile, knowledge)) break;
    result.push(clonePoint(tile));
  }
  return result;
}

export function publicLogisticsState(g, player, visibility = {}) {
  ensureLogisticsState(g);
  const state = logisticsState(g);
  const cargo = state.shipments
    .map((shipment) => publicShipment(g, shipment, player, visibility))
    .filter(Boolean);
  const cities = (g.cities ?? [])
    .filter((city) => city.owner === player && !city.camp)
    .map((city) => ({
      id: city.id,
      foodStock: isSupplyOn(g) ? city.food : null,
      // OFF city.food is the legacy growth ledger, not an inactive reserve.
      // Root's mode migration keeps the old ON inventory here.
      preservedFoodStock: isSupplyOn(g)
        ? null
        : city.suspendedFoodStock == null
          ? null
          : Math.max(0, finite(city.suspendedFoodStock)),
      foodCapacity: isSupplyOn(g) ? cityFoodCapacity(city) : null,
      targetReserve: finite(city.foodTargetReserve ?? city.targetReserve),
    }));
  const units = (g.units ?? [])
    .filter((unit) => unit.owner === player && living(unit))
    .map((unit) => ({
      id: unit.id,
      type: unit.type,
      foodStock: isSupplyOn(g) ? unit.foodStock : null,
      preservedFoodStock: isSupplyOn(g) ? null : unit.foodStock,
      foodCapacity: isSupplyOn(g) ? unit.foodCapacity : null,
      targetReserve: isSupplyOn(g) ? unit.targetReserve : null,
      hungerTurns: isSupplyOn(g) ? unit.hungerTurns : 0,
      foodConsumption: unitFoodDemand(unit, g),
      foodPenalty: isSupplyOn(g) ? unit.foodPenalty : 0,
      cargo: Array.isArray(unit.cargo) ? unit.cargo.map((entry) => ({ ...entry })) : [],
    }));
  const ownCities = (g.cities ?? []).filter((city) => city.owner === player && !city.camp);
  const tradingPosts = ownCities.map((city) => ({
    cityId: city.id,
    ...merchantSummary(g, city),
  }));
  return {
    supported: state.supported,
    version: LOGISTICS_VERSION,
    enabled: isSupplyOn(g),
    mode: isSupplyOn(g) ? "on" : "off",
    actions: { ...LOGISTICS_ACTIONS },
    cities,
    units,
    cargo,
    shipments: cargo,
    roads: state.roads
      .filter((road) => roadVisible(g, road, player, visibility))
      .map(publicRoad),
    tradingPosts,
    merchants: units.filter((unit) => unit.type === "merchant"),
    convoys: cargo.filter((entry) => entry.carrierType === "convoy"),
    pausedFoodShipments: state.shipments.filter(
      (shipment) => shipment.kind === "food" && shipment.paused && !TERMINAL.has(shipment.status) &&
        (shipment.originOwner === player || shipment.recipient === player),
    ).length,
  };
}

export function handleLogisticsAction(g, player, raw = {}, context = {}) {
  const action = raw.action;
  switch (action) {
    case LOGISTICS_ACTIONS.setFoodReserve:
      return setFoodReserve(g, {
        owner: player,
        cityId: raw.cityId,
        targetReserve: raw.targetReserve,
      });
    case LOGISTICS_ACTIONS.setUnitReserve:
      return setUnitReserve(g, {
        owner: player,
        unitId: raw.unitId,
        targetReserve: raw.targetReserve,
      });
    case LOGISTICS_ACTIONS.shipFood:
      return createFoodShipment(g, {
        owner: player,
        // A same-owner city-to-city action need not repeat the destination's
        // faction. If omitted, derive it from the authoritative destination
        // city; an explicitly supplied recipient is still validated by the
        // shipment constructor.
        recipient:
          raw.recipient ??
          raw.toOwner ??
          cityById(g, raw.toCityId)?.owner ??
          null,
        fromCityId: raw.fromCityId ?? raw.cityId,
        toCityId: raw.toCityId,
        amount: raw.amount,
        mode: "manual",
        turn: raw.turn ?? g.turn,
      });
    case LOGISTICS_ACTIONS.shipFoodToUnit:
      return createUnitFoodShipment(g, {
        owner: player,
        recipient: raw.recipient ?? player,
        fromCityId: raw.fromCityId ?? raw.cityId,
        toUnitId: raw.toUnitId ?? raw.unitId,
        amount: raw.amount,
        turn: raw.turn ?? g.turn,
      });
    case LOGISTICS_ACTIONS.shipResource:
      return createResourceShipment(g, {
        owner: player,
        recipient:
          raw.recipient ??
          raw.toOwner ??
          cityById(g, raw.toCityId)?.owner ??
          null,
        fromCityId: raw.fromCityId ?? raw.cityId,
        toCityId: raw.toCityId,
        resource: raw.resource,
        amount: raw.amount,
        turn: raw.turn ?? g.turn,
      });
    case LOGISTICS_ACTIONS.autoSupply:
      return dispatchAutomaticFood(g, { owner: player, turn: raw.turn ?? g.turn });
    case LOGISTICS_ACTIONS.queueMerchant:
      return queueMerchant(g, { owner: player, cityId: raw.cityId, turn: raw.turn ?? g.turn });
    case LOGISTICS_ACTIONS.merchantRoute:
      return scheduleMerchantRoute(g, {
        ...raw,
        owner: player,
        turn: raw.turn ?? g.turn,
      });
    case LOGISTICS_ACTIONS.interceptCargo:
      if (unitById(g, raw.unitId)?.owner !== player)
        throw new LogisticsError("내 군사 유닛만 화물을 나포할 수 있어요.");
      return interceptShipment(g, {
        ...raw,
        isHostile: context.isHostile,
        turn: raw.turn ?? g.turn,
      });
    case LOGISTICS_ACTIONS.returnCargo:
      if (unitById(g, raw.unitId)?.owner !== player)
        throw new LogisticsError("내 유닛의 나포 화물만 반환할 수 있어요.");
      return returnCapturedCargo(g, { ...raw, turn: raw.turn ?? g.turn });
    default:
      return false;
  }
}
