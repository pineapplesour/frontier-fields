import { TYPES, equal } from "../shared/rules.js";
import test from "node:test";
import assert from "node:assert/strict";
import { addUnit, createGame, economy, observe, resolveTurn, setSettings, submitOrders, transact } from "../server/engine.mjs";
import { ensureAmmunition, settleAmmunitionUpkeep } from "../server/upkeep.mjs";
import { productionLogisticsOptions } from "../src/logisticsHelpers.js";

// Synthetic QA fixtures only. No running match, player observation or save is loaded.
function setup(mode = "on") {
  const g = createGame({ mode: "duel", rulesVersion: "expansion-v1", seats: [
    { id: "p1", controller: "human" }, { id: "p2", controller: "human" },
  ], now: 1000 });
  Object.assign(g, { phase: "planning", paused: false, activePlayer: "p1", supplyMode: mode, units: [], cities: [], rivers: [], wars: [], founded: { p1: true, p2: true } });
  for (const t of g.tiles) Object.assign(t, { terrain: "plains", fertility: 2, owner: null, cityId: null, farm: false, developed: false, resource: null, fort: null, ruin: null });
  const city = (id, owner, q, population) => {
    const c = { id, name: id, owner, q, r: 3, population, food: 100, growthProgress: 0, starvationTurns: 0, production: 0, queue: null, hp: 160, wallLevel: 0, wallHp: 0, capital: true, isolation: 0, supplied: true, citizenPolicy: { auto: true, lockedSlots: [], priority: [] }, mobilizationQueue: [], mobilizationLastDispatchTurn: null };
    g.cities.push(c);
    Object.assign(g.tiles.find(t => t.q === q && t.r === 3), { owner, cityId: id });
    return c;
  };
  const c = city("qa-city", "p1", 3, 4);
  city("qa-other", "p2", 14, 1);
  Object.assign(g.tiles.find(t => t.q === 4 && t.r === 3), { owner: "p1", cityId: c.id, farm: true, fertility: 20 });
  return { g, c };
}

test("USER: reserving three population deploys all six units over six city turns", () => {
  const { g, c } = setup();
  for (let i = 0; i < 6; i++) transact(g, "p1", { turn: g.turn, action: "mobilizeUnit", cityId: c.id, type: "spearman" });
  const counts = [];
  for (let turn = 1; turn <= 6; turn++) {
    Object.assign(g, { activePlayer: "p1", turn });
    for (const [i, u] of g.units.filter(unit => unit.type === "spearman").entries()) Object.assign(u, { q: 6 + i, r: 4 });
    resolveTurn(g);
    counts.push(g.units.filter(u => u.owner === "p1" && u.type === "spearman").length);
  }
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6], JSON.stringify({ counts, pending: c.mobilizationQueue, population: c.population, economy: economy(g, "p1").capacity }));
});

test("USER: musketeer and artillery pay one niter per turn even when not attacking", () => {
  const { g, c } = setup();
  addUnit(g, "p1", "musketeer", { q: 3, r: 4 }, { homeCityId: c.id });
  addUnit(g, "p1", "artillery", { q: 4, r: 4 }, { homeCityId: c.id });
  g.stockpiles.p1.niter = 10;
  resolveTurn(g);
  assert.equal(g.stockpiles.p1.niter, 8, "Idle garrison upkeep must not become per-attack ammunition only");
});

test("MODE: toggling ON to OFF to ON cannot turn food stock into free fed turns", () => {
  const { g, c } = setup();
  c.food = 10;
  c.growthProgress = 3;
  g.paused = true;
  setSettings(g, "p1", { supplyMode: "off" }, 1001);
  setSettings(g, "p1", { supplyMode: "on" }, 1002);
  assert.equal(c.growthProgress, 3, "No actual fed turn elapsed during the round trip");
  assert.equal(c.food, 10, "Inactive physical inventory resumes without becoming growth");
});

