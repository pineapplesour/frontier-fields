// Isolated synthetic QA only. Does not use .fieldline or any real match.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createApi } from "../server/http.mjs";
import { createGame, addUnit, startGame, submitOrders } from "../server/engine.mjs";
import { saveStore } from "../server/saves.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = "/tmp/fieldline-sep14-followup-qa-runtime";
const fixtures = path.join(runtime, "synthetic-fixtures");
const now = Date.now();
const g = createGame({ mode: "duel", rulesVersion: "expansion-v1", turnMode: "simultaneous", seed: 7291, now,
  seats: [{ id: "p1", controller: "human", name: "QA 방장" }, { id: "p2", controller: "human", name: "QA 상대" }] });
g.units = []; g.cities = []; g.rivers = []; g.wars = [];
for (const t of g.tiles) Object.assign(t, { terrain: "plains", fertility: 2, owner: null, cityId: null, farm: false, resource: null, developed: false, ruin: null });
g.players.p2.connected = true;
const a = addUnit(g, "p1", "settler", { q: 4, r: 6 });
const b = addUnit(g, "p2", "settler", { q: 14, r: 8 });
startGame(g, now);
submitOrders(g, "p1", { turn: 1, orders: [{ unitId: a.id, action: "found" }] }, now + 1);
submitOrders(g, "p2", { turn: 1, orders: [{ unitId: b.id, action: "found" }] }, now + 2);
const city = g.cities.find(c => c.owner === "p1");
city.name = "지도 QA 도시"; city.population = 6; city.food = 10;
g.gold.p1 = 500; g.gold.p2 = 500; g.turnSeconds = 600;
const hill = g.tiles.find(t => t.q === 5 && t.r === 6);
Object.assign(hill, { terrain: "hills", farm: true, owner: "p1", cityId: city.id });
addUnit(g, "p1", "builder", { q: 4, r: 5 });
addUnit(g, "p1", "spearman", { q: 4, r: 5 });
const fixture = await saveStore(fixtures).save(g, "Synthetic map and ultimatum QA", now);
await writeFile(path.join(runtime, "fixture-info.json"), JSON.stringify({ fixtureId: fixture.id, cityId: city.id, hill: { q: 5, r: 6 }, stack: { q: 4, r: 5 } }), { mode: 0o600 });
const { app, close } = createApi({ saveDirectory: fixtures, runtimeCheckpointDirectory: runtime, resumeRuntime: false });
app.use(express.static(path.join(root, "dist")));
app.get("/{*path}", (_req, res) => res.sendFile(path.join(root, "dist/index.html")));
const server = app.listen(4330, "127.0.0.1", () => console.log("Synthetic QA ready on 127.0.0.1:4330"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { close(); server.closeAllConnections(); server.close(() => process.exit(0)); });
