// Strategic NPC military behaviour (2026-09-15): pillage policy, favorable
// ground, defense of own assets, key positions, concealment, growth/buildup and
// non-warmonger offensives.  Every state here is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  observe,
  submitOrders,
  transact,
  resolveTurn,
} from "../server/engine.mjs";
import { equal, distance } from "../shared/rules.js";
import {
  npcUnitOrder,
  npcEconomy,
  npcDiplomacy,
  NPC_STRATEGY,
} from "../server/npc.mjs";

const MILITARY = ["spearman", "musketeer", "cavalry", "artillery"];

function field(owner = "p3", wars = ["p1|p2", "p1|p3"]) {
  const g = createGame();
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  g.contacts = {};
  g.wars = wars;
  g.activePlayer = owner;
  g.random = () => 0.5;
  g.turn = 6;
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
      ruin: null,
    });
  return g;
}
function city(g, owner, q, r, extra = {}) {
  const c = {
    id: `city-${owner}-${q}-${r}`,
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
    ...extra,
  };
  g.cities.push(c);
  for (const t of g.tiles)
    if (distance(t, c) <= 2 && !t.owner)
      Object.assign(t, { owner, cityId: c.id });
  return c;
}
const tile = (g, q, r) => g.tiles.find((t) => t.q === q && t.r === r);
function farms(g, c, radius = 2) {
  const out = [];
  for (const t of g.tiles)
    if (distance(t, c) >= 1 && distance(t, c) <= radius && t.owner === c.owner) {
      t.farm = true;
      out.push(t);
    }
  return out;
}
const order = (g, u) => npcUnitOrder(observe(g, "p3"), u.id);
const submit = (g, cmd) =>
  submitOrders(g, "p3", { turn: g.turn, orders: [cmd] });

// ---------------------------------------------------------------- pillage

test("starve mode: a raider that cannot take the city pillages the farm it stands on", () => {
  const g = field();
  city(g, "p3", 2, 4);
  const enemy = city(g, "p1", 8, 4); // hp 160 vs one spearman: starve mode
  farms(g, enemy);
  const u = addUnit(g, "p3", "spearman", { q: 6, r: 4 });
  assert.ok(tile(g, 6, 4).farm && tile(g, 6, 4).owner === "p1");
  const cmd = order(g, u);
  assert.equal(cmd.action, "pillage");
  assert.doesNotThrow(() => submit(g, cmd)); // legal in the engine
});

test("starve mode: a raider moves onto reachable enemy farmland, then withdraws when nothing is left", () => {
  const g = field();
  const home = city(g, "p3", 2, 4);
  const enemy = city(g, "p1", 8, 4);
  farms(g, enemy);
  addUnit(g, "p3", "cavalry", { q: 5, r: 7 }); // scout: sees the city and farms
  const u = addUnit(g, "p3", "spearman", { q: 4, r: 4 });
  const cmd = order(g, u);
  assert.equal(cmd.action, "move");
  const dest = tile(g, cmd.target.q, cmd.target.r);
  assert.ok(dest.farm && dest.owner === "p1", "moves onto an enemy farm");
  // Farmland gone: the raider standing in hostile territory pulls back home.
  for (const t of g.tiles) t.farm = false;
  u.q = 7;
  u.r = 4;
  const back = order(g, u);
  assert.equal(back.action, "move");
  assert.ok(distance(back.target, home) < distance(u, home));
  assert.ok(tile(g, back.target.q, back.target.r).owner !== "p1");
});

test("siege mode: a healthy unit of a strong army keeps enemy improvements intact", () => {
  const g = field();
  city(g, "p3", 2, 4);
  const enemy = city(g, "p1", 8, 4);
  farms(g, enemy);
  for (const p of [
    { q: 5, r: 3 },
    { q: 5, r: 5 },
    { q: 4, r: 5 },
  ])
    addUnit(g, "p3", "musketeer", p, { size: 2, hp: 200 });
  const u = addUnit(g, "p3", "spearman", { q: 6, r: 4 });
  const cmd = order(g, u);
  assert.notEqual(cmd?.action, "pillage");
});

