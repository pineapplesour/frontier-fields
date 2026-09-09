// Additive adapters for optional economy/logistics observations. Missing
// fields return `available: false`; callers keep the existing UI instead of
// inventing private stock, routes, or city ownership.

import { distance, equal, productionType } from "../shared/rules.js";

const first = (value, names) => {
  for (const name of names) {
    if (value && Object.prototype.hasOwnProperty.call(value, name))
      return value[name];
  }
  return undefined;
};

const asNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const logisticsStateObject = (game) =>
  game?.logistics && typeof game.logistics === "object" ? game.logistics : null;

const capabilityObject = (game) =>
  game?.capabilities?.detailedLogistics ??
  game?.capabilities?.logistics ??
  game?.capabilities?.supplyLogistics ??
  logisticsStateObject(game)?.capabilities ??
  null;

function capabilityActions(game, capability) {
  return {
    ...(logisticsStateObject(game)?.actions ?? {}),
    ...(game?.capabilities?.logisticsActions ?? {}),
    ...(capability && typeof capability === "object"
      ? capability.actions ?? {}
      : {}),
  };
}

export function logisticsCapability(game) {
  const logistics = logisticsStateObject(game);
  const capability = capabilityObject(game);
  const supplyMode =
    game?.supplyMode ?? game?.supplySettings?.mode ?? game?.economy?.supplyMode;
  const explicitlyDisabled =
    capability === false ||
    (capability && typeof capability === "object" && capability.enabled === false);
  const supported =
    !explicitlyDisabled &&
    (capability === true ||
      (capability && typeof capability === "object" && capability.enabled !== false) ||
      game?.logistics?.supported === true ||
      game?.logistics?.capabilities?.detailed === true ||
      game?.rulesVersion === "expansion-v1" ||
      supplyMode === "on" ||
      supplyMode === "off" ||
      game?.supplySettings != null ||
      game?.foodStorageEnabled !== undefined ||
      game?.economy?.foodStorageEnabled !== undefined);
  const actions = capabilityActions(game, capability);
  return {
    supported: !!supported,
    actions,
    merchant: !!(
      game?.capabilities?.merchant ||
      game?.capabilities?.tradingPost ||
      game?.capabilities?.tradingpost ||
      game?.merchantRules ||
      Array.isArray(logistics?.tradingPosts) ||
      Array.isArray(logistics?.merchants)
    ),
    encampment: !!(
      game?.capabilities?.encampment ||
      game?.capabilities?.offCenterStructures ||
      game?.structureCapabilities?.encampment ||
      logistics?.encampment === true ||
      logistics?.capabilities?.encampment === true
    ),
    facilityActions:
      game?.capabilities?.facilityActions ?? logistics?.facilityActions ?? {},
  };
}

export function detailedLogisticsState(game) {
  const settings = game?.settings ?? game?.options ?? {};
  const supplyMode =
    game?.supplyMode ?? game?.supplySettings?.mode ?? game?.economy?.supplyMode;
  const logisticsModeEnabled =
    game?.logisticsMode === "detailed" ? true : undefined;
  const explicitSetting =
    settings.detailedLogistics ??
    settings.detailedSupply ??
    game?.detailedLogistics ??
    game?.logistics?.detailed ??
    game?.logistics?.enabled ??
    logisticsModeEnabled ??
    (supplyMode === "on");
  const supported = logisticsCapability(game).supported;
  const enabled = supported && explicitSetting === true;
  const canToggle =
    supported &&
    game?.playerId === "p1" &&
    game?.paused === true &&
    game?.phase === "planning";
  return {
    supported,
    enabled,
    canToggle,
    requested: explicitSetting === true,
  };
}

function explicitStock(entity) {
  return first(entity, [
    "foodStock",
    "foodStored",
    "foodReserve",
    "storedFood",
    "stockedFood",
    "reserveFood",
    "foodStorage",
    "foodStore",
  ]);
}

