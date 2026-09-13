import test from "node:test";
import assert from "node:assert/strict";
import { resolveMapSelection } from "../src/selectionResolver.js";
import {
  appendNoticeUpdates,
  initialNoticeState,
  noticeCandidates,
} from "../src/notificationHelpers.js";
import { createTurnTransitionTracker } from "../src/turnAudio.js";
import { productionEstimate } from "../src/productionHelpers.js";
import {
  publicRelationAt,
  relationPresentation,
} from "../src/publicRelations.js";
import {
  capturePresentation,
  combatOutcomePresentation,
  effectBatchIdentity,
  effectDisplayKey,
  lockedCombatEffect,
} from "../src/combatPresentation.js";
import {
  appendGuaranteeNoticeUpdates,
  guaranteeDirectionLabel,
  guaranteeActions,
  guaranteeNoticeCandidates,
  guaranteeRecords,
  guaranteeState,
  initialGuaranteeNoticeState,
  supportsGuarantees,
} from "../src/guaranteeHelpers.js";
import {
  cargoEntries,
  cargoStatus,
  cityFoodSummary,
  detailedLogisticsState,
  encampmentTargetCandidates,
  facilitySummary,
  laborSummary,
  manpowerSummary,
  merchantSummary,
  structureSummary,
  territorySummary,
  unitManpowerSummary,
} from "../src/logisticsHelpers.js";
import {
  attackReadiness,
  cityDefenseSummary,
  wallRepairEligibility,
} from "../src/cityDefenseHelpers.js";
import {
  canMergeEqualTier,
  canMergeFromTier,
  mergedFormationSize,
} from "../src/formationHelpers.js";

const baseGame = () => ({
  playerId: "p1",
  tiles: [{ q: 2, r: 2, terrain: "plains" }],
  units: [
    { id: "own", owner: "p1", type: "spearman", q: 2, r: 2 },
    { id: "enemy", owner: "p2", type: "spearman", q: 4, r: 4 },
  ],
  cities: [
    { id: "home", owner: "p1", name: "들녘", q: 2, r: 2 },
    { id: "away", owner: "p2", name: "솔마루", q: 4, r: 4 },
  ],
  contacts: [],
  cityContacts: [],
});

test("body city picks prefer an own garrison, while city labels inspect the city", () => {
  const game = baseGame();
  assert.deepEqual(
    resolveMapSelection(game, game.cities[0]).selection,
    { kind: "unit", id: "own", q: 2, r: 2 },
  );
  assert.deepEqual(
    resolveMapSelection(game, { ...game.cities[1], source: "cityLabel" }).selection,
    { kind: "city", id: "away", q: 4, r: 4 },
  );
  const noGarrison = { ...game, units: game.units.slice(1) };
  assert.equal(resolveMapSelection(noGarrison, noGarrison.cities[0]).civilizationId, "p1");
});

test("formation merge UI follows equal tiers and preserves legacy size three", () => {
  const base = { id: "a", type: "spearman", size: 1 };
  const brigade = { id: "b", type: "spearman", size: 2 };
  const legacy = { id: "c", type: "spearman", size: 3 };
  assert.equal(mergedFormationSize(base, { ...base, id: "other" }), 2);
  assert.equal(mergedFormationSize(brigade, { ...brigade, id: "other" }), 4);
  assert.equal(mergedFormationSize(legacy, { ...legacy, id: "other" }), null);
  assert.equal(canMergeEqualTier(base, { ...base, id: "other" }), true);
  assert.equal(canMergeEqualTier(base, brigade), false);
  assert.equal(canMergeEqualTier(legacy, { ...legacy, id: "other" }), false);
  assert.equal(canMergeFromTier(base), true);
  assert.equal(canMergeFromTier(legacy), false);
});

