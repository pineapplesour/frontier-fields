import { FACTIONS } from '../shared/rules.js';

const pair = (a, b) => [a, b].sort().join('|');
export const DENOUNCEMENT_TURNS = 10;
export const FORMAL_WAR_WAIT = 3;
export const MIN_WAR_TURNS = 10;

export function ensureWarDiplomacy(g) {
  g.warStarted ??= {};
  g.denouncementStarted ??= {};
  for (const key of g.wars ?? []) {
    if (Number.isFinite(g.warStarted[key])) continue;
    const record = [...(g.announcements ?? [])].reverse().find(e =>
      e.type === 'war' && pair(e.from, e.to) === key && Number.isFinite(e.turn));
    g.warStarted[key] = record?.turn ?? g.turn;
  }
}

export function recordDenouncement(g, from, to) {
  g.denouncements ??= {};
  g.denouncementStarted ??= {};
  g.denouncements[pair(from, to)] = g.turn + DENOUNCEMENT_TURNS;
  g.denouncementStarted[`${from}>${to}`] = g.turn;
}

export function warJustification(g, from, to) {
  const territorial = g.territorialCasusBelli?.[`${from}>${to}`];
  if (territorial) return { justified: true, reason: territorial.reason ?? 'ultimatum-rejected' };
  const until = g.denouncements?.[pair(from, to)] ?? 0;
  // Old snapshots only stored an undirected expiry. Preserve their public
  // denunciation rather than treating a known historical grievance as surprise.
  const started = g.denouncementStarted?.[`${from}>${to}`] ??
    (Object.keys(g.denouncementStarted ?? {}).some(k => k === `${to}>${from}`) ? null : until - DENOUNCEMENT_TURNS);
  if (until > g.turn && started !== null && g.turn >= started + FORMAL_WAR_WAIT)
    return { justified: true, reason: 'denouncement' };
  return { justified: false, reason: 'surprise' };
}

export function peaceIssue(g, a, b) {
  const key = pair(a, b);
  if (!(g.wars ?? []).includes(key)) return null;
  const started = g.warStarted?.[key] ?? g.turn;
  const remaining = started + MIN_WAR_TURNS - g.turn;
  return remaining > 0 ? `개전 후 10턴 동안 평화할 수 없어요. ${remaining}턴 남았어요.` : null;
}

export function clearWarRecord(g, a, b) {
  if (g.warStarted) delete g.warStarted[pair(a, b)];
  if (g.territorialCasusBelli) {
    delete g.territorialCasusBelli[`${a}>${b}`];
    delete g.territorialCasusBelli[`${b}>${a}`];
  }
}

function distances(graph, root) {
  const result = new Map([[root, 0]]), queue = [root];
  for (let i = 0; i < queue.length; i++)
    for (const next of graph.get(queue[i]) ?? [])
      if (!result.has(next)) { result.set(next, result.get(queue[i]) + 1); queue.push(next); }
  return result;
}

/** Called before announcement; the caller may already have inserted g.wars. */
export function applyWarDiplomacy(g, from, to, { reason = null, expandAlliances = true, forceAllianceExpansion = false } = {}) {
  g.warStarted ??= {}; g.wars ??= []; g.relations ??= {}; g.alliances ??= {};
  const key = pair(from, to);
  const first = !Number.isFinite(g.warStarted[key]);
  if (!g.wars.includes(key)) g.wars.push(key);
  // Joining an ally's war supersedes a bilateral truce; keeping both public
  // states would disagree with movement and peace UI after compulsory entry.
  if (g.peaceUntil) delete g.peaceUntil[key];
  if (first) g.warStarted[key] = g.turn;
  const justification = ['alliance', 'guarantee'].includes(reason)
    ? { justified: true, reason } : warJustification(g, from, to);
  if (first && g.territorialCasusBelli && !['alliance','guarantee'].includes(reason))
    delete g.territorialCasusBelli[`${from}>${to}`];
  const ids = Object.keys(g.factions ?? FACTIONS).filter(id => id !== 'barb');
  if (first && !justification.justified)
    for (const third of ids.filter(id => id !== from && id !== to))
      g.relations[pair(from, third)] = Math.max(-100, (g.relations[pair(from, third)] ?? 0) - 15);
  const result = { first, ...justification, newWars: [], brokenAlliances: [] };
  if (!expandAlliances || (!first && !forceAllianceExpansion)) return result;
  const graph = new Map(ids.map(id => [id, []]));
  for (const [edge, until] of Object.entries(g.alliances)) {
    if (!(until > g.turn)) continue;
    const [a, b] = edge.split('|');
    graph.get(a)?.push(b); graph.get(b)?.push(a);
  }
  const attackDistance = distances(graph, from), defendDistance = distances(graph, to);
  const attackers = [], defenders = [];
  for (const id of ids) {
    const a = attackDistance.get(id) ?? Infinity, d = defendDistance.get(id) ?? Infinity;
    if (id === from || a < d) attackers.push(id);
    else if (id === to || d < Infinity) defenders.push(id);
  }
  for (const a of attackers) for (const b of defenders) {
    const edge = pair(a, b);
    if (g.alliances[edge] > g.turn) { delete g.alliances[edge]; result.brokenAlliances.push(edge); }
    if (!g.wars.includes(edge)) result.newWars.push({ from: a, to: b, reason: 'alliance' });
  }
  return result;
}

export function syncAllianceWars(g) {
  ensureWarDiplomacy(g);
  const newWars = new Map(), brokenAlliances = new Set();
  for (const edge of [...g.wars].sort()) {
    const [from, to] = edge.split('|');
    const result = applyWarDiplomacy(g, from, to, { reason: 'alliance', forceAllianceExpansion: true });
    for (const war of result.newWars) newWars.set(pair(war.from, war.to), war);
    for (const broken of result.brokenAlliances) brokenAlliances.add(broken);
  }
  return { newWars: [...newWars.values()], brokenAlliances: [...brokenAlliances] };
}
