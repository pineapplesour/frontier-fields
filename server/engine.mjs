import {
  WIDTH,
  HEIGHT,
  TURN_MS,
  TYPES,
  unitMovement,
  unitAttacks,
  unitStat,
  unitAttackValue,
  RESOURCES,
  key,
  equal,
  neighbors,
  distance,
  fromOffset,
  label,
  level,
  maxHealth,
  growthTarget,
  reachable,
  movementCost,
  siegePenalty,
  findRoute,
  validRoute,
  canCrossBorder,
  territoryEntryAllowed,
  FACTIONS,
  MARKET,
  landPrice,
  blocksUnit,
  normalizeBalance,
  counterMultiplier,
  cityCounterAttack,
  productionType,
  unitPurchasePrice,
  cityMaxHealth,
  wallMaxHealth,
  isCivilian,
  settlementIssue,
  BOMBARD_RANGE,
  RESOURCE_PER_POP,
  UNIT_MANPOWER_COST,
  MIN_CITY_POPULATION,
  TERRITORY_MAX_RADIUS,
  TERRITORY_BASE_RADIUS,
  START_GRACE_TURNS,
  growthHalfTarget,
  factionsFor,
  MILITARY_FOOD_MULTIPLIER,
  NITER_UPKEEP_PER_UNIT,
  EXPANSION_START_NITER,
  farmTerrainYield,
  MAX_TURNS,
} from "../shared/rules.js";
import { FORT_HP, fortIssue, structureAt, structureHp, structureWallHp, structureMaxHp, structureKind } from "../shared/structures.js";
import { encampmentIssue, encampmentCandidates, placeEncampment, recordStructureHit, captureStructure, repairStructure, wallRepairEligibility, beginWallRepair, repairWalls } from "./militaryStructures.mjs";
import { populateWorld, populateExpansionWorld } from "./world.mjs";
import {
  directSeatIds,
  normalizeSeats,
  npcSeatIds,
  publicSeats,
  seatFactions,
} from "./lobby.mjs";
import {
  npcEconomy,
  npcUnitOrder,
  npcDiplomacy,
  npcGuaranteeDecision,
  npcWarRisk,
  npcTurnOrder,
} from "./npc.mjs";
import { handleDeal, refundDeal, dealEntitiesValid } from "./deals.mjs";
import { ensureWarDiplomacy, recordDenouncement, warJustification, peaceIssue, clearWarRecord, applyWarDiplomacy, syncAllianceWars } from "./warDiplomacy.mjs";
import { updateTerritorialPresence, territorialDiplomacyView, restrictionViolation, expireTerritorialUltimatums } from "./diplomacyRules.mjs";
import { captureBarbarianCamp, publicCampState, pillageBarbarianCamp, campSpawnSites } from "./barbarianCamps.mjs";
import {
  combatStrength,
  riverBetween,
  combatMatchup,
  unitDamage,
  cityDamage,
  cityWallHp,
  combatRollRange,
  hasLineOfSight,
  cityCounterDamage,
  formationTier,
  formationTierName,
  preventMutualDeath,
  unfavorableFight,
  killXp,
  COMBAT_XP_PARTICIPATION,
  COMBAT_XP_KILL,
} from "../shared/combat.js";
import { randomUUID } from "node:crypto";
import { constructionIssue } from "../shared/construction.js";
import { ANY_TURN_TRADES } from "../shared/turnPermissions.js";
import { experimentCosts, editExperiment, refreshExperimentUnit, resetUnitActions } from "./experiment.mjs";
import { notifyTrade } from "./notifications.mjs";
import {
  GuaranteeError,
  ensureGuaranteeState,
  publicGuaranteeState,
  issueGuarantee,
  withdrawGuarantee,
  acceptGuaranteeCall,
  rejectGuaranteeCall,
  expireGuaranteeCalls,
  onWarDeclared,
} from "./guarantees.mjs";
import {
  SUPPLY_MODES,
  ensureEconomyState,
  isSupplyOn,
  militaryFoodCost,
  militaryFoodByCity,
  citizenYields,
  publicCitizenAllocation,
  mobilizationCost,
  pendingMobilizationCost,
  pendingMobilizationResources,
  mobilizationQueueView,
  ammunitionCost,
  cityFoodCapacity,
} from "./economy.mjs";
import { ammunitionPreview, settleAmmunitionUpkeep, mergeAmmunitionUpkeep } from "./upkeep.mjs";
import { ensureLogisticsState, tickLogistics, publicLogisticsState, handleLogisticsAction, LOGISTICS_ACTIONS, LogisticsError, onSupplyModeChanged, merchantSummary, mergeUnitLogistics, captureCarrierCargo, demobilizeUnitLogistics, markCarrierDestroyed, createPillageCargo } from "./logistics.mjs";

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
function random(seed, onState) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    onState?.(a >>> 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const other = (p) => (p === "p1" ? "p2" : "p1");
const tileAt = (g, p) => g.tiles.find((t) => equal(t, p));
const living = (g) => g.units.filter((u) => u.hp > 0);
const military = (u) => !isCivilian(u);
const pair = (a, b) => [a, b].sort().join("|");
const factionMap = (g) => g.factions ?? FACTIONS;
const factionIds = (g) => Object.keys(factionMap(g));
const observerIds = (g) =>
  Object.entries(g.players ?? {})
    .map(([id, p]) => ({ id, ...p }))
    .filter(
      (p) =>
        p.controller !== "npc" &&
        !p.npc &&
        p.id !== "cs" &&
        p.id !== "barb",
    )
    .map((p) => p.id);
const turnIds = (g) =>
  g.turnOrder?.length
    ? g.turnOrder
    : ["p1", "p2"].filter((p) => g.players?.[p]);
const isExpansion = (g) => g.rulesVersion === "expansion-v1";
/**
 * Simultaneous rounds (host option, expansion rules only): every direct seat
 * acts during the same countdown, orders apply the moment they arrive, and
 * the round settles when all direct seats are ready or the clock runs out.
 */
const simultaneous = (g) => g.turnMode === "simultaneous";
const directIds = (g) =>
  turnIds(g).filter(
    (id) =>
      g.players?.[id] &&
      !g.players[id].eliminated &&
      g.players[id].controller !== "npc" &&
      g.players[id].npc !== true,
  );
const isActiveSeat = (g, player) =>
  g.internalNpc ? g.activePlayer === player :
    simultaneous(g) ? directIds(g).includes(player) : g.activePlayer === player;
export const atWar = (g, a, b) =>
  a !== b &&
  (a === "barb" || b === "barb" || (g.wars ?? ["p1|p2"]).includes(pair(a, b)));
function endWar(g, a, b) {
  const issue = peaceIssue(g, a, b);
  if (issue) throw new GameError(issue);
  g.wars = g.wars.filter((k) => k !== pair(a, b));
  clearWarRecord(g, a, b);
  g.peaceUntil[pair(a, b)] = g.turn + 5;
}
export function relation(g, a, b) {
  const k = pair(a, b);
  if (a === b) return "self";
  if (atWar(g, a, b)) return "war";
  if ((g.alliances?.[k] ?? 0) > g.turn) return "alliance";
  if ((g.denouncements?.[k] ?? 0) > g.turn) return "denounced";
  const value = g.relations?.[k] ?? 0;
  return value >= 20 ? "good" : value <= -20 ? "bad" : "neutral";
}
const coordinate = (p) => p && Number.isInteger(p.q) && Number.isInteger(p.r);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function normalizeFormation(u) {
  u.size = Number.isInteger(u.size) && u.size > 0 ? u.size : 1;
  u.xp = Number.isFinite(u.xp) && u.xp >= 0 ? u.xp : 0;
  const current = u.formation;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    u.formation = {
      tier: formationTier(u.size),
      sourceIds: [u.id],
      sourceNames: u.name ? [u.name] : [],
      sourceXp: [u.xp],
      manpower: u.size,
      ...(u.size !== 1 && u.size !== 2 && u.size !== 4
        ? { migrated: true }
        : {}),
    };
    return u.formation;
  }
  const list = (value) => (Array.isArray(value) ? value : []);
  current.sourceIds = list(current.sourceIds).filter(
    (id) => typeof id === "string",
  );
  if (!current.sourceIds.length) current.sourceIds = [u.id];
  current.sourceNames = list(current.sourceNames).filter(
    (name) => typeof name === "string",
  );
  current.sourceXp = list(current.sourceXp).filter(
    (xp) => Number.isFinite(xp) && xp >= 0,
  );
  if (!current.sourceXp.length) current.sourceXp = [u.xp];
  current.manpower = u.size;
  // Older saves stored "base"/"corps"; the current tier names are
  // battalion (1) / brigade (2) / division (4).
  if (current.tier === "base" || current.tier === "corps" || current.tier == null)
    current.tier = formationTier(u.size);
  return current;
}
function mergeFormation(receiver, donor, size) {
  const a = normalizeFormation(receiver), b = normalizeFormation(donor);
  return {
    tier: formationTier(size),
    sourceIds: [...a.sourceIds, ...b.sourceIds],
    sourceNames: [...a.sourceNames, ...b.sourceNames],
    sourceXp: [...a.sourceXp, ...b.sourceXp],
    manpower: size,
    ...(size !== 2 && size !== 4 ? { migrated: true } : {}),
  };
}
function normalizeCityDefense(c) {
  c.wallLevel = Number.isInteger(c.wallLevel)
    ? Math.max(0, Math.min(3, c.wallLevel))
    : 0;
  const bodyMax = cityMaxHealth(c), wallMax = wallMaxHealth(c);
  const oldHp = Number.isFinite(c.hp) ? c.hp : bodyMax;
  if (!Number.isFinite(c.wallHp)) {
    const legacyWall = Number.isFinite(c.wallHP)
      ? c.wallHP
      : oldHp > bodyMax
        ? oldHp - bodyMax
        : oldHp === bodyMax
          ? wallMax
          : 0;
    c.wallHp = clamp(legacyWall, 0, wallMax);
  }
  c.wallHp = clamp(Number.isFinite(c.wallHp) ? c.wallHp : 0, 0, wallMax);
  delete c.wallHP;
  c.hp = clamp(oldHp, 0, bodyMax);
  c.lastIncomingAttackTurn ??= null;
  c.wallRepairStartedTurn ??= null;
  c.wallRepairStartHp ??= null;
  return c;
}
function interruptWallRepair(g, c) {
  if (c.queue !== "wallRepair" || c.productionTarget) return false;
  c.queue = null;
  c.production = 0;
  c.productionPending = false;
  c.wallRepairStartedTurn = null;
  c.wallRepairStartHp = null;
  event(g, [c.owner], `${c.name} 성벽 수리가 공격으로 중단됐어요.`);
  return true;
}
function normalizeState(g) {
  ensureWarDiplomacy(g);
  ensureLogisticsState(g);
  for (const u of g.units ?? []) normalizeFormation(u);
  for (const c of g.cities ?? []) normalizeCityDefense(c);
  g.tradeNotices ??= {};
  for (const id of Object.keys(FACTIONS)) {
    const notices = Array.isArray(g.tradeNotices[id])
      ? g.tradeNotices[id]
      : [];
    g.tradeNotices[id] = notices.slice(-30);
  }
}
const publicUnit = (u, own, view = {}) => ({
  id: u.id,
  owner: u.owner,
  type: u.type,
  attack: unitStat(u, "attack", unitAttackValue(view, u.type)),
  defense: unitStat(u, "defense", TYPES[u.type].defense),
  range: TYPES[u.type].range,
  movement: unitMovement(u),
  attacksLeft: u.attacksLeft ?? (u.attackUsed ? 0 : unitAttacks(u)),
  ...(u.experimentStats ? { experimentStats: { ...u.experimentStats } } : {}),
  attackStrength: combatStrength(u, false, view),
  q: u.q,
  r: u.r,
  hp: u.hp,
  size: u.size,
  xp: u.xp,
  level: level(u.xp),
  charges: u.charges,
  fortified: u.fortified,
  riverTurns: u.riverTurns,
  isolation: u.isolation,
  movesLeft: u.movesLeft,
  attackUsed: u.attackUsed,
  fortifyPending: u.fortifyPending,
  ...(u.formation ? { formation: structuredClone(u.formation) } : {}),
  ...(own
    ? {
        supplied: u.supplied,
        acted: u.acted,
        manpowerCost: u.manpowerCost ?? 0,
        homeCityId: u.homeCityId ?? null,
        recruitmentMode: u.recruitmentMode ?? "grandfathered",
        mobilized: !!u.mobilized,
        mobilizationId: u.mobilizationId ?? null,
        ammoPaidTurn: u.ammoPaidTurn ?? null,
        ammoCost: ammunitionCost(u),
        ammoShortfall: u.ammoShortfall ?? 0,
        order: u.order ? structuredClone(u.order) : null,
      }
    : {}),
});

export function addUnit(g, owner, type, position, extra = {}) {
  const unit = {
    id: randomUUID(),
    owner,
    type,
    q: position.q,
    r: position.r,
    hp: 100,
    size: 1,
    xp: 0,
    charges: type === "builder" ? 3 : 0,
    fortified: false,
    isolation: 0,
    supplied: true,
    riverTurns: 0,
    order: null,
    movesLeft: TYPES[type].movement,
  attackUsed: false,
  acted: false,
  fortifyPending: false,
  manpowerCost: 0,
  manpowerSources: [],
  homeCityId: null,
  recruitmentMode: "grandfathered",
  mobilized: false,
  mobilizationId: null,
  ammoPaidTurn: null,
  ammoShortfall: 0,
  ...extra,
};
  normalizeFormation(unit);
  refreshExperimentUnit(g, unit);
  if (g.experiment) {
    unit.movesLeft = unitMovement(unit);
    unit.attacksLeft = unitAttacks(unit);
    unit.attackUsed = unit.attacksLeft <= 0;
    unit.hp = maxHealth(unit);
  }
g.units.push(unit);
return unit;
}

function manpowerSources(unit) {
  const sources = Array.isArray(unit?.manpowerSources)
    ? unit.manpowerSources
        .filter(
          (source) =>
            source &&
            Number.isFinite(source.amount) &&
            source.amount > 0 &&
            typeof source.owner === "string",
        )
        .map((source) => ({
          cityId: typeof source.cityId === "string" ? source.cityId : null,
          owner: source.owner,
          amount: source.amount,
        }))
    : [];
  if (sources.length) return sources;
  const amount = Number(unit?.manpowerCost);
  return Number.isFinite(amount) && amount > 0
    ? [
        {
          cityId:
            typeof unit.homeCityId === "string" ? unit.homeCityId : null,
          owner: unit.manpowerOwner ?? unit.owner,
          amount,
        },
      ]
    : [];
}

function normalizeUnitManpower(g) {
  for (const unit of g.units ?? []) {
    const sources = manpowerSources(unit);
    unit.manpowerSources = sources;
    unit.manpowerCost = sources.reduce((sum, source) => sum + source.amount, 0);
    unit.homeCityId ??= sources[0]?.cityId ?? null;
  }
}

function releaseReservedManpower(city) {
  const reserved = Number(city?.manpowerReserved);
  if (!Number.isFinite(reserved) || reserved <= 0) return 0;
  city.population += reserved;
  city.manpowerReserved = 0;
  return reserved;
}

function reserveManpower(city, amount = UNIT_MANPOWER_COST) {
  if (
    !city ||
    !Number.isFinite(city.population) ||
    city.population - MIN_CITY_POPULATION < amount
  )
    return false;
  city.population -= amount;
  city.manpowerReserved = (city.manpowerReserved ?? 0) + amount;
  return true;
}

function unitManpower(g, city, owner, amount = UNIT_MANPOWER_COST) {
  const source = {
    cityId: city.id,
    owner,
    amount,
  };
  return {
    manpowerCost: amount,
    manpowerSources: [source],
    homeCityId: city.id,
  };
}

function returnUnitManpower(g, unit) {
  if (unit?.manpowerReturned) return 0;
  const sources = manpowerSources(unit);
  let returned = 0;
  for (const source of sources) {
    // A traded formation keeps its source ledger.  Return to the matching
    // current-owner home city when possible; otherwise use that owner's first
    // surviving major city.  A missing city means the committed manpower is
    // lost, never minted for free.
    const exact = source.cityId
      ? g.cities.find(
          (city) => city.id === source.cityId && city.owner === unit.owner,
        )
      : null;
    const destination =
      exact ??
      g.cities.find((city) => city.owner === unit.owner && !city.camp);
    if (destination) {
      destination.population += source.amount;
      returned += source.amount;
    }
  }
  unit.manpowerReturned = true;
  return returned;
}

function mergeManpower(target, source) {
  const bySource = new Map();
  for (const entry of [...manpowerSources(target), ...manpowerSources(source)]) {
    const id = `${entry.owner}|${entry.cityId ?? ""}`;
    const existing = bySource.get(id);
    if (existing) existing.amount += entry.amount;
    else bySource.set(id, { ...entry });
  }
  target.manpowerSources = [...bySource.values()];
  target.manpowerCost = target.manpowerSources.reduce(
    (sum, entry) => sum + entry.amount,
    0,
  );
  target.homeCityId ??= target.manpowerSources[0]?.cityId ?? null;
  if (target.recruitmentMode !== "supply-on" && source.recruitmentMode === "supply-on")
    target.recruitmentMode = "supply-on";
  target.mobilized =
    target.recruitmentMode === "supply-on" ||
    !!target.mobilized ||
    !!source.mobilized;
}

function pendingResourceNeed(city, type) {
  const result = pendingMobilizationResources(city);
  const definition = productionType(type, city);
  for (const [resource, amount] of Object.entries(definition?.resources ?? {}))
    result[resource] = (result[resource] ?? 0) + amount;
  return result;
}

function enqueueMobilization(g, player, city, type) {
  if (!isSupplyOn(g))
    throw new GameError("상세 보급 ON에서만 인구를 병력으로 전환할 수 있어요.");
  if (!city || city.owner !== player || !Object.hasOwn(TYPES, type) || !military({ type }))
    throw new GameError("동원할 아군 도시와 전투 병종을 확인해 주세요.");
  const cost = mobilizationCost(type);
  if (!Number.isFinite(cost))
    throw new GameError("건축자·개척자는 일반 생산 대기열을 사용해 주세요.");
  if ((city.mobilizationQueue?.length ?? 0) >= 40)
    throw new GameError("도시별 병력 동원 대기는 40기까지 예약할 수 있어요.");
  const pending = pendingMobilizationCost(city);
  if (city.population - MIN_CITY_POPULATION - pending < cost)
    throw new GameError(
      `동원 예약 인구가 부족해요. 한 기당 ${UNIT_MANPOWER_COST}명이 필요하고 출병 전까지 시민으로 남아요.`,
    );
  const needed = pendingResourceNeed(city, type);
  for (const [resource, amount] of Object.entries(needed))
    if ((g.stockpiles[player]?.[resource] ?? 0) < amount)
      throw new GameError(
        `${RESOURCES[resource].name}이 부족해요. 예약을 취소하거나 자원 시설을 개발해 주세요.`,
      );
  const entry = {
    id: randomUUID(),
    type,
    requestedTurn: g.turn,
    requestedBy: player,
    status: "pending",
    blockedReason: null,
    dispatchedTurn: null,
  };
  city.mobilizationQueue ??= [];
  city.mobilizationQueue.push(entry);
  event(
    g,
    [player],
    `${city.name}에서 ${TYPES[type].name} ${UNIT_MANPOWER_COST}명 동원을 예약했어요 · 이번 턴에는 시민으로 일해요.`,
  );
  return entry;
}

function cancelMobilization(g, player, city, entryId) {
  if (!city || city.owner !== player || !Array.isArray(city.mobilizationQueue))
    throw new GameError("동원 대기 도시를 확인해 주세요.");
  const index = city.mobilizationQueue.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw new GameError("취소할 미출병 동원을 확인해 주세요.");
  const [removed] = city.mobilizationQueue.splice(index, 1);
  event(g, [player], `${city.name}의 ${TYPES[removed.type]?.name ?? "병력"} 동원을 취소했어요. 인구와 자원은 출병 전이라 차감되지 않았어요.`);
  return removed;
}

function dispatchMobilization(g, player, city) {
  if (!isSupplyOn(g) || !city?.mobilizationQueue?.length) return null;
  if (city.mobilizationLastDispatchTurn === g.turn) return null;
  const entry = city.mobilizationQueue[0];
  const type = entry.type;
  const definition = productionType(type, city);
  const block = (reason) => {
    entry.status = "blocked";
    entry.blockedReason = reason;
    return null;
  };
  if (!definition || !military({ type })) return block("전투 병종이 아니에요.");
  if (city.population - MIN_CITY_POPULATION < UNIT_MANPOWER_COST)
    return block(`출병 직전 인구 ${UNIT_MANPOWER_COST}명이 부족해요.`);
  const needed = definition.resources ?? {};
  for (const [resource, amount] of Object.entries(needed))
    if ((g.stockpiles[player]?.[resource] ?? 0) < amount)
      return block(`${RESOURCES[resource].name}이 부족해요.`);
  if (!legalCitySpawn(g, city, player, type))
    return block("도시 출병 칸이 막혀 있어요.");
  // Detailed supply replaces standing-army capacity with the actual civilian
  // manpower and food ledgers. Applying the old shrinking cap here strands
  // valid reservations (three citizens must produce six half-citizen units).
  if (!reserveManpower(city, UNIT_MANPOWER_COST))
    return block(`출병 직전 인구 ${UNIT_MANPOWER_COST}명이 부족해요.`);
  for (const [resource, amount] of Object.entries(needed))
    g.stockpiles[player][resource] -= amount;
  const unit = addUnit(g, player, type, { q: city.q, r: city.r });
  Object.assign(
    unit,
    unitManpower(g, city, player),
    {
      recruitmentMode: "supply-on",
      mobilized: true,
      mobilizationId: entry.id,
      mobilizedTurn: g.turn,
    },
  );
  // The reservation represented the newly deployed ledger only.  Preserve
  // any civilian production reservation that was already present.
  city.manpowerReserved = Math.max(0, (Number(city.manpowerReserved) || 0) - UNIT_MANPOWER_COST);
  city.mobilizationQueue.shift();
  city.mobilizationLastDispatchTurn = g.turn;
  entry.status = "dispatched";
  entry.dispatchedTurn = g.turn;
  entry.blockedReason = null;
  event(
    g,
    [player],
    `${city.name}에서 ${TYPES[type].name}이 출병했어요 · 인구 ${UNIT_MANPOWER_COST}명과 필요한 자원을 차감했어요.`,
  );
  return unit;
}

function processMobilization(g, player) {
  ensureEconomyState(g);
  if (!isSupplyOn(g)) return [];
  const dispatched = [];
  for (const city of g.cities.filter((candidate) => candidate.owner === player && !candidate.camp)) {
    const unit = dispatchMobilization(g, player, city);
    if (unit) dispatched.push(unit);
  }
  return dispatched;
}

function legalCitySpawn(g, city, owner, type) {
  const tile = tileAt(g, city);
  if (!tile || tile.terrain === "mountain") return false;
  const probe = { id: "__spawn__", owner, type };
  return !living(g).some((unit) => equal(unit, city) && blocksUnit(probe, unit));
}
function canClaim(g, tile, city) {
  return (
    tile &&
    tile.terrain !== "mountain" &&
    distance(tile, city) <= TERRITORY_MAX_RADIUS &&
    (!tile.owner || tile.owner === city.owner)
  );
}

function claim(g, tile, city) {
  if (!canClaim(g, tile, city)) return false;
  // Existing owned land is never revoked or silently reassigned.  A tile
  // which already belongs to this civilization may retain its prior city
  // association (for example after loading an older save).
  if (!tile.owner) tile.owner = city.owner;
  if (!tile.cityId) tile.cityId = city.id;
  return true;
}

function deterministicTileCity(g, tile, cities = g.cities) {
  if (!tile?.owner) return null;
  const explicit = cities.find(
    (city) => city.owner === tile.owner && city.id === tile.cityId,
  );
  if (explicit) return explicit;
  // Imported saves may predate cityId on ordinary land.  This fallback is
  // read-only and deterministic; it is never written back during observation
  // or economy calculation.
  return [...cities]
    .filter((city) => city.owner === tile.owner && !city.camp)
    .sort(
      (a, b) =>
        distance(a, tile) - distance(b, tile) || a.id.localeCompare(b.id),
    )[0] ?? null;
}

function razeCity(g, player, cityId) {
  const city = g.cities.find(c => c.id === cityId && c.owner === player && !c.camp);
  if (!city) throw new GameError("철거할 본인 도시를 확인해 주세요.");
  const affected = g.tiles.filter(t => t.owner === player && deterministicTileCity(g, t)?.id === cityId);
  g.cities = g.cities.filter(c => c.id !== cityId);
  // Existing neighbouring cities retain connected land they can administer.
  // Population and unfinished construction are not refunded by demolition.
  for (const t of affected) { t.owner = null; t.cityId = null; }
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of affected.filter(t => !t.owner)) {
      const successor = g.cities.filter(c => c.owner === player && !c.camp && distance(c,t) <= TERRITORY_MAX_RADIUS)
        .sort((a,b) => distance(a,t)-distance(b,t) || a.id.localeCompare(b.id))
        .find(c => neighbors(t).some(n => { const x=tileAt(g,n); return x?.owner === player && (x.cityId === c.id || equal(x,c)); }));
      if (successor) { t.owner = player; t.cityId = successor.id; changed = true; }
    }
  }
  for (const u of g.units.filter(u => u.homeCityId === cityId)) u.homeCityId = null;
  for (const c of g.cities) if (c.expansionTarget && !expansionCandidates(g,c).some(t=>equal(t,c.expansionTarget))) c.expansionTarget=null;
  event(g, [...new Set([player, ...seenBy(g,city)])], `${city.name}을 자진 철거했어요. 도시 인구와 생산은 사라지고 군대는 남아요.`);
}

