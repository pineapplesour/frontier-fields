import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureEconomyState,
  mobilizationQueueView,
} from "../server/economy.mjs";
import {
  ammunitionCost,
  ammunitionPreview,
  ensureAmmunition,
  mergeAmmunitionUpkeep,
  settleAmmunitionUpkeep,
  upkeepPreview,
} from "../server/upkeep.mjs";

test("economy queue normalization preserves entry identity and blocked diagnostics", () => {
  const entry = {
    id: "mobilize-1",
    type: "musketeer",
    status: "blocked",
    blockedReason: "초석 부족",
    blockedAt: 7,
    lastAttemptTurn: 7,
  };
  const g = {
    supplyMode: "on",
    cities: [{ id: "city-1", population: 3, mobilizationQueue: [entry] }],
    units: [],
  };
  ensureEconomyState(g);
  const reference = g.cities[0].mobilizationQueue[0];
  ensureEconomyState(g);
  assert.strictEqual(g.cities[0].mobilizationQueue[0], reference);
  assert.equal(reference.blockedReason, "초석 부족");
  assert.equal(reference.reason, "초석 부족");
  assert.equal(reference.blockedAt, 7);
  assert.equal(reference.lastAttemptTurn, 7);
  assert.equal(mobilizationQueueView(g.cities[0]).pending[0].blockedReason, "초석 부족");
});

test("idle niter units settle once per turn and an attack cannot double charge", () => {
  const musketeer = { id: "m", owner: "p1", type: "musketeer", size: 1, hp: 100 };
  const artillery = { id: "a", owner: "p1", type: "artillery", size: 2, hp: 100 };
  const g = {
    turn: 4,
    units: [musketeer, artillery],
    stockpiles: { p1: { niter: 8 } },
  };
  assert.equal(ammunitionCost(musketeer), 1);
  assert.equal(ammunitionCost(artillery), 2);
  const first = settleAmmunitionUpkeep(g, "p1");
  assert.equal(first.charged, 3);
  assert.equal(g.stockpiles.p1.niter, 5);
  assert.equal(settleAmmunitionUpkeep(g, "p1").charged, 0);
  assert.equal(ensureAmmunition(g, musketeer).charged, 0);
  assert.equal(g.stockpiles.p1.niter, 5);
  g.turn = 5;
  const second = settleAmmunitionUpkeep(g, "p1");
  assert.equal(second.charged, 3);
  assert.equal(g.stockpiles.p1.niter, 2);
  assert.equal(ammunitionPreview(g, artillery).paid, true);
});

test("shortfall is visible, does not partially debit, and can be retried after top-up", () => {
  const unit = { id: "a", owner: "p1", type: "artillery", size: 4, hp: 100 };
  const g = {
    turn: 9,
    units: [unit],
    stockpiles: { p1: { niter: 2 } },
  };
  const blocked = settleAmmunitionUpkeep(g, "p1");
  assert.equal(blocked.charged, 0);
  assert.equal(blocked.shortfall, 2);
  assert.equal(g.stockpiles.p1.niter, 2);
  assert.equal(ammunitionPreview(g, unit).ready, true);
  g.stockpiles.p1.niter = 4;
  const retry = ensureAmmunition(g, unit);
  assert.equal(retry.ready, true);
  assert.equal(retry.charged, 0, "attacks never settle resources");
  assert.equal(settleAmmunitionUpkeep(g, "p1").charged, 4);
  assert.equal(settleAmmunitionUpkeep(g, "p1").charged, 0);
  assert.equal(upkeepPreview(g, "p1").entries[0].paid, true);
});

test("dead or civilian units never create a niter upkeep charge", () => {
  const g = {
    turn: 2,
    units: [
      { id: "dead", owner: "p1", type: "artillery", size: 1, hp: 0 },
      { id: "builder", owner: "p1", type: "builder", size: 1, hp: 100 },
    ],
    stockpiles: { p1: { niter: 3 } },
  };
  assert.equal(settleAmmunitionUpkeep(g, "p1").charged, 0);
  assert.equal(g.stockpiles.p1.niter, 3);
});

test("a merge carries exact paid niter and charges only the unpaid base unit", () => {
  const target = { id: "target", owner: "p1", type: "musketeer", size: 2, hp: 100 };
  const source = { id: "source", owner: "p1", type: "musketeer", size: 1, hp: 100 };
  const g = { turn: 3, units: [target, source], stockpiles: { p1: { niter: 2 } } };
  // Target's size-1 upkeep has already been paid before the combat merge;
  // the new size-2 formation owes exactly one more niter.
  target.size = 1;
  settleAmmunitionUpkeep(g, "p1", { units: [target] });
  target.size = 2;
  const merged = mergeAmmunitionUpkeep(g, target, source);
  assert.equal(merged.paidAmount, 1);
  assert.equal(merged.remaining, 1);
  assert.equal(ensureAmmunition(g, target).charged, 0);
  assert.equal(settleAmmunitionUpkeep(g, "p1", { units: [target] }).charged, 1);
  assert.equal(g.stockpiles.p1.niter, 0);
  assert.equal(ensureAmmunition(g, target).charged, 0);

  // Imported/early-turn snapshots may still have only the old boolean marker.
  // After the target has already been resized, infer the paid amount from its
  // pre-merge size rather than treating the size-2 formation as fully paid.
  const legacyTarget = {
    id: "legacy-target",
    owner: "p1",
    type: "musketeer",
    size: 2,
    hp: 100,
    ammoPaidTurn: 3,
  };
  const legacySource = {
    id: "legacy-source",
    owner: "p1",
    type: "musketeer",
    size: 1,
    hp: 100,
  };
  const legacy = mergeAmmunitionUpkeep(g, legacyTarget, legacySource);
  assert.equal(legacy.paidAmount, 1);
  assert.equal(legacy.remaining, 1);
});