export function cityFoodSummary(city, game = null) {
  if (!city) return { available: false };
  const observedCity = Array.isArray(game?.logistics?.cities)
    ? game.logistics.cities.find((entry) => entry?.id === city.id)
    : null;
  // The public logistics ledger is allowed to carry the authoritative stock
  // while the city projection carries production and growth fields.
  const stock = explicitStock(city) ?? explicitStock(observedCity);
  const growth = first(city, [
    "growthFood",
    "foodProgress",
    "growthProgress",
    "populationProgress",
    "growthStock",
    "food",
  ]);
  const production = first(city, [
    "foodProduction",
    "foodProductionRate",
    "foodIncome",
    "foodPerTurn",
    "foodGross",
  ]);
  const consumption = first(city, [
    "foodConsumption",
    "foodConsumptionRate",
    "foodConsumed",
    "foodUse",
    "populationFoodCost",
  ]);
  const target = first(city, ["growthTarget", "populationGrowthTarget"]);
  const netValue = first(city, ["foodNet", "foodBalance", "netFood"]);
  const growthProgressUnit = first(city, ["growthProgressUnit"]);
  const foodGross = first(city, ["foodGross"]);
  const inferredConsumption =
    consumption === undefined &&
    (foodGross !== undefined || netValue !== undefined) &&
    typeof city.population === "number"
      ? city.population
      : undefined;
  const effectiveConsumption = consumption ?? inferredConsumption;
  const explicit =
    stock !== undefined ||
    growth !== undefined ||
    production !== undefined ||
    effectiveConsumption !== undefined ||
    netValue !== undefined ||
    city.foodShortage === true ||
    city.starvationEta != null ||
    city.growthEta != null;
  if (!explicit) return { available: false };
  const detailed = detailedLogisticsState(game).enabled;
  // A snapshot can retain a serialized `foodStock` while the host has
  // switched supply OFF.  OFF suspends that ledger; never let stale stock
  // affect the displayed hunger/ETA or leak it into the OFF UI.
  const stockAvailable = detailed && asNumber(stock) != null;
  const stored = asNumber(stock) ?? 0;
  // Legacy observations call the growth meter `food`; it is never used as
  // stored stock.  Detailed observations may expose a separate stock field.
  const progress = asNumber(growth) ?? 0;
  const foodProduction = asNumber(production);
  const foodConsumption = asNumber(effectiveConsumption);
  const net =
    asNumber(netValue) ??
    (foodProduction != null && foodConsumption != null
      ? foodProduction - foodConsumption
      : null);
  const growthTarget = asNumber(target);
  const starvationTurns = stockAvailable
    ? asNumber(city.starvationEta ?? city.shortageEta) ??
      (net != null
        ? net < 0 && foodConsumption != null && foodConsumption > 0
          ? Math.ceil(stored / -net)
          : null
        : foodConsumption != null && foodConsumption > 0
          ? Math.floor(stored / foodConsumption)
          : null)
    : null;
  const growthTurns =
    asNumber(city.growthEta ?? city.populationEta) ??
    (growthTarget != null
      ? growthProgressUnit === "fed-turns"
        ? Math.max(0, Math.ceil(growthTarget - progress))
        : net != null && net > 0
          ? Math.ceil(Math.max(0, growthTarget - progress) / net)
          : null
      : null);
  const fed =
    typeof city.fed === "boolean"
      ? city.fed
      : stockAvailable && foodProduction != null && foodConsumption != null
        ? stored + foodProduction >= foodConsumption
        : net == null || net >= 0;
  return {
    available: true,
    detailed,
    stockAvailable,
    stored,
    progress,
    growthProgressUnit: growthProgressUnit ?? null,
    target: growthTarget,
    production: foodProduction,
    consumption: foodConsumption,
    net,
    capacity: asNumber(
      city.foodCapacity ??
        city.storageCapacity ??
        observedCity?.foodCapacity ??
        observedCity?.storageCapacity,
    ),
    fed,
    civilianFood: asNumber(city.civilianFood),
    militaryFood: asNumber(city.militaryFood),
    starvationTurns,
    growthTurns,
    shortage:
      city.foodShortage === true ||
      fed === false ||
      (stockAvailable ? starvationTurns === 0 : net != null && net < 0),
    growthPaused:
      city.growthPaused === true ||
      city.starvationPaused === true ||
      (detailed && fed === false),
  };
}

