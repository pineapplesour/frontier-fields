import test from "node:test";
import assert from "node:assert/strict";
import {
  addUnit,
  createGame,
  economy,
  observe,
  resolveTurn,
  setCitizenSettings,
  setSettings,
  submitOrders,
  transact,
} from "../server/engine.mjs";
import { distance } from "../shared/rules.js";

function fixture({ supplyMode = "off" } = {}) {
  const g = createGame({
    mode: "duel",
    rulesVersion: "expansion-v1",
    seats: [
      { id: "p1", controller: "human" },
      { id: "p2", controller: "human" },
    ],
    now: 1_000,
  });
  g.phase = "planning";
  g.paused = false;
  g.activePlayer = "p1";
  g.supplyMode = supplyMode;
  g.cities = [];
  g.units = [];
  g.founded = { p1: true, p2: true };
  for (const tile of g.tiles)
    Object.assign(tile, {
      terrain: "plains",
      fertility: 2,
      owner: null,
      cityId: null,
      farm: false,
      developed: false,
      resource: null,
      ruin: null,
    });
  return g;
}

function city(g, id, q, r, population = 4) {
  const c = {
    id,
    owner: "p1",
    name: id,
    q,
    r,
    population,
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
    wallLevel: 0,
    capital: false,
    isolation: 0,
    supplied: true,
  };
  g.cities.push(c);
  const center = g.tiles.find((tile) => tile.q === q && tile.r === r);
  Object.assign(center, { owner: "p1", cityId: id });
  return c;
}

function ownedTile(g, q, r, c, extra = {}) {
  const tile = g.tiles.find((candidate) => candidate.q === q && candidate.r === r);
  Object.assign(tile, { owner: c.owner, cityId: c.id, ...extra });
  return tile;
}

function ownTurn(g, turn = g.turn) {
  g.activePlayer = "p1";
  g.turn = turn;
}

test("detailed supply separates city stock from fed-turn growth and preserves progress on shortage", () => {
  const g = fixture({ supplyMode: "on" });
  const c = city(g, "c1", 3, 3, 2);
  resolveTurn(g);
  assert.equal(c.population, 2);
  assert.equal(c.growthProgress, 1);
  assert.equal(c.food, 1);
  const progress = c.growthProgress;
  c.food = 50;
  ownTurn(g, 2);
  resolveTurn(g);
  assert.equal(c.population, 2);
  assert.equal(c.growthProgress, progress + 1);
  assert.ok(c.food > 1);

  // Civilian consumption above this besieged city's output makes it unfed.
  // The military eats separately from its own stock; no remote double debit.
  const guard = addUnit(g, "p1", "spearman", { q: c.q, r: c.r });
  c.population = 2;
  c.food = 0;
  c.growthProgress = 3;
  c.isolation = 5;
  ownTurn(g, 3);
  resolveTurn(g);
  assert.equal(c.population, 1);
  assert.equal(c.growthProgress, 3);
  assert.equal(c.food, 0);
  assert.equal(guard.mobilized, false);
});

test("supply-ON mobilization is a one-per-city-turn queue with delayed atomic cost", () => {
  const g = fixture({ supplyMode: "on" });
  const c = city(g, "c1", 3, 3, 4);
  c.food = 100;
  for (let i = 0; i < 6; i++)
    transact(g, "p1", {
      turn: g.turn,
      action: "mobilizeUnit",
      cityId: c.id,
      type: "spearman",
    });
  assert.equal(c.mobilizationQueue.length, 6);
  assert.equal(c.population, 4);
  assert.equal(g.stockpiles.p1.iron, 3);

  resolveTurn(g);
  assert.equal(g.units.filter((unit) => unit.owner === "p1").length, 1);
  assert.equal(c.mobilizationQueue.length, 5);
  assert.equal(c.population, 3.5);
  const deployed = g.units.find((unit) => unit.owner === "p1");
  assert.equal(deployed.manpowerCost, 0.5);
  assert.equal(deployed.mobilized, true);

  // Leave the city slot before the next city turn; only one more item can
  // dispatch even though five reservations remain.
  Object.assign(deployed, { q: 4, r: 3 });
  ownTurn(g, 2);
  resolveTurn(g);
  assert.equal(g.units.filter((unit) => unit.owner === "p1").length, 2);
  assert.equal(c.mobilizationQueue.length, 4);
  assert.equal(c.population, 3);
  assert.equal(c.mobilizationLastDispatchTurn, 2);

  const pending = c.mobilizationQueue[0].id;
  ownTurn(g, 2);
  transact(g, "p1", {
    turn: g.turn,
    action: "cancelMobilization",
    cityId: c.id,
    mobilizationId: pending,
  });
  assert.equal(c.mobilizationQueue.length, 3);
});

