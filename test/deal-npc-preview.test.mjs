import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  startGame,
  transact,
  previewDeal,
} from "../server/engine.mjs";

const tx = (g, p, raw) => transact(g, p, { turn: g.turn, ...raw }, 1100);
// p3 is a rule-based NPC civilization, p2/p4 are humans, "cs" is the city-state.
function fixture() {
  const g = createGame({
    mode: "duel",
    rulesVersion: "legacy",
    turnMode: "simultaneous",
    now: 1000,
    seats: [
      { id: "p1", controller: "human" },
      { id: "p2", controller: "human" },
      { id: "p3", controller: "npc" },
      { id: "p4", controller: "human" },
    ],
  });
  // Keep the generated cities so stockpile capacity exists on both sides.
  g.wars = []; g.alliances = {}; g.denouncements = {}; g.peaceUntil = {}; g.warStarted = {};
  for (let i = 1; i <= 4; i++) {
    g.players[`p${i}`].connected = true;
    g.gold[`p${i}`] = 500;
    g.stockpiles[`p${i}`] = { food: 20, iron: 6, horses: 3, niter: 2 };
  }
  g.gold.cs = 500;
  g.stockpiles.cs = { food: 20, iron: 6, horses: 3, niter: 2 };
  startGame(g, 1000);
  return g;
}
const lastNotice = (g, player) => g.tradeNotices?.[player]?.at(-1)?.status ?? null;
// Real proposal outcome: accepted, rejected by the NPC, or refused up front
// with the same message the preview reports as `reason`.
const propose = (g, raw, expectedRefusal = null) => {
  const before = g.tradeNotices?.p1?.length ?? 0;
  try {
    tx(g, "p1", { action: "offerDeal", ...raw });
  } catch (error) {
    if (expectedRefusal) assert.equal(error.message, expectedRefusal);
    else throw error;
    return false;
  }
  assert.equal((g.tradeNotices?.p1?.length ?? 0), before + 1, "one trade notice per proposal");
  return lastNotice(g, "p1") === "accepted";
};

test("peace needs no gold: both direct-peace accept paths and the deal path settle a zero-gold offer", () => {
  for (const action of ["acceptPeace", "acceptProposal"]) {
    const g = fixture();
    tx(g, "p1", { action: "declareWar", factionId: "p2" });
    g.turn = 11;
    tx(g, "p1", { action: "peace", factionId: "p2", gold: 0 });
    const id = g.proposals.at(-1).id;
    assert.equal(g.proposals.at(-1).gold, 0);
    tx(g, "p2", { action, proposalId: id });
    assert.ok(!g.wars.includes("p1|p2"));
    assert.equal(g.gold.p1, 500);
    assert.equal(g.gold.p2, 500);
  }
  // Omitting gold entirely defaults to zero, not 40.
  const h = fixture();
  tx(h, "p1", { action: "declareWar", factionId: "p2" });
  h.turn = 11;
  tx(h, "p1", { action: "peace", factionId: "p2" });
  assert.equal(h.proposals.at(-1).gold, 0);
  // Rule-based civilization and city-state: immediate, free peace after ten turns.
  for (const target of ["p3", "cs"]) {
    const n = fixture();
    tx(n, "p1", { action: "declareWar", factionId: target });
    assert.throws(() => tx(n, "p1", { action: "peace", factionId: target, gold: 0 }), /10턴/);
    n.turn = 11;
    tx(n, "p1", { action: "peace", factionId: target, gold: 0 });
    assert.ok(!n.wars.includes(["p1", target].sort().join("|")));
    assert.equal(n.gold.p1, 500);
  }
  const d = fixture();
  tx(d, "p1", { action: "declareWar", factionId: "p3" });
  d.turn = 11;
  const quote = previewDeal(d, "p1", { factionId: "p3", peace: true, give: {}, receive: {} });
  assert.equal(quote.status, "accept");
  assert.equal(quote.wouldAccept, true);
  assert.equal(quote.demands.gold, 0);
  assert.ok(propose(d, { factionId: "p3", peace: true, give: {}, receive: {} }));
  assert.ok(!d.wars.includes("p1|p3"));
  assert.equal(d.gold.p1, 500);
});

