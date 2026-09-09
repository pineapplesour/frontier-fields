// Rule NPCs only: every decision consumes a player-scoped observation.
// Never use this module to control either direct-player seat p1/p2.
import {
  fortIssue,
  structureAt,
  structureKind,
  structureShieldsGarrison,
} from "../shared/structures.js";
import {
  TYPES,
  MARKET,
  equal,
  key,
  neighbors,
  distance,
  findRoute,
  reachable,
  blocksUnit,
  productionType,
  isCivilian,
  maxHealth,
  settlementIssue,
} from "../shared/rules.js";
import { combatPreview, unitDamage } from "../shared/combat.js";
import { npcWarRisk, npcGuaranteeDecision } from "./guarantees.mjs";
import {
  encampmentCandidates,
  structureProductionDefinition,
} from "./militaryStructures.mjs";
const NPCS = ["p3", "p4", "cs", "barb"];
const factionList = (view) =>
  Array.isArray(view?.factions)
    ? view.factions
    : Object.entries(view?.factions ?? {}).map(([id, faction]) => ({
        id,
        ...faction,
      }));
const factionFor = (view, id) => factionList(view).find((f) => f.id === id);
const isNpc = (view) => {
  const player = view?.playerId;
  if (!player) return false;
  if (NPCS.includes(player)) return true;
  const seat = view?.seats?.find((candidate) => candidate.id === player);
  return (
    seat?.controller === "npc" ||
    seat?.npc === true ||
    factionFor(view, player)?.controller === "npc"
  );
};
const diplomaticNpc = (view) => {
  if (!isNpc(view)) return false;
  if (["cs", "barb"].includes(view.playerId)) return false;
  const faction = factionFor(view, view.playerId);
  return !["citystate", "barbarian"].includes(faction?.kind);
};
const point = (p) => ({ q: p.q, r: p.r });
const power = (u) => TYPES[u.type].attack * u.size * (u.hp / maxHealth(u));
const stable = (a, b) =>
  a.q - b.q ||
  a.r - b.r ||
  String(a.id ?? "").localeCompare(String(b.id ?? ""));
const military = (u) => !isCivilian(u);

function context(view, u) {
  const allies = view.units.filter((e) => e.owner === view.playerId);
  const foes = view.units.filter((e) => e.hostile && military(e));
  const cities = view.cities.filter((c) => c.owner === view.playerId);
  const enemyCities = view.cities.filter((c) => c.hostile);
  const tiles = new Map(view.tiles.map((t) => [key(t), t]));
  const home = [...cities].sort(
    (a, b) => distance(a, u) - distance(b, u) || stable(a, b),
  )[0];
  const support = (p) =>
    allies
      .filter((e) => military(e) && e.id !== u.id && distance(e, p) <= 2)
      .reduce((n, e) => n + power(e) / (1 + distance(e, p)), 0);
  // Bounded heuristic, not access to enemy orders or unseen terrain/units.
  const danger = (p) => {
    const defender = {
      ...u,
      ...point(p),
      fortified: equal(p, u) && u.fortified,
    };
    let n = 0;
    for (const e of foes) {
      const d = distance(e, p),
        range = TYPES[e.type].range;
      const weight =
        d <= range ? 1 : d <= range + TYPES[e.type].movement ? 0.32 : 0;
      if (weight) n += unitDamage(e, defender, view) * weight;
    }
    for (const c of enemyCities)
      if (c.wallHp > 0 && distance(c, p) <= 2) n += 18 + c.wallLevel * 7;
    const structure = structureAt(view, p);
    if (
      structure &&
      structure.owner === view.playerId &&
      structureShieldsGarrison(structure)
    )
      n *= 0.75;
    return n;
  };
  return { allies, foes, cities, enemyCities, tiles, home, support, danger };
}

