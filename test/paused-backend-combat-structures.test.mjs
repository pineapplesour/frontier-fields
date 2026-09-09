import test from "node:test";
import assert from "node:assert/strict";
import {
  combatPreview,
  combatRollRange,
  effectiveCombatMatchup,
  unitDamage,
} from "../shared/combat.js";
import {
  ENCAMPMENT_HP,
  ENCAMPMENT_WALL_HP,
  fortBonus,
  structureDefenseBonus,
  structureObservation,
  structurePositionBonus,
} from "../shared/structures.js";
import {
  beginWallRepair,
  captureStructure,
  encampmentIssue,
  placeEncampment,
  recordStructureHit,
  repairStructure,
  repairWalls,
} from "../server/militaryStructures.mjs";

const tile = (q, r, extra = {}) => ({
  q,
  r,
  terrain: "plains",
  owner: "p1",
  explored: true,
  farm: false,
  developed: false,
  resource: null,
  fort: null,
  encampment: null,
  ...extra,
});

test("captured zero-HP encampment keeps a positional advantage until repaired", () => {
  const city = { id: "city", owner: "p1", q: 2, r: 2, hp: 160 };
  const view = {
    cities: [city],
    tiles: [tile(2, 2), tile(3, 2)],
  };
  const structure = placeEncampment(view, "p1", { q: 3, r: 2 }, {
    cityId: city.id,
  });
  assert.equal(structure.hp, ENCAMPMENT_HP);
  assert.equal(structure.wallHp, ENCAMPMENT_WALL_HP);
  assert.equal(
    encampmentIssue(view, "p1", { q: city.q, r: city.r }, { cityId: city.id }),
    "도시 중심 타일 밖에 주둔지를 지어 주세요.",
  );

  captureStructure(structure, "p2", { turn: 7 });
  assert.equal(structure.hp, 0);
  assert.equal(structure.wallHp, 0);
  assert.equal(structure.captured, true);
  const capturedView = {
    ...view,
    tiles: view.tiles.map((t) =>
      t.encampment ? { ...t, encampment: { ...t.encampment } } : t,
    ),
  };
  const capturedUnit = { type: "spearman", owner: "p2", q: 3, r: 2 };
  assert.equal(
    structurePositionBonus(capturedView, capturedUnit),
    0.1,
  );
  assert.equal(structureDefenseBonus(capturedView, capturedUnit), 0.25);
  assert.equal(structureObservation(structure).usablePosition, true);

  const repair = repairStructure(structure, 20, { owner: "p2" });
  assert.equal(repair.repaired, 20);
  assert.equal(structure.hp, 20);
  assert.equal(structure.wallHp, 0);
});

test("encampment wall hits absorb first and any incoming hit interrupts gradual repair", () => {
  const structure = {
    kind: "encampment",
    owner: "p1",
    hp: 80,
    maxHp: 80,
    wallHp: 20,
    wallMaxHp: 50,
    captured: false,
    lastIncomingAttackTurn: 0,
  };
  assert.equal(beginWallRepair(structure, { owner: "p1", turn: 5 }).started, true);
  assert.equal(repairWalls(structure, 10, { owner: "p1", turn: 6 }).repaired, 10);
  assert.equal(structure.wallHp, 30);
  const hit = recordStructureHit(structure, 40, { turn: 7 });
  assert.deepEqual(
    {
      wallDamage: hit.wallDamage,
      bodyDamage: hit.bodyDamage,
      wallHp: hit.wallHp,
      hp: hit.hp,
      interruptedRepair: hit.interruptedRepair,
    },
    {
      wallDamage: 30,
      bodyDamage: 10,
      wallHp: 0,
      hp: 70,
      interruptedRepair: true,
    },
  );
  assert.equal(
    repairWalls(structure, 10, { owner: "p1", turn: 8 }).interrupted,
    false,
  );
  assert.equal(structure.wallHp, 0);
  assert.equal(repairWalls(structure, 10, { owner: "p1", turn: 12 }).repaired, 10);
  assert.equal(structure.wallHp, 10);
  assert.equal(structure.hp, 70);
});

test("combat preview exposes public niter legality, city garrison pool, and wall shield", () => {
  const attacker = {
    id: "a",
    owner: "p1",
    type: "musketeer",
    q: 3,
    r: 3,
    size: 1,
    hp: 100,
    xp: 0,
    attackUsed: false,
    ammunition: { ready: false, available: 0, shortfall: 1 },
  };
  const target = {
    id: "b",
    owner: "p2",
    type: "spearman",
    q: 4,
    r: 3,
    size: 1,
    hp: 100,
    xp: 0,
    hostile: true,
  };
  const cityView = {
    turn: 4,
    tiles: [tile(3, 3), tile(4, 3, { owner: "p2" })],
    units: [attacker, target],
    cities: [{ id: "c", owner: "p2", q: 4, r: 3, hp: 100, wallLevel: 0, wallHp: 0 }],
  };
  const noAmmo = combatPreview(cityView, attacker, target);
  assert.equal(noAmmo.legal, false);
  assert.ok(noAmmo.reasons.some((reason) => reason.includes("초석 부족")));
  assert.equal(noAmmo.garrisonProtected, true);
  assert.equal(noAmmo.cityPool.hp, 100);
  assert.ok(noAmmo.dealtBounds[1] > 0);
  assert.ok(noAmmo.dealt[1] > 0);

  const ready = { ...attacker, ammunition: { ready: true, available: 1 } };
  const structure = {
    kind: "encampment",
    owner: "p2",
    hp: 80,
    maxHp: 80,
    wallHp: 30,
    wallMaxHp: 50,
  };
  const shieldView = {
    ...cityView,
    cities: [],
    tiles: [tile(3, 3), tile(4, 3, { owner: "p2", encampment: structure })],
  };
  const shield = combatPreview(shieldView, ready, target);
  assert.equal(shield.legal, false);
  assert.equal(shield.wallProtected, true);
  assert.deepEqual(shield.dealt, [0, 0]);
  assert.ok(shield.reasons.some((reason) => reason.includes("성벽이 주둔 부대를 보호")));
});

