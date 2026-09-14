import test from "node:test";
import assert from "node:assert/strict";
import {
  addUnit,
  createGame,
  observe,
  restoreGame,
  resolveTurn,
  setSettings,
  submitOrders,
  transact,
} from "../server/engine.mjs";
import { notifyTrade } from "../server/notifications.mjs";
import {
  equal,
  reachable,
  routeSchedule,
  movementCost,
  TYPES,
  maxHealth,
} from "../shared/rules.js";
import { combatPreview, combatStrength, hasLineOfSight } from "../shared/combat.js";

const field = () => {
  const g = createGame({ now: 1_000 });
  Object.assign(g, {
    units: [],
    cities: [],
    rivers: [],
    wars: ["p1|p2"],
    warStarted: { "p1|p2": g.turn - 10 },
    activePlayer: "p1",
    deadline: null,
    practicePassAt: null,
  });
  for (const t of g.tiles)
    Object.assign(t, {
      terrain: "plains",
      owner: null,
      cityId: null,
      farm: false,
      developed: false,
      resource: null,
      fort: null,
      fertility: 2,
    });
  g.random = () => 0.5;
  // These diplomacy/combat fixtures model living civilizations. Keep one
  // remote civilian per seat so an empty test board does not mean extinction.
  for (const [index, owner] of ["p1", "p2", "p3", "p4"].entries())
    addUnit(g, owner, "builder", {q:18, r:7-index}, {movesLeft:0});
  return g;
};
const order = (g, player, unitId, action, extra = {}) =>
  submitOrders(g, player, {
    turn: g.turn,
    orders: [{ unitId, action, ...extra }],
  });
const trade = (g, player, action, extra = {}) =>
  transact(g, player, { turn: g.turn, action, ...extra });

test("opponent-turn routes queue without spending state and execute in request order", () => {
  const g = field();
  assert.equal(observe(g, "p1").capabilities.resourceConversion, true);
  const first = addUnit(g, "p2", "spearman", { q: 5, r: 3 });
  const second = addUnit(g, "p2", "spearman", { q: 3, r: 3 });
  const before = JSON.stringify({
    first: { q: first.q, r: first.r, movesLeft: first.movesLeft, attackUsed: first.attackUsed },
    second: { q: second.q, r: second.r, movesLeft: second.movesLeft, attackUsed: second.attackUsed },
    effects: g.effects,
    events: g.events,
  });

  // Queue the right-hand unit first. The left-hand unit requests the same
  // destination and must lose the collision when the next own turn starts.
  order(g, "p2", first.id, "move", {
    target: { q: 4, r: 3 },
    path: [{ q: 4, r: 3 }],
  });
  order(g, "p2", second.id, "move", {
    target: { q: 4, r: 3 },
    path: [{ q: 4, r: 3 }],
  });
  assert.deepEqual(
    JSON.stringify({
      first: { q: first.q, r: first.r, movesLeft: first.movesLeft, attackUsed: first.attackUsed },
      second: { q: second.q, r: second.r, movesLeft: second.movesLeft, attackUsed: second.attackUsed },
      effects: g.effects,
      events: g.events,
    }),
    before,
  );
  assert.equal(first.order.queued, true);
  assert.ok(first.order.sequence < second.order.sequence);

  resolveTurn(g, 2_000);
  assert.equal(g.activePlayer, "p2");
  assert.ok(equal(first, { q: 4, r: 3 }));
  assert.ok(equal(second, { q: 3, r: 3 }));
  assert.ok(g.effects.p2.some((effect) => effect.kind === "move" && effect.unitId === first.id));
  assert.equal(first.attackUsed, false);
  assert.equal(first.movesLeft, TYPES.spearman.movement - 1);
});