export function settlementSites(view, settler) {
  if (!isNpc(view)) return [];
  const own = view.cities.filter((c) => c.owner === view.playerId);
  const tiles = new Map(view.tiles.map((t) => [key(t), t]));
  const threats = view.units.filter((u) => u.hostile && military(u));
  return view.tiles
    .filter(
      (t) =>
        t.explored &&
        !t.owner &&
        ["plains", "hills"].includes(t.terrain) &&
        !settlementIssue(view, {
          ...settler,
          ...point(t),
          type: "settler",
          owner: view.playerId,
        }) &&
        (!own.length || own.some((c) => distance(c, t) <= 8)) &&
        !view.units.some((e) => equal(e, t) && blocksUnit(settler, e)) &&
        threats.every((e) => distance(e, t) > TYPES[e.type].range + 1),
    )
    .map((t) => {
      const local = [
        t,
        ...neighbors(t)
          .map((p) => tiles.get(key(p)))
          .filter(Boolean),
      ];
      const quality = local.reduce(
        (n, p) =>
          n +
          (p.terrain === "plains" ? p.fertility + 1 : 0) +
          (p.resource ? 3 : 0),
        0,
      );
      const spacing = own.length
        ? Math.min(...own.map((c) => distance(c, t)))
        : 0;
      return {
        tile: t,
        score: quality - distance(settler, t) * 1.1 - Math.abs(spacing - 5) * 2,
      };
    })
    .sort((a, b) => b.score - a.score || stable(a.tile, b.tile))
    .map((x) => x.tile);
}

