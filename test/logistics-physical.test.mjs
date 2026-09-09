import { TYPES } from "../shared/rules.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  captureCarrierCargo,
  createFoodShipment,
  createPillageCargo,
  createResourceShipment,
  createUnitFoodShipment,
  demobilizeUnitLogistics,
  dispatchAutomaticFood,
  ensureLogisticsState,
  hasRoad,
  interceptShipment,
  merchantSummary,
  markCarrierDestroyed,
  onSupplyModeChanged,
  publicLogisticsState,
  queueMerchant,
  registerMerchant,
  returnCapturedCargo,
  seedUnitFood,
  mergeUnitLogistics,
  scheduleMerchantRoute,
  scheduleUnitTrade,
  supplyLocalUnit,
  tickLogistics,
  consumeUnitFood,
} from "../server/logistics.mjs";
import { key } from "../shared/rules.js";

function fixture(mode = "on") {
  const g = {
    rulesVersion: "expansion-v1",
    supplyMode: mode,
    turn: 1,
    tiles: [],
    cities: [],
    units: [],
    wars: ["p1|p2", "p2|p3", "p1|p3"],
    stockpiles: {
      p1: { iron: 8, horses: 8, niter: 8 },
      p2: { iron: 3, horses: 0, niter: 8 },
      p3: { iron: 0, horses: 0, niter: 8 },
    },
    players: {
      p1: { controller: "human" },
      p2: { controller: "human" },
      p3: { controller: "human" },
    },
    factions: {
      p1: { kind: "player" },
      p2: { kind: "player" },
      p3: { kind: "player" },
    },
  };
  for (let q = 0; q < 20; q++)
    for (let r = 0; r < 20; r++) g.tiles.push({ q, r, terrain: "plains" });
  return g;
}

function city(g, id, owner, q, r, food = 0, extra = {}) {
  const value = {
    id,
    owner,
    name: id,
    q,
    r,
    hp: 160,
    population: 3,
    food,
    camp: false,
    ...extra,
  };
  g.cities.push(value);
  return value;
}

function military(g, id, owner, q, r, extra = {}) {
  const value = {
    id,
    owner,
    type: "spearman",
    q,
    r,
    hp: 100,
    size: 1,
    manpowerCost: 0.5,
    ...extra,
  };
  g.units.push(value);
  return value;
}

function moveUntil(g, shipment, owner, start = 1) {
  for (let turn = start; turn < start + 80 && !["delivered", "lost"].includes(shipment.status); turn++)
    tickLogistics(g, {
      turn,
      owner,
      consumeUnits: false,
      automaticSupply: false,
    });
}

test("ON food cargo is escrowed once, physically delivered once, and paused in OFF", () => {
  const g = fixture("on");
  const source = city(g, "a", "p1", 1, 1, 10);
  const destination = city(g, "b", "p1", 5, 1, 0);
  ensureLogisticsState(g);
  const shipment = createFoodShipment(g, {
    owner: "p1",
    recipient: "p1",
    fromCityId: source.id,
    toCityId: destination.id,
    amount: 4,
  });
  assert.equal(source.food, 6);
  g.supplyMode = "off";
  onSupplyModeChanged(g, "on", "off", 1);
  tickLogistics(g, { turn: 1, owner: "p1", consumeUnits: false, automaticSupply: false });
  assert.equal(shipment.paused, true);
  assert.equal(destination.food, 0);
  g.supplyMode = "on";
  onSupplyModeChanged(g, "off", "on", 2);
  moveUntil(g, shipment, "p1", 2);
  assert.equal(shipment.status, "delivered");
  assert.equal(destination.food, 4);
  tickLogistics(g, { turn: 80, owner: "p1", consumeUnits: false, automaticSupply: false });
  assert.equal(destination.food, 4);
});