test("COMBAT: blocked automatic musketeer engagement preserves its attack opportunity", () => {
  const { g } = setup("off");
  g.wars = ["p1|p2"];
  g.activePlayer = "p2";
  const shooter = addUnit(g, "p1", "musketeer", { q: 3, r: 3 });
  const target = addUnit(g, "p2", "spearman", { q: 5, r: 3 });
  const before = target.hp;
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: shooter.id, action: "move", target: { q: 5, r: 3 }, path: [{ q: 4, r: 3 }, { q: 5, r: 3 }] }] });
  // A friendly screen occupies the route after it was legally queued.
  addUnit(g, "p1", "spearman", { q: 4, r: 3 });
  resolveTurn(g);
  assert.equal(shooter.attackUsed, false);
  assert.equal(shooter.movesLeft, TYPES.musketeer.movement);
  assert.equal(target.hp, before);
});

test("COMBAT: a wall-less city still shields its garrison and incoming fire interrupts city repair", () => {
  const { g } = setup("off");
  g.turn = 8;
  g.wars = ["p1|p2"];
  const enemyCity = g.cities.find(c => c.owner === "p2");
  Object.assign(enemyCity, { q: 5, wallLevel: 1, wallHp: 0, queue: "wallRepair", production: 3, wallRepairStartedTurn: 7, wallRepairStartHp: 0, lastIncomingAttackTurn: null });
  const attacker = addUnit(g, "p1", "musketeer", { q: 3, r: 3 });
  const garrison = addUnit(g, "p2", "spearman", { q: 5, r: 3 });
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: attacker.id, action: "attack", target: { q: 5, r: 3 } }] });
  assert.equal(garrison.hp, 100, "Garrison is protected until city fall, not only wall break");
  assert.equal(enemyCity.lastIncomingAttackTurn, 8);
  assert.equal(enemyCity.queue, null);
  assert.ok(enemyCity.hp < 160, "Incoming fire damages the un-walled city body");
});

test("OFF: UI observation exposes surplus growth but no physical food stock", () => {
  const { g, c } = setup("off");
  const shown = observe(g, "p1").cities.find(city => city.id === c.id);
  assert.equal(shown.foodStock, null);
  assert.equal(shown.growthProgressUnit, "food-surplus");
  assert.equal(shown.foodNet, shown.foodGross - c.population);
  const stockBefore = c.food, goldBefore = g.gold.p1;
  for (const action of ["buy", "sell"])
    assert.throws(() => transact(g, "p1", { turn: g.turn, action, resource: "food", cityId: c.id }), /상세 보급 ON/);
  assert.equal(c.food, stockBefore);
  assert.equal(g.gold.p1, goldBefore);
});

test("COMPATIBILITY: paused host upgrades existing rules without relocating or replacing the match", () => {
  const g = createGame({ mode: "duel", now: 1000 });
  Object.assign(g, { phase: "planning", paused: true, turn: 12 });
  const coordinates = () => ({
    cities: g.cities.map(({ id, owner, q, r, population }) => ({ id, owner, q, r, population })),
    units: g.units.map(({ id, owner, q, r, hp, xp }) => ({ id, owner, q, r, hp, xp })),
    tiles: structuredClone(g.tiles), players: structuredClone(g.players),
  });
  const before = coordinates();
  assert.throws(() => setSettings(g, "p2", { upgradeRules: true }), /방장/);
  assert.throws(() => setSettings(g, "p1", { upgradeRules: true, turnSeconds: -1 }), /10~300/);
  assert.equal(g.rulesVersion, "legacy", "Invalid combined settings must be atomic");
  setSettings(g, "p1", { upgradeRules: true });
  assert.equal(g.rulesVersion, "expansion-v1");
  assert.deepEqual(coordinates(), before);
  assert.equal(g.turn, 12);
  assert.deepEqual(g.turnOrder, ["p1", "p2", "p3", "p4"]);
  const revision = g.revision;
  setSettings(g, "p1", { upgradeRules: true });
  assert.deepEqual(coordinates(), before);
  assert.equal(g.revision, revision + 1);
});

