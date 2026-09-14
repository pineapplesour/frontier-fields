import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createGame,
  submitOrders,
  observe,
  ready,
  advanceDue,
  startGame,
  setCitySettings,
  setCitizenSettings,
  restoreRuntimeGame,
} from "../server/engine.mjs";
import { saveStore } from "../server/saves.mjs";
import { createApi } from "../server/http.mjs";
import {
  writeRuntimeCheckpoint,
  readRuntimeCheckpoint,
  restoreRuntimeEntries,
} from "../server/runtimeCheckpoint.mjs";
import { distance } from "../shared/rules.js";

// Host report 2026-09-15: "자꾸 생산하던 게 없어짐" in a duel / expansion-v1 /
// simultaneous / supply off match.  These tests pin the invariant that a
// city's production queue and progress survive every non-completion path
// the web UI can trigger: empty `production` orders, city and citizen
// settings, host settings, ready/timeout settlement, runtime checkpoint
// resume, and disk save/load.

function game() {
  const g = createGame({
    mode: "duel",
    rulesVersion: "expansion-v1",
    turnMode: "simultaneous",
    now: 1000,
    seats: [
      { id: "p1", controller: "human" },
      { id: "p2", controller: "human" },
      { id: "p3", controller: "npc" },
    ],
  });
  g.units = [];
  g.rivers = [];
  g.random = () => 0.5;
  g.founded = { p1: true, p2: true, p3: true };
  g.players.p2.connected = true;
  g.turnSeconds = 60;
  for (const t of g.tiles)
    Object.assign(t, { terrain: "plains", owner: null, cityId: null, farm: false, developed: false, resource: null, fertility: 2 });
  g.cities = [];
  const mk = (id, owner, q, r, name) => {
    const c = {
      id, owner, name, q, r,
      population: 8, food: 3, growthProgress: 0, growthHalfGranted: false, starvationTurns: 0,
      citizenPolicy: { auto: true, lockedSlots: [], priority: [] },
      mobilizationQueue: [], mobilizationLastDispatchTurn: null,
      production: 0, queue: null, hp: 160, capital: true, isolation: 0, supplied: true,
      wallLevel: 0, attackUsed: false, rulesVersion: "expansion-v1", territoryRadius: 2, territoryGrowth: 0,
    };
    g.cities.push(c);
    for (const t of g.tiles)
      if (distance(t, c) <= 2) { t.owner = owner; t.cityId = id; if (distance(t, c) === 1) t.farm = true; }
    return c;
  };
  mk("c1", "p1", 4, 6, "방장 첫 도시 1");
  mk("c2", "p2", 14, 6, "상대 도시");
  return g;
}
const c1 = (g) => g.cities.find((c) => c.id === "c1");

test("production queue persists across simultaneous rounds (ready and timeout) until completion", () => {
  const g = game();
  startGame(g, 1000);
  submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: "settler" }] }, 1100);
  assert.equal(c1(g).queue, "settler");
  assert.equal(c1(g).manpowerReserved, 0.5);
  let t = 2000, previous = 0, completedAt = null;
  for (let i = 0; i < 8 && completedAt === null; i++) {
    if (i % 2 === 0) { ready(g, "p1", g.turn, t); ready(g, "p2", g.turn, t + 10); }
    else { t = g.deadline + 1; advanceDue(g, t); }
    t += 1000;
    const c = c1(g);
    if (c.queue === null) {
      completedAt = g.turn;
      assert.deepEqual(c.lastProduction, { type: "settler", turn: g.turn - 1 });
      assert.ok(g.units.some((u) => u.owner === "p1" && u.type === "settler"), "completion must spawn the unit");
      break;
    }
    assert.equal(c.queue, "settler", `round ${i}`);
    assert.ok(c.production > previous, `progress must advance in round ${i}`);
    previous = c.production;
  }
  assert.ok(completedAt, "settler should complete within eight rounds");
});

