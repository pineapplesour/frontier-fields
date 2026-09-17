import test from "node:test";
import assert from "node:assert/strict";
import { createGame, addUnit, startGame, resolveTurn, transact } from "../server/engine.mjs";
import { updateContacts } from "../server/engine.mjs";
import { repairRememberedOwnership } from "../server/engine.mjs";
import { key, neighbors, equal } from "../shared/rules.js";
import { TRADE_ROUTE, tradePayout } from "../server/tradeRoutes.mjs";

// 2026-09-18 user requests covered here:
//  * 상인은 교역을 시작할 수 있고 자동으로 왕복하며, 교역 도시는 규모·농지·자원에 따라 수입이 다르다.
//  * 내 도시가 점령당하면 이전 주인의 지도·도시 표시가 즉시 상대 색으로 바뀐다.

function base(rulesVersion = "expansion-v1") {
  const g = createGame({ mode: "duel", rulesVersion, turnMode: "simultaneous", now: 1000,
    seats: [{ id: "p1", controller: "human" }, { id: "p2", controller: "human" }, { id: "p3", controller: "npc" }] });
  g.units = []; g.cities = []; g.rivers = []; g.wars = [];
  for (const t of g.tiles)
    Object.assign(t, { terrain: "plains", fertility: 2, owner: null, cityId: null, farm: false, resource: null, developed: false, ruin: null, fort: null, feature: null, encampment: null });
  g.players.p1.connected = true; g.players.p2.connected = true;
  g.founded = { p1: true, p2: true, p3: true };
  const at = (q, r) => g.tiles.find((t) => t.q === q && t.r === r);
  const city = (id, owner, q, r, population = 3) => {
    const c = { id, name: id, owner, q, r, hp: 160, maxHp: 160, population, production: 0, queue: null, food: 20,
      growthProgress: 0, capital: false, isolation: 0, wallLevel: 0, wallHp: 0, territoryRadius: 1, territoryGrowth: 0,
      citizenPolicy: { auto: true, lockedSlots: [], priority: [] } };
    g.cities.push(c); Object.assign(at(q, r), { owner, cityId: id }); return c;
  };
  return { g, at, city };
}

test("merchant trade route pays gold for each completed outbound leg, scaled by the partner city", () => {
  const { g, at, city } = base();
  const home = city("home", "p2", 6, 6, 4);
  home.tradingPost = { built: true, builtTurn: 1 };
  const rich = city("rich", "p1", 12, 6, 8);   // big, farmed, mined partner
  const poor = city("poor", "p3", 10, 10, 1);  // tiny partner
  for (const n of neighbors(rich)) Object.assign(at(n.q, n.r), { owner: "p1", cityId: "rich" });
  Object.assign(at(11, 5), { owner: "p1", cityId: "rich", farm: true });
  Object.assign(at(12, 5), { owner: "p1", cityId: "rich", farm: true });
  Object.assign(at(13, 6), { owner: "p1", cityId: "rich", resource: "iron", developed: true });
  startGame(g, 1000);
  const merchant = addUnit(g, "p2", "merchant", { q: 6, r: 6 });
  merchant.tradingPostCityId = home.id;
  updateContacts(g);

  // Payout only counts what the trading player has actually explored (fog
  // fairness), so an unseen farm/mine does not pay yet.
  const unknownPayout = tradePayout(g, "p2", rich);
  const remember = (tile) => {
    g.explored.p2[key(tile)] = { q: tile.q, r: tile.r, terrain: tile.terrain, fertility: tile.fertility,
      resource: tile.resource, owner: tile.owner, farm: tile.farm, developed: tile.developed, feature: null,
      ruin: null, fort: null, encampment: null, cityId: tile.cityId, cityName: rich.name, camp: false, lastSeenTurn: g.turn };
  };
  remember(at(11, 5)); remember(at(12, 5)); remember(at(13, 6));
  const richPayout = tradePayout(g, "p2", rich);
  const poorPayout = tradePayout(g, "p2", poor);
  assert.equal(unknownPayout, TRADE_ROUTE.BASE_GOLD + TRADE_ROUTE.GOLD_PER_POPULATION * 8);
  assert.ok(richPayout > poorPayout, `big farmed mined city pays more (${richPayout} > ${poorPayout})`);
  assert.equal(
    richPayout,
    TRADE_ROUTE.BASE_GOLD + TRADE_ROUTE.GOLD_PER_POPULATION * 8 + TRADE_ROUTE.GOLD_PER_FARM * 2 + TRADE_ROUTE.GOLD_PER_RESOURCE * 1,
  );

  const goldBefore = g.gold.p2;
  const started = transact(g, "p2", { turn: g.turn, action: "startTradeRoute", unitId: merchant.id, cityId: rich.id }, 1100);
  const route = started.tradeRoutes.find((r) => r.partnerCityId === rich.id);
  assert.ok(route, "route is published to the owner");
  assert.equal(route.goldPerTrip, richPayout);

  // The route shuttles by itself: outbound leg -> payment -> inbound leg.
  for (let i = 0; i < route.legTurns; i += 1) resolveTurn(g, 2000 + i * 1000);
  const afterOutbound = transact(g, "p2", { turn: g.turn, action: "startTradeRoute", unitId: merchant.id, cityId: rich.id }, 2500);
  assert.equal(afterOutbound.tradeRoutes[0].trips, 1);
  assert.equal(afterOutbound.tradeRoutes[0].goldEarned, richPayout, "one outbound leg credited the partner payout");
  assert.ok(g.gold.p2 >= goldBefore + richPayout, "the payout reached the treasury (city income may add more)");
  assert.equal(afterOutbound.tradeRoutes[0].phase, "inbound");

  // Halfway home nothing is paid, then the next outbound leg pays again.
  for (let i = 0; i < route.legTurns; i += 1) resolveTurn(g, 3000 + i * 1000);
  for (let i = 0; i < route.legTurns; i += 1) resolveTurn(g, 4000 + i * 1000);
  const cycling = (g.tradeRoutes ?? []).find((r) => r.merchantId === merchant.id);
  assert.ok(cycling.trips >= 2, `the automatic round trip keeps paying (${cycling.trips} trips)`);
  assert.ok(cycling.goldEarned >= richPayout * 2);

  // Stopping closes the route without further payments.
  transact(g, "p2", { turn: g.turn, action: "stopTradeRoute", unitId: merchant.id }, 4500);
  const earnedAfterStop = (g.tradeRoutes ?? []).length;
  for (let i = 0; i < 6; i += 1) resolveTurn(g, 5000 + i * 1000);
  assert.equal((g.tradeRoutes ?? []).length, earnedAfterStop, "a stopped route never comes back");
  assert.equal(earnedAfterStop, 0);
});

