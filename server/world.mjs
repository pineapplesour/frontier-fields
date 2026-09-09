import {
  WIDTH,
  HEIGHT,
  FACTIONS,
  TYPES,
  fromOffset,
  neighbors,
  equal,
  distance,
  START_GRACE_TURNS,
} from "../shared/rules.js";
import { seatFactions } from "./lobby.mjs";

function safeCampSite(g, col, row) {
  const desired = fromOffset(col, row);
  const tile = g.tiles.filter(t => (!t.owner || t.owner === "barb") && !t.cityId &&
    !g.cities.some(c => equal(c, t)) && !g.units.some(u => u.hp > 0 && equal(u, t)))
    .sort((a, b) => distance(a, desired) - distance(b, desired))[0];
  return tile ? [tile.q, tile.r + Math.floor(tile.q / 2)] : null;
}

export function populateWorld(g, random, addUnit, territory) {
  const tileAt = (p) => g.tiles.find((t) => equal(t, p));
  for (const id of Object.keys(FACTIONS)) {
    g.players[id] ??= { ready: false, connected: true, npc: true };
    g.stockpiles[id] ??= { iron: 3, horses: 3, niter: 3 };
    g.events[id] = [];
    g.effects[id] = [];
    g.contacts[id] = {};
  }
  g.explored = Object.fromEntries(Object.keys(FACTIONS).map((id) => [id, {}]));
  g.relations = {};
  g.alliances = {};
  g.denouncements = {};
  for (let col = 0; col < WIDTH; col++)
    for (let row = 0; row < HEIGHT; row++) {
      const rnd = random(
          g.seed +
            Math.min(col, WIDTH - 1 - col) * 109 +
            Math.min(row, HEIGHT - 1 - row) * 991,
        ),
        v = rnd();
      const terrain = v < 0.09 ? "mountain" : v < 0.3 ? "hills" : "plains";
      g.tiles.push({
        ...fromOffset(col, row),
        terrain,
        fertility:
          terrain === "plains"
            ? 1 + Math.floor(rnd() * 3)
            : terrain === "hills"
              ? Math.floor(rnd() * 2)
              : 0,
        owner: null,
        farm: false,
        developed: false,
        resource:
          terrain === "mountain"
            ? null
            : rnd() < 0.09
              ? ["iron", "horses", "niter"][Math.floor(rnd() * 3)]
              : null,
      });
    }
  const starts = [
    ["p1", 3, 5, "들샘"],
    ["p2", 16, 5, "솔마루"],
    ["p3", 3, 14, "청람성"],
    ["p4", 16, 14, "자운성"],
  ];
  function city(owner, col, row, name, extra = {}) {
    const pos = fromOffset(col, row),
      c = {
        id:
          owner === "p1"
            ? "c1"
            : owner === "p2"
              ? "c2"
              : `city-${owner}-${col}-${row}`,
        owner,
        name,
        ...pos,
        population: 4,
        food: 8,
        growthProgress: 0,
        growthHalfGranted: false,
        starvationTurns: 0,
        citizenPolicy: { auto: true, lockedSlots: [], priority: [] },
        mobilizationQueue: [],
        mobilizationLastDispatchTurn: null,
        production: 0,
        queue: null,
        hp: 160,
        capital: true,
        isolation: 0,
        supplied: true,
        wallLevel: 0,
        attackUsed: false,
        ...extra,
      };
    g.cities.push(c);
    Object.assign(tileAt(pos), {
      terrain: "plains",
      fertility: 3,
      resource: null,
    });
    if (!c.camp) territory(g, c);
    return c;
  }
  for (const [owner, col, row, name] of starts) {
    const sign = col < 10 ? 1 : -1;
    const c = city(owner, col, row, name);
    const placements = [
      [col + sign, row, "builder"],
      [col + sign, row - 1, "musketeer"],
      [col + 2 * sign, row, "cavalry"],
      [col, row + 1, "artillery"],
      [col, row - 1, "spearman"],
    ];
    for (const [x, y, type] of placements) {
      const p = fromOffset(x, y);
      Object.assign(tileAt(p), {
        terrain: "plains",
        fertility: 2,
        resource: null,
      });
      addUnit(g, owner, type, p);
    }
    for (const x of [col, col + sign])
      Object.assign(tileAt(fromOffset(x, row - 1)), {
        terrain: "plains",
        fertility: 2,
        farm: true,
        owner,
        cityId: c.id,
        resource: null,
      });
    for (const [x, y, resource] of [
      [col - sign, row - 1, "iron"],
      [col + sign, row + 1, "horses"],
      [col - sign, row + 1, "niter"],
    ])
      Object.assign(tileAt(fromOffset(x, y)), {
        resource,
        terrain: resource === "horses" ? "plains" : "hills",
        fertility: resource === "horses" ? 2 : 1,
        farm: false,
      });
    territory(g, c);
  }
  for (const [x, y, name] of [
    [9, 3, "금빛항"],
    [10, 16, "은빛항"],
  ]) {
    const c = city("cs", x, y, name, {
      capital: false,
      population: 3,
      wallLevel: 1,
      hp: 210,
    });
    addUnit(g, "cs", "spearman", c, { fortified: true });
    for (const n of neighbors(c).slice(0, 2))
      Object.assign(tileAt(n), {
        terrain: "plains",
        fertility: 2,
        farm: true,
        owner: "cs",
        cityId: c.id,
      });
  }
  for (const [x, y] of [
    [9, 9],
    [0, 11],
    [19, 18],
  ]) {
    const site = safeCampSite(g, x, y);
    if (!site) continue;
    const c = city("barb", ...site, "야만인 거점", {
      population: 0,
      food: 0,
      capital: false,
      camp: true,
      hp: 80,
    });
    for (const t of g.tiles.filter((t) => t.cityId === c.id))
      Object.assign(t, { owner: null, cityId: null });
    Object.assign(tileAt(c), { camp: true, owner: "barb", cityId: c.id });
    addUnit(
      g,
      "barb",
      "spearman",
      { q: c.q, r: c.r },
      { home: { q: c.q, r: c.r } },
    );
  }
  // Two guaranteed traversable belts, including their E/W seam.
  for (const y of [5, 14])
    for (let x = 0; x < WIDTH; x++) {
      const t = tileAt(fromOffset(x, y));
      t.terrain = "plains";
      t.fertility ||= 2;
    }
  for (const t of g.tiles.filter((t) => t.q === 7 || t.q === 12))
    for (const n of neighbors(t).filter((n) => n.q === t.q + 1 && tileAt(n)))
      g.rivers.push({ a: { q: t.q, r: t.r }, b: n });
}