test("owned iron and niter deposits support farm-to-mine conversion with builder MP", () => {
  const g = field();
  // Per-city yield needs a real owning city, not an orphaned national tile.
  g.cities.push({ id: "mine-city", name: "광산 도시", owner: "p1", q: 2, r: 3, population: 1, hp: 160, food: 0, production: 0, queue: null, isolation: 0, wallLevel: 0 });
  Object.assign(g.tiles.find(t => t.q === 2 && t.r === 3), { owner: "p1", cityId: "mine-city" });
  const builder = addUnit(g, "p1", "builder", { q: 3, r: 3 });
  const deposit = g.tiles.find((t) => equal(t, builder));
  Object.assign(deposit, { owner: "p1", cityId: "mine-city", resource: "iron", farm: true });
  order(g, "p1", builder.id, "develop");
  assert.equal(deposit.developed, true);
  assert.equal(deposit.farm, false);
  assert.equal(builder.charges, 2);
  assert.equal(builder.movesLeft, 0);
  assert.equal(observe(g, "p1").economy.income.iron, 1);

  const niterBuilder = addUnit(g, "p1", "builder", { q: 4, r: 3 });
  const niterDeposit = g.tiles.find((t) => equal(t, niterBuilder));
  Object.assign(niterDeposit, { owner: "p1", cityId: "mine-city", resource: "niter" });
  order(g, "p1", niterBuilder.id, "develop");
  assert.equal(niterDeposit.developed, true);
  assert.equal(niterBuilder.movesLeft, 0);
  assert.equal(observe(g, "p1").economy.income.niter, 1);

  const blocked = field();
  const noMp = addUnit(
    blocked,
    "p1",
    "builder",
    { q: 3, r: 3 },
    { movesLeft: 0 },
  );
  const niter = blocked.tiles.find((t) => equal(t, noMp));
  Object.assign(niter, { owner: "p1", resource: "niter", farm: true });
  assert.throws(() => order(blocked, "p1", noMp.id, "develop"));
  assert.equal(niter.developed, false);
  assert.equal(niter.farm, true);
  assert.equal(noMp.charges, 3);
});

test("opponent-turn cancellation and non-route commands do not mutate the game", () => {
  const g = field();
  const u = addUnit(g, "p2", "spearman", { q: 3, r: 3 });
  order(g, "p2", u.id, "move", {
    target: { q: 5, r: 3 },
    path: [{ q: 4, r: 3 }, { q: 5, r: 3 }],
  });
  const before = JSON.stringify({ q: u.q, r: u.r, movesLeft: u.movesLeft, attackUsed: u.attackUsed, effects: g.effects });
  order(g, "p2", u.id, "cancel");
  assert.equal(u.order, null);
  assert.equal(JSON.stringify({ q: u.q, r: u.r, movesLeft: u.movesLeft, attackUsed: u.attackUsed, effects: g.effects }), before);
  resolveTurn(g, 2_000);
  assert.ok(equal(u, { q: 3, r: 3 }));

  const enemy = addUnit(g, "p1", "spearman", { q: 4, r: 3 });
  for (const body of [
    { orders: [{ unitId: u.id, action: "attack", target: { q: enemy.q, r: enemy.r } }] },
    { orders: [{ unitId: u.id, action: "farm" }] },
    { production: [{ cityId: "missing", type: "builder" }] },
  ])
    assert.throws(() => submitOrders(g, "p1", { turn: g.turn, ...body }));
});

test("pause blocks queued commands and any-turn transactions while own-turn actions stay immediate", () => {
  const g = field();
  const p1 = addUnit(g, "p1", "spearman", { q: 3, r: 3 });
  const p2 = addUnit(g, "p2", "spearman", { q: 7, r: 3 });
  order(g, "p1", p1.id, "move", { target: { q: 4, r: 3 }, path: [{ q: 4, r: 3 }] });
  assert.ok(equal(p1, { q: 4, r: 3 }));
  g.activePlayer = "p2";
  setSettings(g, "p1", { paused: true }, 2_000);
  assert.throws(() => order(g, "p1", p1.id, "move", { target: { q: 5, r: 3 }, path: [{ q: 5, r: 3 }] }));
  assert.throws(() => trade(g, "p1", "sell", { resource: "iron", amount: 1 }));
  resolveTurn(g, 9_999);
  assert.equal(g.paused, true);
  assert.equal(p2.q, 7);
  assert.equal(JSON.stringify({ q: p2.q, r: p2.r, movesLeft: p2.movesLeft, attackUsed: p2.attackUsed }), JSON.stringify({ q: 7, r: 3, movesLeft: TYPES.spearman.movement, attackUsed: false }));
});

