import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, economy, farmYield } from '../server/engine.mjs';
import { citizenSlots } from '../server/economy.mjs';

function fixture() {
  const g = createGame({ mode: 'duel', rulesVersion: 'expansion-v1', now: 1000 });
  g.units = []; g.cities = []; g.rivers = [];
  for (const t of g.tiles) Object.assign(t, { terrain: 'plains', fertility: 2,
    owner: null, cityId: null, farm: false, resource: null, developed: false, ruin: null });
  const city = { id: 'hill-test', owner: 'p1', q: 4, r: 6, population: 4, food: 0,
    production: 0, queue: 'spearman', hp: 160, isolation: 0,
    citizenPolicy: { auto: false, lockedSlots: [], priority: [] } };
  g.cities.push(city);
  Object.assign(g.tiles.find(t => t.q === 4 && t.r === 6), { owner: 'p1', cityId: city.id });
  const tile = g.tiles.find(t => t.q === 5 && t.r === 6);
  Object.assign(tile, { owner: 'p1', cityId: city.id, farm: true });
  return { g, city, tile };
}

test('hill farm exchanges one food for production, retaining fertility and adjacency', () => {
  const { g, city, tile } = fixture();
  const adjacent = g.tiles.find(t => t.q === 5 && t.r === 5);
  Object.assign(adjacent, { farm: true, owner: 'p1', cityId: city.id });
  const flat = farmYield(g, tile);
  tile.terrain = 'hills';
  const hill = farmYield(g, tile);
  assert.equal(hill.total, flat.total - 1);
  assert.equal(hill.adjacent, flat.adjacent);
  assert.equal(hill.fertility, flat.fertility);
  assert.equal(hill.production, 1);
  const slot = citizenSlots(g, city).find(s => s.q === tile.q && s.r === tile.r);
  assert.equal(slot.baseYield, hill.total);
  assert.equal(slot.baseProduction, 1);
  adjacent.farm = false; tile.fertility = 0;
  assert.equal(farmYield(g, tile).total, 0);
});

test('only functioning owned hill farms contribute city production, once per farm', () => {
  const { g, tile } = fixture();
  const flat = economy(g, 'p1');
  tile.terrain = 'hills';
  const hill = economy(g, 'p1');
  assert.equal(hill.production, flat.production + 1);
  assert.equal(hill.foodNet, flat.foodNet - 1);
  tile.ruin = { kind: 'farm' };
  const ruined = economy(g, 'p1');
  assert.equal(ruined.production, flat.production);
  tile.ruin = null; tile.owner = 'p2';
  assert.equal(economy(g, 'p1').production, flat.production);
});
