import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, observe, economy, submitOrders, setCitySettings, resolveTurn, restoreGame } from '../server/engine.mjs';
import { distance, equal, growthHalfTarget } from '../shared/rules.js';

test('legacy cities use population manpower and citizen yields without replacing the game mode', () => {
  const g = createGame({now:1000});
  const city = g.cities.find(c=>c.owner==='p1');
  const before = city.population;
  const view = observe(g,'p1',1000);
  assert.equal(view.rulesVersion,'legacy');
  assert.equal(view.economy.manpowerCost,0.5);
  assert.ok(view.economy.perCity.find(c=>c.id===city.id).citizenAllocation.budget > 0);
  submitOrders(g,'p1',{turn:g.turn,orders:[],production:[{cityId:city.id,type:'builder'}]},1000);
  assert.equal(city.population,before-0.5);
  submitOrders(g,'p1',{turn:g.turn,orders:[],production:[{cityId:city.id,type:null}]},1000);
  assert.equal(city.population,before);
});

test('legacy growth claims the selected connected tile and preserves inherited distant land', () => {
  const g = createGame({now:1000});
  const city = g.cities.find(c=>c.owner==='p1');
  city.citizenPolicy = {auto:false,lockedSlots:[],priority:[]};
  const old = g.tiles.find(t=>!t.owner && distance(t,city)>4);
  Object.assign(old,{owner:'p1',cityId:city.id});
  const view = observe(g,'p1',1000), own = view.cities.find(c=>c.id===city.id);
  assert.ok(own.expansionCandidates.length);
  assert.ok(own.expansionCandidates.every(t=>distance(t,city)<=3));
  const target = own.expansionCandidates.at(-1);
  setCitySettings(g,'p1',{turn:g.turn,cityId:city.id,expansionTarget:target},1000);
  city.food = growthHalfTarget(city.population)-1;
  city.territoryHalfwayClaimed = false;
  assert.ok(economy(g,'p1').perCity.find(c=>c.id===city.id).foodNet>0);
  const before = g.tiles.filter(t=>t.owner==='p1').length;
  resolveTurn(g,1001);
  assert.equal(g.tiles.find(t=>equal(t,target)).owner,'p1');
  assert.equal(g.tiles.filter(t=>t.owner==='p1').length,before+1);
  assert.equal(old.owner,'p1');
  assert.equal(g.rulesVersion,'legacy');
});

test('restoring legacy population rules does not charge existing troops or erase owned territory', () => {
  const g=createGame({now:1000});
  const before=g.cities.map(c=>[c.id,c.population]);
  const land=g.tiles.map(t=>[t.q,t.r,t.owner,t.cityId]);
  const restored=restoreGame(JSON.parse(JSON.stringify(g)),2000);
  assert.deepEqual(restored.cities.map(c=>[c.id,c.population]),before);
  assert.deepEqual(restored.tiles.map(t=>[t.q,t.r,t.owner,t.cityId]),land);
  assert.equal(economy(restored,'p1').manpowerCost,0.5);
});
