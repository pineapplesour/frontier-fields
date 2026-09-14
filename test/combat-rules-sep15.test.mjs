import test from "node:test";
import assert from "node:assert/strict";
import { createGame, addUnit, submitOrders, resolveTurn, restoreGame, observe } from "../server/engine.mjs";
import { level, maxHealth, formationName } from "../shared/rules.js";
import {
  preventMutualDeath,
  unfavorableFight,
  killXp,
  formationTier,
  formationTierName,
  MIN_SURVIVOR_HP,
  COMBAT_XP_PARTICIPATION,
  COMBAT_XP_KILL,
  COMBAT_XP_UNDERDOG_KILL,
  UNDERDOG_STRENGTH_RATIO,
} from "../shared/combat.js";

const command = (g, u, action, extra = {}) => (
  (g.activePlayer = u.owner),
  submitOrders(g, u.owner, { turn: g.turn, orders: [{ unitId: u.id, action, ...extra }] })
);
function field() {
  const g = createGame();
  g.units = [];
  g.wars = ["p1|p2"];
  g.cities = [];
  g.rivers = [];
  g.explored = {};
  for (const t of g.tiles) {
    t.terrain = "plains";
    t.owner = null;
    t.farm = false;
    t.developed = false;
    t.resource = null;
    t.fertility = 2;
  }
  g.random = () => 0.5;
  return g;
}

test("rule constants match the spec: XP 1/3/5, strength ratio 1.5, survivor HP 1", () => {
  assert.equal(COMBAT_XP_PARTICIPATION, 1);
  assert.equal(COMBAT_XP_KILL, 3);
  assert.equal(COMBAT_XP_UNDERDOG_KILL, 5);
  assert.equal(UNDERDOG_STRENGTH_RATIO, 1.5);
  assert.equal(MIN_SURVIVOR_HP, 1);
  assert.equal(killXp(false), 3);
  assert.equal(killXp(true), 5);
});

test("preventMutualDeath keeps the less-overkilled side at 1 HP and ties go to the attacker", () => {
  assert.deepEqual(
    preventMutualDeath({ attackerHp: 10, attackerLoss: 12, defenderHp: 10, defenderLoss: 20 }),
    { attackerLoss: 9, defenderLoss: 20, survivor: "attacker" },
  );
  assert.deepEqual(
    preventMutualDeath({ attackerHp: 10, attackerLoss: 30, defenderHp: 10, defenderLoss: 11 }),
    { attackerLoss: 30, defenderLoss: 9, survivor: "defender" },
  );
  assert.deepEqual(
    preventMutualDeath({ attackerHp: 5, attackerLoss: 8, defenderHp: 5, defenderLoss: 8 }),
    { attackerLoss: 4, defenderLoss: 8, survivor: "attacker" },
  );
  // A one-sided kill is untouched.
  assert.deepEqual(
    preventMutualDeath({ attackerHp: 50, attackerLoss: 8, defenderHp: 5, defenderLoss: 8 }),
    { attackerLoss: 8, defenderLoss: 8, survivor: null },
  );
});

test("melee attack: both sides lethal → exactly one survives with 1 HP (never mutual death)", () => {
  for (const [ahp, dhp] of [[1, 1], [3, 5], [5, 3], [2, 2]]) {
    const g = field();
    const a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: ahp });
    const b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: dhp });
    command(g, a, "attack", { target: { q: 4, r: 2 } });
    resolveTurn(g);
    const alive = g.units.filter((u) => [a.id, b.id].includes(u.id));
    assert.equal(alive.length, 1, `hp ${ahp}/${dhp}: exactly one unit survives`);
    assert.equal(alive[0].hp, 1, "survivor is left at 1 HP");
  }
});

test("melee tie on remaining strength favours the attacker; larger overkill margin loses", () => {
  // Equal spearmen, equal HP, same damage both ways (counter multiplier
  // makes the counter weaker, so the attacker takes less and survives).
  const g = field();
  const a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: 1 });
  const b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: 1 });
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.ok(g.units.includes(a));
  assert.ok(!g.units.includes(b));
  assert.equal(a.hp, 1);
  // Attacker sitting at 1 HP charging a nearly full defender: the defender's
  // remaining strength is far higher, so the defender survives.
  const h = field();
  const c = addUnit(h, "p1", "spearman", { q: 3, r: 2 }, { hp: 1 });
  const d = addUnit(h, "p2", "spearman", { q: 4, r: 2 }, { hp: 60 });
  command(h, c, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(h);
  assert.ok(!h.units.includes(c));
  assert.ok(h.units.includes(d));
  assert.ok(d.hp >= 1);
});

