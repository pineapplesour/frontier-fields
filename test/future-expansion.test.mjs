import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimNpcSeat,
  createGame,
  expansionCandidates,
  observe,
  ready,
  restoreRuntimeGame,
  setCitySettings,
  setSettings,
  startGame,
  submitOrders,
  transact,
} from "../server/engine.mjs";
import {
  distance,
  growthHalfTarget,
  growthTarget,
  WIDTH,
  HEIGHT,
} from "../shared/rules.js";
import {
  readRuntimeCheckpointSync,
  restoreRuntimeEntries,
  writeRuntimeCheckpoint,
} from "../server/runtimeCheckpoint.mjs";

const futureSeats = [
  { id: "p1", controller: "human", name: "방장" },
  { id: "p2", controller: "human", name: "손님" },
  { id: "p3", controller: "human", name: "세 번째 사람" },
  { id: "p4", controller: "agent", name: "API 조종자" },
  { id: "p5", controller: "npc", name: "규칙 문명" },
];

function expansionGame(seats = futureSeats, now = 1_000) {
  return createGame({
    mode: "duel",
    seed: 17_291,
    now,
    rulesVersion: "expansion-v1",
    seats,
  });
}

test("expansion setup starts eight-safe 20x20 mobile civilizations without leaking start positions", () => {
  const g = expansionGame();
  assert.equal(g.tiles.length, WIDTH * HEIGHT);
  assert.equal(g.tiles.length, 400);
  assert.deepEqual(
    g.cities.filter((c) => c.owner.startsWith("p")).map((c) => c.owner),
    [],
  );
  assert.ok(g.cities.some((c) => c.owner === "cs"));
  assert.ok(g.units.filter((u) => u.owner === "p1").some((u) => u.type === "settler"));
  assert.equal(g.units.filter((u) => u.owner === "p1").length, 6);
  const starts = Object.values(g.startPositions);
  assert.equal(starts.length, futureSeats.length);
  for (let i = 0; i < starts.length; i++)
    for (let j = i + 1; j < starts.length; j++)
      assert.ok(distance(starts[i], starts[j]) >= 4);
  const view = observe(g, "p1");
  assert.equal(view.rulesVersion, "expansion-v1");
  assert.equal(view.world.width, WIDTH);
  assert.equal(view.world.height, HEIGHT);
  assert.equal("startPositions" in view, false);
  assert.equal("tokens" in view, false);
  assert.deepEqual(
    view.seats
      .filter(({ id }) => id.startsWith("p"))
      .map(({ id, controller }) => [id, controller]),
    futureSeats.map(({ id, controller }) => [id, controller]),
  );
});

test("growth crosses half and full population thresholds one tile each and stays contiguous within radius three", () => {
  const g = expansionGame([
    { id: "p1", controller: "human" },
    { id: "p2", controller: "npc" },
  ]);
  startGame(g, 1_000);
  const settler = g.units.find((u) => u.owner === "p1" && u.type === "settler");
  submitOrders(g, "p1", {
    turn: 1,
    orders: [{ unitId: settler.id, action: "found" }],
  }, 1_000);
  ready(g, "p1", 1, 1_000);
  const city = g.cities.find((c) => c.owner === "p1");
  assert.ok(city);
  const initialLand = g.tiles.filter((t) => t.cityId === city.id).length;
  const halfTarget = expansionCandidates(g, city)[1];
  assert.ok(halfTarget);
  setCitySettings(g, "p1", {
    turn: g.turn,
    cityId: city.id,
    expansionTarget: { q: halfTarget.q, r: halfTarget.r },
  }, 1_000);
  city.food = growthHalfTarget(city.population) - 1;
  ready(g, "p1", g.turn, 1_000);
  assert.equal(city.population, 1);
  assert.equal(city.food, growthHalfTarget(1) + 1);
  assert.equal(g.tiles.filter((t) => t.cityId === city.id).length, initialLand + 1);
  assert.equal(g.tiles.find((t) => t.cityId === city.id && t.q === halfTarget.q && t.r === halfTarget.r).owner, "p1");

  city.food = growthTarget(city.population) - 1;
  const beforeFull = g.tiles.filter((t) => t.cityId === city.id).length;
  ready(g, "p1", g.turn, 1_000);
  assert.equal(city.population, 2);
  assert.equal(city.food, 1);
  assert.equal(g.tiles.filter((t) => t.cityId === city.id).length, beforeFull + 1);
  assert.equal(city.territoryGrowth, 2);
  assert.ok(
    g.tiles
      .filter((t) => t.cityId === city.id)
      .every((t) => distance(t, city) <= 3),
  );
  assert.ok(g.tiles.filter((t) => t.cityId === city.id).every((t) => t.owner === "p1"));
});

test("host NPC claim changes only controller metadata and leaves the saved civilization intact", () => {
  const g = expansionGame([
    { id: "p1", controller: "human" },
    { id: "p2", controller: "npc" },
  ]);
  const before = {
    cities: structuredClone(g.cities),
    units: structuredClone(g.units),
    tiles: structuredClone(g.tiles),
    events: structuredClone(g.events),
  };
  const result = claimNpcSeat(g, "p1", "p2");
  assert.deepEqual(result, { seatId: "p2", controller: "human", connected: false });
  assert.deepEqual(g.cities, before.cities);
  assert.deepEqual(g.units, before.units);
  assert.deepEqual(g.tiles, before.tiles);
  assert.deepEqual(g.events, before.events);
  assert.equal(g.players.p2.controller, "human");
  assert.equal(g.players.p2.claimable, false);
  assert.throws(() => claimNpcSeat(g, "p2", "p1"), /방장만/);
});

