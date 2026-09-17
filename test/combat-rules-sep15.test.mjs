import test from "node:test";
import assert from "node:assert/strict";
import { createGame, addUnit, submitOrders, resolveTurn, restoreGame, observe } from "../server/engine.mjs";
import { level, maxHealth, formationName, TYPES } from "../shared/rules.js";
import { combatPreview } from "../shared/combat.js";
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
  UNDERDOG_STRENGTH_GAP,
  CIV6,
  civDamage,
  unitExchange,
  cityExchange,
  strengthBreakdown,
  cityStrength,
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

test("rule constants match the spec: XP 1/3/5, underdog gap 10 CS, survivor HP 1", () => {
  assert.equal(COMBAT_XP_PARTICIPATION, 1);
  assert.equal(COMBAT_XP_KILL, 3);
  assert.equal(COMBAT_XP_UNDERDOG_KILL, 5);
  assert.equal(UNDERDOG_STRENGTH_GAP, 10);
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

  // Strength gap: a wounded attacker (−8 CS at 20 HP) vs a fortified defender (+6) → 14 CS behind.
  g = field();
  a = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { hp: 20 });
  b = addUnit(g, "p2", "spearman", { q: 4, r: 2 }, { hp: 100, fortified: true });
  assert.equal(unfavorableFight(g, a, b, true), true, "defender ≥10 CS above us");
  b.hp = 1;
  b.fortified = true;
  assert.equal(unfavorableFight(g, a, b, true), false, "a 1-HP defender (−10 CS) is no longer 10 CS ahead");

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
  // Civ6: HP is not pooled; the merged unit keeps the healthier HP and 100 max.
  assert.equal(b.hp, 90);
  assert.equal(maxHealth(b), 100);
  assert.equal(b.formation.tier, "brigade");
  assert.equal(b.formation.manpower, 2);
  assert.deepEqual(b.formation.sourceIds, [b.id, a.id]);

  // 대대 cannot merge into 여단.
  const c = addUnit(g, "p1", "spearman", { q: 3, r: 2 });
  assert.throws(() => command(g, c, "merge", { targetId: b.id }));
  assert.throws(() => command(g, b, "merge", { targetId: c.id }));

  // 여단 + 여단 → 사단.
  const d = addUnit(g, "p1", "spearman", { q: 5, r: 2 }, { size: 2, hp: 70 });
  b.mergedThisTurn = false; b.acted = false; b.movesLeft = 2;
  command(g, b, "merge", { targetId: d.id });
  resolveTurn(g);
  assert.equal(d.size, 4);
  assert.equal(d.hp, 90);
  assert.equal(maxHealth(d), 100);
  assert.equal(d.formation.tier, "division");
  assert.equal(d.formation.manpower, 4);
  // The fixture brigade d was spawned directly (one source id); b carries a and b.
  assert.ok([a.id, b.id, d.id].every((id) => d.formation.sourceIds.includes(id)));

  // 사단 cannot merge further.
  const e = addUnit(g, "p1", "spearman", { q: 4, r: 2 }, { size: 4, hp: 100 });
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

test("Civ6 formula: 30·e^(Δ/25)·roll; equal CS → 30, +10 → 45 dealt / 20 taken; modifiers are additive CS", () => {
  assert.equal(civDamage(30, 30, 1), 30);
  assert.equal(civDamage(40, 30, 1), 45); // 30·e^0.4 = 44.75
  assert.equal(civDamage(30, 40, 1), 20); // 30·e^−0.4 = 20.11
  assert.equal(civDamage(30, 30, CIV6.ROLL_MIN), 23);
  assert.equal(civDamage(30, 30, CIV6.ROLL_MAX), 38);
  const view = { tiles: [], units: [], cities: [], rivers: [] };
  const mk = (type, owner, q, r = 0, extra = {}) => ({ id: `${type}${q},${r}`, type, owner, q, r, hp: 100, size: 1, xp: 0, ...extra });
  // Melee units use one CS both ways (spearman 21 vs spearman 21 → 30 each way).
  let a = mk("spearman", "p1", 0), b = mk("spearman", "p2", 1);
  let x = unitExchange({ ...view, units: [a, b] }, a, b);
  assert.deepEqual([x.attacker.total, x.defender.total, x.dealt, x.received, x.melee], [21, 21, 30, 30, true]);
  // Anti-cavalry +10 vs cavalry; melee +5 vs anti-cavalry.
  b = mk("cavalry", "p2", 1);
  x = unitExchange({ ...view, units: [a, b] }, a, b);
  assert.deepEqual([x.attacker.total, x.defender.total], [31, 30]);
  x = unitExchange({ ...view, units: [a, b] }, b, a);
  assert.deepEqual([x.attacker.total, x.defender.total], [30, 31]);
  // Ranged: musketeer fires with 28, takes no return fire; defends with 22.
  a = mk("musketeer", "p1", 0); b = mk("spearman", "p2", 2);
  x = unitExchange({ ...view, units: [a, b] }, a, b);
  assert.deepEqual([x.attacker.total, x.dealt, x.received, x.melee], [28, 40, 0, false]);
  assert.equal(strengthBreakdown(a, true, view, b).total, 22);
  // Artillery −17 vs units.
  a = mk("artillery", "p1", 0);
  assert.equal(strengthBreakdown(a, false, view, b).total, 17);
  // Wounded: −10 CS at 0 HP, linear (50 HP → −5).
  a = mk("spearman", "p1", 0, 0, { hp: 50 });
  assert.equal(strengthBreakdown(a, false, view, null).total, 16);
  // Fortified +6, hills +3, fort/encampment +4 handled by structures; river −5; recent crossing −3.
  b = mk("spearman", "p2", 1, 0, { fortified: true });
  const hills = { ...view, tiles: [{ q: 1, r: 0, terrain: "hills" }], units: [b] };
  assert.equal(strengthBreakdown(b, true, hills, null).total, 30);
  const river = { ...view, rivers: [{ a: { q: 0, r: 0 }, b: { q: 1, r: 0 } }], units: [] };
  assert.equal(strengthBreakdown(mk("spearman", "p1", 0), false, river, { q: 1, r: 0, type: "spearman" }).total, 16);
  assert.equal(strengthBreakdown(mk("spearman", "p1", 0, 0, { riverTurns: 2 }), false, view, null).total, 18);
  // Flanking +2 per other friendly adjacent to the target; support +2 per friendly adjacent to the defender.
  a = mk("spearman", "p1", 0); b = mk("spearman", "p2", 1);
  const ally = mk("cavalry", "p1", 1, -1), friend = mk("cavalry", "p2", 2, -1);
  x = unitExchange({ ...view, units: [a, b, ally, friend] }, a, b);
  assert.ok(x.attacker.terms.some((t) => t.label.startsWith("측면") && t.value === 2));
  assert.ok(x.defender.terms.some((t) => t.label.startsWith("지원") && t.value === 2));
  // Host counterMultiplier still scales melee return fire.
  x = unitExchange({ ...view, units: [a, b], balance: { counterMultiplier: 0.5 } }, a, b);
  assert.equal(x.received, 15);
});

test("Civ6 formations: 여단 +10 CS, 사단 +17 CS, 100 HP not pooled; pooled saves migrate proportionally", () => {
  const view = { tiles: [], units: [], cities: [], rivers: [] };
  const corps = { id: "c", type: "spearman", owner: "p1", q: 0, r: 0, hp: 100, size: 2, xp: 0 };
  const army = { ...corps, id: "d", size: 4 };
  assert.equal(strengthBreakdown(corps, false, view, null).total, 31);
  assert.equal(strengthBreakdown(army, false, view, null).total, 38);
  assert.equal(maxHealth(corps), 100);
  assert.equal(maxHealth(army), 100);
  // Migration: a saved brigade at 150/200 pooled HP becomes 75/100 once.
  const g = field();
  const legacy = addUnit(g, "p1", "spearman", { q: 3, r: 2 }, { size: 2 });
  legacy.hp = 150;
  delete legacy.formation;
  const snapshot = JSON.parse(JSON.stringify(g));
  const restored = restoreGame(snapshot);
  const migrated = restored.units.find((u) => u.id === legacy.id);
  assert.equal(migrated.hp, 75);
  assert.equal(migrated.formation.hpModel, "civ6");
  // Restoring again must not halve it a second time.
  const twice = restoreGame(JSON.parse(JSON.stringify(restored))).units.find((u) => u.id === legacy.id);
  assert.equal(twice.hp, 75);
});

test("Civ6 walls: wall HP 100/200/300, melee 15% / ranged 50% / bombard 100% vs walls, ranged 40% vs city HP, city CS = max(garrison, own), heal 20", () => {
  const view = { tiles: [], units: [], cities: [], rivers: [] };
  const city = { id: "c", owner: "p2", q: 1, r: 0, hp: 160, wallLevel: 2, wallHp: 100, population: 4 };
  assert.equal(CIV6.WALL_HP_PER_LEVEL, 100);
  assert.equal(CIV6.WALL_CS_PER_LEVEL, 5);
  assert.equal(CIV6.CITY_HEAL_PER_TURN, 20);
  // Own CS: 20 + 3·pop + 5·wallLevel = 20 + 12 + 10 = 42.
  assert.equal(cityStrength(view, city), 42);
  const garrison = { id: "g", type: "spearman", owner: "p2", q: 1, r: 0, hp: 100, size: 4, xp: 0 };
  assert.equal(cityStrength({ ...view, units: [garrison] }, city), 42); // walls still lead: 21 + 17 = 38
  garrison.fortified = true; // 44 > 42
  assert.equal(cityStrength({ ...view, units: [garrison] }, city), 44);
  const mk = (type) => ({ id: type, type, owner: "p1", q: 0, r: 0, hp: 100, size: 1, xp: 0 });
  const melee = cityExchange(view, mk("spearman"), city);
  const ranged = cityExchange(view, mk("musketeer"), city);
  const bombard = cityExchange(view, mk("artillery"), city);
  assert.equal(melee.wallDamage, Math.max(1, Math.round(melee.raw * 0.15)));
  assert.equal(ranged.wallDamage, Math.round(ranged.raw * 0.5));
  assert.equal(bombard.wallDamage, Math.round(bombard.raw * 1));
  assert.equal(melee.bodyDamage + ranged.bodyDamage + bombard.bodyDamage, 0, "walls take everything while standing");
  assert.ok(melee.received > 0 && ranged.received === 0 && bombard.received === 0, "only adjacent melee takes the city's return blow");
  const open = { ...city, wallHp: 0 };
  const rangedOpen = cityExchange(view, mk("musketeer"), open);
  const meleeOpen = cityExchange(view, mk("spearman"), open);
  assert.equal(rangedOpen.wallDamage, 0);
  assert.equal(rangedOpen.bodyDamage, Math.round(rangedOpen.raw * 0.4));
  assert.equal(meleeOpen.bodyDamage, meleeOpen.raw);
  // No single hit can exceed the pool it lands on.
  assert.ok(bombard.wallDamage <= 100);
});

test("preview == resolution for the same roll across a matrix of melee, ranged, city and formation cases", () => {
  const cases = [
    ["spearman", "spearman", {}, {}],
    ["spearman", "cavalry", {}, { fortified: true }],
    ["cavalry", "spearman", { size: 2 }, {}],
    ["musketeer", "spearman", {}, { hp: 40 }],
    ["artillery", "cavalry", {}, { size: 4 }],
    ["spearman", "artillery", { hp: 30 }, {}],
  ];
  for (const [ta, tb, xa, xb] of cases) {
    for (const r of [0, 0.5, 1]) {
      const g = field();
      const range = TYPES[ta].range;
      const a = addUnit(g, "p1", ta, { q: 3, r: 2 }, xa);
      const b = addUnit(g, "p2", tb, { q: 3 + range, r: 2 }, xb);
      g.tiles.find((t) => t.q === b.q && t.r === b.r).terrain = "hills";
      g.random = () => r;
      const roll = CIV6.ROLL_MIN + r * (CIV6.ROLL_MAX - CIV6.ROLL_MIN);
      const expected = unitExchange(g, a, b, { attackRoll: roll, counterRoll: roll });
      const preview = combatPreview(observe(g, "p1"), a, { ...b, hostile: true });
      const before = { a: a.hp, b: b.hp };
      command(g, a, TYPES[ta].range > 1 && ta === "artillery" ? "bombard" : "attack", { target: { q: b.q, r: b.r } });
      resolveTurn(g);
      const dealt = Math.min(before.b, expected.dealt), received = Math.min(before.a, expected.received);
      const resolved = preventMutualDeath({ attackerHp: before.a, attackerLoss: received, defenderHp: before.b, defenderLoss: dealt });
      assert.equal(before.b - Math.max(0, b.hp), Math.min(before.b, resolved.defenderLoss), `${ta}->${tb} r=${r} dealt`);
      assert.equal(before.a - Math.max(0, a.hp), Math.min(before.a, resolved.attackerLoss), `${ta}->${tb} r=${r} received`);
      // The hover forecast brackets the resolved roll and its strengths match.
      assert.ok(preview.dealtBounds[0] <= expected.dealt && expected.dealt <= preview.dealtBounds[1]);
      assert.equal(preview.attack, expected.attacker.total);
      assert.equal(preview.defense, expected.defender.total);
    }
  }
  // City: preview bounds bracket the resolved wall/body damage.
  const g = field();
  const city = { id: "c1", name: "성", owner: "p2", q: 5, r: 2, hp: 160, wallLevel: 1, wallHp: 50, population: 3, attackUsed: false, queue: null };
  g.cities.push(city);
  const art = addUnit(g, "p1", "artillery", { q: 3, r: 2 });
  g.random = () => 0.5;
  const preview = combatPreview(observe(g, "p1"), art, { ...city, hostile: true });
  const exp = cityExchange(g, art, city);
  command(g, art, "bombard", { target: { q: 5, r: 2 } });
  resolveTurn(g);
  assert.equal(50 - city.wallHp, exp.wallDamage);
  assert.ok(preview.wallDamage[0] <= exp.wallDamage && exp.wallDamage <= preview.wallDamage[1]);
});

test("ranged fire cannot cross a mountain: artillery, musketeer range-2 and city wall fire are blocked; far-side mountains and single-hex ties do not block", async () => {
  const { hexLineCandidates, mountainBlocksLine, rangedTargetIssue, combatPreview, RANGED_MOUNTAIN_BLOCK_MESSAGE } = await import("../shared/combat.js");
  const { equal, TYPES } = await import("../shared/rules.js");
  const tile = (g, p) => g.tiles.find((t) => equal(t, p));
  assert.equal(RANGED_MOUNTAIN_BLOCK_MESSAGE, "산에 가려 사격할 수 없어요.");

  // Straight line (3,2)→(5,2): the single middle hex is (4,2).
  assert.deepEqual(hexLineCandidates({ q: 3, r: 2 }, { q: 5, r: 2 }), [[{ q: 4, r: 2 }]]);
  // Line exactly between two hexes: (3,2)→(4,3) passes between (3,3) and (4,2).
  const tie = hexLineCandidates({ q: 3, r: 2 }, { q: 4, r: 3 });
  assert.equal(tie.length, 1);
  assert.equal(tie[0].length, 2);
  assert.ok(tie[0].some((p) => equal(p, { q: 3, r: 3 })) && tie[0].some((p) => equal(p, { q: 4, r: 2 })));
  // Adjacent shots have no interior hex.
  assert.deepEqual(hexLineCandidates({ q: 3, r: 2 }, { q: 4, r: 2 }), []);

  // Artillery: blocked by a middle mountain, illegal at order time and in preview.
  let g = field();
  let a = addUnit(g, "p1", "artillery", { q: 3, r: 2 });
  let b = addUnit(g, "p2", "spearman", { q: 5, r: 2 });
  tile(g, { q: 4, r: 2 }).terrain = "mountain";
  assert.equal(mountainBlocksLine(g, a, b), true);
  assert.equal(rangedTargetIssue(g, a, b), RANGED_MOUNTAIN_BLOCK_MESSAGE);
  assert.throws(() => command(g, a, "bombard", { target: { q: 5, r: 2 } }), /산에 가려 사격할 수 없어요/);
  const preview = combatPreview(observe(g, "p1"), a, { ...b, hostile: true });
  assert.equal(preview.legal, false);
  assert.ok(preview.reasons.includes(RANGED_MOUNTAIN_BLOCK_MESSAGE));
  // A mountain adjacent to the target on the far side does not block.
  tile(g, { q: 4, r: 2 }).terrain = "plains";
  tile(g, { q: 6, r: 2 }).terrain = "mountain";
  assert.equal(mountainBlocksLine(g, a, b), false);
  command(g, a, "bombard", { target: { q: 5, r: 2 } });
  resolveTurn(g);
  assert.ok(b.hp < 100, "clear line: bombard lands");

  // Musketeer range-2 fire is blocked the same way; adjacent fire is not.
  g = field();
  a = addUnit(g, "p1", "musketeer", { q: 3, r: 2 });
  b = addUnit(g, "p2", "spearman", { q: 5, r: 2 });
  tile(g, { q: 4, r: 2 }).terrain = "mountain";
  assert.equal(TYPES.musketeer.range, 2);
  assert.throws(() => command(g, a, "attack", { target: { q: 5, r: 2 } }), /산에 가려/);
  b.q = 4; b.r = 3; // adjacent to (3,2)
  command(g, a, "attack", { target: { q: 4, r: 3 } });

  // Tie: (3,2)→(4,3) is blocked only when BOTH (3,3) and (4,2) are mountains.
  g = field();
  a = addUnit(g, "p1", "artillery", { q: 3, r: 2 });
  b = addUnit(g, "p2", "spearman", { q: 4, r: 3 });
  tile(g, { q: 4, r: 2 }).terrain = "mountain";
  assert.equal(mountainBlocksLine(g, a, b), false);
  tile(g, { q: 3, r: 3 }).terrain = "mountain";
  assert.equal(mountainBlocksLine(g, a, b), true);

  // City wall fire (cityBombard) respects the same rule.
  g = field();
  const city = { id: "c1", name: "성", owner: "p1", q: 3, r: 2, hp: 100, wallLevel: 1, wallHp: 40, population: 3, attackUsed: false, queue: null };
  g.cities.push(city);
  b = addUnit(g, "p2", "spearman", { q: 5, r: 2 });
  tile(g, { q: 4, r: 2 }).terrain = "mountain";
  g.activePlayer = "p1";
  assert.throws(
    () => submitOrders(g, "p1", { turn: g.turn, orders: [{ cityId: "c1", action: "cityBombard", target: { q: 5, r: 2 } }] }),
    /산에 가려/,
  );
  tile(g, { q: 4, r: 2 }).terrain = "plains";
  submitOrders(g, "p1", { turn: g.turn, orders: [{ cityId: "c1", action: "cityBombard", target: { q: 5, r: 2 } }] });
  resolveTurn(g);
  assert.ok(b.hp < 100, "clear line: city fire lands");
});