test("orders without production, city-settings and citizen-settings never touch the queue", () => {
  const g = game();
  startGame(g, 1000);
  submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: "spearman" }] }, 1100);
  c1(g).production = 7;
  submitOrders(g, "p1", { turn: 1, orders: [], production: [] }, 1200);
  submitOrders(g, "p1", { turn: 1, orders: [] }, 1300);
  submitOrders(g, "p1", { turn: 1 }, 1400);
  // Re-choosing the same type keeps progress.
  submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: "spearman" }] }, 1500);
  const target = observe(g, "p1", 1550).cities.find((c) => c.id === "c1").expansionCandidates[0];
  setCitySettings(g, "p1", { turn: 1, cityId: "c1", expansionTarget: target }, 1600);
  setCitySettings(g, "p1", { turn: 1, cityId: "c1", expansionTarget: null }, 1650);
  setCitizenSettings(g, "p1", { turn: 1, cityId: "c1", auto: false }, 1700);
  setCitizenSettings(g, "p1", { turn: 1, cityId: "c1", auto: true }, 1750);
  assert.equal(c1(g).queue, "spearman");
  assert.equal(c1(g).production, 7);
  assert.equal(c1(g).manpowerReserved, 0.5);
  // Only an explicit null entry clears the queue.
  submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: null }] }, 1800);
  assert.equal(c1(g).queue, null);
  assert.equal(c1(g).production, 0);
  assert.equal(c1(g).manpowerReserved, 0);
});

test("disk save/load and runtime checkpoint keep queue, progress and reserve", async () => {
  const g = game();
  startGame(g, 1000);
  submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: "settler" }] }, 1100);
  c1(g).production = 17;
  const saveDir = await mkdtemp(path.join(tmpdir(), "ff-save-"));
  const meta = await saveStore(saveDir).save(g, "중간", 5000);
  const loaded = await saveStore(saveDir).load(meta.id, 9000);
  assert.equal(c1(loaded).queue, "settler");
  assert.equal(c1(loaded).production, 17);
  assert.equal(c1(loaded).manpowerReserved, 0.5);
  loaded.players.p2.connected = true;
  startGame(loaded, 9000);
  assert.equal(observe(loaded, "p1", 9100).cities.find((c) => c.id === "c1").queue, "settler");

  const ckDir = await mkdtemp(path.join(tmpdir(), "ff-ck-"));
  await writeRuntimeCheckpoint(ckDir, new Map([["m1", { game: g, tokens: { p1: "t" }, invites: {}, touched: 1 }]]), 3000);
  const entries = restoreRuntimeEntries(await readRuntimeCheckpoint(ckDir), (snap, at) => restoreRuntimeGame(snap, at, 4000));
  assert.equal(c1(entries[0].game).queue, "settler");
  assert.equal(c1(entries[0].game).production, 17);
});