function cityFootprintConnected(g, city, movedTile = null, movedTo = null) {
  const cities = g.cities.filter((candidate) => candidate.owner === city.owner && !candidate.camp);
  const assignment = (tile) => {
    if (movedTile && equal(tile, movedTile)) return movedTo;
    return deterministicTileCity(g, tile, cities);
  };
  const own = g.tiles.filter(
    (tile) => tile.owner === city.owner && assignment(tile)?.id === city.id,
  );
  if (!own.some((tile) => equal(tile, city))) own.push(city);
  if (own.some((tile) => distance(tile, city) > TERRITORY_MAX_RADIUS)) return false;
  const wanted = new Set(own.map(key));
  const visited = new Set([key(city)]);
  const queue = [city];
  for (let i = 0; i < queue.length; i++)
    for (const next of neighbors(queue[i])) {
      if (!wanted.has(key(next)) || visited.has(key(next))) continue;
      visited.add(key(next));
      queue.push(next);
    }
  return visited.size === wanted.size;
}

function reassignTile(g, player, target, toCityId) {
  if (!coordinate(target))
    throw new GameError("도시 소속을 바꿀 지도 칸을 확인해 주세요.");
  const tile = tileAt(g, target),
    cities = g.cities.filter((city) => city.owner === player && !city.camp),
    destination = cities.find((city) => city.id === toCityId),
    source = deterministicTileCity(g, tile, cities);
  if (!tile || !destination || !source)
    throw new GameError("같은 문명의 출발·도착 도시를 확인해 주세요.");
  if (source.id === destination.id)
    throw new GameError("이미 해당 도시에 소속된 땅이에요.");
  if (tile.owner !== player)
    throw new GameError("내 문명이 소유한 타일만 도시 사이에서 재배정할 수 있어요.");
  if (g.cities.some((city) => equal(city, tile)))
    throw new GameError("도심 타일의 소속은 바꿀 수 없어요.");
  if (distance(tile, destination) > TERRITORY_MAX_RADIUS)
    throw new GameError("도시에서 3칸 이내의 영토만 배정할 수 있어요.");
  if (tile.cityId && tile.cityId !== source.id)
    throw new GameError("현재 타일의 실제 도시 소속을 확인해 주세요.");
  if (!cityFootprintConnected(g, source, tile, destination))
    throw new GameError("출발 도시 영토가 끊겨 월경지가 되므로 재배정할 수 없어요.");
  if (!cityFootprintConnected(g, destination, tile, destination))
    throw new GameError("도착 도시 영토가 도심과 육각으로 연결되지 않아요.");
  tile.cityId = destination.id;
  event(
    g,
    [player],
    `${label(tile)} 타일의 도시 소속을 ${source.name}에서 ${destination.name}(으)로 바꿨어요. 시설과 국가 소유권은 유지돼요.`,
  );
  return tile;
}

function improvementKind(tile) {
  if (tile?.farm) return "farm";
  if (tile?.developed && RESOURCES[tile.resource]) return "resource";
  return null;
}

function improvementActionIssue(g, unit, action) {
  if (!military(unit)) return "농지·자원 시설 약탈은 전투 부대가 할 수 있어요.";
  if (unit.pillageUsedTurn === g.turn)
    return "이번 턴에는 이미 약탈·청야를 했어요.";
  const tile = tileAt(g, unit), kind = improvementKind(tile);
  if (!tile || !kind || tile.ruin)
    return "현재 칸에 약탈·청야할 완성 농지 또는 자원 시설이 없어요.";
  if (g.cities.some((city) => equal(city, tile)))
    return "도시 중심은 약탈·청야할 수 없어요.";
  if (action === "scorch" && tile.owner !== unit.owner)
    return "청야는 내 농지·자원 시설에서만 할 수 있어요.";
  if (action === "pillage" && (tile.owner === unit.owner || !atWar(g, unit.owner, tile.owner)))
    return "약탈은 전쟁 중인 적 시설에서만 할 수 있어요.";
  if (!tile.owner) return "소유자가 없는 시설은 약탈할 수 없어요.";
  return null;
}

function repairIssue(g, unit) {
  const tile = tileAt(g, unit);
  if (unit?.type !== "builder") return "건축자를 선택해 주세요.";
  if (!unit.charges) return "남은 건설 횟수가 없어요.";
  if (!tile?.ruin || !tile.ruin.kind)
    return "수리할 폐허 시설이 있는 칸으로 이동해 주세요.";
  if (tile.owner !== unit.owner) return "내 영토의 시설 폐허만 수리할 수 있어요.";
  if (g.cities.some((city) => equal(city, tile))) return "도시 중심은 수리 대상이 아니에요.";
  return null;
}

function improvementRewardCity(g, unit, tile) {
  const ownCities = g.cities.filter((city) => city.owner === unit.owner && !city.camp);
  const explicit = ownCities.find((city) => city.id === tile.cityId);
  return explicit ?? [...ownCities].sort(
    (a, b) => distance(a, unit) - distance(b, unit) || a.id.localeCompare(b.id),
  )[0] ?? null;
}

function addCappedGold(g, player, amount) {
  const current = Math.max(0, Number(g.gold[player]) || 0);
  const cap = Math.max(120, (economy(g, player).population || 0) * 50 + 120);
  const credited = Math.max(0, Math.min(amount, cap - current));
  g.gold[player] = current + credited;
  return credited;
}

function applyImprovementAction(g, unit, action) {
  const issue = improvementActionIssue(g, unit, action);
  if (issue) return { issue };
  const tile = tileAt(g, unit), kind = improvementKind(tile);
  const city = improvementRewardCity(g, unit, tile);
  const beforeHp = unit.hp;
  const reward = {
    food: 0,
    resource: null,
    resourceAmount: 0,
    gold: 0,
  };
  if (kind === "farm") {
    reward.food = Math.max(1, farmYield(g, tile, tile.owner).total);
    if (isSupplyOn(g)) {
      createPillageCargo(g, { unitId: unit.id, kind: "food", amount: reward.food, toCityId: city?.id, sourceTile: tile, action });
    } else if (city) {
        // OFF has no food stock: the same finite salvage is a bounded growth
        // contribution and cannot be sold, transported or paid twice.
        reward.food = Math.min(reward.food, Math.max(0, growthTarget(city.population) - 1 - city.food));
        city.food += reward.food;
    }
  } else {
    reward.resource = tile.resource;
    if (isSupplyOn(g)) {
      reward.resourceAmount = 1;
      createPillageCargo(g, { unitId: unit.id, kind: "resource", resource: reward.resource, amount: 1, toCityId: city?.id, sourceTile: tile, action });
    } else {
      const capacity = economy(g, unit.owner).resourceCapacity;
      const available = Math.max(0, capacity - (g.stockpiles[unit.owner]?.[reward.resource] ?? 0));
      reward.resourceAmount = Math.min(1, available);
      g.stockpiles[unit.owner][reward.resource] += reward.resourceAmount;
    }
    reward.gold = addCappedGold(g, unit.owner, MARKET[reward.resource]?.sell ?? 0);
  }
  tile.ruin = {
    kind,
    resource: kind === "resource" ? tile.resource : null,
    originalFarm: kind === "farm",
    originalDeveloped: kind === "resource",
    ruinedTurn: g.turn,
    ruinedBy: unit.owner,
    mode: action,
  };
  tile.farm = false;
  tile.developed = false;
  unit.hp = Math.min(maxHealth(unit), unit.hp + 50);
  const healed = unit.hp - beforeHp;
  if (healed > 0)
    for (const player of observerIds(g))
      if (player === unit.owner || visibility(g, player).has(key(unit)))
        g.effects[player].push({ kind: "heal", unitId: unit.id, at: { q: unit.q, r: unit.r }, amount: healed, turn: g.turn });
  unit.movesLeft = 0;
  unit.acted = true;
  unit.pillageUsedTurn = g.turn;
  event(
    g,
    [unit.owner, tile.owner].filter(Boolean),
    `${label(unit)}이 ${action === "scorch" ? "청야" : "약탈"}했어요 · ${kind === "farm" ? `식량 +${reward.food}` : `${RESOURCES[reward.resource].name} +${reward.resourceAmount} · 골드 +${reward.gold}`}${isSupplyOn(g) ? " · 물자는 도시로 운송 후 사용 가능" : ""} · 회복 ${healed}. 수리는 건축자 1회가 필요해요.`,
  );
  return { tile, reward, healed };
}

function repairImprovement(g, unit) {
  const issue = repairIssue(g, unit);
  if (issue) return { issue };
  const tile = tileAt(g, unit), ruin = tile.ruin;
  if (ruin.kind === "farm") {
    tile.farm = true;
    tile.developed = false;
  } else if (ruin.kind === "resource" && RESOURCES[ruin.resource]) {
    tile.resource = ruin.resource;
    tile.farm = false;
    tile.developed = true;
  } else return { issue: "복구할 시설 종류를 확인해 주세요." };
  delete tile.ruin;
  unit.charges--;
  unit.movesLeft = 0;
  unit.acted = true;
  event(g, [unit.owner], `${label(unit)}이 ${ruin.kind === "farm" ? "농지" : RESOURCES[ruin.resource].improvement} 폐허를 복구했어요.`);
  return { tile };
}

export function expansionCandidates(g, city) {
  const owned = g.tiles.filter(
    (t) =>
      t.owner === city.owner &&
      (t.cityId === city.id ||
        (!t.cityId && deterministicTileCity(g, t, g.cities)?.id === city.id) ||
        equal(t, city)),
  );
  const candidates = new Map();
  for (const root of owned)
    for (const p of neighbors(root)) {
      const tile = tileAt(g, p);
      if (
        !tile ||
        candidates.has(key(tile)) ||
        tile.cityId === city.id ||
        equal(tile, city) ||
        tile.owner ||
        !canClaim(g, tile, city)
      )
        continue;
      // A city may only grow from its own contiguous footprint.  This keeps
      // purchases and old imported land from creating a remote string.
      candidates.set(key(tile), tile);
    }
  return [...candidates.values()].sort(
    (a, b) =>
      distance(a, city) - distance(b, city) ||
      (b.fertility ?? 0) - (a.fertility ?? 0) ||
      key(a).localeCompare(key(b)),
  );
}

function selectExpansionTile(g, city) {
  const candidates = expansionCandidates(g, city);
  if (!candidates.length) return null;
  const target = city.expansionTarget && tileAt(g, city.expansionTarget);
  if (target && candidates.some((t) => equal(t, target))) return target;
  // Invalid or stale choices fall back automatically.  Clear the choice so
  // subsequent growth does not repeatedly attempt an ineligible tile.
  if (city.expansionTarget) city.expansionTarget = null;
  return candidates[0];
}

function expandOne(g, city, reason = "growth") {
  const tile = selectExpansionTile(g, city);
  if (!tile || !claim(g, tile, city)) return null;
  const nextRadius = Math.max(
    city.territoryRadius ?? TERRITORY_BASE_RADIUS,
    distance(tile, city),
  );
  city.territoryRadius = Math.min(TERRITORY_MAX_RADIUS, nextRadius);
  city.territoryGrowth = (city.territoryGrowth ?? 0) + 1;
  city.territoryRadius = Math.max(city.territoryRadius ?? TERRITORY_BASE_RADIUS, distance(tile, city));
  city.lastExpansion = { q: tile.q, r: tile.r, reason, turn: g.turn };
  return tile;
}

