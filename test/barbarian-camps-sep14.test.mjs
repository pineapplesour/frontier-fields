import test from 'node:test';
import assert from 'node:assert/strict';
import { captureBarbarianCamp, publicCampState, pillageBarbarianCamp, campSpawnSites } from '../server/barbarianCamps.mjs';

function fixture() {
 const camp={id:'camp',camp:true,owner:'barb',q:2,r:2,hp:0,population:1};
 const city={id:'home',name:'Home',owner:'p1',q:5,r:2,hp:160,food:4};
 const unit={id:'guard',owner:'p1',type:'spearman',q:2,r:2,hp:100};
 const tiles=[];for(let q=0;q<7;q++)for(let r=0;r<6;r++)tiles.push({q,r,terrain:'plains',owner:null});
 Object.assign(tiles.find(t=>t.q===2&&t.r===2),{owner:'barb',cityId:'camp',camp:true});
 return {turn:3,rulesVersion:'expansion-v1',supplyMode:'off',cities:[camp,city],units:[unit],tiles,gold:{p1:0}};
}
test('destroyed camp remains capturable and recapture preserves loot cooldown',()=>{
 const g=fixture(),[camp]=g.cities,unit=g.units[0];
 assert.equal(captureBarbarianCamp(g,camp,{...unit,type:'artillery'}),false);
 assert.equal(captureBarbarianCamp(g,camp,unit),true);
 assert.equal(camp.owner,'p1');assert.ok(camp.hp>0);assert.equal(camp.camp,true);
 assert.equal(g.tiles.filter(t=>t.owner==='p1').length,1);
 pillageBarbarianCamp(g,'p1',{cityId:camp.id,unitId:unit.id});
 camp.owner='barb';camp.hp=0;assert.equal(captureBarbarianCamp(g,camp,unit),true);
 assert.equal(publicCampState(g,camp,'p1').canPillage,false);
});
test('pillage credits the selected ledger once and rejects cooldown/dead/moved troop atomically',()=>{
 for(const supplyMode of ['off','on']) {
 const g=fixture();g.supplyMode=supplyMode;const[camp,home]=g.cities,unit=g.units[0];
 captureBarbarianCamp(g,camp,unit);
 const raw={cityId:camp.id,unitId:unit.id};
 assert.equal(publicCampState(g,camp,'p1').canPillage,true);
 pillageBarbarianCamp(g,'p1',raw);
 assert.equal(home.food,24);assert.equal(g.gold.p1,20);
 assert.equal(home.growthProgress,supplyMode==='off'?24:undefined);
 assert.throws(()=>pillageBarbarianCamp(g,'p1',raw),/다시/);
 g.turn=13;unit.hp=0;assert.throws(()=>pillageBarbarianCamp(g,'p1',raw),/살아/);
 unit.hp=100;unit.q++;assert.throws(()=>pillageBarbarianCamp(g,'p1',raw),/살아/);
 assert.equal(home.food,24);unit.q--;
 pillageBarbarianCamp(g,'p1',raw);assert.equal(home.food,44);assert.equal(g.gold.p1,40);
 }
});
test('occupied camps still spawn around neutral land, never owned or occupied tiles',()=>{
 const g=fixture(),camp=g.cities[0];captureBarbarianCamp(g,camp,g.units[0]);
 let sites=campSpawnSites(g);assert.equal(sites.length,1);
 assert.notDeepEqual({q:sites[0].q,r:sites[0].r},{q:camp.q,r:camp.r});
 for(const t of g.tiles)t.owner='p1';assert.deepEqual(campSpawnSites(g),[]);
 const tile=g.tiles.find(t=>t.q===3&&t.r===2);tile.owner=null;
 g.units.push({id:'other',owner:'barb',type:'spearman',hp:100,q:3,r:2});
 assert.deepEqual(campSpawnSites(g),[]);
 g.units.pop();tile.terrain='mountain';assert.deepEqual(campSpawnSites(g),[]);
});