test("siege mode: a unit below the heal threshold pillages the improvement under it for recovery", () => {
  const g = field();
  city(g, "p3", 2, 4);
  const enemy = city(g, "p1", 8, 4);
  farms(g, enemy);
  for (const p of [
    { q: 5, r: 3 },
    { q: 5, r: 5 },
    { q: 4, r: 5 },
  ])
    addUnit(g, "p3", "musketeer", p, { size: 2, hp: 200 });
  const u = addUnit(g, "p3", "spearman", { q: 6, r: 4 }, { hp: 40 });
  const cmd = order(g, u);
  assert.equal(cmd.action, "pillage");
  submit(g, cmd);
});

test("never pillages a civilization the NPC is not at war with, even when hurt", () => {
  const g = field();
  city(g, "p3", 2, 4);
  const neutral = city(g, "p2", 8, 4); // p2 is not at war with p3
  farms(g, neutral);
  const u = addUnit(g, "p3", "spearman", { q: 6, r: 4 }, { hp: 40 });
  const cmd = order(g, u);
  assert.notEqual(cmd?.action, "pillage");
});

test("no pillage under lethal enemy fire cover", () => {
  const g = field();
  city(g, "p3", 2, 4);
  const enemy = city(g, "p1", 8, 4);
  farms(g, enemy);
  const u = addUnit(g, "p3", "spearman", { q: 6, r: 4 }, { hp: 30 });
  addUnit(g, "p1", "musketeer", { q: 7, r: 3 }, { size: 2, hp: 200 });
  addUnit(g, "p1", "musketeer", { q: 7, r: 5 }, { size: 2, hp: 200 });
  const cmd = order(g, u);
  assert.notEqual(cmd?.action, "pillage");
});

// -------------------------------------------------- ground and engagement

test("firing position prefers hills when the shot is otherwise equal", () => {
  const g = field();
  const u = addUnit(g, "p3", "musketeer", { q: 4, r: 4 });
  addUnit(g, "p3", "cavalry", { q: 3, r: 7 }); // scout: sees the enemy
  addUnit(g, "p1", "spearman", { q: 7, r: 4 });
  tile(g, 5, 5).terrain = "hills";
  const cmd = order(g, u);
  assert.equal(cmd.action, "move");
  assert.ok(equal(cmd.target, { q: 5, r: 5 }), JSON.stringify(cmd.target));
});

test("outgunned unit holds favorable ground instead of stepping next to a superior stack", () => {
  const g = field();
  city(g, "p3", 2, 4);
  tile(g, 4, 4).terrain = "hills";
  const u = addUnit(g, "p3", "spearman", { q: 4, r: 4 });
  addUnit(g, "p3", "cavalry", { q: 4, r: 6 }); // scout: sees the stack
  const foes = [
    addUnit(g, "p1", "spearman", { q: 8, r: 4 }, { size: 2, hp: 200 }),
    addUnit(g, "p1", "spearman", { q: 8, r: 3 }, { size: 2, hp: 200 }),
    addUnit(g, "p1", "spearman", { q: 7, r: 5 }, { size: 2, hp: 200 }),
  ];
  const cmd = order(g, u);
  assert.notEqual(cmd?.action, "attack");
  if (cmd?.action === "move")
    assert.ok(foes.every((e) => distance(e, cmd.target) >= 2));
  else assert.ok([null, "fortify"].includes(cmd?.action ?? null));
});

// ------------------------------------------------------------- defense