test("city defense display separates body and wall HP and mirrors quiet wall repair gate", () => {
  const city = {
    hp: 104,
    maxHp: 160,
    wallHp: 22,
    wallMaxHp: 50,
    wallLevel: 1,
    lastIncomingAttackTurn: 8,
  };
  const defense = cityDefenseSummary(city);
  assert.deepEqual(
    {
      body: defense.body,
      bodyMax: defense.bodyMax,
      wall: defense.wall,
      wallMax: defense.wallMax,
    },
    { body: 104, bodyMax: 160, wall: 22, wallMax: 50 },
  );
  assert.equal(wallRepairEligibility(city, 12).eligible, false);
  assert.match(wallRepairEligibility(city, 12).reason, /5턴/);
  assert.equal(wallRepairEligibility(city, 13).eligible, true);
  assert.equal(wallRepairEligibility({ ...city, wallHp: 50 }, 13).eligible, false);
});

test("niter shortfalls remain informational even with legacy blocking flags", () => {
  assert.equal(attackReadiness({ type: "spearman" }).ready, true);
  assert.equal(
    attackReadiness({ ammunition: { ready: false, shortfall: 2 } }).ready,
    true,
  );
  assert.match(
    attackReadiness({ ammunition: { ready: false, shortfall: 2 } }).reason,
    /초석 유지비 2개 부족.*공격 가능/,
  );
});

test("explicit unit nameplates keep unit selection even on a city", () => {
  const game = baseGame();
  assert.deepEqual(
    resolveMapSelection(game, { ...game.units[0], source: "unitLabel" }).selection,
    { kind: "unit", id: "own", q: 2, r: 2 },
  );
});

test("trade notice state queues pending requests, skips historic outcomes, and deduplicates polling", () => {
  const proposal = {
    id: "proposal-1",
    kind: "deal",
    from: "p2",
    to: "p1",
    give: { gold: 0, resources: {}, units: [], cities: [] },
    receive: { gold: 10, resources: {}, units: [], cities: [] },
  };
  const game = {
    playerId: "p1",
    turn: 3,
    diplomacy: [proposal],
    tradeNotices: [
      { id: "notice-request", turn: 3, status: "requested", proposal },
      { id: "notice-old", turn: 3, status: "accepted", proposal },
    ],
  };
  const candidates = noticeCandidates(game);
  assert.equal(candidates.length, 2);
  const initial = initialNoticeState(game);
  assert.deepEqual(initial.queue.map((n) => n.status), ["requested"]);
  const repeated = appendNoticeUpdates(initial, game);
  assert.equal(repeated.queue.length, 1);
  const afterOutcome = appendNoticeUpdates(repeated, {
    ...game,
    tradeNotices: [
      ...game.tradeNotices,
      { id: "notice-accepted", turn: 3, status: "accepted", proposal },
    ],
  });
  assert.deepEqual(afterOutcome.queue.map((n) => n.status), ["requested", "accepted"]);

  // A pending diplomacy proposal may arrive before its durable requested
  // event. The event id must not make the same request pop up twice.
  const pendingOnly = initialNoticeState({
    ...game,
    tradeNotices: [],
  });
  const durableLater = appendNoticeUpdates(pendingOnly, {
    ...game,
    tradeNotices: [game.tradeNotices[0]],
  });
  assert.equal(durableLater.queue.length, 1);
});

test("guarantees keep directed status and detect the explicit capability contract", () => {
  const game = {
    playerId: "p1",
    capabilities: {
      guarantees: {
        enabled: true,
        actions: { issue: "issueGuarantee", withdraw: "revokeGuarantee" },
      },
    },
    guarantees: [
      { id: "g-out", guarantor: "p1", protected: "p2", status: "active" },
      { id: "g-in", from: "p3", to: "p1", status: "pending" },
    ],
  };
  assert.equal(supportsGuarantees(game), true);
  assert.equal(supportsGuarantees({ guarantees: [] }), true);
  assert.equal(supportsGuarantees({ capabilities: { guarantees: false } }), false);
  assert.equal(guaranteeRecords(game).length, 2);
  assert.equal(guaranteeState(game, "p1", "p2").active.id, "g-out");
  assert.equal(guaranteeState(game, "p3", "p1").pending.id, "g-in");
  assert.equal(
    guaranteeState(
      { diplomacy: [{ id: "proposal-g", kind: "independent-guarantee", from: "p1", to: "p3", expires: 8 }] },
      "p1",
      "p3",
    ).pending.id,
    "proposal-g",
  );
  assert.equal(
    guaranteeDirectionLabel(
      guaranteeState(game, "p1", "p2").active,
      "p1",
      "p2",
    ),
    "독립보장중",
  );
  assert.equal(
    guaranteeDirectionLabel(
      guaranteeState(game, "p3", "p1").pending,
      "p1",
      "p3",
    ),
    "보장 요청 처리 중",
  );
});

