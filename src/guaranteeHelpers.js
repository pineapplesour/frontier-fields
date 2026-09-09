// Independent guarantees are deliberately feature-detected. Older match
// observations do not contain this contract, so the client must not invent a
// guarantee (or show an action that the server cannot understand).

const GUARANTEE_SOURCE_NAMES = [
  "guarantees",
  "independentGuarantees",
  "protections",
];

const NOTICE_SOURCE_NAMES = [
  "guaranteeNotices",
  "callToArmsNotices",
  "guaranteeCalls",
  "pendingGuaranteeCalls",
  "defensiveCalls",
];

const PENDING_STATUSES = new Set([
  "pending",
  "requested",
  "proposed",
  "waiting",
  "awaiting",
]);
const INACTIVE_STATUSES = new Set([
  "withdrawn",
  "cancelled",
  "canceled",
  "expired",
  "rejected",
  "declined",
  "inactive",
  "ended",
  "revoked",
]);

const lower = (value) =>
  value == null ? "" : String(value).trim().toLowerCase().replace(/[_\s-]+/g, "");

function statusOf(record) {
  if (record?.active === false || record?.enabled === false) return "inactive";
  const value = lower(
    record?.status ?? record?.state ?? record?.phase ?? record?.lifecycle,
  );
  const kind = lower(record?.kind ?? record?.type ?? record?.proposalKind);
  if (!value && record?.expires != null && kind.includes("guarantee"))
    return "pending";
  if (PENDING_STATUSES.has(value)) return "pending";
  if (INACTIVE_STATUSES.has(value)) return "inactive";
  return "active";
}

function parsePair(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(/\s*(?:\||:|->|>)\s*/);
  return parts.length === 2 && parts[0] && parts[1]
    ? { from: parts[0], to: parts[1] }
    : null;
}

function directedFields(record, pair = null) {
  const from =
    record?.guarantor ??
    record?.guarantorId ??
    record?.guaranteeFrom ??
    record?.issuer ??
    record?.issuerId ??
    record?.protector ??
    record?.protectorId ??
    record?.protecting ??
    record?.fromFaction ??
    record?.from ??
    pair?.from ??
    null;
  const to =
    record?.protected ??
    record?.protectedId ??
    record?.guaranteed ??
    record?.beneficiary ??
    record?.beneficiaryId ??
    record?.protectedFaction ??
    record?.toFaction ??
    record?.guaranteeTo ??
    record?.recipient ??
    record?.to ??
    pair?.to ??
    null;
  return { from, to };
}

function hasDirection(record) {
  return !!directedFields(record).from && !!directedFields(record).to;
}

// Accept arrays, pair maps ("p1|p2"), and nested directed maps without
// treating arbitrary capability metadata as a guarantee record.
function flattenGuarantees(value, pair = null, depth = 0) {
  if (value == null || depth > 4) return [];
  if (Array.isArray(value))
    return value.flatMap((entry) => flattenGuarantees(entry, pair, depth + 1));
  if (typeof value !== "object") {
    return value === true && pair ? [{ ...pair, active: true }] : [];
  }
  if (hasDirection(value) || value.id != null || value.guaranteeId != null)
    return [value];

  for (const name of ["records", "items", "entries", "guarantees", "protections"]) {
    if (value[name] != null)
      return flattenGuarantees(value[name], pair, depth + 1);
  }
  for (const [name, status] of [
    ["active", "active"],
    ["pending", "pending"],
  ]) {
    if (value[name] != null) {
      return flattenGuarantees(value[name], pair, depth + 1).map((entry) => ({
        ...entry,
        status: entry.status ?? status,
      }));
    }
  }
  if (pair) return [{ ...value, ...pair }];

  const entries = Object.entries(value);
  const pairFromKey = entries
    .map(([key]) => [key, parsePair(key)])
    .find(([, parsed]) => parsed)?.[1];
  if (pairFromKey) {
    return entries.flatMap(([key, entry]) => {
      const parsed = parsePair(key);
      return parsed
        ? flattenGuarantees(entry, parsed, depth + 1)
        : [];
    });
  }

  return entries.flatMap(([from, row]) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    return Object.entries(row).flatMap(([to, entry]) => {
      const nextPair = { from, to };
      if (entry && typeof entry === "object" && !Array.isArray(entry))
        return flattenGuarantees(entry, nextPair, depth + 1);
      return entry === true ? [{ ...nextPair, active: true }] : [];
    });
  });
}

