// Public independence-guarantee state.  This module deliberately owns only
// the directed commitment and its defensive call; war resolution remains in
// engine.mjs.  It receives callbacks for announcements/events so it cannot
// inspect or mutate hidden combat state while an NPC is deciding.
import { randomUUID } from "node:crypto";
import { FACTIONS, TYPES, isCivilian } from "../shared/rules.js";

export const GUARANTEE_CALL_TTL = 3;

export const GUARANTEE_ACTIONS = Object.freeze({
  issue: "guarantee",
  withdraw: "withdrawGuarantee",
  accept: "acceptGuarantee",
  reject: "rejectGuarantee",
});

export class GuaranteeError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuaranteeError";
  }
}

const pair = (a, b) => [a, b].sort().join("|");
const factions = (g) => g.factions ?? FACTIONS;
const ids = (g) => Object.keys(factions(g));
const faction = (g, id) => factions(g)[id];
const isBarbarian = (g, id) =>
  id === "barb" || faction(g, id)?.kind === "barbarian";
const targetKind = (g, id) =>
  id === "cs" || faction(g, id)?.kind === "citystate"
    ? "citystate"
    : "civilization";
const fail = (message) => {
  throw new GuaranteeError(message);
};
const turnOf = (g, turn) =>
  Number.isInteger(turn) && turn > 0 ? turn : Number(g.turn) || 1;
const emit = (g, options, players, text, extra = {}) =>
  options?.emit?.(g, players, text, extra);
const publicRecipients = (g) => ids(g);

/** Ensure newly-created and older/restored games have additive state. */
export function ensureGuaranteeState(g) {
  g.guarantees = Array.isArray(g.guarantees) ? g.guarantees : [];
  g.guaranteeCalls = Array.isArray(g.guaranteeCalls)
    ? g.guaranteeCalls
    : [];
  for (const edge of g.guarantees) {
    edge.active = edge.active !== false && !edge.withdrawnTurn;
    edge.targetKind ??= targetKind(g, edge.protected);
    edge.issuedTurn ??= 1;
    edge.withdrawnTurn ??= null;
  }
  for (const call of g.guaranteeCalls) {
    call.status ??= "pending";
    call.issuedTurn ??= 1;
    call.expires ??= call.issuedTurn + GUARANTEE_CALL_TTL;
    call.resolvedTurn ??= null;
  }
  return g;
}

export function isGuaranteeTarget(g, id) {
  return (
    typeof id === "string" &&
    !!faction(g, id) &&
    !isBarbarian(g, id) &&
    !!g.players?.[id]
  );
}

const activeEdge = (g, guarantor, protectedId) =>
  g.guarantees.find(
    (edge) =>
      edge.active !== false &&
      !edge.withdrawnTurn &&
      edge.guarantor === guarantor &&
      edge.protected === protectedId,
  );

const publicEdge = (edge) => ({
  id: edge.id,
  guarantor: edge.guarantor,
  protected: edge.protected,
  targetKind: edge.targetKind,
  issuedTurn: edge.issuedTurn,
  active: edge.active !== false && !edge.withdrawnTurn,
  withdrawnTurn: edge.withdrawnTurn ?? null,
});

const publicCall = (call) => ({
  id: call.id,
  guaranteeId: call.guaranteeId,
  guarantor: call.guarantor,
  protected: call.protected,
  attacker: call.attacker,
  warKey: call.warKey,
  status: call.status,
  issuedTurn: call.issuedTurn,
  expires: call.expires,
  resolvedTurn: call.resolvedTurn ?? null,
  joinedWarKey: call.joinedWarKey ?? null,
  reason: call.reason ?? null,
});

/** All edges are public; calls are returned only to their guarantor. */
export function publicGuaranteeState(g, player) {
  ensureGuaranteeState(g);
  const calls = g.guaranteeCalls
    .filter((call) => call.guarantor === player)
    .map(publicCall);
  return {
    guarantees: g.guarantees.map(publicEdge),
    guaranteeCalls: calls,
    pendingGuaranteeCalls: calls.filter((call) => call.status === "pending"),
  };
}

