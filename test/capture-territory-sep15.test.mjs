import test from "node:test";
import assert from "node:assert/strict";
import { createGame, addUnit, startGame, resolveTurn, transact, economy } from "../server/engine.mjs";
import { key, equal, neighbors, distance } from "../shared/rules.js";

// Synthetic flat map: p1 "home" (4,6) and p2 "colony" (8,6) plus p2 "far" (13,6).
// Colony's land forms a ring around it and a two-tile string reaching toward
// far; a p2 orphan at (11,3) is registered to colony but touches none of it.
function fixture(rulesVersion = "expansion-v1") {
  const g = createGame({ mode: "duel", rulesVersion, turnMode: "simultaneous", now: 1000,
    seats: [{ id: "p1", controller: "human" }, { id: "p2", controller: "human" }] });
  g.units = []; g.cities = []; g.rivers = []; g.wars = ["p1|p2"];
  for (const t of g.tiles) Object.assign(t, { terrain: "plains", fertility: 2, owner: null, cityId: null, farm: false, resource: null, developed: false, ruin: null, fort: null, feature: null });
  g.players.p2.connected = true;
  const city = (id, owner, q, r) => {
    const c = { id, name: id, owner, q, r, hp: 160, population: 3, production: 0, queue: null, food: 20, growthProgress: 0,
      capital: false, isolation: 0, wallLevel: 0, wallHp: 0, territoryRadius: 1, territoryGrowth: 0,
      citizenPolicy: { auto: true, lockedSlots: [], priority: [] } };
    g.cities.push(c); Object.assign(g.tiles.find(t => equal(t, c)), { owner, cityId: id }); return c;
  };
  const at = (q, r) => g.tiles.find(t => t.q === q && t.r === r);
  const home = city("home", "p1", 4, 6), colony = city("colony", "p2", 8, 6), far = city("far", "p2", 13, 6);
  for (const n of neighbors(home)) Object.assign(at(n.q, n.r), { owner: "p1", cityId: "home" });
  for (const n of neighbors(colony)) Object.assign(at(n.q, n.r), { owner: "p2", cityId: "colony" });
  for (const n of neighbors(far)) Object.assign(at(n.q, n.r), { owner: "p2", cityId: "far" });
  Object.assign(at(10, 6), { owner: "p2", cityId: "colony", farm: true }); // string toward far, touches (9,6) and far's ring (11,6)? no: (11,6) is far's ring only if adjacent to (13,6)
  Object.assign(at(11, 6), { owner: "p2", cityId: "colony" });              // continues the string; adjacent to far's ring (12,6)
  Object.assign(at(11, 3), { owner: "p2", cityId: "colony" });              // orphan registered to colony, isolated
  Object.assign(at(7, 6), { farm: true });                                  // colony ring farm
  g.founded = { p1: true, p2: true };
  startGame(g, 1000);
  return { g, at, home, colony, far };
}
const connectedToCity = (g, owner, tile) => {
  const cities = g.cities.filter(c => c.owner === owner);
  const seen = new Set(cities.map(key)), queue = [...cities];
  for (let i = 0; i < queue.length; i++)
    for (const n of neighbors(queue[i])) {
      const t = g.tiles.find(x => equal(x, n));
      if (t && t.owner === owner && !seen.has(key(t))) { seen.add(key(t)); queue.push(t); }
    }
  return seen.has(key(tile));
};
const assertNoEnclaves = (g) => {
  for (const owner of ["p1", "p2"])
    for (const t of g.tiles.filter(t => t.owner === owner)) {
      assert.ok(connectedToCity(g, owner, t), `${owner} tile ${key(t)} is disconnected`);
      assert.ok(g.cities.some(c => c.id === t.cityId && c.owner === owner), `${owner} tile ${key(t)} has stale cityId ${t.cityId}`);
    }
};