function sourceValues(game) {
  const direct = GUARANTEE_SOURCE_NAMES.flatMap((name) => {
    const value = game?.[name];
    return value == null ? [] : [{ value, name }];
  });
  const diplomacy = (game?.diplomacy ?? []).filter((proposal) => {
    const kind = lower(proposal?.kind ?? proposal?.type ?? proposal?.proposalKind);
    return kind.includes("guarantee") || kind === "protection";
  });
  if (diplomacy.length) direct.push({ value: diplomacy, name: "diplomacy" });
  return direct;
}

function normalizeRecord(record, sourceName) {
  if (!record || typeof record !== "object") return null;
  const { from, to } = directedFields(record);
  if (!from || !to || from === to) return null;
  const status =
    sourceName === "diplomacy" &&
    !record.status &&
    !record.state &&
    !record.active
      ? "pending"
      : statusOf(record);
  const explicitId =
    record.id != null || record.guaranteeId != null || record.proposalId != null;
  const id =
    record.id ??
    record.guaranteeId ??
    record.proposalId ??
    `${from}->${to}`;
  return {
    ...record,
    id,
    from,
    to,
    status,
    explicitId,
    source: sourceName,
  };
}

export function guaranteeRecords(game) {
  const deduped = new Map();
  for (const { value, name } of sourceValues(game)) {
    for (const raw of flattenGuarantees(value)) {
      const record = normalizeRecord(raw, name);
      if (!record) continue;
      const key = `${record.id}:${record.from}:${record.to}:${record.status}`;
      deduped.set(key, record);
    }
  }
  return [...deduped.values()];
}

export function supportsGuarantees(game) {
  const capability =
    game?.capabilities?.guarantees ??
    game?.capabilities?.independentGuarantees ??
    game?.capabilities?.independentGuarantee;
  if (
    capability === false ||
    (capability && typeof capability === "object" && capability.enabled === false)
  )
    return false;
  if (
    capability === true ||
    (capability && typeof capability === "object" && capability.enabled !== false)
  )
    return true;
  const hasExplicitCollection = GUARANTEE_SOURCE_NAMES.some((name) =>
    Object.prototype.hasOwnProperty.call(game ?? {}, name),
  );
  return (
    hasExplicitCollection ||
    guaranteeRecords(game).length > 0 ||
    guaranteeNoticeCandidates(game).length > 0
  );
}

export function guaranteeActions(game) {
  const capability =
    game?.capabilities?.guarantees ??
    game?.capabilities?.independentGuarantees ??
    game?.capabilities?.independentGuarantee;
  const capabilityActions =
    capability && typeof capability === "object"
      ? capability.actions ?? capability
      : {};
  const actions = {
    ...(game?.capabilities?.guaranteeActions ?? {}),
    ...capabilityActions,
  };
  return {
    issue: actions.issue ?? actions.create ?? "guarantee",
    withdraw: actions.withdraw ?? actions.revoke ?? "withdrawGuarantee",
    acceptCall: actions.acceptCall ?? actions.accept ?? "acceptGuarantee",
    declineCall:
      actions.declineCall ??
      actions.decline ??
      actions.reject ??
      "rejectGuarantee",
  };
}

export function guaranteeState(game, fromId, toId) {
  const records = guaranteeRecords(game).filter(
    (record) => record.from === fromId && record.to === toId,
  );
  return {
    records,
    active: records.find((record) => record.status === "active") ?? null,
    pending: records.find((record) => record.status === "pending") ?? null,
  };
}