test("MULTIPLAYER: alternating human/NPC slots settle each NPC once and include non-seat factions", () => {
  const g = createGame({ mode: "duel", rulesVersion: "expansion-v1", seats: [
    { id: "p1", controller: "human" }, { id: "p2", controller: "npc" },
    { id: "p3", controller: "human" }, { id: "p4", controller: "npc" },
  ], now: 1000 });
  Object.assign(g, { phase: "planning", paused: false, units: [], cities: [], wars: [], rivers: [] });
  addUnit(g, "p1", "builder", {q:0,r:0});
  addUnit(g, "p3", "builder", {q:19,r:0});
  for (const tile of g.tiles) Object.assign(tile, { terrain: "plains", owner: null, cityId: null, farm: false, developed: false, fort: null });
  for (const [owner, q] of [["p2", 3], ["p4", 14]]) {
    const c = { id: `${owner}-city`, owner, q, r: 3, name: owner, population: 1, food: 0, production: 0, queue: null, hp: 160, isolation: 0, wallLevel: 0 };
    g.cities.push(c);
    Object.assign(g.tiles.find(t => t.q === q && t.r === 3), { owner, cityId: c.id });
  }
  resolveTurn(g, 1001);
  assert.equal(g.activePlayer, "p3");
  assert.deepEqual(g.lastNpcTurns.factions, ["p2"]);
  const p2Food = g.cities.find(c => c.owner === "p2").food;
  assert.ok(p2Food > 0);
  assert.equal(g.cities.find(c => c.owner === "p4").food, 0);
  resolveTurn(g, 1002);
  assert.equal(g.activePlayer, "p1");
  assert.equal(g.turn, 2);
  assert.equal(g.cities.find(c => c.owner === "p2").food, p2Food, "p2 must not get a duplicate city settlement");
  assert.ok(g.cities.find(c => c.owner === "p4").food > 0);
  assert.deepEqual(g.lastNpcTurns.factions, ["p2", "p4", "cs", "barb"]);
});

test("PRODUCTION: wall repair is a building project, not military mobilization or population cost", () => {
  const { g, c } = setup("on");
  Object.assign(c, { population: 1, wallLevel: 1, wallHp: 0, lastIncomingAttackTurn: null });
  submitOrders(g, "p1", { turn: g.turn, production: [{ cityId: c.id, type: "wallRepair" }] });
  assert.equal(c.queue, "wallRepair");
  assert.equal(c.population, 1);
  assert.equal(c.manpowerReserved ?? 0, 0);
  resolveTurn(g);
  assert.ok(c.wallHp > 0);
});

test("STRUCTURE: off-center encampment is city production and its walls shield its garrison", () => {
  const { g, c } = setup("off");
  const target = g.tiles.find(t => t.q === 4 && t.r === 3);
  target.farm = false;
  submitOrders(g, "p1", { turn: g.turn, production: [{ cityId: c.id, type: "encampment", target: { q: target.q, r: target.r } }] });
  assert.equal(c.population, 4, "Buildings never draft citizens");
  assert.equal(g.stockpiles.p1.iron, 1);
  assert.equal(target.encampment, undefined);
  c.production = 49;
  resolveTurn(g);
  assert.equal(target.encampment.hp, 80);
  assert.equal(target.encampment.wallHp, 50);
  assert.equal(c.queue, null);
  assert.equal(c.lastProduction.type, "encampment");
  const guard = addUnit(g, "p1", "spearman", target);
  const gun = addUnit(g, "p2", "artillery", { q: 5, r: 3 });
  g.wars = ["p1|p2"];
  submitOrders(g, "p2", { turn: g.turn, orders: [{ unitId: gun.id, action: "bombard", target: { q: target.q, r: target.r } }] });
  assert.ok(target.encampment.wallHp < 50);
  assert.equal(guard.hp, 100);
});

