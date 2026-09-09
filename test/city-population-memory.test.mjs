import test from "node:test";
import assert from "node:assert/strict";
import {createGame,addUnit,observe,restoreRuntimeGame} from "../server/engine.mjs";

test("enemy population is current in sight, frozen in memory, and refreshed on rediscovery",()=>{
  const g=createGame({mode:"practice"});
  const city=g.cities.find(c=>c.owner==="p2");
  g.units=[];g.cities=[city];g.cityContacts={};g.explored={};g.reveals={};
  const scout=addUnit(g,"p1","cavalry",{q:0,r:0});
  assert.ok(!observe(g,"p1").cityContacts.some(c=>c.id===city.id));
  Object.assign(scout,{q:city.q-1,r:city.r});city.population=4.5;
  let v=observe(g,"p1");assert.equal(v.cities.find(c=>c.id===city.id).population,4.5);
  assert.ok(!v.cityContacts.some(c=>c.id===city.id));
  Object.assign(scout,{q:0,r:0});g.turn++;city.population=8;
  v=observe(g,"p1");assert.ok(!v.cities.some(c=>c.id===city.id));
  let memory=v.cityContacts.find(c=>c.id===city.id);
  assert.equal(memory.population,4.5);assert.equal(memory.lastSeenTurn,1);assert.equal(memory.ghost,true);
  const restored=restoreRuntimeGame(JSON.parse(JSON.stringify(g)),1000,2000);
  assert.equal(observe(restored,"p1").cityContacts.find(c=>c.id===city.id).population,4.5);
  Object.assign(scout,{q:city.q-1,r:city.r});g.turn++;
  v=observe(g,"p1");assert.equal(v.cities.find(c=>c.id===city.id).population,8);
  Object.assign(scout,{q:0,r:0});city.population=10;
  memory=observe(g,"p1").cityContacts.find(c=>c.id===city.id);
  assert.equal(memory.population,8);assert.equal(memory.lastSeenTurn,3);
});

test("old unseen city memories without population are not backfilled from hidden live state",()=>{
  const g=createGame({mode:"practice"});const city=g.cities.find(c=>c.owner==="p2");
  g.units=[];g.cities=[city];g.reveals={};g.cityContacts={p1:{[city.id]:{id:city.id,owner:city.owner,name:city.name,q:city.q,r:city.r,lastSeenTurn:1}}};
  assert.equal(observe(g,"p1").cityContacts.find(c=>c.id===city.id).population,undefined);
});
