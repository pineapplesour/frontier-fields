import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  observe,
  submitOrders,
  resolveTurn,
  economy,
  previewDeal,
  transact,
  strength,
} from "../server/engine.mjs";
import { TYPES, equal, distance, maxHealth } from "../shared/rules.js";
import { fortBonus } from "../shared/structures.js";
import { npcDiplomacy } from "../server/npc.mjs";
import { buildWorld, disposeGroup, worldPoint } from "../src/world3d.js";
import { makeMotion } from "../src/motion3d.js";

function field() {
  const g = createGame();
  Object.assign(g, {
    units: [],
    cities: [],
    rivers: [],
    explored: {},
    contacts: {},
    cityContacts: {},
    wars: ["p1|p2"],
    random: () => 0.5,
  });
  for (const t of g.tiles)
    Object.assign(t, {
      terrain: "plains",
      owner: null,
      cityId: null,
      resource: null,
      farm: false,
      developed: false,
      fort: null,
      camp: false,
      fertility: 2,
    });
  return g;
}
function city(g, owner = "p1", q = 3, r = 3) {
  const c = {
    id: `city-${owner}-${q}`,
    owner,
    name: "시험 도시",
    q,
    r,
    population: 3,
    hp: 160,
    food: 0,
    queue: null,
    production: 0,
    wallLevel: 0,
    isolation: 0,
    supplied: true,
    capital: false,
  };
  g.cities.push(c);
  for (const t of g.tiles)
    if (distance(t, c) <= 2) Object.assign(t, { owner, cityId: c.id });
  return c;
}
const cmd = (g, u, action, extra = {}) =>
  submitOrders(g, u.owner, {
    turn: g.turn,
    orders: [{ unitId: u.id, action, ...extra }],
  });
const trade = (g, action, extra = {}) =>
  transact(g, g.activePlayer, { turn: g.turn, action, ...extra });

