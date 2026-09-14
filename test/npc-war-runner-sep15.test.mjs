// War behaviour driven through the real NPC turn runner (turn-based
// resolveTurn and simultaneous realtime advanceDue), plus staging commit,
// city-state raiding and the decision trace.  All states are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  observe,
  resolveTurn,
  startGame,
  advanceDue,
} from "../server/engine.mjs";
import { distance } from "../shared/rules.js";
import { npcUnitOrder, npcDecisionLog, NPC_STRATEGY } from "../server/npc.mjs";

function plainsCity(g, owner, q, r, extra = {}) {
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
function flatten(g) {
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
}
const farmsAround = (g, c) =>
  g.tiles.filter((t) => {
    if (distance(t, c) >= 1 && distance(t, c) <= 2 && t.owner === c.owner) {
      t.farm = true;
      return true;
    }
    return false;
  });
const damageDone = (g, before) =>
  before.some((b) => {
    const u = g.units.find((x) => x.id === b.id);
    return !u || u.hp < b.hp;
  });

test("turn-based runner: an NPC at war pillages or attacks the human's exposed assets within three rounds", () => {
  const g = createGame();
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  g.contacts = {};
  g.random = () => 0.5;
  flatten(g);
  plainsCity(g, "p3", 2, 6);
  const human = plainsCity(g, "p1", 10, 6);
  const farms = farmsAround(g, human);
  const victim = addUnit(g, "p1", "spearman", { q: 7, r: 6 }, { hp: 30 });
  addUnit(g, "p3", "cavalry", { q: 5, r: 8 });
  for (const p of [
    { q: 4, r: 6 },
    { q: 4, r: 7 },
    { q: 5, r: 5 },
  ])
    addUnit(g, "p3", "musketeer", p);
  g.wars = ["p1|p3"];
  g.warStarted = { "p1|p3": g.turn };
  const before = g.units.filter((u) => u.owner === "p1").map((u) => ({ id: u.id, hp: u.hp }));
  for (let round = 0; round < 3; round++) {
    resolveTurn(g, 0);
    resolveTurn(g, 0);
  }
  const pillaged = farms.some((t) => t.ruin);
  assert.ok(
    pillaged || damageDone(g, before),
    `pillaged=${pillaged} victimHp=${g.units.find((u) => u.id === victim.id)?.hp ?? "dead"}`,
  );
});

test("realtime runner: rate-limited NPC steps still move, attack and pillage inside one simultaneous turn", () => {
  const g = createGame({
    mode: "duel",
    rulesVersion: "expansion-v1",
    turnMode: "simultaneous",
    now: 1000,
    seats: [
      { id: "p1", controller: "human" },
      { id: "p2", controller: "human" },
      { id: "p3", controller: "npc" },
    ],
  });
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.wars = [];
  flatten(g);
  g.players.p2.connected = true;
  addUnit(g, "p2", "spearman", { q: 18, r: 18 });
  plainsCity(g, "p3", 2, 6);
  const human = plainsCity(g, "p1", 10, 6);
  const farms = farmsAround(g, human);
  const victim = addUnit(g, "p1", "spearman", { q: 7, r: 6 }, { hp: 30 });
  addUnit(g, "p3", "cavalry", { q: 5, r: 8 });
  for (const p of [
    { q: 4, r: 6 },
    { q: 4, r: 7 },
    { q: 5, r: 5 },
  ])
    addUnit(g, "p3", "musketeer", p);
  startGame(g, 1000);
  g.wars = ["p1|p3"];
  g.warStarted = { "p1|p3": g.turn };
  const before = g.units.filter((u) => u.owner === "p1").map((u) => ({ id: u.id, hp: u.hp }));
  const positions = new Map(g.units.filter((u) => u.owner === "p3").map((u) => [u.id, { q: u.q, r: u.r }]));
  for (let now = 2000; now <= 30000; now += 1000) advanceDue(g, now);
  const moved = [...positions].some(([id, p]) => {
    const u = g.units.find((x) => x.id === id);
    return u && (u.q !== p.q || u.r !== p.r);
  });
  const pillaged = farms.some((t) => t.ruin);
  assert.ok(moved, "NPC units moved during the realtime turn");
  assert.ok(
    pillaged || damageDone(g, before),
    `pillaged=${pillaged} victimHp=${g.units.find((u) => u.id === victim.id)?.hp ?? "dead"}`,
  );
});

function stagingWorld(warAge) {
  const g = createGame();
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  g.contacts = {};
  g.random = () => 0.5;
  g.turn = 12;
  flatten(g);
  plainsCity(g, "p3", 0, 6);
  const enemy = plainsCity(g, "p1", 8, 6);
  addUnit(g, "p3", "cavalry", { q: 4, r: 9 }); // keeps the city in view
  const u = addUnit(g, "p3", "musketeer", { q: 4, r: 6 }, { size: 2, hp: 200 });
  g.wars = ["p1|p3"];
  g.warStarted = { "p1|p3": g.turn - warAge };
  return { g, enemy, u };
}

test("staging is bounded: after STAGING_MAX_TURNS the army commits when it still has an edge", () => {
  const fresh = stagingWorld(0);
  const hold = npcUnitOrder(observe(fresh.g, "p3"), fresh.u.id);
  if (hold?.action === "move")
    assert.ok(distance(hold.target, fresh.enemy) > NPC_STRATEGY.CITY_VISION, "fresh war: stays hidden");
  const old = stagingWorld(NPC_STRATEGY.STAGING_MAX_TURNS + 1);
  const go = npcUnitOrder(observe(old.g, "p3"), old.u.id);
  assert.ok(go, "old war: acts");
  assert.ok(
    ["attack", "bombard"].includes(go.action) ||
      (go.action === "move" && distance(go.target, old.enemy) < distance(old.u, old.enemy)),
    JSON.stringify(go),
  );
});

test("a city-state at war raids the adjacent enemy farm and attacks a weak neighbour", () => {
  const g = createGame();
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  g.contacts = {};
  g.random = () => 0.5;
  g.turn = 10;
  flatten(g);
  plainsCity(g, "cs", 4, 6);
  const human = plainsCity(g, "p1", 9, 6);
  farmsAround(g, human);
  g.wars = ["cs|p1"];
  g.warStarted = { "cs|p1": 8 };
  const raider = addUnit(g, "cs", "spearman", { q: 7, r: 6 }); // on a p1 farm
  const raid = npcUnitOrder(observe(g, "cs"), raider.id);
  assert.equal(raid?.action, "pillage", JSON.stringify(raid));
  const weak = addUnit(g, "p1", "spearman", { q: 6, r: 5 }, { hp: 5 });
  const fighter = addUnit(g, "cs", "spearman", { q: 5, r: 5 });
  const strike = npcUnitOrder(observe(g, "cs"), fighter.id);
  assert.equal(strike?.action, "attack");
  assert.ok(strike.target.q === weak.q && strike.target.r === weak.r);
});

test("decision trace records mode, target and action for each NPC unit decision", () => {
  npcDecisionLog.length = 0;
  const { g, enemy, u } = stagingWorld(0);
  npcUnitOrder(observe(g, "p3"), u.id);
  const entry = npcDecisionLog.at(-1);
  assert.equal(entry.player, "p3");
  assert.equal(entry.unitId, u.id);
  assert.equal(entry.target, enemy.id);
  assert.ok(["starve", "siege", "raid"].includes(entry.mode));
  assert.ok(typeof entry.action === "string" && typeof entry.why === "string");
});
