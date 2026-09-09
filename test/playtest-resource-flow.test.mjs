import test from "node:test";
import assert from "node:assert/strict";
import { createGame, economy, restoreGame } from "../server/engine.mjs";
import { settleAmmunitionUpkeep } from "../server/upkeep.mjs";
import { EXPANSION_START_NITER } from "../shared/rules.js";
import { resourceFlow } from "../src/resourceFlow.js";

test("new expansion seats receive four starting powder rounds equally, never on restore", () => {
  const g = createGame({ mode: "duel", rulesVersion: "expansion-v1", now: 1000,
    seats: [{id:"p1",controller:"human"},{id:"p2",controller:"npc"},{id:"p3",controller:"agent"}] });
  for (const id of ["p1", "p2", "p3"]) {
    assert.equal(g.stockpiles[id].niter, EXPANSION_START_NITER);
    for (let turn = 1; turn <= 4; turn++) {
      g.turn = turn;
      const result = settleAmmunitionUpkeep(g, id);
      assert.equal(result.charged, 2);
      assert.equal(result.shortfall, 0);
    }
    assert.equal(g.stockpiles[id].niter, 0);
  }
  g.stockpiles.p1.niter = 1;
  const restored = restoreGame(JSON.parse(JSON.stringify(g)), 2000);
  assert.equal(restored.stockpiles.p1.niter, 1);
  assert.equal(createGame({ mode:"practice",now:1000 }).stockpiles.p1.niter, 3);
});

test("resource header separates gross production and recurring upkeep without modifying settlement", () => {
  const g = createGame({ mode:"duel", rulesVersion:"expansion-v1", now:1000 });
  const before = g.stockpiles.p1.niter;
  let e = economy(g,"p1");
  assert.equal(e.income.niter, 0);
  assert.equal(e.resourceUpkeep.niter, 2);
  assert.equal(e.netResourceIncome.niter, -2);
  assert.deepEqual(resourceFlow(e,"niter"), {gross:0,upkeep:2,net:-2,signed:"-2"});
  assert.equal(g.stockpiles.p1.niter, before);
  settleAmmunitionUpkeep(g,"p1");
  assert.equal(g.stockpiles.p1.niter, before-2);
  assert.equal(economy(g,"p1").resourceUpkeep.niter, 2, "Recurring rate remains stable after paying this turn");
  g.units.find(u=>u.owner==="p1"&&u.type==="artillery").hp=0;
  g.units.find(u=>u.owner==="p2"&&u.type==="artillery").size=4;
  e=economy(g,"p1");
  assert.equal(e.resourceUpkeep.niter, 1, "Only living own units contribute");
  const legacy=economy(createGame({mode:"practice",now:1000}),"p1");
  assert.equal(legacy.resourceUpkeep.niter,0);
  assert.equal(resourceFlow({income:{iron:1}},"iron").signed,"+1");
});