function territory(g, city, { initial = false } = {}) {
  city.territoryRadius ??= TERRITORY_BASE_RADIUS;
  city.territoryGrowth ??= 0;
  if (!initial) return expandOne(g, city, "growth");
  // Founding grants the transparent base footprint: center + first eligible
  // ring.  Future growth is deliberately one tile at a time.
  const base = g.tiles
    .filter((t) => distance(t, city) <= TERRITORY_BASE_RADIUS)
    .sort((a, b) => distance(a, city) - distance(b, city) || key(a).localeCompare(key(b)));
  for (const t of base) claim(g, t, city);
}
export function createGame({
  mode = "practice",
  seed = 7291,
  now = Date.now(),
  rulesVersion = "legacy",
  setup = null,
  seats = null,
  factionDefinitions = {},
  experiment = false,
  turnMode = "sequential",
} = {}) {
  const future = rulesVersion === "expansion-v1" || setup === "expansion";
  let seatList;
  try {
    seatList = normalizeSeats(seats, { expansion: future });
  } catch (error) {
    throw new GameError(error.message);
  }
  const initialPlayers = future
    ? Object.fromEntries(
        seatList.map((seat) => [seat.id, { id: seat.id, ...seat }]),
      )
    : {
        p1: { ready: false, connected: true },
        p2: { ready: false, connected: mode === "practice" },
      };
  const g = {
    mode,
    rulesVersion: future ? "expansion-v1" : "legacy",
    phase: future ? "lobby" : mode === "practice" ? "planning" : "lobby",
    turn: 1,
    activePlayer: future ? seatList[0].id : "p1",
    turnStartedAt: now,
    reveals: {},
    deadline: future ? null : mode === "practice" ? now + TURN_MS : null,
    turnSeconds: TURN_MS / 1000,
    maxTurns: null,
    revision: 1,
    winner: null,
    nextUnit: 1,
    nextCity: 3,
    units: [],
    cities: [],
    tiles: [],
    rivers: [],
    stockpiles: Object.fromEntries(
      (future ? seatList.map((s) => s.id) : ["p1", "p2"]).map((id) => [
        id,
        { iron: 3, horses: 3, niter: future ? EXPANSION_START_NITER : 3 },
      ]),
    ),
    events: Object.fromEntries(
      (future ? seatList.map((s) => s.id) : ["p1", "p2"]).map((id) => [id, []]),
    ),
    effects: Object.fromEntries(
      (future ? seatList.map((s) => s.id) : ["p1", "p2"]).map((id) => [id, []]),
    ),
    contacts: Object.fromEntries(
      (future ? seatList.map((s) => s.id) : ["p1", "p2"]).map((id) => [id, {}]),
    ),
    effectSerial: 0,
    gold: Object.fromEntries(
      (future
        ? [...seatList.map((s) => s.id), "cs", "barb"]
        : ["p1", "p2", "p3", "p4", "cs", "barb"]
      ).map((id) => [id, id === "barb" ? 0 : id === "cs" ? 100 : 120]),
    ),
    wars: [],
    peaceUntil: {},
    proposals: [],
    tradeNotices: {},
    players: initialPlayers,
    turnOrder: future ? seatList.map((seat) => seat.id) : ["p1", "p2"],
    factionDefinitions,
    seed,
    // Detailed supply is opt-in.  Legacy and newly-created matches both
    // start in connectivity-only mode until the host changes it while
    // paused; this keeps imported/current games rule-compatible.
    supplyMode: SUPPLY_MODES.OFF,
    // Host-adjustable combat numbers; defaults equal the shipped rules.
    balance: normalizeBalance(null),
    // Experiment practice: the host may spawn own/barbarian units anywhere to
    // test balance. Never available in duels or expansion lobbies.
    experiment: !!experiment && mode === "practice",
    turnMode: turnMode === "simultaneous" ? "simultaneous" : "sequential",
  };
  if (future) populateExpansionWorld(g, random(seed, () => {}), addUnit, territory, seatList);
  else populateWorld(g, random, addUnit, territory);
  ensureEconomyState(g);
  ensureGuaranteeState(g);
  normalizeState(g);
  g.randomState = seed >>> 0;
  g.random = random(g.randomState, (state) => {
    g.randomState = state;
  });
  updateContacts(g);
  return g;
}
export function restoreGame(snapshot, now = Date.now()) {
  const g = structuredClone(snapshot);
  if (
    !Array.isArray(g.tiles) ||
    g.tiles.length !== WIDTH * HEIGHT ||
    !g.players?.p1 ||
    !Number.isInteger(g.randomState)
  )
    throw new GameError("호환되지 않는 저장 데이터예요.");
  g.random = random(g.randomState, (state) => {
    g.randomState = state;
  });
  g.maxTurns = Number.isInteger(g.maxTurns) ? g.maxTurns : null;
  // Legacy: matches finished under the old fixed 40-turn limit (no finishedBy)
  // are treated as limit-finished so the host can reopen them.
  if (g.phase === "finished" && !g.finishedBy && g.maxTurns === null && g.turn > MAX_TURNS) {
    g.finishedBy = "turnLimit";
    g.maxTurns = MAX_TURNS;
  }
  normalizeUnitManpower(g);
  ensureEconomyState(g);
  g.factions ??= factionsFor([
    ...Object.keys(g.players ?? {}),
    "p3",
    "p4",
    "cs",
    "barb",
  ]);
  ensureGuaranteeState(g);
  g.turnOrder ??= ["p1", "p2"].filter((p) => g.players?.[p]);
  if (isExpansion(g)) {
    for (const city of g.cities) {
      city.rulesVersion ??= "expansion-v1";
      city.territoryRadius ??= TERRITORY_BASE_RADIUS;
      city.territoryGrowth ??= 0;
    }
    g.startGraceTurns ??= START_GRACE_TURNS;
    g.founded ??= Object.fromEntries(
      g.turnOrder.map((id) => [
        id,
        g.cities.some((city) => city.owner === id && !city.camp),
      ]),
    );
    for (const id of g.turnOrder)
      g.founded[id] ??= g.cities.some(
        (city) => city.owner === id && !city.camp,
      );
  }
  g.deadline = null;
  g.paused = true;
  g.pausedAt = now;
  g.turnStartedAt = now;
  g.practicePassAt = null;
  g.effects = Object.fromEntries(factionIds(g).map((p) => [p, []]));
  g.effectSerial++;
  g.revision++;
  if (g.phase !== "finished") {
    g.phase = "lobby";
    for (const id of directSeatIds(g.players))
      if (id !== "p1") g.players[id].connected = false;
  }
  normalizeState(g);
  return g;
}
export function startGame(g, now = Date.now()) {
  const missing = turnIds(g).filter(
    (id) =>
      g.players[id]?.controller !== "npc" &&
      g.players[id]?.npc !== true &&
      !g.players[id]?.connected,
  );
  if (g.phase !== "lobby" || missing.length)
    throw new GameError("상대가 참가한 뒤 시작할 수 있어요.");
  g.phase = "planning";
  g.paused = false;
  g.turnStartedAt = now;
  g.deadline = now + g.turnSeconds * 1000;
  if (simultaneous(g)) {
    g.activePlayer = directIds(g)[0] ?? g.activePlayer;
    for (const id of directIds(g)) prepayAmmunition(g, id);
  } else prepayAmmunition(g, g.activePlayer);
  g.revision++;
}
export function visibility(g, player) {
  if (g.players[player]?.eliminated) return new Set(g.tiles.map(key));
  const seen = new Set(
    (g.reveals?.[player] ?? [])
      .filter(
        (p) =>
          p.turn >= g.turn &&
          (!p.unitId ||
            living(g).some((u) => u.id === p.unitId && equal(u, p))),
      )
      .map(key),
  );
  const sources = [
    ...living(g)
      .filter((u) => u.owner === player)
      .map((u) => ({ ...u, vision: TYPES[u.type].vision })),
    ...g.cities
      .filter((c) => c.owner === player)
      .map((c) => ({ ...c, vision: 3 })),
  ];
  for (const t of g.tiles)
    if (sources.some((s) => distance(s, t) <= s.vision)) seen.add(key(t));
  return seen;
}
export function farmYield(g, t, previewOwner = t.owner) {
  const terrainYield = farmTerrainYield(t);
  const tileCity = deterministicTileCity(g, t, g.cities)?.id;
  const adjacent = neighbors(t).filter((n) => {
    const x = tileAt(g, n);
    if (!x?.farm || x.ruin || x.owner !== previewOwner) return false;
    return (
      deterministicTileCity(g, x, g.cities)?.id === tileCity
    );
  }).length;
  return {
    ...terrainYield,
    fertility: t.fertility,
    adjacent,
    total: terrainYield.base + t.fertility + adjacent,
  };
}
export function economy(g, player) {
  ensureEconomyState(g);
  const detailedSupply = isSupplyOn(g);
  const cities = g.cities.filter((c) => c.owner === player && !c.camp);
  const farms = g.tiles.filter(
    (t) => t.owner === player && t.farm && !t.ruin,
  );
  const allocations = new Map(cities.map((c) => [c.id, []]));
  for (const f of farms) {
    const c = deterministicTileCity(g, f, cities);
    if (c) allocations.get(c.id).push(f);
  }
  const resourceAllocations = new Map(cities.map((c) => [c.id, []]));
  for (const tile of g.tiles) {
    if (
      tile.owner !== player ||
      !tile.developed ||
      tile.ruin ||
      !RESOURCES[tile.resource]
    )
      continue;
    const c = deterministicTileCity(g, tile, cities);
    if (c) resourceAllocations.get(c.id).push(tile);
  }
  const foodLedger = detailedSupply
    ? militaryFoodByCity(g, player)
    : { byCity: new Map(cities.map((c) => [c.id, 0])), unassigned: 0 };
  const citizen = new Map(
    cities.map((c) => [
      c.id,
      citizenYields(g, c),
    ]),
  );
  const network = supplyNetwork(g, player);
  const perCity = cities.map((c) => {
    const factor = 1 - siegePenalty(c.isolation);
    const citizens = citizen.get(c.id);
    const cityMilitaryFood = foodLedger.byCity.get(c.id) ?? 0;
    const baseFood =
      2 +
      allocations.get(c.id).reduce((sum, f) => sum + farmYield(g, f).total, 0);
    const foodFocusBonus = c.queue ? 0 : Math.ceil(baseFood * 0.25);
    const foodGross = Math.floor(
      (baseFood + foodFocusBonus + citizens.yields.food) * factor,
    );
    const civilianFood = c.population;
    // Military demand is informative here: units eat from their own stores,
    // replenished by physical delivery, never remotely from this city twice.
    const foodConsumption = civilianFood;
    const foodNet = foodGross - foodConsumption;
    const definition = c.queue ? productionType(c.queue, c) : null;
    const farmProduction = allocations.get(c.id).reduce(
      (sum, tile) => sum + farmTerrainYield(tile).production, 0,
    );
    const productionRate = Math.max(
      1,
      Math.floor((2 + c.population + farmProduction) * factor) +
        Math.floor(citizens.yields.production * factor),
    );
    const effectiveResourceYields = Object.fromEntries(
      Object.keys(RESOURCES).map((resource) => [resource, 0]),
    );
    for (const slot of citizens.assignments)
      if (slot.kind === "resource" && network.has(key(slot)))
        {
          const bonus = slot.bonus ?? 0;
          effectiveResourceYields[slot.resource] += bonus;
        }
    const resourceIncome = Object.fromEntries(
      Object.keys(RESOURCES).map((resource) => [
        resource,
        resourceAllocations
          .get(c.id)
          .filter(
            (tile) => tile.resource === resource && network.has(key(tile)),
          ).length + effectiveResourceYields[resource],
      ]),
    );
    const foodStock = detailedSupply ? Math.max(0, c.food) : null;
    const foodCapacity = detailedSupply
      ? cityFoodCapacity(c, cityMilitaryFood)
      : null;
    const growthProgress = detailedSupply
      ? Math.max(0, c.growthProgress ?? 0)
      : Math.max(0, c.food);
    const mobilization = mobilizationQueueView(c);
    return {
      id: c.id,
      foodGross,
      foodFocusBonus,
      foodNet,
      civilianFood,
      militaryFood: cityMilitaryFood,
      foodConsumption,
      foodStock,
      foodCapacity,
      foodLedger: detailedSupply
        ? "city-stock"
        : "growth-progress",
      fed: detailedSupply ? foodStock + foodGross >= foodConsumption : foodNet >= 0,
      productionRate,
      farmProduction,
      growthTarget: growthTarget(c.population),
      growthHalfTarget: growthHalfTarget(c.population),
      growthProgress,
      growthProgressUnit: detailedSupply ? "fed-turns" : "food-surplus",
      territoryRadius: c.territoryRadius ?? Math.min(TERRITORY_MAX_RADIUS, 1 + Math.floor(c.population / 3)),
      territoryGrowth: c.territoryGrowth ?? 0,
      expansionTarget: c.expansionTarget ? { ...c.expansionTarget } : null,
      manpowerCost: UNIT_MANPOWER_COST,
      manpowerReserved: c.manpowerReserved ?? 0,
      manpowerAvailable: Math.max(
        0,
        c.population - MIN_CITY_POPULATION,
      ),
      mobilization: {
        ...mobilization,
        dispatchPopulationCost: UNIT_MANPOWER_COST,
        pendingResourceCost: pendingMobilizationResources(c),
        pendingCivilianFood: 0,
      },
      mobilizationReserved: mobilization.pendingManpower,
      manpowerQueueAvailable: Math.max(
        0,
        c.population - MIN_CITY_POPULATION - mobilization.pendingManpower,
      ),
      citizenAllocation: publicCitizenAllocation(g, c),
      productionEta:
        definition && Number.isFinite(definition.cost)
          ? Math.max(
              0,
              Math.ceil(
                (definition.cost - c.production) /
                  productionRate,
              ),
            )
          : null,
      starvationEta:
        detailedSupply
          ? foodNet < 0
            ? foodStock > 0
              ? Math.ceil(foodStock / -foodNet)
              : 0
            : null
          : foodNet < 0
            ? c.food > 0
              ? Math.ceil(c.food / -foodNet)
              : 0
            : null,
      farms: allocations.get(c.id).length,
      citizenBudget: citizens.budget,
      citizensAssigned: citizens.assigned,
      citizenBoosts: {
        food: citizens.yields.food,
        production: citizens.yields.production,
        gold: citizens.yields.gold,
        resources: effectiveResourceYields,
      },
      resourceIncome,
    };
  });
  const population = cities.reduce((n, c) => n + c.population, 0);
  const pricingCity =
    cities[0] ?? (g.rulesVersion ? { rulesVersion: g.rulesVersion } : {});
  const income = Object.fromEntries(
    Object.keys(RESOURCES).map((r) => [
      r,
      perCity.reduce((sum, city) => sum + (city.resourceIncome?.[r] ?? 0), 0),
    ]),
  );
  const goldIncome =
    population * 2 +
    perCity.reduce((sum, city) => sum + (city.citizenBoosts?.gold ?? 0), 0);
  // Recurring upkeep demand, not another debit or a promise of negative stock.
  // Keep gross income unchanged for the settlement and NPC economy consumers.
  const resourceUpkeep = { iron: 0, horses: 0, niter: experimentCosts(g).upkeep
    ? living(g).filter(u => u.owner === player).reduce((sum, u) => sum + ammunitionCost(u), 0)
    : 0 };
  const netResourceIncome = Object.fromEntries(Object.keys(RESOURCES)
    .map(resource => [resource, income[resource] - resourceUpkeep[resource]]));
  return {
    population,
    resourceCapacity: population * RESOURCE_PER_POP,
    foodNet: perCity.reduce((n, c) => n + c.foodNet, 0),
    production: perCity.reduce((n, c) => n + c.productionRate, 0),
    capacity: detailedSupply ? null : population * 2,
    armyCapacityEnabled: !detailedSupply,
    used: living(g)
      .filter((u) => u.owner === player && !TYPES[u.type]?.internal)
      .reduce((n, u) => n + u.size, 0),
    resources: { ...g.stockpiles[player] },
    gold: g.gold?.[player] ?? 0,
    goldIncome,
    manpowerCost: UNIT_MANPOWER_COST,
    minimumCityPopulation: MIN_CITY_POPULATION,
    supplyMode: detailedSupply ? SUPPLY_MODES.ON : SUPPLY_MODES.OFF,
    militaryFoodMultiplier: detailedSupply ? MILITARY_FOOD_MULTIPLIER : null,
    militaryFood:
      perCity.reduce((n, c) => n + c.militaryFood, 0) +
      foodLedger.unassigned,
    civilianFood: perCity.reduce((n, c) => n + c.civilianFood, 0),
    foodStock: detailedSupply
      ? perCity.reduce((n, c) => n + (c.foodStock ?? 0), 0)
      : null,
    foodStorageEnabled: detailedSupply,
    starvationEta: perCity
      .map((city) => city.starvationEta)
      .filter((eta) => Number.isFinite(eta))
      .sort((a, b) => a - b)[0] ?? null,
    unitPrices: Object.fromEntries(
      Object.keys(TYPES).map((type) => [type, unitPurchasePrice(type, pricingCity)]),
    ),
    income,
    resourceUpkeep,
    netResourceIncome,
    perCity,
  };
}
export function observe(g, player, now = Date.now()) {
  if (!g.players[player]) throw new GameError("플레이어 권한이 필요해요.", 403);
  ensureGuaranteeState(g);
  ensureWarDiplomacy(g);
  for (const c of g.cities) normalizeCityDefense(c);
  const seen = visibility(g, player);
  const eco = economy(g, player);
  const logistics = publicLogisticsState(g, player, {
    visibleTiles: seen,
    exploredTiles: new Set(Object.keys(g.explored?.[player] ?? {})),
  });
  const guaranteeState = publicGuaranteeState(g, player);
  updateContacts(g);
  const opponents = turnIds(g).filter((id) => id !== player),
    opponent = opponents[0] ?? other(player),
    factions = factionMap(g);
  const observation = {
    mode: g.mode,
    rulesVersion: g.rulesVersion ?? "legacy",
    compatibility: { canUpgradeRules: !isExpansion(g), rulesRevision: "repair-v1" },
    phase: g.phase,
    eliminated: !!g.players[player].eliminated,
    spectator: !!g.players[player].eliminated,
    turn: g.turn,
    // In a simultaneous round every unready direct seat sees itself as the
    // acting player; a seat that already pressed ready sees "waiting".
    activePlayer: simultaneous(g)
      ? g.players[player]?.ready
        ? "waiting"
        : directIds(g).includes(player)
          ? player
          : g.activePlayer
      : g.activePlayer,
    turnMode: g.turnMode ?? "sequential",
    activeSeats: simultaneous(g)
      ? directIds(g).filter((id) => !g.players[id]?.ready)
      : [g.activePlayer],
    lastNpcTurns: g.lastNpcTurns ?? null,
    turnStartedAt: g.turnStartedAt,
    maxTurns: g.maxTurns ?? null,
    revision: g.revision,
    playerId: player,
    deadline: g.deadline,
    turnSeconds: g.turnSeconds,
    supplyMode: g.supplyMode ?? SUPPLY_MODES.OFF,
    supplySettings: {
      mode: g.supplyMode ?? SUPPLY_MODES.OFF,
      enabledDescription:
        isSupplyOn(g)
          ? "상세 보급 ON · 도시 비축 식량과 병력 식량을 사용해요."
          : "상세 보급 OFF · 물리 식량 비축 없이 잉여 식량으로 성장해요.",
      militaryFoodMultiplier: isSupplyOn(g)
        ? MILITARY_FOOD_MULTIPLIER
        : null,
      niterUpkeepPerUnit: NITER_UPKEEP_PER_UNIT,
      changedAtTurn: g.supplySettings?.changedAtTurn ?? null,
    },
    paused: !!g.paused,
    pausedRemaining: g.pausedRemaining ?? null,
    experiment: !!g.experiment,
    ...(g.experiment ? { experimentCosts: experimentCosts(g) } : {}),
    balance: g.balance ?? normalizeBalance(null),
    world: { width: WIDTH, height: HEIGHT, wrapX: false, wrapY: false },
    capabilities: { resourceConversion: true, logistics: true, encampment: true, tradingPost: true, populationRules: true, territorialDiplomacy: true },
    logistics,
    cargo: logistics.cargo,
    roads: logistics.roads,
    effectSerial: g.effectSerial,
    factions: Object.entries(factions).map(([id, f]) => ({
      id,
      ...f,
      hostile: atWar(g, player, id),
      peaceUntil: g.peaceUntil?.[pair(player, id)] ?? 0,
      relation: relation(g, player, id),
      allianceUntil: g.alliances?.[pair(player, id)] ?? 0,
      denouncementUntil: g.denouncements?.[pair(player, id)] ?? 0,
      denouncementReadyTurn: (g.denouncementStarted?.[`${player}>${id}`] ?? ((g.denouncements?.[pair(player,id)] ?? 0) - 10)) + 3,
      warJustification: warJustification(g, player, id),
      peaceLockedUntil: atWar(g, player, id) ? (g.warStarted?.[pair(player,id)] ?? g.turn) + 10 : 0,
      openBordersUntil: g.openBorders?.[`${id}>${player}`] ?? 0,
      grantedBordersUntil: g.openBorders?.[`${player}>${id}`] ?? 0,
    })),
    // Treaty/relationship labels are public diplomacy, not private scores,
    // geography, inventories or proposals. Every faction gets the same map.
    publicRelations: Object.fromEntries(Object.keys(factions).map(from => [from,
      Object.fromEntries(Object.keys(factions).map(to => [to, relation(g, from, to)])),
    ])),
    diplomacy: g.proposals
      .filter((p) => p.from === player || p.to === player)
      .map((p) => structuredClone(p)),
    // Directed edges are public.  Defensive calls (including their private
    // pending decision) are scoped to the guarantor by publicGuaranteeState.
    guarantees: guaranteeState.guarantees,
    guaranteeCalls: guaranteeState.guaranteeCalls,
    pendingGuaranteeCalls: guaranteeState.pendingGuaranteeCalls,
    tradeNotices: structuredClone(g.tradeNotices?.[player] ?? []),
    conflicts: g.wars
      .map((k) => k.split("|"))
      .filter(([a, b]) => atWar(g, a, b)),
    announcements: structuredClone(g.announcements ?? []),
    serverTime: now,
    winner: g.winner,
    ready: g.players[player].ready,
    opponentConnected: !!g.players[opponent]?.connected,
    opponentReady: !!g.players[opponent]?.ready,
    seats: publicSeats(g.players),
    founded: g.founded?.[player] ?? g.cities.some((c) => c.owner === player),
    economy: eco,
    rivers: structuredClone(
      g.rivers.filter(
        (e) => g.explored[player]?.[key(e.a)] && g.explored[player]?.[key(e.b)],
      ),
    ),
    tiles: g.tiles.map((t) => {
      const known = g.explored[player]?.[key(t)];
      return known
        ? {
            ...known,
            entryAllowed: territoryEntryAllowed(g, player, known),
            visible: seen.has(key(t)),
            explored: true,
            stale: !seen.has(key(t)) && t.owner !== player,
          }
        : {
            q: t.q,
            r: t.r,
            terrain: "unknown",
            fertility: null,
            resource: null,
            owner: null,
            cityId: null,
            cityName: null,
            farm: false,
            developed: false,
            ruin: null,
            camp: false,
            visible: false,
            explored: false,
          };
    }),
    units: living(g)
      .filter((u) => u.owner === player || seen.has(key(u)))
      .map((u) => ({
        ...publicUnit(u, u.owner === player, g),
        ...(u.owner === player
          ? { ammunition: ammunitionPreview(g, u), ...logistics.units.find(entry => entry.id === u.id) }
          : {}),
        hostile: atWar(g, player, u.owner),
      })),
    cities: g.cities
      .filter((c) => c.owner === player || seen.has(key(c)))
      .map((c) =>
        c.owner === player
          ? {
              ...c,
              campState: publicCampState(g, c, player),
              maxHp: cityMaxHealth(c),
              wallMaxHp: wallMaxHealth(c),
              ...eco.perCity.find((e) => e.id === c.id),
              tradingPost: c.tradingPost ?? null,
              merchantCapacity: merchantSummary(g, c),
              productionTypes: {
                tradingPost: c.tradingPost ? false : productionType("tradingPost", c),
                encampment: productionType("encampment", c),
                merchant: merchantSummary(g, c).remaining > 0 || c.queue === "merchant"
                  ? productionType("merchant", c) : false,
              },
              targetReserve: c.foodTargetReserve ?? c.targetReserve ?? 0,
              encampmentCandidates: encampmentCandidates({ tiles: g.tiles, cities: g.cities }, c)
                .filter(t => deterministicTileCity(g, t, g.cities)?.id === c.id)
                .map(t => ({ q: t.q, r: t.r })),
              wallRepairCandidates: g.tiles.filter(t => t.encampment?.owner === player && deterministicTileCity(g, t)?.id === c.id)
                .map(t => {
                  const status = wallRepairEligibility(t.encampment, { owner: player, turn: g.turn });
                  return { q: t.q, r: t.r, wallHp: structureWallHp(t.encampment), wallMaxHp: t.encampment.wallMaxHp ?? 50, repairIssue: status.ok ? null : status.message };
                }),
              razeIssue: c.camp ? "야만인 거점은 도시 철거 대상이 아니에요." : null,
              expansionCandidates: expansionCandidates(g, c).map(
                (t) => ({ q: t.q, r: t.r }),
              ),
            }
          : {
              id: c.id,
              owner: c.owner,
              name: c.name,
              q: c.q,
              r: c.r,
              population: c.population,
              hp: c.hp,
              wallLevel: c.wallLevel ?? 0,
              wallHp: cityWallHp(c),
              wallMaxHp: wallMaxHealth(c),
              camp: !!c.camp,
              campState: publicCampState(g, c, player),
              maxHp: cityMaxHealth(c),
              capital: c.capital,
              hostile: atWar(g, player, c.owner),
            },
      ),
    events: (g.events[player] ?? []).map((e) => ({ ...e })),
    effects: structuredClone(g.effects?.[player] ?? []),
    contacts: Object.values(g.contacts[player] ?? {})
      .filter((c) => !living(g).some((u) => u.id === c.id && seen.has(key(u))))
      .map((c) => ({ ...c, ghost: true })),
    cityContacts: Object.values(g.cityContacts?.[player] ?? {})
      .filter(
        (c) =>
          !seen.has(key(c)) &&
          !g.cities.some((live) => live.id === c.id && live.owner === player),
      )
      .map((c) => ({ ...c, ghost: true })),
  };
  observation.territorialDiplomacy = territorialDiplomacyView(g, player, observation);
  return observation;
}
export function updateContacts(g) {
  g.contacts ??= { p1: {}, p2: {} };
  g.explored ??= {};
  g.cityContacts ??= {};
  for (const player of Object.keys(g.players)) {
    g.contacts[player] ??= {};
    g.explored[player] ??= {};
    g.cityContacts[player] ??= {};
    const seen = visibility(g, player),
      known = g.contacts[player];
    for (const t of g.tiles)
      if (seen.has(key(t)) || t.owner === player) {
        const c = g.cities.find((c) => c.id === t.cityId);
        g.explored[player][key(t)] = {
          q: t.q,
          r: t.r,
          terrain: t.terrain,
          fertility: t.fertility,
          resource: t.resource,
          owner: t.owner,
          farm: t.farm,
          developed: t.developed,
          ruin: t.ruin ? structuredClone(t.ruin) : null,
          fort: t.fort ? structuredClone(t.fort) : null,
          encampment: t.encampment ? structuredClone(t.encampment) : null,
          cityId: t.cityId ?? null,
          cityName: c?.name ?? null,
          camp: !!t.camp,
          lastSeenTurn: g.turn,
        };
      }
    // Revisiting a remembered hex and confirming it empty clears the marker.
    for (const c of Object.values(g.cityContacts[player]))
      if (
        seen.has(key(c)) &&
        !g.cities.some((live) => live.id === c.id && equal(live, c))
      )
        delete g.cityContacts[player][c.id];
    for (const c of g.cities)
      if (seen.has(key(c)) || c.owner === player)
        g.cityContacts[player][c.id] = {
          id: c.id,
          owner: c.owner,
          name: c.name,
          q: c.q,
          r: c.r,
          population: c.population,
          wallLevel: c.wallLevel ?? 0,
          camp: !!c.camp,
          lastSeenTurn: g.turn,
        };
    for (const c of Object.values(known))
      if (
        seen.has(key(c)) &&
        !living(g).some((u) => u.id === c.id && equal(u, c))
      )
        delete known[c.id];
    for (const u of living(g))
      if (u.owner !== player && seen.has(key(u)))
        known[u.id] = {
          id: u.id,
          owner: u.owner,
          type: u.type,
          q: u.q,
          r: u.r,
          size: u.size,
          lastSeenTurn: g.turn,
        };
    updateTerritorialPresence(g, player, {
      playerId: player, turn: g.turn,
      tiles: g.tiles.filter(t => t.owner === player || seen.has(key(t))).map(t => ({ ...t, visible: true, explored: true })),
      units: living(g).filter(u => u.owner === player || seen.has(key(u))),
      cities: g.cities.filter(c => c.owner === player || seen.has(key(c))),
    });
  }
}
function migrateSupplyMode(g, next, player) {
  const current = g.supplyMode ?? SUPPLY_MODES.OFF;
  if (current === next) return;
  for (const city of g.cities) {
    const target = growthTarget(city.population);
    if (current === SUPPLY_MODES.OFF && next === SUPPLY_MODES.ON) {
      // Growth progress is not an inventory. Only that progress crosses the
      // mode boundary; the inactive ON inventory resumes without conversion.
      city.growthProgress = Math.min(
        Math.max(0, target - 1),
        Math.max(0, Number(city.food) || 0),
      );
      city.food = Math.max(0, Number(city.suspendedFoodStock) || 0);
      delete city.suspendedFoodStock;
      city.growthHalfGranted =
        city.growthProgress >= growthHalfTarget(city.population);
    } else {
      city.suspendedFoodStock = Math.max(0, Number(city.food) || 0);
      city.food = Math.min(
        Math.max(0, target - 1),
        Math.max(0, Number(city.growthProgress) || 0),
      );
      city.growthProgress = 0;
      city.growthHalfGranted = city.food >= growthHalfTarget(city.population);
      if (city.mobilizationQueue?.length) {
        const count = city.mobilizationQueue.length;
        city.mobilizationQueue = [];
        city.mobilizationLastDispatchTurn = null;
        event(
          g,
          [city.owner],
          `${city.name}의 미출병 동원 ${count}기를 보급 OFF 전환으로 취소했어요 · 출병 전이라 인구와 자원은 차감되지 않았어요.`,
        );
      }
    }
  }
  g.supplyMode = next;
  onSupplyModeChanged(g, current, next, g.turn);
  g.supplySettings ??= {};
  g.supplySettings.mode = next;
  g.supplySettings.changedAtTurn = g.turn;
  g.supplySettings.changedBy = player;
  event(
    g,
    [player],
    next === SUPPLY_MODES.ON
      ? "상세 보급을 켰어요 · 성장 진척은 이어지고, 보관해 둔 식량과 식량 수송을 다시 사용해요."
      : "상세 보급을 껐어요 · 비축 식량과 식량 수송은 잠시 보관하며 성장에 더하지 않아요. 도시별 잉여 식량으로 성장해요.",
  );
}

export function setSettings(
  g,
  player,
  { turnSeconds, maxTurns, paused, supplyMode, upgradeRules, balance, turnMode } = {},
  now = Date.now(),
) {
  if (player !== "p1")
    throw new GameError("방장만 경기 전체의 시간을 변경할 수 있어요.", 403);
  ensureEconomyState(g);
  if (balance !== undefined && (typeof balance !== "object" || balance === null))
    throw new GameError("밸런스 설정 형식을 확인해 주세요.");
  if (turnMode !== undefined && !["sequential", "simultaneous"].includes(turnMode))
    throw new GameError("턴 방식은 sequential 또는 simultaneous여야 해요.");
  if (turnMode !== undefined && turnMode !== (g.turnMode ?? "sequential")) {
    if (!g.paused && g.phase !== "lobby")
      throw new GameError("턴 방식은 대기실이거나 일시정지 중일 때만 바꿀 수 있어요.", 409);
  }
  if (
    balance !== undefined &&
    !(g.experiment || g.mode === "practice" || g.paused || g.phase === "lobby")
  )
    throw new GameError("밸런스 수치는 연습·실험 경기이거나 일시정지 중일 때만 바꿀 수 있어요.", 409);
  if (upgradeRules !== undefined && typeof upgradeRules !== "boolean")
    throw new GameError("규칙 적용 여부를 확인해 주세요.");
  if (upgradeRules && !g.paused && g.phase !== "lobby")
    throw new GameError("현재 경기의 규칙 적용은 일시정지 중에만 가능해요.", 409);
  if (
    supplyMode !== undefined &&
    !Object.values(SUPPLY_MODES).includes(supplyMode)
  )
    throw new GameError("보급 모드는 off 또는 on으로 선택해 주세요.");
  if (
    supplyMode !== undefined &&
    supplyMode !== g.supplyMode &&
    !g.paused &&
    g.phase !== "lobby"
  )
    throw new GameError("보급 모드는 일시정지 중인 경기에서만 바꿀 수 있어요.", 409);
  if (
    turnSeconds !== undefined &&
    (!Number.isInteger(turnSeconds) || turnSeconds < 10 || turnSeconds > 300)
  )
    throw new GameError("턴 제한은 10~300초 사이의 정수로 입력해 주세요.");
  if (
    maxTurns !== undefined &&
    maxTurns !== null &&
    (!Number.isInteger(maxTurns) || maxTurns < 10 || maxTurns > 1000)
  )
    throw new GameError("턴 제한은 무제한(null) 또는 10~1000턴 사이의 정수로 입력해 주세요.");
  const limitFinished = g.phase === "finished" && g.finishedBy === "turnLimit";
  if (
    maxTurns !== undefined &&
    maxTurns !== (g.maxTurns ?? null) &&
    !g.paused &&
    g.phase !== "lobby" &&
    !limitFinished
  )
    throw new GameError("턴 제한은 대기실이거나 일시정지 중일 때만 바꿀 수 있어요.", 409);
  if (
    paused !== undefined &&
    (typeof paused !== "boolean" || g.phase !== "planning")
  )
    throw new GameError("진행 중인 경기만 일시정지할 수 있어요.");
  // Validate every field before migrating the food ledger or changing the
  // clock.  A malformed combined settings request must not partially toggle
  // supply mode and then fail on its other field.
  if (upgradeRules && !isExpansion(g)) {
    // Opt-in compatibility migration: never regenerate terrain, relocate a
    // city/unit, discard old territory, or infer a different controller.
    g.rulesVersion = "expansion-v1";
    g.rulesUpgradedAtTurn = g.turn;
    g.turnOrder = [...new Set([
      ...(g.turnOrder ?? []),
      ...Object.keys(g.players).filter(id => /^p[1-8]$/.test(id)),
    ])];
    g.factions ??= factionsFor(Object.keys(g.players));
    g.founded = Object.fromEntries(g.turnOrder.map(id => [id, true]));
    for (const city of g.cities) {
      city.rulesVersion = "expansion-v1";
      city.territoryRadius ??= TERRITORY_BASE_RADIUS;
      city.territoryGrowth ??= 0;
    }
    normalizeUnitManpower(g);
    event(g, observerIds(g), "현재 경기에 최신 규칙을 적용했어요. 기존 도시·유닛·영토와 조종자는 그대로 유지돼요.");
  }
  if (supplyMode !== undefined && supplyMode !== g.supplyMode)
    migrateSupplyMode(g, supplyMode, player);
  if (turnMode !== undefined && turnMode !== (g.turnMode ?? "sequential")) {
    g.turnMode = turnMode;
    for (const seat of Object.values(g.players)) seat.ready = false;
    const direct = directIds(g);
    if (turnMode === "simultaneous") {
      // Seats that were waiting for their sequential turn join the round now.
      for (const id of direct) if (id !== g.activePlayer) prepareActiveSeat(g, id, { settleUpkeep: false });
      g.activePlayer = direct[0] ?? g.activePlayer;
    } else g.activePlayer = direct.includes(g.activePlayer) ? g.activePlayer : direct[0] ?? g.activePlayer;
    event(g, observerIds(g), turnMode === "simultaneous" ? "방장이 동시 턴으로 바꿨어요. 모두 같은 시간에 행동하고 함께 정산돼요." : "방장이 교대 턴으로 바꿨어요.");
  }
  if (balance !== undefined) {
    const current = g.balance ?? normalizeBalance(null);
    g.balance = normalizeBalance({
      ...current,
      ...balance,
      unitAttack: { ...current.unitAttack, ...(balance.unitAttack ?? {}) },
    });
    g.balanceChangedAtTurn = g.turn;
    event(g, observerIds(g), "방장이 전투 밸런스 수치를 바꿨어요. 설정에서 현재 값을 확인할 수 있어요.");
  }
  if (turnSeconds !== undefined) g.turnSeconds = turnSeconds;
  if (maxTurns !== undefined && maxTurns !== (g.maxTurns ?? null)) {
    g.maxTurns = maxTurns;
    const label = maxTurns === null ? "무제한" : `${maxTurns}턴`;
    if (limitFinished && (maxTurns === null || g.turn <= maxTurns)) {
      // The match ended only because the old limit ran out; the host has
      // raised or removed it, so play resumes from the current turn.
      g.phase = "planning";
      g.winner = null;
      g.finishedBy = null;
      for (const seat of Object.values(g.players)) if (!seat.eliminated) seat.ready = false;
      g.deadline = now + g.turnSeconds * 1000;
      g.turnStartedAt = now;
      event(
        g,
        observerIds(g),
        `방장이 턴 제한을 ${label}으로 바꿔서 종료됐던 경기가 ${g.turn}턴부터 다시 이어져요. 이전 최종 점수 결과는 취소됐어요.`,
      );
    } else event(g, observerIds(g), `방장이 턴 제한을 ${label}으로 바꿨어요.`);
  }
  if (paused !== undefined) {
    if (paused && !g.paused) {
      advanceDue(g, now);
      g.pausedRemaining = Math.max(0, g.deadline - now);
      g.pausedAt = now;
      g.practiceRemaining = g.practicePassAt
        ? Math.max(0, g.practicePassAt - now)
        : null;
      g.deadline = null;
      g.practicePassAt = null;
      g.paused = true;
    } else if (!paused && g.paused) {
      g.deadline = now + g.pausedRemaining;
      g.turnStartedAt += now - g.pausedAt;
      g.practicePassAt =
        g.practiceRemaining === null ? null : now + g.practiceRemaining;
      g.paused = false;
      g.pausedRemaining = null;
      g.runtimeResumeRequired = false;
    }
  }
  g.revision++;
  return observe(g, player, now);
}

/**
 * Select the next growth tile for one own city.  The target is only a
 * preference: if it becomes occupied, foreign-owned, mountainous, or falls
 * outside the three-radius contiguous frontier, growth automatically uses
 * the deterministic eligible fallback.
 */
export function setCitySettings(
  g,
  player,
  { turn, cityId, expansionTarget = null } = {},
  now = Date.now(),
) {
  requirePlanning(g, player, turn ?? g.turn, now);
  const city = g.cities.find((c) => c.id === cityId && c.owner === player && !c.camp);
  if (!city) throw new GameError("설정할 아군 도시를 확인해 주세요.");
  if (expansionTarget === null) city.expansionTarget = null;
  else {
    if (!coordinate(expansionTarget) || !tileAt(g, expansionTarget))
      throw new GameError("다음 성장 영토는 지도 안의 칸이어야 해요.");
    const eligible = expansionCandidates(g, city).some((t) =>
      equal(t, expansionTarget),
    );
    if (!eligible)
      throw new GameError(
        "도시 영토에 이어진 3칸 이내의 빈 성장 후보를 선택해 주세요.",
      );
    city.expansionTarget = {
      q: expansionTarget.q,
      r: expansionTarget.r,
    };
  }
  g.revision++;
  return observe(g, player, now);
}

/** Configure the Civ-inspired worker ledger without creating new building
 * types.  Locks and priority are preferences over the authoritative slots;
 * allocation is always bounded by whole civilian population. */
export function setCitizenSettings(
  g,
  player,
  {
    turn,
    cityId,
    auto = true,
    lockedSlots = [],
    priority = [],
  } = {},
  now = Date.now(),
) {
  requirePlanning(g, player, turn ?? g.turn, now);
  const city = g.cities.find((c) => c.id === cityId && c.owner === player && !c.camp);
  if (!city) throw new GameError("설정할 아군 도시를 확인해 주세요.");
  if (typeof auto !== "boolean" || !Array.isArray(lockedSlots) || !Array.isArray(priority))
    throw new GameError("시민 배치 설정 형식이 올바르지 않아요.");
  if (lockedSlots.length > 40 || priority.length > 40)
    throw new GameError("시민 배치 슬롯은 40개까지 지정할 수 있어요.");
  const slots = new Set(publicCitizenAllocation(g, city).slots.map((slot) => slot.id));
  const normalize = (values) => {
    const unique = [...new Set(values)];
    if (unique.some((id) => typeof id !== "string" || !slots.has(id)))
      throw new GameError("현재 도시에서 사용할 수 없는 시민 슬롯이에요.");
    return unique;
  };
  const next = {
    auto,
    lockedSlots: normalize(lockedSlots),
    priority: normalize(priority),
  };
  city.citizenPolicy = next;
  g.revision++;
  return observe(g, player, now);
}