test("guarantee notices show pending calls once and surface later durable outcomes", () => {
  const pending = {
    id: "call-1",
    kind: "callToArms",
    turn: 4,
    status: "requested",
    guaranteeId: "g-call-1",
    guarantor: "p1",
    protected: "p2",
    attacker: "p3",
  };
  const historic = {
    id: "call-old",
    kind: "callToArms",
    turn: 3,
    status: "accepted",
    guarantor: "p1",
    protected: "p3",
    attacker: "p2",
  };
  const game = {
    playerId: "p1",
    turn: 4,
    guaranteeNotices: { p1: [pending, historic] },
  };
  assert.equal(guaranteeNoticeCandidates(game).length, 2);
  const initial = initialGuaranteeNoticeState(game);
  assert.deepEqual(initial.queue.map((notice) => notice.status), ["requested"]);
  const repeated = appendGuaranteeNoticeUpdates(initial, game);
  assert.equal(repeated.queue.length, 1);
  const accepted = {
    ...pending,
    status: "accepted",
  };
  const afterOutcome = appendGuaranteeNoticeUpdates(repeated, {
    ...game,
    guaranteeNotices: { p1: [pending, historic, accepted] },
  });
  assert.deepEqual(
    afterOutcome.queue.map((notice) => notice.status),
    ["requested", "accepted"],
  );
  // A durable result already present on first mount replaces its stale
  // request for the same guarantee id and is not replayed as a new popup.
  const alreadySettled = initialGuaranteeNoticeState({
    ...game,
    guaranteeNotices: {
      p1: [pending, { ...pending, status: "accepted" }],
    },
  });
  assert.equal(alreadySettled.queue.length, 0);

  const actualContract = {
    playerId: "p1",
    turn: 4,
    guarantees: [],
    guaranteeCalls: [
      {
        id: "call-actual",
        guaranteeId: "edge-actual",
        guarantor: "p1",
        protected: "p2",
        attacker: "p3",
        status: "pending",
      },
    ],
    events: [
      {
        type: "guarantee",
        guaranteeId: "edge-not-a-call",
        guarantor: "p1",
        protected: "p2",
      },
    ],
  };
  assert.equal(guaranteeActions(actualContract).acceptCall, "acceptGuarantee");
  assert.equal(guaranteeNoticeCandidates(actualContract).length, 1);
  assert.equal(initialGuaranteeNoticeState(actualContract).queue.length, 1);
});

test("turn transition tracker is silent on baseline/replays and cues only newer transitions", () => {
  const tracker = createTurnTransitionTracker();
  assert.equal(
    tracker.observe("match", { revision: 1, turn: 1, activePlayer: "p1" }),
    false,
  );
  assert.equal(
    tracker.observe("match", { revision: 1, turn: 1, activePlayer: "p1" }),
    false,
  );
  assert.equal(
    tracker.observe("match", { revision: 2, turn: 1, activePlayer: "p1" }),
    false,
  );
  assert.equal(
    tracker.observe("match", { revision: 3, turn: 1, activePlayer: "p2" }),
    true,
  );
  assert.equal(
    tracker.observe("match", { revision: 2, turn: 1, activePlayer: "p1" }),
    false,
  );
  assert.equal(
    tracker.observe(
      "match",
      { revision: 4, turn: 2, activePlayer: "p2" },
      { baseline: true },
    ),
    false,
  );
  assert.equal(
    tracker.observe("match", { revision: 5, turn: 2, activePlayer: "p1" }),
    true,
  );
  assert.equal(
    tracker.observe("match", { revision: 6, turn: 2, activePlayer: "p1" }),
    false,
  );
});