test("HTTP: the exact web-UI call sequence keeps a queued spearman until it completes", async (t) => {
  const g = game();
  startGame(g, 1000);
  const ckDir = await mkdtemp(path.join(tmpdir(), "ff-http-ck-"));
  const saveDir = await mkdtemp(path.join(tmpdir(), "ff-http-save-"));
  await writeRuntimeCheckpoint(ckDir, new Map([["m1", { game: g, tokens: { p1: "tokp1", p2: "tokp2" }, invites: {}, touched: 1000 }]]), 1500);
  let clock = 2000;
  const { app, close } = createApi({ now: () => clock, resumeRuntime: true, runtimeCheckpointDirectory: ckDir, saveDirectory: saveDir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => { close(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const req = async (p, { token, body } = {}) => {
    const r = await fetch(`${url}/api${p}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  let m = "/matches/m1", tok = "tokp1";
  const view = async () => (await req(m, { token: tok })).data;
  const city = async () => (await view()).cities.find((c) => c.id === "c1");
  const ok = async (p, body, token = tok) => {
    const r = await req(p, { token, body });
    assert.equal(r.status, 200, `${p}: ${r.data.error}`);
    return r.data;
  };
  await ok(`${m}/settings`, { paused: false });
  await ok(`${m}/orders`, { turn: 1, production: [{ cityId: "c1", type: "spearman" }] });
  assert.equal((await city()).queue, "spearman");
  await ok(`${m}/orders`, { turn: 1, orders: [] });
  await ok(`${m}/city-settings`, { turn: 1, cityId: "c1", expansionTarget: (await city()).expansionCandidates[0] });
  await ok(`${m}/citizen-settings`, { turn: 1, cityId: "c1", auto: false });
  await ok(`${m}/settings`, { paused: true });
  await ok(`${m}/settings`, { paused: false });
  await ok(`${m}/settings`, { turnSeconds: 60 });
  assert.equal((await city()).queue, "spearman");
  // Round 1: host ready, guest times out on the shared countdown.
  await ok(`${m}/ready`, { turn: 1 });
  clock = (await view()).deadline + 500;
  await new Promise((r) => setTimeout(r, 400));
  let c = await city();
  assert.equal((await view()).turn, 2);
  assert.equal(c.queue, "spearman");
  assert.ok(c.production > 0);
  const progress = c.production;
  // Runtime checkpoint and disk save mid-production, then load into a new match.
  assert.equal((await req(`${m}/runtime-checkpoint`, { token: tok, body: {} })).status, 201);
  const saved = await req(`${m}/save`, { token: tok, body: { name: "중간" } });
  assert.equal(saved.status, 201);
  const loaded = await req("/saves/load", { body: { id: saved.data.id } });
  assert.equal(loaded.status, 200);
  m = `/matches/${loaded.data.matchId}`; tok = loaded.data.token;
  c = await city();
  assert.equal(c.queue, "spearman");
  assert.equal(c.production, progress);
  const guest = await req("/join", { body: { code: loaded.data.inviteCode } });
  await ok(`${m}/start`, {});
  c = await city();
  assert.equal(c.queue, "spearman");
  assert.equal(c.production, progress);
  // Rounds until completion: the queue only clears once the unit exists.
  for (let i = 0; i < 4; i++) {
    const turn = (await view()).turn;
    await ok(`${m}/ready`, { turn });
    await ok(`${m}/ready`, { turn }, guest.data.token);
    const v = await view();
    c = v.cities.find((x) => x.id === "c1");
    if (c.queue === null) {
      assert.equal(c.productionPending, true);
      assert.ok(v.units.some((u) => u.owner === "p1" && u.type === "spearman"));
      return;
    }
    assert.equal(c.queue, "spearman");
  }
  assert.fail("spearman never completed");
});

import { restoreRuntimeGame as restoreRuntime } from "../server/engine.mjs";
import { confirmClearProduction } from "../src/productionHelpers.js";

test("diagnostic: clearing or replacing a queue via orders emits a city event and a console line", () => {
  const g = game();
  startGame(g, 1000);
  submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: "spearman" }] }, 1100);
  c1(g).production = 9;
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: "settler" }] }, 1200);
    submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: null }] }, 1300);
    submitOrders(g, "p1", { turn: 1, production: [{ cityId: "c1", type: "spearman" }] }, 1400);
  } finally {
    console.log = original;
  }
  const diag = g.events.p1.filter((e) => e.kind === "productionCleared");
  assert.equal(diag.length, 2, "queue empty -> spearman must not report a clear");
  assert.match(diag[0].text, /방장 첫 도시 1 생산 변경 · 창병 \(진행 9\/20\) → 개척자/);
  assert.equal(diag[0].previousType, "spearman");
  assert.match(diag[1].text, /생산 취소 · 개척자 \(진행 0\/40\)/);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[orders\] p1 cleared production of c1 \(spearman 9\/20\) payload=\[\{"cityId":"c1","type":"settler"\}\]$/);
  assert.match(lines[1], /"type":null/);
  assert.ok(!g.events.p2.some((e) => e.kind === "productionCleared"), "only the owner sees it");
});

test("diagnostic: 생산 안 함 asks for confirmation only when progress exists", () => {
  const asked = [];
  const ask = (m) => { asked.push(m); return false; };
  assert.equal(confirmClearProduction({ queue: null, production: 0 }, ask), true);
  assert.equal(confirmClearProduction({ queue: "spearman", production: 0, rulesVersion: "expansion-v1" }, ask), true);
  assert.equal(asked.length, 0);
  assert.equal(confirmClearProduction({ queue: "spearman", production: 9, rulesVersion: "expansion-v1" }, ask), false);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /창병 생산이 9\/20까지 진행됐어요/);
  assert.equal(confirmClearProduction({ queue: "spearman", production: 9, rulesVersion: "expansion-v1" }, () => true), true);
});

test("diagnostic: runtime restore from a checkpoint older than the current turn start warns every observer", () => {
  const g = game();
  startGame(g, 1000);
  g.turnStartedAt = 50_000;
  const snapshot = JSON.parse(JSON.stringify(g));
  const stale = restoreRuntime(snapshot, 40_000, 60_000);
  const text = "서버 재시작으로 마지막 체크포인트 이후의 변경이 사라졌을 수 있어요";
  for (const id of ["p1", "p2"]) assert.ok(stale.events[id].some((e) => e.text === text && e.kind === "restartLoss"), id);
  assert.equal(stale.restartLossPossible, true);
  assert.equal(observe(stale, "p1", 60_000).events.some((e) => e.text === text), true);
  const fresh = restoreRuntime(JSON.parse(JSON.stringify(g)), 55_000, 60_000);
  assert.ok(!fresh.events.p1.some((e) => e.text === text));
  assert.notEqual(fresh.restartLossPossible, true);
});