export function issueGuarantee(
  g,
  guarantor,
  protectedId,
  { turn = g.turn, atWar, emit: emitCallback } = {},
) {
  ensureGuaranteeState(g);
  if (!isGuaranteeTarget(g, guarantor) || isBarbarian(g, guarantor))
    fail("야만인은 독립보장을 발행할 수 없어요.");
  if (!isGuaranteeTarget(g, protectedId) || isBarbarian(g, protectedId))
    fail("보장 대상은 참가 문명 또는 도시국가여야 해요.");
  if (guarantor === protectedId)
    fail("자기 문명에는 독립보장을 걸 수 없어요.");
  if (activeEdge(g, guarantor, protectedId))
    fail("같은 대상에 이미 유효한 독립보장이 있어요.");
  if (atWar?.(g, guarantor, protectedId))
    fail("교전 중인 상대에게는 독립보장을 걸 수 없어요.");
  const issuedTurn = turnOf(g, turn);
  const edge = {
    id: randomUUID(),
    guarantor,
    protected: protectedId,
    targetKind: targetKind(g, protectedId),
    issuedTurn,
    active: true,
    withdrawnTurn: null,
  };
  g.guarantees.push(edge);
  emit(
    g,
    { emit: emitCallback },
    publicRecipients(g),
    `${faction(g, guarantor).name}이 ${faction(g, protectedId).name}의 독립을 공개 보장했어요.`,
    { type: "guarantee", guaranteeId: edge.id, guarantor, protected: protectedId },
  );
  return publicEdge(edge);
}

export function withdrawGuarantee(
  g,
  guarantor,
  protectedId,
  { turn = g.turn, emit: emitCallback } = {},
) {
  ensureGuaranteeState(g);
  const edge = activeEdge(g, guarantor, protectedId);
  if (!edge) fail("철회할 유효한 독립보장이 없어요.");
  const withdrawnTurn = turnOf(g, turn);
  edge.active = false;
  edge.withdrawnTurn = withdrawnTurn;
  for (const call of g.guaranteeCalls) {
    if (call.guaranteeId !== edge.id || call.status !== "pending") continue;
    call.status = "withdrawn";
    call.reason = "guarantee-withdrawn";
    call.resolvedTurn = withdrawnTurn;
  }
  emit(
    g,
    { emit: emitCallback },
    publicRecipients(g),
    `${faction(g, guarantor).name}이 ${faction(g, protectedId).name}에 대한 독립보장을 철회했어요.`,
    {
      type: "guarantee-withdrawn",
      guaranteeId: edge.id,
      guarantor,
      protected: protectedId,
    },
  );
  return publicEdge(edge);
}

const callFor = (g, id) =>
  g.guaranteeCalls.find((call) => call.id === id);
const warExists = (g, key) => (g.wars ?? []).includes(key);
const setRelation = (g, a, b, value, mode = "min") => {
  g.relations ??= {};
  const k = pair(a, b);
  const old = Number.isFinite(g.relations[k]) ? g.relations[k] : 0;
  g.relations[k] = mode === "max" ? Math.max(old, value) : Math.min(old, value);
};

/**
 * Called exactly once after a new attacker -> defender war pair is recorded.
 * The defender's initiative is represented by the argument order, so an
 * edge never fires when the protected faction itself starts the war.
 */
export function onWarDeclared(
  g,
  attacker,
  defender,
  { turn = g.turn, atWar, emit: emitCallback } = {},
) {
  ensureGuaranteeState(g);
  if (
    attacker === defender ||
    !isGuaranteeTarget(g, defender) ||
    isBarbarian(g, attacker)
  )
    return [];
  const issuedTurn = turnOf(g, turn);
  const warKey = pair(attacker, defender);
  const calls = [];
  for (const edge of g.guarantees.filter(
    (candidate) =>
      candidate.active !== false &&
      !candidate.withdrawnTurn &&
      candidate.protected === defender,
  )) {
    // A guarantor cannot be asked to defend while it is the attacker.  No
    // private call is emitted: this is not a decision the guarantor needs to
    // make, and repeated war hooks remain naturally idempotent.
    if (edge.guarantor === attacker) continue;
    if (
      g.guaranteeCalls.some(
        (call) => call.guaranteeId === edge.id && call.warKey === warKey,
      )
    )
      continue;
    // A guarantor already fighting the attacker has no unanswered call to
    // make; adding a resolved pseudo-call would leak confusing state to its
    // UI and is unnecessary for duplicate protection.
    if (atWar?.(g, edge.guarantor, attacker)) continue;
    const call = {
      id: randomUUID(),
      guaranteeId: edge.id,
      guarantor: edge.guarantor,
      protected: defender,
      attacker,
      warKey,
      status: "pending",
      issuedTurn,
      expires: issuedTurn + GUARANTEE_CALL_TTL,
      resolvedTurn: null,
      joinedWarKey: null,
      reason: null,
    };
    g.guaranteeCalls.push(call);
    calls.push(publicCall(call));
    emit(
      g,
      { emit: emitCallback },
      [edge.guarantor],
      `${faction(g, edge.guarantor).name}에게 방위 의무 호출이 도착했어요. ${faction(g, defender).name}을 공격한 ${faction(g, attacker).name}에 참전할지 선택해 주세요.`,
      {
        type: "guarantee-call",
        guaranteeCallId: call.id,
        guaranteeId: edge.id,
        guarantor: edge.guarantor,
        protected: defender,
        attacker,
        expires: call.expires,
      },
    );
  }
  return calls;
}

