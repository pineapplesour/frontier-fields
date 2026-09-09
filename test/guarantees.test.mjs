import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  observe,
  startGame,
  transact,
} from "../server/engine.mjs";
import { npcWarRisk, onWarDeclared } from "../server/guarantees.mjs";
import { npcDiplomacy } from "../server/npc.mjs";

const seats = [
  { id: "p1", controller: "human" },
  { id: "p2", controller: "human" },
  { id: "p3", controller: "human" },
  { id: "p4", controller: "human" },
];

function game() {
  const g = createGame({
    mode: "duel",
    seed: 8_731,
    now: 1_000,
    rulesVersion: "expansion-v1",
    seats,
  });
  for (const id of seats.slice(1).map((seat) => seat.id))
    g.players[id].connected = true;
  startGame(g, 1_000);
  return g;
}

function issue(g, guarantor, protectedId) {
  g.activePlayer = guarantor;
  return transact(
    g,
    guarantor,
    { turn: g.turn, action: "guarantee", factionId: protectedId },
    1_000,
  );
}

function declare(g, attacker, defender) {
  g.activePlayer = attacker;
  return transact(
    g,
    attacker,
    { turn: g.turn, action: "declareWar", factionId: defender },
    1_000,
  );
}

test("a defended attack creates one pending call and acceptance joins atomically", () => {
  const g = game();
  issue(g, "p3", "p2");
  declare(g, "p1", "p2");

  assert.deepEqual(g.wars, ["p1|p2"]);
  const pending = observe(g, "p3").pendingGuaranteeCalls;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(observe(g, "p1").pendingGuaranteeCalls.length, 0);

  transact(
    g,
    "p3",
    { turn: g.turn, action: "acceptGuarantee", callId: pending[0].id },
    1_000,
  );
  assert.deepEqual(g.wars.sort(), ["p1|p2", "p1|p3"]);
  assert.equal(g.guaranteeCalls[0].status, "accepted");
  assert.equal(g.guaranteeCalls[0].joinedWarKey, "p1|p3");
  assert.equal(g.relations["p1|p3"], -30);
  assert.ok(
    g.announcements.some(
      (entry) => entry.reason === "guarantee" && entry.from === "p3" && entry.to === "p1",
    ),
  );
});

test("the protected side's offensive war does not create a call", () => {
  const g = game();
  issue(g, "p3", "p2");
  declare(g, "p2", "p1");
  assert.equal(g.guaranteeCalls.length, 0);
  assert.equal(observe(g, "p3").pendingGuaranteeCalls.length, 0);
});

test("a war-entry deal uses the same first-war guarantee hook", () => {
  const g = game();
  issue(g, "p4", "p3");
  g.activePlayer = "p1";
  transact(
    g,
    "p1",
    {
      turn: g.turn,
      action: "offerDeal",
      factionId: "p2",
      give: { warAgainst: "p3" },
      receive: {},
    },
    1_000,
  );
  const proposal = g.proposals.find((candidate) => candidate.kind === "deal");
  assert.ok(proposal);
  transact(
    g,
    "p2",
    { turn: g.turn, action: "acceptProposal", proposalId: proposal.id },
    1_000,
  );
  assert.ok(g.wars.includes("p1|p3"));
  assert.equal(g.guaranteeCalls.filter((call) => call.guarantor === "p4").length, 1);
  assert.equal(g.guaranteeCalls.find((call) => call.guarantor === "p4").status, "pending");
});

test("decline, withdrawal, duplicate guards, and repeated war hooks remain auditable", () => {
  const g = game();
  issue(g, "p3", "p2");
  assert.throws(() => issue(g, "p3", "p2"), /이미 유효한/);
  declare(g, "p1", "p2");
  const callId = observe(g, "p3").pendingGuaranteeCalls[0].id;
  transact(g, "p3", { turn: g.turn, action: "rejectGuarantee", callId }, 1_000);
  assert.equal(g.guaranteeCalls.find((call) => call.id === callId).status, "declined");
  // The war hook is idempotent: resolving the same pair cannot create a second call.
  const edgeId = g.guarantees[0].id;
  onWarDeclared(g, "p1", "p2", { atWar: () => true });
  assert.equal(
    g.guaranteeCalls.filter((call) => call.guaranteeId === edgeId).length,
    1,
  );

  const g2 = game();
  issue(g2, "p3", "p2");
  g2.activePlayer = "p3";
  transact(g2, "p3", { turn: g2.turn, action: "withdrawGuarantee", factionId: "p2" }, 1_000);
  assert.equal(g2.guarantees[0].active, false);
  declare(g2, "p1", "p2");
  assert.equal(g2.guaranteeCalls.length, 0);
});