/** Host-authorized controller transfer used when a saved NPC civilization is
 * offered to a human.  Ownership, units, cities, contacts and event history
 * are intentionally untouched; only the seat controller changes. */
export function claimNpcSeat(g, player, seatId) {
  if (player !== "p1")
    throw new GameError("방장만 NPC 문명 좌석을 사람에게 열 수 있어요.", 403);
  const seat = g.players?.[seatId];
  if (!seat || seatId === "cs" || seatId === "barb")
    throw new GameError("양도할 NPC 문명을 확인해 주세요.");
  if (seat.controller !== "npc" && !seat.npc)
    throw new GameError("이미 사람이 조종하는 문명은 양도할 수 없어요.");
  seat.controller = "human";
  seat.npc = false;
  seat.claimable = false;
  seat.connected = false;
  seat.ready = false;
  seat.claimedAtTurn = g.turn;
  if (!g.turnOrder?.includes(seatId)) {
    g.turnOrder ??= ["p1", "p2"].filter((id) => g.players[id]);
    g.turnOrder.push(seatId);
  }
  g.revision++;
  return { seatId, controller: "human", connected: false };
}

/**
 * Rehydrate a private rolling-update checkpoint.  Active matches resume in a
 * paused state with their exact remaining time, which gives clients a safe
 * reconnect boundary while preserving every order and token.  Paused games
 * retain their existing pausedRemaining value unchanged.
 */