test("city capture transfers all of the city's land, drops the old owner's enclaves and leaves no floating captor land", () => {
  const { g, at, colony } = fixture();
  colony.hp = 0;
  addUnit(g, "p1", "spearman", { q: 8, r: 6 });
  const farmBefore = economy(g, "p2").perCity.find(c => c.id === "colony");
  assert.ok(farmBefore);
  resolveTurn(g, 2000);
  assert.equal(colony.owner, "p1");
  for (const n of neighbors(colony)) { const t = at(n.q, n.r); assert.equal(t.owner, "p1"); assert.equal(t.cityId, "colony"); }
  // Colony's string is colony land connected to it, so it changes hands too.
  assert.equal(at(11, 6).owner, "p1"); assert.equal(at(11, 6).cityId, "colony");
  assert.equal(at(10, 6).owner, "p1"); assert.equal(at(10, 6).cityId, "colony");
  assert.equal(at(10, 6).farm, true);
  // far's own ring is untouched.
  for (const n of neighbors(g.cities.find(c => c.id === "far"))) assert.equal(at(n.q, n.r).owner, "p2");
  // The isolated orphan registered to colony is gone for both sides.
  assert.equal(at(11, 3).owner, null); assert.equal(at(11, 3).cityId, null);
  assert.equal(at(7, 6).farm, true);
  assertNoEnclaves(g);
  const p1 = economy(g, "p1").perCity.find(c => c.id === "colony");
  assert.ok(p1, "captor economy lists the captured city");
  assert.ok(g.tiles.filter(t => t.owner === "p1" && t.cityId === "colony" && t.farm).length >= 1);
  const msg = g.events.p2.map(e => e.text).join("\n");
  assert.match(msg, /colony 도시가 점령됐어요\. 영토 \d+칸이 함께 넘어갔어요/);
  assert.match(msg, /무주지가 됐어요/);
});

test("capture transfers a tile the old owner held with no explicit cityId when the city was its nearest administrator", () => {
  const { g, at, colony } = fixture("legacy");
  Object.assign(at(6, 6), { owner: "p2", cityId: null }); // adjacent to colony's ring at (7,6)
  colony.hp = 0;
  addUnit(g, "p1", "spearman", { q: 8, r: 6 });
  resolveTurn(g, 2000);
  assert.equal(colony.owner, "p1");
  assert.equal(at(6, 6).owner, "p1"); assert.equal(at(6, 6).cityId, "colony");
  assertNoEnclaves(g);
});

test("captor land that the captured city cannot reach is not kept as a floating enclave", () => {
  const { g, at, colony } = fixture();
  // A p2 tile registered to colony but separated from it by p1's approach is only
  // transferable if colony can reach it; here it is cut off by unowned land.
  Object.assign(at(8, 2), { owner: "p2", cityId: "colony" });
  colony.hp = 0;
  addUnit(g, "p1", "spearman", { q: 8, r: 6 });
  resolveTurn(g, 2000);
  assert.equal(at(8, 2).owner, null);
  assert.ok(!g.tiles.some(t => t.owner === "p1" && !connectedToCity(g, "p1", t)));
  assertNoEnclaves(g);
});

test("demolition hands connected land to the neighbouring city and frees the rest", () => {
  const { g, at } = fixture();
  g.wars = [];
  transact(g, "p2", { turn: g.turn, action: "razeCity", cityId: "colony" }, 1300);
  assert.ok(!g.cities.some(c => c.id === "colony"));
  assert.equal(at(11, 6).owner, "p2"); assert.equal(at(11, 6).cityId, "far");
  assert.equal(at(10, 6).owner, "p2"); assert.equal(at(10, 6).cityId, "far");
  assert.equal(at(7, 6).owner, null); assert.equal(at(7, 6).farm, true);
  assert.equal(at(9, 6).owner, null, "land 4+ tiles from far is outside its reach");
  assert.equal(at(11, 3).owner, null);
  assertNoEnclaves(g);
  assert.match(g.events.p2.map(e => e.text).join("\n"), /자진 철거했어요.*무주지가 됐어요/);
});

test("reassignTile still refuses moves that would sever the source footprint and allows connected ones", () => {
  const { g, at } = fixture();
  g.wars = [];
  Object.assign(at(11, 3), { owner: null, cityId: null }); // the orphan is a pre-existing enclave; not this test's subject
  // Moving (10,6) first would strand (11,6) from colony: refused.
  assert.throws(() => transact(g, "p2", { turn: g.turn, action: "reassignTile", target: { q: 10, r: 6 }, toCityId: "far" }, 1300), /월경지/);
  assert.equal(at(10, 6).cityId, "colony");
  // (11,6) touches far's ring at (12,6) and is the string's end: legal.
  transact(g, "p2", { turn: g.turn, action: "reassignTile", target: { q: 11, r: 6 }, toCityId: "far" }, 1300);
  assert.equal(at(11, 6).cityId, "far");
  transact(g, "p2", { turn: g.turn, action: "reassignTile", target: { q: 10, r: 6 }, toCityId: "far" }, 1300);
  assert.equal(at(10, 6).cityId, "far");
  assert.equal(distance(at(9, 6), g.cities.find(c => c.id === "colony")), 1);
});
