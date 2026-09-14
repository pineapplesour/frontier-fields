import { TYPES, TERRAINS, key, distance, equal, neighbors, blocksUnit, canCrossBorder } from "../shared/rules.js";
import { notifyTrade } from "./notifications.mjs";

export const TERRITORIAL_BUFFER = 2;
export const MILITARY_PRESENCE_TURNS = 3;
export const TERRITORIAL_PROMISE_TURNS = 10;
const pair = (a, b) => [a, b].sort().join("|");
const edge = (a, b) => `${a}>${b}`;
const atWar = (g, a, b) => (g.wars ?? []).includes(pair(a, b));
const military = (unit) => unit.hp > 0 && TYPES[unit.type] && !TYPES[unit.type].civilian;
const known = (tile) => tile.visible === true || tile.explored === true;
const isTerritorial = (p) => p.kind === "ultimatum" && ["withdrawTroops", "removeCity"].includes(p.demand);

/** Snapshot the issue-time buffer. Keep full coordinates server-side. */
export function territorialZone(g, owner) {
  const land = (g.tiles ?? []).filter(tile => tile.owner === owner);
  return (g.tiles ?? []).filter(tile => land.some(own => distance(own, tile) <= TERRITORIAL_BUFFER)).map(key);
}

function nearbyObserved(g, player, observation) {
  if (observation?.playerId !== player) return { troops: [], cities: [] };
  const owned = (observation.tiles ?? []).filter(tile => tile.owner === player && known(tile));
  const visible = new Set((observation.tiles ?? []).filter(tile => tile.visible).map(key));
  const inside = (entity) => visible.has(key(entity)) && owned.some(tile => distance(tile, entity) <= TERRITORIAL_BUFFER);
  return {
    troops: (observation.units ?? []).filter(unit => unit.owner !== player && unit.owner !== "barb" && military(unit) && inside(unit)),
    cities: (observation.cities ?? []).filter(city => city.owner !== player && city.owner !== "barb" && !city.camp && city.hp > 0 && inside(city)),
  };
}

/** Call after movements and at logical turn boundaries, never from observe().
 * Only the supplied faction's actual observation contributes to its evidence.
 * Same-turn polls do not accumulate turns; leaving between polls resets it.
 */
export function updateTerritorialPresence(g, player, observation) {
  if (observation?.playerId !== player) return;
  g.territorialPresence ??= {};
  const seen = new Set(nearbyObserved(g, player, observation).troops.map(unit => unit.owner));
  for (const [id, record] of Object.entries(g.territorialPresence))
    if (record.from === player && (!seen.has(record.to) || atWar(g, player, record.to))) delete g.territorialPresence[id];
  for (const to of seen) {
    if (atWar(g, player, to)) continue;
    const id = edge(player, to), before = g.territorialPresence[id];
    const count = before?.lastTurn === g.turn ? before.turns
      : before?.lastTurn === g.turn - 1 ? before.turns + 1 : 1;
    g.territorialPresence[id] = { from: player, to, turns: count, lastTurn: g.turn };
  }
}

export function territorialUltimatumOptions(g, player, observation) {
  const { troops, cities } = nearbyObserved(g, player, observation);
  const ids = new Set([...troops, ...cities].map(entity => entity.owner));
  return [...ids].filter(to => !atWar(g, player, to)).map(factionId => {
    const record = g.territorialPresence?.[edge(player, factionId)];
    const nearbyMilitaryTurns = record && record.lastTurn >= g.turn - 1 ? record.turns : 0;
    const visibleTroops = troops.filter(unit => unit.owner === factionId);
    return {
      factionId, nearbyMilitaryTurns,
      canWithdrawTroops: visibleTroops.length > 0 && nearbyMilitaryTurns >= MILITARY_PRESENCE_TURNS,
      troops: visibleTroops.map(({ id, q, r, type }) => ({ id, q, r, type })),
      cities: cities.filter(city => city.owner === factionId).map(({ id, name, q, r }) => ({ id, name, q, r })),
    };
  });
}

export function territorialCasusBelli(g, from, to) {
  return g.territorialCasusBelli?.[edge(from, to)] ?? null;
}

export function recordTerritorialRefusal(g, proposal, reason = "ultimatum-rejected") {
  if (!isTerritorial(proposal)) return;
  g.territorialCasusBelli ??= {};
  g.territorialCasusBelli[edge(proposal.from, proposal.to)] = {
    from: proposal.from, to: proposal.to, turn: g.turn, proposalId: proposal.id, reason,
  };
}