export function npcEconomy(view) {
  if (!isNpc(view) || view.playerId === "barb") return [];
  const own = view.playerId,
    cities = (view.cities ?? []).filter((c) => c.owner === own);
  const units = (view.units ?? []).filter((u) => u.owner === own),
    army = units.filter(military);
  const foes = (view.units ?? []).filter((u) => u.hostile && military(u));
  const jobs = (view.tiles ?? []).filter(
    (t) =>
      t.owner === own &&
      t.terrain !== "mountain" &&
      !t.farm &&
      !t.developed &&
      !t.encampment &&
      !cities.some((c) => equal(c, t)),
  ).length;
  const farms = (view.tiles ?? []).filter((t) => t.owner === own && t.farm).length;
  const encampments = (view.tiles ?? []).filter(
    (t) => t.encampment?.owner === own,
  ).length;
  const planned = cities.map((c) => c.queue).filter(Boolean);
  const count = (type) =>
    units.filter((u) => u.type === type).length +
    planned.filter((t) => t === type).length;
  const stocks = { ...view.economy.resources },
    plans = [];
  let gold = view.economy.gold;
  for (const c of cities) {
    const localFoes = foes.filter((e) => distance(e, c) <= 4);
    const localArmy = army.filter((e) => distance(e, c) <= 4);
    const emergency =
      localFoes.length > 0 &&
      localFoes.reduce((n, u) => n + power(u), 0) >
        localArmy.reduce((n, u) => n + power(u), 0) * 0.75;
    // Do not repeatedly reset a healthy production queue.
    if (c.queue && !(emergency && ["builder", "settler"].includes(c.queue)))
      continue;
    const counter = () => {
      const horse = localFoes.filter((e) => e.type === "cavalry").length;
      const musk = foes.filter((e) => e.type === "musketeer").length;
      if (horse) return "spearman";
      if (musk && count("cavalry") < Math.max(2, musk)) return "cavalry";
      if (count("spearman") < cities.length) return "spearman";
      if (count("artillery") < Math.max(1, Math.floor(army.length / 4)))
        return "artillery";
      return "musketeer";
    };
    let type;
    let target = null;
    const encampmentEnabled =
      view.rulesVersion === "expansion-v1" ||
      view.capabilities?.encampment === true;
    const encampmentTarget =
      encampmentEnabled && encampments < cities.length
        ? encampmentCandidates(view, c, { radius: 3 })[0]
        : null;
    const settlementReady =
      view.turn >= 1 &&
      c.population >= 3 &&
      cities.length < 3 &&
      count("settler") === 0 &&
      // One surviving escort and one established farm are enough to start a
      // legal second-city attempt. Requiring a full three-unit army made an
      // NPC permanently abandon expansion after an unlucky early skirmish.
      army.length >= 1 &&
      farms >= cities.length &&
      settlementSites(view, { ...c, type: "settler" }).length;
    if (
      !c.queue &&
      c.wallHp > 0 &&
      c.wallHp < c.wallMaxHp &&
      (c.lastIncomingAttackTurn === null ||
        view.turn - c.lastIncomingAttackTurn >= 5)
    )
      type = "wallRepair";
    else if (own === "cs")
      type =
        (c.wallLevel ?? 0) < 2 ? "walls" : army.length < 4 ? "spearman" : null;
    else if (emergency)
      type =
        (c.wallLevel ?? 0) === 0 && localArmy.length >= 2 ? "walls" : counter();
    else if (settlementReady)
      type = "settler";
    else if (
      encampmentTarget &&
      !c.queue &&
      view.turn >= 3 &&
      c.population >= 3 &&
      army.length >= 2
    ) {
      type = "encampment";
      target = point(encampmentTarget);
    } else if (
      jobs > 0 &&
      count("builder") < Math.min(cities.length + 1, Math.ceil(jobs / 6))
    )
      type = "builder";
    else if (
      view.economy.capacity == null ||
      view.economy.used +
        plans.filter((p) => p.production && p.production[0].type !== "walls")
          .length <
        view.economy.capacity - 1
    )
      type = counter();
    else if ((c.wallLevel ?? 0) < 3) type = "walls";
    if (!type) continue;
    const definition =
      productionType(type, c) ?? structureProductionDefinition(type, c);
    if (!definition) continue;
    const needs = definition.resources ?? {};
    const missing = Object.entries(needs).filter(([r, n]) => stocks[r] < n);
    const price = missing.reduce(
      (n, [r, amount]) => n + (amount - stocks[r]) * MARKET[r].buy,
      0,
    );
    if (price && gold - price < 40) {
      type = "spearman";
      target = null;
    }
    else
      for (const [resource, n] of missing) {
        const amount = n - stocks[resource];
        plans.push({ transaction: { action: "buy", resource, amount } });
        stocks[resource] += amount;
        gold -= amount * MARKET[resource].buy;
      }
    const finalDefinition =
      productionType(type, c) ?? structureProductionDefinition(type, c);
    for (const [r, n] of Object.entries(finalDefinition?.resources ?? {}))
      stocks[r] -= n;
    if (
      view.economy.supplyMode === "on" &&
      military({ type }) &&
      type !== "encampment"
    ) {
      // Detailed supply converts military production into the same city-local
      // one-per-turn mobilization queue used by human/agent controllers.  The
      // NPC only sees this observation and its own stock ledger; dispatch and
      // atomic population/resource checks remain authoritative in the engine.
      plans.push({
        transaction: {
          action: "mobilizeUnit",
          cityId: c.id,
          type,
        },
      });
      continue;
    }
    if (c.queue) {
      const i = planned.indexOf(c.queue);
      if (i >= 0) planned.splice(i, 1);
    }
    planned.push(type);
    plans.push({
      production: [
        {
          cityId: c.id,
          type,
          ...(target ? { target } : {}),
        },
      ],
    });
  }
  return plans;
}

// Artillery prepares a target before melee commits; civilians move after escorts.
export function npcTurnOrder(view) {
  if (!isNpc(view)) return [];
  const rank = (u) =>
    u.type === "artillery"
      ? 0
      : u.type === "musketeer"
        ? 1
        : isCivilian(u)
          ? 4
          : 2;
  return view.units
    .filter((u) => u.owner === view.playerId)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.hp / maxHealth(a) - b.hp / maxHealth(b) ||
        stable(a, b),
    )
    .map((u) => u.id);
}

