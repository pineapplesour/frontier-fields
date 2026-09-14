import test from "node:test";
import assert from "node:assert/strict";
import { createGame, addUnit, startGame, observe, ready, transact, submitOrders, updateContacts } from "../server/engine.mjs";
import { key, equal, neighbors, canCrossBorder, settlementIssue } from "../shared/rules.js";

function fixture() {
  const g = createGame({ mode: "duel", rulesVersion: "expansion-v1", turnMode: "simultaneous", now: 1000,
    seats: [{ id: "p1", controller: "human" }, { id: "p2", controller: "human" }, { id: "p3", controller: "human" }] });
  g.units = []; g.cities = []; g.rivers = []; g.wars = [];
  for (const t of g.tiles) Object.assign(t, { terrain: "plains", fertility: 2, owner: null, cityId: null, farm: false, resource: null, developed: false, ruin: null, fort: null });
  g.players.p2.connected = true; g.players.p3.connected = true;
  const city = (id, owner, q, r) => {
    const c = { id, name: id, owner, q, r, hp: 160, population: 3, production: 0, queue: null, food: 20, growthProgress: 0,
      capital: false, isolation: 0, wallLevel: 0, wallHp: 0, territoryRadius: 1, territoryGrowth: 0,
      citizenPolicy: { auto: true, lockedSlots: [], priority: [] } };
    g.cities.push(c); Object.assign(g.tiles.find(t => equal(t, c)), { owner, cityId: id }); return c;
  };
  city("home", "p1", 4, 6); city("colony", "p2", 6, 6); city("retained", "p2", 8, 6);
  Object.assign(g.tiles.find(t => t.q === 7 && t.r === 6), { owner: "p2", cityId: "colony" });
  g.founded = { p1: true, p2: true, p3: true };
  addUnit(g, "p1", "spearman", { q: 4, r: 6 });
  const army = addUnit(g, "p2", "spearman", { q: 5, r: 6 });
  const settler = addUnit(g, "p2", "settler", { q: 4, r: 4 });
  addUnit(g, "p3", "spearman", { q: 15, r: 1 });
  startGame(g, 1000);
  return { g, army, settler };
}
function round(g) {
  for (const player of ["p1", "p2", "p3"]) ready(g, player, g.turn, 1200);
}
const trade = (g, player, data) => transact(g, player, { turn: g.turn, ...data }, 1300);
const option = (g) => observe(g, "p1", 1300).territorialDiplomacy.options.find(o => o.factionId === "p2");

test("engine observed three-turn presence, withdrawal execution, move/found guard and declared-war release", () => {
  const { g, army, settler } = fixture();
  assert.equal(option(g).nearbyMilitaryTurns, 1);
  for (let i = 0; i < 3; i++) observe(g, "p1", 1100);
  assert.equal(option(g).nearbyMilitaryTurns, 1);
  assert.throws(() => trade(g, "p1", { action: "issueUltimatum", factionId: "p2", demand: "withdrawTroops" }), /3턴/);
  round(g); round(g);
  assert.equal(g.turn, 3); assert.equal(option(g).canWithdrawTroops, true);
  trade(g, "p1", { action: "issueUltimatum", factionId: "p2", demand: "withdrawTroops" });
  const id = g.proposals[0].id, before = key(army);
  const zone = new Set(g.territorialDemandZones[id]);
  assert.equal(observe(g, "p3", 1300).diplomacy.length, 0);
  trade(g, "p2", { action: "acceptProposal", proposalId: id });
  assert.notEqual(key(army), before); assert.ok(!zone.has(key(army)));
  assert.equal(observe(g, "p2", 1300).territorialDiplomacy.agreements[0].turnsRemaining, 10);
  round(g); // Real round reset distinguishes treaty blocking from spent moves.
  const back = neighbors(army).find(t => zone.has(key(t)) && g.tiles.some(x => equal(x, t)) && !g.units.some(u => equal(u, t)) && !g.cities.some(c => c.owner !== "p2" && equal(c, t)));
  assert.ok(back, "relocation has an adjacent known pact zone to test");
  assert.equal(canCrossBorder(observe(g, "p2", 1300), army, army, back), false);
  assert.throws(() => submitOrders(g, "p2", { turn: g.turn, orders: [{ unitId: army.id, action: "move", target: back }] }, 1300), /최후통첩/);
  assert.match(settlementIssue(observe(g, "p2", 1300), settler), /최후통첩/);
  assert.throws(() => submitOrders(g, "p2", { turn: g.turn, orders: [{ unitId: settler.id, action: "found" }] }, 1300), /최후통첩/);
  assert.equal(observe(g, "p2", 1300).territorialDiplomacy.agreements[0].turnsRemaining, 9);
  trade(g, "p2", { action: "declareWar", factionId: "p1" });
  round(g);
  assert.equal(canCrossBorder(observe(g, "p2", 1300), army, army, back), true);
  submitOrders(g, "p2", { turn: g.turn, orders: [{ unitId: army.id, action: "move", target: back, path: [back] }] }, 1300);
  assert.equal(key(army), key(back));
});