test("resource shipments remain physical in OFF and establish usable roads", () => {
  const g = fixture("off");
  const source = city(g, "a", "p1", 1, 1, 0);
  const destination = city(g, "b", "p2", 5, 1, 0);
  ensureLogisticsState(g);
  const shipment = createResourceShipment(g, {
    owner: "p1",
    recipient: "p2",
    fromCityId: source.id,
    toCityId: destination.id,
    resource: "iron",
    amount: 3,
  });
  assert.equal(g.stockpiles.p1.iron, 5);
  moveUntil(g, shipment, "p1");
  assert.equal(shipment.status, "delivered");
  assert.equal(g.stockpiles.p2.iron, 6);
  assert.ok(g.logistics.roads.length > 0);
  const edge = g.logistics.roads[0].split("|").map((value) => {
    const [q, r] = value.split(",").map(Number);
    return { q, r };
  });
  assert.equal(hasRoad(g, edge[0], edge[1]), true);
});

test("ordinary bulk dispatch owns a real internal convoy and retires it on arrival", () => {
  const g = fixture("off");
  const source = city(g, "a", "p1", 1, 1, 0);
  const destination = city(g, "b", "p2", 5, 1, 0);
  ensureLogisticsState(g);
  const shipment = createResourceShipment(g, {
    owner: "p1",
    recipient: "p2",
    fromCityId: source.id,
    toCityId: destination.id,
    resource: "iron",
    amount: 1,
  });
  const convoy = g.units.find((unit) => unit.id === shipment.carrierId);
  assert.equal(convoy?.type, "convoy");
  assert.equal(convoy?.logisticsSpawned, true);
  moveUntil(g, shipment, "p1");
  assert.equal(shipment.status, "delivered");
  assert.equal(g.units.some((unit) => unit.id === convoy.id), false);
});

test("captured cargo stays on captor, returns by convoy, and dies without refund", () => {
  const g = fixture("on");
  const source = city(g, "a", "p1", 1, 1, 0);
  const destination = city(g, "b", "p2", 7, 1, 0);
  const captor = military(g, "captor", "p2", 1, 1);
  ensureLogisticsState(g);
  const shipment = createResourceShipment(g, {
    owner: "p1",
    recipient: "p2",
    fromCityId: source.id,
    toCityId: destination.id,
    resource: "iron",
    amount: 2,
  });
  interceptShipment(g, { shipmentId: shipment.id, unitId: captor.id });
  assert.equal(shipment.status, "captured");
  assert.equal(captor.cargo[0].amount, 2);
  assert.equal(g.stockpiles.p2.iron, 3);
  returnCapturedCargo(g, { shipmentId: shipment.id, unitId: captor.id, toCityId: destination.id });
  moveUntil(g, shipment, "p2");
  assert.equal(shipment.status, "delivered");
  assert.equal(g.stockpiles.p2.iron, 5);
  const lost = createResourceShipment(g, {
    owner: "p1",
    recipient: "p2",
    fromCityId: source.id,
    toCityId: destination.id,
    resource: "iron",
    amount: 1,
  });
  interceptShipment(g, { shipmentId: lost.id, unitId: captor.id, turn: 90 });
  captor.hp = 0;
  tickLogistics(g, { turn: 90, owner: "p1", consumeUnits: false, automaticSupply: false });
  assert.equal(lost.status, "lost");
  assert.equal(g.stockpiles.p2.iron, 5);
});

test("combat carrier-capture hook transfers adjacent cargo without moving the attacker", () => {
  const g = fixture("off");
  const source = city(g, "a", "p1", 2, 2, 0);
  const destination = city(g, "b", "p2", 6, 2, 0);
  const carrier = military(g, "convoy", "p1", 2, 2, { type: "convoy", hp: 40 });
  const attacker = military(g, "attacker", "p2", 3, 2);
  ensureLogisticsState(g);
  const shipment = createResourceShipment(g, {
    owner: "p1",
    recipient: "p2",
    fromCityId: source.id,
    toCityId: destination.id,
    resource: "iron",
    amount: 1,
    carrierId: carrier.id,
    carrierType: "convoy",
  });
  const captured = captureCarrierCargo(g, {
    unitId: attacker.id,
    carrierId: carrier.id,
  });
  assert.equal(captured[0].status, "captured");
  assert.equal(attacker.q, 3);
  assert.equal(attacker.cargo[0].shipmentId, shipment.id);
  assert.equal(carrier.q, 2);
});