test("counter-attack kills never take the defender with them and award kill XP to the defender", () => {
  const g = field();
  const a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: 2 });
  const b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: 200, size: 2 });
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.ok(!g.units.includes(a), "attacker dies to the counter");
  assert.ok(g.units.includes(b));
  // Defender: +1 participation +3 kill (attacker was a smaller, weaker unit → not an underdog kill).
  assert.equal(b.xp, COMBAT_XP_PARTICIPATION + COMBAT_XP_KILL);
});

test("bombard and ranged fire cannot cause mutual death and grant +1 to both sides", () => {
  const g = field();
  const a = addUnit(g, "p1", "artillery", { q: 3, r: 2 }, { hp: 1 });
  const b = addUnit(g, "p2", "musketeer", { q: 5, r: 2 }, { hp: 1 });
  command(g, a, "bombard", { target: { q: 5, r: 2 } });
  resolveTurn(g);
  assert.ok(g.units.includes(a), "artillery takes no return fire");
  assert.ok(!g.units.includes(b));
  assert.equal(a.xp, COMBAT_XP_PARTICIPATION + COMBAT_XP_KILL);
  const h = field();
  const c = addUnit(h, "p1", "artillery", { q: 3, r: 2 });
  const d = addUnit(h, "p2", "spearman", { q: 5, r: 2 });
  command(h, c, "bombard", { target: { q: 5, r: 2 } });
  resolveTurn(h);
  assert.equal(c.xp, COMBAT_XP_PARTICIPATION);
  assert.equal(d.xp, COMBAT_XP_PARTICIPATION);
  assert.ok(h.units.includes(c) && h.units.includes(d));
});

test("XP: +1 per combat for both, +3 for an even kill, +5 for an underdog kill (strength / counter-type / tier)", () => {
  // Even kill: musketeer vs 1-HP spearman.
  let g = field();
  let a = addUnit(g, "p1", "musketeer", { q: 3, r: 2 });
  let b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: 1 });
  assert.equal(unfavorableFight(g, a, b, true), false);
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(a.xp, 1 + 3);

  // Counter-type: cavalry attacking a spearman (spearman ×1.7 vs cavalry).
  g = field();
  a = addUnit(g, "p1", "cavalry", { q: 3, r: 2 });
  b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: 1 });
  assert.equal(unfavorableFight(g, a, b, true), true);
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(a.xp, 1 + 5);

  // Larger enemy formation: battalion kills a 1-HP brigade.
  g = field();
  a = addUnit(g, "p1", "musketeer", { q: 3, r: 2 });
  b = addUnit(g, "p2", "musketeer", { q: 4, r: 2 }, { hp: 1, size: 2 });
  assert.equal(unfavorableFight(g, a, b, true), true);
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(a.xp, 1 + 5);

  // Strength ratio: a heavily wounded attacker (−40% at 0 HP) vs a fortified defender.
  g = field();
  a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: 20 });
  b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: 100, fortified: true });
  assert.equal(unfavorableFight(g, a, b, true), true, "defender ≥1.5× our strength");
  b.hp = 1;
  b.fortified = true;
  assert.equal(unfavorableFight(g, a, b, true), false, "1-HP defender is no longer 1.5× stronger");

  // Survivor of a would-be mutual death still earns participation and kill XP.
  g = field();
  a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: 1 });
  b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: 1 });
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(a.xp, 1 + 3);
  assert.equal(level(a.xp), 1);
});

test("formation tiers: 1 = 대대, 2 = 여단, 4 = 사단; only 대대+대대 and 여단+여단 merge", () => {
  assert.equal(formationTier(1), "battalion");
  assert.equal(formationTier(2), "brigade");
  assert.equal(formationTier(4), "division");
  assert.equal(formationTier(3), "legacy");
  assert.equal(formationTierName(1), "대대");
  assert.equal(formationTierName(2), "여단");
  assert.equal(formationTierName(4), "사단");
  assert.equal(formationName(1), "대대");
  assert.match(formationName(2), /^여단/);
  assert.match(formationName(4), /^사단/);

  const g = field();
  const a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: 80 });
  const b = addUnit(g, "p1", "spearman", { q: 4, r: 2 }, { hp: 90 });
  assert.equal(a.formation.tier, "battalion");
  command(g, a, "merge", { targetId: b.id });
  resolveTurn(g);
  assert.equal(b.size, 2);
  assert.equal(b.hp, 170);
  assert.equal(maxHealth(b), 200);
  assert.equal(b.formation.tier, "brigade");
  assert.equal(b.formation.manpower, 2);
  assert.deepEqual(b.formation.sourceIds, [b.id, a.id]);

  // 대대 cannot merge into 여단.
  const c = addUnit(g, "p1", "spearman", { q: 3, r: 2 });
  assert.throws(() => command(g, c, "merge", { targetId: b.id }));
  assert.throws(() => command(g, b, "merge", { targetId: c.id }));

  // 여단 + 여단 → 사단.
  const d = addUnit(g, "p1", "spearman", { q: 5, r: 2 }, { size: 2, hp: 150 });
  b.mergedThisTurn = false; b.acted = false; b.movesLeft = 2;
  command(g, b, "merge", { targetId: d.id });
  resolveTurn(g);
  assert.equal(d.size, 4);
  assert.equal(d.hp, 320);
  assert.equal(maxHealth(d), 400);
  assert.equal(d.formation.tier, "division");
  assert.equal(d.formation.manpower, 4);
  // The fixture brigade d was spawned directly (one source id); b carries a and b.
  assert.ok([a.id, b.id, d.id].every((id) => d.formation.sourceIds.includes(id)));

  // 사단 cannot merge further.
  const e = addUnit(g, "p1", "spearman", { q: 4, r: 2 }, { size: 4, hp: 400 });
  d.mergedThisTurn = false; d.acted = false; d.movesLeft = 2;
  assert.throws(() => command(g, d, "merge", { targetId: e.id }));
  assert.throws(() => command(g, e, "merge", { targetId: d.id }));
});

