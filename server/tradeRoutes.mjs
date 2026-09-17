import { RESOURCES, distance, key } from "../shared/rules.js";

/**
 * 2026-09-18 user request:
 *   "상인은 교역을 시작할수 있고 그러면 자동으로 왕복함. 교역할 도시는 이제 내가
 *    선택하고 도시의 규모와 농지, 자원 마다 돈을 얻는 양이 다름."
 *
 * A merchant that has a trading post at home starts a round trip to a partner
 * city the player picked.  The route then shuttles by itself: every completed
 * outbound leg pays gold that scales with the partner city's population
 * (규모), farms (농지) and developed resources (자원).  Nothing here moves the
 * merchant unit, so trade never fights with border or zone-of-control rules.
 */
export const TRADE_ROUTE = Object.freeze({
  BASE_GOLD: 4,
  GOLD_PER_POPULATION: 2,
  GOLD_PER_FARM: 1,
  GOLD_PER_RESOURCE: 3,
  OWN_CITY_FACTOR: 0.5,
  MIN_LEG_TURNS: 1,
  MAX_LEG_TURNS: 4,
  RADIUS: 3,
});

const live = (unit) => unit && unit.hp > 0;

function nearestOwnCity(g, player, city) {
  return (g.cities ?? [])
    .filter((c) => c.owner === player && !c.camp)
    .sort((a, b) => distance(a, city) - distance(b, city))[0] ?? null;
}

function state(g) {
  if (!Array.isArray(g.tradeRoutes)) g.tradeRoutes = [];
  return g.tradeRoutes;
}

/** Farms and developed resources the player has actually seen near a city. */
function knownSurroundings(g, player, city) {
  const memory = g.explored?.[player] ?? {};
  let farms = 0;
  let resources = 0;
  for (const record of Object.values(memory)) {
    if (!record || typeof record !== "object") continue;
    if (distance(record, city) > TRADE_ROUTE.RADIUS) continue;
    if (record.farm) farms += 1;
    if (record.developed && RESOURCES[record.resource]) resources += 1;
  }
  return { farms, resources };
}

export function tradePayout(g, player, city) {
  if (!city) return 0;
  const { farms, resources } = knownSurroundings(g, player, city);
  const raw =
    TRADE_ROUTE.BASE_GOLD +
    TRADE_ROUTE.GOLD_PER_POPULATION * Math.max(0, city.population ?? 0) +
    TRADE_ROUTE.GOLD_PER_FARM * farms +
    TRADE_ROUTE.GOLD_PER_RESOURCE * resources;
  const factor = city.owner === player ? TRADE_ROUTE.OWN_CITY_FACTOR : 1;
  return Math.max(1, Math.round(raw * factor));
}

export function tradeRouteCandidates(g, player, { atWar = () => false } = {}) {
  const seen = new Set();
  const rows = [];
  for (const city of g.cities ?? []) {
    if (city.camp || city.owner === "barb") continue;
    if (city.owner !== player && !g.explored?.[player]?.[key(city)]) {
      const contact = g.cityContacts?.[player]?.[city.id];
      if (!contact) continue;
    }
    if (seen.has(city.id)) continue;
    seen.add(city.id);
    const { farms, resources } = knownSurroundings(g, player, city);
    rows.push({
      cityId: city.id,
      name: city.name,
      owner: city.owner,
      mine: city.owner === player,
      population: city.population ?? 0,
      farms,
      resources,
      goldPerTrip: tradePayout(g, player, city),
      legTurns: legTurns(nearestOwnCity(g, player, city), city),
      atWar: !!atWar(g, player, city.owner),
    });
  }
  return rows.sort((a, b) => b.goldPerTrip - a.goldPerTrip || a.name.localeCompare(b.name));
}

/** Longer trips take more turns but the merchant is never micromanaged. */
export function legTurns(from, to) {
  if (!from || !to) return TRADE_ROUTE.MIN_LEG_TURNS;
  const hops = Math.round(distance(from, to) / 2);
  return Math.max(TRADE_ROUTE.MIN_LEG_TURNS, Math.min(TRADE_ROUTE.MAX_LEG_TURNS, hops));
}

