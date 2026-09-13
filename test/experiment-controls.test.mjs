import test from "node:test";
import assert from "node:assert/strict";
import { createGame, addUnit, transact, submitOrders, observe, resolveTurn, startGame, restoreRuntimeGame } from "../server/engine.mjs";
import { editExperiment, resetUnitActions } from "../server/experiment.mjs";
import { maxHealth, unitMovement, equal } from "../shared/rules.js";
import { unitDamage, jointAttackPenalty, combatPreview } from "../shared/combat.js";
import { ensureAmmunition, settleAmmunitionUpkeep } from "../server/upkeep.mjs";

function fixture(experiment = true) {
  const g = createGame({ mode: "practice", experiment });
  g.units = []; g.cities = []; g.rivers = []; g.wars = ["p1|p2"];
  g.random = () => 0.5;
  for (const t of g.tiles) Object.assign(t, { terrain: "plains", owner: null, cityId: null });
  return g;
}
const edit = (g, u, scope, values) => transact(g, "p1", { action: "experimentEdit", turn: g.turn, unitId: u.id, scope, values });

test("guarded civilian cannot be captured through its military escort, regardless of insertion order", () => {
  for (const reverse of [false, true]) {
    const g = fixture();
    const civilian = addUnit(g, "p1", "builder", { q: 5, r: 5 });
    const guard = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
    const attacker = addUnit(g, "barb", "spearman", { q: 6, r: 5 });
    if (reverse) g.units.reverse();
    g.activePlayer = "barb";
    submitOrders(g, "barb", { turn: g.turn, orders: [{ action: "attack", unitId: attacker.id, target: { q: 5, r: 5 } }] });
    assert.equal(civilian.owner, "p1");
    assert.equal(civilian.hp, 100);
    assert.ok(guard.hp < 100);
  }
});

test("unescorted civilians remain capturable under ordinary combat rules", () => {
  const g = fixture(false);
  const civilian = addUnit(g, "p1", "builder", { q: 5, r: 5 });
  const attacker = addUnit(g, "barb", "spearman", { q: 6, r: 5 });
  g.activePlayer = "barb";
  submitOrders(g, "barb", { turn: g.turn, orders: [{ action: "attack", unitId: attacker.id, target: civilian }] });
  assert.equal(civilian.owner, "barb");
});

test("temporary and permanent per-unit stats expire/persist and type defaults reach new units", () => {
  const g = fixture();
  const a = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
  const b = addUnit(g, "p2", "spearman", { q: 7, r: 5 });
  edit(g, a, "type", { movement: 9, maxHealth: 180, attacks: 2 });
  assert.equal(maxHealth(b), 180);
  assert.equal(b.hp, 180);
  edit(g, a, "unit", { movement: 12 });
  edit(g, a, "temporary", { movement: 20, attack: 99 });
  assert.equal(unitMovement(a), 20);
  resetUnitActions(g, a);
  assert.equal(unitMovement(a), 12);
  assert.equal(a.experimentStats.attack, undefined);
  const c = addUnit(g, "p1", "spearman", { q: 9, r: 5 });
  assert.equal(c.movesLeft, 9); assert.equal(c.hp, 180); assert.equal(c.attacksLeft, 2);
  edit(g, a, "unit", { maxHealth: 80 });
  assert.equal(a.hp, 80);
  assert.equal(observe(g, "p1").units.find(u => u.id === a.id).experimentStats.movement, 12);
});

test("extra attacks actually execute at zero movement, exhaust, and reset to permanent allowance", () => {
  const g = fixture();
  const a = addUnit(g, "p1", "musketeer", { q: 5, r: 5 });
  const b = addUnit(g, "p2", "spearman", { q: 7, r: 5 }, { size: 4, hp: 400 });
  edit(g, a, "unit", { attacks: 2 });
  edit(g, a, "current", { attacksLeft: 3, movesLeft: 0 });
  for (let i = 0; i < 3; i++) {
    const hp = b.hp;
    submitOrders(g, "p1", { turn: g.turn, orders: [{ action: "attack", unitId: a.id, target: b }] });
    assert.ok(b.hp < hp);
  }
  assert.equal(a.attackUsed, true);
  assert.throws(() => submitOrders(g, "p1", { turn: g.turn, orders: [{ action: "attack", unitId: a.id, target: b }] }));
  resetUnitActions(g, a); assert.equal(a.attacksLeft, 2);
});

