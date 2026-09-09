import test from "node:test";
import assert from "node:assert/strict";
import { handleDeal } from "../server/deals.mjs";
import { ensureLogisticsState, tickLogistics } from "../server/logistics.mjs";

function dealFixture() {
  const g = {
    rulesVersion: "expansion-v1",
    supplyMode: "on",
    turn: 1,
    tiles: [],
    cities: [
      { id: "a", owner: "p1", q: 1, r: 1, hp: 160, population: 3, food: 5 },
      { id: "b", owner: "p2", q: 5, r: 1, hp: 160, population: 3, food: 0 },
    ],
    units: [],
    stockpiles: {
      p1: { iron: 3, horses: 0, niter: 0 },
      p2: { iron: 0, horses: 0, niter: 0 },
    },
    gold: { p1: 100, p2: 100 },
    players: { p1: { controller: "human" }, p2: { controller: "human" } },
    factions: { p1: { name: "p1" }, p2: { name: "p2" } },
    wars: [],
    peaceUntil: {},
    denouncements: {},
    alliances: {},
    relations: {},
    proposals: [],
    cargo: [],
  };
  for (let q = 0; q < 20; q++)
    for (let r = 0; r < 20; r++) g.tiles.push({ q, r, terrain: "plains" });
  ensureLogisticsState(g);
  return g;
}

const context = {
  GameError: class DealError extends Error {},
  event() {},
  atWar() {
    return false;
  },
  relation() {
    return "neutral";
  },
  announceWar() {},
};

test("human deal escrows food/resource by named city and credits only on physical arrival", () => {
  const g = dealFixture();
  const offer = {
    action: "offerDeal",
    factionId: "p2",
    give: {
      food: 2,
      foodCityId: "a",
      foodDestinationCityId: "b",
      resources: { iron: 1 },
      resourceSourceCityId: "a",
      resourceDestinationCityId: "b",
    },
    receive: {},
  };
  handleDeal(g, "p1", { ...offer, observation: { units: [], cities: [] } }, context);
  assert.equal(g.cities[0].food, 3);
  assert.equal(g.stockpiles.p1.iron, 2);
  const proposalId = g.proposals[0].id;
  handleDeal(g, "p2", { action: "acceptProposal", proposalId }, context);
  assert.equal(g.proposals.length, 0);
  assert.equal(g.cities[1].food, 0);
  assert.equal(g.stockpiles.p2.iron, 0);
  for (let turn = 1; turn < 80; turn++)
    tickLogistics(g, { turn, owner: "p1", consumeUnits: false, automaticSupply: false });
  assert.equal(g.cities[1].food, 2);
  assert.equal(g.stockpiles.p2.iron, 1);
  const delivered = g.logistics.shipments.filter((shipment) => shipment.status === "delivered");
  assert.equal(delivered.length, 2);
});

test("cancelled physical deal returns escrow to its original city exactly once", () => {
  const g = dealFixture();
  handleDeal(
    g,
    "p1",
    {
      action: "offerDeal",
      factionId: "p2",
      give: { food: 2, foodCityId: "a", foodDestinationCityId: "b" },
      receive: {},
      observation: { units: [], cities: [] },
    },
    context,
  );
  const proposalId = g.proposals[0].id;
  assert.equal(g.cities[0].food, 3);
  handleDeal(g, "p1", { action: "cancelProposal", proposalId }, context);
  assert.equal(g.cities[0].food, 5);
  // The proposal is gone, so a duplicate cancellation cannot mint another 2.
  assert.equal(handleDeal(g, "p1", { action: "cancelProposal", proposalId }, context), false);
  assert.equal(g.cities[0].food, 5);
});

