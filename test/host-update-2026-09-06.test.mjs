import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  submitOrders,
  transact,
  observe,
  resolveTurn,
  setSettings,
  startGame,
} from "../server/engine.mjs";
import {
  TYPES,
  BALANCE_DEFAULTS,
  normalizeBalance,
  cityCounterAttack,
  distance,
  neighbors,
  equal,
  key,
} from "../shared/rules.js";
import { combatPreview, cityCounterRange, hexLine } from "../shared/combat.js";

// Host-requested rule update of 2026-09-06: flat map, 4/10 movement, city
// return fire, prepaid niter, adjacent production spawn, host balance
// settings and an experiment practice with instant spawning.

function flat(mode = "practice", extra = {}) {
  const g = createGame({ mode, ...extra });
  g.units = [];
  g.wars = ["p1|p2"];
  g.rivers = [];
  g.explored = {};
  for (const t of g.tiles) {
    t.terrain = "plains";
    t.owner = null;
    t.farm = false;
    t.developed = false;
    t.resource = null;
    t.fertility = 2;
    t.cityId = null;
  }
  g.random = () => 0.5;
  return g;
}

test("movement points: infantry and civilians move four, cavalry ten", () => {
  assert.equal(TYPES.spearman.movement, 4);
  assert.equal(TYPES.musketeer.movement, 4);
  assert.equal(TYPES.artillery.movement, 4);
  assert.equal(TYPES.builder.movement, 4);
  assert.equal(TYPES.settler.movement, 4);
  assert.equal(TYPES.cavalry.movement, 10);
  const g = flat();
  const c = addUnit(g, "p1", "cavalry", { q: 2, r: 8 });
  submitOrders(g, "p1", {
    turn: 1,
    orders: [{ unitId: c.id, action: "move", target: { q: 12, r: 8 } }],
  });
  assert.ok(equal(c, { q: 12, r: 8 }), "cavalry crosses ten plains tiles in one turn");
  assert.equal(c.movesLeft, 0);
});

test("flat map: no wrap in neighbors, distance, line of fire or observation", () => {
  const west = { q: 0, r: 8 }, east = { q: 19, r: -1 };
  assert.equal(distance(west, east), 19);
  assert.ok(neighbors(west).every((p) => p.q !== 19));
  assert.equal(hexLine(west, { q: 2, r: 8 }).length, 3);
  assert.ok(hexLine(west, { q: 2, r: 8 }).every((p) => p.q >= 0 && p.q <= 2));
  const g = flat();
  assert.equal(observe(g, "p1").world.wrapX, false);
});

test("city return fire scales with population and honours host balance values", () => {
  const g = flat();
  const city = g.cities.find((c) => c.owner === "p2");
  Object.assign(city, { q: 6, r: 4, population: 4, hp: 160, wallLevel: 0, wallHp: 0 });
  Object.assign(g.tiles.find((t) => equal(t, city)), { owner: "p2", cityId: city.id });
  const attacker = addUnit(g, "p1", "spearman", { q: 5, r: 4 });
  assert.equal(cityCounterAttack(city, g), BALANCE_DEFAULTS.cityBaseAttack + 4 * BALANCE_DEFAULTS.cityAttackPerPop);
  const preview = combatPreview(observe(g, "p1"), attacker, { ...city, hostile: true });
  assert.deepEqual(preview.received, cityCounterRange(city, g).map((n) => Math.min(attacker.hp, n)));
  assert.ok(preview.reasons.some((r) => r.includes("도시 수비 반격")));
  const before = attacker.hp;
  submitOrders(g, "p1", {
    turn: 1,
    orders: [{ unitId: attacker.id, action: "attack", target: { q: city.q, r: city.r } }],
  });
  assert.ok(city.hp < 160, "the city still takes the attack");
  assert.equal(before - attacker.hp, Math.round((20 + 12) * 1.0), "return fire at the deterministic mid roll");
  // Artillery keeps its stand-off immunity.
  const gun = addUnit(g, "p1", "artillery", { q: 4, r: 4 });
  const gunHp = gun.hp;
  submitOrders(g, "p1", {
    turn: 1,
    orders: [{ unitId: gun.id, action: "bombard", target: { q: city.q, r: city.r } }],
  });
  assert.equal(gun.hp, gunHp);
  // Host balance: a city with no return fire and a doubled melee counter.
  setSettings(g, "p1", { balance: { cityBaseAttack: 0, cityAttackPerPop: 0, counterMultiplier: 2, unitAttack: { spearman: 50 } } });
  const shown = observe(g, "p1").balance;
  assert.equal(shown.cityBaseAttack, 0);
  assert.equal(shown.counterMultiplier, 2);
  assert.equal(shown.unitAttack.spearman, 50);
  assert.equal(shown.unitAttack.cavalry, TYPES.cavalry.attack, "unspecified values keep their defaults");
  const fresh = addUnit(g, "p1", "spearman", { q: 7, r: 4 });
  const freshHp = fresh.hp;
  g.turn = 2;
  submitOrders(g, "p1", {
    turn: 2,
    orders: [{ unitId: fresh.id, action: "attack", target: { q: city.q, r: city.r } }],
  });
  assert.equal(fresh.hp, freshHp, "zero return fire once the host disables it");
  assert.throws(() => setSettings(g, "p2", { balance: { cityBaseAttack: 5 } }), /방장/);
  assert.deepEqual(normalizeBalance({ counterMultiplier: 99, unitAttack: { spearman: -3 } }), {
    ...normalizeBalance(null),
    counterMultiplier: 3,
    unitAttack: { ...normalizeBalance(null).unitAttack, spearman: 1 },
  });
});