test("production ETA separates points from time and handles completion/zero rate", () => {
  assert.deepEqual(
    productionEstimate({ cost: 26, progress: 0, productionRate: 4 }),
    {
      cost: 26,
      progress: 0,
      productionRate: 4,
      remaining: 26,
      complete: false,
      turns: 7,
    },
  );
  assert.equal(
    productionEstimate({ cost: 26, progress: 26, productionRate: 4 }).complete,
    true,
  );
  assert.equal(
    productionEstimate({ cost: 26, progress: 4, productionRate: 0 }).turns,
    null,
  );
});

test("public relation matrix never guesses a missing pair as neutral", () => {
  const game = {
    publicRelations: {
      p2: {
        p1: "war",
        p3: { relation: "alliance" },
      },
    },
    factions: [],
  };
  assert.equal(publicRelationAt(game, "p2", "p1"), "war");
  assert.equal(publicRelationAt(game, "p2", "p3"), "alliance");
  assert.equal(publicRelationAt(game, "p2", "p4"), null);
  assert.deepEqual(relationPresentation(null), {
    label: "공개 정보 없음",
    tone: "unknown",
    icon: "info",
    known: false,
  });
  assert.equal(relationPresentation("denounced").tone, "denounced");
});

test("combat visuals keep the resolved endpoint instead of homing to a moved target", () => {
  const effect = {
    id: "shot-1",
    kind: "bombard",
    from: { q: 1, r: 1 },
    to: { q: 4, r: 4 },
    at: { q: 4, r: 4 },
  };
  const locked = lockedCombatEffect(effect);
  const laterSnapshot = {
    ...effect,
    to: { q: 8, r: 8 },
    target: { q: 8, r: 8 },
  };
  assert.deepEqual(locked.to, { q: 4, r: 4 });
  assert.notDeepEqual(locked.to, laterSnapshot.target);
  assert.equal(
    effectBatchIdentity([effect], 4),
    effectBatchIdentity([{ ...effect }], 4),
  );
  assert.equal(
    effectDisplayKey(9, [effect], 4),
    effectDisplayKey(9, [{ ...effect }], 4),
  );
  assert.equal(effectDisplayKey(9, [], 4), null);
  const legacyEffect = { ...effect, id: undefined };
  assert.notEqual(
    effectBatchIdentity([legacyEffect], 4),
    effectBatchIdentity([legacyEffect], 5),
  );
});

test("combat outcome labels use visible damage bounds and hide unsupported probability", () => {
  const target = { id: "enemy", owner: "p2", type: "spearman", hp: 50 };
  const attacker = { id: "own", owner: "p1", type: "musketeer", hp: 100 };
  const result = combatOutcomePresentation({
    attacker,
    target,
    preview: {
      dealt: [42, 58],
      received: [0, 0],
      reasons: ["구릉지 방어력 +20%"],
      probability: 0.95,
    },
  });
  assert.equal(result.enemy, "격파가능");
  assert.equal(result.own, "아군 전사위험 없음");
  assert.equal(result.damage, "42~58");
  assert.equal(result.probability, null);
  assert.deepEqual(result.advantages, ["구릉지 방어력 +20%"]);
});

test("backend preview outcome aliases map guaranteed/possible bounds without RNG guesses", () => {
  const result = combatOutcomePresentation({
    attacker: { type: "spearman", hp: 10 },
    target: { type: "cavalry", hp: 80 },
    preview: {
      dealt: [20, 30],
      received: [6, 8],
      targetOutcome: {
        currentHp: 80,
        minDamage: 20,
        maxDamage: 30,
        status: "possible",
      },
      attackerOutcome: {
        currentHp: 10,
        minDamage: 6,
        maxDamage: 8,
        status: "unlikely",
      },
      reasons: ["구릉지 고지 공격 +10%", "아군 요새 주둔 공격 +10%"],
    },
  });
  assert.equal(result.enemy, "격파가능");
  assert.equal(result.own, "아군 전사어려움");
  assert.deepEqual(result.advantages, [
    "구릉지 고지 공격 +10%",
    "아군 요새 주둔 공격 +10%",
  ]);
  assert.equal(result.probability, null);
});