test("produced and instantly purchased units reserve manpower, merge sums ledgers, disband returns it, and sale does not", () => {
  const g = expansionGame([
    { id: "p1", controller: "human" },
    { id: "p2", controller: "npc" },
  ]);
  startGame(g, 1_000);
  const settler = g.units.find((u) => u.owner === "p1" && u.type === "settler");
  submitOrders(g, "p1", {
    turn: 1,
    orders: [{ unitId: settler.id, action: "found" }],
  }, 1_000);
  ready(g, "p1", 1, 1_000);
  const city = g.cities.find((c) => c.owner === "p1");
  g.units = g.units.filter((u) => u.owner !== "p1");
  city.population = 4;
  const startingGold = g.gold.p1;
  const startingIron = g.stockpiles.p1.iron;
  const purchased = observe(g, "p1").economy.unitPrices.builder;
  assert.equal(purchased, 36);
  transact(g, "p1", {
    turn: g.turn,
    action: "buyUnit",
    cityId: city.id,
    type: "builder",
  }, 1_000);
  const builder = g.units.find((u) => u.owner === "p1" && u.type === "builder");
  assert.equal(builder.manpowerCost, 0.5);
  assert.equal(builder.homeCityId, city.id);
  assert.equal(city.population, 3.5);
  assert.equal(g.gold.p1, startingGold - purchased);
  assert.equal(g.stockpiles.p1.iron, startingIron);

  transact(g, "p1", {
    turn: g.turn,
    action: "buyUnit",
    cityId: city.id,
    type: "spearman",
  }, 1_000);
  const spear = g.units.find((u) => u.owner === "p1" && u.type === "spearman");
  const adjacent = g.tiles.find((t) =>
    t.terrain !== "mountain" &&
    distance(t, city) === 1 &&
    !g.units.some((u) => u.q === t.q && u.r === t.r),
  );
  Object.assign(spear, adjacent);
  transact(g, "p1", {
    turn: g.turn,
    action: "buyUnit",
    cityId: city.id,
    type: "spearman",
  }, 1_000);
  const spear2 = g.units.find(
    (u) => u.owner === "p1" && u.id !== spear.id && u.type === "spearman",
  );
  // Put the two military units on adjacent legal tiles and merge them.
  Object.assign(spear2, { q: city.q, r: city.r });
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [{ unitId: spear.id, action: "merge", targetId: spear2.id }],
  }, 1_000);
  ready(g, "p1", g.turn, 1_000);
  const merged = g.units.find((u) => u.id === spear2.id);
  assert.equal(merged.manpowerCost, 1);
  assert.equal(merged.manpowerSources[0].amount, 1);
  const beforeDisband = city.population;
  transact(g, "p1", {
    turn: g.turn,
    action: "disbandUnit",
    unitId: merged.id,
  }, 1_000);
  assert.equal(city.population, beforeDisband + 1);

  const sold = g.units.find((u) => u.id === builder.id);
  const beforeSale = city.population;
  transact(g, "p1", {
    turn: g.turn,
    action: "sellUnit",
    unitId: sold.id,
  }, 1_000);
  assert.equal(city.population, beforeSale);
});

test("rolling runtime checkpoint is private, atomic, and restores sessions with paused time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fieldline-expansion-checkpoint-"));
  try {
    const g = expansionGame([
      { id: "p1", controller: "human" },
      { id: "p2", controller: "human" },
    ]);
    g.paused = true;
    g.pausedRemaining = 12_345;
    g.deadline = null;
    const matches = new Map([
      [
        "future-match",
        {
          game: g,
          tokens: { p1: "host-secret", p2: "guest-secret" },
          invites: { p2: "guest-invite" },
          touched: 2_000,
        },
      ],
    ]);
    const metadata = await writeRuntimeCheckpoint(directory, matches, 3_000);
    assert.equal(metadata.matchCount, 1);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const payload = readRuntimeCheckpointSync(directory);
    assert.equal(payload.matches.length, 1);
    const restored = restoreRuntimeEntries(
      payload,
      (snapshot, checkpointedAt) =>
        // A later process resumes with a paused client reconnect boundary.
        restoreRuntimeGame(snapshot, checkpointedAt, 9_000),
    )[0];
    assert.equal(restored.matchId, "future-match");
    assert.equal(restored.tokens.p1, "host-secret");
    assert.equal(restored.tokens.p2, "guest-secret");
    assert.equal(restored.invites.p2, "guest-invite");
    assert.equal(restored.game.paused, true);
    assert.equal(restored.game.pausedRemaining, 12_345);
    assert.equal(typeof restored.game.random, "function");
    assert.equal((await stat(join(directory, "fieldline-runtime-checkpoint.json"))).mode & 0o777, 0o600);

    const active = expansionGame([
      { id: "p1", controller: "human" },
      { id: "p2", controller: "human" },
    ], 4_000);
    active.phase = "planning";
    active.paused = false;
    active.turnStartedAt = 4_000;
    active.deadline = 64_000;
    const resumed = restoreRuntimeGame(
      JSON.parse(JSON.stringify(active)),
      14_000,
      20_000,
    );
    assert.equal(resumed.paused, true);
    assert.equal(resumed.pausedRemaining, 50_000);
    assert.equal(resumed.pausedAt, 20_000);
    setSettings(resumed, "p1", { paused: false }, 20_000);
    assert.equal(Number.isFinite(resumed.deadline), true);
    assert.equal(resumed.deadline, 70_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
