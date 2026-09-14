import test from "node:test";
import assert from "node:assert/strict";
import { handleUltimatum } from "../server/ultimatums.mjs";
import { updateTerritorialPresence, territorialUltimatumOptions, territorialDiplomacyView,
  restrictionViolation, expireTerritorialUltimatums, territorialCasusBelli } from "../server/diplomacyRules.mjs";

function fixture() {
  const g = { turn: 1, wars: [], peaceUntil: {}, proposals: [], gold: { p1: 100, p2: 100 },
    factions: { p1: {}, p2: {}, p3: {} }, players: { p1: {}, p2: {}, p3: {} }, tiles: [],
    units: [{ id: "army", type: "spearman", owner: "p2", hp: 100, q: 4, r: 4, movesLeft: 4 },
      { id: "builder", type: "builder", owner: "p2", hp: 100, q: 4, r: 4 }],
    cities: [{ id: "home", name: "Home", owner: "p1", q: 3, r: 4, hp: 160 },
      { id: "colony", name: "Colony", owner: "p2", q: 5, r: 4, hp: 160 }] };
  for (let q = 0; q <= 12; q++) for (let r = 0; r <= 8; r++) g.tiles.push({ q, r, terrain: "plains", owner: null });
  Object.assign(g.tiles.find(t => t.q === 3 && t.r === 4), { owner: "p1", cityId: "home" });
  Object.assign(g.tiles.find(t => t.q === 5 && t.r === 4), { owner: "p2", cityId: "colony" });
  return g;
}
const view = (g, player = "p1") => ({ playerId: player,
  tiles: g.tiles.map(t => ({ ...t, visible: t.q <= 6, explored: t.q <= 6 })),
  units: g.units.filter(u => u.q <= 6).map(u => ({ ...u })),
  cities: g.cities.filter(c => c.q <= 6).map(c => ({ ...c })) });
const context = (g, player = "p1") => ({ GameError: Error, event() {},
  atWar: (game, a, b) => game.wars.includes([a, b].sort().join("|")), relation: () => "neutral",
  observation: view(g, player),
  razeCity(game, owner, id) {
    assert.ok(game.cities.some(c => c.id === id && c.owner === owner));
    game.cities = game.cities.filter(c => c.id !== id);
    for (const tile of game.tiles.filter(t => t.cityId === id)) { tile.cityId = null; tile.owner = null; }
  } });
const streak = (g) => { for (let turn = 1; turn <= 3; turn++) { g.turn = turn; updateTerritorialPresence(g, "p1", view(g)); } };
const issue = (g, demand, extra = {}) => handleUltimatum(g, "p1", { action: "issueUltimatum", factionId: "p2", demand, ...extra }, context(g));
const answer = (g, action, player = "p2") => handleUltimatum(g, player,
  { action, proposalId: g.proposals[0].id }, context(g, player));

test("military presence requires three observed turns, never polls, and resets on departure", () => {
  const g = fixture();
  for (let i = 0; i < 5; i++) updateTerritorialPresence(g, "p1", view(g));
  assert.equal(territorialUltimatumOptions(g, "p1", view(g))[0].nearbyMilitaryTurns, 1);
  assert.throws(() => issue(g, "withdrawTroops"), /3턴/);
  g.turn = 2; updateTerritorialPresence(g, "p1", view(g));
  g.turn = 3; updateTerritorialPresence(g, "p1", view(g));
  assert.equal(territorialUltimatumOptions(g, "p1", view(g))[0].canWithdrawTroops, true);
  g.units[0].q = 10; updateTerritorialPresence(g, "p1", view(g));
  g.units[0].q = 4; updateTerritorialPresence(g, "p1", view(g));
  assert.equal(territorialUltimatumOptions(g, "p1", view(g))[0].nearbyMilitaryTurns, 1);
});

test("nearby settlement is immediately eligible, hidden cities and civilians are not military evidence", () => {
  const g = fixture(); g.units = g.units.filter(u => u.type === "builder");
  updateTerritorialPresence(g, "p1", view(g));
  const options = territorialUltimatumOptions(g, "p1", view(g));
  assert.equal(options[0].cities[0].id, "colony"); assert.equal(options[0].canWithdrawTroops, false);
  const hidden = view(g); hidden.tiles.forEach(t => { if (t.q === 5 && t.r === 4) t.visible = false; });
  assert.equal(territorialUltimatumOptions(g, "p1", hidden).length, 0);
  assert.throws(() => handleUltimatum(g, "p1", { action: "issueUltimatum", factionId: "p2", demand: "removeCity", cityId: "colony" }, { ...context(g), observation: hidden }));
  issue(g, "removeCity", { cityId: "colony" });
  assert.equal(g.proposals[0].cityName, "Colony");
  assert.equal(g.proposals[0].fullZoneKeys, undefined, "proposal cloning must not reveal unknown coordinates");
  assert.equal(g.tradeNotices.p2[0].proposal.demand, "removeCity");
  assert.equal(g.tradeNotices.p2[0].proposal.cityId, "colony");
});