test("unit reserves consume locally, and food-to-unit delivery never debits city remotely", () => {
  const g = fixture("on");
  const source = city(g, "a", "p1", 1, 1, 6);
  const destination = city(g, "b", "p1", 4, 1, 0);
  const unit = military(g, "u", "p1", 4, 1, { foodStock: 2, foodCapacity: 4 });
  ensureLogisticsState(g);
  const beforeCity = source.food;
  const shipment = createUnitFoodShipment(g, {
    owner: "p1",
    recipient: "p1",
    fromCityId: source.id,
    toUnitId: unit.id,
    amount: 2,
  });
  assert.equal(source.food, beforeCity - 2);
  moveUntil(g, shipment, "p1");
  assert.equal(unit.foodStock, 4);
  const consumed = consumeUnitFood(g, unit, { turn: 100 });
  assert.equal(consumed.consumed, 1);
  assert.equal(unit.foodStock, 3);
  g.supplyMode = "off";
  const preserved = unit.foodStock;
  assert.equal(consumeUnitFood(g, unit, { turn: 101 }).active, false);
  assert.equal(unit.foodStock, preserved);
  assert.equal(destination.food, 0);
});

test("automatic supply also dispatches a city-to-field-unit convoy toward its reserve", () => {
  const g = fixture("on");
  const source = city(g, "source", "p1", 1, 1, 10);
  const unit = military(g, "field", "p1", 5, 1, {
    homeCityId: source.id,
    foodStock: 0,
    targetReserve: 2,
  });
  ensureLogisticsState(g);
  const created = dispatchAutomaticFood(g, { owner: "p1", turn: 1 });
  assert.equal(created.length, 1);
  assert.equal(created[0].toUnitId, unit.id);
  assert.equal(source.food, 8);
  moveUntil(g, created[0], "p1");
  assert.equal(unit.foodStock, 2);
});

test("an own-city garrison gets local stock before its once-per-turn hunger check", () => {
  const g = fixture("on");
  const home = city(g, "home", "p1", 2, 2, 3);
  const unit = military(g, "garrison", "p1", 2, 2, { foodStock: 0 });
  ensureLogisticsState(g);
  const result = supplyLocalUnit(g, unit, { turn: 12 });
  assert.equal(result.transferred, 2);
  assert.equal(unit.foodStock, 2);
  assert.equal(home.food, 1);
  const consumed = consumeUnitFood(g, unit, { turn: 12 });
  assert.equal(consumed.shortage, false);
  assert.equal(unit.foodStock, 1);
});

test("a remote home city cannot teleport stock into a field unit", () => {
  const g = fixture("on");
  const home = city(g, "home", "p1", 2, 2, 3);
  const unit = military(g, "field", "p1", 8, 8, { homeCityId: home.id, foodStock: 0 });
  ensureLogisticsState(g);
  const result = supplyLocalUnit(g, unit, { turn: 12 });
  assert.equal(result.transferred, 0);
  assert.equal(unit.foodStock, 0);
  assert.equal(home.food, 3);
});

test("surviving city demobilization returns personal stock once, while a remote reserve is not teleported", () => {
  const g = fixture("on");
  const home = city(g, "home", "p1", 2, 2, 3);
  const garrison = military(g, "garrison", "p1", 2, 2, { homeCityId: home.id, foodStock: 4 });
  ensureLogisticsState(g);
  const returned = demobilizeUnitLogistics(g, garrison, { turn: 12 });
  assert.equal(returned.returnedFood, 4);
  assert.equal(garrison.foodStock, 0);
  assert.equal(home.food, 7);

  const field = military(g, "field", "p1", 8, 8, { homeCityId: home.id, foodStock: 2 });
  const remote = demobilizeUnitLogistics(g, field, { turn: 12 });
  assert.equal(remote.returnedFood, 0);
  assert.equal(remote.lostFood, 2);
  assert.equal(home.food, 7);
});