export function restoreRuntimeGame(
  snapshot,
  checkpointedAt = Date.now(),
  now = Date.now(),
) {
  const g = structuredClone(snapshot);
  if (
    !Array.isArray(g.tiles) ||
    g.tiles.length !== WIDTH * HEIGHT ||
    !g.players?.p1 ||
    !Number.isInteger(g.randomState)
  )
    throw new GameError("호환되지 않는 런타임 경기예요.");
  g.random = random(g.randomState, (state) => {
    g.randomState = state;
  });
  g.maxTurns = Number.isInteger(g.maxTurns) ? g.maxTurns : null;
  // Legacy: matches finished under the old fixed 40-turn limit (no finishedBy)
  // are treated as limit-finished so the host can reopen them.
  if (g.phase === "finished" && !g.finishedBy && g.maxTurns === null && g.turn > MAX_TURNS) {
    g.finishedBy = "turnLimit";
    g.maxTurns = MAX_TURNS;
  }
  normalizeUnitManpower(g);
  ensureEconomyState(g);
  g.factions ??= factionsFor([
    ...Object.keys(g.players),
    "p3",
    "p4",
    "cs",
    "barb",
  ]);
  ensureGuaranteeState(g);
  g.turnOrder ??= ["p1", "p2"].filter((p) => g.players[p]);
  if (isExpansion(g)) {
    for (const city of g.cities) {
      city.rulesVersion ??= "expansion-v1";
      city.territoryRadius ??= TERRITORY_BASE_RADIUS;
      city.territoryGrowth ??= 0;
    }
    g.startGraceTurns ??= START_GRACE_TURNS;
    g.founded ??= Object.fromEntries(
      g.turnOrder.map((id) => [
        id,
        g.cities.some((city) => city.owner === id && !city.camp),
      ]),
    );
    for (const id of g.turnOrder)
      g.founded[id] ??= g.cities.some(
        (city) => city.owner === id && !city.camp,
      );
  }
  if (!g.paused && Number.isFinite(g.deadline)) {
    g.pausedRemaining = Math.max(0, g.deadline - checkpointedAt);
    g.deadline = null;
    g.paused = true;
    // The restored process owns a fresh pause boundary.  Without this
    // timestamp, the first host resume would turn turnStartedAt into NaN.
    g.pausedAt = now;
    g.runtimeResumeRequired = true;
  }
  g.pausedAt ??= now;
  // Diagnostic: a checkpoint written before the current turn began cannot
  // contain anything done during that turn.  Tell the players so a restart
  // loss is not mistaken for a game bug.
  if (
    Number.isFinite(g.turnStartedAt) &&
    Number.isFinite(checkpointedAt) &&
    checkpointedAt < g.turnStartedAt
  ) {
    g.events ??= {};
    for (const id of observerIds(g)) g.events[id] ??= [];
    event(
      g,
      observerIds(g),
      "서버 재시작으로 마지막 체크포인트 이후의 변경이 사라졌을 수 있어요",
      { kind: "restartLoss", checkpointedAt, turnStartedAt: g.turnStartedAt },
    );
    g.restartLossPossible = true;
  }
  g.turnStartedAt = now;
  g.practicePassAt = null;
  return g;
}
function requirePlanning(g, player, turn, now, anyTurn = false) {
  if (!g.players?.[player])
    throw new GameError("플레이어 권한이 필요해요.", 403);
  if (g.players[player].eliminated)
    throw new GameError("문명이 멸망했어요. 관전만 할 수 있어요.", 403);
  if (g.paused)
    throw new GameError(
      "일시정지 중이에요. 사용자가 재개하면 행동할 수 있어요.",
      409,
    );
  if (g.deadline && now >= g.deadline) {
    advanceDue(g, now);
    throw new GameError("명령 시간이 끝났어요. 새 턴을 확인해 주세요.", 409);
  }
  if (g.phase !== "planning")
    throw new GameError("현재 명령을 내릴 수 없는 상태예요.", 409);
  if (turn !== g.turn)
    throw new GameError("턴이 바뀌었어요. 새 상태를 확인해 주세요.", 409);
  if (!anyTurn && !isActiveSeat(g, player))
    throw new GameError("상대 턴이에요. 내 턴이 되면 행동할 수 있어요.", 409);
  if (!anyTurn && g.players[player].ready)
    throw new GameError("준비 완료한 명령은 바꿀 수 없어요.", 409);
}
export function submitOrders(
  g,
  player,
  { turn, orders = [], production = [] },
  now = Date.now(),
) {
  const queued = !isActiveSeat(g, player);
  const planningOnly =
    queued &&
    Array.isArray(orders) &&
    orders.length > 0 &&
    orders.every((o) => ["move", "cancel"].includes(o?.action)) &&
    Array.isArray(production) &&
    production.length === 0;
  requirePlanning(g, player, turn, now, planningOnly);
  if (
    !Array.isArray(orders) ||
    orders.length > 80 ||
    !Array.isArray(production) ||
    production.length > 20
  )
    throw new GameError("명령 형식이 올바르지 않아요.");
  const view = observe(g, player, now);
  const seen = visibility(g, player);
  const changes = [];
  const cityShots = [];
  const ids = new Set();
  for (const raw of orders) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new GameError("명령 형식이 올바르지 않아요.");
    if (raw.action === "cityBombard") {
      const c = g.cities.find((c) => c.id === raw.cityId && c.owner === player);
      if (c) normalizeCityDefense(c);
      const target = view.units.find(
        (u) => equal(u, raw.target) && u.hostile && u.owner !== player,
      );
      if (
        !c ||
        c.hp <= 0 ||
        !(c.wallHp > 0) ||
        c.attackUsed ||
        ids.has(c.id) ||
        !target ||
        distance(c, target) > BOMBARD_RANGE
      )
        throw new GameError(
          "성벽 도시로 2칸 이내 보이는 적에게 턴당 한 번 포격할 수 있어요.",
        );
      ids.add(c.id);
      cityShots.push([c, target.id]);
      continue;
    }
    const u = living(g).find((u) => u.id === raw.unitId && u.owner === player);
    if (!u || ids.has(u.id))
      throw new GameError("명령할 아군 유닛을 확인해 주세요.");
    if (u.tradeShipmentId || (u.type === "merchant" && g.logistics?.shipments?.some(s => s.carrierId === u.id && ["in_transit", "blocked", "returning"].includes(s.status))))
      throw new GameError("운송 중인 유닛은 목적지에 도착한 뒤 다시 명령할 수 있어요.");
    if (TYPES[u.type]?.internal)
      throw new GameError("보급 수송대는 지정된 운송 경로를 자동으로 따라가요.");
    ids.add(u.id);
    const action = raw.action;
    if (
      !["move", "cancel"].includes(action) &&
      u.attackUsed
    )
      throw new GameError(
        "이번 턴의 행동을 이미 마쳤어요. 다음 턴에 행동력이 회복돼요.",
      );
    if (
      ["farm", "develop", "fort", "found", "merge", "fortify", "repairStructure"].includes(
        action,
      ) &&
      u.movesLeft <= 0
    )
      throw new GameError(
        "이번 턴의 행동을 이미 마쳤어요. 다음 턴에 행동력이 회복돼요.",
      );
    if (action === "move" && u.attackUsed && !queued && !(g.experiment && u.movesLeft > 0))
      throw new GameError("공격한 유닛은 이번 턴에 더 이동할 수 없어요.");
    if (
      action === "fortify" &&
      (u.acted || u.movesLeft < unitMovement(u))
    )
      throw new GameError(
        "이번 턴 이동하거나 행동하지 않은 유닛만 방어 준비를 할 수 있어요.",
      );
    if (
      ![
        "move",
        "attack",
        "bombard",
        "farm",
        "develop",
        "pillage",
        "scorch",
        "repair",
        "repairStructure",
        "fort",
        "found",
        "merge",
        "fortify",
        "cancel",
      ].includes(action)
    )
      throw new GameError("지원하지 않는 명령이에요.");
    const order = { action };
    if (["move", "attack", "bombard"].includes(action)) {
      if (!coordinate(raw.target) || !tileAt(g, raw.target))
        throw new GameError("지도 안의 칸을 선택해 주세요.");
      order.target = { q: raw.target.q, r: raw.target.r };
    }
    if (action === "move") {
      if (military(u) && restrictionViolation(g, player, order.target, "military"))
        throw new GameError("최후통첩 합의 지역이에요. 선전포고 전에는 군사를 진입시킬 수 없어요.");
      const destination = view.tiles.find(t => equal(t, order.target));
      if (!territoryEntryAllowed(view, player, destination) &&
          !canCrossBorder(view, u, u, order.target))
        throw new GameError("국경이 닫혀 있어요. 거래로 30턴 국경개방을 받아야 진입할 수 있어요.");
      const path =
        raw.path === undefined ? findRoute(view, u, order.target) : raw.path;
      if (!validRoute(view, u, path, order.target))
        throw new GameError("이동 가능한 인접 칸으로 경로를 지정해 주세요.");
      order.path = path.map((p) => ({ q: p.q, r: p.r }));
    }
    if (action === "attack" || action === "bombard") {
      const friendlyTarget = [...view.units, ...view.cities].some(x =>
        x.owner === player && equal(x, order.target));
      if (friendlyTarget)
        throw new GameError("아군 유닛이나 도시는 공격할 수 없어요. 공격 기회는 소모되지 않았어요.");
      const neutral = [...view.units, ...view.cities].find(
        (x) =>
          x.owner !== player &&
          equal(x, order.target) &&
          !atWar(g, player, x.owner),
      );
      if (neutral)
        throw new GameError(
          "평화 중인 세력이에요. 외교에서 관계를 확인해 주세요.",
        );
      if (
        !military(u) ||
        distance(u, order.target) > TYPES[u.type].range ||
        equal(u, order.target)
      )
        throw new GameError("공격 사거리를 확인해 주세요.");
      if (action === "bombard" && u.type !== "artillery")
        throw new GameError("포병만 포격할 수 있어요.");
      if (action === "attack" && u.type === "artillery")
        order.action = "bombard";
      if (order.action === "attack" && !seen.has(key(order.target)))
        throw new GameError("직접 공격은 보이는 칸에만 가능해요.");
      if (
        order.action === "attack" &&
        u.type === "musketeer" &&
        !hasLineOfSight(view, u, order.target)
      )
        throw new GameError("사격선이 막혀 있어요.");
      if (raw.retreat) {
        if (
          order.action !== "bombard" ||
          !coordinate(raw.retreat) ||
          distance(u, raw.retreat) !== 1 ||
          !tileAt(g, raw.retreat) ||
          tileAt(g, raw.retreat).terrain === "mountain"
        )
          throw new GameError(
            "포격 후 재배치는 인접한 이동 가능 칸으로 해 주세요.",
          );
        order.retreat = { q: raw.retreat.q, r: raw.retreat.r };
      }
    }
    if (action === "farm") {
      const issue = constructionIssue(view, u, action);
      if (issue) throw new GameError(issue);
    }
    if (action === "develop") {
      const issue = constructionIssue(view, u, action);
      if (issue) throw new GameError(issue);
    }
    if (action === "pillage" || action === "scorch") {
      const issue = improvementActionIssue(g, u, action);
      if (issue) throw new GameError(issue);
    }
    if (action === "repair") {
      const issue = repairIssue(g, u);
      if (issue) throw new GameError(issue);
    }
    if (action === "repairStructure") {
      const structure = structureAt(g, u);
      if (u.type !== "builder" || u.charges < 1 || !structure || structure.owner !== player || structureHp(structure) >= structureMaxHp(structure))
        throw new GameError("건설 횟수가 남은 건축자로 손상된 아군 요새·주둔지에 올라가 주세요.");
    }
    if (action === "fort") {
      const issue = fortIssue(view, u);
      if (issue) throw new GameError(issue);
    }
    if (action === "found") {
      if (restrictionViolation(g, player, u, "found"))
        throw new GameError("최후통첩 합의 지역에는 10턴 동안 선전포고 없이 정착할 수 없어요.");
      const issue = settlementIssue(view, u);
      if (issue) throw new GameError(issue);
    }
    if (action === "merge") {
      const target = living(g).find(
        (x) => x.id === raw.targetId && x.owner === player,
      );
      if (
        !military(u) ||
        !target ||
        target.id === u.id ||
        target.type !== u.type ||
        distance(u, target) > 1 ||
        !(
          (u.size === 1 && target.size === 1) ||
          (u.size === 2 && target.size === 2)
        )
      )
        throw new GameError(
          "같은 편제의 인접 부대만 대대+대대→여단, 여단+여단→사단으로 합칠 수 있어요.",
        );
      order.targetId = target.id;
    }
    changes.push([u, action === "cancel" ? null : order]);
  }
  const stocks = { ...g.stockpiles[player] };
  const cityIds = new Set();
  const builds = production.map((p) => {
    const c = g.cities.find((c) => c.id === p.cityId && c.owner === player);
    if (
      !c || c.camp ||
      cityIds.has(c.id) ||
      (p.type !== null &&
        p.type !== "walls" &&
        p.type !== "wallRepair" &&
        p.type !== "tradingPost" &&
        p.type !== "encampment" &&
        !Object.hasOwn(TYPES, p.type))
    )
      throw new GameError("도시와 생산할 유닛을 확인해 주세요.");
    if (TYPES[p.type]?.internal)
      throw new GameError("보급 수송대는 물자 운송 때 자동 생성돼요.");
    if (isSupplyOn(g) && Object.hasOwn(TYPES, p.type) && military({ type: p.type }))
      throw new GameError(
        "상세 보급 ON에서는 전투 병종을 일반 생산하지 않고 도시별 동원 대기에 예약해요.",
      );
    cityIds.add(c.id);
    if (p.type === "walls" && (c.wallLevel ?? 0) >= 3)
      throw new GameError("성벽은 최대 3레벨이에요.");
    normalizeCityDefense(c);
    if (p.type === "tradingPost" && c.tradingPost)
      throw new GameError("도시마다 교역소는 하나만 지을 수 있어요.");
    if (p.type === "merchant") {
      const summary = merchantSummary(g, c);
      if (!summary.built || summary.active > 0)
        throw new GameError("교역소가 필요하고 도시당 상인은 한 명만 유지할 수 있어요.");
    }
    if (p.type === "encampment") {
      const issue = encampmentIssue(view, player, p.target, { cityId: c.id });
      if (issue) throw new GameError(issue);
      if (deterministicTileCity(g, tileAt(g, p.target), g.cities)?.id !== c.id)
        throw new GameError("생산하는 도시 소속의 타일에 주둔지를 지어 주세요.");
    }
    if (p.type === "wallRepair") {
      if (p.target) {
        const tile = coordinate(p.target) && tileAt(g, p.target);
        const structure = tile?.encampment;
        if (!structure || structure.owner !== player || deterministicTileCity(g, tile)?.id !== c.id)
          throw new GameError("이 도시 소속 주둔지의 성벽만 수리할 수 있어요.");
        const eligibility = wallRepairEligibility(structure, { owner: player, turn: g.turn });
        if (!eligibility.ok) throw new GameError(eligibility.message);
      } else {
      if (c.wallLevel <= 0 || c.wallHp >= wallMaxHealth(c))
        throw new GameError("수리할 손상된 성벽이 없어요.");
      if (
        c.lastIncomingAttackTurn !== null &&
        g.turn - c.lastIncomingAttackTurn < 5
      )
        throw new GameError("공격이 멈춘 뒤 5턴이 지나야 성벽을 수리할 수 있어요.");
      }
    }
    if (c.queue)
      for (const [r, n] of Object.entries(productionType(c.queue, c).resources))
        stocks[r] += n;
    const reserved = Number(c.manpowerReserved) || 0,
      required =
        Object.hasOwn(TYPES, p.type)
          ? UNIT_MANPOWER_COST
          : 0,
      availableAfterRelease =
        c.population + reserved -
        MIN_CITY_POPULATION;
    if (
      required > reserved &&
      availableAfterRelease < required
    )
      throw new GameError(
        `인구 ${UNIT_MANPOWER_COST}명이 필요해요. 도시는 최소 ${MIN_CITY_POPULATION}명을 남겨야 해요.`,
      );
    if (p.type)
      for (const [r, n] of Object.entries(
        productionType(p.type, c).resources,
      )) {
        stocks[r] -= n;
        if (stocks[r] < 0)
          throw new GameError(
            `${RESOURCES[r].name}이 부족해요. 자원 시설을 개발해 주세요.`,
          );
      }
    return [c, p.type, ["encampment", "wallRepair"].includes(p.type) && p.target ? { q: p.target.q, r: p.target.r } : null];
  });
  // Validate the entire batch before changing anything.
  if (queued) {
    let sequence = g.nextRouteSequence ?? 0;
    for (const [u, order] of changes) {
      if (order) {
        sequence++;
        u.order = { ...order, queued: true, sequence };
      } else u.order = null;
    }
    g.nextRouteSequence = sequence;
    g.revision++;
    return observe(g, player, now);
  }
  beginEffects(g);
  for (const [u, order] of changes) u.order = order;
  for (const [c, type, target] of builds) {
    const changedTarget = Boolean(c.productionTarget) !== Boolean(target) || (target && !equal(c.productionTarget, target));
    if (c.queue !== type || changedTarget) {
      // Diagnostic: a queued item is being dropped or replaced by an explicit
      // orders request.  Make it visible in the city owner's events and on
      // the server console so a vanished queue can be traced to its cause.
      if (c.queue && !c.camp) {
        const previous = productionType(c.queue, c);
        const label = previous?.name ?? c.queue;
        const progress = `${Math.floor(c.production ?? 0)}/${previous?.cost ?? "?"}`;
        event(
          g,
          [c.owner],
          type
            ? `${c.name} 생산 변경 · ${label} (진행 ${progress}) → ${productionType(type, c)?.name ?? type}`
            : `${c.name} 생산 취소 · ${label} (진행 ${progress}) 예약을 비웠어요.`,
          { kind: "productionCleared", cityId: c.id, previousType: c.queue, nextType: type },
        );
        console.log(
          `[orders] ${player} cleared production of ${c.id} (${c.queue} ${progress}) payload=${JSON.stringify(production)}`,
        );
      }
      releaseReservedManpower(c);
      c.production = 0;
    }
    if (
      Object.hasOwn(TYPES, type) &&
      (Number(c.manpowerReserved) || 0) < UNIT_MANPOWER_COST
    )
      if (!reserveManpower(c, UNIT_MANPOWER_COST))
        throw new GameError(
          `인구 ${UNIT_MANPOWER_COST}명이 필요해요. 도시는 최소 ${MIN_CITY_POPULATION}명을 남겨야 해요.`,
        );
    const changed = c.queue !== type;
    if (type === "wallRepair") {
      if (changed || changedTarget || !Number.isFinite(c.wallRepairStartHp)) {
        const structure = target && tileAt(g, target)?.encampment;
        if (structure) beginWallRepair(structure, { owner: c.owner, turn: g.turn });
        c.wallRepairStartedTurn = g.turn;
        c.wallRepairStartHp = structure ? structureWallHp(structure) : c.wallHp;
        c.productionTargetWallMaxHp = structure ? wallRepairEligibility(structure, { owner: c.owner, turn: g.turn }).maximum : null;
      }
    } else {
      c.wallRepairStartedTurn = null;
      c.wallRepairStartHp = null;
      c.productionTargetWallMaxHp = null;
    }
    c.queue = type;
    c.productionTarget = target;
    c.manpowerBlocked = false;
    c.productionPending = false;
  }
  g.stockpiles[player] = stocks;
  const acting = changes.filter(([, order]) => order).map(([u]) => u);
  handleMoves(g, acting);
  handleCombat(g, acting);
  for (const [c, targetId] of cityShots) {
    normalizeCityDefense(c);
    // An earlier action in this resolution may have broken the wall. The
    // bombardment is disabled immediately rather than firing from wallLevel.
    if (c.hp <= 0 || c.wallHp <= 0) continue;
    c.attackUsed = true;
    const d = living(g).find((u) => u.id === targetId);
    if (!d) continue;
    const targetCity = g.cities.find(
      (city) => city.hp > 0 && equal(city, d) && atWar(g, c.owner, city.owner),
    );
    const rawLoss = 2 * Math.max(
      6,
      Math.round(
        (((22 + c.wallLevel * 8) * 22) / Math.max(8, targetCity ? 30 + (targetCity.wallLevel ?? 0) * 8 : strength(d, true, g))) *
          0.4 *
          (0.85 + g.random() * 0.3) *
          (1 - siegePenalty(c.isolation)),
      ),
    );
    if (targetCity) {
      normalizeCityDefense(targetCity);
      // A hit on a wall-less garrison still means the city is under attack.
      // Repair/healing cooldowns must not depend on which health pool took it.
      targetCity.lastIncomingAttackTurn = g.turn;
      interruptWallRepair(g, targetCity);
    }
    const loss = targetCity ? rawLoss : Math.min(d.hp, rawLoss);
    // The entire standing city protects its garrison, not merely its wall.
    if (targetCity) {
      const wallLoss = Math.min(targetCity.wallHp, loss);
      const bodyLoss = Math.min(targetCity.hp, Math.max(0, loss - wallLoss));
      targetCity.wallHp -= wallLoss;
      targetCity.hp -= bodyLoss;
      targetCity.lastIncomingAttackTurn = g.turn;
      interruptWallRepair(g, targetCity);
      for (const p of observerIds(g))
        if (
          p === c.owner ||
          p === targetCity.owner ||
          visibility(g, p).has(key(targetCity))
        )
          g.effects[p].push({
            kind: p === c.owner ? "bombard" : "impact",
            unitType: "artillery",
            ...(p === c.owner ? { from: { q: c.q, r: c.r } } : {}),
            to: { q: targetCity.q, r: targetCity.r },
            turn: g.turn,
          });
      for (const p of observerIds(g))
        if (p === targetCity.owner || visibility(g, p).has(key(targetCity)))
          g.effects[p].push({
            kind: "damage",
            cityId: targetCity.id,
            owner: targetCity.owner,
            name: targetCity.name,
            at: { q: targetCity.q, r: targetCity.r },
            amount: wallLoss + bodyLoss,
            wallDamage: wallLoss,
            bodyDamage: bodyLoss,
            wallHp: targetCity.wallHp,
            hp: targetCity.hp,
            destroyed: targetCity.hp === 0,
            turn: g.turn,
          });
      event(
        g,
        [c.owner, targetCity.owner],
        `${c.name} 성벽 포격 · ${targetCity.name} 성벽 피해 ${wallLoss} · 도시 피해 ${bodyLoss} · 주둔 부대 피해 0`,
      );
      continue;
    }
    const targetStructure = structureAt(g, d);
    if (targetStructure && atWar(g, c.owner, targetStructure.owner)) {
      const shields = structureWallHp(targetStructure) > 0;
      const hit = recordStructureHit(targetStructure, rawLoss, { turn: g.turn });
      for (const p of observerIds(g))
        if (p === c.owner || p === targetStructure.owner || visibility(g, p).has(key(d))) {
          if (shields) {
            const source = p === c.owner || visibility(g, p).has(key(c));
            g.effects[p].push({ kind: source ? "bombard" : "impact", unitType: "artillery", ...(source ? { from: { q: c.q, r: c.r } } : {}), to: { q: d.q, r: d.r }, turn: g.turn });
          }
          g.effects[p].push({ kind: "damage", fort: true, owner: targetStructure.owner, name: structureKind(targetStructure) === "encampment" ? "주둔지" : "요새", at: { q: d.q, r: d.r }, amount: hit.damage, turn: g.turn });
        }
      if (shields) {
        event(g, [c.owner, d.owner], `${c.name} 포격 · 주둔지 피해 ${hit.damage} · 성벽이 주둔 부대를 보호했어요.`);
        continue;
      }
    }
    for (const p of observerIds(g))
      if (
        p === c.owner ||
        visibility(g, p).has(key(c)) ||
        visibility(g, p).has(key(d))
      ) {
        const source = p === c.owner || visibility(g, p).has(key(c));
        g.effects[p].push({
          kind: source ? "bombard" : "impact",
          unitType: "artillery",
          ...(source ? { from: { q: c.q, r: c.r } } : {}),
          to: { q: d.q, r: d.r },
          turn: g.turn,
        });
        if (p === d.owner || visibility(g, p).has(key(d)))
          g.effects[p].push({
            kind: "damage",
            unitId: d.id,
            unit: publicUnit(d),
            at: { q: d.q, r: d.r },
            amount: loss,
            destroyed: loss >= d.hp,
            turn: g.turn,
          });
      }
    d.hp -= loss;
    if (d.hp <= 0) markCarrierDestroyed(g, d.id);
    d.xp += COMBAT_XP_PARTICIPATION;
    event(
      g,
      [c.owner, d.owner],
      `${c.name} 성벽 포격 · ${TYPES[d.type].name} 피해 ${loss} · 도시 반격 피해 0`,
    );
  }
  handleActions(g, acting, false);
  for (const u of acting) {
    if (u.order?.action !== "move" || !u.order.path.length) u.order = null;
    delete u.engageTarget;
  }
  updateContacts(g);
  checkVictory(g);
  g.revision++;
  return observe(g, player, now);
}
export function ready(g, player, turn, now = Date.now()) {
  requirePlanning(g, player, turn, now);
  g.players[player].ready = true;
  // Legacy practice has no second human; its passive seat must not block
  // the host's shared-round completion or be silently converted to an AI.
  if (simultaneous(g) && !isExpansion(g) && g.mode === "practice" && g.players.p2)
    g.players.p2.ready = true;
  g.revision++;
  if (simultaneous(g) && !directIds(g).every((id) => g.players[id]?.ready)) {
    // Wait for the other direct seats or the shared countdown.
    event(g, [player], "준비 완료 · 다른 문명이 모두 마치거나 시간이 끝나면 함께 정산돼요.");
    return observe(g, player, now);
  }
  resolveTurn(g, now);
  return observe(g, player, now);
}
function event(g, players, text, extra = {}) {
  for (const p of new Set(players))
    if (g.events[p]) g.events[p].push({ turn: g.turn, text, ...extra });
}
function beginEffects(g) {
  if (g.internalNpc) return;
  g.effects = Object.fromEntries(observerIds(g).map((p) => [p, []]));
  g.effectSerial = (g.effectSerial ?? 0) + 1;
}
function seenBy(g, p) {
  return observerIds(g).filter((owner) => visibility(g, owner).has(key(p)));
}
export const strength = combatStrength;
export const crossesRiver = riverBetween;
export const matchup = combatMatchup;
function damage(a, b, g) {
  const [low, high] = combatRollRange(a);
  return unitDamage(a, b, g, low + g.random() * (high - low));
}
function handleMoves(g, scope = living(g)) {
  const movers = scope
    .filter((u) => u.hp > 0 && (!u.attackUsed || (g.experiment && u.movesLeft > 0)))
    .filter((u) => u.order?.action === "move")
    .map((u) => ({
      u,
      path: [...u.order.path],
      stopped: false,
      index: 0,
      left: u.movesLeft ?? unitMovement(u),
    }));
  for (const { u } of movers) {
    u.order.blocked = false;
    u.engageTarget = null;
  }
  const startsInZone = new Set(
    movers
      .filter(({ u }) =>
        living(g).some(
          (e) =>
            atWar(g, e.owner, u.owner) && military(e) && distance(e, u) === 1,
        ),
      )
      .map(({ u }) => u.id),
  );
  // One micro-step is needed per movement point. Add one slot per mover so
  // friendly units that cross paths can vacate a contested hex and continue
  // without reintroducing the former fixed three-step ceiling.
  const maxSteps =
    Math.max(1, ...movers.map(({ u }) => Math.ceil((TYPES[u.type]?.movement ?? 1) / 0.5))) +
    movers.length;
  for (let step = 0; step < maxSteps; step++) {
    const beforeSeen = Object.fromEntries(
      observerIds(g).map((p) => [p, visibility(g, p)]),
    );
    for (const m of movers) {
      const target = m.u.order.target;
      if (
        !m.u.engageTarget &&
        military(m.u) &&
        visibility(g, m.u.owner).has(key(target)) &&
        m.path.length - m.index <= TYPES[m.u.type].range &&
        distance(m.u, target) <= TYPES[m.u.type].range &&
        !m.u.attackUsed &&
        (m.u.type !== "musketeer" || hasLineOfSight(g, m.u, target)) &&
        (living(g).some(
          (e) => atWar(g, e.owner, m.u.owner) && equal(e, target),
        ) ||
          g.cities.some(
            (c) => atWar(g, c.owner, m.u.owner) && c.hp > 0 && equal(c, target),
          ) ||
          ((structureHp(structureAt(g, target)) > 0 || structureWallHp(structureAt(g, target)) > 0) &&
            atWar(g, structureAt(g, target).owner, m.u.owner)))
      ) {
        m.u.engageTarget = { ...target };
        m.stopped = true;
      }
    }
    const proposals = movers
      .filter((m) => {
        if (m.stopped || !m.path[m.index] || m.left <= 0) return false;
        const destination = m.path[m.index];
        if (!canCrossBorder(g, m.u, m.u, destination)) {
          m.stopped = true;
          m.u.order.blocked = true;
          event(g, [m.u.owner], "국경개방이 없어 예약 이동을 멈췄어요.");
          return false;
        }
        return Number.isFinite(
          movementCost({ a: m.u, b: destination }, g),
        );
      })
      .map((m) => ({
        ...m,
        dest: m.path[m.index],
        from: { q: m.u.q, r: m.u.r },
      }));
    const moved = [];
    for (const m of proposals) {
      const original = movers.find((x) => x.u.id === m.u.id);
      if (
        living(g).some((u) => equal(u, m.dest) && blocksUnit(m.u, u)) ||
        g.cities.some(
          (c) => c.owner !== m.u.owner && c.hp > 0 && equal(c, m.dest),
        )
      ) {
        // A same-side mover may vacate this hex later in the batch. Wait for
        // another movement micro-step instead of stopping both crossing paths.
        const waitingForAlly = living(g).some(
          (u) =>
            equal(u, m.dest) &&
            blocksUnit(m.u, u) &&
            u.owner === m.u.owner &&
            movers.some(
              (p) =>
                p.u.id === u.id && !p.stopped && p.left > 0 && p.path[p.index],
            ),
        );
        original.stopped = !waitingForAlly;
        m.u.order.blocked = true;
        if (
          military(m.u) &&
          !m.u.attackUsed &&
          (m.u.type !== "musketeer" || hasLineOfSight(g, m.u, m.dest)) &&
          living(g).some(
            (e) => atWar(g, e.owner, m.u.owner) && equal(e, m.dest),
          )
        )
          m.u.engageTarget = { ...m.dest };
        if (!waitingForAlly)
          event(
            g,
            [m.u.owner],
            `${TYPES[m.u.type].name}: 진로가 막혀 ${label(m.u)}에서 멈췄어요.`,
          );
        continue;
      }
      if (crossesRiver(g, m.u, m.dest)) m.u.riverTurns = 3;
      m.u.order.blocked = false;
      m.u.q = m.dest.q;
      m.u.r = m.dest.r;
      const positionStructure = structureAt(g, m.dest);
      if (military(m.u) && positionStructure && positionStructure.owner !== m.u.owner &&
          (!positionStructure.owner || atWar(g, positionStructure.owner, m.u.owner)) &&
          structureHp(positionStructure) === 0 && structureWallHp(positionStructure) === 0) {
        captureStructure(positionStructure, m.u.owner, { turn: g.turn });
        event(g, seenBy(g, m.dest), `${label(m.dest)} 방어 거점을 점령했어요 · 위치 보너스는 즉시 적용, 건물 체력은 수리가 필요해요.`);
      }
      m.u.fortified = false;
      m.u.fortifyPending = false;
      m.u.acted = true;
      const cost = movementCost({ a: m.from, b: m.dest }, g);
      original.left = Math.max(0, original.left - cost);
      original.index++;
      original.from = m.from;
      moved.push(original);
    }
    // All positions change before evaluating the new zones of control.
    for (const original of moved) {
      const u = original.u;
      for (const player of observerIds(g))
        if (
          player === u.owner ||
          (beforeSeen[player].has(key(original.from)) &&
            visibility(g, player).has(key(u)))
        )
          g.effects[player].push({
            kind: "move",
            unitId: u.id,
            from: original.from,
            to: { q: u.q, r: u.r },
            step,
            turn: g.turn,
          });
      if (
        startsInZone.has(u.id) ||
        living(g).some(
          (e) =>
            atWar(g, e.owner, u.owner) && military(e) && distance(e, u) === 1,
        )
      ) {
        original.stopped = true;
        original.left = 0;
      }
    }
    updateContacts(g);
  }
  for (const m of movers) {
    m.u.order.path = m.path.slice(m.index);
    m.u.movesLeft = m.left;
  }
}
function handleCombat(g, scope = living(g)) {
  const pending = scope.filter(u => u.hp > 0 && !u.attackUsed &&
    (["attack", "bombard"].includes(u.order?.action) || u.engageTarget));
  if (!pending.length) return;
  if (pending.length > 1) {
    for (const unit of pending) {
      handleCombat(g, [unit]);
      handleActions(g, [], false);
    }
    return;
  }
  // Outcome receipts use the actual HP delta, independently of animation data.
  const visibleBefore = new Map(observerIds(g).map(p => [p, visibility(g, p)]));
  const beforeHealth = living(g).map((unit) => ({ unit, hp: unit.hp, owner: unit.owner,
    viewers: [...visibleBefore].filter(([p, seen]) => p === unit.owner || seen.has(key(unit))).map(([p]) => p) }));
  const hits = new Map();
  const credited = new Map();
  const cityHits = new Map();
  const cityAttackers = new Map();
  const fortHits = new Map();
  const xp = new Map();
  const addXp = (unit, amount) =>
    xp.set(unit.id, (xp.get(unit.id) ?? 0) + amount);
  // `${killer.id}|${victim.id}` → whether the fight was unfavorable for the
  // killer, judged at resolution before any damage is applied.
  const underdog = new Map();
  // attacker.id → defender whose melee counter-attack hit it.
  const counters = new Map();
  const addHit = (u, amount) => hits.set(u.id, (hits.get(u.id) ?? 0) + amount);
  const attacks = scope.filter(
    (u) =>
      u.hp > 0 &&
      !u.attackUsed &&
      (["attack", "bombard"].includes(u.order?.action) || u.engageTarget),
  );
  for (const u of attacks) {
    const target = u.engageTarget ?? u.order.target;
    const bombard = u.order.action === "bombard" || u.type === "artillery";
    const currentTargets = [...living(g), ...g.cities.filter(c => c.hp > 0 || !c.camp)]
      .filter(entity => equal(entity, target));
    const targetStructure = structureAt(g, target);
    if (targetStructure && (structureHp(targetStructure) > 0 || structureWallHp(targetStructure) > 0)) currentTargets.push(targetStructure);
    if (currentTargets.some(entity => entity.owner === u.owner) ||
        (currentTargets.length && !currentTargets.some(entity => atWar(g, u.owner, entity.owner))) ||
        (!currentTargets.length && (!bombard || visibility(g, u.owner).has(key(target))))) {
      u.order = null;
      delete u.engageTarget;
      event(g, [u.owner], "공격 대상이 사라졌거나 관계가 바뀌어 예약 공격을 취소했어요. 공격 기회는 유지돼요.");
      continue;
    }
    if (distance(u, target) > TYPES[u.type].range) continue;
    // A blocked automatic engagement must not consume the attack or movement
    // opportunity. Revalidate before charging ammo or committing animation.
    if (u.type === "musketeer" && !hasLineOfSight(g, u, target)) continue;
    const captureTarget = living(g).filter(e => atWar(g, e.owner, u.owner) && equal(e, target))
      .sort((a, b) => Number(isCivilian(a)) - Number(isCivilian(b)))[0];
    const capturing = military(u) && !bombard && captureTarget && isCivilian(captureTarget) && distance(u, target) === 1 &&
      !g.cities.some(c => c.hp > 0 && equal(c, target)) &&
      !(targetStructure && (structureHp(targetStructure) > 0 || structureWallHp(targetStructure) > 0));
    if (capturing && (u.movesLeft <= 0 || !canCrossBorder(g,u,u,target) || !Number.isFinite(movementCost({from:u,to:target},g)))) continue;
    if (!capturing) {
    u.fortified = false;
    u.fortifyPending = false;
    u.attacksLeft = Math.max(0, (u.attacksLeft ?? (u.attackUsed ? 0 : unitAttacks(u))) - 1);
    u.attacksSpent = (u.attacksSpent ?? 0) + 1;
    u.attackUsed = u.attacksLeft === 0;
    u.movesLeft = 0;
    u.acted = true;
    if (bombard)
      event(
        g,
        observerIds(g),
        `${label(u)}에서 포격이 관측됐어요. 발사 후 위치는 알 수 없어요.`,
        { type: "shot", q: u.q, r: u.r },
      );
    for (const player of observerIds(g)) {
      const seen = visibility(g, player),
        source = player === u.owner || seen.has(key(u)) || bombard,
        impact = player === u.owner || seen.has(key(target));
      if (source)
        g.effects[player].push({
          kind: bombard ? "bombard" : "attack",
          unitType: u.type,
          unitId: player === u.owner || seen.has(key(u)) ? u.id : undefined,
          from: { q: u.q, r: u.r },
          ...(impact ? { to: { ...target } } : {}),
          turn: g.turn,
        });
      else if (impact)
        g.effects[player].push({
          kind: "impact",
          to: { ...target },
          turn: g.turn,
        });
    }
    }
    const targetCity = g.cities.find(
      (c) => c.hp > 0 && atWar(g, c.owner, u.owner) && equal(c, target),
    );
    if (targetCity) {
      normalizeCityDefense(targetCity);
      targetCity.lastIncomingAttackTurn = g.turn;
      interruptWallRepair(g, targetCity);
    }
    // Every standing city shields its garrison until the city itself falls.
    const targetTile = tileAt(g, target),
      fort = structureAt(g, target);
    if (fort && atWar(g, fort.owner, u.owner))
      recordStructureHit(fort, 0, { turn: g.turn });
    const d = targetCity || (fort && atWar(g, fort.owner, u.owner) && structureWallHp(fort) > 0)
      ? null
      : living(g).filter(
          (e) => atWar(g, e.owner, u.owner) && equal(e, target),
        ).sort((a, b) => Number(isCivilian(a)) - Number(isCivilian(b)))[0];
    if (fort && (structureHp(fort) > 0 || structureWallHp(fort) > 0) && atWar(g, fort.owner, u.owner)) {
      const n = cityDamage(u, { q: target.q, r: target.r, wallLevel: 0 }, g);
      fortHits.set(key(targetTile), (fortHits.get(key(targetTile)) ?? 0) + n);
      if (bombard) {
        g.reveals[u.owner] ??= [];
        g.reveals[u.owner].push({ q: target.q, r: target.r, turn: g.turn });
      }
      if (!d) addXp(u, COMBAT_XP_PARTICIPATION);
    }
    if (d) {
      if (capturing && d === captureTarget) {
        const from = { q: u.q, r: u.r };
        const cost = movementCost({ from: u, to: d }, g);
        u.movesLeft = Math.max(0, u.movesLeft - cost);
        u.q = d.q; u.r = d.r;
        if (riverBetween(g, from, d)) u.riverTurns = 3;
        u.fortified = false; u.fortifyPending = false; u.acted = true;
        u.order = null; delete u.engageTarget;
        for (const player of observerIds(g))
          if (player === u.owner || visibility(g, player).has(key(d)))
            g.effects[player].push({ kind: "move", unitId: u.id, from, to: {q:u.q,r:u.r}, turn:g.turn });
        const oldOwner = d.owner;
        const cargo = captureCarrierCargo(g, { unitId: u.id, carrierId: d.id, isHostile: (game, unit, shipment) => atWar(game, unit.owner, shipment.owner) });
        if (TYPES[d.type].internal) {
          const receipt = beforeHealth.find(entry => entry.unit === d);
          if (receipt) receipt.hp = 0; // A cargo capture is not combat damage.
          d.hp = 0;
          event(g, [oldOwner, u.owner], `수송대를 나포했어요 · 화물 ${cargo.length}건은 공격 부대가 보유해요. 도시로 수송해야 사용할 수 있어요.`);
          continue;
        }
        d.owner = u.owner;
        d.order = null;
        d.movesLeft = 0;
        d.attackUsed = true;
        d.acted = true;
        d.fortified = false;
        d.fortifyPending = false;
        addXp(u, COMBAT_XP_KILL);
        event(
          g,
          [oldOwner, u.owner],
          `${TYPES[d.type].name}이 적의 직접 돌파로 ${factionMap(g)[u.owner]?.name ?? u.owner}에 편입됐어요.`,
        );
        for (const player of observerIds(g))
          if (player === oldOwner || player === u.owner || visibility(g, player).has(key(d)))
            g.effects[player].push({
              kind: "capture",
              unitId: d.id,
              at: { q: d.q, r: d.r },
              turn: g.turn,
            });
        continue;
      }
      if (bombard) {
        g.reveals[u.owner] ??= [];
        g.reveals[u.owner].push({ q: d.q, r: d.r, unitId: d.id, turn: g.turn });
      }
      const n = damage(u, d, g);
      addHit(d, n);
      addXp(u, COMBAT_XP_PARTICIPATION);
      addXp(d, COMBAT_XP_PARTICIPATION);
      if (!credited.has(d.id)) credited.set(d.id, []);
      credited.get(d.id).push(u);
      underdog.set(`${u.id}|${d.id}`, unfavorableFight(g, u, d, true));
      event(
        g,
        [d.owner],
        `${TYPES[u.type].name} → ${label(d)} ${TYPES[d.type].name}, 피해 ${n}.`,
      );
      if (visibility(g, u.owner).has(key(d)))
        event(
          g,
          [u.owner],
          `${TYPES[u.type].name} → ${label(d)} ${TYPES[d.type].name}, 피해 ${n}.`,
        );
      else
        event(
          g,
          [u.owner],
          `${label(target)}에 포격했어요. 시야 밖의 피해는 확인할 수 없어요.`,
        );
      if (distance(u, d) === 1 && military(d) && !bombard) {
        addHit(u, Math.max(4, Math.round(damage(d, u, g) * counterMultiplier(g))));
        counters.set(u.id, d);
        underdog.set(`${d.id}|${u.id}`, unfavorableFight(g, d, u, false));
      }
    } else {
      const c = targetCity;
      if (c) {
        if (bombard) {
          g.reveals[u.owner] ??= [];
          g.reveals[u.owner].push({ q: c.q, r: c.r, turn: g.turn });
        }
        const [low, high] = combatRollRange(u);
        const n = cityDamage(u, c, g, low + g.random() * (high - low));
        cityHits.set(c.id, (cityHits.get(c.id) ?? 0) + n);
        if (!cityAttackers.has(c.id)) cityAttackers.set(c.id, []);
        cityAttackers.get(c.id).push(u);
        addXp(u, COMBAT_XP_PARTICIPATION);
        event(g, [c.owner], `${c.name} 방어 시설에 피해 ${n}.`);
        // A standing city returns fire on an adjacent direct attacker with a
        // population-scaled strength. Artillery keeps its stand-off immunity.
        if (!bombard && u.type !== "artillery" && distance(u, c) === 1 && cityCounterAttack(c, g) > 0) {
          const back = Math.min(u.hp, cityCounterDamage(c, g, 0.88 + g.random() * 0.24));
          if (back > 0) {
            addHit(u, back);
            event(g, [u.owner], `${c.name} 수비대 반격 · ${label(u)} 피해 ${back}.`);
            if (visibility(g, c.owner).has(key(u)))
              event(g, [c.owner], `${c.name} 수비대 반격 · ${label(u)} ${TYPES[u.type].name}에 피해 ${back}.`);
          }
        }
        event(
          g,
          [u.owner],
          visibility(g, u.owner).has(key(c))
            ? `${c.name} 방어 시설에 피해 ${n}.`
            : `${label(target)}에 포격했어요. 시야 밖의 피해는 확인할 수 없어요.`,
        );
      } else if (!fortHits.has(key(target)))
        event(
          g,
          [u.owner],
          visibility(g, u.owner).has(key(target))
            ? `${label(target)} 공격에서 적중을 확인하지 못했어요.`
            : `${label(target)}에 포격했어요. 시야 밖의 피해는 확인할 수 없어요.`,
        );
    }
  }
  // No mutual annihilation: when a melee exchange would kill both sides, the
  // side with the higher remaining strength keeps MIN_SURVIVOR_HP.
  for (const [attackerId, d] of counters) {
    const u = g.units.find((x) => x.id === attackerId);
    if (!u) continue;
    const resolved = preventMutualDeath({
      attackerHp: u.hp,
      attackerLoss: hits.get(u.id) ?? 0,
      defenderHp: d.hp,
      defenderLoss: hits.get(d.id) ?? 0,
    });
    if (!resolved.survivor) continue;
    hits.set(u.id, resolved.attackerLoss);
    hits.set(d.id, resolved.defenderLoss);
    const survivor = resolved.survivor === "attacker" ? u : d;
    event(g, [survivor.owner], `${label(survivor)} ${TYPES[survivor.type].name} 부대가 전멸 직전에 버텨 체력 ${Math.max(survivor.hp - (hits.get(survivor.id) ?? 0), 1)}로 살아남았어요.`);
  }
  const dying = new Set(
    g.units.filter((x) => hits.has(x.id) && x.hp > 0 && x.hp <= hits.get(x.id)).map((x) => x.id),
  );
  for (const u of g.units) {
    const loss = hits.get(u.id) ?? 0;
    if (loss)
      for (const player of observerIds(g))
        if (player === u.owner || visibility(g, player).has(key(u)))
          g.effects[player].push({
            kind: "damage",
            unitId: u.id,
            unit: publicUnit(u),
            at: { q: u.q, r: u.r },
            amount: Math.min(u.hp, loss),
            receiptCovered: true,
            destroyed: u.hp <= loss,
            turn: g.turn,
          });
    u.hp -= hits.get(u.id) ?? 0;
    if (u.hp <= 0) {
      markCarrierDestroyed(g, u.id);
      for (const a of credited.get(u.id) ?? [])
        addXp(a, killXp(underdog.get(`${a.id}|${u.id}`) === true));
      const counterKiller = counters.get(u.id);
      if (counterKiller && dying.has(u.id) && !dying.has(counterKiller.id))
        addXp(counterKiller, killXp(underdog.get(`${counterKiller.id}|${u.id}`) === true));
      event(g, [u.owner], `${TYPES[u.type].name} 부대를 잃었어요.`);
      event(
        g,
        seenBy(g, u).filter((p) => p !== u.owner),
        `${factionMap(g)[u.owner]?.name ?? u.owner}의 ${TYPES[u.type].name} 부대가 격파됐어요.`,
      );
    }
  }
  for (const u of g.units) u.xp += xp.get(u.id) ?? 0;
  for (const [position, loss] of fortHits) {
    const t = g.tiles.find((t) => key(t) === position),
      fort = structureAt(g, t);
    const hit = recordStructureHit(fort, loss, { turn: g.turn });
    const amount = hit.damage;
    for (const player of observerIds(g))
      if (player === fort.owner || visibility(g, player).has(position))
        g.effects[player].push({
          kind: "damage",
          fort: true,
          owner: fort.owner,
          name: structureKind(fort) === "encampment" ? "주둔지" : "요새",
          at: { q: t.q, r: t.r },
          amount,
          turn: g.turn,
        });
    event(
      g,
      seenBy(g, t),
      `${label(t)} 방어 건물 피해 ${amount}${fort.hp === 0 && structureWallHp(fort) === 0 ? " · 파괴됨 · 병력 진입 시 점령" : ""}.`,
    );
  }
  for (const c of g.cities) {
    normalizeCityDefense(c);
    const loss = cityHits.get(c.id) ?? 0;
    const wallLoss = Math.min(c.wallHp, loss);
    const bodyLoss = Math.min(c.hp, Math.max(0, loss - wallLoss));
    if (loss)
      for (const player of observerIds(g))
        if (player === c.owner || visibility(g, player).has(key(c)))
          g.effects[player].push({
            kind: "damage",
            cityId: c.id,
            owner: c.owner,
            name: c.name,
            at: { q: c.q, r: c.r },
            amount: wallLoss + bodyLoss,
            wallDamage: wallLoss,
            bodyDamage: bodyLoss,
            wallHp: Math.max(0, c.wallHp - wallLoss),
            hp: Math.max(0, c.hp - bodyLoss),
            destroyed: c.hp <= bodyLoss,
            turn: g.turn,
          });
    if (loss) {
      c.lastIncomingAttackTurn = g.turn;
      interruptWallRepair(g, c);
    }
    c.wallHp = Math.max(0, c.wallHp - wallLoss);
    c.hp = Math.max(0, c.hp - bodyLoss);
    if (loss && c.hp === 0 && !c.camp) {
      const invader = (cityAttackers.get(c.id) ?? []).find(unit =>
        unit.hp > 0 && ["spearman", "cavalry"].includes(unit.type) && distance(unit, c) === 1 && canCrossBorder(g,unit,unit,c));
      if (invader) {
        const from = { q: invader.q, r: invader.r };
        invader.q = c.q;
        invader.r = c.r;
        for (const player of observerIds(g))
          if (player === invader.owner || visibility(g, player).has(key(c)))
            g.effects[player].push({ kind: "move", unitId: invader.id, from, to: { q: c.q, r: c.r }, step: 0, turn: g.turn });
      }
    }
  }
  g.units = living(g);
  // Advance only a surviving melee attacker whose defeated target occupied
  // an adjacent, now-enterable tile. Ranged units never advance after a kill.
  for (const attacker of attacks) {
    const target = attacker.engageTarget ?? attacker.order?.target;
    if (attacker.hp <= 0 || !["spearman", "cavalry"].includes(attacker.type) ||
        !target || distance(attacker, target) !== 1 ||
        !beforeHealth.some(({unit, owner}) => owner !== attacker.owner && unit.hp <= 0 && equal(unit, target) && (credited.get(unit.id) ?? []).includes(attacker)) ||
        tileAt(g, target)?.terrain === "mountain" ||
        !canCrossBorder(g,attacker,attacker,target) ||
        living(g).some(unit => equal(unit, target) && blocksUnit(attacker, unit)) ||
        g.cities.some(city => city.hp > 0 && city.owner !== attacker.owner && equal(city, target))) continue;
    const from = { q: attacker.q, r: attacker.r };
    if (crossesRiver(g, attacker, target)) attacker.riverTurns = 3;
    attacker.q = target.q; attacker.r = target.r;
    for (const player of observerIds(g))
      if (player === attacker.owner || visibility(g, player).has(key(target)))
        g.effects[player].push({ kind: "move", unitId: attacker.id, from, to: { q: attacker.q, r: attacker.r }, step: 0, turn: g.turn });
  }
  for (const player of observerIds(g)) {
    let ownDamage = 0, opponentDamage = 0;
    for (const before of beforeHealth) {
      if (!before.viewers.includes(player)) continue;
      const loss = Math.max(0, before.hp - Math.max(0, before.unit.hp));
      if (before.owner === player) ownDamage += loss; else opponentDamage += loss;
    }
    if (ownDamage || opponentDamage)
      g.effects[player].push({ kind: "combat-result", ownDamage, opponentDamage, turn: g.turn });
  }
  // Relocation follows all firing; only the firing coordinate is broadcast.
  const retreaters = attacks.filter((u) => u.hp > 0 && u.order?.retreat);
  const retreatCounts = new Map();
  for (const u of retreaters)
    retreatCounts.set(
      key(u.order.retreat),
      (retreatCounts.get(key(u.order.retreat)) ?? 0) + 1,
    );
  const beforeRetreat = new Set(living(g).map(key));
  for (const u of retreaters)
    if (
      u.hp > 0 &&
      u.order.retreat &&
      retreatCounts.get(key(u.order.retreat)) === 1 &&
      tileAt(g, u.order.retreat).terrain !== "mountain" &&
      canCrossBorder(g,u,u,u.order.retreat) &&
      !living(g).some((e) => equal(e, u.order.retreat) && blocksUnit(u, e)) &&
      !g.cities.some(
        (c) => c.owner !== u.owner && c.hp > 0 && equal(c, u.order.retreat),
      )
    ) {
      if (crossesRiver(g, u, u.order.retreat)) u.riverTurns = 3;
      for (const player of observerIds(g))
        if (
          player === u.owner ||
          (visibility(g, player).has(key(u)) &&
            visibility(g, player).has(key(u.order.retreat)))
        )
          g.effects[player].push({
            kind: "relocate",
            unitId: u.id,
            from: { q: u.q, r: u.r },
            to: { ...u.order.retreat },
            turn: g.turn,
          });
      u.q = u.order.retreat.q;
      u.r = u.order.retreat.r;
    }
}
function handleActions(g, scope = living(g), endTurn = false) {
  const used = new Set();
  const merging = new Set(
    living(g)
      .filter((u) => u.order?.action === "merge")
      .flatMap((u) => [u.id, u.order.targetId]),
  );
  for (const u of [...scope].filter((u) => u.hp > 0)) {
    if (used.has(u.id)) continue;
    const a = u.order?.action;
    if (["farm", "develop", "pillage", "scorch", "repair", "repairStructure", "fort", "found", "merge", "fortify"].includes(a)) {
      u.movesLeft = 0;
      u.acted = true;
    }
    if (["farm", "develop", "pillage", "scorch", "repair", "repairStructure", "fort", "found"].includes(a))
      for (const p of observerIds(g))
        if (p === u.owner || visibility(g, p).has(key(u)))
          g.effects[p].push({
            kind: "build",
            unitId: u.id,
            unit: publicUnit(u),
            at: { q: u.q, r: u.r },
            action: a,
            consumed: a === "found" || u.charges === 1 || ["pillage", "scorch", "repair"].includes(a),
            turn: g.turn,
          });
    if (a === "merge") {
      const t = living(g).find((x) => x.id === u.order.targetId);
      if (
        t &&
        !used.has(t.id) &&
        t.owner === u.owner &&
        t.type === u.type &&
        distance(t, u) <= 1 &&
        ((t.size === 1 && u.size === 1) || (t.size === 2 && u.size === 2))
      ) {
        const size = t.size + u.size;
        // Freeze the old formation's exact paid amount before increasing its
        // size; a legacy full-payment marker must not cover the added troops.
        t.upkeepPaidAmount = ammunitionPreview(g, t).paidAmount;
        t.xp = Math.floor((t.xp * t.size + u.xp * u.size) / size);
        t.formation = mergeFormation(t, u, size);
        t.size = size;
        t.hp += u.hp;
        t.fortified = false;
        t.isolation = Math.max(t.isolation, u.isolation);
        t.riverTurns = Math.max(t.riverTurns, u.riverTurns);
        mergeManpower(t, u);
        mergeAmmunitionUpkeep(g, t, u);
        mergeUnitLogistics(g, t, u);
        t.movesLeft = 0;
        t.acted = true;
        t.mergedThisTurn = true;
        t.order = null;
        u.hp = 0;
        used.add(t.id);
        used.add(u.id);
        event(
          g,
          [t.owner],
          `${TYPES[t.type].name} ${t.size === 2 ? "대대 2개" : "여단 2개"}를 합쳐 ${formationTierName(t.size)}이 됐어요. 체력과 경험치를 이어받아요.`,
        );
      }
    }
    if (a === "farm") {
      const t = tileAt(g, u);
      if (
        u.charges > 0 &&
        t.owner === u.owner &&
        !t.farm &&
        !g.cities.some((c) => equal(c, u))
      ) {
        t.farm = true;
        u.charges--;
        event(
          g,
          [u.owner],
          `${label(u)} ${farmTerrainYield(t).name}를 조성했어요. 식량 +${farmYield(g, t).total}${farmTerrainYield(t).production ? ` · 생산 +${farmTerrainYield(t).production}` : ""}.`,
        );
      }
    }
    if (a === "develop") {
      const t = tileAt(g, u);
      if (
        u.charges > 0 &&
        t.owner === u.owner &&
        t.resource &&
        !t.developed
      ) {
        t.developed = true;
        t.farm = false;
        u.charges--;
        event(
          g,
          [u.owner],
          `${label(u)} ${RESOURCES[t.resource].improvement} 개발 완료.`,
        );
      }
    }
    if (a === "pillage" || a === "scorch") applyImprovementAction(g, u, a);
    if (a === "repair") repairImprovement(g, u);
    if (a === "repairStructure") {
      const structure = structureAt(g, u);
      const result = repairStructure(structure, 40, { owner: u.owner });
      if (result.repaired > 0) {
        u.charges--;
        event(g, [u.owner], `${label(u)} 방어 건물 체력 ${result.repaired} 수리 · 성벽은 도시 생산 사업으로 수리해요.`);
      }
    }
    if (a === "fort" && !fortIssue(g, u)) {
      tileAt(g, u).fort = { owner: u.owner, hp: FORT_HP, maxHp: FORT_HP };
      u.charges--;
      event(
        g,
        [u.owner],
        `${label(u)} 요새 완성 · 체력 ${FORT_HP} · 주둔 방어력 +25%.`,
      );
    }
    if (
      a === "found" &&
      u.type === "settler" &&
      !g.cities.some((c) => distance(c, u) < 4) &&
      !settlementIssue(g, u) && !restrictionViolation(g, u.owner, u, "found")
    ) {
      const city = {
        id: randomUUID(),
        owner: u.owner,
        name: `${factionMap(g)[u.owner]?.name ?? u.owner} ${
          isExpansion(g) && !g.founded?.[u.owner] ? "첫 도시" : "신도시"
        } ${g.cities.filter((c) => c.owner === u.owner).length + 1}`,
        q: u.q,
        r: u.r,
        population: 1,
        food: 0,
        growthProgress: 0,
        growthHalfGranted: false,
        starvationTurns: 0,
        citizenPolicy: { auto: true, lockedSlots: [], priority: [] },
        mobilizationQueue: [],
        mobilizationLastDispatchTurn: null,
        production: 0,
        queue: null,
        hp: 160,
        wallHp: 0,
        wallLevel: 0,
        attackUsed: false,
        capital: isExpansion(g) ? !g.founded?.[u.owner] : false,
        isolation: 0,
        supplied: true,
        territoryRadius: TERRITORY_BASE_RADIUS,
        territoryGrowth: 0,
        rulesVersion: "expansion-v1",
        lastIncomingAttackTurn: null,
        wallRepairStartedTurn: null,
        wallRepairStartHp: null,
      };
      g.cities.push(city);
      tileAt(g, u).farm = false;
      tileAt(g, u).developed = false;
      tileAt(g, u).fort = null;
      territory(g, city, { initial: true });
      if (isExpansion(g)) g.founded[u.owner] = true;
      u.hp = 0;
      event(g, [u.owner], `${city.name} 도시를 세웠어요.`);
    }
    if (a === "fortify") u.fortifyPending = true;
    if (endTurn && u.fortifyPending) {
      u.fortified = true;
      u.fortifyPending = false;
    }
    if (
      endTurn &&
      u.hp > 0 &&
      !u.attackUsed &&
      !u.mergedThisTurn &&
      u.isolation === 0 &&
      !merging.has(u.id)
    ) {
      const healed = Math.min(maxHealth(u) - u.hp, 16 * u.size);
      u.hp += healed;
      if (healed > 0)
        for (const player of observerIds(g))
          if (player === u.owner || visibility(g, player).has(key(u)))
            g.effects[player].push({
              kind: "heal",
              unitId: u.id,
              at: { q: u.q, r: u.r },
              amount: healed,
              turn: g.turn,
            });
    }
    if (u.type === "builder" && u.charges === 0) u.hp = 0;
  }
  g.units = living(g);
  for (const c of g.cities) {
    if (c.hp === 0) {
      for (const guard of g.units.filter(u => u.owner === c.owner && military(u) && equal(u, c) && u.hp > 0)) {
        for (const player of observerIds(g))
          if (player === guard.owner || visibility(g, player).has(key(c)))
            g.effects[player].push({ kind: "damage", unitId: guard.id, unit: publicUnit(guard), at: { q: guard.q, r: guard.r }, amount: guard.hp, destroyed: true, turn: g.turn });
        guard.hp = 0;
        markCarrierDestroyed(g, guard.id);
        event(g, [c.owner, ...seenBy(g, c)], `${c.name} 방어선 붕괴로 주둔 군사 부대가 전멸했어요.`);
      }
    }
    const invader = g.units.find(
      (u) =>
        atWar(g, u.owner, c.owner) &&
        military(u) &&
        u.type !== "artillery" &&
        equal(u, c),
    );
    if (c.camp) {
      if (c.hp === 0 && invader && captureBarbarianCamp(g, c, invader))
        event(g, [...new Set([invader.owner, ...seenBy(g,c)])], `${c.name}을 점령했어요. 주둔 군사로 10턴마다 식량·골드를 약탈할 수 있고 주변 야만인은 계속 나타나요.`);
      continue;
    }
    if (c.hp === 0 && invader) {
      const old = c.owner;
      releaseReservedManpower(c);
      for (const garrison of g.units.filter((u) => u.hp > 0 && equal(u, c) && u.id !== invader.id)) {
        if (!atWar(g, garrison.owner, invader.owner)) continue;
        if (military(garrison)) {
          garrison.hp = 0;
          markCarrierDestroyed(g, garrison.id);
          event(
            g,
            [old, invader.owner],
            `${c.name} 함락과 함께 주둔 군사 부대가 전멸했어요.`,
          );
        } else {
          captureCarrierCargo(g, { unitId: invader.id, carrierId: garrison.id, isHostile: (game, unit, shipment) => atWar(game, unit.owner, shipment.owner) });
          if (TYPES[garrison.type]?.internal) { garrison.hp = 0; continue; }
          garrison.owner = invader.owner;
          garrison.order = null;
          garrison.movesLeft = 0;
          garrison.attackUsed = true;
          garrison.acted = true;
          garrison.fortified = false;
          garrison.fortifyPending = false;
          event(
            g,
            [old, invader.owner],
            `${c.name}의 ${TYPES[garrison.type].name}이 점령군에 편입됐어요.`,
          );
        }
      }
      c.owner = invader.owner;
      c.hp = Math.min(cityMaxHealth(c), 80);
      c.wallHp = 0;
      c.queue = null;
      c.production = 0;
      c.productionPending = false;
      c.wallRepairStartedTurn = null;
      c.wallRepairStartHp = null;
      c.productionTarget = null;
      c.productionTargetWallMaxHp = null;
      c.lastIncomingAttackTurn = g.turn;
      c.attackUsed = true;
      for (const t of g.tiles) if (t.cityId === c.id) t.owner = invader.owner;
      if (isExpansion(g)) g.founded[invader.owner] = true;
      event(
        g,
        [old, invader.owner, ...seenBy(g, c)],
        `${c.name} 도시가 점령됐어요.`,
      );
    }
  }
  g.units = living(g);
}
function settleGrowth(g, city, foodNet, owner, values = null) {
  // Legacy and expansion/off matches retain the original surplus ledger in
  // `city.food`; in expansion/off it is growth progress, never a physical
  // stockpile.  Detailed supply is the only mode with city food storage.
  if (isSupplyOn(g)) {
    // The caller passes the complete per-city economy record in detailed
    // mode.  Keep the old three-argument call usable for legacy tests and
    // imported snapshots.
    if (!values) return;
    const beforeStock = Math.max(0, Number(city.food) || 0);
    const consumption = Math.max(0, Number(values.foodConsumption) || 0);
    const available = beforeStock + Math.max(0, Number(values.foodGross) || 0);
    const fed = available >= consumption;
    const capacity = cityFoodCapacity(city, Number(values.militaryFood) || 0);
    city.food = Math.min(capacity, Math.max(0, available - consumption));
    city.growthProgress = Math.max(0, Number(city.growthProgress) || 0);
    const target = growthTarget(city.population);
    const half = growthHalfTarget(city.population);
    if (fed) {
      city.starvationTurns = 0;
      const before = city.growthProgress;
      city.growthProgress += 1;
      if (!city.growthHalfGranted && before < half && city.growthProgress >= half) {
        const tile = expandOne(g, city, "halfway");
        city.growthHalfGranted = true;
        event(
          g,
          [owner],
          tile
            ? `${city.name} 성장 절반 · 인접 영토 1칸이 늘었어요.`
            : `${city.name} 성장 절반 · 반경 3칸 한도로 새 영토를 얻지 못했어요.`,
        );
      }
      while (city.growthProgress >= target) {
        city.growthProgress -= target;
        city.population++;
        const tile = expandOne(g, city, "population");
        city.growthHalfGranted = false;
        event(
          g,
          [owner],
          tile
            ? `${city.name} 인구가 ${city.population}으로 늘었어요 · 영토 1칸이 늘었어요.`
            : `${city.name} 인구가 ${city.population}으로 늘었어요 · 반경 3칸 한도로 새 영토가 없어요.`,
        );
      }
    } else {
      // Stored food has been consumed completely.  Growth progress pauses
      // exactly where it was; one population-equivalent is lost per unfed
      // turn above the minimum, never by minting or refunding manpower.
      city.starvationTurns = (city.starvationTurns ?? 0) + 1;
      if (city.population > MIN_CITY_POPULATION) {
        city.population = Math.max(MIN_CITY_POPULATION, city.population - 1);
        city.growthProgress = Math.min(
          city.growthProgress,
          Math.max(0, growthTarget(city.population) - 1),
        );
        city.growthHalfGranted =
          city.growthProgress >= growthHalfTarget(city.population);
        event(g, [owner], `${city.name}: 도시 식량이 바닥나 인구가 줄었어요. 성장 진척은 유지돼요.`);
      } else event(g, [owner], `${city.name}: 도시 식량 부족 · 성장 진척이 멈췄어요.`);
    }
    return;
  }
  const before = city.food;
  city.food += foodNet;
  const initialHalf = growthHalfTarget(city.population);
  let halfClaimed =
    city.territoryHalfwayClaimed ?? before >= initialHalf;
  if (!halfClaimed && before < initialHalf && city.food >= initialHalf) {
    const tile = expandOne(g, city, "halfway");
    halfClaimed = true;
    event(
      g,
      [owner],
      tile
        ? `${city.name} 성장 절반 · 인접 영토 1칸이 늘었어요.`
        : `${city.name} 성장 절반 · 반경 3칸 한도로 새 영토를 얻지 못했어요.`,
    );
  }
  while (city.food >= growthTarget(city.population)) {
    const target = growthTarget(city.population);
    city.food -= target;
    city.population++;
    const tile = expandOne(g, city, "population");
    event(
      g,
      [owner],
      tile
        ? `${city.name} 인구가 ${city.population}으로 늘었어요 · 영토 1칸이 늘었어요.`
        : `${city.name} 인구가 ${city.population}으로 늘었어요 · 반경 3칸 한도로 새 영토가 없어요.`,
    );
    halfClaimed = false;
    if (city.food >= growthHalfTarget(city.population)) {
      const tile = expandOne(g, city, "halfway");
      halfClaimed = true;
      event(
        g,
        [owner],
        tile
          ? `${city.name} 다음 성장 절반 · 인접 영토 1칸이 늘었어요.`
          : `${city.name} 다음 성장 절반 · 반경 3칸 한도로 새 영토가 없어요.`,
      );
    }
  }
  // A starvation loss never revokes old tiles, but it does reset the current
  // population's unclaimed half marker so future positive growth remains
  // one-for-one with a threshold crossing.
  if (city.food < 0) {
    city.food = 0;
    if (city.population > MIN_CITY_POPULATION)
      city.population = Math.max(MIN_CITY_POPULATION, city.population - 1);
    halfClaimed = false;
    event(g, [owner], `${city.name}: 식량이 부족해 인구가 줄었어요.`);
  }
  city.territoryHalfwayClaimed = halfClaimed;
  city.growthProgress = Math.max(0, city.food);
}