export function guaranteeDirectionLabel(record, viewerId, subjectId, names = {}) {
  if (!record) return "";
  if (record.status === "pending") return "보장 요청 처리 중";
  if (record.from === viewerId && record.to === subjectId) return "독립보장중";
  if (record.to === viewerId && record.from === subjectId) return "보장받음";
  const from = names[record.from] ?? record.from;
  const to = names[record.to] ?? record.to;
  return `${from} → ${to}`;
}

function noticeSources(game) {
  const values = NOTICE_SOURCE_NAMES.flatMap((name) => {
    const value = game?.[name];
    return value == null ? [] : [value];
  });
  const notifications = game?.notifications;
  if (notifications?.guarantees != null) values.push(notifications.guarantees);
  if (notifications?.guaranteeNotices != null)
    values.push(notifications.guaranteeNotices);
  if (notifications?.callToArms != null) values.push(notifications.callToArms);
  if (Array.isArray(game?.events)) values.push(game.events);
  return values;
}

function isCallNotice(value) {
  if (!value || typeof value !== "object") return false;
  const kind = lower(
    value.kind ??
      value.type ??
      value.event ??
      value.notificationType ??
      value.proposal?.kind ??
      value.call?.kind,
  );
  // A public guarantee announcement is not a call-to-arms decision. It is
  // rendered by the ordinary event/war surfaces and must not become a fake
  // consent popup merely because it carries the edge id.
  if (
    kind === "guarantee" &&
    value.guaranteeCallId == null &&
    value.callId == null &&
    value.attacker == null &&
    value.warKey == null
  )
    return false;
  return (
    [
      "guarantee",
      "guaranteecall",
      "calltoarms",
      "defensivecall",
      "defensivewarcall",
      "independentguaranteecall",
    ].includes(kind) ||
    value.guaranteeId != null ||
    value.guarantee != null ||
    value.guarantor != null &&
      (value.protected != null || value.protectedFaction != null)
  );
}

function flattenNotices(value, playerId, depth = 0) {
  if (value == null || depth > 4) return [];
  if (Array.isArray(value))
    return value.flatMap((entry) => flattenNotices(entry, playerId, depth + 1));
  if (typeof value !== "object") return [];
  if (isCallNotice(value)) return [value];
  if (value[playerId] != null)
    return flattenNotices(value[playerId], playerId, depth + 1);
  return Object.values(value).flatMap((entry) =>
    flattenNotices(entry, playerId, depth + 1),
  );
}

function normalizeNotice(raw, turn) {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw.proposal ?? raw.call ?? raw.payload ?? raw;
  const guarantee = raw.guarantee ?? payload.guarantee ?? {};
  const kind = lower(raw.kind ?? raw.type ?? payload.kind ?? payload.type);
  const explicitGuarantor =
    raw.guarantor ??
    payload.guarantor ??
    guarantee.guarantor ??
    raw.guarantorId ??
    payload.guarantorId ??
    raw.defender ??
    payload.defender ??
    raw.defendingFaction ??
    payload.defendingFaction ??
    null;
  const explicitProtected =
    raw.protected ??
    raw.protectedFaction ??
    payload.protected ??
    payload.protectedFaction ??
    guarantee.protected ??
    guarantee.to ??
    raw.defended ??
    payload.defended ??
    raw.defendedFaction ??
    payload.defendedFaction ??
    null;
  const recipient =
    raw.recipient ??
    raw.for ??
    raw.playerId ??
    payload.recipient ??
    payload.for ??
    (kind === "calltoarms" || kind === "guaranteecall" ? raw.to ?? payload.to : null);
  const guarantor =
    explicitGuarantor ??
    recipient ??
    raw.from ??
    payload.from ??
    null;
  const protectedParty =
    explicitProtected ??
    (recipient && (raw.from ?? payload.from) !== recipient
      ? raw.from ?? payload.from
      : raw.to ?? payload.to ?? null);
  const attacker =
    raw.attacker ??
    payload.attacker ??
    raw.attackerId ??
    payload.attackerId ??
    raw.attackingFaction ??
    payload.attackingFaction ??
    null;
  const rawStatus = lower(
    raw.status ?? raw.state ?? payload.status ?? raw.type ?? payload.type ?? "requested",
  );
  const status =
    PENDING_STATUSES.has(rawStatus)
      ? "requested"
      : rawStatus === "guaranteeaccepted"
        ? "accepted"
        : rawStatus === "guaranteedeclined"
          ? "rejected"
          : rawStatus === "guaranteecallexpired"
            ? "expired"
            : rawStatus === "guaranteewithdrawn"
              ? "cancelled"
      : rawStatus === "declined"
        ? "rejected"
        : rawStatus === "canceled"
          ? "cancelled"
          : rawStatus || "requested";
  const callId =
    raw.callId ??
    payload.callId ??
    raw.guaranteeCallId ??
    payload.guaranteeCallId ??
    null;
  const guaranteeId =
    raw.guaranteeId ??
    payload.guaranteeId ??
    guarantee.id ??
    null;
  const id = raw.id ?? raw.noticeId ?? payload.noticeId ?? callId ?? guaranteeId;
  if (!id && !guarantor && !protectedParty) return null;
  const proposal = {
    ...payload,
    id: payload.id ?? id ?? guaranteeId,
    callId: payload.callId ?? callId ?? id,
    guaranteeId,
    guarantor,
    protected: protectedParty,
    attacker,
    from: payload.from ?? guarantor,
    to: payload.to ?? protectedParty,
  };
  return {
    ...raw,
    id: id ?? `${guarantor ?? "?"}->${protectedParty ?? "?"}:${turn}`,
    turn: raw.turn ?? payload.turn ?? turn,
    status,
    kind: "callToArms",
    recipient,
    proposal,
  };
}