export function npcUnitOrder(view, id) {
  if (!isNpc(view)) return null;
  const u = view.units.find((u) => u.id === id && u.owner === view.playerId);
  if (!u || u.attackUsed) return null;
  const { allies, foes, cities, enemyCities, tiles, home, support, danger } =
    context(view, u);
  const t = tiles.get(key(u)),
    def = TYPES[u.type],
    ratio = u.hp / maxHealth(u);
  const reach = reachable(
    view.tiles,
    u,
    view.units,
    u.owner,
    view.rivers,
    view.roads ?? view.logistics?.roads ?? [],
  );
  const fortify = () =>
    !u.acted && u.movesLeft === def.movement
      ? { unitId: id, action: "fortify" }
      : null;
  const moveTo = (dest) => {
    const path = findRoute(view, u, dest);
    if (!path?.length) return null;
    return { unitId: id, action: "move", target: point(dest), path };
  };
  const safePath = (dest) => {
    const path = findRoute(view, u, dest);
    return path?.length &&
      path.every(
        (p) =>
          tiles.get(key(p))?.explored &&
          !foes.some((e) => distance(e, p) <= TYPES[e.type].range + 1),
      )
      ? { unitId: id, action: "move", target: point(dest), path }
      : null;
  };
  const currentDanger = danger(u);
  const localCity = cities
    .slice()
    .sort((a, b) => distance(a, u) - distance(b, u) || stable(a, b))[0];
  const hostileOwner =
    t?.owner && factionList(view).some((f) => f.id === t.owner && f.hostile);
  // Improvement actions are observation-scoped.  NPCs may plunder a visible
  // hostile facility when damaged, and may scorch their own farm only when a
  // detailed-supply emergency makes the one-time food/heal trade strategic;
  // they never routine-destroy healthy infrastructure for cash.
  if (
    military(u) &&
    t &&
    (t.farm || t.developed) &&
    ratio < 0.8 &&
    (hostileOwner ||
      (t.owner === u.owner &&
        view.economy.supplyMode === "on" &&
        localCity?.foodStock <= localCity?.foodConsumption))
  )
    return {
      unitId: id,
      action: hostileOwner ? "pillage" : "scorch",
    };
  const retreat = () => {
    if (u.movesLeft <= 0) return null;
    const rank = (p) =>
      -danger(p) * 1.5 +
      support(p) * 0.3 +
      (home ? -distance(p, home) * 2 : 0) +
      (p.owner === u.owner ? 4 : 0) +
      (p.terrain === "hills" ? 2 : 0);
    const options = view.tiles
      .filter((p) => reach.has(key(p)) && p.explored)
      .sort((a, b) => rank(b) - rank(a) || stable(a, b));
    // Staying is a real option. Resting safely breaks the low-HP pacing loop.
    if (u.isolation === 0 && currentDanger < 6) return fortify();
    const best = options[0];
    return best && !equal(best, u) && rank(best) > rank(t) + 1
      ? moveTo(best)
      : fortify();
  };
  const enemies = [...view.units.filter((e) => e.hostile), ...enemyCities];
  const targets = enemies.filter((e) => distance(e, u) <= 5);
  const attacks = enemies
    .map((e) => ({ e, preview: combatPreview(view, u, e) }))
    .filter((x) => x.preview?.legal)
    .map((x) => ({
      ...x,
      score:
        x.preview.dealt[0] -
        x.preview.received[1] * 1.15 +
        (x.e.hp <= x.preview.dealt[0] ? 45 : 0) +
        (x.e.type === "artillery" ? 14 : 0),
    }))
    .sort((a, b) => b.score - a.score || stable(a.e, b.e));
  const shot = attacks.find(
    (x) =>
      x.preview.received[1] < u.hp &&
      (x.score > 0 || x.e.hp <= x.preview.dealt[0]),
  );
  const shoot = (x) => ({
    unitId: id,
    action: u.type === "artillery" ? "bombard" : "attack",
    target: point(x.e),
  });
  if (
    shot &&
    shot.e.hp <= shot.preview.dealt[0] &&
    shot.preview.received[1] === 0 &&
    currentDanger < u.hp * 0.6
  )
    return shoot(shot);
  if (
    (isCivilian(u) && currentDanger > 5) ||
    (u.isolation >= 2 && u.type !== "settler") ||
    (u.type !== "settler" &&
      (ratio < 0.45 || (u.fortified && ratio < 0.9)) &&
      currentDanger < u.hp * 1.5)
  )
    return retreat();
  if (isCivilian(u)) {
    if (u.movesLeft <= 0) return null;
    if (u.type === "settler") {
      // A surviving escort is preferred. If every escort was lost, waiting
      // forever makes the NPC's city-expansion branch irrecoverable; after a
      // quiet mid-game turn a safely visible settlement may proceed alone.
      const lateSafeFound =
        view.turn >= 8 &&
        currentDanger < 5 &&
        !foes.some((e) => distance(e, u) <= 5);
      if (
        !settlementIssue(view, u) &&
        !t.owner &&
        currentDanger < 5 &&
        (allies.some((e) => military(e) && distance(e, u) <= 2) ||
          lateSafeFound)
      )
        return { unitId: id, action: "found" };
      for (const site of settlementSites(view, u).slice(0, 8)) {
        const path = safePath(site);
        if (!path) continue;
        const step = path.path[Math.min(1, path.path.length - 1)];
        const guarded = allies.some(
          (e) => military(e) && distance(e, step) <= 2,
        );
        const escorted = allies.some(
          (e) => military(e) && distance(e, u) <= 2,
        );
        if (guarded || escorted) return path;
      }
      return fortify();
    }
    if (
      !fortIssue(view, u) &&
      foes.some((e) => distance(e, u) <= 4) &&
      allies.some((e) => military(e) && equal(e, u))
    )
      return { unitId: id, action: "fort" };
    if (
      t.ruin &&
      t.owner === u.owner
    )
      return { unitId: id, action: "repair" };
    if (
      t.encampment &&
      t.encampment.owner === u.owner &&
      t.encampment.hp < (t.encampment.maxHp ?? 80) &&
      (view.rulesVersion === "expansion-v1" ||
        view.capabilities?.structureRepair === true)
    )
      return { unitId: id, action: "repairStructure" };
    if (
      t.owner === u.owner &&
      !t.farm &&
      !t.developed &&
      !(t.fort?.hp > 0) &&
      !cities.some((c) => equal(c, u))
    )
      return { unitId: id, action: t.resource ? "develop" : "farm" };
    const jobs = view.tiles.filter(
      (p) =>
        p.explored &&
        p.owner === u.owner &&
        p.terrain !== "mountain" &&
        !p.farm &&
        !p.developed &&
      !(p.fort?.hp > 0) &&
      !p.encampment &&
        !cities.some((c) => equal(c, p)) &&
        !view.units.some((e) => equal(e, p) && blocksUnit(u, e)),
    );
    const rank = (p) =>
      p.fertility * 2 +
      neighbors(p).filter((n) => tiles.get(key(n))?.farm).length * 3 +
      (p.resource
        ? (view.economy.income[p.resource] ?? 0) === 0
          ? 22
          : 10
        : 0) -
      distance(u, p) * 1.7 -
      danger(p);
    for (const p of jobs
      .sort((a, b) => rank(b) - rank(a) || stable(a, b))
      .slice(0, 8)) {
      const order = safePath(p);
      if (order) return order;
    }
    return fortify();
  }
  if (
    shot &&
    (u.type !== "artillery" ||
      currentDanger < u.hp * 0.8 ||
      shot.e.hp <= shot.preview.dealt[0])
  )
    return shoot(shot);
  if (u.movesLeft <= 0) return null;
  if (currentDanger >= u.hp * 0.7) return retreat();
  const mate = allies.find(
    (e) =>
      e.id !== id &&
      e.type === u.type &&
      ((e.size === 1 && u.size === 1) || (e.size === 2 && u.size === 2)) &&
      distance(e, u) <= 1 &&
      (ratio < 0.7 || (targets.length && foes.some((x) => x.size > u.size))),
  );
  if (mate) return { unitId: id, action: "merge", targetId: mate.id };

  // One nearest front-line unit escorts each settler, without exposing anything new.
  const settler = allies
    .filter((e) => e.type === "settler")
    .find((s) => {
      const guards = allies
        .filter((e) => military(e) && e.type !== "artillery")
        .sort((a, b) => distance(a, s) - distance(b, s) || stable(a, b));
      return guards[0]?.id === id;
    });
  if (settler && !foes.some((e) => distance(e, u) <= 2)) {
    const site = settlementSites(view, settler)[0];
    if (site) {
      const path = findRoute(view, settler, site);
      const rally = path?.[Math.min(1, path.length - 1)] ?? settler;
      const options = view.tiles
        .filter(
          (p) => reach.has(key(p)) && p.explored && distance(p, settler) <= 3,
        )
        .sort(
          (a, b) =>
            distance(a, rally) - distance(b, rally) ||
            danger(a) - danger(b) ||
            stable(a, b),
        );
      if (options[0] && !equal(options[0], u)) return moveTo(options[0]);
      return fortify();
    }
  }

  // Position to fire this turn, preserve a screen, and avoid suicidal melee charges.
  const options = view.tiles.filter(
    (p) => reach.has(key(p)) && p.explored && !equal(p, u),
  );
  const firing = [];
  for (const p of options) {
    const left = Math.max(0, u.movesLeft - reach.get(key(p)).cost);
    if (u.type === "artillery" && foes.some((e) => distance(e, p) <= 1))
      continue;
    const moved = { ...u, ...point(p), movesLeft: left, fortified: false };
    for (const e of targets) {
      const preview = combatPreview(view, moved, e);
      if (!preview?.legal || preview.received[1] + danger(p) * 0.4 >= u.hp)
        continue;
      const score =
        preview.dealt[0] -
        preview.received[1] -
        danger(p) * 0.5 +
        support(p) * 0.15 +
        (e.hp <= preview.dealt[0] ? 35 : 0) -
        (def.range > 1 ? Math.abs(distance(p, e) - def.range) * 3 : 0);
      if (score > 2) firing.push({ p, score });
    }
  }
  firing.sort((a, b) => b.score - a.score || stable(a.p, b.p));
  if (firing[0]) return moveTo(firing[0].p);

  // Advance the line as a group rather than walking artillery onto an enemy.
  if (targets.length) {
    const target = [...targets].sort(
      (a, b) => distance(a, u) - distance(b, u) || stable(a, b),
    )[0];
    const preferred = u.type === "artillery" ? def.range : 1;
    const rank = (p) =>
      -Math.abs(distance(p, target) - preferred) * 4 -
      danger(p) * 0.7 +
      support(p) * 0.2 +
      (p.terrain === "hills" ? 1 : 0);
    const candidates = [t, ...options]
      .filter(
        (p) =>
          u.type !== "artillery" ||
          !foes.some((e) => distance(e, p) <= 2) ||
          support(p) > 25,
      )
      .sort((a, b) => rank(b) - rank(a) || stable(a, b));
    if (
      candidates[0] &&
      !equal(candidates[0], u) &&
      rank(candidates[0]) > rank(t) + 1
    )
      return moveTo(candidates[0]);
    return fortify();
  }
  if (u.owner === "cs" && !cities.some((c) => equal(c, u) && c.queue))
    return fortify();
  const scouts = allies.filter((e) => e.type === "cavalry").sort(stable);
  const scout = u.owner === "barb" || scouts[0]?.id === id;
  const discovery = (p) =>
    neighbors(p).filter((n) => tiles.get(key(n))?.explored === false).length;
  const rank = (p) =>
    discovery(p) * (scout ? 6 : 1) -
    (home
      ? Math.abs(distance(p, home) - (u.type === "artillery" ? 1 : 3)) * 0.8
      : 0) +
    (p.terrain === "hills" ? 1 : 0) -
    (cities.some((c) => equal(c, p) && c.queue) ? 20 : 0);
  const explore = view.tiles
    .filter((p) => reach.has(key(p)) && !equal(p, u) && (p.explored || scout))
    .sort((a, b) => rank(b) - rank(a) || stable(a, b));
  const best = explore[0];
  return best &&
    (rank(best) > rank(t) + 0.5 || cities.some((c) => equal(c, u) && c.queue))
    ? moveTo(best)
    : fortify();
}

