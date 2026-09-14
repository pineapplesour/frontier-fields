import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  submitOrders,
  observe,
  restoreGame,
  restoreRuntimeGame,
  resolveTurn,
  economy,
  farmYield,
  bankProduction,
  applyStoredProduction,
  grantInstantProduction,
  builderFeatureAction,
} from "../server/engine.mjs";
import {
  seedTileFeatures,
  ensureTileFeatures,
  rollFeature,
} from "../server/features.mjs";
import { featureActionIssue, constructionIssue } from "../shared/construction.js";
import {
  PRODUCTION_BANK_CAP,
  CHOP_PRODUCTION,
  HARVEST_FOOD,
  HARVEST_PRODUCTION,
  HARVEST_RESOURCE_AMOUNT,
  WHEAT_FARM_FOOD_BONUS,
  FOREST_CHANCE,
  WHEAT_CHANCE,
  WHEAT_MIN_FERTILITY,
  productionType,
  equal,
  key,
} from "../shared/rules.js";

const tileAt = (g, p) => g.tiles.find((t) => equal(t, p));
function legacy() {
  const g = createGame({ now: 1000 });
  const city = g.cities.find((c) => c.id === "c1");
  const builder = g.units.find((u) => u.owner === "p1" && u.type === "builder");
  const tile = tileAt(g, builder);
  Object.assign(tile, { feature: null, resource: null, farm: false, developed: false, ruin: null });
  return { g, city, builder, tile };
}
const order = (g, u, action) =>
  submitOrders(g, "p1", { turn: g.turn, orders: [{ unitId: u.id, action }] }, 2000);

// ---------------------------------------------------------------- banking
test("idle city banks its per-turn production up to the cap", () => {
  const { g, city } = legacy();
  city.queue = null;
  const rate = economy(g, "p1").perCity.find((c) => c.id === city.id).productionRate;
  assert.ok(rate > 0);
  resolveTurn(g, 2000);
  assert.equal(city.storedProduction, rate);
  city.storedProduction = PRODUCTION_BANK_CAP - 1;
  resolveTurn(g, 130000); // p2 turn
  resolveTurn(g, 200000); // p1 turn again
  assert.equal(city.storedProduction, PRODUCTION_BANK_CAP);
  assert.equal(bankProduction(city, 50), 0);
  assert.equal(city.storedProduction, PRODUCTION_BANK_CAP);
});

test("banked production flows into the next queued item immediately and overflow is re-banked", () => {
  const { g, city } = legacy();
  city.queue = null;
  city.storedProduction = 25;
  submitOrders(g, "p1", { turn: 1, orders: [], production: [{ cityId: city.id, type: "spearman" }] }, 2000);
  assert.equal(city.queue, "spearman");
  assert.equal(city.production, 25);
  assert.equal(city.storedProduction, 0);
  // Completion: cost 20 for a spearman?  Use the real cost and force overflow.
  const cost = productionType("spearman", city).cost;
  city.production = cost + 7; // an instant grant pushed it past the cost
  const rate = economy(g, "p1").perCity.find((c) => c.id === city.id).productionRate;
  const before = g.units.length;
  resolveTurn(g, 2000);
  assert.equal(g.units.length, before + 1, "unit completed");
  assert.equal(city.queue, null);
  assert.equal(city.production, 0);
  // 7 excess re-banked before the clamp, plus this turn's rate as overflow.
  assert.equal(city.storedProduction, Math.min(PRODUCTION_BANK_CAP, 7 + rate));
});

test("wall completion overflow is banked; wall repair never receives the bank", () => {
  const { g, city } = legacy();
  city.queue = "walls";
  city.production = productionType("walls", city).cost;
  const rate = economy(g, "p1").perCity.find((c) => c.id === city.id).productionRate;
  resolveTurn(g, 2000);
  assert.equal(city.wallLevel, 1);
  assert.equal(city.storedProduction, rate);
  city.queue = "wallRepair";
  city.storedProduction = 30;
  assert.equal(applyStoredProduction(city), 0);
  assert.equal(city.storedProduction, 30);
  city.queue = null;
  assert.deepEqual(grantInstantProduction(city, 10), { queued: 0, banked: 10 });
  assert.equal(city.storedProduction, 40);
  city.queue = "spearman";
  city.production = 3;
  assert.deepEqual(grantInstantProduction(city, 10), { queued: 10, banked: 0 });
  assert.equal(city.production, 13);
});