function growAndProduce(g, owners = ["p1", "p2", "p3", "p4", "cs"]) {
  for (const p of owners) {
    {
      const upkeep = settleAmmunitionUpkeep(g, p);
      if (upkeep.charged)
        event(g, [p], `이번 턴 화약 부대 유지비 · 초석 ${upkeep.charged}개를 사용했어요.`);
      if (upkeep.shortfall)
        event(g, [p], `초석 유지비가 부족해요 · 기존 부대는 공격 가능하며 신규 생산에는 자원이 필요해요.`);
    }
    const e = economy(g, p);
    g.gold[p] += e.goldIncome;
    for (const [r, n] of Object.entries(e.income))
      g.stockpiles[p][r] += Math.max(
        0,
        Math.min(n, e.resourceCapacity - g.stockpiles[p][r]),
      );
    // Detailed-supply military queues dispatch at most one unit per city on
    // that city's controller turn.  This happens after income is credited,
    // so a newly-produced resource can satisfy the one atomic dispatch, while
    // pending citizens remain ordinary workers until this commit.
    processMobilization(g, p);
    const settledEconomy = economy(g, p);
    for (const c of g.cities.filter((c) => c.owner === p && !c.camp)) {
      normalizeCityDefense(c);
      if (
        !c.camp &&
        c.hp > 0 &&
        c.hp < cityMaxHealth(c) &&
        (c.lastIncomingAttackTurn === null ||
          // A damaged city gets one complete quiet turn before body healing
          // begins. The wall repair cooldown is separate and longer.
          g.turn - c.lastIncomingAttackTurn >= 2)
      ) {
        const healed = Math.min(16, cityMaxHealth(c) - c.hp);
        c.hp += healed;
        if (healed > 0)
          for (const player of observerIds(g))
            if (player === c.owner || visibility(g, player).has(key(c)))
              g.effects[player].push({
                kind: "heal",
                cityId: c.id,
                at: { q: c.q, r: c.r },
                amount: healed,
                turn: g.turn,
              });
      }
      const values = settledEconomy.perCity.find((x) => x.id === c.id);
      settleGrowth(g, c, values.foodNet, p, values);
      if (c.queue) {
        if (c.queue === "wallRepair") {
          if (c.productionTarget) {
            const tile = tileAt(g, c.productionTarget), structure = tile?.encampment;
            const valid = structure?.owner === p && deterministicTileCity(g, tile)?.id === c.id;
            const result = valid ? repairWalls(structure, values.productionRate, { owner: p, turn: g.turn }) : { interrupted: true, reason: "주둔지 소유권이 바뀌었어요." };
            c.production += result.repaired ?? 0;
            if (result.complete || result.interrupted || result.code || !valid) {
              c.queue = null;
              c.production = 0;
              c.productionTarget = null;
              c.productionTargetWallMaxHp = null;
              c.wallRepairStartedTurn = null;
              c.wallRepairStartHp = null;
              c.productionPending = true;
              if (result.complete) c.lastProduction = { type: "wallRepair", turn: g.turn };
              event(g, [p], result.complete ? `${c.name} 주둔지 성벽 수리가 완료됐어요.` : `${c.name} 주둔지 성벽 수리 중단 · ${result.reason}`);
            }
            continue;
          }
          if (!Number.isFinite(c.wallRepairStartedTurn))
            c.wallRepairStartedTurn = g.turn;
          if (!Number.isFinite(c.wallRepairStartHp))
            c.wallRepairStartHp = c.wallHp;
          if (
            c.lastIncomingAttackTurn !== null &&
            c.wallRepairStartedTurn <= c.lastIncomingAttackTurn
          ) {
            interruptWallRepair(g, c);
            continue;
          }
          const repairCost = productionType("wallRepair", c).cost;
          c.production = Math.min(
            repairCost,
            c.production + values.productionRate,
          );
          c.wallHp = Math.min(
            wallMaxHealth(c),
            c.wallRepairStartHp + c.production,
          );
          if (c.production >= repairCost || c.wallHp >= wallMaxHealth(c)) {
            c.wallHp = wallMaxHealth(c);
            c.production = 0;
            c.queue = null;
            c.productionPending = true;
            c.lastProduction = { type: "wallRepair", turn: g.turn };
            c.wallRepairStartedTurn = null;
            c.wallRepairStartHp = null;
            event(g, [p], `${c.name} 성벽 수리가 완료됐어요.`);
          }
          continue;
        }
        c.production = Math.min(
          productionType(c.queue, c).cost,
          c.production + values.productionRate,
        );
        if (["tradingPost", "encampment"].includes(c.queue)) {
          const type = c.queue;
          if (c.production < productionType(type, c).cost) continue;
          if (type === "tradingPost") c.tradingPost = { built: true, builtTurn: g.turn };
          else {
            const issue = encampmentIssue(g, p, c.productionTarget, { cityId: c.id });
            if (issue || deterministicTileCity(g, tileAt(g, c.productionTarget), g.cities)?.id !== c.id) {
              c.productionBlocked = issue ?? "주둔지 예정 타일의 소속 도시가 바뀌었어요.";
              continue;
            }
            placeEncampment(g, p, c.productionTarget, { cityId: c.id, builtTurn: g.turn });
          }
          c.lastProduction = { type, turn: g.turn };
          c.production = 0;
          c.queue = null;
          c.productionTarget = null;
          c.productionBlocked = null;
          c.productionPending = true;
          event(g, [p], `${c.name} ${productionType(type, c).name} 건설 완료.`);
          continue;
        }
        const eco = economy(g, p);
        if (
          c.queue === "walls" &&
          c.production >= productionType("walls", c).cost
        ) {
          const previousWallHp = c.wallHp;
          c.wallLevel = (c.wallLevel ?? 0) + 1;
          c.wallHp = Math.min(wallMaxHealth(c), previousWallHp + 50);
          c.production = 0;
          c.queue = null;
          c.productionPending = true;
          c.lastProduction = { type: "walls", turn: g.turn };
          event(g, [p], `${c.name} 성벽 ${c.wallLevel}레벨 증축 완료.`);
          continue;
        }
        if (
          c.production >= productionType(c.queue, c).cost &&
          (!eco.armyCapacityEnabled || eco.used < eco.capacity) &&
          c.queue !== "walls"
        ) {
          if (c.queue === "merchant" && (!merchantSummary(g, c).built || merchantSummary(g, c).active > 0)) {
            c.productionBlocked = "교역소의 상인 정원이 가득 찼어요.";
            continue;
          }
          // Completed units appear on the city tile, or on the nearest own
          // adjacent tile when the city tile is already occupied, so a
          // garrison never stalls production indefinitely.
          const spawn = [{ q: c.q, r: c.r }, ...neighbors(c)].find(
            (t) =>
              tileAt(g, t) &&
              tileAt(g, t).terrain !== "mountain" &&
              (equal(t, c) || tileAt(g, t).owner === p) &&
              !g.cities.some((city) => city.hp > 0 && city.id !== c.id && equal(city, t)) &&
              !g.units.some(
                (u) =>
                  equal(u, t) && blocksUnit({ owner: p, type: c.queue }, u),
              ),
          );
          if (spawn) {
            const type = c.queue;
            // Queues created after the manpower migration already reserve
            // half a population.  A legacy serialized queue has no reserve;
            // charge it at completion instead of minting a free unit.
            if (
              (Number(c.manpowerReserved) || 0) < UNIT_MANPOWER_COST &&
              !reserveManpower(c, UNIT_MANPOWER_COST)
            ) {
              if (!c.manpowerBlocked)
                event(
                  g,
                  [p],
                  `${c.name} 생산 완료 대기 · 인구 ${UNIT_MANPOWER_COST}명이 필요해요.`,
                );
              c.manpowerBlocked = true;
              continue;
            }
            addUnit(g, p, type, spawn);
            const produced = g.units.at(-1);
            Object.assign(produced, unitManpower(g, c, p));
            if (type === "merchant") produced.tradingPostCityId = c.id;
            c.production -= productionType(type, c).cost;
            c.queue = null;
            c.manpowerReserved = 0;
            c.manpowerBlocked = false;
            c.productionPending = true;
            c.lastProduction = { type, turn: g.turn };
            event(g, [p], `${c.name}에서 ${TYPES[type].name} 생산을 마쳤어요.`);
          }
        }
      }
    }
    settleLogisticsTurn(g, p);
  }
}