export function npcDiplomacy(view) {
  if (!diplomaticNpc(view) || view.playerId === "barb" || view.turn < 6)
    return null;
  const factions = factionList(view), diplomacy = view.diplomacy ?? [];
  // A losing NPC may offer peace; the human must still explicitly accept.
  const threatened = (view.cities ?? []).filter(
    (c) => c.owner === view.playerId && (c.hp < 80 || c.isolation >= 2),
  );
  const peaceTarget = factions.find(
    (f) =>
      f.kind === "player" &&
      f.hostile &&
      !diplomacy.some((p) => p.from === f.id || p.to === f.id) &&
      (view.units ?? []).some(
        (u) =>
          u.owner === f.id &&
          military(u) &&
          threatened.some((c) => distance(c, u) <= 3),
      ),
  );
  if (peaceTarget && view.turn % 3 === 0)
    return {
      action: "offerDeal",
      factionId: peaceTarget.id,
      peace: true,
      give: { gold: Math.min(40, view.economy?.gold ?? 0) },
      receive: {},
    };
  // No simultaneous opportunistic wars, and no aggression merely at a worker.
  if (factions.some((f) => f.id !== "barb" && f.hostile)) return null;
  const army = (view.units ?? []).filter(
    (u) => u.owner === view.playerId && military(u),
  );
  const cities = (view.cities ?? []).filter((c) => c.owner === view.playerId);
  if (army.length < 5 || army.reduce((n, u) => n + power(u), 0) < 110)
    return null;
  const rivals = (view.units ?? []).filter(
    (u) =>
      u.owner !== view.playerId &&
      u.owner !== "barb" &&
      military(u) &&
      cities.some((c) => distance(c, u) < 3),
  );
  for (const rival of rivals.sort(stable)) {
    const f = factions.find((f) => f.id === rival.owner);
    if (!f || f.relation === "alliance" || f.peaceUntil >= view.turn) continue;
    const ours = army
      .filter((u) => distance(u, rival) <= 5)
      .reduce((n, u) => n + power(u), 0);
    const theirs = view.units
      .filter(
        (u) =>
          u.owner === rival.owner && military(u) && distance(u, rival) <= 5,
      )
      .reduce((n, u) => n + power(u), 0);
    const risk = npcWarRisk(view, f.id);
    // Public guarantees add a coalition and commitment penalty.  This uses
    // only the same scoped units/cities already present in the NPC view; an
    // unseen backer's army is never read from the live game object.
    if (ours < theirs * 1.35 || ours < risk.coalitionStrength * 1.1) continue;
    return {
      action: f.relation === "denounced" ? "declareWar" : "denounce",
      factionId: f.id,
    };
  }
  return null;
}

// Kept as an NPC-facing export so engine turn resolution can submit a bounded
// accept/reject decision without granting NPC code access to the game state.
export { npcGuaranteeDecision, npcWarRisk };
