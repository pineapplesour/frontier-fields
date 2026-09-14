import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  addUnit,
  submitOrders,
  observe,
  ready,
  unready,
  resolveTurn,
  advanceDue,
  setSettings,
  startGame,
} from "../server/engine.mjs";
import { equal } from "../shared/rules.js";

function game(turnMode = "simultaneous") {
  const g = createGame({
    mode: "duel",
    rulesVersion: "expansion-v1",
    turnMode,
    now: 1000,
    seats: [
      { id: "p1", controller: "human" },
      { id: "p2", controller: "human" },
      { id: "p3", controller: "npc" },
    ],
  });
  g.units = [];
  g.wars = ["p1|p2"];
  g.rivers = [];
  for (const t of g.tiles) Object.assign(t, { terrain: "plains", owner: null, cityId: null, farm: false, developed: false, resource: null });
  g.random = () => 0.5;
  g.founded = { p1: true, p2: true, p3: true };
  g.players.p2.connected = true;
  return g;
}

test("simultaneous: both direct seats act in the same countdown, first order wins a tile", () => {
  const g = game();
  const a = addUnit(g, "p1", "spearman", { q: 4, r: 6 });
  const b = addUnit(g, "p2", "spearman", { q: 6, r: 6 });
  startGame(g, 1000);
  assert.equal(observe(g, "p1", 1100).turnMode, "simultaneous");
  assert.equal(observe(g, "p1", 1100).activePlayer, "p1");
  assert.equal(observe(g, "p2", 1100).activePlayer, "p2");
  assert.deepEqual(observe(g, "p3", 1100).activeSeats, ["p1", "p2"]);
  submitOrders(g, "p2", { turn: 1, orders: [{ unitId: b.id, action: "move", target: { q: 5, r: 6 }, path: [{ q: 5, r: 6 }] }] }, 1200);
  assert.ok(equal(b, { q: 5, r: 6 }), "p2 moves immediately even though p1 is seat one");
  // The tile taken first is no longer enterable: the later mover is stopped
  // (or engages the occupant) instead of sharing the hex.
  submitOrders(g, "p1", { turn: 1, orders: [{ unitId: a.id, action: "move", target: { q: 5, r: 6 }, path: [{ q: 5, r: 6 }] }] }, 1300);
  assert.ok(!equal(a, { q: 5, r: 6 }));
  assert.ok(equal(b, { q: 5, r: 6 }));
  // Drop the blocked route so the next round starts without an engagement.
  submitOrders(g, "p1", { turn: 1, orders: [{ unitId: a.id, action: "cancel" }] }, 1350);
  // Ready from one seat does not end the round.
  ready(g, "p1", 1, 1400);
  assert.equal(g.turn, 1);
  assert.equal(observe(g, "p1", 1500).activePlayer, "waiting");
  assert.deepEqual(observe(g, "p2", 1500).activeSeats, ["p2"]);
  assert.throws(() => submitOrders(g, "p1", { turn: 1, orders: [{ unitId: a.id, action: "fortify" }] }, 1500), /준비 완료/);
  submitOrders(g, "p2", { turn: 1, orders: [{ unitId: b.id, action: "attack", target: { q: 4, r: 6 } }] }, 1600);
  assert.ok(a.hp < 100, "p2 keeps acting until it is ready too");
  ready(g, "p2", 1, 1700);
  assert.equal(g.turn, 2, "the round settles once every direct seat is ready");
  assert.equal(g.players.p1.ready, false);
  assert.equal(observe(g, "p1", 1800).activePlayer, "p1");
  assert.equal(a.movesLeft, 4);
  assert.equal(b.movesLeft, 4);
  assert.equal(g.deadline, 1700 + g.turnSeconds * 1000);
});

test("simultaneous: the shared countdown settles the round for everyone", () => {
  const g = game();
  addUnit(g, "p1", "spearman", { q: 4, r: 6 });
  addUnit(g, "p2", "spearman", { q: 9, r: 6 });
  startGame(g, 1000);
  advanceDue(g, 1000 + g.turnSeconds * 1000 - 1);
  assert.equal(g.turn, 1);
  advanceDue(g, 1000 + g.turnSeconds * 1000 + 1);
  assert.equal(g.turn, 2);
  assert.equal(g.phase, "planning");
});

test("simultaneous: independent host setting changes while paused or in the lobby", () => {
  const g = game("sequential");
  assert.equal(observe(g, "p1", 1100).turnMode, "sequential");
  setSettings(g, "p1", { turnMode: "simultaneous" }, 1100);
  assert.equal(g.turnMode, "simultaneous", "allowed in the lobby");
  startGame(g, 1200);
  assert.throws(() => setSettings(g, "p1", { turnMode: "sequential" }, 1300), /일시정지/);
  setSettings(g, "p1", { paused: true }, 1400);
  setSettings(g, "p1", { turnMode: "sequential" }, 1500);
  assert.equal(g.turnMode, "sequential");
  assert.equal(g.activePlayer, "p1");
  assert.throws(() => setSettings(g, "p2", { turnMode: "simultaneous" }, 1600), /방장/);
  const legacy = createGame({ mode: "practice" });
  setSettings(legacy, "p1", {paused:true});
  const before=JSON.stringify({rules:legacy.rulesVersion,supply:legacy.supplyMode,stock:legacy.stockpiles});
  setSettings(legacy, "p1", { turnMode: "simultaneous" });
  assert.equal(JSON.stringify({rules:legacy.rulesVersion,supply:legacy.supplyMode,stock:legacy.stockpiles}),before);
  const plain = createGame({ mode: "practice", turnMode: "simultaneous" });
  assert.equal(plain.turnMode, "simultaneous");
  ready(plain,"p1",plain.turn);
  assert.equal(plain.turn,2,"passive practice seat does not block the round");
});