test("pillage/scorch rewards stay in a unit-held ledger until the return convoy arrives", () => {
  const g = fixture("on");
  const home = city(g, "home", "p1", 1, 1, 0);
  const raider = military(g, "raider", "p1", 4, 1, { hp: 60 });
  ensureLogisticsState(g);
  const shipment = createPillageCargo(g, {
    unitId: raider.id,
    kind: "food",
    amount: 3,
    toCityId: home.id,
    action: "scorch",
    autoReturn: true,
  });
  assert.equal(shipment.status, "returning");
  assert.equal(home.food, 0);
  assert.equal(raider.cargo.length, 0);
  moveUntil(g, shipment, "p1");
  assert.equal(shipment.status, "delivered");
  assert.equal(home.food, 3);

  const held = military(g, "held-raider", "p1", 4, 1);
  const lost = createPillageCargo(g, {
    unitId: held.id,
    kind: "resource",
    resource: "iron",
    amount: 1,
    toCityId: home.id,
    autoReturn: false,
  });
  assert.equal(lost.status, "captured");
  assert.equal(held.cargo.length, 1);
  markCarrierDestroyed(g, held.id, 20);
  assert.equal(lost.status, "lost");
});

test("initial reserve and formation merge conserve personal food and held cargo", () => {
  const g = fixture("on");
  const target = military(g, "target", "p1", 1, 1, { foodStock: 1, foodCapacity: 2 });
  const source = military(g, "source", "p1", 1, 1, { foodStock: 2, foodCapacity: 2 });
  ensureLogisticsState(g);
  seedUnitFood(g, target, { amount: 2 });
  assert.equal(target.foodStock, 2);
  source.cargo = [{ shipmentId: "held-1", kind: "resource", amount: 1 }];
  const merged = mergeUnitLogistics(g, target, source);
  assert.equal(merged.foodStock, 4);
  assert.equal(target.foodStock, 4);
  assert.equal(source.foodStock, 0);
  assert.equal(target.cargo.length, 1);
  assert.equal(source.cargo.length, 0);
});

test("one trading post allows one active or queued merchant and merchant movement is visible", () => {
  const g = fixture("off");
  const source = city(g, "a", "p1", 1, 1, 0, { tradingPost: { built: true } });
  const destination = city(g, "b", "p2", 5, 1, 0);
  ensureLogisticsState(g);
  const order = queueMerchant(g, { owner: "p1", cityId: source.id });
  assert.throws(() => queueMerchant(g, { owner: "p1", cityId: source.id }));
  const merchant = registerMerchant(g, { owner: "p1", cityId: source.id, orderId: order.id });
  assert.equal(merchant.manpowerCost, 0);
  assert.equal(merchantSummary(g, source).inUse, 1);
  const shipment = scheduleMerchantRoute(g, {
    merchantId: merchant.id,
    owner: "p1",
    fromCityId: source.id,
    toCityId: destination.id,
    recipient: "p2",
    kind: "resource",
    resource: "iron",
    amount: 2,
  });
  moveUntil(g, shipment, "p1");
  assert.equal(shipment.status, "delivered");
  assert.notEqual(`${merchant.q},${merchant.r}`, `${source.q},${source.r}`);
  assert.ok(g.logistics.roads.length > 0);
});

test("public logistics hides unrelated cargo and unknown route geography", () => {
  const g = fixture("off");
  const a = city(g, "a", "p1", 1, 1, 0);
  const b = city(g, "b", "p2", 5, 1, 0);
  const c = city(g, "c", "p3", 9, 1, 0);
  ensureLogisticsState(g);
  const own = createResourceShipment(g, {
    owner: "p1",
    recipient: "p2",
    fromCityId: a.id,
    toCityId: b.id,
    resource: "iron",
    amount: 1,
  });
  createResourceShipment(g, {
    owner: "p2",
    recipient: "p3",
    fromCityId: b.id,
    toCityId: c.id,
    resource: "iron",
    amount: 1,
  });
  g.explored = { p1: { [key(a)]: true } };
  const view = publicLogisticsState(g, "p1", { explored: g.explored });
  assert.ok(view.cargo.some((entry) => entry.id === own.id));
  assert.equal(view.cargo.some((entry) => entry.recipient === "p3"), false);
  assert.equal(view.roads.length, 0);
  const observed = publicLogisticsState(g, "p1", {
    visibleTiles: new Set([key(b)]),
  });
  const enemy = observed.cargo.find(
    (entry) => entry.status === "in_transit" && entry.owner === null,
  );
  assert.ok(enemy);
  assert.equal(enemy.amount, null);
  assert.equal(enemy.resource, null);
  assert.deepEqual(enemy.path, []);
});