export function expireGuaranteeCalls(
  g,
  { turn = g.turn, emit: emitCallback } = {},
) {
  ensureGuaranteeState(g);
  const currentTurn = turnOf(g, turn);
  const expired = [];
  for (const call of g.guaranteeCalls) {
    if (call.status !== "pending" || call.expires > currentTurn) continue;
    call.status = "expired";
    call.reason = "call-expired";
    call.resolvedTurn = currentTurn;
    expired.push(publicCall(call));
    emit(
      g,
      { emit: emitCallback },
      [call.guarantor],
      "독립보장 방위 의무 호출의 응답 시간이 지나 만료됐어요.",
      { type: "guarantee-call-expired", guaranteeCallId: call.id },
    );
  }
  return expired;
}

const validatePending = (g, player, callId, turn, options) => {
  ensureGuaranteeState(g);
  expireGuaranteeCalls(g, { turn, emit: options?.emit });
  const call = callFor(g, callId);
  if (!call || call.guarantor !== player)
    fail("응답할 수 있는 독립보장 호출이 없어요.");
  if (call.status !== "pending")
    fail("이 독립보장 호출은 이미 처리됐어요.");
  const edge = g.guarantees.find((candidate) => candidate.id === call.guaranteeId);
  if (!edge || edge.active === false || edge.withdrawnTurn) {
    call.status = "withdrawn";
    call.reason = "guarantee-withdrawn";
    call.resolvedTurn = turnOf(g, turn);
    fail("보장이 철회되어 방위 의무 호출에 응답할 수 없어요.");
  }
  if (!warExists(g, call.warKey)) {
    call.status = "expired";
    call.reason = "war-ended";
    call.resolvedTurn = turnOf(g, turn);
    fail("대상 전쟁이 끝나 방위 의무 호출이 만료됐어요.");
  }
  return call;
};

/** Accept joins only the existing attacker/defender war, atomically. */
export function acceptGuaranteeCall(
  g,
  player,
  callId,
  {
    turn = g.turn,
    atWar,
    announceWar,
    emit: emitCallback,
  } = {},
) {
  const currentTurn = turnOf(g, turn);
  const call = validatePending(g, player, callId, currentTurn, {
    emit: emitCallback,
  });
  if (call.guarantor === call.attacker || call.guarantor === call.protected)
    fail("보장 의무의 참전 대상을 확인할 수 없어요.");
  const joinKey = pair(call.guarantor, call.attacker);
  const alreadyAtWar = atWar?.(g, call.guarantor, call.attacker) || warExists(g, joinKey);
  // All failure checks occur before the first mutation, which keeps an
  // accepted call from leaving a half-applied relationship or war pair.
  if (!alreadyAtWar && !faction(g, call.attacker))
    fail("참전할 공격 문명을 확인할 수 없어요.");
  g.wars ??= [];
  if (!alreadyAtWar) g.wars.push(joinKey);
  if ((g.alliances?.[joinKey] ?? 0) >= currentTurn) delete g.alliances[joinKey];
  setRelation(g, call.guarantor, call.attacker, -30, "min");
  setRelation(g, call.guarantor, call.protected, 20, "max");
  call.status = "accepted";
  call.reason = "defensive-commitment-accepted";
  call.resolvedTurn = currentTurn;
  call.joinedWarKey = joinKey;
  if (!alreadyAtWar)
    announceWar?.(g, call.guarantor, call.attacker, {
      triggerGuarantees: false,
      reason: "guarantee",
    });
  emit(
    g,
    { emit: emitCallback },
    publicRecipients(g),
    `${faction(g, call.guarantor).name}이 독립보장 의무로 ${faction(g, call.attacker).name}과의 전쟁에 참전했어요.`,
    {
      type: "guarantee-accepted",
      guaranteeCallId: call.id,
      guarantor: call.guarantor,
      protected: call.protected,
      attacker: call.attacker,
      warKey: joinKey,
    },
  );
  return publicCall(call);
}