test("an empty threatened city is garrisoned by the nearest defender", () => {
  const g = field();
  const home = city(g, "p3", 6, 6);
  addUnit(g, "p1", "spearman", { q: 3, r: 6 }); // 3 tiles from the city, seen by it
  const u = addUnit(g, "p3", "spearman", { q: 9, r: 6 });
  const cmd = order(g, u);
  assert.equal(cmd.action, "move");
  assert.ok(equal(cmd.target, home));
});

test("defenders intercept a raider approaching own farmland", () => {
  const g = field();
  city(g, "p3", 6, 6);
  const farm = tile(g, 6, 2);
  Object.assign(farm, { owner: "p3", farm: true });
  const raider = addUnit(g, "p1", "cavalry", { q: 6, r: 0 });
  addUnit(g, "p3", "cavalry", { q: 9, r: 1 }); // scout: sees the raider
  const u = addUnit(g, "p3", "spearman", { q: 6, r: 6 });
  assert.ok(observe(g, "p3").units.some((x) => x.id === raider.id && x.hostile));
  const cmd = order(g, u);
  assert.equal(cmd.action, "move");
  assert.ok(distance(cmd.target, farm) <= 1, JSON.stringify(cmd.target));
});

// --------------------------------------------------------- key positions

test("takes the hills between home and an approaching threat before contact", () => {
  const g = field();
  city(g, "p3", 6, 6);
  tile(g, 6, 8).terrain = "hills";
  addUnit(g, "p1", "spearman", { q: 6, r: 12 });
  addUnit(g, "p3", "cavalry", { q: 9, r: 9 }); // scout: sees the threat
  const u = addUnit(g, "p3", "spearman", { q: 5, r: 6 });
  const cmd = order(g, u);
  assert.equal(cmd.action, "move");
  assert.ok(equal(cmd.target, { q: 6, r: 8 }), JSON.stringify(cmd.target));
});

// ----------------------------------------------------------- concealment

test("an army that is not ready to strike stays out of the enemy city's vision", () => {
  const g = field();
  city(g, "p3", 0, 4);
  const enemy = city(g, "p1", 8, 4);
  addUnit(g, "p3", "cavalry", { q: 4, r: 7 }); // scout: the city is in view
  const u = addUnit(g, "p3", "spearman", { q: 4, r: 4 });
  assert.ok(observe(g, "p3").cities.some((c) => c.id === enemy.id && c.hostile));
  const cmd = order(g, u);
  if (cmd?.action === "move")
    assert.ok(distance(cmd.target, enemy) > NPC_STRATEGY.CITY_VISION);
  else assert.ok([null, "fortify"].includes(cmd?.action ?? null));
});

// ------------------------------------------------------ growth / buildup

test("idle NPC cities always fill their production queue and start with builders", () => {
  const g = field();
  const a = city(g, "p3", 4, 4);
  const b = city(g, "p3", 12, 4);
  g.turn = 1;
  const plans = npcEconomy(observe(g, "p3"));
  const productions = plans.filter((p) => p.production);
  assert.equal(productions.length, 2);
  for (const c of [a, b])
    assert.ok(productions.some((p) => p.production[0].cityId === c.id));
  assert.ok(productions.some((p) => p.production[0].type === "builder"));
});

test("army buildup scales with a stronger visible neighbour", () => {
  const g = field();
  const c = city(g, "p3", 4, 4);
  addUnit(g, "p3", "builder", { q: 4, r: 4 });
  addUnit(g, "p3", "cavalry", { q: 6, r: 4 });
  for (let i = 0; i < 4; i++)
    addUnit(g, "p2", "musketeer", { q: 9, r: 3 + i }); // neutral but strong
  const plans = npcEconomy(observe(g, "p3"));
  const prod = plans.find((p) => p.production)?.production[0];
  assert.equal(prod.cityId, c.id);
  assert.ok(MILITARY.includes(prod.type), prod.type);
});

// ------------------------------------------------------------ offensives