test("STRUCTURE: destroyed fort remains on map, changes owner on entry, and builders repair its body", () => {
  const { g } = setup("off");
  g.wars = ["p1|p2"];
  const target = g.tiles.find(t => t.q === 4 && t.r === 3);
  Object.assign(target, { owner: "p2", farm: false, fort: { kind: "fort", owner: "p2", hp: 1, maxHp: 80 } });
  const attacker = addUnit(g, "p1", "spearman", { q: 3, r: 3 });
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: attacker.id, action: "move", target: { q: 4, r: 3 } }] });
  assert.equal(target.fort.hp, 0);
  assert.equal(target.fort.owner, "p2", "Bombing is not remote ownership transfer");
  assert.equal(attacker.q, 3);
  Object.assign(attacker, { movesLeft: 2, attackUsed: false });
  g.turn++;
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: attacker.id, action: "move", target: { q: 4, r: 3 } }] });
  assert.equal(target.fort.owner, "p1");
  assert.equal(target.fort.captured, true);
  assert.equal(target.fort.hp, 0);
  const builder = addUnit(g, "p1", "builder", target);
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: builder.id, action: "repairStructure" }] });
  assert.equal(target.fort.hp, 40);
  assert.equal(builder.charges, 2);
  assert.equal(builder.movesLeft, 0);
});

test("STRUCTURE: city production repairs its off-center walls gradually and incoming attacks stop the project", () => {
  const { g, c } = setup("off");
  const tile = g.tiles.find(t => t.q === 4 && t.r === 3);
  tile.encampment = { kind: "encampment", owner: "p1", hp: 80, maxHp: 80, wallHp: 0, wallMaxHp: 50, lastIncomingAttackTurn: 1 };
  const order = { production: [{ cityId: c.id, type: "wallRepair", target: { q: 4, r: 3 } }] };
  g.turn = 5;
  assert.throws(() => submitOrders(g, "p1", { turn: g.turn, ...order }), /5턴/);
  g.turn = 6;
  const beforePop = c.population;
  submitOrders(g, "p1", { turn: g.turn, ...order });
  assert.equal(c.population, beforePop, "Repair projects do not reserve population");
  resolveTurn(g);
  assert.ok(tile.encampment.wallHp > 0 && tile.encampment.wallHp < 50);
  assert.equal(c.wallHp, 0, "Targeted project must not repair unrelated city walls");
  const gun = addUnit(g, "p2", "artillery", { q: 5, r: 3 });
  g.wars = ["p1|p2"];
  submitOrders(g, "p2", { turn: g.turn, orders: [{ unitId: gun.id, action: "bombard", target: { q: 4, r: 3 } }] });
  resolveTurn(g);
  resolveTurn(g);
  assert.equal(c.queue, null);
  assert.equal(c.productionTarget, null);
});

test("CAPTURE: a lethal adjacent attack enters the city, destroys military and captures its builder", () => {
  const { g } = setup("off");
  g.wars = ["p1|p2"];
  const c = g.cities.find(city => city.owner === "p2");
  Object.assign(c, { q: 4, hp: 1, wallHp: 0 });
  const guard = addUnit(g, "p2", "spearman", c);
  const builder = addUnit(g, "p2", "builder", c);
  const attacker = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, { movesLeft: 0 });
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: attacker.id, action: "attack", target: { q: 4, r: 3 } }] });
  assert.equal(c.owner, "p1");
  assert.equal(attacker.q, 4);
  assert.equal(attacker.movesLeft, 0);
  assert.equal(g.units.some(u => u.id === guard.id), false);
  assert.equal(builder.owner, "p1");
});

test("LOGISTICS: merged units conserve personal food and pay only the missing base-unit upkeep", () => {
  const { g } = setup("on");
  const receiver = addUnit(g, "p1", "musketeer", { q: 6, r: 3 }, { foodStock: 3 });
  const donor = addUnit(g, "p1", "musketeer", { q: 7, r: 3 }, { foodStock: 2 });
  g.stockpiles.p1.niter = 10;
  settleAmmunitionUpkeep(g, "p1", { units: [receiver] });
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: donor.id, action: "merge", targetId: receiver.id }] });
  assert.equal(receiver.size, 2);
  assert.equal(receiver.foodStock, 5);
  assert.equal(receiver.upkeepPaidAmount, 1);
  assert.equal(g.stockpiles.p1.niter, 9);
  resolveTurn(g);
  assert.equal(g.stockpiles.p1.niter, 8);
});

