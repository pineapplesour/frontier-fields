import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createGame,
  addUnit,
  observe,
  submitOrders,
  resolveTurn,
  transact,
  setSettings,
  advanceDue,
  updateSupply,
  farmYield,
  relation,
} from "../server/engine.mjs";
import {
  WIDTH,
  HEIGHT,
  fromOffset,
  neighbors,
  distance,
  equal,
  key,
  findRoute,
  reachable,
  cityMaxHealth,
  productionType,
} from "../shared/rules.js";
import { combatPreview, riverBetween } from "../shared/combat.js";
import {
  buildWorld,
  buildHighlights,
  rangeBoundary,
  disposeGroup,
  worldPoint,
} from "../src/world3d.js";
import { makeMotion, makeRoute, combatTiming } from "../src/motion3d.js";
import { npcEconomy, npcUnitOrder } from "../server/npc.mjs";
function field() {
  const g = createGame();
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  g.contacts = {};
  g.wars = ["p1|p2"];
  for (const t of g.tiles)
    Object.assign(t, {
      terrain: "plains",
      owner: null,
      cityId: null,
      resource: null,
      farm: false,
      developed: false,
      camp: false,
      fertility: 2,
    });
  g.random = () => 0.5;
  return g;
}
const order = (g, u, action, extra = {}) =>
  submitOrders(g, u.owner, {
    turn: g.turn,
    orders: [{ unitId: u.id, action, ...extra }],
  });
const trade = (g, player, action, extra = {}) =>
  transact(g, player, { turn: g.turn, action, ...extra });
const tile = (g, p) => g.tiles.find((t) => equal(t, p));
const round = (g) => {
  resolveTurn(g);
  resolveTurn(g);
};