function rivalWorld({ theirs = 1, ours = 8, wars = [] } = {}) {
  const g = field("p3", wars);
  city(g, "p3", 4, 4);
  const enemy = city(g, "p1", 10, 4);
  farms(g, enemy);
  addUnit(g, "p3", "cavalry", { q: 7, r: 4 }); // sees the enemy city
  const spots = [
    [2, 1], [4, 1], [6, 1], [2, 3], [4, 3], [6, 3], [2, 5], [4, 5],
  ];
  for (let i = 0; i < ours; i++)
    addUnit(g, "p3", "musketeer", { q: spots[i][0], r: spots[i][1] });
  for (let i = 0; i < theirs; i++)
    addUnit(g, "p1", "musketeer", { q: 9 + (i % 3), r: 6 + Math.floor(i / 3) });
  return { g, enemy };
}

test("a clear sustained advantage over an exposed neighbour follows denounce -> formal war -> strike", () => {
  const { g, enemy } = rivalWorld({ theirs: 1, ours: 8 });
  const first = npcDiplomacy(observe(g, "p3"));
  assert.deepEqual(first, { action: "denounce", factionId: "p1" });
  transact(g, "p3", { turn: g.turn, ...first });
  // The denouncement is public; formal war needs the engine's waiting period.
  assert.equal(npcDiplomacy(observe(g, "p3")), null);
  let declared = null;
  for (let round = 0; round < 6 && !declared; round++) {
    g.turn += 1;
    const next = npcDiplomacy(observe(g, "p3"));
    if (next?.action === "declareWar") declared = next;
    else assert.equal(next, null);
  }
  assert.deepEqual(declared, { action: "declareWar", factionId: "p1" });
  transact(g, "p3", { turn: g.turn, ...declared });
  assert.ok(g.wars.includes("p1|p3"));
  // Bounded synthetic march: moves are applied by hand, attacks/pillage count
  // as the strike.  The army masses on the staging ring and then closes in.
  let strike = null;
  const army = () => g.units.filter((u) => u.owner === "p3" && MILITARY.includes(u.type));
  const before = Math.min(...army().map((u) => distance(u, enemy)));
  for (let round = 0; round < 8 && !strike; round++) {
    for (const u of army()) {
      u.movesLeft = 10;
      u.acted = false;
      u.attackUsed = false;
      const cmd = order(g, u);
      if (!cmd) continue;
      if (cmd.action === "move") Object.assign(u, cmd.target);
      else if (["attack", "bombard", "pillage"].includes(cmd.action)) strike = cmd;
    }
  }
  const after = Math.min(...army().map((u) => distance(u, enemy)));
  assert.ok(strike || after < before, `strike=${JSON.stringify(strike)} before=${before} after=${after}`);
  assert.ok(after <= 2 || strike, `army closed to ${after}`);
});

test("a stronger neighbour never triggers denouncement or war", () => {
  const { g } = rivalWorld({ theirs: 8, ours: 5 });
  assert.equal(npcDiplomacy(observe(g, "p3")), null);
});

test("without clear advantage or justification an NPC stays at peace over a long run", () => {
  const { g } = rivalWorld({ theirs: 5, ours: 6 });
  for (let turn = 6; turn <= 60; turn++) {
    g.turn = turn;
    const action = npcDiplomacy(observe(g, "p3"));
    assert.ok(
      !action || !["denounce", "declareWar"].includes(action.action),
      `turn ${turn}: ${JSON.stringify(action)}`,
    );
  }
  assert.equal(g.wars.length, 0);
});

// ------------------------------------------------------------- expansion

function runRounds(g, rounds) {
  for (let i = 0; i < rounds; i++) {
    resolveTurn(g, 0);
    resolveTurn(g, 0);
  }
}

test("an NPC with open land and gold founds at least three cities within twenty rounds", () => {
  const g = field("p3", []);
  city(g, "p3", 6, 6);
  g.gold.p3 = 300;
  addUnit(g, "p3", "spearman", { q: 6, r: 6 });
  addUnit(g, "p3", "builder", { q: 6, r: 6 });
  runRounds(g, 20);
  const own = g.cities.filter((c) => c.owner === "p3");
  assert.ok(own.length >= 3, `founded ${own.length} cities`);
  assert.ok(own.every((c) => c.hp > 0));
});

