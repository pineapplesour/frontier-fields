import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addUnit, startGame, observe, submitOrders, transact, advanceDue, setSettings, ready, restoreRuntimeGame } from '../server/engine.mjs';
import { canCrossBorder, findRoute, reachable } from '../shared/rules.js';

function fixture() {
  const g = createGame({ mode: 'duel', rulesVersion: 'expansion-v1', turnMode: 'simultaneous', now: 1000,
    seats: [{ id: 'p1', controller: 'human' }, { id: 'p2', controller: 'human' }, { id: 'p3', controller: 'npc' }] });
  g.units = []; g.cities = []; g.rivers = []; g.wars = [];
  for (const t of g.tiles) Object.assign(t, { terrain: 'plains', owner: null, cityId: null, farm: false, resource: null });
  g.players.p2.connected = true;
  addUnit(g, 'p1', 'spearman', {q:4,r:6});
  addUnit(g, 'p2', 'spearman', {q:12,r:6});
  addUnit(g, 'p3', 'settler', {q:8,r:6});
  addUnit(g, 'p3', 'spearman', {q:8,r:7});
  startGame(g, 1000);
  return g;
}
test('NPC founds during countdown, does not advance economy per tick, pauses and restores without refill', () => {
  const g = fixture();
  const direct = g.units.find(u => u.owner === 'p1');
  const before = { q: direct.q, r: direct.r, moves: direct.movesLeft };
  advanceDue(g, 1999);
  assert.equal(g.cities.length, 0);
  advanceDue(g, 2000);
  const city = g.cities.find(c => c.owner === 'p3');
  assert.ok(city, 'founding happened before ready/deadline');
  assert.equal(g.turn, 1);
  const food = city.food, population = city.population;
  advanceDue(g, 3000); advanceDue(g, 4000);
  assert.equal(city.food, food); assert.equal(city.population, population);
  assert.deepEqual({q:direct.q,r:direct.r,moves:direct.movesLeft}, before);
  assert.equal(g.activePlayer, 'p1');
  setSettings(g,'p1',{paused:true},4500);
  const paused=JSON.stringify(g);
  advanceDue(g,9000); assert.equal(JSON.stringify(g),paused);
  const restored=restoreRuntimeGame(JSON.parse(paused),4500,10000);
  assert.equal(restored.paused,true);
  assert.deepEqual(restored.npcPreparedTurns,g.npcPreparedTurns);
});
test('NPC reacts to a newly visible opponent during the same turn, only attacks once', () => {
  const g=fixture();
  g.units=g.units.filter(u=>u.owner!=='p3');
  const npc=addUnit(g,'p3','musketeer',{q:8,r:6});
  g.wars=['p1|p3'];g.stockpiles.p3.niter=8;
  const human=g.units.find(u=>u.owner==='p1');
  advanceDue(g,2000);
  Object.assign(human,{q:npc.q+1,r:npc.r,hp:1});
  advanceDue(g,3000);
  assert.ok(!g.units.some(u=>u.id===human.id),'fresh observation catches the approaching enemy');
  const hp=human.hp,ammo=g.stockpiles.p3.niter;
  advanceDue(g,4000);advanceDue(g,5000);
  assert.equal(human.hp,hp);assert.equal(g.stockpiles.p3.niter,ammo);
  assert.equal(npc.attackUsed,true);
});
test('closed borders reject direct and queued entry; accepted directional deal lasts exactly 30 turns', () => {
  const g=fixture(), u=g.units.find(u=>u.owner==='p1');
  const target=g.tiles.find(t=>t.q===5&&t.r===6); target.owner='p2';
  let view=observe(g,'p1',1100);
  assert.throws(()=>submitOrders(g,'p1',{turn:1,orders:[{unitId:u.id,action:'move',target}]},1100),/국경/);
  assert.equal(findRoute(view,u,target),null);
  assert.equal(reachable(view.tiles,u,view.units,'p1',[]).has('5,6'),false);
  transact(g,'p1',{turn:1,action:'offerDeal',factionId:'p2',give:{gold:30},receive:{openBorders:true}},1200);
  assert.equal(g.openBorders,undefined,'offer alone grants no permission');
  const proposal=g.proposals[0];
  transact(g,'p2',{turn:1,action:'acceptProposal',proposalId:proposal.id},1300);
  assert.equal(g.openBorders['p2>p1'],31); assert.equal(g.openBorders['p1>p2'],undefined);
  assert.equal(observe(g,'p1',1400).factions.find(f=>f.id==='p2').openBordersUntil,31);
  assert.equal(observe(g,'p2',1400).tradeNotices.at(-1).proposal?.receive?.openBorders ??
    observe(g,'p2',1400).tradeNotices.at(-1).receive?.openBorders, true);
  submitOrders(g,'p1',{turn:1,orders:[{unitId:u.id,action:'move',target:{q:5,r:6}}]},1500);
  assert.equal(u.q,5);
  g.turn=30; assert.equal(canCrossBorder(g,u,{q:4,r:6},target),true);
  g.turn=31; assert.equal(canCrossBorder(g,u,{q:4,r:6},target),false);
  assert.equal(canCrossBorder(g,u,u,{q:4,r:6}),true,'expired visitors may leave');
  g.wars=['p1|p2']; assert.equal(canCrossBorder(g,u,{q:4,r:6},target),true);
});
test('reserved route rechecks border after permission expiry', () => {
  const g=fixture(),u=g.units.find(u=>u.owner==='p1');
  g.tiles.find(t=>t.q===5&&t.r===6).owner='p2';
  g.openBorders={'p2>p1':2};u.movesLeft=0;
  submitOrders(g,'p1',{turn:1,orders:[{unitId:u.id,action:'move',target:{q:5,r:6}}]},1100);
  ready(g,'p1',1,1200); ready(g,'p2',1,1300);
  assert.equal(g.turn,2); assert.equal(u.q,4);assert.equal(u.order.blocked,true);
});
test('NPC movement is paced one hex at a time and movement cannot refill mid-round', () => {
  const g=fixture();
  g.units=g.units.filter(u=>u.owner!=='p3');
  const npc=addUnit(g,'p3','spearman',{q:8,r:6});
  let previous={q:npc.q,r:npc.r},budget=4,moved=false;
  for(let time=2000;time<=12000;time+=1000){
    advanceDue(g,time);
    const d=Math.max(Math.abs(npc.q-previous.q),Math.abs(npc.r-previous.r),Math.abs(npc.q+npc.r-previous.q-previous.r));
    assert.ok(d<=1);assert.ok(npc.movesLeft<=budget);moved ||= d>0;
    previous={q:npc.q,r:npc.r};budget=npc.movesLeft;
  }
  assert.ok(moved);assert.equal(g.turn,1);
});
test('mutual grants restore, expire and never expose another pair private contract', () => {
  const g=fixture();
  transact(g,'p1',{turn:1,action:'offerDeal',factionId:'p2',give:{openBorders:true},receive:{openBorders:true}},1100);
  transact(g,'p2',{turn:1,action:'acceptProposal',proposalId:g.proposals[0].id},1200);
  const restored=restoreRuntimeGame(JSON.parse(JSON.stringify(g)),1200,1300);
  assert.deepEqual(restored.openBorders,{'p1>p2':31,'p2>p1':31});
  assert.equal(observe(g,'p3',1300).tradeNotices.length,0);
  const foreign=g.tiles.filter(t=>t.q>=5&&t.q<=7&&t.r>=4&&t.r<=8);
  for(const t of foreign)t.owner='p2';
  g.turn=31;const unit={owner:'p1',q:5,r:6};
  assert.equal(canCrossBorder(g,unit,unit,{q:6,r:6}),false,'no deeper entry after expiry');
  assert.equal(canCrossBorder(g,unit,unit,{q:4,r:6}),true);
});