export function rejectGuaranteeCall(
  g,
  player,
  callId,
  { turn = g.turn, emit: emitCallback } = {},
) {
  const currentTurn = turnOf(g, turn);
  const call = validatePending(g, player, callId, currentTurn, {
    emit: emitCallback,
  });
  call.status = "declined";
  call.reason = "defensive-commitment-declined";
  call.resolvedTurn = currentTurn;
  emit(
    g,
    { emit: emitCallback },
    [player],
    "독립보장 방위 의무 호출을 거절했어요. 참전하지 않았어요.",
    { type: "guarantee-declined", guaranteeCallId: call.id },
  );
  return publicCall(call);
}

const visibleUnitStrength = (view, owner) =>
  (view.units ?? [])
    .filter((unit) => unit.owner === owner && !isCivilian(unit))
    .reduce((sum, unit) => {
      const type = TYPES[unit.type];
      if (!type) return sum;
      return sum + type.attack * (unit.size ?? 1) * ((unit.hp ?? 100) / 100);
    }, 0);
const visibleCityStrength = (view, owner) =>
  (view.cities ?? [])
    .filter((city) => city.owner === owner)
    .reduce(
      (sum, city) => sum + 20 + (city.wallLevel ?? 0) * 12 + (city.hp ?? 0) / 20,
      0,
    );
const relationOf = (view, id) =>
  view.factions?.find((f) => f.id === id)?.relation ?? "neutral";

/**
 * Estimate only what a scoped NPC view contains.  Active public edges add a
 * coalition term, but unseen units never come from the game object.
 */
export function npcWarRisk(view, target) {
  const targetStrength =
    visibleUnitStrength(view, target) + visibleCityStrength(view, target);
  const edges = (view.guarantees ?? []).filter(
    (edge) => edge.active !== false && edge.protected === target,
  );
  const backers = edges.map((edge) => {
    const relation = relationOf(view, edge.guarantor);
    const relationFactor =
      relation === "alliance" || relation === "good"
        ? 1.15
        : relation === "bad" || relation === "denounced"
          ? 0.55
          : 0.85;
    return {
      id: edge.guarantor,
      relation,
      strength:
        (visibleUnitStrength(view, edge.guarantor) +
          visibleCityStrength(view, edge.guarantor)) *
        relationFactor,
    };
  });
  const coalitionStrength =
    targetStrength + backers.reduce((sum, backer) => sum + backer.strength, 0);
  const guaranteePenalty = edges.length * 12;
  return {
    target,
    targetStrength,
    backers,
    guaranteeCount: edges.length,
    guaranteePenalty,
    coalitionStrength: coalitionStrength + guaranteePenalty,
  };
}

/** NPC call decisions use only the currently-scoped observation. */
export function npcGuaranteeDecision(view) {
  if (!view?.playerId || view.playerId === "barb") return null;
  const pending = (view.pendingGuaranteeCalls ?? view.guaranteeCalls ?? [])
    .filter((call) => call.status === "pending")
    .sort((a, b) => a.expires - b.expires || String(a.id).localeCompare(String(b.id)));
  const call = pending[0];
  if (!call) return null;
  const own = visibleUnitStrength(view, view.playerId) + visibleCityStrength(view, view.playerId);
  const attacker =
    visibleUnitStrength(view, call.attacker) + visibleCityStrength(view, call.attacker);
  const relation = relationOf(view, call.protected);
  const relationshipBonus =
    relation === "alliance" || relation === "good"
      ? 1.25
      : relation === "bad" || relation === "denounced"
        ? 0.65
        : 1;
  // A direct NPC controller chooses; it never silently joins a war.  If an
  // attacker is unseen, its estimate is zero rather than a hidden-state peek.
  const accept = own > 0 && own * relationshipBonus >= Math.max(18, attacker * 0.9);
  return {
    action: accept ? GUARANTEE_ACTIONS.accept : GUARANTEE_ACTIONS.reject,
    callId: call.id,
  };
}