test("a rich NPC buys a settler outright instead of waiting for production", () => {
  const g = field("p3", []);
  const c = city(g, "p3", 6, 6);
  g.gold.p3 = 300;
  g.turn = 40; // restored mid-game: the land is already known
  addUnit(g, "p3", "spearman", { q: 7, r: 6 });
  g.explored.p3 = Object.fromEntries(
    g.tiles.map((t) => [`${t.q},${t.r}`, { ...t }]),
  );
  const plans = npcEconomy(observe(g, "p3"));
  const buy = plans.find((p) => p.transaction?.action === "buyUnit");
  assert.ok(buy, JSON.stringify(plans));
  assert.equal(buy.transaction.type, "settler");
  assert.equal(buy.transaction.cityId, c.id);
  assert.doesNotThrow(() => transact(g, "p3", { turn: g.turn, ...buy.transaction }));
  assert.ok(g.units.some((u) => u.owner === "p3" && u.type === "settler"));
});

test("an escorted settler settles instead of oscillating between sites", () => {
  const g = field("p3", []);
  city(g, "p3", 4, 4);
  g.gold.p3 = 0;
  addUnit(g, "p3", "settler", { q: 6, r: 4 });
  addUnit(g, "p3", "spearman", { q: 6, r: 5 });
  runRounds(g, 8);
  assert.equal(g.cities.filter((c) => c.owner === "p3").length, 2);
  assert.ok(!g.units.some((u) => u.owner === "p3" && u.type === "settler"));
});

test("expansion respects the city cap", () => {
  const g = field("p3", []);
  for (let i = 0; i < NPC_STRATEGY.MAX_CITIES; i++) city(g, "p3", 2 + (i % 4) * 4, 3 + Math.floor(i / 4) * 6);
  g.gold.p3 = 500;
  addUnit(g, "p3", "spearman", { q: 2, r: 3 });
  const plans = npcEconomy(observe(g, "p3"));
  assert.ok(!plans.some((p) => p.transaction?.type === "settler"));
  assert.ok(!plans.some((p) => p.production?.[0].type === "settler"));
});

// ------------------------------------------------------------ formations

test("four battalions form a division within a few rounds", () => {
  const g = field("p3", []);
  city(g, "p3", 4, 4);
  for (const p of [
    { q: 4, r: 4 },
    { q: 5, r: 4 },
    { q: 4, r: 5 },
    { q: 3, r: 5 },
  ])
    addUnit(g, "p3", "spearman", p);
  runRounds(g, 6);
  const spears = g.units.filter((u) => u.owner === "p3" && u.type === "spearman");
  assert.ok(spears.some((u) => u.size === 4), spears.map((u) => u.size).join(","));
});

test("a defending NPC forms at least a brigade at the threatened city", () => {
  const g = field("p3", ["p1|p3"]);
  const home = city(g, "p3", 6, 6);
  g.gold.p3 = 0; // no settler purchases pulling escorts away
  addUnit(g, "p3", "spearman", { q: 6, r: 6 });
  addUnit(g, "p3", "spearman", { q: 7, r: 6 });
  addUnit(g, "p1", "spearman", { q: 6, r: 10 }, { size: 2, hp: 200 });
  addUnit(g, "p3", "cavalry", { q: 8, r: 8 }); // scout keeps the threat in view
  runRounds(g, 2);
  const near = g.units.filter(
    (u) => u.owner === "p3" && u.type === "spearman" && distance(u, home) <= 1,
  );
  assert.ok(near.some((u) => u.size >= 2), near.map((u) => `${u.size}@${u.q},${u.r}`).join(" "));
});