test("market and diplomacy work off-turn, while unilateral war and land actions remain own-turn", () => {
  const g = field();
  g.activePlayer = "p2";
  const beforeGold = g.gold.p1;
  trade(g, "p1", "sell", { resource: "iron", amount: 1 });
  assert.equal(g.gold.p1, beforeGold + 7);
  for (const action of ["declareWar", "denounce", "buyTile"])
    assert.throws(() =>
      trade(g, "p1", action, {
        factionId: "p2",
        cityId: "missing",
        target: { q: 0, r: 0 },
      }),
    );

  g.wars = [];
  const requestedBefore = observe(g, "p1").tradeNotices.length;
  trade(g, "p1", "offerTrade", { factionId: "p2", resource: "iron", amount: 1, gold: 7 });
  const proposal = g.proposals.at(-1);
  assert.equal(proposal.kind, "trade");
  assert.equal(observe(g, "p1").tradeNotices.at(-1).status, "requested");
  assert.equal(observe(g, "p2").tradeNotices.at(-1).status, "requested");
  assert.equal(observe(g, "p3").tradeNotices.length, 0);
  trade(g, "p2", "acceptProposal", { proposalId: proposal.id });
  assert.equal(observe(g, "p1").tradeNotices.at(-1).status, "accepted");
  assert.equal(observe(g, "p1").tradeNotices.length, requestedBefore + 2);

  g.wars = ["p1|p2"];
  const goldBeforePeace = g.gold.p1;
  trade(g, "p1", "peace", { factionId: "p2", gold: 10 });
  const peace = g.proposals.at(-1);
  assert.equal(peace.kind, "peace");
  trade(g, "p2", "rejectPeace", { proposalId: peace.id });
  assert.equal(observe(g, "p1").tradeNotices.at(-1).status, "rejected");
  assert.equal(g.gold.p1, goldBeforePeace);
});

test("deal and legacy outcomes are durable, private, capped, and atomic on invalid acceptance", () => {
  const g = field();
  g.activePlayer = "p2";
  g.wars = [];
  const tradedUnit = addUnit(g, "p1", "spearman", { q: 3, r: 3 });
  trade(g, "p1", "offerDeal", {
    factionId: "p2",
    give: { gold: 1, units: [tradedUnit.id] },
    receive: {},
  });
  const deal = g.proposals.at(-1);
  assert.equal(observe(g, "p1").tradeNotices.at(-1).status, "requested");
  assert.equal(observe(g, "p2").tradeNotices.at(-1).status, "requested");
  tradedUnit.owner = "p3";
  assert.throws(() => trade(g, "p2", "acceptProposal", { proposalId: deal.id }));
  assert.equal(g.proposals.at(-1).id, deal.id);
  assert.equal(observe(g, "p1").tradeNotices.filter((n) => n.proposal.id === deal.id).length, 1);

  trade(g, "p2", "rejectProposal", { proposalId: deal.id });
  assert.equal(observe(g, "p1").tradeNotices.at(-1).status, "rejected");

  // NPC immediate acceptance has no proposal row, but still has a bilateral
  // status transition. A valid NPC refusal is also represented as rejected.
  trade(g, "p1", "offerDeal", { factionId: "p3", give: { gold: 1 }, receive: {} });
  assert.equal(observe(g, "p1").tradeNotices.at(-1).status, "accepted");
  trade(g, "p1", "offerDeal", { factionId: "p3", give: {}, receive: { resources: { iron: 2 } } });
  assert.equal(observe(g, "p1").tradeNotices.at(-1).status, "rejected");
  const invalidCount = observe(g, "p1").tradeNotices.length;
  assert.throws(() =>
    trade(g, "p1", "offerTrade", { factionId: "p2", resource: "iron", amount: 99, gold: 1 }),
  );
  assert.equal(observe(g, "p1").tradeNotices.length, invalidCount);

  const visibleUnit = addUnit(g, "p1", "spearman", { q: 5, r: 5 });
  const privateUnit = addUnit(g, "p3", "spearman", { q: 6, r: 5 });
  const synthetic = {
    id: "notice-test",
    kind: "deal",
    from: "p1",
    to: "p2",
    give: {
      units: [visibleUnit.id, privateUnit.id],
      resources: { iron: 1 },
    },
    receive: {},
    labels: {
      [visibleUnit.id]: "보이는 병력",
      [privateUnit.id]: "private",
      secret: "private",
    },
    assets: {
      [visibleUnit.id]: { type: "spearman", hp: 100 },
      [privateUnit.id]: { type: "spearman", hp: 100 },
      secret: { hp: 999 },
    },
    privateInventory: { p3: { iron: 999 } },
  };
  const thirdPartyBefore = observe(g, "p3").tradeNotices.length;
  for (let i = 0; i < 31; i++) notifyTrade(g, { ...synthetic, id: `notice-${i}` }, "requested");
  const notices = observe(g, "p1").tradeNotices;
  assert.equal(notices.length, 30);
  assert.equal(notices.at(-1).proposal.labels[visibleUnit.id], "보이는 병력");
  assert.equal(notices.at(-1).proposal.labels[privateUnit.id], undefined);
  assert.equal(notices.at(-1).proposal.labels.secret, undefined);
  assert.equal(notices.at(-1).proposal.assets[visibleUnit.id].hp, 100);
  assert.equal(notices.at(-1).proposal.assets[privateUnit.id], undefined);
  assert.equal(notices.at(-1).proposal.privateInventory, undefined);
  assert.equal(observe(g, "p3").tradeNotices.length, thirdPartyBefore);
});