function settleLogisticsTurn(g, owner) {
  const positions = new Map(living(g).map(unit => [unit.id, { q: unit.q, r: unit.r }]));
  const seenBefore = Object.fromEntries(observerIds(g).map(player => [player, visibility(g, player)]));
  const result = tickLogistics(g, { owner, turn: g.turn, isHostile: (game, unit, shipment) => atWar(game, unit.owner, shipment.cargoOwner ?? shipment.owner) });
  for (const unit of living(g)) {
    const from = positions.get(unit.id);
    if (!from || equal(from, unit)) continue;
    for (const player of observerIds(g))
      if (player === unit.owner || (seenBefore[player].has(key(from)) && visibility(g, player).has(key(unit))))
        g.effects[player].push({ kind: "move", unitId: unit.id, from, to: { q: unit.q, r: unit.r }, step: 0, turn: g.turn });
  }
  if (result.delivered.length) event(g, [owner], `화물 ${result.delivered.length}건이 목적지에 도착했어요.`);
  if (result.captured.length) event(g, [owner], `이동 중 화물 ${result.captured.length}건이 나포됐어요.`);
  if (result.lost.length) event(g, [owner], `화물 ${result.lost.length}건의 운송이 중단됐어요.`);
}

export function supplyNetwork(g, player) {
  const foes = living(g).filter(
    (u) => atWar(g, u.owner, player) && military(u),
  );
  const friendly = new Set(
    living(g)
      .filter((u) => u.owner === player && military(u))
      .map(key),
  );
  const passable = new Set(
    g.tiles
      .filter(
        (t) =>
          t.terrain !== "mountain" &&
          !g.cities.some(
            (c) => c.hp > 0 && atWar(g, c.owner, player) && equal(c, t),
          ) &&
          !foes.some((u) => equal(u, t)) &&
          (friendly.has(key(t)) || !foes.some((u) => distance(u, t) === 1)),
      )
      .map(key),
  );
  // Supply comes from a city's accessible hinterland, not an artificial world edge.
  // A surrounded city needs at least 12 connected traversable hexes to sustain it.
  const network = new Set(),
    visited = new Set(),
    cities = g.cities.filter((c) => c.owner === player);
  for (const root of g.tiles) {
    if (!passable.has(key(root)) || visited.has(key(root))) continue;
    const queue = [root];
    visited.add(key(root));
    for (let i = 0; i < queue.length; i++)
      for (const n of neighbors(queue[i]))
        if (passable.has(key(n)) && !visited.has(key(n))) {
          visited.add(key(n));
          queue.push(n);
        }
    if (
      queue.length >= 12 &&
      (!cities.length || cities.some((c) => queue.some((p) => equal(p, c))))
    )
      for (const t of queue) network.add(key(t));
  }
  return network;
}
export function updateSupply(g, owners = null) {
  owners ??= factionIds(g).filter((p) => p !== "barb");
  for (const p of owners) {
    const network = supplyNetwork(g, p);
    for (const entity of [...living(g), ...g.cities].filter(
      (e) => e.owner === p,
    )) {
      if (isExpansion(g) && !g.founded?.[p] && g.turn <= (g.startGraceTurns ?? START_GRACE_TURNS)) {
        entity.supplied = true;
        entity.isolation = Math.max(0, (entity.isolation ?? 0) - 1);
        continue;
      }
      entity.supplied = network.has(key(entity));
      entity.isolation = Math.max(
        0,
        Math.min(5, (entity.isolation ?? 0) + (entity.supplied ? -1 : 1)),
      );
      if (!entity.supplied && entity.isolation >= 3) {
        entity.hp = Math.max(
          g.cities.includes(entity) ? 0 : 1,
          entity.hp - (entity.isolation - 2) * 4 * (entity.size ?? 1),
        );
      }
    }
  }
}
export function resolveTurn(g, now = Date.now()) {
  if (g.phase !== "planning" || g.paused) return;
  if (simultaneous(g)) return resolveSimultaneousRound(g, now);
  if (isExpansion(g)) return resolveExpansionTurn(g, now);
  g.events = Object.fromEntries(factionIds(g).map((p) => [p, []]));
  beginEffects(g);
  updateContacts(g);
  const ending = g.activePlayer;
  handleActions(
    g,
    living(g).filter((u) => u.owner === ending),
    true,
  );
  updateSupply(g, [ending]);
  growAndProduce(g, [ending]);
  if (ending === "p2") {
    playNpcs(g, now);
    g.lastNpcTurns = { round: g.turn, factions: ["p3", "p4", "cs", "barb"] };
    g.turn++;
    expireProposals(g);
  }
  g.activePlayer = other(ending);
  for (const c of g.cities.filter((c) => c.owner === g.activePlayer))
    c.attackUsed = false;
  for (const u of g.units.filter((u) => u.owner === g.activePlayer)) {
    delete u.engageTarget;
    resetUnitActions(g, u);
    u.mergedThisTurn = false;
    u.acted = false;
    u.riverTurns = Math.max(0, u.riverTurns - 1);
    if (u.order?.queued) u.order.queued = false;
  }
  prepayAmmunition(g, g.activePlayer);
  const starting = living(g).filter((u) => u.owner === g.activePlayer).sort((a, b) => (a.order?.sequence ?? 0) - (b.order?.sequence ?? 0));
  handleMoves(g, starting);
  handleCombat(g, starting);
  handleActions(g, [], false);
  for (const u of g.units) {
    if (u.order?.action !== "move" || !u.order.path.length) u.order = null;
    delete u.engageTarget;
  }
  checkVictory(g);
  if (turnLimitReached(g)) {
    const score = (p) =>
      economy(g, p).population * 5 +
      g.tiles.filter((t) => t.owner === p && t.farm).length * 3 +
      g.units.filter((u) => u.owner === p).reduce((n, u) => n + u.size * 2, 0);
    const a = score("p1"),
      b = score("p2");
    const scores = ["p1", "p2", "p3", "p4"]
      .map((p) => [p, score(p)])
      .sort((a, b) => b[1] - a[1]);
    g.winner = scores[0][1] === scores[1][1] ? "draw" : scores[0][0];
    g.phase = "finished";
    g.finishedBy = "turnLimit";
    event(
      g,
      observerIds(g),
      `최종 점수 · ${scores.map(([p, n]) => `${factionMap(g)[p].name} ${n}`).join(" / ")}`,
    );
  }
  updateContacts(g);
  g.revision++;
  g.players.p1.ready = false;
  g.players.p2.ready = false;
  g.deadline = g.phase === "planning" ? now + g.turnSeconds * 1000 : null;
  g.turnStartedAt = now;
  g.practicePassAt =
    g.mode === "practice" && g.activePlayer === "p2" ? now + 3000 : null;
}

function prepareActiveSeat(g, player, { settleUpkeep = true } = {}) {
  for (const c of g.cities.filter((c) => c.owner === player)) c.attackUsed = false;
  for (const u of g.units.filter((u) => u.owner === player)) {
    delete u.engageTarget;
    resetUnitActions(g, u);
    u.mergedThisTurn = false;
    u.acted = false;
    u.riverTurns = Math.max(0, u.riverTurns - 1);
    if (u.order?.queued) u.order.queued = false;
  }
  if (settleUpkeep) prepayAmmunition(g, player);
}
/**
 * Powder units pay their once-per-round niter upkeep when their own turn
 * begins. A unit that paid may attack for the rest of that turn even when the
 * stockpile then reads zero; the end-of-turn settlement sees the paid marker
 * and charges nothing twice. Units created later in the turn still settle on
 * the end of the turn. Attacks never spend niter or depend on payment.
 */
function prepayAmmunition(g, player) {
  const upkeep = settleAmmunitionUpkeep(g, player);
  if (upkeep.charged)
    event(g, [player], `턴 시작 · 화약 부대 초석 유지비 ${upkeep.charged}개를 냈어요.`);
  if (upkeep.shortfall)
    event(g, [player], `초석 유지비 ${upkeep.shortfall}개가 부족해요 · 기존 부대는 공격 가능하며 신규 생산에는 자원이 필요해요.`);
}