const scenarios = [
  { name: "gold-only request", raw: { factionId: "p3", give: {}, receive: { gold: 30 } }, expect: false },
  { name: "gold-only gift", raw: { factionId: "p3", give: { gold: 10 }, receive: {} }, expect: true },
  { name: "resource request", raw: { factionId: "p3", receive: { resources: { iron: 2 } } }, expect: false },
  { name: "resource for gold", raw: { factionId: "p3", give: { gold: 14 }, receive: { resources: { iron: 2 } } }, expect: true },
  { name: "alliance without goodwill", raw: { factionId: "p3", alliance: true }, expect: false },
  { name: "alliance with goodwill", raw: { factionId: "p3", alliance: true }, setup: (g) => { g.relations["p1|p3"] = 60; }, expect: true },
  { name: "alliance during denouncement is never accepted", raw: { factionId: "p3", alliance: true, give: { gold: 200 } }, setup: (g) => { g.denouncements["p1|p3"] = 99; }, expect: false, never: true },
  { name: "peace too early is never accepted", raw: { factionId: "p3", peace: true, give: { gold: 200 } }, setup: (g) => { tx(g, "p1", { action: "declareWar", factionId: "p3" }); }, expect: false, never: true },
  { name: "peace after ten turns", raw: { factionId: "p3", peace: true }, setup: (g) => { tx(g, "p1", { action: "declareWar", factionId: "p3" }); g.turn = 11; }, expect: true },
  { name: "city-state resource request", raw: { factionId: "cs", receive: { resources: { niter: 1 } } }, expect: false },
];

test("deal-preview wouldAccept equals the NPC's real accept decision for every synthetic deal", () => {
  for (const s of scenarios) {
    const g = fixture();
    s.setup?.(g);
    const quote = previewDeal(g, "p1", s.raw);
    assert.equal(quote.wouldAccept, s.expect, s.name);
    assert.equal(quote.never ?? false, s.never ?? false, `${s.name} never flag`);
    assert.equal(typeof quote.reason, "string", `${s.name} reason`);
    if (s.expect) assert.deepEqual(quote.demands, { gold: 0, resources: {} }, s.name);
    else if (!s.never) assert.ok(quote.demands.gold > 0, `${s.name} demands gold`);
    else assert.equal(quote.demands, null, s.name);
    assert.equal(propose(g, s.raw, s.never ? quote.reason : null), s.expect, `${s.name} actual decision`);
  }
});

test("applying the suggested demands (gold or the resource alternative) makes the NPC accept", () => {
  for (const s of scenarios.filter((x) => !x.expect && !x.never)) {
    // Gold demand.
    const g = fixture();
    s.setup?.(g);
    const quote = previewDeal(g, "p1", s.raw);
    const filled = { ...s.raw, give: { ...(s.raw.give ?? {}), gold: (s.raw.give?.gold ?? 0) + quote.demands.gold } };
    const again = previewDeal(g, "p1", filled);
    assert.equal(again.wouldAccept, true, `${s.name} gold fill`);
    assert.equal(again.status, "accept");
    assert.ok(propose(g, filled), `${s.name} gold fill actual`);
    // Resource alternative, when the stockpile can cover it.
    if (!Object.keys(quote.demands.resources).length) continue;
    const h = fixture();
    s.setup?.(h);
    const give = s.raw.give ?? {};
    const resources = { ...(give.resources ?? {}) };
    for (const [r, n] of Object.entries(quote.demands.resources)) resources[r] = (resources[r] ?? 0) + n;
    const alt = { ...s.raw, give: { ...give, resources } };
    assert.equal(previewDeal(h, "p1", alt).wouldAccept, true, `${s.name} resource fill`);
    assert.ok(propose(h, alt), `${s.name} resource fill actual`);
  }
  // Human counterpart: no prediction, no demands.
  const g = fixture();
  const human = previewDeal(g, "p1", { factionId: "p2", receive: { gold: 30 } });
  assert.equal(human.status, "human");
  assert.equal(human.wouldAccept, null);
  assert.equal(human.demands, null);
  // Impossible deal error path also carries the prediction fields.
  const bad = previewDeal(g, "p1", { factionId: "p3", give: { gold: 9999 } });
  assert.equal(bad.status, "unavailable");
  assert.equal(bad.wouldAccept, false);
  assert.equal(bad.never, true);
});