test("NPC trade, alliance, peace, and rejection outcomes notify only both parties", () => {
  const g = field();
  g.relations["p1|p3"] = 30;

  trade(g, "p1", "offerTrade", {
    factionId: "p3",
    resource: "iron",
    amount: 1,
    gold: 1,
  });
  trade(g, "p1", "alliance", { factionId: "p3" });
  g.wars.push("p1|p3");
  g.warStarted["p1|p3"] = g.turn - 10;
  trade(g, "p1", "peace", { factionId: "p3", gold: 40 });
  trade(g, "p1", "offerTrade", {
    factionId: "p3",
    resource: "iron",
    amount: 1,
    gold: 100,
  });

  const p1Statuses = g.tradeNotices.p1.map((notice) => notice.status);
  const p3Statuses = g.tradeNotices.p3.map((notice) => notice.status);
  assert.deepEqual(p1Statuses, ["accepted", "accepted", "accepted", "rejected"]);
  assert.deepEqual(p3Statuses, p1Statuses);
  assert.equal(g.tradeNotices.p2.length, 0);
  assert.equal(g.wars.includes("p1|p3"), false);
});

test("invalid peace acceptance keeps escrow and emits no terminal notice", () => {
  const g = field();
  g.wars = ["p1|p2"];
  trade(g, "p1", "peace", { factionId: "p2", gold: 10 });
  const proposal = g.proposals.at(-1);
  const gold = g.gold.p1;
  g.wars = [];
  assert.throws(() =>
    trade(g, "p2", "acceptPeace", { proposalId: proposal.id }),
  );
  assert.equal(g.proposals.at(-1).id, proposal.id);
  assert.equal(g.gold.p1, gold);
  assert.equal(
    observe(g, "p1").tradeNotices.filter((n) => n.proposal.id === proposal.id).length,
    1,
  );
});

test("movement cost allows a positive-MP over-cost hill or river edge and keeps route forecasts aligned", () => {
  const g = field();
  const hill = g.tiles.find((t) => equal(t, { q: 4, r: 3 }));
  hill.terrain = "hills";
  const uphill = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, { movesLeft: 1 });
  assert.equal(movementCost({ a: uphill, b: hill }, g), 2);
  assert.equal(reachable(g.tiles, uphill, g.units, "p1").get("4,3").cost, 1);
  order(g, "p1", uphill.id, "move", {
    target: { q: 4, r: 3 },
    path: [{ q: 4, r: 3 }],
  });
  assert.ok(equal(uphill, { q: 4, r: 3 }));
  assert.equal(uphill.movesLeft, 0);

  const river = field();
  const crossing = addUnit(
    river,
    "p1",
    "spearman",
    { q: 3, r: 3 },
    { movesLeft: 2 },
  );
  const bank = river.tiles.find((t) => equal(t, { q: 4, r: 3 }));
  bank.terrain = "hills";
  river.rivers = [{ a: { q: 3, r: 3 }, b: { q: 4, r: 3 } }];
  assert.equal(movementCost({ a: crossing, b: bank }, river), 3);
  assert.equal(
    reachable(river.tiles, crossing, river.units, "p1", river.rivers).get("4,3").cost,
    2,
  );
  assert.deepEqual(
    routeSchedule(
      river.tiles,
      crossing,
      river.units,
      "p1",
      [{ q: 4, r: 3 }],
      river.rivers,
    ).steps[0],
      { q: 4, r: 3, turn: 1, remaining: 0, endOfTurn: true },
  );

  const cavalryField = field();
  const cavalry = addUnit(cavalryField, "p1", "cavalry", { q: 3, r: 8 });
  const cavalryPath = Array.from({ length: 6 }, (_, index) => ({
    q: 4 + index,
    r: 8,
  }));
  assert.equal(
    routeSchedule(
      cavalryField.tiles,
      cavalry,
      cavalryField.units,
      "p1",
      cavalryPath,
    ).steps.at(-1).turn,
    1,
  );
  order(cavalryField, "p1", cavalry.id, "move", {
    target: cavalryPath.at(-1),
    path: cavalryPath,
  });
  assert.ok(equal(cavalry, cavalryPath.at(-1)));
  assert.equal(cavalry.movesLeft, TYPES.cavalry.movement - 6);
});