test("mobilization keeps civilian workers until dispatch and exact resource reservations", () => {
  const g = fixture({ supplyMode: "on" });
  // Keep the second seat alive without adding units to the recruitment assertions.
  const opponentCity = city(g, "opponent", 18, 0, 1);
  opponentCity.owner = "p2";
  // A reservation-shortage fixture, independent of the new-match allowance.
  g.stockpiles.p1.niter = 3;
  const c = city(g, "c1", 3, 3, 4);
  c.food = 100;
  transact(g, "p1", {
    turn: g.turn,
    action: "mobilizeUnit",
    cityId: c.id,
    type: "musketeer",
  });
  assert.equal(c.population, 4);
  assert.equal(economy(g, "p1").perCity[0].citizenBudget, 4);
  assert.equal(g.stockpiles.p1.niter, 3);
  assert.throws(
    () =>
      transact(g, "p1", {
        turn: g.turn,
        action: "mobilizeUnit",
        cityId: c.id,
        type: "musketeer",
      }),
    /초석/,
  );
  resolveTurn(g);
  assert.equal(g.stockpiles.p1.niter, 1);
  assert.equal(c.population, 3.5);
  assert.equal(c.mobilizationQueue.length, 0);
  assert.equal(g.units[0].recruitmentMode, "supply-on");

  const veteran = g.units[0];
  veteran.xp = 20;
  const before = c.population;
  transact(g, "p1", {
    turn: g.turn,
    action: "disbandUnit",
    unitId: veteran.id,
  });
  assert.equal(c.population, before + 0.5);
  assert.equal(veteran.xp, 0);
  assert.equal(g.units.length, 0);
});

test("a demobilized formation can retain a selected veteran slice while refunding only released manpower", () => {
  const g = fixture({ supplyMode: "on" });
  const c = city(g, "c1", 3, 3, 4);
  const formation = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, {
    size: 2,
    hp: 160,
    xp: 20,
    mobilized: true,
    recruitmentMode: "supply-on",
    manpowerCost: 1,
    manpowerSources: [{ cityId: c.id, owner: "p1", amount: 1 }],
    homeCityId: c.id,
  });
  const before = c.population;
  transact(g, "p1", {
    turn: g.turn,
    action: "disbandUnit",
    unitId: formation.id,
    retainVeteranCount: 1,
  });
  assert.equal(g.units.length, 1);
  assert.equal(g.units[0].size, 1);
  assert.equal(g.units[0].xp, 20);
  assert.equal(g.units[0].manpowerCost, 0.5);
  assert.equal(c.population, before + 0.5);
});

test("supply mode transitions are host-paused and one-time, without free stock/population", () => {
  const g = fixture({ supplyMode: "off" });
  const c = city(g, "c1", 3, 3, 2);
  assert.equal(economy(g, "p1").foodStock, null);
  assert.throws(
    () =>
      transact(g, "p1", {
        turn: g.turn,
        action: "sell",
        cityId: c.id,
        resource: "food",
        amount: 1,
      }),
    /비축|성장/,
  );
  c.food = 7;
  g.paused = true;
  assert.throws(
    () => setSettings(g, "p1", { supplyMode: "on", turnSeconds: 9 }),
    /10~300/,
  );
  assert.equal(g.supplyMode, "off");
  assert.equal(c.food, 7);
  setSettings(g, "p1", { supplyMode: "on" });
  assert.equal(c.food, 0);
  assert.equal(c.growthProgress, 7);
  c.food = 5;
  g.paused = false;
  assert.throws(
    () => setSettings(g, "p1", { supplyMode: "off" }),
    /일시정지 중/,
  );
  g.paused = true;
  c.mobilizationQueue = [
    {
      id: "pending-toggle",
      type: "spearman",
      requestedTurn: g.turn,
      status: "pending",
    },
  ];
  setSettings(g, "p1", { supplyMode: "off" });
  assert.equal(c.food, 7); // Physical stock must never become free fed turns.
  assert.equal(c.suspendedFoodStock, 5);
  assert.equal(c.growthProgress, 0);
  assert.equal(c.mobilizationQueue.length, 0);
  setSettings(g, "p1", { supplyMode: "off" });
  assert.equal(c.food, 7);
});

