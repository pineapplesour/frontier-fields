import test from "node:test";
import assert from "node:assert/strict";
import { createGame, startGame, transact } from "../server/engine.mjs";

// Physical (expansion-style) deals with detailed supply OFF: resources settle
// instantly between stockpiles and need no source/destination cities.
test("physical deals with supply OFF settle resources instantly without cities", () => {
  const g = createGame({ mode: "duel", rulesVersion: "legacy", turnMode: "simultaneous", now: 1000,
    seats: [{ id: "p1", controller: "human" }, { id: "p2", controller: "human" }] });
  g.players.p2.connected = true;
  g.wars = [];
  g.supplyMode = "off";
  startGame(g, 1000);
  g.logistics = { ...(g.logistics ?? {}), physical: true };
  g.stockpiles.p1 = { food: 0, iron: 5, horses: 0, niter: 0 };
  g.stockpiles.p2 = { food: 0, iron: 0, horses: 0, niter: 0 };
  g.gold.p1 = 100; g.gold.p2 = 100;
  transact(g, "p1", { turn: g.turn, action: "offerDeal", factionId: "p2",
    give: { gold: 0, resources: { iron: 2 }, units: [], cities: [], warAgainst: null },
    receive: { gold: 10, resources: {}, units: [], cities: [], warAgainst: null },
    alliance: false, peace: false }, 1100);
  const proposalId = g.proposals.at(-1).id;
  assert.equal(g.stockpiles.p1.iron, 3, "escrowed");
  transact(g, "p2", { turn: g.turn, action: "acceptProposal", proposalId }, 1200);
  assert.equal(g.stockpiles.p2.iron, 2);
  assert.equal(g.gold.p1, 110);
  assert.equal((g.logistics?.shipments ?? []).filter((s) => s.mode === "deal-resource").length, 0);
});
