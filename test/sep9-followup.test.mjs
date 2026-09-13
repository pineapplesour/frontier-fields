import test from "node:test";
import assert from "node:assert/strict";
import {createGame,addUnit,observe,submitOrders,startGame,ready,advanceDue} from "../server/engine.mjs";
import {approachCombatPreview,combatPreview,combatStrength} from "../shared/combat.js";
import {equal} from "../shared/rules.js";

function field(){
  const g=createGame({mode:"practice"});g.units=[];g.cities=[];g.rivers=[];g.wars=["p1|p2"];
  for(const t of g.tiles)Object.assign(t,{terrain:"plains",owner:null,cityId:null});
  return g;
}
test("distant cavalry UI forecasts adjacent retaliation without making the order legal",()=>{
  const g=field(),a=addUnit(g,"p1","cavalry",{q:5,r:5}),b=addUnit(g,"p2","spearman",{q:7,r:5});
  const view=observe(g,"p1"),ua=view.units.find(u=>u.id===a.id),ub=view.units.find(u=>u.id===b.id);
  const before=JSON.stringify(view),preview=approachCombatPreview(view,ua,ub);
  assert.equal(preview.legal,false);assert.ok(preview.approachFrom);assert.ok(preview.received[0]>0);
  assert.equal(JSON.stringify(view),before);
  const adjacent={...ua,...preview.approachFrom};
  const actual= combatPreview({...view,units:view.units.map(u=>u.id===a.id?adjacent:u)},adjacent,ub);
  assert.deepEqual(preview.received,actual.received);
});
test("ranged combat keeps its real distance instead of inventing a melee counterattack",()=>{
  for(const type of ["musketeer","artillery"]){
    const g=field(),a=addUnit(g,"p1",type,{q:5,r:5}),b=addUnit(g,"p2","spearman",{q:7,r:5});
    const view=observe(g,"p1"),p=approachCombatPreview(view,view.units.find(u=>u.id===a.id),view.units.find(u=>u.id===b.id));
    assert.deepEqual(p.received,[0,0]);assert.equal(p.approachFrom,undefined);
  }
});
test("half health lowers attack by 20 percent and names the injury penalty in preview",()=>{
  const g=field(),a=addUnit(g,"p1","cavalry",{q:5,r:5}),b=addUnit(g,"p2","spearman",{q:6,r:5});
  const full=combatStrength(a,false,g,b);a.hp=50;
  assert.equal(combatStrength(a,false,g,b),full*0.8);
  assert.ok(combatPreview(g,a,b).reasons.some(r=>r.includes("공격력 −20%")));
});
test("founding a city on hills consumes the settler without flattening the tile",()=>{
  const g=field(),s=addUnit(g,"p1","settler",{q:5,r:5});
  const tile=g.tiles.find(t=>equal(t,s));tile.terrain="hills";
  submitOrders(g,"p1",{turn:g.turn,orders:[{unitId:s.id,action:"found"}]});
  assert.ok(g.cities.some(c=>equal(c,s)&&c.owner==="p1"));assert.equal(tile.terrain,"hills");
  assert.ok(!g.units.some(u=>u.id===s.id));
});
test("simultaneous NPC countdown executes actual attacks without external-seat authority",()=>{
  const g=createGame({mode:"duel",rulesVersion:"expansion-v1",turnMode:"simultaneous",now:1000,
    seats:[{id:"p1",controller:"human"},{id:"p2",controller:"human"},{id:"p3",controller:"npc"}]});
  g.units=[];g.cities=[];g.rivers=[];g.wars=["p1|p3"];g.players.p2.connected=true;
  for(const t of g.tiles)Object.assign(t,{terrain:"plains",owner:null,cityId:null});
  addUnit(g,"p1","settler",{q:1,r:1});addUnit(g,"p2","settler",{q:18,r:1});
  const a=addUnit(g,"p3","spearman",{q:5,r:5}),b=addUnit(g,"p1","spearman",{q:6,r:5},{hp:1});
  startGame(g,1100);
  assert.throws(()=>submitOrders(g,"p3",{turn:1,orders:[{unitId:a.id,action:"attack",target:{q:6,r:5}}]},1200),/상대 턴/);
  advanceDue(g,2100);
  assert.ok(!g.units.some(u=>u.id===b.id));assert.equal(g.turn,1);
  ready(g,"p1",1,2200);ready(g,"p2",1,2300);
  assert.ok(!g.units.some(u=>u.id===b.id));assert.equal(a.attackUsed,true);
  assert.equal(g.internalNpc,false);assert.equal(g.turn,2);
});