test("legacy simultaneous duel allows both seats and powder attacks without enabling upkeep",()=>{
  const g=createGame({mode:"duel",turnMode:"simultaneous",now:1000});
  g.players.p2.connected=true;g.units=[];g.rivers=[];g.wars=["p1|p2"];
  for(const t of g.tiles)t.terrain="plains";
  const a=addUnit(g,"p1","musketeer",{q:4,r:6});
  const b=addUnit(g,"p2","spearman",{q:5,r:6});
  g.stockpiles.p1.niter=0;
  startGame(g,1100);
  assert.equal(observe(g,"p2",1200).activePlayer,"p2");
  submitOrders(g,"p1",{turn:1,orders:[{unitId:a.id,action:"attack",target:{q:b.q,r:b.r}}]},1200);
  assert.ok(b.hp<100);assert.equal(g.stockpiles.p1.niter,0);
  ready(g,"p1",1,1300);ready(g,"p2",1,1400);
  assert.equal(g.turn,2);assert.equal(g.rulesVersion,"legacy");assert.equal(g.supplyMode,"off");
  assert.equal(g.stockpiles.p1.niter,0);
  setSettings(g,"p1",{paused:true},1500);setSettings(g,"p1",{turnMode:"sequential"},1600);
  assert.equal(g.rulesVersion,"legacy");assert.equal(g.supplyMode,"off");
});

test("sequential expansion matches are unchanged by the new option", () => {
  const g = game("sequential");
  const b = addUnit(g, "p2", "spearman", { q: 6, r: 6 });
  startGame(g, 1000);
  assert.equal(observe(g, "p2", 1100).activePlayer, "p1");
  assert.deepEqual(observe(g, "p2", 1100).activeSeats, ["p1"]);
  submitOrders(g, "p2", { turn: 1, orders: [{ unitId: b.id, action: "move", target: { q: 5, r: 6 }, path: [{ q: 5, r: 6 }] }] }, 1200);
  assert.ok(equal(b, { q: 6, r: 6 }), "off-turn moves only queue in sequential mode");
  ready(g, "p1", 1, 1300);
  assert.equal(g.activePlayer, "p2");
  assert.equal(g.turn, 1);
});

test("simultaneous: a ready seat may take it back until the round settles", () => {
  const g = game();
  const a = addUnit(g, "p1", "spearman", { q: 4, r: 6 });
  addUnit(g, "p2", "spearman", { q: 9, r: 6 });
  startGame(g, 1000);
  ready(g, "p1", 1, 1100);
  assert.equal(g.players.p1.ready, true);
  assert.equal(observe(g, "p1", 1150).activePlayer, "waiting");
  assert.throws(() => submitOrders(g, "p1", { turn: 1, orders: [{ unitId: a.id, action: "fortify" }] }, 1150), /준비 완료/);
  assert.throws(() => unready(g, "p2", 1, 1200), /아직 턴을 마치지/);
  const before = g.revision;
  const obs = unready(g, "p1", 1, 1200);
  assert.equal(g.players.p1.ready, false);
  assert.equal(obs.ready, false);
  assert.equal(obs.activePlayer, "p1");
  assert.equal(g.revision, before + 1);
  assert.ok(obs.events.some((e) => /턴 종료를 해제/.test(e.text)));
  assert.deepEqual(observe(g, "p2", 1250).activeSeats, ["p1", "p2"]);
  submitOrders(g, "p1", { turn: 1, orders: [{ unitId: a.id, action: "fortify" }] }, 1300);
  assert.equal(g.turn, 1, "orders are accepted again without settling");
  // Both seats ready: the round settles first, so there is nothing to undo.
  ready(g, "p1", 1, 1400);
  ready(g, "p2", 1, 1500);
  assert.equal(g.turn, 2);
  assert.throws(() => unready(g, "p1", 1, 1600), /턴이 바뀌었어요/);
  assert.throws(() => unready(g, "p1", 2, 1600), /아직 턴을 마치지/);
  // The shared countdown also settles before an unready can land.
  ready(g, "p1", 2, 1700);
  const late = 1500 + g.turnSeconds * 1000 + 1;
  assert.throws(() => unready(g, "p1", 2, late), /이미 정산됐어요/);
  assert.equal(g.turn, 3);
  assert.equal(g.players.p1.ready, false);
});

test("sequential: unready is refused with a clear message", () => {
  const g = game("sequential");
  addUnit(g, "p1", "spearman", { q: 4, r: 6 });
  addUnit(g, "p2", "spearman", { q: 9, r: 6 });
  startGame(g, 1000);
  assert.throws(() => unready(g, "p1", 1, 1100), /교대 턴에서는 턴 종료를 해제할 수 없어요/);
  ready(g, "p1", 1, 1200);
  assert.equal(g.activePlayer, "p2");
  assert.throws(() => unready(g, "p1", 1, 1300), /교대 턴/);
});