// ---------------------------------------------------------------- world gen
test("world generation places forest and wheat only on plain land, deterministically per seed", () => {
  for (const options of [{ seed: 11 }, { seed: 11, rulesVersion: "expansion-v1" }]) {
    const g = createGame(options);
    const again = createGame(options);
    assert.deepEqual(
      g.tiles.map((t) => t.feature),
      again.tiles.map((t) => t.feature),
    );
    const counts = { forest: 0, wheat: 0, null: 0 };
    for (const t of g.tiles) {
      assert.ok(["forest", "wheat", null].includes(t.feature));
      counts[t.feature] += 1;
      if (t.feature) {
        assert.notEqual(t.terrain, "mountain");
        assert.equal(t.resource, null);
        assert.equal(t.farm, false);
        assert.ok(!g.cities.some((c) => equal(c, t)));
        assert.ok(!t.camp);
      }
      if (t.feature === "wheat") {
        assert.equal(t.terrain, "plains");
        assert.ok(t.fertility >= WHEAT_MIN_FERTILITY);
      }
    }
    const eligible = g.tiles.filter((t) => t.terrain !== "mountain" && !t.resource && !t.farm && !g.cities.some((c) => equal(c, t))).length;
    assert.ok(counts.forest / eligible > FOREST_CHANCE * 0.5 && counts.forest / eligible < FOREST_CHANCE * 1.6, `forest share ${counts.forest}/${eligible}`);
    assert.ok(counts.wheat > 0 && counts.wheat / eligible < WHEAT_CHANCE * 1.6, `wheat share ${counts.wheat}/${eligible}`);
  }
  const a = createGame({ seed: 1 }).tiles.map((t) => t.feature).join();
  const b = createGame({ seed: 2 }).tiles.map((t) => t.feature).join();
  assert.notEqual(a, b);
  assert.equal(rollFeature(5, { q: 1, r: 1, terrain: "mountain", fertility: 0 }), null);
});

test("feature seeding never consumes the shared random stream", () => {
  const g = createGame({ seed: 99 });
  const clone = structuredClone({ ...g, random: undefined });
  seedTileFeatures(clone);
  assert.deepEqual(clone.tiles.map((t) => t.feature), g.tiles.map((t) => t.feature));
  assert.equal(clone.randomState, g.randomState);
});

// ---------------------------------------------------------------- migration
test("old saves without tile features load: owned/improved tiles stay bare, wild land is seeded lazily", () => {
  for (const factory of [() => createGame({ seed: 3 }), () => createGame({ seed: 3, rulesVersion: "expansion-v1" })]) {
    const g = factory();
    const snapshot = JSON.parse(JSON.stringify(g));
    for (const t of snapshot.tiles) delete t.feature;
    for (const c of snapshot.cities) delete c.storedProduction;
    // Mark some improved land the way a turn-50 save would.
    const farmed = snapshot.tiles.find((t) => t.terrain === "plains" && !t.owner && !t.resource);
    farmed.farm = true;
    const developed = snapshot.tiles.find((t) => t.resource && !t.owner);
    developed.developed = true;
    for (const restore of [(s) => restoreGame(s, 5000), (s) => restoreRuntimeGame(s, 5000, 6000)]) {
      const r = restore(snapshot);
      assert.ok(r.tiles.every((t) => t.feature !== undefined));
      for (const t of r.tiles) {
        if (t.owner || t.farm || t.developed || t.resource || t.terrain === "mountain" || r.cities.some((c) => equal(c, t)))
          assert.equal(t.feature, null, `tile ${key(t)} must not gain a feature`);
      }
      assert.equal(tileAt(r, farmed).feature, null);
      assert.equal(tileAt(r, developed).feature, null);
      const wild = r.tiles.filter((t) => !t.owner && t.feature);
      assert.ok(wild.length > 0, "unowned wild land receives features");
      // Deterministic: the same save migrates to the same features.
      const r2 = restore(snapshot);
      assert.deepEqual(r2.tiles.map((t) => t.feature), r.tiles.map((t) => t.feature));
      assert.ok(r.cities.every((c) => c.storedProduction === 0));
      assert.equal(ensureTileFeatures(r), 0, "migration is idempotent");
    }
  }
});

// ---------------------------------------------------------------- actions
test("chop removes the forest, consumes one charge and grants instant production to the nearest own city", () => {
  const { g, city, builder, tile } = legacy();
  tile.feature = "forest";
  city.queue = null;
  city.storedProduction = 0;
  assert.equal(builderFeatureAction(g, builder)?.action, "chop");
  assert.equal(builderFeatureAction(g, builder).cityId, city.id);
  order(g, builder, "chop");
  assert.equal(tile.feature, null);
  assert.equal(builder.charges, 2);
  assert.equal(builder.movesLeft, 0);
  assert.equal(city.storedProduction, CHOP_PRODUCTION);
  assert.ok(g.events.p1.some((e) => e.text.includes(`생산력 +${CHOP_PRODUCTION}`)));
  assert.equal(builderFeatureAction(g, builder), null);
  // With a queue the lump goes straight into the item.
  const { g: g2, city: city2, builder: b2, tile: t2 } = legacy();
  t2.feature = "forest";
  city2.queue = "spearman";
  city2.production = 1;
  order(g2, b2, "chop");
  assert.equal(city2.production, 1 + CHOP_PRODUCTION);
});