test("city capture preview allows a lethal adjacent attack at zero movement, but defers ranged entry", () => {
  const attacker = {
    id: "adjacent-attacker",
    owner: "p1",
    type: "spearman",
    q: 3,
    r: 3,
    size: 1,
    hp: 100,
    xp: 0,
    movesLeft: 0,
    attackUsed: false,
    hostile: true,
  };
  const city = {
    id: "city-capture",
    owner: "p2",
    q: 4,
    r: 3,
    hp: 1,
    wallLevel: 0,
    wallHp: 0,
    hostile: true,
  };
  const view = {
    turn: 1,
    tiles: [tile(3, 3), tile(4, 3, { owner: "p2" })],
    units: [attacker],
    cities: [],
  };
  const adjacent = combatPreview(view, attacker, city);
  assert.equal(adjacent.legal, true);
  assert.equal(adjacent.capture.lethal, true);
  assert.equal(adjacent.capture.canCapture, true);
  assert.equal(adjacent.capture.guaranteed, true);
  assert.equal(adjacent.capture.requiresEntry, false);
  assert.equal(adjacent.capture.nextTurn, false);
  assert.equal(adjacent.capture.directEntry, true);

  const camp = { ...city, id: "destructible-camp", camp: true };
  const campPreview = combatPreview(view, attacker, camp);
  assert.equal(campPreview.legal, true);
  assert.equal(campPreview.capture.lethal, true);
  assert.equal(campPreview.capture.capturable, false);
  assert.equal(campPreview.capture.canCapture, false);
  assert.equal(campPreview.capture.requiresEntry, false);

  const ranged = {
    ...attacker,
    id: "ranged-attacker",
    type: "musketeer",
    q: 3,
    r: 3,
    ammunition: { ready: true, available: 1 },
  };
  const rangedCity = { ...city, id: "ranged-city", q: 5 };
  const rangedView = {
    ...view,
    tiles: [tile(3, 3), tile(4, 3), tile(5, 3, { owner: "p2" })],
    units: [ranged],
  };
  const rangedPreview = combatPreview(rangedView, ranged, rangedCity);
  assert.equal(rangedPreview.legal, true);
  assert.equal(rangedPreview.capture.lethal, true);
  assert.equal(rangedPreview.capture.canCapture, false);
  assert.equal(rangedPreview.capture.requiresEntry, true);
  assert.equal(rangedPreview.capture.nextTurn, true);
  assert.equal(rangedPreview.capture.entry.artillery, false);

  const artillery = {
    ...ranged,
    id: "artillery-attacker",
    type: "artillery",
    q: 4,
    ammunition: { ready: true, available: 1 },
  };
  const artilleryPreview = combatPreview(
    { ...view, tiles: [tile(4, 3), tile(5, 3, { owner: "p2" })], units: [artillery] },
    artillery,
    rangedCity,
  );
  assert.equal(artilleryPreview.legal, true);
  assert.equal(artilleryPreview.capture.lethal, true);
  assert.equal(artilleryPreview.capture.canCapture, false);
  assert.equal(artilleryPreview.capture.requiresEntry, true);
  assert.equal(artilleryPreview.capture.nextTurn, true);
  assert.equal(artilleryPreview.capture.entry.artillery, true);

  const garrison = {
    ...attacker,
    id: "city-garrison",
    owner: "p2",
    q: 4,
    r: 3,
  };
  const garrisonCity = { ...city, id: "garrison-city" };
  const garrisonPreview = combatPreview(
    {
      ...view,
      units: [attacker, garrison],
      cities: [garrisonCity],
    },
    attacker,
    garrison,
  );
  assert.equal(garrisonPreview.legal, true);
  assert.equal(garrisonPreview.garrisonProtected, true);
  assert.equal(garrisonPreview.capture.canCapture, true);
  assert.equal(garrisonPreview.capture.garrisonBlocked, false);
});

test("veteran combat advantages remain deterministic and bounded", () => {
  const base = {
    type: "cavalry",
    owner: "p1",
    q: 3,
    r: 3,
    size: 1,
    hp: 100,
    isolation: 0,
    riverTurns: 0,
    xp: 0,
  };
  const veteran = { ...base, xp: 62 };
  const defender = {
    type: "musketeer",
    owner: "p2",
    q: 4,
    r: 3,
    size: 1,
    hp: 100,
    xp: 0,
    isolation: 0,
    riverTurns: 0,
  };
  const view = {
    tiles: [tile(3, 3), tile(4, 3, { owner: "p2" })],
    rivers: [],
  };
  assert.deepEqual(combatRollRange(veteran), [0.94, 1.18]);
  assert.ok(effectiveCombatMatchup(veteran, defender) > 1.5);
  assert.ok(unitDamage(veteran, defender, view, 1) >= unitDamage(base, defender, view, 1));
  assert.ok(unitDamage(veteran, defender, view, 0.94) <= unitDamage(veteran, defender, view, 1.18));
  assert.equal(fortBonus({ tiles: [tile(4, 3, { fort: { owner: "p2", hp: 0, captured: false } })] }, defender), 0);
});
