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
import { combatPreview, unitDamage, unfavorableFight } from "../shared/combat.js";
import { npcWarRisk, npcGuaranteeDecision } from "./guarantees.mjs";
import {
  encampmentCandidates,
  structureProductionDefinition,
} from "./militaryStructures.mjs";
const NPCS = ["p3", "p4", "cs", "barb"];
// Strategic thresholds for rule-based NPC military decisions.  Every value is
// an observation-scoped heuristic; nothing here reads hidden enemy state.
export const NPC_STRATEGY = Object.freeze({
  // --- pillage policy -------------------------------------------------------
  PILLAGE_HEAL: 50, // engine heals +50 HP on pillage/scorch
  SIEGE_HEAL_RATIO: 0.5, // siege mode: only a unit below this HP ratio pillages (for the heal)
  STARVE_STRIKE_RATIO: 0.75, // strike < defense * ratio  => cannot take the city soon => starve mode
  STRIKE_READY_RATIO: 1.0, // strike >= defense * ratio  => the army may show itself and assault
  STRIKE_RADIUS: 5, // allies within this range of the target city count as the strike force
  RAID_RADIUS: 3, // enemy improvements within this range of the target city are its farmland
  TARGET_CITY_RANGE: 7, // nearest hostile city within this range is the unit's war target
  RAID_MIN_HP_RATIO: 0.5, // a raider below this ratio stops raiding (it pillages only where it stands)
  RAID_APPROACH_DANGER_RATIO: 0.5, // approach step danger must stay below hp * ratio
  LETHAL_DANGER_RATIO: 0.6, // expected damage >= hp * ratio counts as lethal fire cover
  HEAL_PILLAGE_DANGER_SLACK: 8, // a heal-pillage step may be at most this much more dangerous than staying
  KEY_POSITION_THREAT_RANGE: 3, // a unit on a city/structure with foes this close holds it
  // --- favorable ground -----------------------------------------------------
  GROUND_HILLS: 4,
  GROUND_OWN_TERRITORY: 2,
  GROUND_STRUCTURE: 3,
  GROUND_CITY: 3,
  FIRING_GROUND_WEIGHT: 0.6, // ground value weight when choosing a firing position
  UNFAVORABLE_TRADE_RATIO: 1.3, // received * ratio > dealt => bad trade (only a kill or a free shot allows it)
  OUTGUNNED_RATIO: 1.2, // local enemy power > ours * ratio => hold favorable ground instead of closing
  OUTGUNNED_GROUND_WEIGHT: 2.5,
  OUTGUNNED_CONTACT_PENALTY: 10, // do not step adjacent to a superior enemy
  // --- defense of own cities and improvements -------------------------------
  GARRISON_THREAT_RANGE: 4, // foes this close to an empty own city summon the nearest garrison
  RAIDER_INTERCEPT_RANGE: 4, // foes this close to own farms/resources are treated as raiders
  DEFENDERS_PER_RAIDER: 2,
  COVER_WEIGHT: 2, // value per own improvement covered (within 1) by a position
  // --- key positions and concealment ----------------------------------------
  THREAT_RANGE: 8, // foes this close to home trigger key-position pre-emption
  KEY_TILE_RANGE: 3, // key tiles lie within this range of the home city
  CITY_VISION: 3, // enemy cities see this far (mirrors engine visibility)
  HIDE_PENALTY: 16, // rank penalty for standing in enemy vision while the strike is not ready
  STAGING_DISTANCE: 4, // offensive march stops on this ring around the objective (just outside city vision)
  MERGE_MIN_ARMY: 4, // quiet-time merging into brigades/divisions starts at this army size
  // --- growth and buildup ---------------------------------------------------
  MAX_CITIES: 8, // land-based cap: sites must also lie within 8 tiles of an own city
  SETTLER_MIN_POP: 3, // the settler city keeps growing past this
  SETTLERS_IN_FLIGHT_PER_CITIES: 2, // one settler in flight per this many cities (min 1)
  SETTLER_BUY_RESERVE: 80, // buy a settler with gold when gold >= price + reserve
  SITE_RESOURCE_BONUS: 6, // per strategic resource tile in the site's ring
  SITE_HILLS_BONUS: 2, // defensible city tile
  SITE_RIVER_BONUS: 2, // adjacent river edge
  SITE_CONTESTED_BONUS: 3, // rival territory within 3: claim it first
  SITE_IDEAL_SPACING: 4, // compact borders: preferred distance to the nearest own city
  ARMY_PER_CITY: 2, // baseline army size per city
  ARMY_POP_DIVISOR: 3, // plus one unit per this much population
  ARMY_PARITY_RATIO: 1.0, // keep army power >= strongest neighbour's visible power * ratio
  NEIGHBOUR_RANGE: 8, // a civ with cities/units this close to ours is a neighbour
  // --- offensives (never a warmonger) --------------------------------------
  TEMPERAMENT: Object.freeze({ default: 0.3, p3: 0.35, p4: 0.3 }), // aggression 0..1
  OFFENSE_ADVANTAGE_BASE: 1.6, // required own/their power ratio at aggression 1
  OFFENSE_ADVANTAGE_SCALE: 0.8, // added requirement per (1 - aggression)
  CITY_DEFENSE_WEIGHT: 0.4, // city hp + wall hp counted at this weight in their power
  EXPOSED_IMPROVEMENTS_MIN: 2, // exposed enemy farms/resources needed for an economic casus belli
  MIN_OFFENSIVE_ARMY: 5,
  MIN_OFFENSIVE_POWER: 110,
});
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
  const cities = view.cities.filter((c) => c.owner === view.playerId && !c.camp);
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
  const own = view.cities.filter((c) => c.owner === view.playerId && !c.camp);
  const tiles = new Map(view.tiles.map((t) => [key(t), t]));
  const threats = view.units.filter((u) => u.hostile && military(u));
  const S = NPC_STRATEGY;
  const rivers = view.rivers ?? [];
  const riverside = (t) =>
    rivers.some((e) => equal(e.a, t) || equal(e.b, t));
  const contested = (t) =>
    view.tiles.some(
      (p) => p.owner && p.owner !== view.playerId && distance(p, t) <= 3,
    );
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
        // Remembered (ghost) cities also enforce the 4-tile spacing, so a site
        // does not flip between valid and invalid as fog moves with the settler.
        !(view.cityContacts ?? []).some((c) => distance(c, t) < 4) &&
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
          (p.resource ? S.SITE_RESOURCE_BONUS : 0),
        0,
      );
      const spacing = own.length
        ? Math.min(...own.map((c) => distance(c, t)))
        : S.SITE_IDEAL_SPACING;
      return {
        tile: t,
        score:
          quality -
          distance(settler, t) * 1.1 -
          Math.abs(spacing - S.SITE_IDEAL_SPACING) * 2 +
          (t.terrain === "hills" ? S.SITE_HILLS_BONUS : 0) +
          (riverside(t) ? S.SITE_RIVER_BONUS : 0) +
          (contested(t) ? S.SITE_CONTESTED_BONUS : 0),
      };
    })
    .sort((a, b) => b.score - a.score || stable(a.tile, b.tile))
    .map((x) => x.tile);
}

