import test from "node:test";
import assert from "node:assert/strict";
import {createGame,addUnit,submitOrders,observe,transact,resolveTurn} from "../server/engine.mjs";
import {damageTotal} from "../src/combatPresentation.js";
import {buildWorld,terrainHeight,disposeGroup} from "../src/world3d.js";
import {equal} from "../shared/rules.js";

function fixture(cities = false) {
  const g=createGame({mode:"practice",experiment:true});g.units=[];g.rivers=[];g.wars=["p1|p2"];
  if(!cities)g.cities=[];
  for(const t of g.tiles)Object.assign(t,{terrain:"plains",owner:null,cityId:null});
  g.random=()=>0.5;return g;
}
const attack=(g,u,target)=>submitOrders(g,"p1",{turn:g.turn,orders:[{unitId:u.id,action:"attack",target:{q:target.q,r:target.r}}]});

test("cavalry-versus-spearman counter damage receipt equals actual HP loss even without animation ownership",()=>{
  const g=fixture();const a=addUnit(g,"p1","cavalry",{q:5,r:5});const b=addUnit(g,"p2","spearman",{q:6,r:5});
  const hp=a.hp;const view=attack(g,a,b);assert.ok(a.hp<hp);
  assert.equal(damageTotal(view.effects,"p1",true),hp-Math.max(0,a.hp));
  const withoutOwner=view.effects.map(e=>e.kind==="damage"?{...e,unit:undefined}:e);
  assert.equal(damageTotal(withoutOwner,"p1",true),hp-Math.max(0,a.hp));
});
test("only surviving spear/cavalry advance after a lethal adjacent hit; muskets and artillery stay",()=>{
  for(const type of ["spearman","cavalry","musketeer","artillery"]){
    const g=fixture();const a=addUnit(g,"p1",type,{q:5,r:5});const b=addUnit(g,"p2","spearman",{q:6,r:5});b.hp=1;
    attack(g,a,b);assert.ok(b.hp<=0);
    assert.equal(a.q,["spearman","cavalry"].includes(type)?6:5);
  }
});
test("friendly target rejection consumes neither attack, movement nor resources",()=>{
  const g=fixture();const a=addUnit(g,"p1","cavalry",{q:5,r:5});const b=addUnit(g,"p1","spearman",{q:6,r:5});
  const before=JSON.stringify({hp:a.hp,moves:a.movesLeft,attack:a.attackUsed,stock:g.stockpiles.p1});
  assert.throws(()=>attack(g,a,b),/아군/);
  assert.equal(JSON.stringify({hp:a.hp,moves:a.movesLeft,attack:a.attackUsed,stock:g.stockpiles.p1}),before);
});
test("second reserved attacker preserves its opportunity after first captures the target city",()=>{
  const g=fixture(true);const c=g.cities.find(c=>c.owner==="p2");Object.assign(c,{q:6,r:5,hp:1,wallLevel:0,wallHp:0});
  const a=addUnit(g,"p1","cavalry",{q:5,r:5});const b=addUnit(g,"p1","spearman",{q:6,r:4});
  submitOrders(g,"p1",{turn:g.turn,orders:[a,b].map(u=>({unitId:u.id,action:"attack",target:{q:c.q,r:c.r}}))});
  assert.equal(c.owner,"p1");assert.equal(b.attackUsed,false);assert.equal(b.movesLeft,4);assert.equal(b.order,null);
});
test("city active bombard inflicts twice the former deterministic damage",()=>{
  const g=fixture(true);const c=g.cities.find(c=>c.owner==="p1");Object.assign(c,{q:5,r:5,hp:160,wallLevel:1,wallHp:50});
  const d=addUnit(g,"p2","spearman",{q:6,r:5});
  submitOrders(g,"p1",{turn:g.turn,orders:[{cityId:c.id,action:"cityBombard",target:{q:d.q,r:d.r}}]});
  assert.equal(d.hp,78);
});
test("garrison actor stays on the tile ground; label stacking must not lift the model",()=>{
  const g=fixture(true);const city=g.cities.find(c=>c.owner==="p1");const u=addUnit(g,"p1","spearman",city);
  const view=observe(g,"p1");const scene=buildWorld(view);const actor=scene.userData.actors.get(u.id);
  const tile=view.tiles.find(t=>equal(t,u));assert.equal(actor.origin.y,terrainHeight(tile));
  disposeGroup(scene);
});

test("civilian capture enters its tile without spending an attack and allows further movement",()=>{
  const g=fixture(true);const a=addUnit(g,"p1","cavalry",{q:5,r:5});const b=addUnit(g,"p2","builder",{q:6,r:5});
  const moves=a.movesLeft, attacks=a.attacksLeft;
  attack(g,a,b);
  assert.equal(b.owner,"p1");assert.ok(equal(a,b));assert.equal(a.attackUsed,false);
  assert.equal(a.attacksLeft,attacks);assert.equal(a.movesLeft,moves-1);
  submitOrders(g,"p1",{turn:g.turn,orders:[{unitId:a.id,action:"move",target:{q:7,r:5},path:[{q:7,r:5}]}]});
  assert.equal(a.q,7);
});

test("a civilization without cities AND units is eliminated but retains read-only spectator access",()=>{
  const g=fixture(true);g.cities=g.cities.filter(c=>c.owner!=="p2");
  const a=addUnit(g,"p1","cavalry",{q:5,r:5});const b=addUnit(g,"p2","builder",{q:6,r:5});
  attack(g,a,b);
  const view=observe(g,"p2");assert.equal(view.spectator,true);assert.equal(view.eliminated,true);
  assert.ok(view.units.some(u=>u.id===a.id));
  assert.throws(()=>submitOrders(g,"p2",{turn:g.turn,orders:[]}),/관전/);
  assert.throws(()=>transact(g,"p2",{turn:g.turn,action:"buyUnit",type:"builder"}),/관전/);
  assert.equal(observe(g,"p1").eliminated,false);
});

test("generated barbarian camps never overlap another city or foreign territory",()=>{
  for(const rulesVersion of ["legacy","expansion-v1"]){
    const g=createGame({mode:"practice",rulesVersion});
    for(const c of g.cities.filter(c=>c.camp)){
      assert.equal(g.tiles.find(t=>equal(t,c)).owner,"barb");
      assert.equal(g.cities.filter(other=>equal(other,c)).length,1);
      assert.ok(!g.units.some(u=>u.owner!=="barb"&&equal(u,c)));
    }
  }
});

test("automatic barbarian reinforcements use only neutral or barbarian land beside occupied camps",()=>{
  for(const owner of ["p1","barb"]){
    const g=createGame({mode:"practice"});g.activePlayer="p2";g.turn=4;
    g.units=g.units.filter(u=>u.owner!=="barb");
    for(const c of g.cities.filter(c=>c.camp))g.tiles.find(t=>equal(t,c)).owner=owner;
    resolveTurn(g);
    const spawned=g.units.filter(u=>u.owner==="barb");
    assert.ok(spawned.length>0);
    assert.ok(spawned.every(u=>[null,"barb"].includes(g.tiles.find(t=>equal(t,u)).owner)));
    if(owner==="p1")assert.ok(spawned.every(u=>!g.cities.some(c=>c.camp&&equal(c,u))),"No spawn on a player-owned camp center");
  }
});