function noticeBaseKey(notice) {
  return (
    notice?.proposal?.id ??
    notice?.id ??
    notice?.proposal?.guaranteeId ??
    null
  );
}

export const guaranteeNoticeKey = (notice) => {
  const identity = notice?.id ?? noticeBaseKey(notice);
  return identity == null
    ? null
    : `${identity}:${notice?.status ?? "unknown"}`;
};

export function guaranteeNoticeCandidates(game) {
  const byBase = new Map();
  for (const value of noticeSources(game)) {
    for (const raw of flattenNotices(value, game?.playerId)) {
      const notice = normalizeNotice(raw, game?.turn);
      if (!notice) continue;
      const base = noticeBaseKey(notice) ?? guaranteeNoticeKey(notice);
      // Durable arrays normally append newer lifecycle events. Keeping the
      // latest event for one call avoids showing a stale request after it was
      // accepted/declined while still allowing a later poll to enqueue that
      // lifecycle transition once.
      byBase.set(base, notice);
    }
  }
  return [...byBase.values()];
}

export function isPendingIncomingGuaranteeNotice(notice, playerId) {
  if (!notice || notice.status !== "requested") return false;
  const proposal = notice.proposal ?? {};
  const recipient =
    notice.recipient ??
    notice.for ??
    notice.playerId ??
    proposal.recipient ??
    proposal.guarantor ??
    notice.guarantor;
  return (recipient == null || recipient === playerId) && proposal.guarantor === playerId;
}

export function initialGuaranteeNoticeState(game) {
  const seen = new Set();
  const queue = [];
  for (const notice of guaranteeNoticeCandidates(game)) {
    const key = guaranteeNoticeKey(notice);
    if (!key) continue;
    if (isPendingIncomingGuaranteeNotice(notice, game?.playerId)) queue.push(notice);
    else seen.add(key);
  }
  for (const notice of queue) {
    const key = guaranteeNoticeKey(notice);
    if (key) seen.add(key);
  }
  return { seen, queue };
}

export function appendGuaranteeNoticeUpdates(state, game) {
  const seen = new Set(state?.seen ?? []);
  const queue = [...(state?.queue ?? [])];
  for (const notice of guaranteeNoticeCandidates(game)) {
    const key = guaranteeNoticeKey(notice);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (
      notice.status !== "requested" ||
      isPendingIncomingGuaranteeNotice(notice, game?.playerId)
    )
      queue.push(notice);
  }
  return { seen, queue };
}