test("withdrawal acceptance relocates military atomically and enforces ten-turn directional promise", () => {
  const g = fixture(); streak(g); issue(g, "withdrawTroops");
  const zone = new Set(g.territorialDemandZones[g.proposals[0].id]);
  answer(g, "acceptProposal");
  assert.ok(!zone.has(`${g.units[0].q},${g.units[0].r}`));
  assert.equal(g.units[0].movesLeft, 0); assert.equal(g.units[0].attackUsed, true);
  assert.deepEqual([g.units[1].q, g.units[1].r], [4, 4], "civilian movement remains independent");
  assert.equal(g.proposals.length, 0); assert.deepEqual(g.gold, { p1: 100, p2: 100 });
  assert.ok(restrictionViolation(g, "p2", { q: 4, r: 4 }, "military"));
  assert.ok(restrictionViolation(g, "p2", { q: 4, r: 4 }, "found"));
  assert.equal(restrictionViolation(g, "p2", { q: 4, r: 4 }, "civilian"), null);
  assert.equal(restrictionViolation(g, "p1", { q: 4, r: 4 }), null);
  g.turn = 12; assert.ok(restrictionViolation(g, "p2", { q: 4, r: 4 }));
  g.wars = ["p1|p2"]; assert.equal(restrictionViolation(g, "p2", { q: 4, r: 4 }), null);
  g.wars = []; g.turn = 13; assert.equal(restrictionViolation(g, "p2", { q: 4, r: 4 }), null);
});

test("city withdrawal invokes demolition, withdraws troops, and grants no hidden coordinates", () => {
  const g = fixture(); issue(g, "removeCity", { cityId: "colony" }); answer(g, "acceptProposal");
  assert.ok(!g.cities.some(c => c.id === "colony"));
  assert.equal(g.territorialAgreements[0].until, 11);
  const limited = { ...view(g, "p2"), tiles: [{ q: 4, r: 4, explored: true }] };
  const publicView = territorialDiplomacyView(g, "p2", limited);
  assert.deepEqual(publicView.agreements[0].zoneKeys, ["4,4"]);
  assert.deepEqual(territorialDiplomacyView(g, "p3", view(g, "p3")).agreements, []);
});

test("rejection and deadline expiry grant immediate directional cause; cancellation does not", () => {
  for (const response of ["rejectProposal", "cancelProposal", "expiry"]) {
    const g = fixture(); issue(g, "removeCity", { cityId: "colony", deadlineTurns: 1 });
    if (response === "expiry") { g.turn = 2; expireTerritorialUltimatums(g); }
    else answer(g, response, response === "cancelProposal" ? "p1" : "p2");
    assert.equal(!!territorialCasusBelli(g, "p1", "p2"), response !== "cancelProposal");
    assert.equal(territorialCasusBelli(g, "p2", "p1"), null);
    assert.deepEqual(g.wars, []); assert.equal(g.proposals.length, 0);
    assert.equal(Object.keys(g.territorialDemandZones).length, 0);
  }
});

test("illegal or unauthorized withdrawal acceptance cannot partially raze, relocate or settle", () => {
  const g = fixture(); issue(g, "removeCity", { cityId: "colony" });
  assert.throws(() => answer(g, "acceptProposal", "p3"), /응답/);
  for (const t of g.tiles) if (!(t.q === 4 && t.r === 4)) t.terrain = "mountain";
  const before = JSON.stringify(g);
  assert.throws(() => answer(g, "acceptProposal"), /철수/);
  assert.equal(JSON.stringify(g), before);
});

test("rule-based territorial refusal creates cause, while legacy gold demands do not", () => {
  const g = fixture(); g.players.p2.controller = "npc";
  issue(g, "removeCity", { cityId: "colony" });
  assert.ok(territorialCasusBelli(g, "p1", "p2")); assert.equal(g.proposals.length, 0);
  const gold = fixture(); gold.players.p2.controller = "npc"; issue(gold, "gold", { gold: 10 });
  assert.equal(territorialCasusBelli(gold, "p1", "p2"), null);
});