test("a war with the partner closes the route with a notice", () => {
  const { g, at, city } = base();
  const home = city("home", "p2", 6, 6, 4);
  home.tradingPost = { built: true, builtTurn: 1 };
  const partner = city("partner", "p1", 9, 6, 2);
  startGame(g, 1000);
  const merchant = addUnit(g, "p2", "merchant", { q: 6, r: 6 });
  merchant.tradingPostCityId = home.id;
  transact(g, "p2", { turn: g.turn, action: "startTradeRoute", unitId: merchant.id, cityId: partner.id }, 1100);
  g.wars = ["p1|p2"];
  resolveTurn(g, 2000);
  assert.equal((g.tradeRoutes ?? []).length, 0, "no route survives the war");
  assert.match(g.events.p2.map((e) => e.text).join("\n"), /전쟁/);
});

test("a captured city stops showing the old owner's flag in remembered state", () => {
  const { g, at, city } = base();
  const home = city("home", "p2", 4, 6, 3);
  const target = city("target", "p1", 9, 6, 3);
  for (const n of neighbors(target)) Object.assign(at(n.q, n.r), { owner: "p1", cityId: "target" });
  Object.assign(at(10, 6), { farm: true, owner: "p1", cityId: "target" });
  at(11, 6).resource = "niter";
  at(11, 6).developed = true;
  at(11, 6).owner = "p1"; at(11, 6).cityId = "target";
  g.wars = ["p1|p2"];
  startGame(g, 1000);
  // p1 has explored its own land and holds a city contact for it.
  updateContacts(g);
  assert.equal(g.explored.p1[key(target)].owner, "p1");
  assert.equal(g.cityContacts.p1[target.id].owner, "p1");
  assert.equal(g.explored.p1[key(at(11, 6))].owner, "p1");

  target.hp = 0;
  addUnit(g, "p2", "spearman", { q: 9, r: 6 });
  resolveTurn(g, 2000);
  assert.equal(target.owner, "p2", "city changed hands");
  assert.equal(g.explored.p1[key(target)].owner, "p2", "remembered city tile flips owner");
  assert.equal(g.explored.p1[key(target)].cityName, "target");
  assert.equal(g.explored.p1[key(at(11, 6))].owner, "p2", "remembered mine tile flips owner");
  assert.equal(g.cityContacts.p1[target.id].owner, "p2", "ghost city marker follows the capture");
  assert.doesNotMatch(g.events.p1.map((e) => e.text).join("\n"), /내 도시/);
});

test("restore repair rewrites ownership remembered before the capture fix", () => {
  const { g, at, city } = base();
  const target = city("target", "p1", 9, 6, 3);
  Object.assign(at(10, 6), { owner: "p1", cityId: "target", farm: true });
  updateContacts(g);
  // Simulate a save written before the fix: the city changed hands in the live
  // state while the remembered map and ghost marker still claim the old owner.
  g.explored.p1[key(at(10, 6))].owner = "p1";
  g.cityContacts.p1[target.id].owner = "p1";
  target.owner = "p3";
  repairRememberedOwnership(g);
  assert.equal(g.explored.p1[key(at(10, 6))].owner, "p3");
  assert.equal(g.cityContacts.p1[target.id].owner, "p3");
  assert.equal(g.cityContacts.p1[target.id].name, "target");
  // Untouched last-seen details survive the repair (fog is preserved).
  assert.equal(g.explored.p1[key(at(10, 6))].farm, true);
});