test("city capture preview keeps wall, entry, and next-turn conditions explicit", () => {
  const result = capturePresentation({
    attacker: { type: "artillery", movesLeft: 0 },
    target: { id: "city", owner: "p2", hp: 18, wallHp: 9 },
    preview: {
      dealt: [5, 7],
      capture: { requiresEntry: true, garrisonBlocked: true },
    },
  });
  assert.equal(result.tone, "blocked");
  assert.ok(result.lines.some((line) => line.includes("성벽")));
  assert.ok(result.lines.some((line) => line.includes("주둔군")));
  assert.ok(result.lines.some((line) => line.includes("진입")));
  assert.equal(result.lines.some((line) => line.includes("확률")), false);
});

test("city preview uses separate backend wall/body damage ranges", () => {
  const result = capturePresentation({
    attacker: { type: "artillery", movesLeft: 2 },
    target: { id: "city", owner: "p2", hp: 40, wallHp: 8 },
    preview: {
      dealt: [10, 14],
      wallDamage: [8, 8],
      bodyDamage: [2, 6],
      targetOutcome: {
        currentHp: 48,
        minDamage: 10,
        maxDamage: 14,
        status: "possible",
      },
    },
  });
  assert.ok(result.lines.some((line) => line.includes("성벽 피해 8")));
  assert.ok(result.lines.some((line) => line.includes("도시 체력 40") && line.includes("2~6")));
  assert.equal(result.lines.some((line) => line.includes("확률")), false);
});

test("detailed logistics keeps city food stock separate from growth progress", () => {
  const game = {
    playerId: "p1",
    paused: true,
    phase: "planning",
    capabilities: { detailedLogistics: true },
    settings: { detailedLogistics: true },
  };
  const summary = cityFoodSummary(
    {
      foodStock: 12,
      food: 4,
      growthTarget: 10,
      foodProductionRate: 5,
      foodConsumptionRate: 3,
    },
    game,
  );
  assert.equal(summary.available, true);
  assert.equal(summary.stored, 12);
  assert.equal(summary.progress, 4);
  assert.equal(summary.net, 2);
  assert.equal(summary.growthTurns, 3);
  assert.equal(summary.starvationTurns, null);
  assert.equal(detailedLogisticsState(game).canToggle, true);
  const legacy = cityFoodSummary({ food: 4, population: 2, foodGross: 2, foodNet: 0 });
  assert.equal(legacy.available, true);
  assert.equal(legacy.stockAvailable, false);
  const off = cityFoodSummary(
    { food: 4, population: 2, foodGross: 3, foodNet: 1, growthTarget: 10 },
    { ...game, settings: { detailedLogistics: false } },
  );
  assert.equal(off.stockAvailable, false);
  assert.equal(off.starvationTurns, null);
  assert.equal(off.growthTurns, 6);
  const expansionOff = cityFoodSummary(
    {
      foodStock: null,
      growthProgress: 4,
      growthProgressUnit: "food-surplus",
      foodGross: 3,
      foodConsumption: 2,
      foodNet: 1,
      growthTarget: 10,
    },
    { supplyMode: "off", rulesVersion: "expansion-v1" },
  );
  assert.equal(expansionOff.stockAvailable, false);
  assert.equal(expansionOff.progress, 4);
  assert.equal(
    detailedLogisticsState({
      playerId: "p1",
      paused: true,
      phase: "planning",
      supplyMode: "off",
    }).supported,
    true,
  );
  assert.equal(
    detailedLogisticsState({ supplyMode: "on" }).enabled,
    true,
  );
  assert.equal(
    detailedLogisticsState({ rulesVersion: "expansion-v1" }).supported,
    true,
  );
  assert.equal(
    detailedLogisticsState({
      capabilities: { detailedLogistics: false },
      supplyMode: "off",
    }).supported,
    false,
  );
});