export function npcEconomy(view) {
  if (!isNpc(view) || view.playerId === "barb") return [];
  const own = view.playerId,
    cities = (view.cities ?? []).filter((c) => c.owner === own && !c.camp);
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
  // Buildup target: proportional to the economy and to the strongest visible
  // neighbour, so the army keeps pace instead of stalling at a token guard.
  const S = NPC_STRATEGY;
  const armyPower = army.reduce((n, u) => n + power(u), 0);
  const neighbourPower = Math.max(
    0,
    ...factionList(view)
      .filter((f) => f.id !== own && f.id !== "barb")
      .map((f) =>
        (view.units ?? [])
          .filter(
            (u) =>
              u.owner === f.id &&
              military(u) &&
              cities.some((c) => distance(c, u) <= S.NEIGHBOUR_RANGE),
          )
          .reduce((n, u) => n + power(u), 0),
      ),
  );
  const armyTarget =
    cities.length * S.ARMY_PER_CITY +
    Math.ceil((view.economy.population ?? 0) / S.ARMY_POP_DIVISOR);
  const armyShort =
    army.length < armyTarget || armyPower < neighbourPower * S.ARMY_PARITY_RATIO;
  // Expansion is a first-class priority: the best-food city with a garrison
  // produces (or buys) settlers while legal sites remain and the cap allows.
  const sites = settlementSites(view, {
    ...(cities[0] ?? { q: 0, r: 0 }),
    type: "settler",
  });
  const settlersWanted =
    cities.length < S.MAX_CITIES &&
    sites.length > 0 &&
    count("settler") <
      Math.max(1, Math.floor(cities.length / S.SETTLERS_IN_FLIGHT_PER_CITIES));
  const garrisoned = (c) => army.some((u) => distance(u, c) <= 1);
  const settlerCity = settlersWanted
    ? cities
        .filter((c) => c.population >= S.SETTLER_MIN_POP)
        .sort(
          (a, b) =>
            (garrisoned(b) ? 1 : 0) - (garrisoned(a) ? 1 : 0) ||
            (b.foodNet ?? 0) - (a.foodNet ?? 0) ||
            b.population - a.population ||
            stable(a, b),
        )[0] ?? null
    : null;
  let settlerPlanned = false;
  if (
    settlerCity &&
    (garrisoned(settlerCity) || army.length >= 1) &&
    gold >= (productionType("settler", settlerCity)?.cost ?? Infinity) + S.SETTLER_BUY_RESERVE &&
    !units.some((u) => equal(u, settlerCity) && isCivilian(u))
  ) {
    plans.push({
      transaction: { action: "buyUnit", cityId: settlerCity.id, type: "settler" },
    });
    gold -= productionType("settler", settlerCity).cost;
    settlerPlanned = true;
  }
  const capacityOk = () =>
    view.economy.capacity == null ||
    view.economy.used +
      plans.filter((p) => p.production && p.production[0].type !== "walls")
        .length <
      view.economy.capacity - 1;
  for (const c of cities) {
    const localFoes = foes.filter((e) => distance(e, c) <= 4);
    const localArmy = army.filter((e) => distance(e, c) <= 4);
    const emergency =
      localFoes.length > 0 &&
      localFoes.reduce((n, u) => n + power(u), 0) >
        localArmy.reduce((n, u) => n + power(u), 0) * 0.75;
    const wantSettlerHere =
      !settlerPlanned &&
      settlerCity?.id === c.id &&
      (garrisoned(c) || army.length >= 1) &&
      !emergency;
    // Do not repeatedly reset a healthy production queue, except to start an
    // overdue settler (once: afterwards the queue is the settler itself).
    if (
      c.queue &&
      !(emergency && ["builder", "settler"].includes(c.queue)) &&
      !(wantSettlerHere && !["settler", "wallRepair", "walls"].includes(c.queue))
    )
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
    const settlementReady = wantSettlerHere;
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
    else if (settlementReady) {
      type = "settler";
      settlerPlanned = true;
    } else if (
      encampmentTarget &&
      !c.queue &&
      view.turn >= 3 &&
      c.population >= 3 &&
      army.length >= 2
    ) {
      type = "encampment";
      target = point(encampmentTarget);
    } else if (armyShort && count("builder") >= 1 && capacityOk())
      type = counter();
    else if (
      jobs > 0 &&
      count("builder") < Math.min(cities.length + 1, Math.ceil(jobs / 6))
    )
      type = "builder";
    else if (capacityOk()) type = counter();
    else if ((c.wallLevel ?? 0) < 3) type = "walls";
    // Never leave a city idle: keep builders working while the army is capped.
    else if (jobs > 0) type = "builder";
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
  // A pending pillage/scorch resolves at end of turn; never override it.
  if (["pillage", "scorch"].includes(u.order?.action)) return null;
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
  // Improvement actions are observation-scoped.  A hostile facility is only
  // plundered through the strategic pillage policy below; NPCs may scorch
  // their own farm only when a detailed-supply emergency makes the one-time
  // food/heal trade strategic.  They never routine-destroy healthy
  // infrastructure for cash.
  if (
    military(u) &&
    t &&
    (t.farm || t.developed) &&
    !t.ruin &&
    ratio < 0.8 &&
    t.owner === u.owner &&
    view.economy?.supplyMode === "on" &&
    localCity?.foodStock <= localCity?.foodConsumption
  )
    return { unitId: id, action: "scorch" };
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

  // ---- Strategic layer: pillage policy, favorable ground, defense duties,
  // key positions and concealment.  All inputs are the NPC's own observation.
  const S = NPC_STRATEGY;
  const atWarWith = (owner) =>
    !!owner && owner !== u.owner && !!factionFor(view, owner)?.hostile;
  const isCityTile = (p) => view.cities.some((c) => equal(c, p));
  const improvement = (p) =>
    !!p && (p.farm || p.developed) && !p.ruin && !isCityTile(p);
  const enemyImprovement = (p) =>
    improvement(p) && p.explored !== false && atWarWith(p.owner);
  const ownImprovement = (p) => improvement(p) && p.owner === u.owner;
  const blocked = (p) =>
    view.units.some((e) => e.id !== u.id && equal(e, p) && blocksUnit(u, e));
  const lethal = (p, hp = u.hp) => danger(p) >= hp * S.LETHAL_DANGER_RATIO;
  const ownStructure = (p) => {
    const structure = structureAt(view, p);
    return (
      !!structure &&
      structure.owner === u.owner &&
      (structure.hp > 0 || structure.wallHp > 0)
    );
  };
  const ground = (p) =>
    (p.terrain === "hills" ? S.GROUND_HILLS : 0) +
    (p.owner === u.owner ? S.GROUND_OWN_TERRITORY : 0) +
    (ownStructure(p) ? S.GROUND_STRUCTURE : 0) +
    (cities.some((c) => equal(c, p)) ? S.GROUND_CITY : 0);
  const cover = (p) =>
    view.tiles.filter((x) => ownImprovement(x) && distance(x, p) <= 1).length;
  const holdingKeyPosition =
    (cities.some((c) => equal(c, u)) || ownStructure(t)) &&
    foes.some((e) => distance(e, u) <= S.KEY_POSITION_THREAT_RANGE);
  const seenByEnemy = (p) =>
    foes.some((e) => distance(e, p) <= TYPES[e.type].vision) ||
    enemyCities.some((c) => distance(c, p) <= S.CITY_VISION);
  const strikeAt = (c) =>
    allies
      .filter((e) => military(e) && distance(e, c) <= S.STRIKE_RADIUS)
      .reduce((n, e) => n + power(e), 0);
  const defenseAt = (c) =>
    (c.hp ?? 0) +
    (c.wallHp ?? 0) +
    foes.filter((e) => distance(e, c) <= 1).reduce((n, e) => n + power(e), 0);
  const targetCity =
    enemyCities
      .filter((c) => !c.camp && distance(c, u) <= S.TARGET_CITY_RANGE)
      .sort((a, b) => distance(a, u) - distance(b, u) || stable(a, b))[0] ??
    null;
  const strikeReady = targetCity
    ? strikeAt(targetCity) >= defenseAt(targetCity) * S.STRIKE_READY_RATIO
    : true;
  const warMode = !targetCity
    ? null
    : strikeAt(targetCity) < defenseAt(targetCity) * S.STARVE_STRIKE_RATIO
      ? "starve"
      : "siege";
  const healedHp = Math.min(maxHealth(u), u.hp + S.PILLAGE_HEAL);
  const pillageHere = () =>
    enemyImprovement(t) && !lethal(t, healedHp)
      ? { unitId: id, action: "pillage" }
      : null;
  // Leave hostile ground after a raid: away from fire, toward home.
  const withdraw = () => {
    if (u.movesLeft <= 0) return fortify();
    const rank = (p) =>
      -danger(p) * 1.5 +
      (home ? -distance(p, home) * 2 : 0) +
      (p.owner === u.owner ? 4 : 0) +
      (atWarWith(p.owner) ? -3 : 0) +
      (p.terrain === "hills" ? 2 : 0);
    const best = view.tiles
      .filter((p) => reach.has(key(p)) && p.explored && !blocked(p))
      .sort((a, b) => rank(b) - rank(a) || stable(a, b))[0];
    return best && !equal(best, u) && rank(best) > rank(t)
      ? moveTo(best)
      : fortify();
  };
  // Defense duties: one garrison per threatened empty city, and up to
  // DEFENDERS_PER_RAIDER interceptors per raider approaching own improvements.
  const duty = () => {
    if (!military(u) || u.owner === "barb") return null;
    const defenders = allies
      .filter((e) => military(e) && e.type !== "artillery")
      .sort(stable);
    for (const c of cities
      .slice()
      .sort((a, b) => distance(a, u) - distance(b, u) || stable(a, b))) {
      if (!foes.some((e) => distance(e, c) <= S.GARRISON_THREAT_RANGE))
        continue;
      if (allies.some((e) => military(e) && e.id !== id && equal(e, c)))
        continue;
      const nearest = defenders
        .slice()
        .sort((a, b) => distance(a, c) - distance(b, c) || stable(a, b))[0];
      if (nearest?.id !== id) continue;
      if (equal(u, c)) return { hold: true, city: c };
      if (u.movesLeft <= 0) return null;
      if (reach.has(key(c)) && !blocked(c)) return { order: moveTo(c) };
      const step = view.tiles
        .filter(
          (p) => reach.has(key(p)) && p.explored && !blocked(p) && !lethal(p),
        )
        .sort(
          (a, b) =>
            distance(a, c) - distance(b, c) || danger(a) - danger(b) || stable(a, b),
        )[0];
      return step && distance(step, c) < distance(u, c)
        ? { order: moveTo(step) }
        : null;
    }
    const raiders = foes
      .filter((e) =>
        view.tiles.some(
          (p) => ownImprovement(p) && distance(e, p) <= S.RAIDER_INTERCEPT_RANGE,
        ),
      )
      .sort(stable);
    for (const raider of raiders) {
      const assigned = defenders
        .slice()
        .sort(
          (a, b) => distance(a, raider) - distance(b, raider) || stable(a, b),
        )
        .slice(0, S.DEFENDERS_PER_RAIDER);
      if (!assigned.some((e) => e.id === id)) continue;
      const farm = view.tiles
        .filter((p) => ownImprovement(p))
        .sort(
          (a, b) =>
            distance(a, raider) - distance(b, raider) || stable(a, b),
        )[0];
      if (!farm) continue;
      const rank = (p) =>
        ground(p) +
        cover(p) * S.COVER_WEIGHT -
        distance(p, farm) * 2 -
        Math.max(0, distance(p, raider) - def.range) * 1.5 -
        danger(p) * 0.3;
      if (u.movesLeft <= 0) return { hold: true, raider };
      const best = [t, ...view.tiles.filter(
        (p) => reach.has(key(p)) && p.explored && !blocked(p) && !lethal(p),
      )].sort((a, b) => rank(b) - rank(a) || stable(a, b))[0];
      return best && !equal(best, u) && rank(best) > rank(t) + 1
        ? { order: moveTo(best) }
        : { hold: true, raider };
    }
    return null;
  };
  const assigned = duty();
  // Pillage policy.  Starve mode: the city cannot be taken soon, so raid its
  // farmland and leave.  Siege mode: keep the improvements intact while
  // healthy; a hurt unit on/next to one plunders it for the +50 heal when
  // that is safer than a long retreat.  Never on non-war owners, never under
  // lethal fire, never while holding a key position.
  const pillagePlan = () => {
    if (!military(u)) return null;
    if (warMode === "starve" && u.type !== "artillery" && !assigned) {
      const here = pillageHere();
      if (here) return here;
      if (ratio < S.RAID_MIN_HP_RATIO) return null;
      const zone = view.tiles.filter(
        (p) => enemyImprovement(p) && distance(p, targetCity) <= S.RAID_RADIUS,
      );
      if (!zone.length) return atWarWith(t?.owner) ? withdraw() : null;
      if (holdingKeyPosition || u.movesLeft <= 0) return null;
      const now = zone
        .filter(
          (p) => reach.has(key(p)) && !blocked(p) && !lethal(p, healedHp),
        )
        .sort(
          (a, b) =>
            danger(a) - danger(b) ||
            reach.get(key(a)).cost - reach.get(key(b)).cost ||
            stable(a, b),
        );
      if (now[0]) return moveTo(now[0]);
      const goal = zone
        .slice()
        .sort((a, b) => distance(a, u) - distance(b, u) || stable(a, b))[0];
      const step = view.tiles
        .filter(
          (p) =>
            reach.has(key(p)) &&
            p.explored &&
            !blocked(p) &&
            !equal(p, u) &&
            danger(p) < u.hp * S.RAID_APPROACH_DANGER_RATIO,
        )
        .sort(
          (a, b) =>
            distance(a, goal) - distance(b, goal) ||
            danger(a) - danger(b) ||
            stable(a, b),
        )[0];
      if (step && distance(step, goal) < distance(u, goal)) return moveTo(step);
      return atWarWith(t?.owner) ? withdraw() : null;
    }
    if (ratio >= S.SIEGE_HEAL_RATIO) return null;
    const here = pillageHere();
    if (here) return here;
    if (holdingKeyPosition || u.movesLeft <= 0) return null;
    const beside = neighbors(u)
      .map((n) => tiles.get(key(n)))
      .filter(
        (p) =>
          p &&
          enemyImprovement(p) &&
          reach.has(key(p)) &&
          !blocked(p) &&
          !lethal(p, healedHp) &&
          danger(p) <= danger(t) + S.HEAL_PILLAGE_DANGER_SLACK,
      )
      .sort((a, b) => danger(a) - danger(b) || stable(a, b));
    return beside[0] ? moveTo(beside[0]) : null;
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
  // A bad trade (heavy retaliation, counter-type, larger formation, uphill or
  // across a river) is only taken for a kill or when nothing is received.
  const badTrade = (x) =>
    x.e.hp > x.preview.dealt[0] &&
    x.preview.received[1] > 0 &&
    (x.preview.received[1] * S.UNFAVORABLE_TRADE_RATIO > x.preview.dealt[0] ||
      (!!x.e.type && unfavorableFight(view, u, x.e, true)));
  const shot = attacks.find(
    (x) =>
      x.preview.received[1] < u.hp &&
      !badTrade(x) &&
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
  const plunder = pillagePlan();
  if (plunder) return plunder;
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
      const sitesNow = settlementSites(view, u);
      const goodHere =
        sitesNow.length === 0 ||
        sitesNow.slice(0, 3).some((site) => distance(site, u) <= 1);
      if (
        !settlementIssue(view, u) &&
        !t.owner &&
        currentDanger < 5 &&
        goodHere &&
        (allies.some((e) => military(e) && distance(e, u) <= 3) ||
          lateSafeFound)
      )
        return { unitId: id, action: "found" };
      for (const site of sitesNow.slice(0, 8)) {
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
      (ratio < 0.7 ||
        (targets.length && foes.some((x) => x.size > u.size)) ||
        // Quiet buildup: form brigades/divisions once the army is large enough.
        (!targets.length &&
          ratio >= 0.9 &&
          e.hp / maxHealth(e) >= 0.9 &&
          allies.filter(military).length >= S.MERGE_MIN_ARMY)),
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
    (p) =>
      reach.has(key(p)) &&
      p.explored &&
      !equal(p, u) &&
      !enemyCities.some((c) => c.hp > 0 && equal(c, p)),
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
        ground(p) * S.FIRING_GROUND_WEIGHT +
        (e.hp <= preview.dealt[0] ? 35 : 0) -
        (def.range > 1 ? Math.abs(distance(p, e) - def.range) * 3 : 0);
      if (score > 2) firing.push({ p, score });
    }
  }
  firing.sort((a, b) => b.score - a.score || stable(a.p, b.p));
  if (firing[0]) return moveTo(firing[0].p);
  // Garrison and farmland defense come before advancing the line.
  if (assigned?.hold) return fortify();
  if (assigned?.order) return assigned.order;

  // Advance the line as a group rather than walking artillery onto an enemy.
  if (targets.length) {
    const target = [...targets].sort(
      (a, b) => distance(a, u) - distance(b, u) || stable(a, b),
    )[0];
    const preferred = u.type === "artillery" ? def.range : 1;
    // Outgunned locally: hold favorable ground and make the enemy come to us.
    const localFoe = foes
      .filter((e) => distance(e, target) <= 3)
      .reduce((n, e) => n + power(e), 0);
    const localAlly = allies
      .filter((e) => military(e) && distance(e, u) <= 3)
      .reduce((n, e) => n + power(e), 0);
    const outgunned = localFoe > localAlly * S.OUTGUNNED_RATIO;
    const rank = (p) =>
      -Math.abs(distance(p, target) - preferred) * 4 -
      danger(p) * 0.7 +
      support(p) * 0.2 +
      ground(p) * (outgunned ? S.OUTGUNNED_GROUND_WEIGHT : 0.5) -
      (outgunned && distance(p, target) <= 1 ? S.OUTGUNNED_CONTACT_PENALTY : 0) -
      (!strikeReady && seenByEnemy(p) ? S.HIDE_PENALTY : 0);
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
  // Offensive march: at war with a known (seen or remembered) city and no
  // local contact, bring the army to a staging ring just outside the city's
  // vision.  The advance branch takes over on contact once the strike is ready.
  const homeThreat = home
    ? foes.some((e) => distance(e, home) <= S.THREAT_RANGE)
    : false;
  const objective =
    military(u) && !["barb", "cs"].includes(u.owner) && !assigned && !homeThreat
      ? [
          ...enemyCities,
          ...(view.cityContacts ?? []).filter((c) => atWarWith(c.owner)),
        ]
          .filter((c) => !c.camp)
          .sort((a, b) => distance(a, u) - distance(b, u) || stable(a, b))[0]
      : null;
  if (objective && distance(u, objective) > S.STAGING_DISTANCE && u.movesLeft > 0) {
    const step = view.tiles
      .filter(
        (p) =>
          reach.has(key(p)) &&
          p.explored &&
          !blocked(p) &&
          !lethal(p) &&
          !equal(p, u) &&
          distance(p, objective) >= S.STAGING_DISTANCE,
      )
      .sort(
        (a, b) =>
          distance(a, objective) - distance(b, objective) ||
          danger(a) - danger(b) ||
          ground(b) - ground(a) ||
          stable(a, b),
      )[0];
    if (step && distance(step, objective) < distance(u, objective))
      return moveTo(step);
  }
  // Pre-empt key ground between home and an approaching threat: hills, own
  // structures and tiles covering own farmland.
  const threat = home && u.owner !== "barb"
    ? foes
        .filter((e) => distance(e, home) <= S.THREAT_RANGE)
        .sort((a, b) => distance(a, home) - distance(b, home) || stable(a, b))[0]
    : null;
  if (threat && u.type !== "artillery") {
    const keyTile = (p) =>
      (p.terrain === "hills" || ownStructure(p) || cover(p) > 0) &&
      distance(p, home) <= S.KEY_TILE_RANGE &&
      distance(p, threat) < distance(home, threat) &&
      !isCityTile(p);
    const rank = (p) =>
      ground(p) + cover(p) * S.COVER_WEIGHT - danger(p) * 0.3 - distance(p, threat) * 0.5;
    const spots = view.tiles
      .filter((p) => keyTile(p) && p.explored && !lethal(p) && (equal(p, u) || (reach.has(key(p)) && !blocked(p))))
      .sort((a, b) => rank(b) - rank(a) || stable(a, b));
    if (spots[0]) {
      if (equal(spots[0], u) || (keyTile(t) && rank(t) >= rank(spots[0]) - 1))
        return fortify();
      return moveTo(spots[0]);
    }
  }
  const atWar = factionList(view).some((f) => f.id !== "barb" && f.hostile);
  const scouts = allies.filter((e) => e.type === "cavalry").sort(stable);
  const cheap = allies
    .filter((e) => military(e) && e.type !== "artillery")
    .sort(stable);
  const scout =
    u.owner === "barb" ||
    scouts[0]?.id === id ||
    (!scouts.length && !atWar && cheap[0]?.id === id);
  const discovery = (p) =>
    neighbors(p).filter((n) => tiles.get(key(n))?.explored === false).length;
  const rank = (p) =>
    discovery(p) * (scout ? 6 : 1) -
    (home
      ? Math.abs(distance(p, home) - (u.type === "artillery" ? 1 : 3)) * 0.8
      : 0) +
    (p.terrain === "hills" ? 1 : 0) -
    (atWar && !scout && seenByEnemy(p) ? S.HIDE_PENALTY : 0) -
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
  const S = NPC_STRATEGY;
  if (
    army.length < S.MIN_OFFENSIVE_ARMY ||
    army.reduce((n, u) => n + power(u), 0) < S.MIN_OFFENSIVE_POWER
  )
    return null;
  // Not a warmonger: an offensive needs a clear advantage that is sustained
  // through the public denouncement wait (or an existing territorial casus
  // belli), plus a concrete opening: encroaching troops, a weak garrison or
  // exposed farmland next to our border.  Peaceful play is the default.
  const aggression =
    S.TEMPERAMENT[view.playerId] ?? S.TEMPERAMENT.default;
  const required =
    S.OFFENSE_ADVANTAGE_BASE + (1 - aggression) * S.OFFENSE_ADVANTAGE_SCALE;
  const ownPower = army.reduce((n, u) => n + power(u), 0);
  const tiles = view.tiles ?? [];
  const opportunity = (f) => {
    if (!f || f.id === view.playerId || f.id === "barb") return null;
    if (f.kind && f.kind !== "player") return null;
    if (f.relation === "alliance" || f.peaceUntil >= view.turn || f.hostile)
      return null;
    const theirUnits = (view.units ?? []).filter(
      (u) => u.owner === f.id && military(u),
    );
    const near = (view.cities ?? []).filter(
      (c) =>
        c.owner === f.id &&
        !c.camp &&
        cities.some((o) => distance(o, c) <= S.NEIGHBOUR_RANGE),
    );
    const encroaching = theirUnits.filter((u) =>
      cities.some((c) => distance(c, u) < 3),
    );
    if (!near.length && !encroaching.length) return null;
    const theirPower =
      theirUnits.reduce((n, u) => n + power(u), 0) +
      near.reduce((n, c) => n + (c.hp ?? 0) + (c.wallHp ?? 0), 0) *
        S.CITY_DEFENSE_WEIGHT;
    const exposed = tiles.filter(
      (t) =>
        t.owner === f.id &&
        (t.farm || t.developed) &&
        !t.ruin &&
        cities.some((o) => distance(o, t) <= S.NEIGHBOUR_RANGE),
    ).length;
    const weakGarrison = near.some(
      (c) => !theirUnits.some((u) => distance(u, c) <= 1),
    );
    if (ownPower < theirPower * required) return null;
    if (!(encroaching.length || weakGarrison || exposed >= S.EXPOSED_IMPROVEMENTS_MIN))
      return null;
    const risk = npcWarRisk(view, f.id);
    // Public guarantees add a coalition and commitment penalty.  This uses
    // only the same scoped units/cities already present in the NPC view; an
    // unseen backer's army is never read from the live game object.
    if (ownPower < risk.coalitionStrength * 1.1) return null;
    return f;
  };
  for (const f of factions
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!opportunity(f)) continue;
    if (f.warJustification?.justified)
      return { action: "declareWar", factionId: f.id };
    // Wait out the formal-war window after our own denouncement; never a
    // surprise war.
    if (f.relation === "denounced") return null;
    return { action: "denounce", factionId: f.id };
  }
  return null;
}

// Kept as an NPC-facing export so engine turn resolution can submit a bounded
// accept/reject decision without granting NPC code access to the game state.
export { npcGuaranteeDecision, npcWarRisk };