test("harvesting wheat grants food and production and leaves a normal farm afterwards", () => {
  const { g, city, builder, tile } = legacy();
  tile.feature = "wheat";
  city.queue = null;
  city.food = 0;
  const before = city.storedProduction ?? 0;
  order(g, builder, "harvest");
  assert.equal(tile.feature, null);
  assert.equal(city.food, HARVEST_FOOD);
  assert.equal(city.growthProgress, HARVEST_FOOD);
  assert.equal(city.storedProduction, before + HARVEST_PRODUCTION);
  assert.equal(farmYield(g, tile).wheat, 0);
});

test("harvesting an undeveloped deposit gives resources and production and removes the deposit for good", () => {
  const { g, city, builder, tile } = legacy();
  tile.resource = "iron";
  city.queue = null;
  const stock = g.stockpiles.p1.iron;
  order(g, builder, "harvest");
  assert.equal(tile.resource, null);
  assert.equal(tile.developed, false);
  assert.equal(g.stockpiles.p1.iron, stock + HARVEST_RESOURCE_AMOUNT);
  assert.equal(city.storedProduction, HARVEST_PRODUCTION);
  assert.equal(observe(g, "p1").tiles.find((t) => equal(t, tile)).resource, null);
  // Developed deposits cannot be harvested.
  const { g: g2, builder: b2, tile: t2 } = legacy();
  t2.resource = "horses";
  t2.developed = true;
  assert.throws(() => order(g2, b2, "harvest"), /자원 시설이 이미 완성/);
});

test("a farm on wheat yields the golden bonus; forest blocks farming until chopped", () => {
  const { g, builder, tile } = legacy();
  tile.feature = "wheat";
  const plain = farmYield(g, { ...tile, feature: null }).total;
  assert.equal(farmYield(g, tile).total, plain + WHEAT_FARM_FOOD_BONUS);
  order(g, builder, "farm");
  assert.equal(tile.farm, true);
  assert.equal(tile.feature, "wheat", "wheat stays under the farm");
  const golden = economy(g, "p1").perCity.find((c) => c.id === "c1").foodGross;
  tile.feature = null;
  const ordinary = economy(g, "p1").perCity.find((c) => c.id === "c1").foodGross;
  assert.equal(golden - ordinary, WHEAT_FARM_FOOD_BONUS);
  const { g: g2, builder: b2, tile: t2 } = legacy();
  t2.feature = "forest";
  assert.throws(() => order(g2, b2, "farm"), /숲을 먼저 베어야/);
  assert.equal(constructionIssue(observe(g2, "p1"), observe(g2, "p1").units.find((u) => u.id === b2.id), "farm"), "숲을 먼저 베어야 농지를 지을 수 있어요.");
});

test("chop/harvest validation errors match the shared UI texts", () => {
  const { g, builder, tile } = legacy();
  const view = () => observe(g, "p1");
  const unit = () => view().units.find((u) => u.id === builder.id);
  assert.throws(() => order(g, builder, "chop"), /벨 숲이 없어요/);
  assert.equal(featureActionIssue(view(), unit(), "chop"), "벨 숲이 없어요.");
  assert.throws(() => order(g, builder, "harvest"), /수확할 밀밭이나/);
  tile.feature = "forest";
  tile.owner = "p2";
  assert.throws(() => order(g, builder, "chop"), /내 영토이거나 내 영토에 인접한 빈 땅/);
  tile.owner = null; // unowned but adjacent to own territory
  assert.equal(featureActionIssue(view(), unit(), "chop"), null);
  order(g, builder, "chop");
  assert.equal(tile.feature, null);
  const spear = g.units.find((u) => u.owner === "p1" && u.type === "spearman");
  assert.throws(() => order(g, spear, "chop"), /건축자를 선택/);
  builder.movesLeft = 1;
  builder.attackUsed = false;
  builder.charges = 0;
  tile.feature = "forest";
  assert.throws(() => order(g, builder, "chop"), /남은 건설 횟수가 없어요/);
  assert.throws(() => order(g, builder, "prune"), /지원하지 않는 명령/);
});

test("observation exposes features on explored tiles only and the banked production on own cities", () => {
  const { g, city, tile } = legacy();
  tile.feature = "forest";
  city.storedProduction = 12;
  const view = observe(g, "p1");
  assert.equal(view.tiles.find((t) => equal(t, tile)).feature, "forest");
  assert.ok(view.tiles.filter((t) => !t.explored).every((t) => t.feature === null));
  assert.equal(view.cities.find((c) => c.id === city.id).storedProduction, 12);
});