test("nested public logistics ledgers and encampment candidates stay authoritative", () => {
  const game = {
    playerId: "p1",
    rulesVersion: "expansion-v1",
    settings: { detailedLogistics: true },
    logistics: {
      enabled: true,
      cities: [{ id: "home", foodStock: 7, foodCapacity: 20 }],
      encampmentCandidates: {
        home: [{ q: 3, r: 2, terrain: "hills", cityId: "home" }],
      },
    },
  };
  const food = cityFoodSummary(
    {
      id: "home",
      growthProgress: 4,
      growthTarget: 12,
      foodProduction: 5,
      foodConsumption: 3,
    },
    game,
  );
  assert.equal(food.stockAvailable, true);
  assert.equal(food.stored, 7);
  assert.equal(food.capacity, 20);
  assert.deepEqual(encampmentTargetCandidates(game, { id: "home" }), [
    { q: 3, r: 2, terrain: "hills", cityId: "home" },
  ]);
  assert.equal(
    structureSummary({ encampment: false, encampmentStatus: "active" }, game).available,
    false,
  );
});

test("ruin, fixed farm healing, encampment capture, merchant quota and cargo are explicit-only", () => {
  const game = {
    playerId: "p1",
    capabilities: {
      detailedLogistics: true,
      facilityActions: { farm: { action: "scorch", heal: 50 } },
      encampment: true,
      merchant: true,
      logisticsActions: { repairStructure: "repairStructure" },
    },
    cities: [],
    cargo: [
      { id: "cargo-1", status: "in_transit", fromCityId: "a", toCityId: "b" },
      { id: "cargo-1", status: "arrived", fromCityId: "a", toCityId: "b" },
      { id: "cargo-2", status: "captured", fromCityId: "a", toCityId: "b" },
    ],
  };
  const farm = facilitySummary(
    { q: 1, r: 2, farm: true, facilityStatus: "scorched", repairRequired: true },
    game,
  );
  assert.equal(farm.scorched, true);
  assert.equal(farm.repairRequired, true);
  assert.equal(farm.heal, 50);
  assert.equal(facilitySummary({ farm: true }).available, false);
  const expansionRuin = facilitySummary(
    { farm: false, ruin: { kind: "farm", mode: "scorch" } },
    { rulesVersion: "expansion-v1" },
  );
  assert.equal(expansionRuin.kind, "farm");
  assert.equal(expansionRuin.scorched, true);
  assert.equal(expansionRuin.repairRequired, true);
  assert.equal(expansionRuin.heal, 50);
  assert.equal(expansionRuin.repairAction, "repair");

  const encampment = structureSummary(
    {
      encampment: {
        hp: 0,
        maxHp: 80,
        wallsHp: 12,
        owner: "p1",
        captured: true,
      },
    },
    game,
  );
  assert.equal(encampment.captured, true);
  assert.equal(encampment.usablePosition, true);
  assert.equal(encampment.repairRequired, true);
  assert.equal(encampment.repairAction, "repairStructure");

  const merchant = merchantSummary(
    game,
    {
      tradingPost: { built: true, capacity: 1, activeMerchants: 0, traveling: 1, ordered: 1 },
    },
  );
  assert.equal(merchant.built, true);
  assert.equal(merchant.capacity, 1);
  assert.equal(merchant.inUse, 2);
  assert.equal(merchant.remaining, 0);
  assert.equal(merchant.traveling, 1);
  assert.equal(merchant.ordered, 1);
  assert.equal(cargoEntries(game).length, 2);
  assert.equal(cargoStatus({ status: "captured" }), "나포됨");
  assert.equal(cargoStatus({ status: "delivered" }), "도착 완료");
});