export function startTradeRoute(g, player, { unitId, cityId, turn = g.turn, atWar = () => false } = {}) {
  const merchant = (g.units ?? []).find((u) => u.id === unitId);
  if (!merchant || merchant.owner !== player || !live(merchant))
    return { issue: "내 상인 유닛을 선택해 주세요." };
  if (merchant.type !== "merchant") return { issue: "상인만 교역로를 열 수 있어요." };
  const partner = (g.cities ?? []).find((c) => c.id === cityId);
  if (!partner) return { issue: "교역할 도시를 찾을 수 없어요." };
  if (partner.owner === "barb" || partner.camp) return { issue: "야만인과는 교역할 수 없어요." };
  if (atWar(g, player, partner.owner)) return { issue: "전쟁 중인 문명과는 교역할 수 없어요." };
  const home = (g.cities ?? []).find(
    (c) => c.owner === player && (c.id === merchant.tradingPostCityId || c.id === merchant.homeCityId),
  );
  if (!home) return { issue: "교역소가 있는 아군 도시에서 상인을 준비해 주세요." };
  const existing = state(g).find((route) => route.merchantId === merchant.id);
  if (existing) return { route: existing, replaced: true };
  const route = {
    id: `trade-${merchant.id}`,
    owner: player,
    merchantId: merchant.id,
    homeCityId: home.id,
    partnerCityId: partner.id,
    partnerOwner: partner.owner,
    legTurns: legTurns(home, partner),
    progress: 0,
    phase: "outbound",
    trips: 0,
    goldEarned: 0,
    startedTurn: turn,
    lastPaidTurn: null,
  };
  state(g).push(route);
  return { route };
}

export function stopTradeRoute(g, player, { unitId = null, routeId = null } = {}) {
  const routes = state(g);
  const index = routes.findIndex(
    (route) =>
      route.owner === player &&
      ((routeId && route.id === routeId) || (unitId && route.merchantId === unitId)),
  );
  if (index < 0) return { issue: "진행 중인 교역로가 없어요." };
  const [route] = routes.splice(index, 1);
  return { route };
}

/**
 * Advance every live route for `owner` by one turn.  Returns the payments and
 * the routes that had to stop (merchant or partner city gone, or a war began).
 */
export function advanceTradeRoutes(g, { turn = g.turn, owner = null, atWar = () => false } = {}) {
  const routes = state(g);
  const paid = [];
  const stopped = [];
  for (const route of [...routes]) {
    if (owner && route.owner !== owner) continue;
    const merchant = (g.units ?? []).find((u) => u.id === route.merchantId);
    const partner = (g.cities ?? []).find((c) => c.id === route.partnerCityId);
    const home = (g.cities ?? []).find((c) => c.id === route.homeCityId);
    let reason = null;
    if (!live(merchant)) reason = "상인이 사라져 교역로가 닫혔어요.";
    else if (!home || home.owner !== route.owner) reason = "본거지 도시를 잃어 교역로가 닫혔어요.";
    else if (!partner) reason = "교역 상대 도시가 사라져 교역로가 닫혔어요.";
    else if (atWar(g, route.owner, partner.owner)) reason = "교역 상대와 전쟁이 나 교역로가 닫혔어요.";
    if (reason) {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
      stopped.push({ route, reason });
      continue;
    }
    route.partnerOwner = partner.owner;
    route.progress += 1;
    if (route.progress < route.legTurns) continue;
    route.progress = 0;
    if (route.phase === "outbound") {
      const gold = tradePayout(g, route.owner, partner);
      g.gold[route.owner] = (g.gold[route.owner] ?? 0) + gold;
      route.goldEarned += gold;
      route.trips += 1;
      route.lastPaidTurn = turn;
      route.phase = "inbound";
      paid.push({ route, gold, partner });
    } else {
      route.phase = "outbound";
    }
  }
  return { paid, stopped };
}

export function publicTradeRoutes(g, player) {
  return state(g)
    .filter((route) => route.owner === player)
    .map((route) => {
      const partner = (g.cities ?? []).find((c) => c.id === route.partnerCityId) ?? null;
      const home = (g.cities ?? []).find((c) => c.id === route.homeCityId) ?? null;
      return {
        id: route.id,
        merchantId: route.merchantId,
        homeCityId: route.homeCityId,
        homeName: home?.name ?? null,
        partnerCityId: route.partnerCityId,
        partnerName: partner?.name ?? null,
        partnerOwner: route.partnerOwner ?? partner?.owner ?? null,
        phase: route.phase,
        progress: route.progress,
        legTurns: route.legTurns,
        trips: route.trips,
        goldEarned: route.goldEarned,
        goldPerTrip: partner ? tradePayout(g, player, partner) : 0,
      };
    });
}
