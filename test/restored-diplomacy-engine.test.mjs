import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addUnit, startGame, transact, observe, submitOrders, resolveTurn } from '../server/engine.mjs';

const tx=(g,p,raw)=>transact(g,p,{turn:g.turn,...raw},1100);
function fixture(npc=false) {
 const g=createGame({mode:'duel',rulesVersion:'expansion-v1',turnMode:'simultaneous',now:1000,
 seats:[{id:'p1',controller:'human'},{id:'p2',controller:'human'},{id:'p3',controller:npc?'npc':'human'},{id:'p4',controller:'human'}]});
 g.units=[];g.cities=[];g.rivers=[];g.wars=[];g.alliances={};g.denouncements={};g.peaceUntil={};
 for(const t of g.tiles)Object.assign(t,{terrain:'plains',owner:null,cityId:null,farm:false,developed:false,resource:null});
 for(let i=1;i<=4;i++){g.players[`p${i}`].connected=true;addUnit(g,`p${i}`,'spearman',{q:i*3,r:6});g.gold[`p${i}`]=500;}
 startGame(g,1000);return g;
}
function city(g,id,owner,q,r,extra={}) {
 const c={id,name:id,owner,q,r,hp:160,population:3,food:0,production:0,queue:null,wallLevel:0,wallHp:0,capital:false,...extra};
 g.cities.push(c);Object.assign(g.tiles.find(t=>t.q===q&&t.r===r),{owner,cityId:id});return c;
}

test('engine denunciation before/after three turns changes third-party war penalty',()=>{
 for(const turn of [3,4]) {
 const g=fixture();tx(g,'p1',{action:'denounce',factionId:'p2'});g.turn=turn;
 const before=g.relations['p1|p3']??0;
 tx(g,'p1',{action:'declareWar',factionId:'p2'});
 assert.equal(g.relations['p1|p3']??0,turn===3?before-15:before);
 assert.equal(g.warStarted['p1|p2'],turn);
 }
});

test('engine peace gate covers direct offer, deal offer, and both acceptance actions',()=>{
 const g=fixture();tx(g,'p1',{action:'declareWar',factionId:'p2'});
 const peace={action:'peace',factionId:'p2',gold:40};
 assert.throws(()=>tx(g,'p1',peace),/10턴/);
 assert.throws(()=>tx(g,'p1',{action:'offerDeal',factionId:'p2',peace:true,give:{},receive:{}}),/10턴/);
 g.proposals.push({id:'imported-peace',kind:'peace',from:'p1',to:'p2',gold:40,expires:99});
 for(const action of ['acceptPeace','acceptProposal'])
   assert.throws(()=>tx(g,'p2',{action,proposalId:'imported-peace'}),/10턴/);
 assert.equal(g.gold.p2,500);assert.ok(g.wars.includes('p1|p2'));
 g.proposals=[];g.turn=11;tx(g,'p1',peace);
 const proposal=g.proposals.find(p=>p.kind==='peace');
 tx(g,'p2',{action:'acceptPeace',proposalId:proposal.id});
 assert.ok(!g.wars.includes('p1|p2'));assert.equal(g.warStarted['p1|p2'],undefined);
});

test('direct alliances renew and both offensive/defensive allies enter war',()=>{
 const g=fixture();
 for(const [from,to] of [['p1','p3'],['p2','p4']]) {
 tx(g,from,{action:'alliance',factionId:to});
 tx(g,to,{action:'acceptProposal',proposalId:g.proposals.at(-1).id});
 }
 g.turn=5;tx(g,'p1',{action:'alliance',factionId:'p3'});
 tx(g,'p3',{action:'acceptProposal',proposalId:g.proposals.at(-1).id});
 assert.equal(g.alliances['p1|p3'],15);
 tx(g,'p1',{action:'declareWar',factionId:'p2'});
 for(const key of ['p1|p2','p1|p4','p2|p3','p3|p4'])assert.ok(g.wars.includes(key),key);
});

test('peace recipient can accept the sender-funded escrow even with no gold',()=>{
 for(const action of ['acceptPeace','acceptProposal']) {
  const g=fixture();tx(g,'p1',{action:'declareWar',factionId:'p2'});
  g.turn=11;g.gold.p2=0;
  tx(g,'p1',{action:'peace',factionId:'p2',gold:40});
  const id=g.proposals.at(-1).id;
  tx(g,'p2',{action,proposalId:id});
  assert.equal(g.gold.p1,460);assert.equal(g.gold.p2,40);
  assert.ok(!g.wars.includes('p1|p2'));
  assert.throws(()=>tx(g,'p2',{action,proposalId:id}),/제안/);
 }
});

test('NPC immediate alliance joins an already active war',()=>{
 const g=fixture(true);g.relations['p1|p3']=60;
 tx(g,'p1',{action:'declareWar',factionId:'p2'});
 tx(g,'p1',{action:'alliance',factionId:'p3'});
 assert.equal(g.alliances['p1|p3'],11);assert.ok(g.wars.includes('p2|p3'));
});

test('city demolition checks owner, preserves soldiers and another city land',()=>{
 const g=fixture();const a=city(g,'demolish','p1',4,4),b=city(g,'keep','p1',6,4);
 const own=g.units.find(u=>u.owner==='p1');own.homeCityId=a.id;
 assert.throws(()=>tx(g,'p2',{action:'razeCity',cityId:a.id}),/본인/);
 const otherTile=g.tiles.find(t=>t.q===6&&t.r===4);
 tx(g,'p1',{action:'razeCity',cityId:a.id});
 assert.ok(!g.cities.some(c=>c.id===a.id));assert.ok(g.cities.some(c=>c.id===b.id));
 assert.equal(otherTile.owner,'p1');assert.equal(otherTile.cityId,b.id);
 assert.ok(g.units.some(u=>u.id===own.id));assert.equal(own.homeCityId,null);
});

test('zero-health camp survives then melee movement captures it and pillage cooldown applies',()=>{
 const g=fixture();const home=city(g,'home','p1',3,4);
 const camp=city(g,'camp','barb',4,6,{camp:true,hp:0});
 const u=g.units.find(u=>u.owner==='p1');
 submitOrders(g,'p1',{turn:g.turn,orders:[{unitId:u.id,action:'move',target:{q:4,r:6}}]},1100);
 assert.ok(g.cities.includes(camp));assert.equal(camp.owner,'p1');assert.ok(camp.hp>0);
 const before=g.gold.p1;tx(g,'p1',{action:'pillageCamp',cityId:camp.id,unitId:u.id});
 assert.equal(home.food,20);assert.equal(g.gold.p1,before+20);
 assert.throws(()=>tx(g,'p1',{action:'pillageCamp',cityId:camp.id,unitId:u.id}),/다시/);
 assert.equal(observe(g,'p1',1100).cities.find(c=>c.id===camp.id).campState.canPillage,false);
});