test("mobilization and labor summaries require explicit detailed observations", () => {
  const game = {
    playerId: "p1",
    capabilities: { detailedLogistics: true },
    settings: { detailedLogistics: true },
  };
  const city = {
    manpowerReserved: 1.5,
    manpowerAvailable: 2.5,
    mobilization: {
      units: 3,
      unitType: "musketeer",
      unitsPerTurn: 1,
      nextDepartureIn: 1,
      sequential: true,
      reason: "초석 부족",
    },
    laborSlots: 5,
    workersAssigned: 3,
    laborMode: "manual",
    workerAssignments: { 농지: 2, "철광산": 1 },
  };
  const manpower = manpowerSummary(city, game);
  assert.equal(manpower.reserved, 1.5);
  assert.equal(manpower.units, 3);
  assert.equal(manpower.perTurn, 1);
  assert.equal(manpower.nextDeparture, 1);
  assert.equal(manpower.sequential, true);
  assert.equal(manpower.reason, "초석 부족");
  const actualQueue = manpowerSummary(
    {
      owner: "p1",
      manpowerAvailable: 2,
      manpowerQueueAvailable: 1,
      mobilization: {
        pending: [
          { id: "m1", type: "spearman", status: "pending" },
          { id: "m2", type: "musketeer", status: "blocked", blockedReason: "초석 부족" },
        ],
        pendingCount: 2,
        pendingManpower: 1,
      },
    },
    { ...game, rulesVersion: "expansion-v1", activePlayer: "p2" },
  );
  assert.equal(actualQueue.reserved, 1);
  assert.equal(actualQueue.units, 2);
  assert.equal(actualQueue.perTurn, 1);
  assert.equal(actualQueue.nextDeparture, 1);
  assert.equal(actualQueue.availableManpower, 1);
  assert.equal(actualQueue.cancelAction, "cancelMobilization");
  assert.equal(actualQueue.reason, "초석 부족");
  assert.equal(laborSummary(city).assigned, 3);
  assert.equal(laborSummary(city).mode, "manual");
  const actualAllocation = laborSummary({
    citizenAllocation: {
      budget: 4,
      assigned: 3,
      available: 1,
      auto: false,
      lockedSlots: ["farm:1,1"],
      priority: ["resource:2,2"],
      slots: [{ id: "farm:1,1", kind: "farm", yield: "food" }],
      assignments: [{ id: "farm:1,1", kind: "farm" }],
    },
  });
  assert.equal(actualAllocation.mode, "manual");
  assert.equal(actualAllocation.slots, 1);
  assert.deepEqual(actualAllocation.lockedSlots, ["farm:1,1"]);
  assert.equal(unitManpowerSummary({
    manpowerSources: [{ amount: 0.5 }, { population: 0.5 }],
    homeCityId: "home",
  }).tracked, 1);
  assert.equal(manpowerSummary({}).available, false);
});

test("tile assignment displays authoritative city ownership without nearest-city inference", () => {
  const game = {
    playerId: "p1",
    capabilities: { logisticsActions: { reassignTerritory: "reassignTerritory" } },
  };
  const tile = {
    q: 3,
    r: 2,
    owner: "p1",
    cityId: "home",
    reassignmentOptions: ["home", { cityId: "outpost", name: "전초" }],
    reassignable: true,
  };
  const summary = territorySummary(tile, game);
  assert.equal(summary.cityId, "home");
  assert.equal(summary.reassignable, true);
  assert.equal(summary.options.length, 2);
  assert.equal(summary.action, "reassignTerritory");
  assert.equal(
    territorySummary(
      { q: 0, r: 0, owner: "p1", cityId: "home" },
      { ...game, cities: [{ id: "home", q: 0, r: 0 }] },
    ).isCenter,
    true,
  );
  assert.equal(territorySummary({ owner: "p1" }, game).cityId, undefined);

  const expansion = {
    playerId: "p1",
    rulesVersion: "expansion-v1",
    cities: [
      { id: "home", owner: "p1", name: "본도시", q: 0, r: 0 },
      { id: "outpost", owner: "p1", name: "전초", q: 2, r: 0 },
      { id: "far", owner: "p1", name: "먼 도시", q: 6, r: 0 },
    ],
  };
  const derived = territorySummary(
    { q: 1, r: 0, owner: "p1", cityId: "home" },
    expansion,
  );
  assert.equal(derived.action, "reassignTile");
  assert.deepEqual(derived.options, [{ id: "outpost", name: "전초" }]);
  assert.equal(territorySummary({ q: 1, r: 0, owner: null }, expansion).available, false);
});