export function unitFoodSummary(unit, game = null) {
  if (!unit) return { available: false };
  const detailed = detailedLogisticsState(game).enabled;
  const observedUnit = Array.isArray(game?.logistics?.units)
    ? game.logistics.units.find((entry) => entry?.id === unit.id)
    : null;
  const reserve =
    explicitStock(unit) ??
    explicitStock(observedUnit) ??
    (detailed && Object.prototype.hasOwnProperty.call(unit, "food")
      ? unit.food
      : undefined);
  const consumption = first(unit, [
    "foodConsumption",
    "foodConsumed",
    "foodPerTurn",
    "foodUse",
  ]);
  const penalty = first(unit, [
    "foodPenalty",
    "supplyPenalty",
    "hungerPenalty",
    "attackPenalty",
  ]);
  const explicit =
    reserve !== undefined ||
    consumption !== undefined ||
    penalty !== undefined ||
    unit.starvationTurns != null ||
    unit.hungerTurns != null;
  if (!explicit) return { available: false };
  const stock = asNumber(reserve) ?? 0;
  const use = asNumber(consumption);
  const starvationTurns =
    asNumber(unit.starvationTurns ?? unit.hungerTurns) ??
    (use != null && use > 0 ? Math.floor(stock / use) : null);
  return {
    available: true,
    detailed,
    stock,
    consumption: use,
    starvationTurns,
    penalty: asNumber(penalty),
    shortage: unit.foodShortage === true || starvationTurns === 0,
    cargo: first(unit, ["cargo", "cargoHold", "heldCargo"]) ?? null,
  };
}

function facilityKind(tile) {
  return first(tile, [
    "facility",
    "improvement",
    "facilityType",
    "improvementType",
  ]);
}

export function facilitySummary(tile, game = null) {
  if (!tile) return { available: false };
  const ruin = tile.ruin && typeof tile.ruin === "object" ? tile.ruin : null;
  const status = String(
    first(tile, ["facilityStatus", "improvementStatus", "ruinStatus"]) ?? "",
  ).toLowerCase();
  const kind =
    facilityKind(tile) ??
    (ruin?.kind ??
      (logisticsCapability(game).facilityActions?.farm != null ||
      game?.rulesVersion === "expansion-v1"
        ? tile.farm
          ? "farm"
          : tile.developed && tile.resource
            ? "resource"
            : null
        : null));
  const plundered =
    tile.plundered === true ||
    tile.lootTaken === true ||
    status.includes("plunder") ||
    status.includes("sack") ||
    ruin?.mode === "pillage";
  const scorched =
    tile.scorched === true ||
    tile.scorch === true ||
    status.includes("scorch") ||
    ruin?.mode === "scorch";
  const ruined =
    !!ruin ||
    tile.ruin === true ||
    tile.ruins === true ||
    tile.repairRequired === true ||
    status.includes("ruin") ||
    status.includes("repair");
  const explicit =
    kind != null ||
    plundered ||
    scorched ||
    ruined ||
    tile.repairAction != null ||
    (tile.farm === true &&
      logisticsCapability(game).facilityActions?.farm != null);
  if (!explicit) return { available: false };
  const actions = logisticsCapability(game).facilityActions ?? {};
  const farmAction = actions.farm ?? actions.scorch ?? {};
  return {
    available: true,
    kind: kind ?? (tile.farm ? "farm" : null),
    plundered,
    scorched,
    ruined,
    repairRequired: ruined || tile.repairRequired === true,
    heal:
      asNumber(tile.facilityHeal ?? tile.farmHeal) ??
      (farmAction.heal === 50 ||
      (game?.rulesVersion === "expansion-v1" && kind === "farm")
        ? 50
        : null),
    repairAction:
      actions.repair ??
      tile.repairAction ??
      (game?.rulesVersion === "expansion-v1" && ruin ? "repair" : null),
    foodYield: asNumber(tile.foodYield ?? tile.foodProduction),
    resourceYield: asNumber(tile.resourceYield ?? tile.resourceProduction),
  };
}