test("balance changes in a duel require a pause; melee counter uses the multiplier", () => {
  const g = flat("duel", { rulesVersion: "expansion-v1", seats: [
    { id: "p1", controller: "human" }, { id: "p2", controller: "human" },
  ] });
  Object.assign(g, { phase: "planning", paused: false, activePlayer: "p1", founded: { p1: true, p2: true } });
  assert.throws(() => setSettings(g, "p1", { balance: { counterMultiplier: 0.5 } }), /일시정지/);
  g.paused = true;
  setSettings(g, "p1", { balance: { counterMultiplier: 0 } });
  g.paused = false;
  const a = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
  const b = addUnit(g, "p2", "spearman", { q: 6, r: 5 });
  const view = observe(g, "p1");
  const preview = combatPreview(view, a, view.units.find((u) => u.id === b.id));
  assert.deepEqual(preview.received, [4, 4], "floor of four when the host zeroes the counter");
});

test("prepaid niter: a powder unit pays at its own turn start and can still fire at zero stock", () => {
  const g = createGame({ mode: "duel", rulesVersion: "expansion-v1", seats: [
    { id: "p1", controller: "human" }, { id: "p2", controller: "human" },
  ], now: 1000 });
  Object.assign(g, { units: [], cities: [], rivers: [], wars: ["p1|p2"], founded: { p1: true, p2: true } });
  for (const t of g.tiles) Object.assign(t, { terrain: "plains", owner: null, cityId: null, farm: false, developed: false, resource: null });
  g.random = () => 0.5;
  g.players.p2.connected = true;
  g.stockpiles.p1.niter = 1;
  const shooter = addUnit(g, "p1", "musketeer", { q: 4, r: 4 });
  const target = addUnit(g, "p2", "spearman", { q: 6, r: 4 });
  startGame(g, 1000);
  assert.equal(g.stockpiles.p1.niter, 0, "upkeep charged when p1's turn began");
  assert.equal(shooter.ammoPaidTurn, g.turn);
  assert.ok(observe(g, "p1").units.find((u) => u.id === shooter.id).ammunition.ready);
  const before = target.hp;
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: shooter.id, action: "attack", target: { q: 6, r: 4 } }],
  }, 1500);
  assert.ok(target.hp < before, "the prepaid unit fires with an empty stockpile");
  assert.equal(g.stockpiles.p1.niter, 0, "no second charge for the attack");
  resolveTurn(g, 2000);
  assert.equal(g.stockpiles.p1.niter, 0, "end-of-turn settlement does not double charge");
  // Next own turn with nothing left: the unit is unpaid and cannot fire.
  g.players.p2.ready = true;
  resolveTurn(g, 3000);
  assert.equal(g.activePlayer, "p1");
  assert.ok(!observe(g, "p1").units.find((u) => u.id === shooter.id).ammunition.ready);
});

test("experiment practice spawns own and barbarian units on demand, never in a duel", () => {
  const g = createGame({ mode: "practice", experiment: true });
  assert.equal(observe(g, "p1").experiment, true);
  const tile = g.tiles.find((t) => t.terrain !== "mountain" && !g.units.some((u) => equal(u, t)) && !g.cities.some((c) => equal(c, t)));
  const count = g.units.length;
  transact(g, "p1", { turn: g.turn, action: "spawn", type: "cavalry", target: { q: tile.q, r: tile.r }, hp: 40 });
  const spawned = g.units.at(-1);
  assert.equal(g.units.length, count + 1);
  assert.equal(spawned.owner, "p1");
  assert.equal(spawned.hp, 40);
  assert.equal(spawned.movesLeft, TYPES.cavalry.movement);
  const enemyTile = neighbors(tile).find((p) => g.tiles.some((t) => equal(t, p) && t.terrain !== "mountain") && !g.units.some((u) => equal(u, p)) && !g.cities.some((c) => equal(c, p)));
  transact(g, "p1", { turn: g.turn, action: "spawn", type: "spearman", factionId: "barb", target: enemyTile });
  const enemy = g.units.at(-1);
  assert.equal(enemy.owner, "barb");
  assert.throws(() => transact(g, "p1", { turn: g.turn, action: "spawn", type: "spearman", target: enemyTile }), /이미 다른 부대/);
  assert.throws(() => transact(g, "p1", { turn: g.turn, action: "spawn", type: "convoy", target: tile }), /병종/);
  transact(g, "p1", { turn: g.turn, action: "removeUnit", unitId: enemy.id });
  assert.ok(!g.units.some((u) => u.id === enemy.id && u.hp > 0));
  const plain = createGame({ mode: "practice" });
  assert.equal(observe(plain, "p1").experiment, false);
  assert.throws(() => transact(plain, "p1", { turn: plain.turn, action: "spawn", type: "spearman", target: tile }), /실험 모드/);
  const duel = createGame({ mode: "duel", experiment: true });
  assert.equal(duel.experiment, false, "experiment never applies to a duel");
});

test("observation carries balance defaults and serverTime for clock correction", () => {
  const g = createGame();
  const shown = observe(g, "p1", 123456);
  assert.equal(shown.serverTime, 123456);
  assert.deepEqual(shown.balance, normalizeBalance(null));
  assert.equal(shown.balance.unitAttack.musketeer, 28);
});