test("legacy saved tier names base/corps migrate to battalion/division", () => {
  const g = field();
  const a = addUnit(g, "p1", "spearman", { q: 3, r: 2 });
  const b = addUnit(g, "p1", "cavalry", { q: 5, r: 2 }, { size: 4, hp: 400 });
  a.formation.tier = "base";
  b.formation.tier = "corps";
  const restored = restoreGame(JSON.parse(JSON.stringify(g)));
  const view = observe(restored, "p1");
  assert.equal(view.units.find((u) => u.id === a.id).formation.tier, "battalion");
  assert.equal(view.units.find((u) => u.id === b.id).formation.tier, "division");
});

test("counter-type advantage deals 2× normal damage, 역상성 deals 0.75×, and counterMultiplier still scales return fire", async () => {
  const { unitDamage, matchupDisadvantage, COUNTER_ADVANTAGE_MULTIPLIER, COUNTER_DISADVANTAGE_MULTIPLIER } = await import("../shared/combat.js");
  const { combatMatchup } = await import("../shared/combat.js");
  assert.equal(COUNTER_ADVANTAGE_MULTIPLIER, 2);
  assert.equal(COUNTER_DISADVANTAGE_MULTIPLIER, 0.75);
  const view = { tiles: [], units: [], cities: [], rivers: [] };
  const mk = (type, owner, q) => ({ type, owner, q, r: 0, hp: 100, size: 1, xp: 0 });
  const spear = mk("spearman", "p1", 0), cav = mk("cavalry", "p2", 1), musk = mk("musketeer", "p2", 1), art = mk("artillery", "p2", 1);
  const neutralCav = { ...cav, type: "cavalry" };
  // Spearman vs cavalry: 2× of what the same spearman would do to a same-defense non-countered target.
  const plainTarget = { ...cav, type: "spearman" }; // spearman defense 25 vs cavalry 21 → compare via matchup fields instead.
  assert.equal(combatMatchup(spear, cav), 2);
  assert.equal(combatMatchup(mk("cavalry", "p1", 0), musk), 2);
  assert.equal(combatMatchup(spear, art), 2);
  assert.equal(matchupDisadvantage(mk("cavalry", "p1", 0), { ...spear, owner: "p2", q: 1 }), 0.75);
  assert.equal(matchupDisadvantage(mk("musketeer", "p1", 0), neutralCav), 0.75);
  assert.equal(matchupDisadvantage(spear, plainTarget), 1);
  // Numeric: spearman→cavalry 54 (= round(27·21/21·2)); cavalry→spearman 20 (= round(27·25/25·0.75)).
  assert.equal(unitDamage(spear, cav, view), 54);
  assert.equal(unitDamage(mk("cavalry", "p1", 0), { ...spear, owner: "p2", q: 1 }, view), 20);
  // Host balance counterMultiplier scales the melee return fire on top.
  const g = field();
  const a = addUnit(g, "p1", "cavalry", { q: 3, r: 2 });
  const b = addUnit(g, "p2", "spearman", { q: 4, r: 2 });
  g.balance = { ...g.balance, counterMultiplier: 0.5 };
  const expectedCounter = Math.round(unitDamage(b, a, g) * 0.5); // 54 × 0.5 = 27
  command(g, a, "attack", { target: { q: 4, r: 2 } });
  resolveTurn(g);
  assert.equal(100 - b.hp, 20, "역상성 attacker deals 0.75× (20)");
  assert.equal(100 - a.hp, expectedCounter, "counter = 2× advantage × counterMultiplier 0.5");
  assert.equal(expectedCounter, 27);
});