test("citizen locks boost existing facility yields without double assigning workers", () => {
  const g = fixture({ supplyMode: "off" });
  const c = city(g, "c1", 3, 3, 1);
  ownedTile(g, 4, 3, c, { farm: true, fertility: 2 });
  const mine = ownedTile(g, 2, 3, c, {
    terrain: "hills",
    resource: "iron",
    developed: true,
  });
  let info = economy(g, "p1").perCity[0];
  assert.equal(info.citizenBudget, 1);
  assert.equal(info.citizensAssigned, 1);
  assert.equal(info.citizenBoosts.food + info.citizenBoosts.resources.iron, 1);
  const resourceSlot = `resource:${mine.q},${mine.r}`;
  setCitizenSettings(g, "p1", {
    turn: g.turn,
    cityId: c.id,
    auto: true,
    lockedSlots: [resourceSlot],
  });
  info = economy(g, "p1").perCity[0];
  assert.deepEqual(info.citizenAllocation.locked, [resourceSlot]);
  assert.equal(info.citizenBoosts.resources.iron, 1);
  assert.equal(info.citizenBoosts.food, 0);
  assert.equal(economy(g, "p1").income.iron, 2); // base facility + one worker.
});

test("city food and facilities follow explicit cityId, and reassignment preserves connected radius-three land", () => {
  const g = fixture({ supplyMode: "off" });
  const first = city(g, "c1", 3, 3, 3);
  const second = city(g, "c2", 7, 3, 3);
  ownedTile(g, 4, 3, first, { farm: true, fertility: 1 });
  const bridge = ownedTile(g, 5, 3, first, { farm: true, fertility: 1 });
  ownedTile(g, 6, 3, second, { farm: true, fertility: 1 });
  ownedTile(g, 6, 2, second, {
    terrain: "hills",
    resource: "iron",
    developed: true,
  });
  assert.equal(economy(g, "p1").perCity.find((x) => x.id === first.id).farms, 2);
  assert.equal(
    economy(g, "p1").perCity.find((x) => x.id === first.id).foodGross,
    12,
  );
  assert.equal(economy(g, "p1").perCity.find((x) => x.id === second.id).farms, 1);
  assert.equal(
    economy(g, "p1")
      .perCity.find((x) => x.id === first.id)
      .citizenAllocation.slots.filter((slot) => slot.q === 6 && slot.r === 3)
      .length,
    0,
  );
  // The inner tile is a bridge for the still-unmoved outer tile; cutting it
  // first would create an enclave and is rejected atomically.
  assert.throws(
    () =>
      transact(g, "p1", {
        turn: g.turn,
        action: "reassignTile",
        target: { q: 4, r: 3 },
        toCityId: second.id,
      }),
    /끊겨|연결/,
  );
  transact(g, "p1", {
    turn: g.turn,
    action: "reassignTile",
    target: { q: bridge.q, r: bridge.r },
    toCityId: second.id,
  });
  assert.equal(bridge.cityId, second.id);
  assert.equal(
    economy(g, "p1").perCity.find((x) => x.id === first.id).farms,
    1,
  );
  assert.equal(
    economy(g, "p1").perCity.find((x) => x.id === second.id).farms,
    2,
  );
  assert.equal(
    economy(g, "p1").perCity.find((x) => x.id === first.id).resourceIncome.iron,
    0,
  );
  assert.ok(
    economy(g, "p1").perCity.find((x) => x.id === second.id).resourceIncome.iron >=
      1,
  );
  assert.ok(distance(bridge, second) <= 3);
});