test("20x20 world has four capitals, independent city states and destructible camps", () => {
  const g = createGame();
  assert.equal(g.tiles.length, 400);
  assert.equal(WIDTH, 20);
  assert.equal(HEIGHT, 20);
  assert.deepEqual(
    g.cities
      .filter((c) => c.capital)
      .map((c) => c.owner)
      .sort(),
    ["p1", "p2", "p3", "p4"],
  );
  assert.ok(g.cities.some((c) => c.owner === "cs"));
  assert.equal(g.cities.filter((c) => c.camp).length, 3);
});
test("flat map: no east/west wrap for adjacency, distance, routes, sight, rivers or farm adjacency", () => {
  const g = field(),
    a = fromOffset(0, 8),
    b = fromOffset(19, 8),
    u = addUnit(g, "p1", "spearman", a);
  // Host rule 2026-09-06: the world is a bounded board, not a cylinder.
  assert.equal(observe(g, "p1").world.wrapX, false);
  assert.ok(!neighbors(a).some((p) => p.q === 19));
  assert.ok(!neighbors(b).some((p) => equal(p, a)));
  assert.ok(neighbors(a).some((p) => p.q === -1 && !g.tiles.some((t) => equal(t, p))));
  assert.equal(distance(a, b), 19);
  assert.ok(!observe(g, "p1").tiles.find((t) => equal(t, b)).visible);
  const view = observe(g, "p1"),
    path = findRoute(view, u, b);
  assert.ok(path.length >= 19, "A route to the far column crosses the whole map");
  assert.ok(!reachable(view.tiles, u, view.units, "p1").has(key(b)));
  assert.ok(!riverBetween(g, a, b));
  tile(g, a).farm = tile(g, b).farm = true;
  tile(g, a).owner = tile(g, b).owner = "p1";
  assert.equal(farmYield(g, tile(g, a)).adjacent, 0);
  const east = fromOffset(1, 8);
  assert.equal(distance(a, east), 1);
  assert.ok(distance(fromOffset(5, 0), fromOffset(5, 19)) > 1);
  assert.ok(!g.tiles.some((t) => equal(t, fromOffset(0, -1))));
  assert.ok(!g.tiles.some((t) => equal(t, { q: -1, r: a.r })));
});
test("unexplored observation and renderer cannot reveal terrain, fertility, resource or river layout", () => {
  const g = field(),
    u = addUnit(g, "p1", "spearman", fromOffset(2, 4)),
    hidden = fromOffset(10, 14);
  tile(g, hidden).terrain = "mountain";
  tile(g, hidden).resource = "niter";
  tile(g, hidden).fertility = 999;
  g.rivers = [{ a: hidden, b: neighbors(hidden)[0] }];
  const v = observe(g, "p1"),
    t = v.tiles.find((t) => equal(t, hidden));
  assert.equal(t.terrain, "unknown");
  assert.equal(t.fertility, null);
  assert.equal(t.resource, null);
  assert.equal(v.rivers.length, 0);
  const known = neighbors(u)[0];
  tile(g, known).terrain = "hills";
  observe(g, "p1");
  Object.assign(u, fromOffset(14, 15));
  tile(g, known).owner = "p2";
  tile(g, known).farm = true;
  const memory = observe(g, "p1").tiles.find((t) => equal(t, known));
  assert.equal(memory.terrain, "hills");
  assert.equal(memory.owner, null);
  assert.equal(memory.farm, false);
  assert.equal(memory.stale, true);
});
test("builder and military share a slot; same class blocks; production uses compatible city slot", () => {
  const g = field(),
    a = addUnit(g, "p1", "builder", { q: 2, r: 3 }),
    b = addUnit(g, "p1", "spearman", { q: 3, r: 3 });
  order(g, a, "move", { target: { q: b.q, r: b.r } });
  assert.ok(equal(a, b));
  const c = addUnit(g, "p1", "cavalry", { q: 4, r: 3 });
  assert.throws(() => order(g, c, "move", { target: { q: b.q, r: b.r } }));
  const h = createGame(),
    city = h.cities.find((c) => c.owner === "p1"),
    guard = h.units.find((u) => u.owner === "p1" && u.type === "spearman");
  Object.assign(guard, { q: city.q, r: city.r });
  submitOrders(h, "p1", {
    turn: 1,
    production: [{ cityId: city.id, type: "builder" }],
  });
  for (let i = 0; i < 3; i++) round(h);
  assert.ok(h.units.some((u) => equal(u, city) && u.type === "builder"));
  assert.ok(h.units.some((u) => u.id === guard.id && equal(u, city)));
});
test("wall levels require population production, grant HP and city fire is visible, ranged and once per turn", () => {
  const g = createGame(),
    c = g.cities.find((c) => c.owner === "p1");
  submitOrders(g, "p1", {
    turn: 1,
    production: [{ cityId: c.id, type: "walls" }],
  });
  assert.equal(c.wallLevel, 0);
  const rate = observe(g, "p1").cities.find(
    (x) => x.id === c.id,
  ).productionRate;
  assert.equal(rate, 7, "Wall production includes assigned citizen production");
  for (let i = 0; i < 5; i++) round(g);
  assert.equal(c.wallLevel, 1);
  assert.equal(cityMaxHealth(c), 160);
  assert.equal(c.hp, 160);
  assert.equal(c.wallHp, 50, "Walls add a separate health pool, not city body HP");
  g.wars.push("p1|p2");
  const p = neighbors(c).find(
    (p) => tile(g, p) && !g.units.some((u) => equal(u, p)),
  );
  const e = addUnit(g, "p2", "spearman", p);
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ cityId: c.id, action: "cityBombard", target: p }],
  });
  assert.ok(e.hp < 100);
  assert.equal(c.attackUsed, true);
  assert.throws(() =>
    submitOrders(g, "p1", {
      turn: g.turn,
      orders: [{ cityId: c.id, action: "cityBombard", target: p }],
    }),
  );
  assert.ok(observe(g, "p1").effects.some((e) => e.kind === "bombard"));
  c.wallLevel = 3;
  assert.throws(() =>
    submitOrders(g, "p1", {
      turn: g.turn,
      production: [{ cityId: c.id, type: "walls" }],
    }),
  );
  assert.equal(productionType("walls", { wallLevel: 1 }).cost, 55);
});
test("pause freezes deadline and orders globally; only p1 can resume and exact remaining time is restored", () => {
  const g = createGame({ now: 1000 }),
    u = g.units.find((u) => u.owner === "p1");
  setSettings(g, "p1", { paused: true }, 21000);
  assert.equal(g.pausedRemaining, 40000);
  advanceDue(g, 999999);
  assert.equal(g.turn, 1);
  assert.equal(g.activePlayer, "p1");
  assert.throws(() => setSettings(g, "p2", { paused: false }, 999999));
  assert.throws(() =>
    submitOrders(
      g,
      "p1",
      { turn: 1, orders: [{ unitId: u.id, action: "fortify" }] },
      999999,
    ),
  );
  setSettings(g, "p1", { paused: false }, 1000000);
  assert.equal(g.deadline, 1040000);
  advanceDue(g, 1039999);
  assert.equal(g.activePlayer, "p1");
  advanceDue(g, 1040000);
  assert.equal(g.activePlayer, "p2");
});
test("forecast uses exact attack formula and shows hill, river, fortification, counters and random interval", () => {
  const g = field(),
    a = addUnit(g, "p1", "spearman", { q: 2, r: 3 }),
    b = addUnit(g, "p2", "cavalry", { q: 3, r: 3 }, { fortified: true });
  tile(g, b).terrain = "hills";
  g.rivers = [{ a: { q: a.q, r: a.r }, b: { q: b.q, r: b.r } }];
  const preview = combatPreview(observe(g, "p1"), a, { ...b, hostile: true });
  assert.ok(preview.reasons.some((r) => r.includes("구릉")));
  assert.ok(preview.reasons.some((r) => r.includes("강")));
  assert.ok(preview.reasons.some((r) => r.includes("상성")));
  assert.ok(preview.reasons.some((r) => r.includes("방어 태세")));
  order(g, a, "attack", { target: { q: b.q, r: b.r } });
  const dealt = 100 - b.hp,
    received = 100 - a.hp;
  assert.ok(dealt >= preview.dealt[0] && dealt <= preview.dealt[1]);
  assert.ok(received >= preview.received[0] && received <= preview.received[1]);
  assert.equal(
    observe(g, "p1").effects.filter((e) => e.kind === "damage").length,
    2,
  );
});
test("defeated camps remain capturable and keep adjacent spawns; observation-only NPCs develop farms and production", () => {
  const g = createGame(),
    camp = g.cities.find((c) => c.camp);
  g.units = g.units.filter((u) => !equal(u, camp));
  camp.hp = 1;
  const a = addUnit(
    g,
    "p1",
    "artillery",
    neighbors(camp).find(
      (p) => tile(g, p) && !g.units.some((u) => equal(u, p)),
    ),
  );
  tile(g, a).terrain = "plains";
  order(g, a, "bombard", { target: { q: camp.q, r: camp.r } });
  assert.ok(g.cities.some((c) => c.id === camp.id));
  assert.equal(camp.hp, 0, "Bombardment defeats the camp without erasing the site");
  assert.equal(tile(g, camp).camp, true);
  const occupier = addUnit(g, "p1", "spearman", neighbors(camp).find((p) => tile(g, p) && !g.units.some((u) => equal(u, p))));
  tile(g, occupier).terrain = "plains";
  order(g, occupier, "move", { target: { q: camp.q, r: camp.r } });
  assert.equal(camp.owner, "p1", "Melee troops can occupy the defeated site");
  assert.equal(tile(g, camp).owner, "p1");
  for (let i = 0; i < 5; i++) round(g);
  assert.ok(g.units.some((u) => u.owner === "barb" && equal(u.home, camp)), "Occupied sites retain barbarian reinforcement pressure on surrounding neutral land");
  assert.ok(
    g.tiles.filter((t) => ["p3", "p4"].includes(t.owner) && t.farm).length > 4,
  );
  assert.ok(
    g.cities
      .filter((c) => ["p3", "p4"].includes(c.owner))
      .some((c) => c.population > 4),
  );
  const v = observe(g, "p3");
  assert.ok(v.tiles.some((t) => t.terrain === "unknown"));
  assert.deepEqual(
    npcEconomy(structuredClone(v)),
    npcEconomy(structuredClone(v)),
  );
  const id = v.units.find((u) => u.owner === "p3").id;
  assert.deepEqual(
    npcUnitOrder(structuredClone(v), id),
    npcUnitOrder(structuredClone(v), id),
  );
});
test("parchment surfaces are separated so zoom cannot z-fight; ranges contain only outside boundary edges", () => {
  const v = observe(createGame(), "p1"),
    world = buildWorld(v),
    unknown = v.tiles.find((t) => t.terrain === "unknown"),
    hex = world.children.find(
      (m) => m.isInstancedMesh && m.geometry.type === "CylinderGeometry",
    ),
    tops = [],
    m = new THREE.Matrix4(),
    p = new THREE.Vector3(),
    q = new THREE.Quaternion(),
    s = new THREE.Vector3();
  hex.userData.points.forEach((t, i) => {
    if (equal(t, unknown)) {
      hex.getMatrixAt(i, m);
      m.decompose(p, q, s);
      tops.push(p.y + s.y / 2);
    }
  });
  tops.sort((a, b) => b - a);
  assert.ok(tops[0] - tops[1] > 0.04);
  const u = v.units.find((u) => u.type === "cavalry"),
    h = buildHighlights(v, u, u, "inspect", null);
  assert.ok(h.userData.movement);
  assert.ok(h.userData.attack);
  for (const area of ["movement", "attack"]) {
    const set = new Set(h.userData[area].tiles);
    assert.ok(h.userData[area].edges.every((e) => !set.has(e.neighbor)));
  }
  // Cavalry now reaches six MP, so disconnected boundary chains may exceed
  // the old fixed mesh count. Assert contour geometry, not old range size.
  const contours = h.children.filter(mesh => mesh.userData.range);
  assert.ok(contours.length > 0);
  const edgeCount = ["movement", "attack"].reduce((sum, type) => sum + h.userData[type].edges.length, 0);
  assert.ok(contours.length <= edgeCount * 2);
  for (const mesh of contours) {
    assert.equal(mesh.geometry.type, "TubeGeometry");
    assert.equal(mesh.material.depthWrite, false);
    assert.ok([...mesh.geometry.attributes.position.array].every(Number.isFinite));
  }
  disposeGroup(world);
  disposeGroup(h);
});
test("cavalry has no thrown projectile; builders hammer even on their consumed last charge", () => {
  const g = field(),
    a = addUnit(g, "p1", "cavalry", { q: 2, r: 3 }),
    b = addUnit(g, "p2", "spearman", { q: 3, r: 3 });
  order(g, a, "attack", { target: { q: b.q, r: b.r } });
  const v = observe(g, "p1"),
    motion = makeMotion(v, 0),
    pose = motion.update(325).poses.get(a.id);
  assert.ok(pose.position.distanceTo(worldPoint(a)) > 0.2);
  assert.ok(
    v.effects.some((e) => e.kind === "attack" && e.unitType === "cavalry"),
  );
  disposeGroup(motion.group);
  const h = field(),
    u = addUnit(h, "p1", "builder", { q: 3, r: 3 }, { charges: 1 });
  tile(h, u).owner = "p1";
  order(h, u, "farm");
  const hv = observe(h, "p1"),
    world = buildWorld(hv),
    work = makeMotion(hv, 0);
  assert.ok(!hv.units.some((x) => x.id === u.id));
  assert.ok(world.userData.actors.has(u.id));
  assert.ok(Math.abs(work.update(200).poses.get(u.id).work) > 0.01);
  assert.equal(work.update(2200).poses.get(u.id).scale, 0);
  disposeGroup(world);
  disposeGroup(work.group);
});
test("war declaration is broadcast to every civilization and does not disclose geography", () => {
  const g = createGame();
  trade(g, "p1", "declareWar", { factionId: "p2" });
  for (const p of ["p1", "p2", "p3", "p4", "cs", "barb"]) {
    const v = observe(g, p);
    assert.equal(v.announcements.at(-1).type, "war");
    assert.equal(v.announcements.at(-1).from, "p1");
    assert.ok(!Object.hasOwn(v.announcements.at(-1), "q"));
  }
});
test("combined city/unit/resource/alliance/war deal escrows, requires partner consent, and settles atomically", () => {
  const g = createGame(),
    city = g.cities.find((c) => c.owner === "p1"),
    u = g.units.find((u) => u.owner === "p1" && u.type === "cavalry");
  trade(g, "p1", "offerDeal", {
    factionId: "p2",
    give: {
      gold: 20,
      resources: { iron: 1 },
      units: [u.id],
      cities: [city.id],
    },
    receive: { gold: 10, warAgainst: "p3" },
    alliance: true,
  });
  const p = g.proposals[0];
  assert.equal(g.gold.p1, 100);
  assert.equal(g.stockpiles.p1.iron, 2);
  assert.equal(u.owner, "p1");
  assert.equal(city.owner, "p1");
  assert.equal(relation(g, "p2", "p3"), "neutral");
  assert.equal(relation(g, "p1", "p2"), "neutral");
  g.activePlayer = "p2";
  trade(g, "p2", "acceptProposal", { proposalId: p.id });
  assert.equal(u.owner, "p2");
  assert.equal(u.movesLeft, 0);
  assert.equal(city.owner, "p2");
  assert.ok(
    g.tiles.filter((t) => t.cityId === city.id).every((t) => t.owner === "p2"),
  );
  assert.equal(g.gold.p1, 110);
  assert.equal(g.gold.p2, 130);
  assert.equal(g.stockpiles.p2.iron, 4);
  assert.equal(relation(g, "p1", "p2"), "alliance");
  assert.equal(relation(g, "p2", "p3"), "war");
  assert.equal(g.proposals.length, 0);
});
test("rejected deals return exact escrow and invalid acceptance never partially transfers assets", () => {
  const g = createGame(),
    u = g.units.find((u) => u.owner === "p1" && u.type === "cavalry");
  trade(g, "p1", "offerDeal", {
    factionId: "p2",
    give: { gold: 17, resources: { horses: 2 }, units: [u.id] },
    receive: { gold: 9999 },
  });
  const p = g.proposals[0];
  g.activePlayer = "p2";
  assert.throws(() => trade(g, "p2", "acceptProposal", { proposalId: p.id }));
  assert.equal(u.owner, "p1");
  assert.equal(g.gold.p1, 103);
  trade(g, "p2", "rejectProposal", { proposalId: p.id });
  assert.equal(g.gold.p1, 120);
  assert.equal(g.stockpiles.p1.horses, 3);
  assert.equal(g.proposals.length, 0);
});
test("treaties block paid joint-war proposals; self joining can be traded for counterpart resources", () => {
  const g = createGame();
  g.peaceUntil["p2|p3"] = 10;
  assert.throws(() =>
    trade(g, "p1", "offerDeal", {
      factionId: "p2",
      give: { gold: 80 },
      receive: { warAgainst: "p3" },
    }),
  );
  assert.equal(g.gold.p1, 120);
  trade(g, "p1", "offerDeal", {
    factionId: "p2",
    give: { warAgainst: "p4" },
    receive: { resources: { niter: 2 } },
  });
  g.activePlayer = "p2";
  trade(g, "p2", "acceptProposal", { proposalId: g.proposals[0].id });
  assert.equal(relation(g, "p1", "p4"), "war");
  assert.equal(g.stockpiles.p1.niter, 5);
  assert.equal(g.stockpiles.p2.niter, 1);
});
