import test from "node:test";
import assert from "node:assert/strict";
import { handleDeal } from "../server/deals.mjs";
import { createGame, startGame, transact, observe, resolveTurn, setSettings, restoreRuntimeGame } from "../server/engine.mjs";

const ctx = { GameError: Error, event() {}, atWar: g => g.wars.length > 0, relation: () => "neutral" };
const fixture = () => ({ turn: 4, proposals: [], wars: [], gold: { p1: 10, p2: 100 }, factions: { p1: {}, p2: {}, p3: {} }, players: { p1: {}, p2: {}, p3: {} } });
const issue = (g, extra = {}) => handleDeal(g, "p1", { action: "issueUltimatum", factionId: "p2", gold: 40, ...extra }, ctx);
test("ultimatum pays once on explicit acceptance and is participant-private", () => {
  const g = fixture(); issue(g);
  const id = g.proposals[0].id;
  assert.equal(g.proposals[0].expires, 7);
  assert.deepEqual(g.gold, { p1: 10, p2: 100 });
  assert.equal(g.tradeNotices.p3, undefined);
  assert.throws(() => handleDeal(g, "p3", { action: "acceptProposal", proposalId: id }, ctx));
  handleDeal(g, "p2", { action: "acceptProposal", proposalId: id }, ctx);
  assert.deepEqual(g.gold, { p1: 50, p2: 60 });
  assert.equal(handleDeal(g, "p2", { action: "acceptProposal", proposalId: id }, ctx), false);
  assert.deepEqual(g.wars, []);
});
test("rejection and cancellation have no treasury or war side effects", () => {
  for (const [action, player] of [["rejectProposal", "p2"], ["cancelProposal", "p1"]]) {
    const g = fixture(); issue(g);
    handleDeal(g, player, { action, proposalId: g.proposals[0].id }, ctx);
    assert.deepEqual(g.gold, { p1: 10, p2: 100 });
    assert.equal(g.proposals.length, 0); assert.deepEqual(g.wars, []);
  }
});
test("expired or unaffordable demands cannot transfer gold", () => {
  const g = fixture(); issue(g, { gold: 101 });
  const raw = { action: "acceptProposal", proposalId: g.proposals[0].id };
  assert.throws(() => handleDeal(g, "p2", raw, ctx));
  g.gold.p2 = 200; g.turn = 7;
  assert.throws(() => handleDeal(g, "p2", raw, ctx));
  assert.equal(g.gold.p1, 10); assert.equal(g.proposals.length, 1);
});
test("strict validation, pending conflicts and NPC refusal", () => {
  for (const extra of [{ gold: -1 }, { gold: 0 }, { gold: NaN }, { deadlineTurns: 0 }, { deadlineTurns: 1.5 }, { factionId: "p1" }]) {
    const g = fixture(); assert.throws(() => issue(g, extra)); assert.equal(g.proposals.length, 0);
  }
  const g = fixture(); issue(g); assert.throws(() => issue(g));
  const npc = fixture(); npc.players.p2.controller = "npc"; issue(npc);
  assert.equal(npc.proposals.length, 0); assert.equal(npc.tradeNotices.p1[0].status, "rejected");
  assert.deepEqual(npc.wars, []);
});

function engineFixture() {
  const g = createGame({ mode: "duel", rulesVersion: "expansion-v1", turnMode: "alternating", now: 1000,
    seats: [{ id: "p1", controller: "human" }, { id: "p2", controller: "human" }, { id: "p3", controller: "human" }] });
  g.players.p2.connected = true; g.players.p3.connected = true;
  startGame(g, 1000);
  g.gold.p1 = 100; g.gold.p2 = 100;
  return g;
}
test("engine routes off-turn ultimata and responses without exposing a third-party proposal", () => {
  const g = engineFixture();
  transact(g, "p2", { turn: g.turn, action: "issueUltimatum", factionId: "p1", gold: 20 }, 1100);
  const id = g.proposals[0].id;
  assert.equal(observe(g, "p3", 1100).diplomacy.length, 0);
  assert.equal(observe(g, "p3", 1100).tradeNotices.length, 0);
  assert.throws(() => transact(g, "p3", { turn: g.turn, action: "acceptProposal", proposalId: id }, 1200), /응답/);
  transact(g, "p1", { turn: g.turn, action: "acceptProposal", proposalId: id }, 1200);
  assert.equal(g.gold.p1, 80); assert.equal(g.gold.p2, 120);
  assert.equal(g.proposals.length, 0);
  assert.throws(() => transact(g, "p1", { turn: g.turn, action: "acceptProposal", proposalId: id }, 1200));
});
test("engine expiry removes demand with no refund, payment or automatic war", () => {
  const g = engineFixture();
  transact(g, "p1", { turn: g.turn, action: "issueUltimatum", factionId: "p2", gold: 40, deadlineTurns: 1 }, 1100);
  const id = g.proposals[0].id;
  const control = restoreRuntimeGame(JSON.parse(JSON.stringify(g)), 1100, 1100); control.proposals = [];
  // Compare identical round economy so routine income cannot mask transfers.
  for (let i = 0; i < 3; i++) { resolveTurn(g, 1200 + i); resolveTurn(control, 1200 + i); }
  assert.ok(g.turn >= 2);
  assert.ok(!g.proposals.some(p => p.id === id));
  assert.deepEqual([g.gold.p1, g.gold.p2], [control.gold.p1, control.gold.p2]);
  assert.equal(g.wars.includes("p1|p2"), false);
  assert.equal(observe(g, "p1", 1300).tradeNotices.at(-1).status, "expired");
});
test("engine rejects paused, stale and invalid authority actions; refusal preserves gold", () => {
  const g = engineFixture();
  const raw = { turn: g.turn, action: "issueUltimatum", factionId: "p2", gold: 20 };
  assert.throws(() => transact(g, "intruder", raw, 1100), /권한/);
  assert.throws(() => transact(g, "p1", { ...raw, turn: 0 }, 1100), /턴/);
  setSettings(g, "p1", { paused: true }, 1100);
  assert.throws(() => transact(g, "p1", raw, 1200), /일시정지/);
  setSettings(g, "p1", { paused: false }, 1200);
  transact(g, "p1", raw, 1300);
  transact(g, "p2", { turn: g.turn, action: "rejectProposal", proposalId: g.proposals[0].id }, 1400);
  assert.equal(g.gold.p1, 100); assert.equal(g.gold.p2, 100);
  assert.ok(!g.wars.includes("p1|p2"));
});