export function territorySummary(tile, game = null) {
  if (!tile) return { available: false };
  const cityId = tile.cityId ?? tile.assignedCityId ?? tile.territoryCityId;
  const owner = tile.owner ?? tile.territoryOwner ?? null;
  const suppliedOptions = first(tile, [
    "reassignmentOptions",
    "assignmentOptions",
    "eligibleCities",
  ]);
  const action =
    logisticsCapability(game).actions.reassignTerritory ??
    logisticsCapability(game).actions.assignTerritory ??
    (game?.rulesVersion === "expansion-v1" ? "reassignTile" : null);
  // Expansion-v1 exposes the authoritative cityId on every owned tile and
  // accepts reassignTile. It does not yet send an option list, so derive only
  // radius-three same-owner candidates from public city coordinates. The
  // server still checks both footprint graphs; this is a candidate picker,
  // never a local approval or nearest-city fallback.
  const derivedOptions =
    suppliedOptions == null &&
    action &&
    owner != null &&
    cityId != null &&
    Array.isArray(game?.cities)
      ? game.cities
          .filter(
            (city) =>
              city.owner === owner &&
              !city.camp &&
              city.id !== cityId &&
              distance(tile, city) <= 3,
          )
          .map((city) => ({ id: city.id, name: city.name }))
      : [];
  const options = suppliedOptions ?? derivedOptions;
  const explicit =
    cityId != null ||
    owner != null ||
    suppliedOptions != null ||
    tile.assignmentIssue != null ||
    tile.reassignable !== undefined ||
    (action != null && (owner != null || cityId != null));
  if (!explicit) return { available: false };
  const optionList = Array.isArray(options)
    ? options
    : options && typeof options === "object"
      ? Object.values(options)
      : [];
  const centerCity = (game?.cities ?? []).find(
    (city) =>
      (city.id === cityId || city.owner === owner) &&
      !city.camp &&
      city.q === tile.q &&
      city.r === tile.r,
  );
  return {
    available: true,
    owner,
    cityId,
    cityName: tile.cityName ?? tile.assignedCityName ?? null,
    isCenter:
      tile.cityCenter === true ||
      tile.isCityCenter === true ||
      tile.center === true ||
      !!centerCity,
    reassignable: tile.reassignable === true || optionList.length > 0,
    issue: tile.assignmentIssue ?? tile.reassignmentIssue ?? null,
    options: optionList,
    action,
  };
}

export function structureSummary(tile, game = null) {
  if (!tile) return { available: false };
  const structure =
    tile.encampment !== false && tile.encampment != null
      ? tile.encampment
      : tile.camp !== false && tile.camp != null
        ? tile.camp
        : tile.bastion !== false && tile.bastion != null
          ? tile.bastion
          : null;
  const data = structure && typeof structure === "object" ? structure : {};
  const hp = asNumber(data.hp ?? tile.encampmentHp ?? tile.campHp);
  const maxHp = asNumber(data.maxHp ?? tile.encampmentMaxHp ?? tile.campMaxHp);
  const walls = asNumber(data.wallsHp ?? data.wallHp ?? tile.encampmentWalls);
  const rawStatus = String(
    data.status ?? tile.encampmentStatus ?? "",
  ).toLowerCase();
  const absentStatus = /^(none|missing|absent|inactive|unbuilt|empty|false|0)$/i.test(
    rawStatus,
  );
  const hasStructureValue =
    structure === true ||
    (structure &&
      typeof structure === "object" &&
      structure.present !== false &&
      structure.exists !== false &&
      structure.built !== false);
  const hasLifecycleState = rawStatus && !absentStatus && rawStatus !== "active";
  // A capability or a default `active` status can be present on every tile;
  // it is not proof that an encampment was actually built. Require the
  // authoritative structure object/marker, HP ledger, or a non-default
  // lifecycle state before rendering a structure card.
  const explicit =
    hasStructureValue ||
    hp != null ||
    maxHp != null ||
    walls != null ||
    hasLifecycleState;
  if (!explicit) return { available: false };
  const kind = tile.encampment
    ? "encampment"
    : tile.bastion
      ? "bastion"
      : tile.camp
        ? "fort"
        : "encampment";
  const owner = data.owner ?? tile.encampmentOwner ?? tile.owner ?? null;
  const status = String(
    data.status ?? tile.encampmentStatus ?? "active",
  ).toLowerCase();
  const captured =
    data.captured === true ||
    tile.encampmentCaptured === true ||
    status.includes("captur");
  const repairRequired =
    data.repairRequired === true ||
    tile.encampmentRepairRequired === true ||
    (hp != null && hp <= 0);
  return {
    available: true,
    built: hasStructureValue || hp != null || maxHp != null || walls != null,
    kind,
    hp,
    maxHp,
    walls,
    owner,
    captured,
    usablePosition: data.usablePosition !== false && tile.encampmentPosition !== false,
    repairRequired,
    repairAction: logisticsCapability(game).actions.repairStructure ?? null,
  };
}

function listValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === "object")
    return Object.values(value).flatMap((entry) => listValue(entry));
  return [];
}

export function cargoEntries(game) {
  const values = [
    game?.cargo,
    game?.shipments,
    game?.supplyConvoys,
    game?.tradeCargo,
    game?.logistics?.shipments,
    game?.logistics?.cargo,
    game?.logistics?.convoys,
    game?.logistics?.tradeCargo,
  ];
  const seen = new Set();
  return values.flatMap((value) =>
    listValue(value).filter((entry) => {
      const id = entry.id ?? entry.cargoId ?? entry.shipmentId;
      if (id == null || seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  );
}

export function cargoStatus(entry) {
  const raw = String(entry?.status ?? entry?.state ?? "").toLowerCase();
  if (raw.includes("deliver") || raw === "arrived") return "도착 완료";
  if (raw.includes("lost") || raw.includes("destroy")) return "분실";
  if (raw.includes("captur") || raw.includes("loot")) return "나포됨";
  if (raw.includes("block")) return "경로 막힘";
  if (raw.includes("dispatch") || raw.includes("order")) return "출발 준비";
  if (raw.includes("transit") || raw.includes("travel")) return "운송 중";
  return raw ? entry.status : "상태 확인 중";
}

export function cargoForEntity(game, entity) {
  if (!entity) return [];
  const ids = new Set([entity.id, `${entity.q},${entity.r}`]);
  return cargoEntries(game).filter((entry) => {
    const refs = [
      entry.unitId,
      entry.cityId,
      entry.fromCityId,
      entry.toCityId,
      entry.originId,
      entry.destinationId,
      entry.targetId,
      entry.position && `${entry.position.q},${entry.position.r}`,
      entry.origin?.cityId,
      entry.destination?.cityId,
      entry.origin?.unitId,
      entry.destination?.unitId,
    ];
    return refs.some((ref) => ref != null && ids.has(ref));
  });
}

export function merchantSummary(game, city) {
  if (!city) return { available: false };
  const logistics = logisticsStateObject(game);
  const observed = Array.isArray(logistics?.tradingPosts)
    ? logistics.tradingPosts.find((entry) => entry?.cityId === city.id)
    : null;
  const directPost = city.tradingPost ?? city.tradePost ?? city.tradingpost ?? null;
  const post = directPost ?? (observed?.built === true ? observed : null);
  const quota =
    first(city, ["merchantQuota", "merchantCapacity", "tradePostQuota"]) ??
    observed?.capacity;
  const merchants =
    first(city, ["merchants", "merchantCount", "assignedMerchants"]) ??
    observed?.active;
  const explicit =
    post != null ||
    quota !== undefined ||
    merchants !== undefined ||
    logisticsCapability(game).merchant;
  if (!explicit) return { available: false };
  const postObject =
    post && typeof post === "object" ? post : observed && typeof observed === "object" ? observed : {};
  const capacity = asNumber(quota ?? postObject.merchantQuota ?? postObject.capacity) ?? 1;
  const active = asNumber(merchants ?? postObject.merchants ?? postObject.activeMerchants) ?? 0;
  const traveling = asNumber(postObject.traveling ?? city.travelingMerchants) ?? 0;
  const ordered = asNumber(postObject.ordered ?? city.orderedMerchants) ?? 0;
  const inUse = active + traveling + ordered;
  return {
    available: true,
    built: post === true || (post != null && postObject.built !== false),
    capacity,
    active,
    traveling,
    ordered,
    inUse,
    remaining: Math.max(0, capacity - inUse),
  };
}

function nestedValue(value, names) {
  return value && typeof value === "object" ? first(value, names) : undefined;
}

export function manpowerSummary(city, game = null) {
  if (!city) return { available: false };
  const queue = first(city, [
    "mobilization",
    "mobilizationQueue",
    "manpowerQueue",
    "unitMobilization",
  ]);
  const queueData = queue && typeof queue === "object" && !Array.isArray(queue)
    ? queue
    : {};
  const pending = Array.isArray(queueData.pending) ? queueData.pending : [];
  const reservedValue =
    nestedValue(queueData, ["pendingManpower", "reserved", "manpowerReserved", "citizens"]) ??
    first(city, ["manpowerReserved", "citizensReserved", "mobilizedPopulation"]);
  const availableValue =
    first(city, ["manpowerQueueAvailable", "manpowerAvailable", "citizensAvailable"]) ??
    nestedValue(queueData, ["available", "manpowerAvailable"]);
  const unitCountValue =
    first(city, ["mobilizationUnits", "reservedUnits", "unitsQueued"]) ??
    nestedValue(queueData, ["pendingCount", "units", "unitCount", "quantity", "count"]) ??
    (pending.length ? pending.length : undefined);
  const pendingTypes = [...new Set(pending.map((entry) => entry?.type).filter(Boolean))];
  const unitType =
    first(city, ["mobilizationType", "unitType", "mobilizedType"]) ??
    nestedValue(queueData, ["unitType", "type"]) ??
    (pendingTypes.length === 1 ? pendingTypes[0] : undefined);
  const perUnitValue =
    first(city, ["manpowerPerUnit", "populationPerUnit", "manpowerCost"]) ??
    nestedValue(queueData, ["manpowerPerUnit", "populationPerUnit"]);
  const perTurnValue =
    first(city, ["mobilizationPerTurn", "unitsPerTurn", "departurePerTurn"]) ??
    nestedValue(queueData, ["unitsPerTurn", "perTurn", "departurePerTurn"]);
  const turnsValue =
    first(city, ["mobilizationTurns", "mobilizationEta", "manpowerEta"]) ??
    nestedValue(queueData, ["turns", "eta", "duration"]);
  const nextDepartureValue =
    first(city, ["nextMobilizationTurn", "nextDepartureTurn", "nextDepartureIn"]) ??
    nestedValue(queueData, ["nextDepartureTurn", "nextDepartureIn", "nextTurn"]);
  const reason =
    first(city, ["manpowerIssue", "mobilizationIssue", "manpowerShortage"]) ??
    nestedValue(queueData, ["reason", "issue", "shortageReason"]) ??
    pending.find((entry) => entry?.blockedReason)?.blockedReason;
  const explicit =
    queue != null ||
    reservedValue !== undefined ||
    availableValue !== undefined ||
    unitCountValue !== undefined ||
    unitType !== undefined ||
    reason !== undefined;
  if (!explicit) return { available: false };
  const reserved = asNumber(reservedValue);
  const manpowerPerUnit = asNumber(perUnitValue);
  const units =
    asNumber(unitCountValue) ??
    (reserved != null && manpowerPerUnit > 0
      ? Math.floor(reserved / manpowerPerUnit)
      : null);
  const perTurn =
    asNumber(perTurnValue) ??
    (pending.length && game?.rulesVersion === "expansion-v1" ? 1 : null);
  const turns =
    asNumber(turnsValue) ??
    (units != null && perTurn != null && perTurn > 0
      ? Math.ceil(units / perTurn)
      : null);
  const sequentialValue =
    first(city, ["mobilizationSequential", "sequentialMobilization"]) ??
    nestedValue(queueData, ["sequential", "onePerTurn"]) ??
    (pending.length ? true : undefined);
  const nextDeparture =
    asNumber(nextDepartureValue) ??
    (pending.length && game?.rulesVersion === "expansion-v1" ? 1 : null);
  const cancelAction =
    logisticsCapability(game).actions.cancelMobilization ??
    (pending.length && game?.rulesVersion === "expansion-v1"
      ? "cancelMobilization"
      : null);
  return {
    available: true,
    detailed: detailedLogisticsState(game).enabled,
    reserved,
    availableManpower: asNumber(availableValue),
    units,
    unitType: unitType == null ? null : String(unitType),
    manpowerPerUnit,
    perTurn,
    turns,
    nextDeparture,
    sequential: sequentialValue == null ? null : sequentialValue === true,
    reason: reason == null ? null : String(reason),
    pending,
    cancelAction: typeof cancelAction === "string" ? cancelAction : null,
  };
}

export function laborSummary(city) {
  if (!city) return { available: false };
  const allocation = city.citizenAllocation;
  if (allocation && typeof allocation === "object") {
    const slotList = Array.isArray(allocation.slots) ? allocation.slots : [];
    return {
      available: true,
      budget: asNumber(allocation.budget),
      slots: slotList.length,
      slotList,
      assigned: asNumber(allocation.assigned) ??
        (Array.isArray(allocation.assignments) ? allocation.assignments.length : 0),
      availableWorkers: asNumber(allocation.available),
      mode: allocation.auto === false ? "manual" : "auto",
      auto: allocation.auto !== false,
      lockedSlots: Array.isArray(allocation.lockedSlots)
        ? allocation.lockedSlots
        : [],
      priority: Array.isArray(allocation.priority) ? allocation.priority : [],
      assignments: Array.isArray(allocation.assignments)
        ? allocation.assignments
        : [],
      issue: null,
    };
  }
  const assignments = first(city, [
    "workerAssignments",
    "laborAssignments",
    "workersByFacility",
  ]);
  const slotsValue = first(city, ["laborSlots", "workerSlots", "availableWorkers"]);
  const assignedValue = first(city, [
    "workersAssigned",
    "assignedWorkers",
    "laborAssigned",
  ]);
  const mode = first(city, ["laborMode", "workerMode", "workforceMode"]);
  const explicit =
    assignments != null ||
    slotsValue !== undefined ||
    assignedValue !== undefined ||
    mode !== undefined ||
    city.laborIssue != null;
  if (!explicit) return { available: false };
  const slots = asNumber(slotsValue);
  const assigned = asNumber(assignedValue);
  return {
    available: true,
    slots,
    slotList: [],
    budget: null,
    assigned,
    availableWorkers: null,
    mode: mode == null ? null : String(mode),
    auto: mode !== "manual",
    lockedSlots: [],
    priority: [],
    assignments,
    issue: city.laborIssue == null ? null : String(city.laborIssue),
  };
}

export function unitManpowerSummary(unit) {
  if (!unit) return { available: false };
  const sources = first(unit, ["manpowerSources", "manpowerLedger", "populationSources"]);
  const cost = first(unit, ["manpowerCost", "populationCost"]);
  if (sources == null && cost === undefined && unit.homeCityId == null)
    return { available: false };
  const sourceList = Array.isArray(sources)
    ? sources
    : sources && typeof sources === "object"
      ? Object.values(sources)
      : [];
  const tracked =
    asNumber(cost) ??
    sourceList.reduce((total, source) => {
      if (typeof source === "number") return total + source;
      return total + (asNumber(source?.amount ?? source?.manpower ?? source?.population) ?? 0);
    }, 0);
  return {
    available: true,
    tracked,
    homeCityId: unit.homeCityId ?? null,
    sources: sourceList,
  };
}

export function productionLogisticsOptions(game, city) {
  const source =
    city?.productionTypes ??
    city?.availableProductionTypes ??
    game?.productionTypes ??
    game?.capabilities?.productionTypes ??
    game?.logistics?.productionTypes ??
    null;
  if (!source || (typeof source !== "object" && !Array.isArray(source))) return [];
  const entries = Array.isArray(source)
    ? source.map((type) => [type, true])
    : Object.entries(source);
  return entries
    .filter(([type, definition]) =>
      ["merchant", "tradingPost", "tradingpost", "encampment"].includes(type) &&
      definition !== false,
    )
    .map(([type, definition]) => [
      type,
      definition && typeof definition === "object"
        ? definition
        : productionType(type, city),
    ]);
}

/**
 * Return observed same-city empty tiles that can be offered as encampment
 * targets. This is only a candidate picker: the server rechecks ownership,
 * radius, structures and the city's connected footprint when production is
 * submitted.
 */
export function encampmentTargetCandidates(game, city) {
  if (!game || !city) return [];
  const supplied =
    city.encampmentCandidates ??
    (game.logistics && typeof game.logistics.encampmentCandidates === "object"
      ? game.logistics.encampmentCandidates[city.id]
      : null);
  if (Array.isArray(supplied)) {
    return supplied
      .map((entry) => entry?.tile ?? entry)
      .filter(
        (tile) =>
          tile && Number.isFinite(Number(tile.q)) && Number.isFinite(Number(tile.r)),
      );
  }
  return (game.tiles ?? [])
    .filter(
      (tile) =>
        tile?.owner === game.playerId &&
        tile?.cityId === city.id &&
        tile?.explored !== false &&
        ["plains", "hills"].includes(tile.terrain) &&
        !equal(tile, city) &&
        !tile.farm &&
        !tile.developed &&
        !tile.encampment &&
        !tile.fort &&
        !tile.bastion,
    )
    .sort((a, b) => `${a.q},${a.r}`.localeCompare(`${b.q},${b.r}`));
}
