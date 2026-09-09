import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveStore } from "../server/saves.mjs";
import { createGame, observe } from "../server/engine.mjs";
import { createApi } from "../server/http.mjs";

test("disk saves survive a new store, preserve random continuation and private memories, restore paused", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fieldline-save-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = createGame({ now: 1000 });
  g.random();
  g.random();
  const before = JSON.stringify(g);
  const saved = await saveStore(dir).save(g, "시험 저장", 11000);
  assert.equal(JSON.stringify(g), before);
  assert.deepEqual(Object.keys(saved).sort(), [
    "id",
    "mode",
    "name",
    "savedAt",
    "turn",
  ]);
  const restored = await saveStore(dir).load(saved.id, 100000);
  assert.equal(restored.paused, true);
  assert.equal(restored.deadline, null);
  assert.equal(restored.pausedRemaining, 50000);
  assert.deepEqual(restored.cityContacts, g.cityContacts);
  assert.deepEqual(restored.units, g.units);
  assert.deepEqual(restored.stockpiles, g.stockpiles);
  for (let i = 0; i < 20; i++) assert.equal(restored.random(), g.random());
  assert.ok(!Object.hasOwn(observe(restored, "p1"), "randomState"));
  await assert.rejects(() => saveStore(dir).load("../../not-a-save", 1));
});
test("save endpoint restricts p2; restart load issues fresh seats, leaks no world or original credentials", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fieldline-save-api-"));
  const running = [];
  t.after(async () => {
    for (const { server, close } of running) {
      close();
      server.closeAllConnections();
      server.close();
    }
    await rm(dir, { recursive: true, force: true });
  });
  const launch = async () => {
    const { app, close } = createApi({ now: () => 1000, saveDirectory: dir });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    running.push({ server, close });
    return async (route, body, token) => {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api${route}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      return { status: res.status, data: await res.json() };
    };
  };
  const api = await launch(),
    a = (await api("/matches", { mode: "duel" })).data;
  const b = (await api("/join", { code: a.inviteCode })).data;
  assert.equal(
    (await api(`/matches/${a.matchId}/save`, { name: "타인" }, b.token)).status,
    403,
  );
  const s = await api(
    `/matches/${a.matchId}/save`,
    { name: "다음에" },
    a.token,
  );
  assert.equal(s.status, 201);
  const api2 = await launch(),
    loaded = (await api2("/saves/load", { id: s.data.id })).data;
  assert.notEqual(loaded.token, a.token);
  assert.ok(loaded.inviteCode);
  assert.equal(loaded.observation.phase, "lobby");
  assert.equal(loaded.observation.paused, true);
  assert.equal(loaded.observation.playerId, "p1");
  assert.equal(loaded.observation.randomState, undefined);
  assert.equal((await api2("/saves/load", { id: "x" })).status, 404);
});