test("musketeer LOS blocks allied and enemy screens without naming hidden blockers, while MP-zero attacks remain legal", () => {
  const g = field();
  const attacker = addUnit(g, "p1", "musketeer", { q: 3, r: 3 }, { movesLeft: 0 });
  const screen = addUnit(g, "p1", "spearman", { q: 4, r: 3 });
  const target = addUnit(g, "p2", "spearman", { q: 5, r: 3 });
  const view = observe(g, "p1");
  const preview = combatPreview(view, attacker, {
    ...target,
    hostile: true,
  });
  assert.equal(preview.legal, false);
  assert.ok(preview.reasons.includes("사격선이 막혀 있어요"));
  assert.throws(() =>
    order(g, "p1", attacker.id, "attack", { target: { q: 5, r: 3 } }),
  );
  assert.equal(attacker.attackUsed, false);

  screen.q = 8;
  const open = observe(g, "p1");
  const openTarget = open.units.find((u) => u.id === target.id);
  assert.equal(combatPreview(open, attacker, openTarget).legal, true);
  order(g, "p1", attacker.id, "attack", { target: { q: 5, r: 3 } });
  assert.equal(attacker.attackUsed, true);
  assert.equal(attacker.movesLeft, 0);
  assert.ok(target.hp < 100);

  const hidden = field();
  const shooter = addUnit(hidden, "p1", "musketeer", { q: 3, r: 3 });
  const unseen = addUnit(hidden, "p2", "spearman", { q: 4, r: 3 });
  const far = addUnit(hidden, "p2", "spearman", { q: 5, r: 3 });
  // A player-scoped observation can omit the blocker (for example when it is
  // stale or comes from another scout). The helper remains generic and never
  // returns the blocker identity.
  const stale = { ...observe(hidden, "p1"), units: [
    observe(hidden, "p1").units.find((u) => u.id === shooter.id),
    observe(hidden, "p1").units.find((u) => u.id === far.id),
  ] };
  assert.equal(hasLineOfSight(stale, shooter, far), true);
  assert.equal(hasLineOfSight(observe(hidden, "p1"), shooter, far), false);
  assert.equal(unseen.id.includes("private"), false);
});