export function territorialDiplomacyView(g, player, observation) {
  if (observation?.playerId !== player) return { options: [], agreements: [], casusBelli: [] };
  const disclosed = new Set((observation.tiles ?? []).filter(known).map(key));
  return {
    options: territorialUltimatumOptions(g, player, observation),
    agreements: (g.territorialAgreements ?? [])
      .filter(p => p.until > g.turn && (p.from === player || p.to === player) && !atWar(g, p.from, p.to))
      .map(p => ({ from: p.from, to: p.to, until: p.until, turnsRemaining: p.until - g.turn,
        zoneKeys: p.fullZoneKeys.filter(id => disclosed.has(id)) })),
    casusBelli: Object.values(g.territorialCasusBelli ?? {})
      .filter(record => record.from === player || record.to === player)
      .map(({ from, to, turn, reason }) => ({ from, to, turn, reason })),
  };
}

/** The server enforces full zones, including undiscovered tiles. */
export function restrictionViolation(g, owner, target, kind = "military") {
  if (!["military", "found", "settle", "settlement"].includes(kind)) return null;
  const pact = (g.territorialAgreements ?? []).find(p => p.to === owner && p.until > g.turn &&
    !atWar(g, p.from, p.to) && p.fullZoneKeys.includes(key(target)));
  return pact ? { from: pact.from, to: pact.to, until: pact.until,
    reason: `최후통첩 수락 약속이 ${pact.until - g.turn}턴 남았어요. 선전포고 전에는 해당 국경 주변에 ${kind === "military" ? "군사를 보낼" : "정착할"} 수 없어요.` } : null;
}

/** Find legal reachable exits before mutating anything. This is negotiated
 * relocation, not a movement-point action. Occupancy and other treaties apply.
 */
export function planTerritorialWithdrawal(g, owner, fullZoneKeys) {
  const zone = new Set(fullZoneKeys), tiles = new Map((g.tiles ?? []).map(tile => [key(tile), tile]));
  const units = (g.units ?? []).filter(unit => unit.owner === owner && military(unit) && zone.has(key(unit)));
  const placements = [];
  for (const unit of units) {
    const queue = [unit], visited = new Set([key(unit)]);
    let destination = null;
    const occupied = (tile) => (g.units ?? []).some(other => {
      if (!(other.hp > 0) || other.id === unit.id) return false;
      const moved = placements.find(p => p.unit.id === other.id);
      return equal(moved?.target ?? other, tile) && blocksUnit(unit, other);
    });
    for (let i = 0; i < queue.length && !destination; i++) {
      const current = queue[i];
      if (!zone.has(key(current)) && !occupied(current) && !restrictionViolation(g, owner, current)) {
        destination = current; break;
      }
      for (const point of neighbors(current)) {
        const tile = tiles.get(key(point));
        if (!tile || visited.has(key(tile)) || !Number.isFinite(TERRAINS[tile.terrain]?.cost) || occupied(tile)) continue;
        if (!canCrossBorder(g, unit, current, tile)) continue;
        if ((g.cities ?? []).some(city => city.hp > 0 && city.owner !== owner && equal(city, tile))) continue;
        if (restrictionViolation(g, owner, tile)) continue;
        visited.add(key(tile)); queue.push(tile);
      }
    }
    if (!destination) return null;
    placements.push({ unit, target: { q: destination.q, r: destination.r } });
  }
  return placements;
}

export function applyTerritorialWithdrawal(plan) {
  for (const { unit, target } of plan) Object.assign(unit, target, {
    order: null, movesLeft: 0, attackUsed: true, attacksLeft: 0, acted: true,
    fortified: false, fortifyPending: false,
  });
}

export function acceptTerritorialPromise(g, proposal) {
  g.territorialAgreements ??= [];
  g.territorialAgreements = g.territorialAgreements.filter(p => p.from !== proposal.from || p.to !== proposal.to);
  g.territorialAgreements.push({ from: proposal.from, to: proposal.to,
    until: g.turn + TERRITORIAL_PROMISE_TURNS, fullZoneKeys: [...(g.territorialDemandZones?.[proposal.id] ?? [])] });
  if (g.territorialPresence) delete g.territorialPresence[edge(proposal.from, proposal.to)];
  if (g.territorialCasusBelli) delete g.territorialCasusBelli[edge(proposal.from, proposal.to)];
}

/** Run before generic proposal expiry to preserve the refusal consequence. */
export function expireTerritorialUltimatums(g, { event } = {}) {
  const stale = (g.proposals ?? []).filter(p => isTerritorial(p) && p.expires <= g.turn);
  for (const p of stale) {
    recordTerritorialRefusal(g, p, "ultimatum-expired");
    notifyTrade(g, p, "expired");
    event?.(g, [p.from, p.to], "영토 최후통첩의 응답 기한이 지났어요. 요구한 문명이 즉시 명분 전쟁을 선포할 수 있어요.");
    if (g.territorialDemandZones) delete g.territorialDemandZones[p.id];
  }
  const ids = new Set(stale.map(p => p.id));
  g.proposals = (g.proposals ?? []).filter(p => !ids.has(p.id));
}
