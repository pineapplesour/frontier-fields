import { TYPES, cityMaxHealth, distance, equal, isCivilian, neighbors } from '../shared/rules.js';

export const CAMP_PILLAGE_COOLDOWN = 10;
export const CAMP_PILLAGE_FOOD = 20;
export const CAMP_PILLAGE_GOLD = 20;
const soldier = u => u && u.hp > 0 && TYPES[u.type] && !isCivilian(u) && !TYPES[u.type].internal;

export function captureBarbarianCamp(g, camp, unit) {
  if (!camp?.camp || camp.hp > 0 || !soldier(unit) || unit.type === 'artillery' ||
      unit.owner === camp.owner || !equal(unit, camp)) return false;
  camp.owner = unit.owner;
  camp.hp = Math.min(cityMaxHealth(camp), 80);
  camp.wallHp = 0; camp.queue = null; camp.production = 0;
  camp.productionPending = false; camp.capital = false;
  camp.occupiedTurn = g.turn;
  // Cooldown belongs to the site, so recapture cannot grant duplicate loot.
  const center = g.tiles.find(t => equal(t, camp));
  if (center) Object.assign(center, { owner: unit.owner, cityId: camp.id, camp: true });
  return true;
}

export function publicCampState(g, camp, player) {
  if (!camp?.camp) return null;
  const occupied = camp.owner !== 'barb';
  const nextPillageTurn = camp.owner !== player ? null : Number.isFinite(camp.lastPillageTurn)
    ? camp.lastPillageTurn + CAMP_PILLAGE_COOLDOWN : g.turn;
  return { occupied, nextPillageTurn, pillageFood: CAMP_PILLAGE_FOOD,
    pillageGold: CAMP_PILLAGE_GOLD,
    canPillage: occupied && camp.owner === player && camp.hp > 0 && g.turn >= nextPillageTurn &&
      g.units.some(u => soldier(u) && u.owner === player && equal(u, camp)) &&
      g.cities.some(c => !c.camp && c.owner === player && c.hp > 0) };
}

export function pillageBarbarianCamp(g, player, raw, { GameError = Error, event = () => {} } = {}) {
  const fail = text => { throw new GameError(text); };
  const camp = g.cities.find(c => c.id === raw.cityId && c.camp);
  const unit = g.units.find(u => u.id === raw.unitId);
  if (!camp || camp.owner !== player || camp.owner === 'barb' || camp.hp <= 0 ||
      !soldier(unit) || unit.owner !== player || !equal(unit, camp))
    fail('점령한 야만인 거점 위에 살아 있는 아군 군사 유닛이 필요해요.');
  if (Number.isFinite(camp.lastPillageTurn) && g.turn < camp.lastPillageTurn + CAMP_PILLAGE_COOLDOWN)
    fail(`이 거점은 ${camp.lastPillageTurn + CAMP_PILLAGE_COOLDOWN}턴부터 다시 약탈할 수 있어요.`);
  const cities = g.cities.filter(c => c.owner === player && !c.camp && c.hp > 0)
    .sort((a,b) => distance(a,camp)-distance(b,camp) || a.id.localeCompare(b.id));
  const destination = raw.targetCityId ? cities.find(c => c.id === raw.targetCityId) : cities[0];
  if (!destination) fail('약탈 식량을 받을 아군 도시가 필요해요.');
  // Existing ledger convention: city.food is stored food with detailed
  // supply, and growth surplus otherwise. Never credit both ledgers.
  destination.food = Math.max(0, Number(destination.food) || 0) + CAMP_PILLAGE_FOOD;
  if (g.supplyMode !== 'on') destination.growthProgress = destination.food;
  g.gold ??= {}; g.gold[player] = (Number(g.gold[player]) || 0) + CAMP_PILLAGE_GOLD;
  camp.lastPillageTurn = g.turn;
  event(g, [player], `야만인 거점을 약탈했어요 · ${destination.name ?? destination.id} 식량 +${CAMP_PILLAGE_FOOD} · 골드 +${CAMP_PILLAGE_GOLD} · ${g.turn+CAMP_PILLAGE_COOLDOWN}턴부터 다시 가능.`);
  return { cityId: camp.id, targetCityId: destination.id, food: CAMP_PILLAGE_FOOD, gold: CAMP_PILLAGE_GOLD };
}

/** Caller retains its existing spawn cadence and the global 12-unit cap. */
export function campSpawnSites(g) {
  const sites = [], used = new Set();
  for (const camp of g.cities.filter(c => c.camp).sort((a,b) => a.id.localeCompare(b.id))) {
    const candidates = camp.owner === 'barb' ? [camp, ...neighbors(camp)] : neighbors(camp);
    const site = candidates.find(p => {
      const t = g.tiles.find(t => equal(t,p)), key = `${p.q},${p.r}`;
      return t && t.terrain !== 'mountain' && (!t.owner || t.owner === 'barb') && !used.has(key) &&
        !g.units.some(u => u.hp > 0 && equal(u,p)) &&
        !g.cities.some(c => equal(c,p) && c.id !== camp.id);
    });
    if (site) { used.add(`${site.q},${site.r}`); sites.push({ campId: camp.id, q: site.q, r: site.r }); }
  }
  return sites;
}
