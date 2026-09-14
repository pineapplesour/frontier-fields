// Dedicated synthetic-only browser QA. Never loads a real match or .fieldline.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createApi } from "../server/http.mjs";
import { createGame, addUnit, startGame, ready, transact } from "../server/engine.mjs";
import { saveStore } from "../server/saves.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = "/tmp/fieldline-sep14-restored-diplomacy-qa";
const fixtures = path.join(runtime, "synthetic-fixtures");
const stamp = Date.now();
function fixture(legacy = false) {
  const g = createGame({ mode: "duel", rulesVersion: legacy ? "legacy" : "expansion-v1", turnMode: "simultaneous", seed: 7291, now: stamp,
    ...(!legacy ? { seats: [{ id: "p1", controller: "human", name: "QA 방장" }, { id: "p2", controller: "human", name: "QA 상대" }] } : {}) });
  g.units = []; g.cities = []; g.rivers = []; g.wars = [];
  for (const t of g.tiles) Object.assign(t, { terrain: "plains", fertility: 2, owner: null, cityId: null, farm: false, resource: null, developed: false, ruin: null, fort: null });
  g.players.p2.connected = true;
  const city = (id, owner, q, r, extra = {}) => {
    const c = { id, name: id, owner, q, r, hp: 160, population: 6, production: 0, queue: null, food: 20, growthProgress: 20,
      capital: false, isolation: 0, wallLevel: 0, wallHp: 0, territoryRadius: 1, territoryGrowth: 0,
      citizenPolicy: { auto: true, lockedSlots: [], priority: [] }, ...extra };
    g.cities.push(c); Object.assign(g.tiles.find(t => t.q === q && t.r === r), { owner, cityId: id, camp: !!c.camp }); return c;
  };
  city("QA 본도시", "p1", 4, 6); city("QA 철거대상", "p2", 6, 6); city("QA 잔존도시", "p2", 8, 6);
  Object.assign(g.tiles.find(t => t.q === 7 && t.r === 6), { owner: "p2", cityId: "QA 철거대상" });
  g.founded = { p1: true, p2: true };
  addUnit(g, "p1", "spearman", { q: 4, r: 6 });
  addUnit(g, "p2", "spearman", { q: 5, r: 6 });
  addUnit(g, "p2", "settler", { q: 4, r: 4 });
  if (legacy) {
    city("QA 점령거점", "p1", 4, 7, { hp: 80, camp: true, population: 1, occupiedTurn: 1 });
    addUnit(g, "p1", "spearman", { q: 4, r: 7 });
  }
  startGame(g, stamp);
  g.gold.p1 = 500; g.gold.p2 = 500; g.turnSeconds = 600;
  return g;
}
const round = g => { ready(g, "p1", g.turn, stamp + 10); ready(g, "p2", g.turn, stamp + 10); };
const action = (g, player, body) => transact(g, player, { turn: g.turn, ...body }, stamp + 20);
const cases = {};
const territory = fixture(); round(territory); round(territory); cases.territory = territory;
const formal = fixture(); action(formal, "p1", { action: "denounce", factionId: "p2" }); round(formal); round(formal); round(formal); cases.formal = formal;
const alliance = fixture(); action(alliance, "p1", { action: "alliance", factionId: "p2" });
action(alliance, "p2", { action: "acceptProposal", proposalId: alliance.proposals[0].id }); cases.alliance = alliance;
cases.legacy = fixture(true);
const ids = {};
for (const [name, game] of Object.entries(cases)) ids[name] = (await saveStore(fixtures).save(game, `Synthetic ${name}`, stamp)).id;
await writeFile(path.join(runtime, "fixture-info.json"), JSON.stringify(ids), { mode: 0o600 });
const { app, close } = createApi({ saveDirectory: fixtures, runtimeCheckpointDirectory: runtime, resumeRuntime: false });
const dist = process.env.FIELDLINE_QA_DIST || path.join(root, "dist");
app.use(express.static(dist));
app.get("/{*path}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
const server = app.listen(4330, "127.0.0.1", () => console.log("Restored diplomacy synthetic QA ready on 127.0.0.1:4330"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { close(); server.closeAllConnections(); server.close(() => process.exit(0)); });