test("granting current movement after an attack permits real movement without restoring attacks", () => {
  const g = fixture(); const u = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
  u.attackUsed = true; u.attacksLeft = 0; u.movesLeft = 0;
  edit(g, u, "current", { movesLeft: 3 });
  submitOrders(g, "p1", { turn: g.turn, orders: [{ action: "move", unitId: u.id, target: { q: 6, r: 5 } }] });
  assert.equal(u.q, 6); assert.equal(u.movesLeft, 2); assert.equal(u.attackUsed, true);
});

test("paused host can edit experiment without advancing time; shots never charge resources", () => {
  const g = fixture(); const u = addUnit(g, "p1", "musketeer", { q: 5, r: 5 });
  g.paused = true;
  edit(g, u, "unit", { attacks: 3 });
  assert.equal(g.paused, true); assert.equal(g.turn, 1);
  transact(g, "p1", { action: "experimentCosts", turn: g.turn, upkeep: false, attack: true });
  g.stockpiles.p1.niter = 2;
  assert.equal(ensureAmmunition(g, u).charged, 0);
  assert.equal(ensureAmmunition(g, u).charged, 0);
  assert.equal(ensureAmmunition(g, u).ready, true);
  assert.equal(settleAmmunitionUpkeep(g, "p1").charged, 0);
});

test("experiment resource costs default off, toggles take effect, ordinary matches retain upkeep", () => {
  for (const experiment of [true, false]) {
    const g = fixture(experiment);
    const a = addUnit(g, "p1", "musketeer", { q: 5, r: 5 });
    g.stockpiles.p1.niter = 0;
    assert.equal(ensureAmmunition(g, a).ready, true);
    assert.equal(settleAmmunitionUpkeep(g, "p1").shortfall, experiment ? 0 : 1);
    if (experiment) {
      editExperiment(g, { action: "experimentCosts", upkeep: true, attack: true });
      assert.equal(ensureAmmunition(g, a).ready, true);
      g.stockpiles.p1.niter = 2;
      assert.equal(settleAmmunitionUpkeep(g, "p1").charged, 1);
      assert.equal(ensureAmmunition(g, a).charged, 0);
    }
  }
});

test("experiment editing rejects non-hosts, ordinary matches and invalid fields atomically", () => {
  const g = fixture(); const u = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
  assert.throws(() => edit(g, u, "unit", { movement: 20, owner: "barb" }));
  assert.equal(unitMovement(u), 4); assert.equal(u.owner, "p1");
  assert.throws(() => transact(g, "p2", { action: "experimentCosts", turn: g.turn, upkeep: false, attack: false }));
  const normal = fixture(false); const v = addUnit(normal, "p1", "spearman", { q: 5, r: 5 });
  assert.throws(() => edit(normal, v, "unit", { movement: 20 }));
});

test("runtime restart preserves experiment overrides, remaining actions and resource switches", () => {
  const g = fixture(); const u = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
  edit(g, u, "type", { attack: 77 });
  edit(g, u, "unit", { movement: 12, attacks: 4 });
  edit(g, u, "temporary", { defense: 88 });
  edit(g, u, "current", { attacksLeft: 2 });
  const restored = restoreRuntimeGame(JSON.parse(JSON.stringify(g)), Date.now(), Date.now());
  const v = restored.units.find(x => x.id === u.id);
  assert.equal(v.experimentStats.attack, 77); assert.equal(v.experimentStats.defense, 88);
  assert.equal(v.attacksLeft, 2); assert.equal(v.movesLeft, 12);
  assert.deepEqual(observe(restored, "p1").experimentCosts, { upkeep: false, attack: false });
  resetUnitActions(restored, v);
  assert.equal(v.experimentStats.defense, undefined); assert.equal(v.attacksLeft, 4);
});

test("joint attack counts distinct adjacent military positions and matches public preview", () => {
  const g = fixture(); const a = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
  const b = addUnit(g, "p2", "spearman", { q: 6, r: 5 });
  const before = unitDamage(a, b, g);
  addUnit(g, "p1", "builder", { q: 6, r: 4 });
  assert.equal(jointAttackPenalty(g, b, a).penalty, 0);
  addUnit(g, "p1", "spearman", { q: 6, r: 4 });
  assert.equal(jointAttackPenalty(g, b, a).penalty, 0.1);
  assert.ok(unitDamage(a, b, g) > before);
  const view = observe(g, "p1");
  const preview = combatPreview(view, view.units.find(u => u.id === a.id), view.units.find(u => u.id === b.id));
  assert.ok(preview.reasons.some(reason => reason.includes("합동공격")));
  edit(g, b, "unit", { jointPenalty: 0 });
  assert.equal(unitDamage(a, b, g), before);
});