test("city food starvation is local and does not cancel a fed sibling city's growth", () => {
  const g = fixture({ supplyMode: "on" });
  const fed = city(g, "fed", 3, 3, 2);
  const hungry = city(g, "hungry", 10, 3, 2);
  ownedTile(g, 4, 3, fed, { farm: true, fertility: 2 });
  hungry.isolation = 5;
  fed.food = 0;
  hungry.food = 0;
  assert.equal(
    economy(g, "p1").perCity.find((x) => x.id === hungry.id).fed,
    false,
  );
  ownTurn(g, 1);
  resolveTurn(g);
  assert.equal(fed.growthProgress, 1);
  assert.equal(fed.population, 2);
  assert.equal(hungry.growthProgress, 0);
  assert.equal(hungry.population, 1);
  assert.equal(hungry.starvationTurns, 1);
  assert.equal(economy(g, "p1").perCity.find((x) => x.id === fed.id).fed, true);
});

test("scorch and plunder create repairable ruins, give one capped reward, and heal exactly fifty", () => {
  const g = fixture({ supplyMode: "on" });
  const c = city(g, "c1", 3, 3, 4);
  c.food = 0;
  const farm = ownedTile(g, 4, 3, c, { farm: true, fertility: 2 });
  const fighter = addUnit(g, "p1", "spearman", farm, { hp: 40 });
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: fighter.id, action: "scorch" }],
  });
  assert.equal(farm.farm, false);
  assert.equal(farm.ruin.kind, "farm");
  assert.equal(c.food, 0, "Scorch food remains physical cargo until arrival");
  assert.equal(g.logistics.shipments.find(s => s.mode === "scorch-loot").amount, 3);
  assert.equal(fighter.hp, 90);
  const builder = addUnit(g, "p1", "builder", farm);
  ownTurn(g);
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: builder.id, action: "repair" }],
  });
  assert.equal(farm.farm, true);
  assert.equal(farm.ruin, undefined);
  assert.throws(
    () =>
      submitOrders(g, "p1", {
        turn: g.turn,
        orders: [{ unitId: fighter.id, action: "scorch" }],
      }),
    /행동|완성|이미 약탈/,
  );

  const resource = ownedTile(g, 2, 3, c, {
    terrain: "hills",
    resource: "iron",
    developed: true,
  });
  const resourceUnit = addUnit(g, "p1", "spearman", resource, { hp: 20 });
  ownTurn(g, g.turn + 1);
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: resourceUnit.id, action: "scorch" }],
  });
  assert.equal(resource.developed, false);
  assert.equal(resource.ruin.kind, "resource");
  assert.equal(g.stockpiles.p1.iron, 3, "Resource loot is not spendable until delivered");
  assert.equal(g.logistics.shipments.find(s => s.resource === "iron").amount, 1);
  assert.equal(resourceUnit.hp, 70);
  assert.throws(
    () =>
      submitOrders(g, "p1", {
        turn: g.turn,
        orders: [{ unitId: resourceUnit.id, action: "scorch" }],
      }),
    /행동|완성|이미 약탈/,
  );
  const resourceBuilder = addUnit(g, "p1", "builder", resource);
  ownTurn(g, g.turn + 1);
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: resourceBuilder.id, action: "repair" }],
  });
  assert.equal(resource.developed, true);
  assert.equal(resource.ruin, undefined);
  assert.ok(economy(g, "p1").income.iron >= 1);
});

test("neutral facilities cannot be plundered", () => {
  const g = fixture({ supplyMode: "on" });
  const c = city(g, "c1", 3, 3, 2);
  const farm = ownedTile(g, 4, 3, c, { farm: true });
  farm.owner = "p2";
  farm.cityId = null;
  const unit = addUnit(g, "p1", "spearman", farm, { hp: 30 });
  assert.throws(
    () =>
      submitOrders(g, "p1", {
        turn: g.turn,
        orders: [{ unitId: unit.id, action: "pillage" }],
      }),
    /전쟁/,
  );
});

