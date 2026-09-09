import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  observe,
  submitOrders,
  resolveTurn as endTurn,
  setSettings,
  transact,
  economy,
  advanceDue,
} from "../server/engine.mjs";
import {
  TYPES,
  key,
  equal,
  neighbors,
  distance,
  findRoute,
  routeSchedule,
  extendRoute,
  validRoute,
  landPrice,
  growthTarget,
} from "../shared/rules.js";
const command = (g, u, action, extra = {}) =>
  submitOrders(g, u.owner, {
    turn: g.turn,
    orders: [{ unitId: u.id, action, ...extra }],
  });
const resolveTurn = (g, now) => {
  endTurn(g, now);
  endTurn(g, now);
};
function field() {
  const g = createGame();
  g.wars = ["p1|p2"];
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.contacts = { p1: {}, p2: {} };
  g.explored = {};
  for (const t of g.tiles)
    Object.assign(t, {
      terrain: "plains",
      owner: null,
      cityId: null,
      farm: false,
      developed: false,
      resource: null,
      camp: false,
      fertility: 2,
    });
  g.random = () => 0.5;
  return g;
}

test("persistent movement executes now, respects terrain and advances once each next turn", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", { q: 1, r: 3 }),
    target = { q: 7, r: 3 };
  // Infantry now moves four plains tiles per turn (host rule change 2026-09-06).
  const path = findRoute(observe(g, "p1"), u, target),
    plan = routeSchedule(g.tiles, u, g.units, "p1", path);
  assert.equal(plan.turns, 2);
  assert.equal(plan.steps[3].endOfTurn, true);
  command(g, u, "move", { target, path });
  assert.equal(u.q, 5);
  assert.equal(u.movesLeft, 0);
  assert.equal(g.turn, 1);
  assert.equal(u.order.path.length, 2);
  const remaining = routeSchedule(g.tiles, u, g.units, "p1", u.order.path);
  assert.equal(remaining.steps[0].turn, 2);
  resolveTurn(g);
  assert.equal(u.q, 7);
  assert.equal(u.order, null);
});
test("cancel only cancels future movement, remaining MP survives replacement and custom waypoints are validated", () => {
  const g = field(),
    u = addUnit(g, "p1", "cavalry", { q: 1, r: 3 });
  command(g, u, "move", { target: { q: 2, r: 3 } });
  assert.equal(u.movesLeft, TYPES.cavalry.movement - 1);
  command(g, u, "move", { target: { q: 3, r: 3 } });
  assert.equal(u.movesLeft, TYPES.cavalry.movement - 2);
  assert.throws(() => command(g, u, "fortify"));
  command(g, u, "move", { target: { q: 7, r: 3 } });
  assert.equal(u.movesLeft, TYPES.cavalry.movement - 6);
  const actual = { q: u.q, r: u.r };
  command(g, u, "cancel");
  assert.equal(u.order, null);
  assert.ok(equal(u, actual));
  resolveTurn(g);
  assert.ok(equal(u, actual));
  const view = observe(g, "p1");
  let path = extendRoute(view, u, [], { q: 4, r: 4 });
  // Finish beyond the waypoint, not on the earlier leg (which intentionally
  // truncates a dragged route). Cavalry now ends the first leg at q7.
  path = extendRoute(view, u, path, { q: 4, r: 6 });
  assert.ok(path.some((p) => equal(p, { q: 4, r: 4 })));
  assert.equal(validRoute(view, u, path, path.at(-1)), true);
  assert.throws(() =>
    command(g, u, "move", { target: { q: 10, r: 1 }, path: [{ q: 10, r: 1 }] }),
  );
});
test("right-click enemy moves into range and fights once; adjacent attack works with zero MP", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", { q: 2, r: 3 }),
    e = addUnit(g, "p2", "spearman", { q: 4, r: 3 });
  command(g, u, "move", { target: { q: e.q, r: e.r } });
  assert.equal(u.q, 3);
  assert.ok(e.hp < 100);
  assert.equal(u.attackUsed, true);
  assert.equal(u.movesLeft, 0);
  assert.throws(() => command(g, u, "attack", { target: { q: e.q, r: e.r } }));
  assert.throws(() => command(g, u, "move", { target: { q: 2, r: 3 } }));
  const g2 = field(),
    a = addUnit(g2, "p1", "spearman", { q: 2, r: 3 }, { movesLeft: 0 }),
    b = addUnit(g2, "p2", "spearman", { q: 3, r: 3 });
  command(g2, a, "attack", { target: { q: b.q, r: b.r } });
  assert.ok(b.hp < 100);
});
test("last construction removes builder immediately and cannot be repeated in same turn", () => {
  const g = field(),
    u = addUnit(g, "p1", "builder", { q: 2, r: 3 }, { charges: 1 }),
    t = g.tiles.find((t) => equal(t, u));
  t.owner = "p1";
  command(g, u, "farm");
  assert.equal(t.farm, true);
  assert.equal(g.units.includes(u), false);
  assert.equal(g.turn, 1);
  assert.throws(() => command(g, u, "farm"));
});
test("last-seen contact is stale, scoped, and clears only when old tile is checked", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", { q: 2, r: 3 }),
    e = addUnit(g, "p2", "spearman", { q: 4, r: 3 });
  observe(g, "p1");
  u.q = 0;
  e.q = 8;
  let view = observe(g, "p1");
  assert.equal(
    view.units.some((x) => x.id === e.id),
    false,
  );
  const memory = view.contacts.find((c) => c.id === e.id);
  assert.equal(memory.q, 4);
  assert.equal(memory.hp, undefined);
  assert.equal(memory.lastSeenTurn, 1);
  assert.ok(!JSON.stringify(view.contacts).includes('"q":8'));
  u.q = 2;
  view = observe(g, "p1");
  assert.equal(
    view.contacts.some((c) => c.id === e.id),
    false,
  );
});
test("shell hits reveal only the hit tile and never reveal post-shot relocation", () => {
  const g = field(),
    a = addUnit(g, "p1", "artillery", { q: 2, r: 3 }),
    b = addUnit(g, "p2", "musketeer", { q: 4, r: 3 });
  command(g, a, "bombard", { target: { q: 4, r: 3 }, retreat: { q: 1, r: 3 } });
  const own = observe(g, "p1"),
    foe = observe(g, "p2");
  assert.ok(own.effects.some((x) => x.kind === "damage" && x.unitId === b.id));
  assert.ok(own.units.some((x) => x.id === b.id));
  assert.ok(!foe.effects.some((x) => x.kind === "move" && x.unitId === a.id));
  assert.equal(foe.effects.find((x) => x.kind === "bombard").from.q, 2);
  b.q = 8;
  const moved = observe(g, "p1");
  assert.ok(!moved.units.some((x) => x.id === b.id));
  assert.equal(moved.contacts.find((x) => x.id === b.id).q, 4);
});
test("global timer defaults to 60s, validates host/range, applies next turn without extending current deadline", () => {
  const g = createGame({ now: 1000 }),
    before = g.deadline;
  assert.equal(before, 61000);
  assert.equal(g.turnSeconds, 60);
  assert.throws(() => setSettings(g, "p2", { turnSeconds: 90 }));
  assert.throws(() => setSettings(g, "p1", { turnSeconds: 0 }));
  setSettings(g, "p1", { turnSeconds: 90 });
  assert.equal(g.deadline, before);
  resolveTurn(g, 2000);
  assert.equal(g.deadline, 92000);
  assert.equal(observe(g, "p2", 2000).turnSeconds, 90);
  advanceDue(g, 92000);
  assert.equal(g.activePlayer, "p2");
});
test("gold trades conserve stock, reject overdraft and remove only sold own unit", () => {
  const g = createGame(),
    gold = g.gold.p1,
    city = g.cities.find((c) => c.owner === "p1"),
    unit = g.units.find((u) => u.owner === "p1");
  transact(g, "p1", { turn: 1, action: "sell", resource: "iron", amount: 1 });
  assert.equal(g.gold.p1, gold + 7);
  assert.equal(g.stockpiles.p1.iron, 2);
  transact(g, "p1", {
    turn: 1,
    action: "buy",
    resource: "food",
    cityId: city.id,
    amount: 5,
  });
  assert.equal(g.gold.p1, gold + 7 - 20);
  const food = city.food;
  assert.ok(food >= 5);
  const balance = g.gold.p1;
  assert.throws(() =>
    transact(g, "p1", {
      turn: 1,
      action: "buy",
      resource: "niter",
      amount: 100,
    }),
  );
  assert.equal(g.gold.p1, balance);
  assert.throws(() =>
    transact(g, "p2", { turn: 1, action: "sellUnit", unitId: unit.id }),
  );
  transact(g, "p1", { turn: 1, action: "sellUnit", unitId: unit.id });
  assert.ok(!g.units.includes(unit));
  assert.ok(g.gold.p1 > balance);
});
test("territory purchase charges exact price and population growth expands own city territory", () => {
  const g = createGame(),
    c = g.cities.find((c) => c.owner === "p1");
  const t = g.tiles.find(
    (t) =>
      !t.owner &&
      t.terrain !== "mountain" &&
      neighbors(t).some((p) =>
        g.tiles.some((x) => equal(x, p) && x.cityId === c.id),
      ),
  );
  const before = g.gold.p1,
    cost = landPrice(t, c);
  transact(g, "p1", {
    turn: 1,
    action: "buyTile",
    cityId: c.id,
    target: { q: t.q, r: t.r },
  });
  assert.equal(t.owner, "p1");
  assert.equal(t.cityId, c.id);
  assert.equal(g.gold.p1, before - cost);
  assert.throws(() =>
    transact(g, "p1", { turn: 1, action: "buyTile", cityId: c.id, target: t }),
  );
  const count = g.tiles.filter((t) => t.cityId === c.id).length;
  c.population = 5;
  c.food = growthTarget(5);
  resolveTurn(g);
  assert.equal(c.population, 6);
  assert.ok(g.tiles.filter((t) => t.cityId === c.id).length > count);
});
test("human peace uses escrow and consent; decline and expiration return the exact gold", () => {
  const g = createGame(),
    gold = g.gold.p1;
  transact(g, "p1", { turn: 1, action: "declareWar", factionId: "p2" });
  transact(g, "p1", { turn: 1, action: "peace", factionId: "p2", gold: 30 });
  let p = g.proposals[0];
  assert.equal(g.gold.p1, gold - 30);
  assert.equal(
    observe(g, "p1").factions.find((f) => f.id === "p2").hostile,
    true,
  );
  assert.throws(() =>
    transact(g, "p1", { turn: 1, action: "acceptPeace", proposalId: p.id }),
  );
  g.activePlayer = "p2";
  transact(g, "p2", { turn: 1, action: "rejectPeace", proposalId: p.id });
  assert.equal(g.gold.p1, gold);
  g.activePlayer = "p1";
  transact(g, "p1", { turn: 1, action: "peace", factionId: "p2", gold: 30 });
  p = g.proposals[0];
  g.activePlayer = "p2";
  transact(g, "p2", { turn: 1, action: "acceptPeace", proposalId: p.id });
  assert.equal(g.gold.p2, 150);
  assert.equal(
    observe(g, "p1").factions.find((f) => f.id === "p2").hostile,
    false,
  );
  g.activePlayer = "p1";
  assert.throws(() =>
    transact(g, "p1", { turn: 1, action: "declareWar", factionId: "p2" }),
  );
  const h = createGame();
  transact(h, "p1", { turn: 1, action: "declareWar", factionId: "p2" });
  transact(h, "p1", { turn: 1, action: "peace", factionId: "p2", gold: 30 });
  for (let i = 0; i < 3; i++) resolveTurn(h);
  assert.equal(h.proposals.length, 0);
  assert.ok(h.gold.p1 >= 120);
});
test("independent faction, city-state and barbarians differ; peace prevents attacks and movement ZOC", () => {
  const g = createGame();
  const factions = observe(g, "p1").factions;
  assert.equal(factions.find((f) => f.id === "cs").hostile, false);
  assert.equal(factions.find((f) => f.id === "p3").hostile, false);
  assert.equal(factions.find((f) => f.id === "barb").hostile, true);
  transact(g, "p1", { turn: 1, action: "declareWar", factionId: "p3" });
  assert.equal(
    observe(g, "p1").factions.find((f) => f.id === "p3").hostile,
    true,
  );
  transact(g, "p1", { turn: 1, action: "peace", factionId: "p3", gold: 40 });
  assert.equal(
    observe(g, "p1").factions.find((f) => f.id === "p3").hostile,
    false,
  );
  assert.throws(() =>
    transact(g, "p1", {
      turn: 1,
      action: "peace",
      factionId: "barb",
      gold: 40,
    }),
  );
  const a = g.units.find((u) => u.owner === "p1" && u.type === "musketeer"),
    b = g.units.find((u) => u.owner === "p3");
  a.q = b.q - 1;
  a.r = b.r;
  assert.throws(() => command(g, a, "attack", { target: { q: b.q, r: b.r } }));
});
test("60-second expiry settles only active city economy and switches to opponent without replaying actions", () => {
  const g = createGame({ now: 1000 }),
    c = g.cities.find((c) => c.owner === "p1"),
    other = g.cities.find((c) => c.owner === "p2"),
    u = g.units.find((u) => u.owner === "p1" && u.type === "builder");
  submitOrders(
    g,
    "p1",
    {
      turn: 1,
      orders: [{ unitId: u.id, action: "farm" }],
      production: [{ cityId: c.id, type: "builder" }],
    },
    2000,
  );
  const otherFood = other.food;
  assert.throws(() => submitOrders(g, "p2", { turn: 1, orders: [] }, 2001));
  advanceDue(g, 61000);
  assert.equal(g.activePlayer, "p2");
  assert.equal(g.turn, 1);
  assert.equal(g.deadline, 121000);
  assert.equal(c.production, 6);
  assert.equal(other.food, otherFood);
  assert.equal(u.charges, 2);
  assert.throws(() => submitOrders(g, "p1", { turn: 1, orders: [] }, 61001));
  const beforeIron = g.stockpiles.p1.iron;
  transact(g, "p1", { turn: 1, action: "sell", resource: "iron" }, 61001);
  assert.equal(g.stockpiles.p1.iron, beforeIron - 1, "Market trades are explicitly allowed off-turn");
  endTurn(g, 62000);
  assert.equal(g.activePlayer, "p1");
  assert.equal(g.turn, 2);
  assert.equal(c.production, 6);
  assert.equal(u.charges, 2);
  assert.equal(u.movesLeft, TYPES.builder.movement);
});
test("completed production spawns on an adjacent own tile when a same-class unit occupies the city tile", () => {
  const g = createGame(),
    c = g.cities.find((c) => c.owner === "p1"),
    guard = g.units.find((u) => u.owner === "p1" && u.type === "builder");
  guard.q = c.q;
  guard.r = c.r;
  submitOrders(g, "p1", {
    turn: 1,
    production: [{ cityId: c.id, type: "builder" }],
  });
  const count = g.units.filter((u) => u.owner === "p1").length;
  for (let i = 0; i < 4; i++) resolveTurn(g);
  // Host rule 2026-09-06: a finished unit never waits behind a garrison; it
  // appears on the nearest own adjacent tile instead of stalling the queue.
  assert.equal(c.queue, null);
  assert.equal(g.units.filter((u) => u.owner === "p1").length, count + 1);
  const spawned = g.units.filter((u) => u.owner === "p1" && u.type === "builder" && u.id !== guard.id).at(-1);
  assert.equal(spawned.type, "builder");
  assert.equal(distance(spawned, c), 1);
  assert.equal(g.tiles.find((t) => equal(t, spawned)).owner, "p1");
  assert.ok(equal(guard, c), "The garrison stays where it was");
  // With every own adjacent tile blocked too, the unit waits as before.
  const h = createGame(),
    hc = h.cities.find((x) => x.owner === "p1"),
    hguard = h.units.find((u) => u.owner === "p1" && u.type === "builder");
  hguard.q = hc.q;
  hguard.r = hc.r;
  for (const n of neighbors(hc))
    if (h.tiles.some((t) => equal(t, n) && t.terrain !== "mountain" && t.owner === "p1"))
      addUnit(h, "p1", "settler", n);
  submitOrders(h, "p1", { turn: 1, production: [{ cityId: hc.id, type: "builder" }] });
  for (let i = 0; i < 4; i++) resolveTurn(h);
  assert.equal(hc.queue, "builder");
  // Only the original guard builder exists; roaming barbarians may capture a
  // blocking settler, which is irrelevant to the waiting rule under test.
  assert.equal(h.units.filter((u) => u.owner === "p1" && u.type === "builder").length, 1);
});
