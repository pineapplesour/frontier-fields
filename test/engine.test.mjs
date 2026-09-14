import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  observe,
  submitOrders,
  ready,
  startGame,
  resolveTurn as endTurn,
  advanceDue,
  farmYield,
  economy,
  updateSupply,
  strength,
  matchup,
  setSettings,
  transact,
} from "../server/engine.mjs";
import {
  TYPES,
  TURN_MS,
  MAX_TURNS,
  key,
  equal,
  neighbors,
  fromOffset,
  reachable,
  level,
  findRoute,
  routeSchedule,
  validRoute,
  extendRoute,
  landPrice,
} from "../shared/rules.js";

const tile = (g, p) => g.tiles.find((t) => equal(t, p));
const resolveTurn = (g, now) => {
  endTurn(g, now);
  endTurn(g, now);
};
const command = (g, u, action, extra = {}) => (
  (g.activePlayer = u.owner),
  submitOrders(g, u.owner, {
    turn: g.turn,
    orders: [{ unitId: u.id, action, ...extra }],
  })
);
function field() {
  const g = createGame();
  g.units = [];
  g.wars = ["p1|p2"];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  for (const t of g.tiles) {
    t.terrain = "plains";
    t.owner = null;
    t.farm = false;
    t.developed = false;
    t.resource = null;
    t.fertility = 2;
  }
  g.random = () => 0.5;
  return g;
}