test("whole-city position cannot overwrite unit identity or copy city metadata", () => {
  const g = createGame({ seed: 7291 });
  const all = [...g.cities, ...g.units].map((e) => e.id);
  assert.equal(new Set(all).size, all.length);
  const c = g.cities[0],
    u = addUnit(g, "p1", "spearman", c);
  assert.notEqual(u.id, c.id);
  assert.equal(u.population, undefined);
  assert.equal(u.name, undefined);
  assert.ok(equal(u, c));
});
test("even a legacy colliding ID leaves city geometry static while its garrison animates", () => {
  const g = field(),
    c = city(g),
    u = addUnit(g, "p1", "spearman", c);
  u.id = c.id;
  const world = buildWorld(observe(g, "p1"));
  const mesh = world.children.find((m) =>
    m.userData.points?.some((p) => p?.id === c.id && !p.type),
  );
  const i = mesh.userData.points.findIndex((p) => p?.id === c.id && !p.type);
  const before = [...mesh.instanceMatrix.array.slice(i * 16, i * 16 + 16)];
  const actor = world.userData.actors.get(u.id);
  assert.ok(actor.parts.length > 0);
  world.userData.animate(
    new Map([
      [u.id, { position: worldPoint(u).add({ x: 3, y: 0, z: 0 }), scale: 1 }],
    ]),
    900,
    true,
  );
  assert.deepEqual(
    [...mesh.instanceMatrix.array.slice(i * 16, i * 16 + 16)],
    before,
  );
  disposeGroup(world);
});
test("moving without attacking heals exact missing HP and emits a finite recovery motion", () => {
  const g = field();
  city(g);
  const u = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, { hp: 96 });
  cmd(g, u, "move", { target: { q: 4, r: 3 } });
  resolveTurn(g);
  assert.equal(u.hp, 100);
  const view = observe(g, "p1"),
    heal = view.effects.find((e) => e.kind === "heal" && e.unitId === u.id);
  assert.equal(heal.amount, 4);
  const motion = makeMotion(view, 0);
  for (const time of [0, 300, 1000, 2300])
    for (const pose of motion.update(time).poses.values()) {
      assert.ok(Number.isFinite(pose.scale ?? 1));
      assert.ok(pose.position.toArray().every(Number.isFinite));
    }
  disposeGroup(motion.group);
});
test("attacking, isolation and full health suppress recovery", () => {
  for (const extra of [
    { hp: 60, attackUsed: true },
    { hp: 60, isolation: 1 },
    { hp: 100 },
  ]) {
    const g = field();
    city(g);
    const u = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, extra);
    resolveTurn(g);
    assert.equal(u.hp, extra.hp);
    assert.ok(
      !observe(g, "p1").effects.some(
        (e) => e.kind === "heal" && e.unitId === u.id,
      ),
    );
  }
});
test("artillery and wall fire accept distance two and reject distance three without spending attack", () => {
  for (const walls of [false, true]) {
    const g = field(),
      c = city(g);
    c.wallLevel = 1;
    const a = addUnit(g, "p1", "artillery", c),
      b = addUnit(g, "p2", "spearman", { q: 6, r: 3 });
    const fire = () =>
      walls
        ? submitOrders(g, "p1", {
            turn: 1,
            orders: [
              {
                cityId: c.id,
                action: "cityBombard",
                target: { q: b.q, r: b.r },
              },
            ],
          })
        : cmd(g, a, "bombard", { target: { q: b.q, r: b.r } });
    assert.throws(fire);
    assert.ok(!a.attackUsed && !c.attackUsed);
    b.q = 5;
    fire();
    assert.ok(b.hp < 100);
  }
  assert.equal(TYPES.artillery.range, 2);
});
test("fort construction consumes last charge, cannot overlap farms, and benefits only allied military", () => {
  const g = field();
  city(g);
  const u = addUnit(g, "p1", "builder", { q: 4, r: 3 }, { charges: 1 }),
    t = g.tiles.find((t) => equal(t, u));
  const guard = addUnit(g, "p1", "spearman", u),
    before = strength(guard, true, g);
  cmd(g, u, "fort");
  assert.ok(!g.units.includes(u));
  assert.equal(t.fort.hp, 80);
  assert.equal(fortBonus(g, guard), 0.25);
  assert.ok(strength(guard, true, g) > before);
  assert.equal(fortBonus(g, { ...guard, owner: "p2" }), 0);
  assert.equal(fortBonus(g, { ...guard, type: "builder" }), 0);
  const builder = addUnit(g, "p1", "builder", t);
  assert.throws(() => cmd(g, builder, "farm"));
  assert.throws(() => cmd(g, builder, "fort"));
});
test("right-click-style move engages empty hostile fort and destroys it without moving onto it", () => {
  const g = field(),
    a = addUnit(g, "p1", "spearman", { q: 3, r: 3 });
  const t = g.tiles.find((t) => t.q === 4 && t.r === 3);
  t.fort = { owner: "p2", hp: 1, maxHp: 80 };
  cmd(g, a, "move", { target: { q: 4, r: 3 } });
  assert.equal(a.q, 3);
  assert.ok(a.attackUsed);
  assert.equal(t.fort.hp, 0, "Destroyed fort persists for physical occupation and repair");
  assert.ok(observe(g, "p1").effects.some((e) => e.fort && e.amount === 1));
});
test("resource facility produces one, population sets cap, excess legacy stock is preserved", () => {
  const g = field(),
    c = city(g),
    u = addUnit(g, "p1", "builder", { q: 4, r: 3 });
  c.citizenPolicy = { auto: false, lockedSlots: [], priority: [] };
  const t = g.tiles.find((t) => equal(t, u));
  t.resource = "iron";
  cmd(g, u, "develop");
  assert.equal(economy(g, "p1").income.iron, 1);
  assert.equal(economy(g, "p1").resourceCapacity, 15);
  g.stockpiles.p1.iron = 14;
  resolveTurn(g);
  assert.equal(g.stockpiles.p1.iron, 15);
  g.activePlayer = "p1";
  assert.throws(() => trade(g, "buy", { resource: "iron", amount: 1 }));
  c.population = 2;
  resolveTurn(g);
  assert.equal(g.stockpiles.p1.iron, 15);
  assert.equal(economy(g, "p1").resourceCapacity, 10);
});
test("production completes on city and leaves durable prompt; choosing idle acknowledges with food bonus", () => {
  const g = field(),
    c = city(g);
  c.queue = "builder";
  c.production = TYPES.builder.cost - 1;
  assert.equal(economy(g, "p1").perCity[0].foodFocusBonus, 0);
  resolveTurn(g);
  const own = observe(g, "p1").cities.find((x) => x.id === c.id);
  assert.ok(own.productionPending);
  assert.equal(own.lastProduction.type, "builder");
  assert.ok(g.units.some((u) => u.type === "builder" && equal(u, c)));
  assert.equal(own.foodFocusBonus, 1);
  g.activePlayer = "p1";
  submitOrders(g, "p1", {
    turn: g.turn,
    production: [{ cityId: c.id, type: null }],
  });
  assert.equal(c.productionPending, false);
  assert.equal(c.queue, null);
});
test("city memory preserves last observed population and owner without hidden HP and clears on revisit", () => {
  const g = field(),
    scout = addUnit(g, "p1", "spearman", { q: 3, r: 3 }),
    c = city(g, "p2", 5, 3);
  const observedPopulation = c.population;
  observe(g, "p1");
  scout.q = 0;
  c.population = 99;
  c.hp = 7;
  c.owner = "p3";
  let v = observe(g, "p1"),
    ghost = v.cityContacts.find((x) => x.id === c.id);
  assert.ok(ghost.ghost);
  assert.equal(ghost.owner, "p2");
  assert.equal(ghost.hp, undefined);
  assert.equal(ghost.population, observedPopulation);
  assert.ok(!v.cities.some((x) => x.id === c.id));
  g.cities = [];
  assert.ok(observe(g, "p1").cityContacts.some((x) => x.id === c.id));
  scout.q = 3;
  assert.ok(!observe(g, "p1").cityContacts.some((x) => x.id === c.id));
});
test("NPC quote has no economic mutation and exact additional gold matches real settlement", () => {
  const g = createGame(),
    raw = { factionId: "p3", receive: { resources: { iron: 2 } } };
  observe(g, "p1");
  const before = JSON.stringify({
    stocks: g.stockpiles,
    gold: g.gold,
    proposals: g.proposals,
    revision: g.revision,
    events: g.events,
  });
  const q = previewDeal(g, "p1", raw);
  assert.equal(q.status, "insufficient");
  assert.equal(q.additionalGold, 14);
  assert.equal(
    JSON.stringify({
      stocks: g.stockpiles,
      gold: g.gold,
      proposals: g.proposals,
      revision: g.revision,
      events: g.events,
    }),
    before,
  );
  raw.give = { gold: q.additionalGold };
  assert.equal(previewDeal(g, "p1", raw).status, "accept");
  trade(g, "offerDeal", raw);
  assert.equal(g.stockpiles.p1.iron, 5);
  assert.equal(g.proposals.length, 0);
});
test("human quote never predicts willingness or exposes inventory and requires actual consent", () => {
  const g = createGame();
  g.wars = ["p1|p2"];
  g.warStarted = { "p1|p2": g.turn - 10 };
  const raw = {
    factionId: "p2",
    peace: true,
    receive: { resources: { iron: 99 } },
  };
  assert.equal(previewDeal(g, "p1", raw).status, "human");
  raw.receive = {};
  trade(g, "offerDeal", raw);
  assert.ok(g.wars.includes("p1|p2"));
  g.activePlayer = "p2";
  trade(g, "acceptProposal", { proposalId: g.proposals[0].id });
  assert.ok(!g.wars.includes("p1|p2"));
  g.turn = 20;
  assert.equal(
    observe(g, "p1").factions.find((f) => f.id === "p2").hostile,
    false,
  );
});
test("wars do not expire and accepted NPC peace only lifts redeclaration restriction after five turns", () => {
  const g = createGame();
  g.wars = ["p1|p3"];
  g.turn = 15;
  g.warStarted = { "p1|p3": 1 };
  assert.ok(observe(g, "p1").factions.find((f) => f.id === "p3").hostile);
  trade(g, "peace", { factionId: "p3", gold: 40 });
  assert.throws(() => trade(g, "declareWar", { factionId: "p3" }));
  g.turn = 21;
  assert.ok(!observe(g, "p1").factions.find((f) => f.id === "p3").hostile);
  trade(g, "declareWar", { factionId: "p3" });
  assert.ok(g.wars.includes("p1|p3"));
});
test("combined peace quote and acceptance match and cannot automatically resume war", () => {
  const g = createGame();
  g.wars = ["p1|p3"];
  g.warStarted = { "p1|p3": g.turn - 10 };
  const raw = {
    factionId: "p3",
    peace: true,
    give: { resources: { iron: 2 } },
  };
  assert.equal(previewDeal(g, "p1", raw).additionalGold, 26);
  raw.give.gold = 26;
  trade(g, "offerDeal", raw);
  assert.ok(!g.wars.includes("p1|p3"));
  g.turn = 10;
  assert.ok(!observe(g, "p1").factions.find((f) => f.id === "p3").hostile);
});
test("NPC losing city may request consent-based peace and completed NPC turns are public", () => {
  const g = field(),
    c = city(g, "p3");
  c.hp = 50;
  g.turn = 6;
  g.wars = ["p1|p3"];
  addUnit(g, "p1", "spearman", { q: 4, r: 3 });
  const action = npcDiplomacy(observe(g, "p3"));
  assert.equal(action.action, "offerDeal");
  assert.equal(action.peace, true);
  const h = field();
  resolveTurn(h);
  resolveTurn(h);
  assert.deepEqual(observe(h, "p1").lastNpcTurns, {
    round: 1,
    factions: ["p3", "p4", "cs", "barb"],
  });
});