test("war-only pillage rewards the attacker and leaves the defender's ruined facility without passive income", () => {
  const g = fixture({ supplyMode: "on" });
  const home = city(g, "c1", 3, 3, 3);
  const enemy = {
    id: "enemy-city",
    owner: "p2",
    name: "enemy",
    q: 8,
    r: 3,
    population: 3,
    food: 0,
    growthProgress: 0,
    citizenPolicy: { auto: true, lockedSlots: [], priority: [] },
    mobilizationQueue: [],
    production: 0,
    queue: null,
    hp: 160,
    wallLevel: 0,
    capital: false,
    isolation: 0,
    supplied: true,
  };
  g.cities.push(enemy);
  const farm = g.tiles.find((tile) => tile.q === 4 && tile.r === 3);
  Object.assign(farm, { owner: "p2", cityId: enemy.id, farm: true, fertility: 2 });
  const unit = addUnit(g, "p1", "spearman", farm, { hp: 40 });
  g.wars = ["p1|p2"];
  const beforeFood = home.food;
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: unit.id, action: "pillage" }],
  });
  assert.equal(farm.ruin.mode, "pillage");
  assert.equal(home.food, beforeFood, "Pillage creates physical return cargo, not a remote city credit");
  assert.equal(g.logistics.shipments.find(s => s.mode === "pillage-loot").amount, 3);
  assert.equal(unit.hp, 90);
  assert.equal(economy(g, "p2").perCity[0].farms, 0);
});

test("attacks never spend niter and existing units fire despite saved upkeep shortfall", () => {
  for (const supplyMode of ["off", "on", "legacy"]) {
  const g = fixture({ supplyMode });
  if (supplyMode === "legacy") { delete g.rulesVersion; g.supplyMode = "off"; }
  city(g, "c1", 3, 3, 2);
  g.wars = ["p1|p2"];
  const target = addUnit(g, "p2", "spearman", { q: 5, r: 3 });
  const artillery = addUnit(g, "p1", "artillery", { q: 3, r: 3 });
  g.stockpiles.p1.niter = 1;
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: artillery.id, action: "bombard", target }],
  });
  assert.equal(g.stockpiles.p1.niter, 1);
  assert.equal(artillery.attackUsed, true);
  assert.throws(
    () =>
      submitOrders(g, "p1", {
        turn: g.turn,
        orders: [{ unitId: artillery.id, action: "bombard", target }],
      }),
    /행동/,
  );

  const second = addUnit(g, "p1", "artillery", { q: 3, r: 4 });
  const secondTarget = addUnit(g, "p2", "spearman", { q: 5, r: 4 });
  g.stockpiles.p1.niter = 0;
  second.ammoShortfall = 1;
  second.upkeepShortfallTurn = g.turn;
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: second.id, action: "bombard", target: secondTarget }],
  });
  assert.equal(g.stockpiles.p1.niter, 0);
  assert.equal(second.attackUsed, true);
  }
});

test("legacy non-supply game charges idle powder upkeep and keeps new-production costs", () => {
  const g = fixture(); delete g.rulesVersion;
  const c = city(g, "legacy", 3, 3, 4);
  addUnit(g, "p1", "musketeer", { q: 4, r: 3 });
  g.stockpiles.p1.niter = 0;
  assert.throws(() => submitOrders(g, "p1", { turn: g.turn,
    production: [{ cityId: c.id, type: "musketeer" }] }), /초석/);
  g.stockpiles.p1.niter = 8;
  assert.equal(economy(g, "p1").resourceUpkeep.niter, 1);
  resolveTurn(g);
  assert.ok(g.stockpiles.p1.niter < 8, "idle presence consumes niter");
});

test("new powder units still require construction resources", () => {
  const g = fixture({ supplyMode: "off" });
  const c = city(g, "new-production", 3, 3, 4);
  g.gold.p1 = 10000;
  g.stockpiles.p1.niter = 0;
  const purchase = { turn: g.turn, action: "buyUnit", cityId: c.id, type: "musketeer" };
  assert.throws(() => transact(g, "p1", purchase), /초석/);
  assert.equal(g.units.length, 0);
  g.stockpiles.p1.niter = 2;
  transact(g, "p1", purchase);
  assert.equal(g.stockpiles.p1.niter, 0);
  assert.equal(g.units.filter(u => u.type === "musketeer").length, 1);
});