test("unit trade changes controller immediately but keeps the unit at its tile until arrival", () => {
  const g = fixture("off");
  city(g, "a", "p1", 1, 1, 0);
  const destination = city(g, "b", "p2", 5, 1, 0);
  const unit = military(g, "u", "p1", 1, 1);
  ensureLogisticsState(g);
  const shipment = scheduleUnitTrade(g, {
    unitId: unit.id,
    fromOwner: "p1",
    recipient: "p2",
    toCityId: destination.id,
  });
  assert.equal(unit.owner, "p2");
  assert.deepEqual({ q: unit.q, r: unit.r }, { q: 1, r: 1 });
  moveUntil(g, shipment, "p2");
  assert.equal(shipment.status, "delivered");
  assert.deepEqual({ q: unit.q, r: unit.r }, { q: 5, r: 1 });
});

test("traded units spend their movement budget and do not create roads", () => {
  const g = fixture("off");
  city(g, "a", "p1", 1, 1, 0);
  const destination = city(g, "b", "p2", 5, 1, 0);
  const unit = military(g, "cavalry", "p1", 1, 1, { type: "cavalry" });
  ensureLogisticsState(g);
  const shipment = scheduleUnitTrade(g, {
    unitId: unit.id,
    fromOwner: "p1",
    recipient: "p2",
    toCityId: destination.id,
  });

  tickLogistics(g, {
    turn: 1,
    owner: "p2",
    consumeUnits: false,
    automaticSupply: false,
  });

  assert.equal(shipment.status, "delivered");
  assert.deepEqual({ q: unit.q, r: unit.r }, { q: 5, r: 1 });
  assert.equal(unit.movesLeft, TYPES.cavalry.movement - 4);
  assert.equal(g.logistics.roads.length, 0);
});

test("traded movement may enter one positive-budget over-cost river edge", () => {
  const g = fixture("off");
  city(g, "a", "p1", 1, 1, 0);
  const destination = city(g, "b", "p2", 4, 1, 0);
  const unit = military(g, "river-trade", "p1", 1, 1);
  g.rivers = [{ a: { q: 1, r: 1 }, b: { q: 2, r: 1 } }];
  ensureLogisticsState(g);
  const shipment = scheduleUnitTrade(g, {
    unitId: unit.id,
    fromOwner: "p1",
    recipient: "p2",
    toCityId: destination.id,
  });
  shipment.path = [
    { q: 1, r: 1 },
    { q: 2, r: 1 },
    { q: 3, r: 1 },
    { q: 4, r: 1 },
  ];
  shipment.pathIndex = 0;
  shipment.routeTarget = { q: 4, r: 1 };

  tickLogistics(g, {
    turn: 1,
    owner: "p2",
    consumeUnits: false,
    automaticSupply: false,
  });

  // Four movement points: the river edge costs three, one plains step
  // follows, and the unit still has one tile left to the destination.
  assert.equal(shipment.status, "in_transit");
  assert.deepEqual({ q: unit.q, r: unit.r }, { q: 3, r: 1 });
  assert.equal(unit.movesLeft, 0);
});

