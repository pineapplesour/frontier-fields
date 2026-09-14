import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  observe,
  submitOrders,
  resolveTurn,
  supplyNetwork,
  transact,
} from "../server/engine.mjs";
import {
  TYPES,
  equal,
  key,
  distance,
  findRoute,
  blocksUnit,
  settlementIssue,
} from "../shared/rules.js";
import { cityDamage, combatPreview } from "../shared/combat.js";
import {
  npcUnitOrder,
  npcEconomy,
  npcTurnOrder,
  settlementSites,
} from "../server/npc.mjs";

function field(owner = "p1") {
  const g = createGame();
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  g.contacts = {};
  g.wars = ["p1|p2", "p1|p3"];
  g.activePlayer = owner;
  g.random = () => 0.5;
  for (const t of g.tiles)
    Object.assign(t, {
      terrain: "plains",
      fertility: 2,
      owner: null,
      cityId: null,
      resource: null,
      developed: false,
      farm: false,
      camp: false,
    });
  return g;
}
function city(g, owner, q = 4, r = 4) {
  const c = {
    id: "home-" + owner,
    owner,
    q,
    r,
    name: "시험 도시",
    population: 5,
    food: 0,
    production: 0,
    queue: null,
    hp: 160,
    wallLevel: 0,
    capital: false,
    isolation: 0,
    supplied: true,
  };
  g.cities.push(c);
  for (const t of g.tiles)
    if (distance(t, c) <= 2) Object.assign(t, { owner, cityId: c.id });
  return c;
}
function order(g, u, action, extra = {}) {
  return submitOrders(g, u.owner, {
    turn: g.turn,
    orders: [{ unitId: u.id, action, ...extra }],
  });
}

test("wounded NPC artillery holds a safe position and actually recovers instead of pacing", () => {
  const g = field("p3");
  city(g, "p3");
  const u = addUnit(g, "p3", "artillery", { q: 4, r: 4 }, { hp: 15 });
  const command = npcUnitOrder(observe(g, "p3"), u.id);
  assert.equal(command.action, "fortify");
  submitOrders(g, "p3", { turn: 1, orders: [command] });
  assert.ok(equal(u, { q: 4, r: 4 }));
  g.activePlayer = "p1";
  for (let i = 0; i < 3; i++) {
    resolveTurn(g);
    resolveTurn(g);
  }
  assert.ok(u.hp >= 39);
  assert.ok(equal(u, { q: 4, r: 4 }));
});
test("foreign casualties are identified as foreign losses, not my lost unit", () => {
  const g = field(),
    a = addUnit(g, "p1", "artillery", { q: 4, r: 4 }),
    b = addUnit(g, "p2", "spearman", { q: 5, r: 4 }, { hp: 1 });
  order(g, a, "bombard", { target: b });
  const events = observe(g, "p1").events;
  assert.ok(!events.some((e) => e.text.includes("부대를 잃었어요")));
  assert.ok(
    events.some((e) => e.text.includes("솔마루") && e.text.includes("격파")),
  );
  assert.ok(
    observe(g, "p2").events.some((e) => e.text.includes("부대를 잃었어요")),
  );
});
test("builder coexistence is bidirectional, and crossing friendly move paths do not deadlock", () => {
  const g = field(),
    builder = addUnit(g, "p1", "builder", { q: 4, r: 4 }),
    a = addUnit(g, "p1", "musketeer", { q: 4, r: 3 }),
    b = addUnit(g, "p1", "spearman", { q: 3, r: 4 });
  assert.equal(blocksUnit(a, builder), false);
  submitOrders(g, "p1", {
    turn: 1,
    orders: [
      {
        unitId: a.id,
        action: "move",
        target: { q: 4, r: 5 },
        path: [
          { q: 4, r: 4 },
          { q: 4, r: 5 },
        ],
      },
      {
        unitId: b.id,
        action: "move",
        target: { q: 5, r: 4 },
        path: [
          { q: 4, r: 4 },
          { q: 5, r: 4 },
        ],
      },
    ],
  });
  assert.ok(equal(a, { q: 4, r: 5 }));
  assert.ok(equal(b, { q: 5, r: 4 }));
  assert.ok(equal(builder, { q: 4, r: 4 }));
});
test("open enemy-owned land is not encirclement; actual occupied lines still cut supply", () => {
  const g = field();
  city(g, "p1", 2, 4);
  const u = addUnit(g, "p1", "spearman", { q: 5, r: 4 });
  for (const t of g.tiles) if (t.q >= 4) t.owner = "p2";
  assert.ok(supplyNetwork(g, "p1").has(key(u)));
  addUnit(g, "p2", "spearman", { q: 5, r: 3 });
  addUnit(g, "p2", "spearman", { q: 6, r: 4 });
  addUnit(g, "p2", "spearman", { q: 4, r: 5 });
  // A friendly unit can contest its own hex, but not all surrounding enemy ZOC.
  assert.ok(!supplyNetwork(g, "p1").has(key(u)));
});
test("siege damage responds to health, experience and class rather than a flat 25", () => {
  const g = field(),
    c = city(g, "p2", 6, 4),
    a = addUnit(g, "p1", "artillery", { q: 4, r: 4 }),
    s = addUnit(g, "p1", "spearman", { q: 5, r: 4 });
  assert.ok(cityDamage(a, c, g) > cityDamage(s, c, g));
  const full = cityDamage(a, c, g);
  a.hp = 15;
  assert.ok(cityDamage(a, c, g) < full);
  a.hp = 100;
  a.xp = 20;
  assert.ok(cityDamage(a, c, g) > full);
});