function resolveExpansionTurn(g, now) {
  g.events = Object.fromEntries(factionIds(g).map((p) => [p, []]));
  beginEffects(g);
  updateContacts(g);
  const ending = g.activePlayer,
    order = turnIds(g),
    index = Math.max(0, order.indexOf(ending));
  handleActions(g, living(g).filter((u) => u.owner === ending), true);
  updateSupply(g, [ending]);
  growAndProduce(g, [ending]);
  // Run only the NPC slots actually crossed. Running every NPC at each gap
  // grants extra turns in human/NPC/human/NPC lobbies. Non-seat factions act
  // exactly once at the round boundary, including all-human lobbies.
  let next = null;
  for (let step = 1; step <= order.length; step++) {
    const candidateIndex = (index + step) % order.length;
    if (candidateIndex === 0) {
      const extras = ["cs", "barb"].filter(id => g.players[id] && !order.includes(id));
      if (extras.length) playNpcs(g, now, extras);
      g.turn++;
      expireProposals(g);
    }
    const candidate = order[candidateIndex];
    if (g.players[candidate]?.eliminated) continue;
    if (
      g.players[candidate]?.controller !== "npc" &&
      g.players[candidate]?.npc !== true
    ) {
      next = candidate;
      break;
    }
    playNpcs(g, now, [candidate]);
  }
  if (!next) {
    checkVictory(g);
    updateContacts(g);
    g.revision++;
    g.deadline = g.phase === "planning" ? now + g.turnSeconds * 1000 : null;
    g.turnStartedAt = now;
    return;
  }
  g.activePlayer = next;
  prepareActiveSeat(g, next);
  const starting = living(g)
    .filter((u) => u.owner === next)
    .sort((a, b) => (a.order?.sequence ?? 0) - (b.order?.sequence ?? 0));
  handleMoves(g, starting);
  handleCombat(g, starting);
  handleActions(g, [], false);
  for (const u of g.units) {
    if (u.order?.action !== "move" || !u.order.path.length) u.order = null;
    delete u.engageTarget;
  }
  checkVictory(g);
  if (turnLimitReached(g)) {
    const scores = order
      .map((p) => [
        p,
        economy(g, p).population * 5 +
          g.tiles.filter((t) => t.owner === p && t.farm).length * 3 +
          g.units.filter((u) => u.owner === p).reduce((n, u) => n + u.size * 2, 0),
      ])
      .sort((a, b) => b[1] - a[1]);
    // Never end an un-founded expansion match on a zero-city score.
    if (g.cities.some((c) => c.capital && !c.camp)) {
      g.winner = scores[0][1] === scores[1]?.[1] ? "draw" : scores[0][0];
      g.phase = "finished";
      g.finishedBy = "turnLimit";
      event(
        g,
        observerIds(g),
        `최종 점수 · ${scores.map(([p, n]) => `${factionMap(g)[p].name} ${n}`).join(" / ")}`,
      );
    }
  }
  updateContacts(g);
  g.revision++;
  for (const seat of Object.values(g.players)) seat.ready = false;
  g.deadline = g.phase === "planning" ? now + g.turnSeconds * 1000 : null;
  g.turnStartedAt = now;
}
function resolveSimultaneousRound(g, now) {
  g.events = Object.fromEntries(factionIds(g).map((p) => [p, []]));
  beginEffects(g);
  updateContacts(g);
  const order = turnIds(g),
    direct = directIds(g);
  // Every direct seat ends its actions in seat order, then settles.
  for (const p of direct)
    handleActions(g, living(g).filter((u) => u.owner === p), true);
  updateSupply(g, direct);
  growAndProduce(g, direct);
  // NPC orders happen during the shared countdown; only settlement happens here.
  const npcSeats = order.filter((id) => !direct.includes(id));
  const extras = [...new Set([...npcSeatIds(g.players), "cs", "barb"])].filter((id) => g.players[id] && !order.includes(id));
  const npcs = [...npcSeats, ...extras];
  const unstarted = npcs.filter(id => g.npcPreparedTurns?.[id] !== g.turn);
  if (unstarted.length) playNpcs(g, now, unstarted, { realtime: true });
  if (npcs.length) playNpcs(g, now, npcs, { settleOnly: true });
  g.turn++;
  expireProposals(g);
  g.activePlayer = direct[0] ?? order[0];
  // All direct seats start the new round together: fresh movement, prepaid
  // ammunition, and persistent routes advance in seat order (first come).
  for (const p of direct) {
    prepareActiveSeat(g, p);
    const starting = living(g)
      .filter((u) => u.owner === p)
      .sort((a, b) => (a.order?.sequence ?? 0) - (b.order?.sequence ?? 0));
    handleMoves(g, starting);
    handleCombat(g, starting);
  }
  handleActions(g, [], false);
  for (const u of g.units) {
    if (u.order?.action !== "move" || !u.order.path.length) u.order = null;
    delete u.engageTarget;
  }
  checkVictory(g);
  if (turnLimitReached(g)) {
    const scores = order
      .map((p) => [
        p,
        economy(g, p).population * 5 +
          g.tiles.filter((t) => t.owner === p && t.farm).length * 3 +
          g.units.filter((u) => u.owner === p).reduce((n, u) => n + u.size * 2, 0),
      ])
      .sort((a, b) => b[1] - a[1]);
    if (g.cities.some((c) => c.capital && !c.camp)) {
      g.winner = scores[0][1] === scores[1]?.[1] ? "draw" : scores[0][0];
      g.phase = "finished";
      g.finishedBy = "turnLimit";
      event(
        g,
        observerIds(g),
        `최종 점수 · ${scores.map(([p, n]) => `${factionMap(g)[p].name} ${n}`).join(" / ")}`,
      );
    }
  }
  updateContacts(g);
  g.revision++;
  for (const seat of Object.values(g.players)) seat.ready = false;
  g.deadline = g.phase === "planning" ? now + g.turnSeconds * 1000 : null;
  g.turnStartedAt = now;
}
/** Turn limit is per-game; `null`/missing means unlimited (default). */
function turnLimitReached(g) {
  return (
    g.phase !== "finished" &&
    Number.isInteger(g.maxTurns) &&
    g.turn > g.maxTurns
  );
}
function checkVictory(g) {
  for (const id of Object.keys(g.players).filter(id => !["cs", "barb"].includes(id))) {
    if (!g.players[id].eliminated && !living(g).some(u => u.owner === id) && !g.cities.some(c => c.owner === id && !c.camp)) {
      g.players[id].eliminated = true;
      g.players[id].ready = true;
      event(g, observerIds(g), `${factionMap(g)[id]?.name ?? id} 문명이 멸망했어요. 사람 플레이어는 관전을 계속할 수 있어요.`);
    }
  }
  if (
    isExpansion(g) &&
    turnIds(g).some((p) => !g.founded?.[p])
  ) {
    // A settler-start match cannot be won or accidentally ended before the
    // civilizations have had a legal chance to found their first cities.
    return;
  }
  const capitals = g.cities.filter((c) => c.capital);
  const owners = new Set(capitals.map((c) => c.owner));
  if (capitals.length && owners.size === 1) {
    g.winner = [...owners][0];
    g.phase = "finished";
    g.finishedBy = "capital";
  }
  if (g.phase === "finished") g.deadline = null;
}
function playNpcs(g, now, selected = null, { realtime = false, settleOnly = false } = {}) {
  const savedDeadline = g.deadline;
  const savedActivePlayer = g.activePlayer;
  g.deadline = null;
  g.internalNpc = true;
  const attempt = (fn) => {
    try {
      fn();
      return true;
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      return false;
    }
  };
  try {
    const npcIds = (selected ?? [...npcSeatIds(g.players), "cs", "barb"]).filter(
      (p, i, all) => g.players[p] && !g.players[p].eliminated && all.indexOf(p) === i,
    );
    if (isExpansion(g)) {
      const previous = g.lastNpcTurns?.round === g.turn ? g.lastNpcTurns.factions : [];
      g.lastNpcTurns = { round: g.turn, factions: [...new Set([...previous, ...npcIds])] };
    }
    for (const p of npcIds) {
      g.activePlayer = p;
      g.players[p].ready = false;
      g.npcPreparedTurns ??= {};
      if (!realtime && !settleOnly || g.npcPreparedTurns[p] !== g.turn) {
      g.npcPreparedTurns[p] = g.turn;
      for (const u of g.units.filter((u) => u.owner === p)) {
        resetUnitActions(g, u);
        u.mergedThisTurn = false;
        u.acted = false;
        u.order = null;
        delete u.engageTarget;
        u.riverTurns = Math.max(0, u.riverTurns - 1);
      }
      for (const c of g.cities.filter((c) => c.owner === p))
        c.attackUsed = false;
      prepayAmmunition(g, p);
      }
      if (!settleOnly) {
      let view = observe(g, p, now);
      const guaranteeDecision = npcGuaranteeDecision(view);
      if (guaranteeDecision)
        attempt(() =>
          transact(g, p, { turn: g.turn, ...guaranteeDecision }, now),
        );
      view = observe(g, p, now);
      const diplomacy = npcDiplomacy(view);
      if (diplomacy)
        attempt(() => transact(g, p, { turn: g.turn, ...diplomacy }, now));
      view = observe(g, p, now);
      g.npcEconomyTurns ??= {};
      if (!realtime || g.npcEconomyTurns[p] !== g.turn) {
      g.npcEconomyTurns[p] = g.turn;
      for (const prod of npcEconomy(view))
        attempt(() =>
          prod.transaction
            ? transact(g, p, { turn: g.turn, ...prod.transaction }, now)
            : submitOrders(g, p, { turn: g.turn, ...prod }, now),
        );
      }
      view = observe(g, p, now);
      for (const c of view.cities.filter(
        (c) => c.owner === p && c.hp > 0 && c.wallHp > 0 && !c.attackUsed,
      )) {
        const target = observe(g, p, now)
          .units.filter((u) => u.hostile && distance(u, c) <= 2)
          .sort((a, b) => a.hp - b.hp || (a.type === "artillery" ? -1 : 1))[0];
        if (target)
          attempt(() =>
            submitOrders(
              g,
              p,
              {
                turn: g.turn,
                orders: [
                  {
                    cityId: c.id,
                    action: "cityBombard",
                    target: { q: target.q, r: target.r },
                  },
                ],
              },
              now,
            ),
          );
      }
      for (const id of npcTurnOrder(observe(g, p, now)))
        for (let step = 0; step < (realtime ? 1 : 2); step++) {
          let order = npcUnitOrder(observe(g, p, now), id);
          if (realtime && order?.action === "fortify" && savedDeadline - now > 2000) break;
          if (realtime && order?.action === "move") {
            const next = order.path?.[0];
            if (!next) break;
            order = { ...order, target: next, path: [next] };
          }
          if (
            !order ||
            !attempt(() =>
              submitOrders(g, p, { turn: g.turn, orders: [order] }, now),
            )
          )
            break;
        }
      }
      if (!realtime) {
      handleActions(
        g,
        living(g).filter((u) => u.owner === p),
        true,
      );
      if (p !== "barb") {
        updateSupply(g, [p]);
        growAndProduce(g, [p]);
      } else settleLogisticsTurn(g, p);
      }
    }
    if (!realtime && npcIds.includes("barb") && g.turn % 4 === 0)
      for (const site of campSpawnSites(g)) {
        if (living(g).filter((u) => u.owner === "barb").length >= 12) break;
        const c = g.cities.find(c => c.id === site.campId);
        addUnit(
            g,
            "barb",
            g.turn >= 12 ? "cavalry" : "spearman",
            { q: site.q, r: site.r },
            { home: { q: c.q, r: c.r }, movesLeft: 0 },
          );
      }
  } finally {
    g.internalNpc = false;
    g.deadline = savedDeadline;
    g.activePlayer = savedActivePlayer;
  }
}
function expireProposals(g) {
  expireTerritorialUltimatums(g, { event });
  for (const [permission, until] of Object.entries(g.openBorders ?? {})) {
    if (until > g.turn) continue;
    delete g.openBorders[permission];
    event(g, permission.split(">"), "30턴 국경개방이 만료됐어요. 평시 진입이 제한되며 남은 부대는 철수할 수 있어요.");
  }
  const expired = (p) =>
    p.expires <= g.turn || (p.kind === "deal" && !dealEntitiesValid(g, p));
  const stale = g.proposals.filter(expired);
  for (const p of stale) {
    refundProposal(g, p);
    notifyTrade(g, p, "expired");
  }
  g.proposals = g.proposals.filter((p) => !expired(p));
  expireGuaranteeCalls(g, {
    turn: g.turn,
    emit: (game, players, text, extra) => event(game, players, text, extra),
  });
}
const GUARANTEE_ACTION_SET = new Set([
  "guarantee",
  "issueGuarantee",
  "withdrawGuarantee",
  "acceptGuarantee",
  "rejectGuarantee",
]);
const isGuaranteeAction = (action) => GUARANTEE_ACTION_SET.has(action);
function handleGuaranteeAction(g, player, raw) {
  const emitCallback = (game, players, text, extra) =>
    event(game, players, text, extra);
  try {
    if (raw.action === "guarantee" || raw.action === "issueGuarantee")
      return issueGuarantee(g, player, raw.factionId ?? raw.protectedId, {
        turn: g.turn,
        atWar,
        emit: emitCallback,
      });
    if (raw.action === "withdrawGuarantee")
      return withdrawGuarantee(
        g,
        player,
        raw.factionId ?? raw.protectedId,
        { turn: g.turn, emit: emitCallback },
      );
    if (raw.action === "acceptGuarantee")
      return acceptGuaranteeCall(g, player, raw.callId ?? raw.guaranteeCallId, {
        turn: g.turn,
        atWar,
        announceWar,
        emit: emitCallback,
      });
    if (raw.action === "rejectGuarantee")
      return rejectGuaranteeCall(
        g,
        player,
        raw.callId ?? raw.guaranteeCallId,
        { turn: g.turn, emit: emitCallback },
      );
  } catch (error) {
    if (error instanceof GuaranteeError) throw new GameError(error.message);
    throw error;
  }
  return null;
}
export function transact(g, player, raw, now = Date.now()) {
  if (g.players[player]?.eliminated) throw new GameError("문명이 멸망했어요. 관전만 할 수 있어요.", 403);
  const pausedExperimentEdit = g.experiment && player === "p1" && g.paused &&
    ["experimentEdit", "experimentCosts", "spawn", "removeUnit"].includes(raw.action);
  if (pausedExperimentEdit) {
    if (g.phase !== "planning" || raw.turn !== g.turn)
      throw new GameError("현재 실험 상태를 다시 확인해 주세요.", 409);
  } else requirePlanning(g, player, raw.turn, now, ANY_TURN_TRADES.has(raw.action));
  const action = raw.action,
    amount = raw.amount ?? 1;
  if (Object.values(LOGISTICS_ACTIONS).includes(action)) {
    if (action === "queueMerchant")
      return submitOrders(g, player, { turn: g.turn, production: [{ cityId: raw.cityId, type: "merchant" }] }, now);
    try {
      handleLogisticsAction(g, player, raw, { isHostile: (game, unit, shipment) => atWar(game, unit.owner, shipment.cargoOwner ?? shipment.owner) });
    } catch (error) {
      if (error instanceof LogisticsError) throw new GameError(error.message);
      throw error;
    }
    updateContacts(g);
    g.revision++;
    return observe(g, player, now);
  }
  if (["experimentEdit", "experimentCosts"].includes(action)) {
    if (!g.experiment || player !== "p1")
      throw new GameError("실험 모드 방장만 수치를 변경할 수 있어요.", 403);
    try { editExperiment(g, raw); }
    catch (error) { throw new GameError(error.message); }
    g.revision++;
    return observe(g, player, now);
  }
  if (action === "spawn" || action === "removeUnit") {
    if (!g.experiment)
      throw new GameError("유닛 소환·제거는 실험 모드 연습에서만 가능해요.", 403);
    if (player !== "p1")
      throw new GameError("실험 모드의 소환은 방장만 할 수 있어요.", 403);
    if (action === "removeUnit") {
      const u = living(g).find((x) => x.id === raw.unitId);
      if (!u) throw new GameError("제거할 유닛을 찾을 수 없어요.");
      u.hp = 0;
      event(g, [player], `실험 · ${label(u)} ${TYPES[u.type].name}을 제거했어요.`);
    } else {
      const type = raw.type;
      if (!Object.hasOwn(TYPES, type) || TYPES[type].internal)
        throw new GameError("소환할 병종을 선택해 주세요.");
      const faction = raw.factionId ?? player;
      if (!factionIds(g).includes(faction))
        throw new GameError("소환할 세력을 확인해 주세요.");
      const t = coordinate(raw.target) && tileAt(g, raw.target);
      if (!t || t.terrain === "mountain")
        throw new GameError("산지가 아닌 실제 칸을 선택해 주세요.");
      if (living(g).some((u) => equal(u, t) && blocksUnit({ owner: faction, type }, u)))
        throw new GameError("그 칸에는 이미 다른 부대가 있어요.");
      addUnit(g, faction, type, t);
      const u = g.units.at(-1);
      const hp = Number(raw.hp);
      if (Number.isFinite(hp)) u.hp = Math.max(1, Math.min(100, Math.round(hp)));
      if (faction === player) {
        g.explored[player] ??= {};
        for (const n of [t, ...neighbors(t)]) if (tileAt(g, n)) g.explored[player][key(n)] = true;
      }
      event(g, [player], `실험 · ${label(u)}에 ${factionMap(g)[faction]?.name ?? faction} ${TYPES[type].name}을 소환했어요.`);
    }
    updateSupply(g, turnIds(g));
    updateContacts(g);
    g.revision++;
    return observe(g, player, now);
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100)
    throw new GameError("수량은 1~100 사이로 선택해 주세요.");
  if (isGuaranteeAction(action)) {
    handleGuaranteeAction(g, player, raw);
    g.revision++;
    updateContacts(g);
    return observe(g, player, now);
  }
  if (action === "pillageCamp") {
    pillageBarbarianCamp(g, player, raw, { GameError, event });
  } else if (action === "razeCity") {
    razeCity(g, player, raw.cityId);
  } else if (action === "reassignTile" || action === "assignTile") {
    reassignTile(
      g,
      player,
      raw.target ?? raw.tile,
      raw.toCityId ?? raw.cityId,
    );
  } else if (action === "buyTile") {
    const c = g.cities.find((c) => c.id === raw.cityId && c.owner === player),
      t = coordinate(raw.target) && tileAt(g, raw.target);
    if (
      !c ||
      !t ||
      !g.explored[player]?.[key(t)] ||
      t.owner ||
      t.terrain === "mountain" ||
      distance(t, c) > TERRITORY_MAX_RADIUS ||
      !neighbors(t).some(
        (p) => tileAt(g, p)?.cityId === c.id && tileAt(g, p)?.owner === player,
      )
    )
      throw new GameError(
        `도시 영토와 이어진 ${TERRITORY_MAX_RADIUS}칸 이내의 미소유 땅만 구매할 수 있어요.`,
      );
    const cost = landPrice(t, c);
    if (g.gold[player] < cost) throw new GameError("골드가 부족해요.");
    g.gold[player] -= cost;
    t.owner = player;
    t.cityId = c.id;
    event(g, [player], `${label(t)} 영토를 ${cost}골드에 구매했어요.`);
  } else if (action === "mobilizeUnit" || action === "queueMobilization") {
    const city = g.cities.find(
      (candidate) => candidate.id === raw.cityId && candidate.owner === player,
    );
    enqueueMobilization(g, player, city, raw.type);
  } else if (action === "cancelMobilization") {
    const city = g.cities.find(
      (candidate) => candidate.id === raw.cityId && candidate.owner === player,
    );
    cancelMobilization(
      g,
      player,
      city,
      raw.mobilizationId ?? raw.queueId ?? raw.entryId,
    );
  } else if (action === "buyUnit") {
    if (isSupplyOn(g) && military({ type: raw.type }))
      throw new GameError(
        "상세 보급 ON에서는 전투 병종을 즉시 구매할 수 없고 도시별 동원 대기를 사용해요.",
      );
    const type = raw.type,
      city = g.cities.find(
        (candidate) => candidate.id === raw.cityId && candidate.owner === player,
      ),
      definition = city && !city.camp && Object.hasOwn(TYPES, type)
        && !TYPES[type].internal ? productionType(type, city)
        : null,
      price = definition ? unitPurchasePrice(type, city) : Infinity,
      resources = definition?.resources ?? {};
    if (!city || !definition || !Number.isFinite(price))
      throw new GameError("즉시 구매할 아군 도시와 유닛을 확인해 주세요.");
    if (type === "merchant" && (!merchantSummary(g, city).built || merchantSummary(g, city).active > 0 || city.queue === "merchant"))
      throw new GameError("도시 교역소당 상인은 생산 대기를 포함해 한 명만 유지할 수 있어요.");
    if (
      city.population - MIN_CITY_POPULATION < UNIT_MANPOWER_COST
    )
      throw new GameError(
        `인구 ${UNIT_MANPOWER_COST}명이 필요해요. 도시는 최소 ${MIN_CITY_POPULATION}명을 남겨야 해요.`,
      );
    if (!legalCitySpawn(g, city, player, type))
      throw new GameError("도시의 해당 병종 슬롯이 비어 있지 않아요.");
    const eco = economy(g, player);
    // Reserving 0.5 population lowers capacity by one (capacity is 2 per
    // population), so check the post-purchase capacity before mutating gold
    // or stockpiles.
    const capacityAfterManpower =
      eco.capacity - UNIT_MANPOWER_COST * 2;
    if (eco.armyCapacityEnabled && eco.used + 1 > capacityAfterManpower)
      throw new GameError("병력 수용량이 부족해요. 인구를 늘리거나 병력을 해산해 주세요.");
    if (g.gold[player] < price)
      throw new GameError(`골드가 부족해요. 즉시 구매 가격은 ${price}G예요.`);
    for (const [resource, amountNeeded] of Object.entries(resources))
      if ((g.stockpiles[player][resource] ?? 0) < amountNeeded)
        throw new GameError(
          `${RESOURCES[resource].name}이 부족해요. 자원 시설을 개발해 주세요.`,
        );
    if (!reserveManpower(city, UNIT_MANPOWER_COST))
      throw new GameError(
        `인구 ${UNIT_MANPOWER_COST}명이 필요해요. 도시는 최소 ${MIN_CITY_POPULATION}명을 남겨야 해요.`,
      );
    g.gold[player] -= price;
    for (const [resource, amountNeeded] of Object.entries(resources))
      g.stockpiles[player][resource] -= amountNeeded;
    const unit = addUnit(g, player, type, { q: city.q, r: city.r });
    Object.assign(unit, unitManpower(g, city, player));
    if (type === "merchant") unit.tradingPostCityId = city.id;
    event(
      g,
      [player],
      `${city.name}에서 ${TYPES[type].name}을 즉시 구매했어요 · ${price}G · 인구 ${UNIT_MANPOWER_COST}명 배정.`,
    );
  } else if (action === "buy" || action === "sell") {
    const rate = MARKET[raw.resource];
    if (!rate) throw new GameError("거래할 식량 또는 자원을 선택해 주세요.");
    const city =
      raw.resource === "food"
        ? g.cities.find((c) => c.id === raw.cityId && c.owner === player && !c.camp)
        : null;
    if (raw.resource === "food" && !city)
      throw new GameError("식량을 거래할 아군 도시를 선택해 주세요.");
    if (
      raw.resource === "food" &&
      !isSupplyOn(g)
    )
      throw new GameError(
        "식량 거래는 상세 보급 ON에서 가능해요. OFF에서는 도시별 잉여 식량으로만 성장해요.",
      );
    const stock = city ? city.food : g.stockpiles[player][raw.resource],
      price = amount * rate[action];
    if (action === "buy" && g.gold[player] < price)
      throw new GameError("골드가 부족해요.");
    if (
      action === "buy" &&
      !city &&
      stock + amount > economy(g, player).resourceCapacity
    )
      throw new GameError(
        "자원 비축 한도를 넘어요. 총인구 1명당 자원별 5까지 보관할 수 있어요.",
      );
    if (
      action === "buy" &&
      city &&
      isSupplyOn(g) &&
      stock + amount > cityFoodCapacity(city, economy(g, player).perCity.find((c) => c.id === city.id)?.militaryFood ?? 0)
    )
      throw new GameError("도시 식량 비축 한도를 넘어요.");
    if (action === "sell" && stock < amount)
      throw new GameError("판매할 비축량이 부족해요.");
    g.gold[player] += action === "sell" ? price : -price;
    if (city) city.food += action === "buy" ? amount : -amount;
    else
      g.stockpiles[player][raw.resource] += action === "buy" ? amount : -amount;
    event(
      g,
      [player],
      `${raw.resource === "food" ? "식량" : RESOURCES[raw.resource].name} ${amount} ${action === "buy" ? "구매" : "판매"} · ${price}골드${raw.resource === "food" && isExpansion(g) && !isSupplyOn(g) ? " · 보급 OFF 성장 진척에 반영(비축 아님)" : ""}`,
    );
  } else if (action === "disbandUnit") {
    const u = living(g).find((u) => u.id === raw.unitId && u.owner === player);
    if (!u) throw new GameError("해산할 아군 유닛을 선택해 주세요.");
    if (TYPES[u.type]?.internal)
      throw new GameError("자동 수송대는 해산할 수 없어요. 운송이 끝나면 복귀해요.");
    const demobilized = isSupplyOn(g) && military(u) && u.mobilized;
    const requestedRetained =
      raw.retainVeteranCount ??
      raw.retainVeterans ??
      (raw.retainVeteran === true ? 1 : 0);
    const retained =
      requestedRetained === true ? 1 : Number(requestedRetained) || 0;
    if (!Number.isInteger(retained) || retained < 0)
      throw new GameError("유지할 숙련병 수를 확인해 주세요.");
    if (retained > 0) {
      if (!demobilized || retained >= u.size)
        throw new GameError("동원 해제할 합병 부대의 일부 숙련병만 유지할 수 있어요.");
      const originalSize = u.size,
        originalHp = u.hp,
        originalSources = manpowerSources(u),
        released = {
          ...u,
          size: originalSize - retained,
          manpowerSources: originalSources.map((source) => ({
            ...source,
            amount: source.amount * ((originalSize - retained) / originalSize),
          })),
          manpowerReturned: false,
        },
        returned = returnUnitManpower(g, released);
      u.size = retained;
      u.hp = Math.max(1, Math.min(maxHealth(u), Math.round(originalHp * (retained / originalSize))));
      u.manpowerSources = originalSources.map((source) => ({
        ...source,
        amount: source.amount * (retained / originalSize),
      }));
      u.manpowerCost = u.manpowerSources.reduce((sum, source) => sum + source.amount, 0);
      u.manpowerReturned = false;
      const retainedFraction = retained / originalSize;
      const releasedFood = Math.max(0, Number(u.foodStock) || 0) * (1 - retainedFraction);
      demobilizeUnitLogistics(g, { ...u, id: `released-${u.id}`, foodStock: releasedFood, cargo: [] });
      u.foodStock = Math.max(0, (Number(u.foodStock) || 0) - releasedFood);
      u.foodCapacity = Math.max(u.foodStock, (Number(u.foodCapacity) || 0) * retainedFraction);
      u.targetReserve = Math.min(u.foodCapacity, (Number(u.targetReserve) || 0) * retainedFraction);
      u.upkeepPaidAmount = Math.min(ammunitionCost(u), ammunitionPreview(g, u).paidAmount);
      // The retained slice is explicitly the veteran choice; its XP/level
      // remains, while the released slice's manpower is the only refund.
      event(
        g,
        [player],
        `${TYPES[u.type].name} ${originalSize}개 중 숙련병 ${retained}개를 유지하고 ${originalSize - retained}개를 동원 해제했어요 · 인구 ${returned}명 반환.`,
      );
      beginEffects(g);
      g.revision++;
      updateContacts(g);
      return observe(g, player, now);
    }
    const returned = returnUnitManpower(g, u);
    demobilizeUnitLogistics(g, u);
    if (demobilized) {
      // Demobilization intentionally returns surviving manpower only.  XP is
      // not a population asset and is reset before the record leaves the
      // world, so a later remobilization cannot inherit veteran level for
      // free.
      u.xp = 0;
      u.level = 0;
    }
    g.units = g.units.filter((x) => x.id !== u.id);
    event(
      g,
      [player],
      `${TYPES[u.type].name} 부대를 ${demobilized ? "동원 해제" : "해산"}했어요${returned ? ` · 인구 ${returned}명 반환` : ""}${demobilized ? " · 숙련도는 초기화돼요" : ""}.`,
    );
    beginEffects(g);
  } else if (action === "sellUnit") {
    const u = living(g).find((u) => u.id === raw.unitId && u.owner === player);
    if (!u) throw new GameError("판매할 아군 유닛을 선택해 주세요.");
    if (TYPES[u.type]?.internal)
      throw new GameError("자동 생성된 수송대는 판매할 수 없어요.");
    const price = Math.max(
      1,
      Math.floor((TYPES[u.type].cost * u.size * 0.8 * u.hp) / maxHealth(u)),
    );
    g.gold[player] += price;
    demobilizeUnitLogistics(g, u, { reason: "unit-sold" });
    g.units = g.units.filter((x) => x.id !== u.id);
    event(
      g,
      [player],
      `${TYPES[u.type].name} 부대를 ${price}골드에 판매했어요.`,
    );
    beginEffects(g);
  } else if (action === "peace") {
    const target = raw.factionId,
      gold = raw.gold ?? 0;
    if (
      !Object.hasOwn(factionMap(g), target) ||
      target === player ||
      target === "barb" ||
      !atWar(g, player, target)
    )
      throw new GameError("협상 가능한 교전 세력을 선택해 주세요.");
    const peaceBlocked = peaceIssue(g, player, target);
    if (peaceBlocked) throw new GameError(peaceBlocked);
    if (!Number.isInteger(gold) || gold < 0 || gold > g.gold[player])
      throw new GameError("지불 가능한 골드 금액을 입력해 주세요.");
    if (g.proposals.some((p) => pair(p.from, p.to) === pair(player, target)))
      throw new GameError("진행 중인 평화 제안이 있어요.");
    if (!directSeatIds(g.players).includes(target)) {
      // Peace has no minimum price; only the ten-turn war-duration gate
      // (peaceIssue above) restricts it.
      g.gold[player] -= gold;
      g.gold[target] += gold;
      endWar(g, player, target);
      const proposal = {
        id: randomUUID(),
        kind: "peace",
        from: player,
        to: target,
        gold,
        expires: g.turn + 3,
      };
      notifyTrade(g, proposal, "accepted");
      event(
        g,
        [player],
        `${factionMap(g)[target].name}과 5턴 평화 협정을 맺었어요.`,
      );
    } else {
      g.gold[player] -= gold;
      const proposal = {
        id: randomUUID(),
        kind: "peace",
        from: player,
        to: target,
        gold,
        expires: g.turn + 3,
      };
      g.proposals.push(proposal);
      notifyTrade(g, proposal, "requested");
      event(
        g,
        [player, target],
        "평화 협정 제안이 도착했어요. 외교에서 확인해 주세요.",
      );
    }
  } else if (["acceptPeace", "rejectPeace", "cancelPeace"].includes(action)) {
    const p = g.proposals.find((p) => p.id === raw.proposalId);
    if (
      !p ||
      (p.kind && p.kind !== "peace") ||
      (action === "cancelPeace" ? p.from !== player : p.to !== player)
    )
      throw new GameError("응답 가능한 제안을 확인해 주세요.");
    if (action === "acceptPeace") {
      const peaceBlocked = peaceIssue(g, p.from, p.to);
      if (peaceBlocked) throw new GameError(peaceBlocked);
      if (
        !Number.isInteger(p.gold) ||
        p.gold < 0 ||
        !Object.hasOwn(g.gold, p.to) ||
        !atWar(g, p.from, p.to)
      )
        throw new GameError("수락할 평화 제안이 더 이상 유효하지 않아요.");
      g.gold[p.to] += p.gold;
      endWar(g, p.from, p.to);
      notifyTrade(g, p, "accepted");
      event(g, [p.from, p.to], "5턴 평화 협정이 체결됐어요.");
    } else {
      g.gold[p.from] += p.gold;
      notifyTrade(g, p, action === "cancelPeace" ? "cancelled" : "rejected");
    }
    g.proposals = g.proposals.filter((x) => x.id !== p.id);
  } else if (action === "declareWar") {
    const target = raw.factionId;
    if (
      !Object.hasOwn(factionMap(g), target) ||
      target === player ||
      target === "barb"
    )
      throw new GameError("외교 대상을 확인해 주세요.");
    const k = pair(player, target);
    if ((g.alliances[k] ?? 0) > g.turn)
      throw new GameError("먼저 동맹을 파기해야 선전포고할 수 있어요.");
    if ((g.peaceUntil[k] ?? 0) >= g.turn)
      throw new GameError("평화 협정 기간에는 공격할 수 없어요.");
    if (atWar(g, player, target)) throw new GameError("이미 전쟁 중이에요.");
    if (!g.wars.includes(k)) g.wars.push(k);
    announceWar(g, player, target);
  } else if (!diplomaticAction(g, player, raw))
    throw new GameError("지원하지 않는 거래예요.");
  checkVictory(g);
  g.revision++;
  updateContacts(g);
  return observe(g, player, now);
}
export function previewDeal(g, player, raw, now = Date.now()) {
  if (!g.players[player]) throw new GameError("플레이어 권한이 필요해요.", 403);
  try {
    return handleDeal(
      g,
      player,
      { ...raw, action: "offerDeal", observation: observe(g, player, now) },
      {
        GameError,
        event,
        atWar,
        relation,
        announceWar,
        npcWarRisk,
        preview: true,
      },
    );
  } catch (error) {
    if (!(error instanceof GameError)) throw error;
    return {
      status: "unavailable",
      message: error.message,
      additionalGold: null,
      wouldAccept: false,
      never: true,
      demands: null,
      reason: error.message,
    };
  }
}
function announceWar(g, from, to, { triggerGuarantees = true, reason = null, expandAlliances = true } = {}) {
  const consequence = applyWarDiplomacy(g, from, to, { reason, expandAlliances });
  reason = consequence.reason;
  if (g.openBorders) {
    delete g.openBorders[`${from}>${to}`];
    delete g.openBorders[`${to}>${from}`];
  }
  const text =
    reason === "guarantee"
      ? `${factionMap(g)[from].name}이 독립보장 의무로 ${factionMap(g)[to].name}과의 전쟁에 참전했습니다.`
      : reason === "alliance"
        ? `${factionMap(g)[from].name}이 동맹 의무로 ${factionMap(g)[to].name}과의 전쟁에 참전했습니다.`
        : `${factionMap(g)[from].name}이 ${factionMap(g)[to].name}에 ${consequence.justified ? "명분 있는" : "기습"} 전쟁을 선포했습니다.`;
  g.announcements = [
    ...(g.announcements ?? []),
    { id: randomUUID(), type: "war", from, to, text, turn: g.turn, ...(reason ? { reason } : {}) },
  ].slice(-8);
  event(g, factionIds(g), text, { type: "war", from, to, ...(reason ? { reason } : {}) });
  for (const edge of consequence.brokenAlliances)
    event(g, factionIds(g), `교차 동맹 ${edge}이 전쟁 참전 의무 충돌로 해제됐어요.`);
  for (const joined of consequence.newWars)
    announceWar(g, joined.from, joined.to, { reason: "alliance", expandAlliances: false });
  if (triggerGuarantees)
    onWarDeclared(g, from, to, {
      turn: g.turn,
      atWar,
      emit: (game, players, message, extra) => event(game, players, message, extra),
    });
}
function enforceAllianceWars(g) {
  const result = syncAllianceWars(g);
  for (const edge of result.brokenAlliances)
    event(g, factionIds(g), `교차 동맹 ${edge}이 전쟁 참전 의무 충돌로 해제됐어요.`);
  for (const war of result.newWars)
    announceWar(g, war.from, war.to, { reason: "alliance", expandAlliances: false });
}
function refundProposal(g, p) {
  if (p.kind === "deal") {
    refundDeal(g, p);
    return;
  }
  if (p.kind === "trade") g.stockpiles[p.from][p.resource] += p.amount;
  else if (!p.kind || p.kind === "peace") g.gold[p.from] += p.gold;
}
function diplomaticAction(g, player, raw) {
  if (
    handleDeal(
      g,
      player,
      { ...raw, observation: observe(g, player) },
      { GameError, event, atWar, relation, announceWar, npcWarRisk, razeCity },
    )
  ) {
    checkVictory(g);
    return true;
  }
  const action = raw.action;
  if (["acceptProposal", "rejectProposal", "cancelProposal"].includes(action)) {
    const p = g.proposals.find((p) => p.id === raw.proposalId);
    if (
      !p ||
      (action === "cancelProposal" ? p.from !== player : p.to !== player)
    )
      throw new GameError("응답할 수 있는 제안이 아니에요.");
    if (action === "acceptProposal") {
      if (p.kind === "trade") {
        if (
          !RESOURCES[p.resource] ||
          !Number.isInteger(p.amount) ||
          p.amount < 1 ||
          !Number.isInteger(p.gold) ||
          p.gold < 0 ||
          atWar(g, p.from, p.to) ||
          g.gold[player] < p.gold
        )
          throw new GameError("거래 대금을 지불할 수 없거나 교전 중이에요.");
        g.gold[player] -= p.gold;
        g.gold[p.from] += p.gold;
        g.stockpiles[player][p.resource] += p.amount;
        g.relations[pair(p.from, p.to)] =
          (g.relations[pair(p.from, p.to)] ?? 0) + 10;
      } else if (p.kind === "alliance") {
        if (atWar(g, p.from, p.to) || (g.denouncements?.[pair(p.from,p.to)] ?? 0) > g.turn)
          throw new GameError("전쟁·공개비난 중에는 동맹을 맺을 수 없어요.");
        g.alliances[pair(p.from, p.to)] = g.turn + 10;
        g.relations[pair(p.from, p.to)] = 30;
        enforceAllianceWars(g);
      } else if (p.kind === "peace" || !p.kind) {
        const peaceBlocked = peaceIssue(g,p.from,p.to);
        if (peaceBlocked) throw new GameError(peaceBlocked);
        if (
          !Number.isInteger(p.gold) ||
          p.gold < 0 ||
          !Object.hasOwn(g.gold, p.to) ||
          !atWar(g, p.from, p.to)
        )
          throw new GameError("수락할 평화 제안이 더 이상 유효하지 않아요.");
        g.gold[p.to] += p.gold;
        endWar(g, p.from, p.to);
      } else throw new GameError("응답할 수 없는 제안 종류예요.");
      event(g, [p.from, p.to], "외교 제안이 수락됐어요.");
      notifyTrade(g, p, "accepted");
    } else {
      refundProposal(g, p);
      notifyTrade(g, p, action === "cancelProposal" ? "cancelled" : "rejected");
    }
    g.proposals = g.proposals.filter((x) => x.id !== p.id);
    return true;
  }
  if (
    !["denounce", "alliance", "breakAlliance", "gift", "offerTrade"].includes(
      action,
    )
  )
    return false;
  const target = raw.factionId,
    k = pair(player, target);
  if (!factionMap(g)[target] || target === player || target === "barb")
    throw new GameError("외교 가능한 상대 문명을 선택해 주세요.");
  const human = directSeatIds(g.players).includes(target);
  if (action === "denounce") {
    if (relation(g, player, target) === "alliance")
      throw new GameError("동맹 파기 후 공개비난할 수 있어요.");
    recordDenouncement(g, player, target);
    g.relations[k] = -30;
    event(
      g,
      factionIds(g),
      `${factionMap(g)[player].name}이 ${factionMap(g)[target].name}을 공개비난했어요. (10턴)`,
    );
    return true;
  }
  if (action === "breakAlliance") {
    if (relation(g, player, target) !== "alliance")
      throw new GameError("현재 동맹이 아니에요.");
    delete g.alliances[k];
    g.relations[k] = -30;
    event(g, [player, target], "동맹이 파기됐어요. 관계가 악화됐어요.");
    return true;
  }
  if (atWar(g, player, target))
    throw new GameError("먼저 평화 협정을 맺어 주세요.");
  if (action === "gift") {
    const gold = raw.gold ?? 20;
    if (!Number.isInteger(gold) || gold < 1 || gold > g.gold[player])
      throw new GameError("지불 가능한 골드를 입력해 주세요.");
    const proposal = {
      id: randomUUID(),
      kind: "gift",
      from: player,
      to: target,
      gold,
    };
    g.gold[player] -= gold;
    g.gold[target] += gold;
    g.relations[k] = Math.min(60, (g.relations[k] ?? 0) + Math.min(20, gold));
    notifyTrade(g, proposal, "accepted");
    event(
      g,
      [player, target],
      `${factionMap(g)[player].name}이 우호 선물 ${gold}골드를 보냈어요.`,
    );
    return true;
  }
  if (g.proposals.some((p) => pair(p.from, p.to) === k))
    throw new GameError("진행 중인 제안에 먼저 응답해 주세요.");
  if (action === "alliance") {
    if (relation(g, player, target) === "denounced")
      throw new GameError("현재 관계에서는 동맹을 요청할 수 없어요.");
    if (human) {
      const proposal = {
        id: randomUUID(),
        kind: "alliance",
        from: player,
        to: target,
        expires: g.turn + 3,
        gold: 0,
      };
      g.proposals.push(proposal);
      notifyTrade(g, proposal, "requested");
    } else if ((g.relations[k] ?? 0) >= 20) {
      const proposal = {
        id: randomUUID(),
        kind: "alliance",
        from: player,
        to: target,
        gold: 0,
      };
      g.alliances[k] = g.turn + 10;
      enforceAllianceWars(g);
      notifyTrade(g, proposal, "accepted");
      event(
        g,
        [player],
      `${factionMap(g)[target].name}과 10턴 동맹을 맺었어요. 시야는 공유하지 않아요.`,
      );
    } else {
      const proposal = {
        id: randomUUID(),
        kind: "alliance",
        from: player,
        to: target,
        gold: 0,
      };
      notifyTrade(g, proposal, "rejected");
      event(
        g,
        [player],
      `${factionMap(g)[target].name}이 동맹을 거절했어요. 좋음 관계에서 수락해요.`,
      );
    }
    return true;
  }
  const resource = raw.resource,
    amount = raw.amount ?? 1,
    gold = raw.gold ?? MARKET[resource]?.sell * amount;
  if (
    !RESOURCES[resource] ||
    !Number.isInteger(gold) ||
    gold < 0 ||
    gold > 10000 ||
    g.stockpiles[player][resource] < amount
  )
    throw new GameError("판매할 자원 수량과 대금을 확인해 주세요.");
  const proposal = {
    id: randomUUID(),
    kind: "trade",
    from: player,
    to: target,
    resource,
    amount,
    gold,
    expires: g.turn + 3,
  };
  if (human) {
    g.stockpiles[player][resource] -= amount;
    g.proposals.push(proposal);
    notifyTrade(g, proposal, "requested");
    event(
      g,
      [player, target],
      "자원 거래 제안이 도착했어요. 수락 전까지 판매 자원은 보관돼요.",
    );
  } else if (
    gold <= MARKET[resource].buy * amount &&
    g.gold[target] >= gold &&
    relation(g, player, target) !== "denounced"
  ) {
    g.stockpiles[player][resource] -= amount;
    g.stockpiles[target][resource] += amount;
    g.gold[target] -= gold;
    g.gold[player] += gold;
    g.relations[k] = (g.relations[k] ?? 0) + 10;
    notifyTrade(g, proposal, "accepted");
    event(
      g,
      [player],
      `${factionMap(g)[target].name}과 자원 거래를 마쳤어요. 관계 +10`,
    );
  } else {
    notifyTrade(g, proposal, "rejected");
    event(g, [player], `${factionMap(g)[target].name}이 거래 조건을 거절했어요.`);
  }
  return true;
}
export function advanceDue(g, now = Date.now()) {
  if (!g.internalNpc && !g.paused && g.phase === "planning" && simultaneous(g) &&
      g.deadline && now < g.deadline && now >= (g.npcNextActionAt ?? g.turnStartedAt + 1000)) {
    g.npcNextActionAt = now + 1000;
    beginEffects(g);
    playNpcs(g, now, null, { realtime: true });
    updateContacts(g);
    checkVictory(g);
    g.revision++;
  }
  if (
    !g.paused &&
    g.phase === "planning" &&
    ((!simultaneous(g) && g.players[g.activePlayer]?.eliminated && directIds(g).length > 0) ||
      (g.deadline && now >= g.deadline) ||
      (g.practicePassAt && now >= g.practicePassAt))
  )
    resolveTurn(g, now);
}