const terrainFor = (random) => {
  const v = random();
  return v < 0.09 ? "mountain" : v < 0.3 ? "hills" : "plains";
};

/**
 * Expansion-v1 world setup.  Player civilizations begin as mobile
 * settlements rather than pre-founded capitals.  The start list is kept on
 * the server game object only; observe() never serializes it.  All initial
 * armies are ordinary units, so a human, agent, or rule NPC uses the same
 * legal settle action.
 */
export function populateExpansionWorld(g, random, addUnit, territory, seats) {
  const ids = seats.map((seat) => seat.id),
    factions = seatFactions(seats, g.factionDefinitions ?? {});
  g.factions = factions;
  for (const id of Object.keys(factions)) {
    g.players[id] ??= { id, ready: false, connected: id === "cs" || id === "barb", controller: "npc" };
    if (id === "cs" || id === "barb") g.players[id].controller = "npc";
    g.stockpiles[id] ??= { iron: 3, horses: 3, niter: 3 };
    g.events[id] = [];
    g.effects[id] = [];
    g.contacts[id] = {};
  }
  g.explored = Object.fromEntries(Object.keys(factions).map((id) => [id, {}]));
  g.cityContacts = Object.fromEntries(Object.keys(factions).map((id) => [id, {}]));
  g.relations = {};
  g.alliances = {};
  g.denouncements = {};
  g.founded = Object.fromEntries(ids.map((id) => [id, false]));
  g.startGraceTurns = START_GRACE_TURNS;
  for (let col = 0; col < WIDTH; col++)
    for (let row = 0; row < HEIGHT; row++) {
      const t = terrainFor(random),
        fertility =
          t === "plains" ? 1 + Math.floor(random() * 3) : t === "hills" ? Math.floor(random() * 2) : 0;
      g.tiles.push({
        ...fromOffset(col, row),
        terrain: t,
        fertility,
        owner: null,
        cityId: null,
        farm: false,
        developed: false,
        resource:
          t === "mountain" || random() >= 0.09
            ? null
            : ["iron", "horses", "niter"][Math.floor(random() * 3)],
      });
    }
  const tileAt = (p) => g.tiles.find((t) => equal(t, p));
  // Keep the fixed independent sites out of player staging positions.  The
  // sites are created after player placement, so filtering them here avoids
  // a seed-dependent overlap that could otherwise hide a settler under a
  // city-state or barbarian camp.
  const protectedSites = [fromOffset(9, 3), fromOffset(9, 9)];
  const candidates = g.tiles.filter(
    (t) =>
      t.terrain !== "mountain" &&
      protectedSites.every((site) => distance(t, site) >= 4) &&
      // Keep a complete six-unit staging ring away from every map edge of
      // the flat, non-wrapping board.
      neighbors(t).filter(tileAt).length >= 5,
  );
  // Maximin selection keeps eight starts visibly separated while preserving
  // a deterministic seed.  The fallback spacing is still four hexes, which
  // is the same minimum used by settlement rules.
  const starts = [];
  while (starts.length < ids.length && candidates.length) {
    const ranked = candidates
      .filter((t) => !starts.some((s) => equal(s, t)))
      .map((t) => ({
        t,
        score: starts.length
          ? Math.min(...starts.map((s) => distance(s, t)))
          : Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => b.score - a.score || a.t.q - b.t.q || a.t.r - b.t.r);
    const chosen = ranked.find((x) => x.score >= 6) ?? ranked.find((x) => x.score >= 4) ?? ranked[0];
    starts.push(chosen.t);
    // Never use a chosen point as a later candidate, even if its terrain is
    // subsequently normalized to plains.
    candidates.splice(candidates.indexOf(chosen.t), 1);
  }
  g.startPositions = Object.fromEntries(ids.map((id, i) => [id, { ...starts[i] }]));
  const placementTypes = [
    "settler",
    "builder",
    "spearman",
    "musketeer",
    "cavalry",
    "artillery",
  ];
  for (const [index, id] of ids.entries()) {
    const start = starts[index];
    const positions = [start, ...neighbors(start).filter(tileAt).slice(0, 5)];
    for (const [unitIndex, p] of positions.entries()) {
      const tile = tileAt(p),
        type = placementTypes[unitIndex];
      if (!tile) continue;
      // The initial footprint is an honest, traversable staging area.  The
      // surrounding terrain remains procedural; only the six occupied start
      // tiles are normalized so every settler can legally found on turn one.
      tile.terrain = "plains";
      tile.fertility = Math.max(2, tile.fertility ?? 0);
      tile.resource = null;
      addUnit(g, id, type, p);
    }
  }
  // Independent city-state and hostile camps remain part of the world, but
  // no player civilization receives a pre-founded major city.
  const city = (owner, col, row, name, extra = {}) => {
    const p = fromOffset(col, row),
      c = {
        id: `city-${owner}-${col}-${row}`,
        owner,
        name,
        ...p,
        population: extra.population ?? 3,
        food: extra.population === 0 ? 0 : 8,
        growthProgress: 0,
        growthHalfGranted: false,
        starvationTurns: 0,
        citizenPolicy: { auto: true, lockedSlots: [], priority: [] },
        mobilizationQueue: [],
        mobilizationLastDispatchTurn: null,
        production: 0,
        queue: null,
        hp: extra.hp ?? 160,
        capital: false,
        isolation: 0,
        supplied: true,
        wallLevel: extra.wallLevel ?? 0,
        attackUsed: false,
        rulesVersion: g.rulesVersion,
        ...extra,
      };
    g.cities.push(c);
    const t = tileAt(p);
    if (t) {
      t.terrain = "plains";
      t.fertility = 3;
      t.resource = null;
    }
    if (!c.camp) territory(g, c, { initial: true });
    return c;
  };
  const cs = city("cs", 9, 3, "금빛항", { wallLevel: 1, hp: 210 });
  addUnit(g, "cs", "spearman", cs, { fortified: true });
  const campSite = safeCampSite(g, 9, 9);
  if (campSite) {
  const camp = city("barb", ...campSite, "야만인 거점", {
    camp: true,
    population: 0,
    food: 0,
    hp: 80,
  });
  for (const t of g.tiles.filter((t) => t.cityId === camp.id))
    Object.assign(t, { owner: null, cityId: null });
  Object.assign(tileAt(camp), { camp: true, owner: "barb", cityId: camp.id });
  addUnit(g, "barb", "spearman", camp, { home: { q: camp.q, r: camp.r } });
  }
  // Guarantee two broad traversable belts for fair early settlement without
  // exposing the private start coordinates to opponents.
  for (const y of [5, 14])
    for (let x = 0; x < WIDTH; x++) {
      const t = tileAt(fromOffset(x, y));
      if (t) {
        t.terrain = "plains";
        t.fertility ||= 2;
      }
    }
}