test("both starts have equal economy, resources, unit mix and visible map size", () => {
  const g = createGame();
  const a = observe(g, "p1"),
    b = observe(g, "p2");
  assert.deepEqual(
    { ...a.economy, perCity: [] },
    { ...b.economy, perCity: [] },
  );
  assert.equal(a.units.filter((u) => u.owner === "p1").length, 5);
  assert.equal(
    a.tiles.filter((t) => t.visible).length,
    b.tiles.filter((t) => t.visible).length,
  );
  assert.equal(a.cities[0].production, 0);
  assert.equal(a.cities[0].productionRate, 7, "Initial production includes assigned citizens");
});
test("unseen enemy units, orders, stockpiles, changing improvements and seed never enter observations", () => {
  const g = createGame();
  const enemy = g.units.find((u) => u.owner === "p2");
  const beforeHiddenChange = observe(g, "p1", 1000);
  enemy.order = { action: "move", target: { q: 1, r: 1 } };
  g.stockpiles.p2.niter = 7777;
  const view = observe(g, "p1", 1000);
  assert.ok(!view.units.some((u) => u.id === enemy.id));
  // Compare the complete observation instead of matching a decimal
  // substring that can also appear in an unrelated random UUID/timestamp.
  assert.deepEqual(view, beforeHiddenChange);
  assert.equal(view.seed, undefined);
  assert.ok(
    view.units.every((u) => u.owner === "p1" || !Object.hasOwn(u, "order")),
  );
  assert.ok(
    view.cities.every(
      (c) =>
        c.owner === "p1" || view.tiles.some((t) => equal(t, c) && t.visible),
    ),
  );
  assert.ok(!view.cities.some((c) => c.owner === "p2"));
});
test("mountains are impassable; hills use two points", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", { q: 3, r: 2 });
  tile(g, { q: 4, r: 2 }).terrain = "hills";
  tile(g, { q: 3, r: 1 }).terrain = "mountain";
  const options = reachable(g.tiles, u, g.units, "p1");
  assert.equal(options.get("4,2").cost, 2);
  assert.ok(!options.has("3,1"));
  assert.throws(() => command(g, u, "move", { target: { q: 3, r: 1 } }));
});
test("entering enemy control stops movement and starting there permits only one hex", () => {
  const g = field(),
    u = addUnit(g, "p1", "cavalry", { q: 2, r: 2 });
  addUnit(g, "p2", "spearman", { q: 4, r: 2 });
  let moves = reachable(g.tiles, u, g.units, "p1");
  assert.equal(moves.get("3,2").path.length, 1);
  assert.ok(
    !moves.get("4,1") || moves.get("4,1").path.every((p) => key(p) !== "3,2"),
  );
  u.q = 3;
  moves = reachable(g.tiles, u, g.units, "p1");
  assert.ok([...moves.values()].every((p) => p.path.length <= 1));
});
test("movement previews cannot route through another friendly unit", () => {
  const g = field(),
    u = addUnit(g, "p1", "cavalry", { q: 3, r: 2 });
  addUnit(g, "p1", "spearman", { q: 4, r: 2 });
  const moves = reachable(g.tiles, u, g.units, "p1");
  assert.ok(!moves.has("4,2"));
  assert.ok(
    [...moves.values()].every((m) => m.path.every((p) => key(p) !== "4,2")),
  );
  assert.throws(() => command(g, u, "move", { target: { q: 4, r: 2 } }));
});
test("out-of-range hidden targets do not change validation responses or expose identity", () => {
  const g = field(),
    u = addUnit(g, "p1", "artillery", { q: 1, r: 3 });
  const e = addUnit(g, "p2", "spearman", { q: 5, r: 3 });
  const view = observe(g, "p1");
  assert.ok(!view.units.some((x) => x.id === e.id));
  const response = () => {
    try {
      command(g, u, "bombard", { target: { q: 5, r: 3 } });
    } catch (error) {
      return error.message;
    }
  };
  const occupied = response();
  g.units = g.units.filter((x) => x.id !== e.id);
  assert.equal(response(), occupied);
  assert.ok(occupied && !occupied.includes(e.id));
  assert.equal(u.attackUsed, false);
  assert.equal(u.movesLeft, TYPES.artillery.movement);
});
test("persistent routes respect active-player turn order, independent of unit array order", () => {
  for (const reverse of [false, true]) {
    const g = field(),
      a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }),
      b = addUnit(g, "p2", "spearman", { q: 5, r: 2 });
    a.movesLeft = 0;
    b.movesLeft = 0;
    command(g, a, "move", { target: { q: 4, r: 2 } });
    command(g, b, "move", { target: { q: 4, r: 2 } });
    g.activePlayer = "p1";
    if (reverse) g.units.reverse();
    resolveTurn(g);
    assert.equal(a.q, 3);
    assert.equal(b.q, 4);
    assert.equal(a.attackUsed, true);
  }
});
test("farm yield rewards all six friendly neighbors and excludes enemy farms", () => {
  const g = field(),
    p = { q: 5, r: 1 };
  const t = tile(g, p);
  t.owner = "p1";
  t.farm = true;
  t.fertility = 3;
  for (const n of neighbors(p)) {
    const x = tile(g, n);
    x.owner = "p1";
    x.farm = true;
  }
  assert.equal(farmYield(g, t).total, 10);
  tile(g, neighbors(p)[0]).owner = "p2";
  assert.equal(farmYield(g, t).total, 9);
});
test("builder farms immediately change food, exhaust moves and spend a single charge", () => {
  const g = createGame(),
    u = g.units.find((u) => u.owner === "p1" && u.type === "builder");
  const before = economy(g, "p1").foodNet;
  command(g, u, "farm");
  assert.equal(tile(g, u).farm, true);
  assert.equal(u.charges, 2);
  assert.equal(u.movesLeft, 0);
  assert.equal(g.turn, 1);
  ready(g, "p1", g.turn);
  assert.equal(tile(g, u).farm, true);
  assert.equal(u.charges, 2);
  assert.ok(economy(g, "p1").foodNet > before);
  assert.throws(() => command(g, u, "farm"));
});
test("resource facilities require matching owned deposits and generate strategic resources", () => {
  const g = createGame(),
    u = g.units.find((u) => u.owner === "p1" && u.type === "builder");
  // Initial territory now has one ring; give this facility fixture an
  // explicit connected owned deposit rather than relying on map expansion.
  const city = g.cities.find((candidate) => candidate.owner === "p1");
  const deposit = g.tiles.find((t) => t.owner === "p1" && !equal(t, city) && t.terrain === "plains");
  Object.assign(deposit, { resource: "iron", farm: false, developed: false, cityId: city.id });
  u.q = deposit.q;
  u.r = deposit.r;
  command(g, u, "develop");
  resolveTurn(g);
  assert.equal(deposit.developed, true);
  assert.equal(u.charges, 2);
  assert.equal(g.stockpiles.p1.iron, 5, "Facility base income plus assigned citizen resource bonus");
});
test("production reserves costs once, switching refunds, and unaffordable batches are atomic", () => {
  const g = createGame(),
    c = g.cities[0],
    u = g.units.find((u) => u.owner === "p1");
  submitOrders(g, "p1", {
    turn: 1,
    production: [{ cityId: c.id, type: "musketeer" }],
  });
  assert.equal(g.stockpiles.p1.niter, 1);
  submitOrders(g, "p1", {
    turn: 1,
    production: [{ cityId: c.id, type: "musketeer" }],
  });
  assert.equal(g.stockpiles.p1.niter, 1);
  submitOrders(g, "p1", {
    turn: 1,
    production: [{ cityId: c.id, type: "cavalry" }],
  });
  assert.equal(g.stockpiles.p1.niter, 3);
  assert.equal(g.stockpiles.p1.horses, 1);
  g.stockpiles.p1.iron = 0;
  assert.throws(() =>
    submitOrders(g, "p1", {
      turn: 1,
      orders: [{ unitId: u.id, action: "fortify" }],
      production: [{ cityId: c.id, type: "artillery" }],
    }),
  );
  assert.equal(u.order, null);
  assert.equal(c.queue, "cavalry");
  assert.equal(g.stockpiles.p1.horses, 1);
});
test("city production advances and completes a real unit without leaking rate into stored progress", () => {
  const g = createGame(),
    c = g.cities[0];
  const before = g.units.filter((u) => u.owner === "p1").length;
  submitOrders(g, "p1", {
    turn: 1,
    production: [{ cityId: c.id, type: "builder" }],
  });
  resolveTurn(g);
  assert.equal(c.production, 6);
  assert.equal(observe(g, "p1").cities[0].production, 6);
  resolveTurn(g);
  resolveTurn(g);
  assert.equal(c.queue, null);
  assert.equal(g.units.filter((u) => u.owner === "p1").length, before + 1);
});
test("population grows from surplus and raises production and capacity", () => {
  const g = createGame(),
    c = g.cities[0];
  c.food = 27;
  resolveTurn(g);
  const e = economy(g, "p1");
  assert.equal(c.population, 5);
  assert.equal(e.production, 8, "Population growth and citizen production both contribute");
  assert.equal(e.capacity, 10);
});
test("equal brigades merge into a four-unit corps conserving damaged health and weighted experience in either order", () => {
  for (const reverse of [false, true]) {
    const g = field(),
      a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: 65, size: 2, xp: 8 }),
      b = addUnit(
        g,
        "p1",
        "spearman",
        { q: 4, r: 2 },
        { hp: 140, size: 2, xp: 2 },
      );
    if (reverse) g.units.reverse();
    command(g, a, "merge", { targetId: b.id });
    resolveTurn(g);
    assert.equal(b.size, 4);
    assert.equal(b.hp, 205);
    assert.equal(b.xp, 5);
    assert.equal(g.units.length, 1);
    const c = addUnit(g, "p1", "spearman", { q: 3, r: 2 });
    assert.throws(() => command(g, c, "merge", { targetId: b.id }));
  }
});
test("fortification consumes a stationary turn and moving cancels it", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", { q: 3, r: 2 });
  const base = strength(u, true, g);
  command(g, u, "fortify");
  assert.equal(u.fortified, false);
  resolveTurn(g);
  assert.equal(u.fortified, true);
  assert.equal(strength(u, true, g), base * 1.25);
  command(g, u, "move", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(u.fortified, false);
});
test("attacking and defending both earn XP; kills and level thresholds apply", () => {
  const g = field(),
    a = addUnit(g, "p1", "musketeer", { q: 3, r: 2 }, { xp: 6 }),
    b = addUnit(g, "p2", "spearman", { q: 4, r: 2 });
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(a.xp, 8);
  assert.equal(b.xp, 2);
  assert.equal(level(a.xp), 2);
  b.hp = 1;
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(a.xp, 14);
  assert.ok(!g.units.includes(b));
});
test("immediate lethal attack removes target before it can act", () => {
  const g = field(),
    a = addUnit(g, "p1", "musketeer", { q: 3, r: 2 }, { hp: 1 }),
    b = addUnit(g, "p2", "musketeer", { q: 5, r: 2 }, { hp: 1 });
  command(g, a, "attack", { target: { q: 5, r: 2 } });
  assert.throws(() => command(g, b, "attack", { target: { q: 3, r: 2 } }));
  assert.equal(g.units.length, 1);
  assert.equal(a.attackUsed, true);
});
test("counter relationships and hill defense match the stated rules", () => {
  const g = field(),
    s = addUnit(g, "p1", "spearman", { q: 3, r: 2 }),
    c = addUnit(g, "p2", "cavalry", { q: 4, r: 2 });
  assert.equal(matchup(s, c), 1.7);
  assert.equal(matchup(c, { ...s, type: "musketeer" }), 1.5);
  assert.equal(matchup(s, { ...c, type: "artillery" }), 1.6);
  const before = strength(s, true, g);
  tile(g, s).terrain = "hills";
  assert.equal(strength(s, true, g), before * 1.2);
});
test("river crossing has two subsequent turns of penalty then expires", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", { q: 3, r: 2 });
  g.rivers = [{ a: { q: 3, r: 2 }, b: { q: 4, r: 2 } }];
  // Force the crossing: with four movement points a dry detour would now be
  // cheaper than fording, and this test is about the ford penalty itself.
  command(g, u, "move", { target: { q: 4, r: 2 }, path: [{ q: 4, r: 2 }] });
  assert.equal(u.riverTurns, 3);
  resolveTurn(g);
  assert.equal(u.riverTurns, 2);
  resolveTurn(g);
  assert.equal(u.riverTurns, 1);
  resolveTurn(g);
  assert.equal(u.riverTurns, 0);
});
test("encirclement weakens both units and cities and recovery is gradual", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", { q: 4, r: 2 });
  const city = {
    id: "city",
    owner: "p1",
    q: 4,
    r: 2,
    population: 4,
    food: 8,
    production: 0,
    queue: null,
    hp: 160,
    isolation: 0,
  };
  g.cities = [city];
  for (const n of neighbors(u)) addUnit(g, "p2", "spearman", n);
  for (let i = 0; i < 3; i++) updateSupply(g);
  assert.equal(u.isolation, 3);
  assert.equal(city.isolation, 3);
  assert.ok(u.hp < 100);
  assert.ok(city.hp < 160);
  g.units = g.units.filter((x) => x.owner === "p1");
  updateSupply(g);
  assert.equal(u.isolation, 2);
  assert.equal(city.isolation, 2);
  updateSupply(g);
  updateSupply(g);
  assert.equal(u.isolation, 0);
});
test("range-two artillery exposes firing position but not unseen retreat", () => {
  const g = field(),
    a = addUnit(g, "p1", "artillery", { q: 3, r: 2 }),
    b = addUnit(g, "p2", "musketeer", { q: 5, r: 2 });
  command(g, a, "bombard", { target: { q: 5, r: 2 }, retreat: { q: 2, r: 2 } });
  const view = observe(g, "p2");
  assert.ok(!view.units.some((u) => u.id === a.id));
  const shot = view.events.find((e) => e.type === "shot");
  assert.equal(shot.q, 3);
  assert.equal(shot.r, 2);
  assert.ok(!JSON.stringify(view.events).includes(a.id));
  assert.ok(observe(g, "p1").events.some((e) => e.text.includes("머스킷병")));
  assert.equal(a.q, 2);
  assert.equal(b.xp, 2);
});
test("turn cutoff, out-of-turn requests and sequential early handoff are enforced", () => {
  const g = createGame({ mode: "duel" });
  g.players.p2.connected = true;
  startGame(g, 1000);
  const u = g.units.find((u) => u.owner === "p1");
  assert.equal(g.deadline, 1000 + TURN_MS);
  ready(g, "p1", 1, 2000);
  assert.equal(g.turn, 1);
  assert.equal(g.activePlayer, "p2");
  assert.throws(() => submitOrders(g, "p1", { turn: 1, orders: [] }, 2500));
  ready(g, "p2", 1, 3000);
  assert.equal(g.turn, 2);
  assert.equal(g.deadline, 3000 + TURN_MS);
  assert.throws(() =>
    submitOrders(
      g,
      "p1",
      { turn: 2, orders: [{ unitId: u.id, action: "fortify" }] },
      g.deadline,
    ),
  );
  assert.equal(g.turn, 2);
  assert.equal(g.activePlayer, "p2");
  assert.equal(u.order, null);
  assert.throws(() => ready(g, "p1", 2, 3001));
});
test("capturing the last opposing capital completes a four-civilization match", () => {
  const g = createGame();
  for (const c of g.cities.filter((c) => ["p3", "p4"].includes(c.owner)))
    c.owner = "p1";
  g.wars = ["p1|p2"];
  const c = g.cities.find((c) => c.owner === "p2");
  c.hp = 0;
  g.units = g.units.filter((u) => u.owner === "p1");
  const a = g.units.find((u) => u.type === "spearman");
  Object.assign(
    a,
    neighbors(c).find((p) => tile(g, p) && tile(g, p).terrain !== "mountain"),
  );
  command(g, a, "move", { target: { q: c.q, r: c.r } });
  resolveTurn(g);
  assert.equal(g.winner, "p1");
  assert.equal(g.phase, "finished");
  assert.equal(g.deadline, null);
});
test("match has a bounded complete ending after maximum turns", () => {
  const g = createGame();
  g.turn = MAX_TURNS;
  resolveTurn(g);
  assert.equal(g.phase, "finished");
  assert.ok(["p1", "p2", "p3", "p4", "draw"].includes(g.winner));
});
