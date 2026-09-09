import test from "node:test";
import assert from "node:assert/strict";
import {
  addUnit,
  createGame,
  observe,
  submitOrders,
} from "../server/engine.mjs";
import { npcUnitOrder } from "../server/npc.mjs";

// Synthetic fixtures only. These games are created in memory and never load a
// running match, a save, or a player observation from outside this test.
function cityFireFixture() {
  const g = createGame({ mode: "practice", now: 0 });
  Object.assign(g, {
    phase: "planning",
    paused: false,
    activePlayer: "p1",
    deadline: null,
    turn: 1,
    units: [],
    cities: [],
    rivers: [],
    wars: ["p1|p2"],
  });
  for (const tile of g.tiles)
    Object.assign(tile, {
      terrain: "plains",
      fertility: 2,
      owner: null,
      cityId: null,
      farm: false,
      developed: false,
      resource: null,
      fort: null,
      encampment: null,
      ruin: null,
    });
  const source = {
    id: "city-fire-source",
    owner: "p1",
    q: 3,
    r: 3,
    name: "포격 도시",
    population: 4,
    food: 0,
    production: 0,
    queue: null,
    hp: 160,
    wallLevel: 1,
    wallHp: 50,
    capital: true,
    isolation: 0,
    supplied: true,
    attackUsed: false,
  };
  const target = {
    id: "city-fire-target",
    owner: "p2",
    q: 5,
    r: 3,
    name: "피격 도시",
    population: 4,
    food: 0,
    production: 0,
    queue: null,
    hp: 160,
    wallLevel: 0,
    wallHp: 0,
    capital: false,
    isolation: 0,
    supplied: true,
    attackUsed: false,
  };
  g.cities.push(source, target);
  for (const city of g.cities)
    Object.assign(
      g.tiles.find((tile) => tile.q === city.q && tile.r === city.r),
      { owner: city.owner, cityId: city.id },
    );
  g.random = () => 0.5;
  return { g, source, target };
}

function fireOnGarrison({ size = 1, xp = 0 } = {}) {
  const fixture = cityFireFixture();
  const { g, source, target } = fixture;
  const garrison = addUnit(
    g,
    "p2",
    "spearman",
    target,
    { size, hp: 100 * size, xp },
  );
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [
      {
        cityId: source.id,
        action: "cityBombard",
        target: { q: target.q, r: target.r },
      },
    ],
  });
  return {
    cityHp: target.hp,
    cityWallHp: target.wallHp,
    cityLoss: 160 - target.hp,
    garrisonHp: garrison.hp,
  };
}

test("city fire damage is independent of garrison size and XP", () => {
  const base = fireOnGarrison({ size: 1, xp: 0 });
  const veteranFormation = fireOnGarrison({ size: 4, xp: 62 });
  assert.deepEqual(
    {
      cityHp: veteranFormation.cityHp,
      cityWallHp: veteranFormation.cityWallHp,
      cityLoss: veteranFormation.cityLoss,
    },
    {
      cityHp: base.cityHp,
      cityWallHp: base.cityWallHp,
      cityLoss: base.cityLoss,
    },
    "city-fire strength must use the city pool, not the selected garrison's strength",
  );
  assert.equal(base.garrisonHp, 100);
  assert.equal(veteranFormation.garrisonHp, 400);
});

test("zero-wall city fire damages the city body while shielding its garrison", () => {
  const result = fireOnGarrison({ size: 2, xp: 62 });
  assert.equal(result.cityWallHp, 0);
  assert.ok(result.cityHp < 160, "wallless city body must still take city-fire damage");
  assert.equal(result.garrisonHp, 200, "standing city body protects the garrison");
});

test("NPC artillery orders do not home to an unseen target", () => {
  const { g } = cityFireFixture();
  g.cities = [];
  g.wars = ["p1|p2"];
  const artillery = addUnit(g, "p1", "artillery", { q: 3, r: 3 });
  const hidden = addUnit(g, "p2", "spearman", { q: 12, r: 3 });
  const view = observe(g, "p1");
  view.seats = [{ id: "p1", controller: "npc" }];
  assert.equal(view.units.some((unit) => unit.id === hidden.id), false);

  const order = npcUnitOrder(view, artillery.id);
  assert.notEqual(order?.action, "attack");
  assert.notEqual(order?.action, "bombard");
  assert.notEqual(order?.target?.q, hidden.q);
});