test("LOGISTICS: actual adjacent combat captures convoy cargo instead of granting free inventory", () => {
  const { g, c } = setup("on");
  // Seven hexes away so a four-point convoy is still on the road next turn.
  const destination = { ...c, id: "qa-depot", name: "qa-depot", q: 10, food: 0, foodTargetReserve: 0, targetReserve: 0 };
  g.cities.push(destination);
  Object.assign(g.tiles.find(t => t.q === 10 && t.r === 3), { owner: "p1", cityId: destination.id });
  c.foodTargetReserve = 100;
  transact(g, "p1", { action: "shipFood", turn: g.turn, recipient: "p1", fromCityId: c.id, toCityId: destination.id, amount: 8 });
  const shipment = g.logistics.shipments.find(s => s.kind === "food");
  resolveTurn(g);
  const convoy = g.units.find(u => u.id === shipment.carrierId);
  assert.ok(convoy && convoy.q !== c.q, "Shipment must have a real moving actor");
  const captor = addUnit(g, "p2", "spearman", { q: convoy.q, r: convoy.r + 1 });
  const stockBefore = g.cities.find(city => city.owner === "p2").food;
  g.wars = ["p1|p2"];
  submitOrders(g, "p2", { turn: g.turn, orders: [{ unitId: captor.id, action: "attack", target: { q: convoy.q, r: convoy.r } }] });
  assert.equal(shipment.status, "captured");
  assert.equal(captor.cargo[0].amount, 8);
  assert.equal(g.cities.find(city => city.owner === "p2").food, stockBefore);
  assert.ok(!g.units.some(u => u.id === convoy.id));
  assert.equal(captor.movesLeft, 3);
  assert.equal(captor.attackUsed, false);
  assert.ok(equal(captor, convoy));
});

test("DIPLOMACY: full public relationship matrix exposes labels without private scores", () => {
  const { g } = setup("off");
  g.wars = ["p1|p2"];
  g.relations["cs|p1"] = 31;
  const shown = observe(g, "p1");
  assert.equal(shown.publicRelations.p2.p1, "war");
  assert.equal(shown.publicRelations.cs.p1, "good");
  assert.equal(shown.publicRelations.p1.barb, "war");
  assert.equal(shown.relations, undefined);
  assert.equal(shown.publicRelations.p2.p2, "self");
});

test("MERCHANT: post is one city building, merchant reserves population and occupies its quota", () => {
  const { g, c } = setup("off");
  const before = observe(g, "p1");
  assert.deepEqual(productionLogisticsOptions(before, before.cities.find(city => city.id === c.id)).map(([type]) => type), ["tradingPost", "encampment"]);
  c.food = 0;
  submitOrders(g, "p1", { turn: g.turn, production: [{ cityId: c.id, type: "tradingPost" }] });
  assert.equal(c.population, 4);
  c.production = 29;
  resolveTurn(g);
  assert.ok(c.tradingPost);
  const afterPost = observe(g, "p1");
  assert.deepEqual(productionLogisticsOptions(afterPost, afterPost.cities.find(city => city.id === c.id)).map(([type]) => type), ["encampment", "merchant"]);
  g.activePlayer = "p1";
  assert.throws(() => submitOrders(g, "p1", { turn: g.turn, production: [{ cityId: c.id, type: "tradingPost" }] }), /하나/);
  const beforePop = c.population;
  submitOrders(g, "p1", { turn: g.turn, production: [{ cityId: c.id, type: "merchant" }] });
  assert.equal(c.population, beforePop - 0.5);
  assert.equal(observe(g, "p1").cities.find(city => city.id === c.id).merchantCapacity.ordered, 1);
  c.production = 23;
  resolveTurn(g);
  const merchant = g.units.find(unit => unit.type === "merchant");
  assert.ok(merchant);
  assert.equal(merchant.q, c.q);
  assert.equal(merchant.r, c.r);
  assert.equal(merchant.manpowerCost, 0.5);
  g.activePlayer = "p1";
  assert.throws(() => submitOrders(g, "p1", { turn: g.turn, production: [{ cityId: c.id, type: "merchant" }] }), /한 명/);
});