test("traded movement revalidates terrain, blocksUnit occupancy, foreign cities, and ZOC", () => {
  const blockedCases = [
    {
      name: "mountain",
      setup(g) {
        g.tiles.find((tile) => tile.q === 2 && tile.r === 1).terrain = "mountain";
      },
      expected: "산지",
    },
    {
      name: "same-side military occupant",
      setup(g) {
        military(g, "blocker", "p2", 2, 1);
      },
      expected: "막혀",
    },
    {
      name: "foreign city",
      setup(g) {
        city(g, "foreign", "p3", 2, 1, 0);
      },
      expected: "도시",
    },
    {
      name: "hostile zone of control",
      setup(g) {
        military(g, "zoc", "p3", 1, 2);
      },
      expected: "통제구역",
    },
  ];

  for (const blocked of blockedCases) {
    const g = fixture("off");
    city(g, "a", "p1", 1, 1, 0);
    const destination = city(g, "b", "p2", 5, 1, 0);
    const unit = military(g, `trade-${blocked.name}`, "p1", 1, 1);
    blocked.setup(g, destination);
    ensureLogisticsState(g);
    const shipment = scheduleUnitTrade(g, {
      unitId: unit.id,
      fromOwner: "p1",
      recipient: "p2",
      toCityId: destination.id,
    });
    // The acceptance-time path is a public plan. Force its first edge to be
    // the newly invalidated edge so the execution hook must revalidate it.
    shipment.path = [
      { q: 1, r: 1 },
      { q: 2, r: 1 },
      { q: 3, r: 1 },
      { q: 4, r: 1 },
      { q: 5, r: 1 },
    ];
    shipment.pathIndex = 0;
    shipment.routeTarget = { q: 5, r: 1 };
    tickLogistics(g, {
      turn: 1,
      owner: "p2",
      consumeUnits: false,
      automaticSupply: false,
    });
    assert.equal(shipment.status, "blocked", blocked.name);
    assert.deepEqual({ q: unit.q, r: unit.r }, { q: 1, r: 1 }, blocked.name);
    assert.match(shipment.blockedReason, new RegExp(blocked.expected), blocked.name);
  }
});

test("returning captured cargo plans with the captor's known geography", () => {
  const g = fixture("on");
  const source = city(g, "source", "p1", 1, 1, 0);
  const destination = city(g, "destination", "p2", 3, 1, 0);
  const captor = military(g, "captor", "p2", 1, 1);
  ensureLogisticsState(g);
  const shipment = createResourceShipment(g, {
    owner: "p1",
    recipient: "p2",
    fromCityId: source.id,
    toCityId: destination.id,
    resource: "iron",
    amount: 1,
  });
  interceptShipment(g, { shipmentId: shipment.id, unitId: captor.id });

  for (const tile of g.tiles) tile.terrain = "mountain";
  g.tiles.find((tile) => tile.q === 1 && tile.r === 1).terrain = "plains";
  g.tiles.find((tile) => tile.q === 3 && tile.r === 1).terrain = "plains";
  g.explored = {
    p2: Object.fromEntries(g.tiles.map((tile) => [key(tile), true])),
  };
  assert.throws(
    () =>
      returnCapturedCargo(g, {
        shipmentId: shipment.id,
        unitId: captor.id,
        toCityId: destination.id,
      }),
    /반환 경로/,
  );
  assert.equal(shipment.status, "captured");
  assert.equal(g.units.filter((unit) => unit.logisticsSpawned).length, 0);
});

test("automatic city supply counts food already in transit toward the destination reserve", () => {
  const g = fixture("on");
  const source = city(g, "source", "p1", 1, 1, 10, { targetReserve: 0 });
  const destination = city(g, "destination", "p1", 4, 1, 0, { targetReserve: 4 });
  ensureLogisticsState(g);

  const first = dispatchAutomaticFood(g, { owner: "p1", turn: 1 });
  const second = dispatchAutomaticFood(g, { owner: "p1", turn: 1 });

  assert.equal(first.length, 1);
  assert.equal(first[0].toCityId, destination.id);
  assert.equal(second.length, 0);
  assert.equal(source.food, 6);
  assert.equal(destination.food, 0);
  assert.equal(
    g.logistics.shipments.filter(
      (shipment) => shipment.toCityId === destination.id && shipment.status === "in_transit",
    ).length,
    1,
  );
});