test("formations merge only equal tiers with literal summed health and retained provenance, and legacy size three stays intact", () => {
  const g = field();
  const a = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, { hp: 61, xp: 8, name: "첫 부대" });
  const b = addUnit(g, "p1", "spearman", { q: 4, r: 3 }, { hp: 73, xp: 2, name: "둘째 부대" });
  order(g, "p1", a.id, "merge", { targetId: b.id });
  resolveTurn(g, 2_000);
  assert.equal(b.size, 2);
  // Civ6: HP is not pooled; the brigade keeps the healthier constituent's HP.
  assert.equal(b.hp, 73);
  assert.equal(maxHealth(b), 100);
  assert.equal(b.formation.tier, "brigade");
  assert.deepEqual(b.formation.sourceNames, ["둘째 부대", "첫 부대"]);
  assert.equal(b.formation.manpower, 2);
  assert.ok(b.mergedThisTurn);
  assert.throws(() =>
    order(g, "p1", b.id, "merge", { targetId: a.id }),
  );

  const c = addUnit(g, "p1", "spearman", { q: 5, r: 3 }, { size: 2, hp: 180, xp: 20 });
  b.q = 4;
  c.q = 5;
  b.movesLeft = 2;
  b.attackUsed = false;
  b.mergedThisTurn = false;
  b.acted = false;
  g.activePlayer = "p1";
  order(g, "p1", b.id, "merge", { targetId: c.id });
  resolveTurn(g, 2_000);
  assert.equal(c.size, 4);
  assert.equal(c.hp, 100);
  assert.equal(maxHealth(c), 100);
  assert.equal(c.formation.tier, "division");
  assert.equal(c.formation.manpower, 4);

  const legacy = addUnit(g, "p1", "cavalry", { q: 7, r: 3 }, { size: 3, xp: 12 });
  legacy.hp = 201; // raw pooled-HP save state (100 × size model)
  delete legacy.formation;
  const snapshot = JSON.parse(JSON.stringify(g));
  const observed = observe(restoreGame(snapshot), "p1").units.find(
    (u) => u.id === legacy.id,
  );
  assert.equal(observed.size, 3);
  assert.equal(observed.hp, 67, "pooled legacy HP 201/300 migrates to 67/100");
  assert.equal(observed.formation.tier, "legacy");
  assert.equal(observed.formation.manpower, 3);
  assert.ok(snapshot.units.some((u) => u.id === legacy.id));
});

test("recovery is 16 per base unit, walls absorb first and repair never passively heals the city body", () => {
  const g = field();
  const wounded = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, { hp: 70 });
  resolveTurn(g, 2_000);
  assert.equal(wounded.hp, 86);

  const city = {
    id: "wall-city",
    owner: "p2",
    name: "벽 도시",
    q: 6,
    r: 3,
    population: 3,
    hp: 140,
    wallLevel: 1,
    wallHp: 20,
    food: 0,
    production: 0,
    queue: null,
    capital: false,
    isolation: 0,
    supplied: true,
  };
  g.cities.push(city);
  const bombard = addUnit(g, "p1", "artillery", { q: 4, r: 3 });
  const garrison = addUnit(g, "p2", "spearman", { q: 6, r: 3 }, { hp: 100 });
  g.deadline = null;
  g.activePlayer = "p1";
  order(g, "p1", bombard.id, "bombard", { target: { q: 6, r: 3 } });
  assert.equal(city.wallHp, 0);
  assert.ok(city.hp < 140);
  assert.equal(garrison.hp, 100);
  assert.ok(observe(g, "p1").effects.some((e) => e.wallDamage > 0 && e.bodyDamage > 0));

  city.hp = 100;
  city.wallHp = 10;
  city.lastIncomingAttackTurn = 0;
  g.turn = 5;
  g.activePlayer = "p2";
  g.deadline = null;
  submitOrders(g, "p2", {
    turn: 5,
    production: [{ cityId: city.id, type: "wallRepair" }],
  });
  resolveTurn(g, 2_000);
  assert.ok(city.wallHp > 10);
  assert.equal(city.hp, 120, "Civ6 city heal 20 per quiet turn");
  const bodyAfterRepair = city.hp;
  city.lastIncomingAttackTurn = g.turn;
  city.wallRepairStartedTurn = g.turn - 1;
  g.activePlayer = "p2";
  resolveTurn(g, 2_000);
  assert.equal(city.hp, bodyAfterRepair);
  assert.equal(city.queue, null);
});

test("city fire cannot bypass a live target wall to damage its garrison", () => {
  const g = field();
  const source = {
    id: "source-city",
    owner: "p1",
    name: "공격 도시",
    q: 3,
    r: 3,
    population: 3,
    hp: 160,
    wallLevel: 1,
    wallHp: 50,
    food: 0,
    production: 0,
    queue: null,
    capital: false,
    isolation: 0,
    supplied: true,
  };
  const targetCity = {
    id: "target-city",
    owner: "p2",
    name: "방어 도시",
    q: 5,
    r: 3,
    population: 3,
    hp: 160,
    wallLevel: 1,
    wallHp: 50,
    food: 0,
    production: 0,
    queue: null,
    capital: false,
    isolation: 0,
    supplied: true,
  };
  g.cities.push(source, targetCity);
  const garrison = addUnit(g, "p2", "spearman", targetCity);
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [
      {
        cityId: source.id,
        action: "cityBombard",
        target: { q: targetCity.q, r: targetCity.r },
      },
    ],
  });
  assert.ok(targetCity.wallHp < 50);
  assert.equal(garrison.hp, 100);

  // Wall damage is not limited by the current HP of the protected unit.
  targetCity.wallHp = 50;
  garrison.hp = 1;
  source.attackUsed = false;
  submitOrders(g, "p1", {
    turn: g.turn,
    orders: [
      {
        cityId: source.id,
        action: "cityBombard",
        target: { q: targetCity.q, r: targetCity.r },
      },
    ],
  });
  assert.ok(targetCity.wallHp < 50);
  assert.equal(garrison.hp, 1);
});