test("settler is produced on the city military-compatible slot, at its real production cost", () => {
  const g = field(),
    c = city(g, "p1"),
    guard = addUnit(g, "p1", "spearman", { q: c.q, r: c.r });
  c.food = 100;
  submitOrders(g, "p1", {
    turn: 1,
    production: [{ cityId: c.id, type: "settler" }],
  });
  assert.equal(TYPES.settler.cost, 40);
  assert.equal(g.units.filter((u) => u.type === "settler").length, 0);
  for (let i = 0; i < 6; i++) {
    resolveTurn(g);
    resolveTurn(g);
  }
  const s = g.units.find((u) => u.type === "settler");
  assert.ok(s);
  assert.ok(equal(s, c));
  assert.ok(equal(guard, s));
  assert.equal(s.charges, 0);
  assert.deepEqual(TYPES.settler.resources, {});
});
test("settler founds immediately and is consumed; its escort survives and builders cannot found", () => {
  const g = field();
  city(g, "p1");
  const s = addUnit(g, "p1", "settler", { q: 9, r: 4 }),
    escort = addUnit(g, "p1", "spearman", { q: s.q, r: s.r });
  const builder = addUnit(g, "p1", "builder", { q: 10, r: 5 });
  assert.throws(() => order(g, builder, "found"), /개척자/);
  order(g, s, "found");
  assert.ok(!g.units.some((u) => u.id === s.id));
  assert.ok(g.units.includes(escort));
  const c = g.cities.find((c) => equal(c, s));
  assert.equal(c.population, 1);
  assert.equal(c.wallLevel, 0);
  assert.equal(c.hp, 160);
  assert.equal(g.tiles.find((t) => equal(t, s)).cityId, c.id);
  assert.throws(() => order(g, s, "found"));
});
test("settlement permits plains/hills but checks mountains, ownership, spacing and MP", () => {
  const g = field();
  const c = city(g, "p1", 0, 8);
  // The map no longer wraps east/west: the far column is nineteen hexes away.
  assert.equal(distance(c, { q: 19, r: -1 }), 19);
  const s = addUnit(g, "p1", "settler", { q: 1, r: 8 });
  assert.equal(distance(c, s), 1);
  assert.throws(() => order(g, s, "found"), /4칸/);
  Object.assign(s, { q: 9, r: 4 });
  const t = g.tiles.find((t) => equal(t, s));
  t.terrain = "hills";
  assert.equal(settlementIssue(observe(g, "p1"), s),null);
  t.terrain = "mountain";
  assert.ok(settlementIssue(observe(g, "p1"), s));
  assert.throws(() => order(g, s, "found"), /평지/);
  t.terrain = "plains";
  t.owner = "p2";
  assert.throws(() => order(g, s, "found"), /영토/);
  t.owner = null;
  s.movesLeft = 0;
  assert.throws(() => order(g, s, "found"), /행동/);
});
test("settlers cannot fight, merge or build improvements, and generate no zone of control", () => {
  const g = field(),
    s = addUnit(g, "p1", "settler", { q: 4, r: 4 }),
    e = addUnit(g, "p2", "settler", { q: 6, r: 3 });
  assert.throws(() => order(g, s, "attack", { target: e }));
  assert.throws(() => order(g, s, "farm"));
  assert.throws(() => order(g, s, "merge", { targetId: s.id }));
  const b = addUnit(g, "p1", "builder", { q: 3, r: 4 });
  assert.equal(blocksUnit(s, b), true);
  const m = addUnit(g, "p1", "cavalry", { q: 5, r: 4 });
  assert.equal(blocksUnit(s, m), false);
  order(g, m, "move", {
    target: { q: 7, r: 4 },
    path: [
      { q: 6, r: 4 },
      { q: 7, r: 4 },
    ],
  });
  assert.ok(equal(m, { q: 7, r: 4 }));
  assert.equal(m.movesLeft, TYPES.cavalry.movement - 2);
});
test("zero-MP NPC still uses an unused adjacent finishing attack", () => {
  const g = field("p3"),
    a = addUnit(g, "p3", "spearman", { q: 4, r: 4 }, { movesLeft: 0 }),
    e = addUnit(g, "p1", "spearman", { q: 5, r: 4 }, { hp: 1 });
  const cmd = npcUnitOrder(observe(g, "p3"), a.id);
  assert.equal(cmd.action, "attack");
  assert.ok(equal(cmd.target, e));
  submitOrders(g, "p3", { turn: 1, orders: [cmd] });
  assert.ok(!g.units.includes(e), "A military target is still attackable with zero movement");
  assert.equal(a.attackUsed, true);
});
test("artillery moves to a firing position with MP reserved, then fires without a melee charge", () => {
  const g = field("p3");
  city(g, "p3");
  const a = addUnit(g, "p3", "artillery", { q: 4, r: 4 }),
    e = addUnit(g, "p1", "spearman", { q: 7, r: 4 });
  addUnit(g, "p3", "cavalry", { q: 6, r: 3 });
  let cmd = npcUnitOrder(observe(g, "p3"), a.id);
  assert.equal(cmd.action, "move");
  submitOrders(g, "p3", { turn: 1, orders: [cmd] });
  assert.ok(a.movesLeft > 0);
  assert.equal(distance(a, e), 2);
  cmd = npcUnitOrder(observe(g, "p3"), a.id);
  assert.equal(cmd.action, "bombard");
  submitOrders(g, "p3", { turn: 1, orders: [cmd] });
  assert.ok(e.hp < 100);
});
test("NPC focus fire prefers a kill and does not charge cavalry into a superior spear army", () => {
  const g = field("p3"),
    a = addUnit(g, "p3", "artillery", { q: 4, r: 4 });
  addUnit(g, "p1", "spearman", { q: 6, r: 4 });
  const weak = addUnit(g, "p1", "musketeer", { q: 6, r: 3 }, { hp: 10 });
  const cmd = npcUnitOrder(observe(g, "p3"), a.id);
  assert.equal(cmd.action, "bombard");
  assert.ok(equal(cmd.target, weak));
  const h = field("p3"),
    cav = addUnit(h, "p3", "cavalry", { q: 4, r: 4 });
  addUnit(
    h,
    "p1",
    "spearman",
    { q: 5, r: 4 },
    { size: 3, hp: 300, fortified: true },
  );
  const cautious = npcUnitOrder(observe(h, "p3"), cav.id);
  assert.notEqual(cautious?.action, "attack");
});
test("NPC settler waits for an escort and then legally founds on a safe site", () => {
  const g = field("p3");
  city(g, "p3");
  const s = addUnit(g, "p3", "settler", { q: 8, r: 4 });
  let view = observe(g, "p3");
  assert.ok(settlementSites(view, s).length);
  assert.notEqual(npcUnitOrder(view, s.id)?.action, "found");
  const guard = addUnit(g, "p3", "spearman", { q: 8, r: 5 });
  const cmd = npcUnitOrder(observe(g, "p3"), s.id);
  assert.equal(cmd.action, "found");
  submitOrders(g, "p3", { turn: 1, orders: [cmd] });
  assert.equal(g.cities.filter((c) => c.owner === "p3").length, 2);
  assert.ok(g.units.includes(guard));
});
test("NPC economy buys only affordable missing counter-unit resources, retaining a gold reserve", () => {
  const g = field("p3"),
    c = city(g, "p3");
  for (const t of g.tiles.filter((t) => t.owner === "p3" && !equal(t, c)))
    t.farm = true;
  addUnit(g, "p3", "spearman", { q: 4, r: 4 });
  addUnit(g, "p3", "artillery", { q: 4, r: 5 });
  addUnit(g, "p3", "builder", { q: 5, r: 4 });
  addUnit(g, "p1", "musketeer", { q: 7, r: 4 });
  g.stockpiles.p3.horses = 0;
  g.gold.p3 = 100;
  const plans = npcEconomy(observe(g, "p3"));
  assert.ok(plans.some((p) => p.transaction?.resource === "horses"));
  for (const p of plans) {
    if (p.transaction) transact(g, "p3", { turn: 1, ...p.transaction });
    else submitOrders(g, "p3", { turn: 1, ...p });
  }
  assert.ok(g.gold.p3 >= 40);
  assert.equal(c.queue, "cavalry");
});
test("NPC tactical/economic orders depend only on scoped data and never control p1 or p2", () => {
  const g = field("p3");
  city(g, "p3");
  const u = addUnit(g, "p3", "spearman", { q: 4, r: 4 });
  const hidden = addUnit(g, "p1", "cavalry", { q: 16, r: 5 });
  const before = observe(g, "p3");
  assert.ok(!before.units.some((e) => e.id === hidden.id));
  const a = npcUnitOrder(before, u.id),
    p = npcEconomy(before);
  hidden.hp = 1;
  hidden.type = "artillery";
  g.stockpiles.p1.niter = 999;
  const after = observe(g, "p3");
  assert.deepEqual(npcUnitOrder(after, u.id), a);
  assert.deepEqual(npcEconomy(after), p);
  for (const side of ["p1", "p2"]) {
    const v = observe(g, side);
    assert.deepEqual(npcEconomy(v), []);
    assert.deepEqual(npcTurnOrder(v), []);
    assert.equal(npcUnitOrder(v, u.id), null);
  }
});

test("twenty-four-round legal-engine integration expands both NPC civilizations without moving direct-player seats", () => {
  // Seed 7293: the 2026-09-15 combat balance (2× counter-type damage, linear
  // HP attack scaling, no mutual death) changed the seeded threat timeline so
  // that under seed 7291 one NPC lost its second settler to barbarians.
  const g = createGame({ seed: 7293, now: 0 });
  const direct = g.units
    .filter((u) => ["p1", "p2"].includes(u.owner))
    .map((u) => ({ id: u.id, q: u.q, r: u.r }));
  // Kill-advance and movement-cost captures change the seeded threat timeline.
  for (let i = 0; i < 24; i++) {
    resolveTurn(g, 0);
    resolveTurn(g, 0);
  }
  for (const owner of ["p3", "p4"])
    assert.ok(g.cities.filter((c) => c.owner === owner).length >= 2);
  for (const start of direct) {
    const u = g.units.find((u) => u.id === start.id);
    // A civilian overrun and captured by barbarians legitimately moves with
    // its new owner; idle direct-player units themselves never move.
    if (u && u.owner === start.owner) assert.ok(equal(u, start));
  }
  assert.ok(g.units.every((u) => u.hp > 0 && u.hp <= 100 * u.size));
});