test("an unanswered call expires without joining the war", () => {
  const g = game();
  issue(g, "p3", "p2");
  declare(g, "p1", "p2");
  const call = g.guaranteeCalls[0];
  g.turn = call.expires;
  assert.throws(
    () =>
      transact(
        g,
        "p3",
        { turn: g.turn, action: "acceptGuarantee", callId: call.id },
        1_000,
      ),
    /이미 처리됐어요/,
  );
  assert.equal(call.status, "expired");
  assert.deepEqual(g.wars, ["p1|p2"]);
});

test("city-state edges are public but barbarians cannot be guaranteed", () => {
  const g = game();
  issue(g, "p3", "cs");
  assert.equal(observe(g, "p1").guarantees[0].targetKind, "citystate");
  assert.throws(() => {
    g.activePlayer = "p3";
    transact(g, "p3", { turn: g.turn, action: "guarantee", factionId: "barb" }, 1_000);
  }, /참가 문명 또는 도시국가/);
  assert.throws(() => {
    g.activePlayer = "p3";
    transact(g, "p3", { turn: g.turn, action: "guarantee", factionId: "p3" }, 1_000);
  }, /자기 문명/);
});

test("NPC war risk includes a visible guarantor coalition without hidden-state access", () => {
  const view = {
    playerId: "p3",
    units: [
      { owner: "p3", type: "spearman", size: 1, hp: 100 },
      { owner: "p1", type: "artillery", size: 3, hp: 100 },
      { owner: "p4", type: "cavalry", size: 3, hp: 100 },
    ],
    cities: [],
    factions: [
      { id: "p1", relation: "bad" },
      { id: "p4", relation: "good" },
    ],
    guarantees: [
      { id: "edge", guarantor: "p4", protected: "p1", active: true },
    ],
  };
  const risk = npcWarRisk(view, "p1");
  assert.equal(risk.guaranteeCount, 1);
  assert.ok(risk.coalitionStrength > risk.targetStrength);
  assert.equal(risk.backers[0].id, "p4");
  // Adding no units for p4 changes no hidden data; the estimate remains scoped.
  const noBackerUnits = npcWarRisk({ ...view, units: view.units.slice(0, 2) }, "p1");
  assert.ok(noBackerUnits.coalitionStrength < risk.coalitionStrength);
});

test("NPC diplomacy declines a visible target when its public backer makes the coalition too strong", () => {
  const own = Array.from({ length: 5 }, (_, index) => ({
    id: `own-${index}`,
    owner: "p3",
    type: "musketeer",
    size: 1,
    hp: 100,
    q: 0,
    r: index,
  }));
  const backer = Array.from({ length: 5 }, (_, index) => ({
    id: `backer-${index}`,
    owner: "p4",
    type: "cavalry",
    size: 1,
    hp: 100,
    q: 2,
    r: index,
  }));
  const view = {
    playerId: "p3",
    turn: 6,
    cities: [{ id: "npc-city", owner: "p3", q: 0, r: 0, hp: 160, isolation: 0 }],
    units: [
      ...own,
      { id: "rival", owner: "p1", type: "spearman", size: 1, hp: 100, q: 1, r: 0 },
      ...backer,
    ],
    factions: [
      { id: "p1", kind: "player", hostile: false, relation: "neutral", peaceUntil: 0 },
      { id: "p4", kind: "player", hostile: false, relation: "good", peaceUntil: 0 },
      { id: "barb", kind: "barbarian", hostile: false },
    ],
    diplomacy: [],
    economy: { gold: 100 },
    guarantees: [{ id: "edge", guarantor: "p4", protected: "p1", active: true }],
  };
  assert.equal(npcDiplomacy(view), null);
});