test("direct military overrun captures builders, while final city capture preserves civilians and destroys military garrison", () => {
  const overrun = field();
  const raider = addUnit(overrun, "p1", "spearman", { q: 3, r: 3 });
  const builder = addUnit(overrun, "p2", "builder", { q: 4, r: 3 });
  order(overrun, "p1", raider.id, "attack", { target: { q: 4, r: 3 } });
  assert.ok(overrun.units.includes(builder));
  assert.equal(builder.owner, "p1");
  assert.equal(builder.hp, 100);

  const g = field();
  const city = {
    id: "capture-city",
    owner: "p2",
    name: "함락 도시",
    q: 6,
    r: 3,
    population: 3,
    hp: 0,
    wallHp: 0,
    wallLevel: 1,
    food: 0,
    production: 0,
    queue: null,
    capital: false,
    isolation: 0,
    supplied: true,
  };
  g.cities.push(city);
  const invader = addUnit(g, "p1", "spearman", { q: 6, r: 3 });
  const militaryGarrison = addUnit(g, "p2", "spearman", { q: 6, r: 3 });
  const civilianGarrison = addUnit(g, "p2", "builder", { q: 6, r: 3 });
  g.deadline = null;
  order(g, "p1", invader.id, "fortify");
  assert.equal(city.owner, "p1");
  assert.ok(!g.units.some((u) => u.id === militaryGarrison.id));
  assert.equal(g.units.find((u) => u.id === civilianGarrison.id).owner, "p1");
  assert.equal(city.wallHp, 0);
  assert.equal(city.hp, 80);
});

test("preview exposes position modifiers and mathematically bounded lethal/death risk, and joint-war deal commits both sides atomically", () => {
  const g = field();
  // Civ6: a 1-HP defender still hits back with ~11 CS, so a 6-HP attacker keeps
  // the death risk "possible" while its own kill is guaranteed.
  const attacker = addUnit(g, "p1", "spearman", { q: 3, r: 3 }, { hp: 6 });
  const target = addUnit(g, "p2", "spearman", { q: 4, r: 3 }, { hp: 1 });
  g.tiles.find((t) => equal(t, target)).terrain = "hills";
  const preview = combatPreview(observe(g, "p1"), attacker, {
    ...target,
    hostile: true,
  });
  assert.ok(preview.reasons.includes("방어 구릉지 방어 +3"));
  assert.equal(preview.targetOutcome.possible, true);
  assert.equal(preview.targetOutcome.guaranteed, true);
  assert.equal(preview.outcome.attacker.possible, true);
  assert.equal(preview.attack, combatStrength(attacker, false, observe(g, "p1"), target));

  const diplomacy = field();
  diplomacy.wars = ["p1|p2"];
  trade(diplomacy, "p1", "offerDeal", {
    factionId: "p2",
    peace: true,
    alliance: true,
    give: { gold: 1, warAgainst: "p3" },
    receive: { warAgainst: "p4" },
  });
  const proposal = diplomacy.proposals.at(-1);
  assert.equal(diplomacy.wars.length, 1);
  assert.equal(diplomacy.alliances["p1|p2"], undefined);
  trade(diplomacy, "p2", "acceptProposal", { proposalId: proposal.id });
  assert.ok(!diplomacy.wars.includes("p1|p2"));
  assert.ok(diplomacy.wars.includes("p1|p3"));
  assert.ok(diplomacy.wars.includes("p2|p4"));
  assert.ok(diplomacy.alliances["p1|p2"] >= diplomacy.turn);
  assert.equal(diplomacy.proposals.length, 0);
});
