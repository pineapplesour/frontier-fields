import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureWarDiplomacy, recordDenouncement, warJustification, peaceIssue,
  applyWarDiplomacy, clearWarRecord, syncAllianceWars } from '../server/warDiplomacy.mjs';
import { handleDeal } from '../server/deals.mjs';

const pair = (a,b) => [a,b].sort().join('|');
function fixture() {
  const ids = ['p1','p2','p3','p4','p5'];
  return {turn:1,wars:[],warStarted:{},relations:{},alliances:{},denouncements:{},peaceUntil:{},
    factions:Object.fromEntries(ids.map(id=>[id,{name:id}])),
    players:Object.fromEntries(ids.map(id=>[id,{controller:'human'}])),
    gold:Object.fromEntries(ids.map(id=>[id,0])), stockpiles:Object.fromEntries(ids.map(id=>[id,{}])),
    proposals:[],units:[],cities:[],tiles:[]};
}
const context = {GameError:Error,event(){},atWar:(g,a,b)=>g.wars.includes(pair(a,b)),relation:()=> 'neutral',announceWar(){}};

test('denouncement waits three turns, expires at ten and only justifies issuer',()=>{
 const g=fixture(); recordDenouncement(g,'p1','p2');
 assert.equal(warJustification(g,'p1','p2').justified,false);
 g.turn=4; assert.equal(warJustification(g,'p1','p2').justified,true);
 assert.equal(warJustification(g,'p2','p1').justified,false);
 g.turn=11; assert.equal(warJustification(g,'p1','p2').justified,false);
 g.territorialCasusBelli={'p1>p2':{reason:'ultimatum-rejected'}};
 assert.equal(warJustification(g,'p1','p2').justified,true);
});

test('formal war preserves third-party relations; surprise penalty occurs only once',()=>{
 const g=fixture();recordDenouncement(g,'p1','p2');g.turn=4;
 applyWarDiplomacy(g,'p1','p2');assert.equal(g.relations['p1|p3'],undefined);
 const surprise=fixture();applyWarDiplomacy(surprise,'p1','p2');
 assert.equal(surprise.relations['p1|p3'],-15);
 applyWarDiplomacy(surprise,'p1','p2');assert.equal(surprise.relations['p1|p3'],-15);
 clearWarRecord(surprise,'p1','p2'); assert.equal(surprise.warStarted['p1|p2'],undefined);
});

test('offensive and defensive allied chains join both sides deterministically',()=>{
 const g=fixture();g.alliances={'p1|p3':11,'p2|p4':11,'p3|p5':11};
 const result=applyWarDiplomacy(g,'p1','p2');
 assert.deepEqual(result.newWars.map(w=>pair(w.from,w.to)).sort(),['p1|p4','p2|p3','p2|p5','p3|p4','p4|p5']);
 for(const war of result.newWars) applyWarDiplomacy(g,war.from,war.to,{reason:'alliance',expandAlliances:false});
 assert.equal(g.wars.length,6);assert.equal(g.relations['p3|p5'],undefined);
 const overlap=fixture();overlap.alliances={'p1|p3':11,'p2|p3':11};
 assert.deepEqual(applyWarDiplomacy(overlap,'p1','p2').brokenAlliances,['p1|p3']);
 const expired=fixture();expired.turn=11;expired.alliances={'p1|p3':11};
 assert.equal(applyWarDiplomacy(expired,'p1','p2').newWars.length,0);
});

test('peace waits ten turns, including proposal and delayed acceptance, preserves escrow on failure',()=>{
 const g=fixture();applyWarDiplomacy(g,'p1','p2');
 const offer={action:'offerDeal',factionId:'p2',peace:true,give:{},receive:{},observation:{units:[],cities:[]}};
 assert.throws(()=>handleDeal(g,'p1',offer,context),/10턴/);assert.equal(g.proposals.length,0);
 g.turn=11;assert.equal(peaceIssue(g,'p1','p2'),null);
 handleDeal(g,'p1',offer,context);const id=g.proposals[0].id;
 g.warStarted['p1|p2']=10;
 assert.throws(()=>handleDeal(g,'p2',{action:'acceptProposal',proposalId:id},context),/10턴/);
 assert.equal(g.proposals.length,1);
 g.warStarted['p1|p2']=1;
 handleDeal(g,'p2',{action:'acceptProposal',proposalId:id},context);
 assert.equal(g.wars.length,0);assert.equal(g.warStarted['p1|p2'],undefined);
});

test('old wars recover public announcement dates and use current turn only when unknown',()=>{
 const g=fixture();g.turn=20;g.wars=['p1|p2','p3|p4'];
 g.announcements=[{type:'war',from:'p2',to:'p1',turn:7}];ensureWarDiplomacy(g);
 assert.equal(g.warStarted['p1|p2'],7);assert.equal(g.warStarted['p3|p4'],20);
 assert.equal(peaceIssue(g,'p1','p2'),null);assert.match(peaceIssue(g,'p3','p4'),/10턴/);
});

test('new alliance joins an existing war without repeating surprise-war penalties',()=>{
 const g=fixture();applyWarDiplomacy(g,'p1','p2');
 const relations=structuredClone(g.relations);
 g.alliances['p1|p3']=g.turn+10;
 const result=syncAllianceWars(g);
 assert.deepEqual(result.newWars,[{from:'p3',to:'p2',reason:'alliance'}]);
 assert.deepEqual(g.relations,relations);
 g.peaceUntil['p2|p3']=100;
 applyWarDiplomacy(g,'p3','p2',{reason:'alliance',expandAlliances:false});
 assert.equal(g.peaceUntil['p2|p3'],undefined);
 assert.deepEqual(g.relations,relations);
});

test('denounced alliance offer and acceptance fail before asset changes; renew extends ten turns',()=>{
 const g=fixture();g.gold.p1=20;
 const offer={action:'offerDeal',factionId:'p2',alliance:true,give:{gold:10},receive:{},observation:{units:[],cities:[]}};
 recordDenouncement(g,'p1','p2');
 assert.throws(()=>handleDeal(g,'p1',offer,context),/비난/);
 assert.equal(g.gold.p1,20);assert.equal(g.proposals.length,0);
 g.turn=11;handleDeal(g,'p1',offer,context);const id=g.proposals[0].id;
 recordDenouncement(g,'p2','p1');
 assert.throws(()=>handleDeal(g,'p2',{action:'acceptProposal',proposalId:id},context),/비난/);
 assert.equal(g.gold.p1,10);assert.equal(g.gold.p2,0);assert.equal(g.proposals.length,1);
 delete g.denouncements['p1|p2'];
 g.alliances['p1|p2']=15;
 handleDeal(g,'p2',{action:'acceptProposal',proposalId:id},context);
 assert.equal(g.alliances['p1|p2'],21);assert.equal(g.gold.p2,10);
});

test('a territorial incident justifies one war and cannot excuse a later surprise war',()=>{
 const g=fixture();g.territorialCasusBelli={'p1>p2':{reason:'ultimatum-rejected'},'p2>p1':{reason:'ultimatum-rejected'}};
 const first=applyWarDiplomacy(g,'p1','p2');assert.equal(first.justified,true);
 assert.equal(g.territorialCasusBelli['p1>p2'],undefined);
 clearWarRecord(g,'p1','p2');g.wars=[];
 assert.equal(g.territorialCasusBelli['p2>p1'],undefined);
 g.turn=20;const second=applyWarDiplomacy(g,'p1','p2');assert.equal(second.justified,false);
 assert.equal(g.relations['p1|p3'],-15);
});