test("engine city ultimatum calls actual demolition, retains other cities and reassigns connected land", () => {
  const { g } = fixture();
  const homeLand = g.tiles.filter(t => t.owner === "p1").map(key);
  trade(g, "p1", { action: "issueUltimatum", factionId: "p2", demand: "removeCity", cityId: "colony" });
  const id = g.proposals[0].id;
  assert.throws(() => trade(g, "p3", { action: "acceptProposal", proposalId: id }), /응답/);
  trade(g, "p2", { action: "acceptProposal", proposalId: id });
  assert.ok(!g.cities.some(c => c.id === "colony"));
  assert.ok(g.cities.some(c => c.id === "retained" && c.owner === "p2"));
  assert.deepEqual(g.tiles.filter(t => t.owner === "p1").map(key), homeLand);
  const linked = g.tiles.find(t => t.q === 7 && t.r === 6);
  assert.equal(linked.owner, "p2"); assert.equal(linked.cityId, "retained");
  assert.equal(g.territorialAgreements.length, 1);
});

test("engine deadline creates private directional cause and no war until sender chooses", () => {
  const { g } = fixture();
  trade(g, "p1", { action: "issueUltimatum", factionId: "p2", demand: "removeCity", cityId: "colony", deadlineTurns: 1 });
  const recipient = observe(g, "p2", 1300);
  assert.equal(recipient.diplomacy[0].fullZoneKeys, undefined);
  assert.equal(recipient.diplomacy[0].cityName, "colony");
  round(g);
  assert.equal(g.proposals.length, 0); assert.ok(g.territorialCasusBelli["p1>p2"]);
  assert.equal(observe(g, "p3", 1300).territorialDiplomacy.casusBelli.length, 0);
  assert.ok(!g.wars.includes("p1|p2"));
  const relation = g.relations["p1|p3"] ?? 0;
  trade(g, "p1", { action: "declareWar", factionId: "p2" });
  assert.ok(g.wars.includes("p1|p2")); assert.equal(g.relations["p1|p3"] ?? 0, relation);
});

test("engine refuses spoofed hidden targets and all NPC evidence uses its own observed border", () => {
  const { g } = fixture();
  const retained = g.cities.find(c => c.id === "retained");
  assert.ok(!observe(g, "p1", 1300).cities.some(c => c.id === retained.id));
  assert.throws(() => trade(g, "p1", { action: "issueUltimatum", factionId: "p2", demand: "removeCity", cityId: retained.id,
    observation: { playerId: "p1", cities: g.cities, units: g.units, tiles: g.tiles.map(t => ({ ...t, visible: true, explored: true })) } }), /관측/);
  // NPC seats use the identical observation boundary, not omniscient world state.
  g.players.p3.controller = "npc"; g.players.p3.npc = true;
  Object.assign(g.tiles.find(t => t.q === 14 && t.r === 1), { owner: "p3" });
  updateContacts(g);
  assert.deepEqual(observe(g, "p3", 1300).territorialDiplomacy.options, []);
  assert.ok(!g.territorialPresence["p3>p2"]);
  g.players.p2.controller = "npc"; g.players.p2.npc = true;
  trade(g, "p1", { action: "issueUltimatum", factionId: "p2", demand: "removeCity", cityId: "colony" });
  assert.equal(g.proposals.length, 0); assert.ok(g.territorialCasusBelli["p1>p2"]);
  assert.equal(observe(g, "p1", 1300).tradeNotices.at(-1).status, "rejected");
});
