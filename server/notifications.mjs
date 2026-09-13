import { randomUUID } from "node:crypto";
import { RESOURCES } from "../shared/rules.js";

// A notice is an append-only status transition for one proposal or immediate
// transaction. Keep this list deliberately small so clients can safely switch
// on these values without understanding server internals.
export const TRADE_NOTICE_STATUSES = Object.freeze([
  "requested",
  "accepted",
  "rejected",
  "cancelled",
  "expired",
]);

const side = (value, allowedEntities) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  if (typeof value.openBorders === "boolean") result.openBorders = value.openBorders;
  if (Number.isInteger(value.gold) && value.gold >= 0) result.gold = value.gold;
  if (
    value.resources &&
    typeof value.resources === "object" &&
    !Array.isArray(value.resources)
  )
    result.resources = Object.fromEntries(
      Object.entries(value.resources).filter(
        ([resource, amount]) =>
          typeof resource === "string" &&
          Object.hasOwn(RESOURCES, resource) &&
          Number.isInteger(amount) &&
          amount >= 0,
      ),
    );
  for (const field of ["units", "cities"])
    if (Array.isArray(value[field]))
      result[field] = value[field].filter(
        (id) => typeof id === "string" && allowedEntities.has(id),
      );
  if (value.warAgainst === null || typeof value.warAgainst === "string")
    result.warAgainst = value.warAgainst;
  return result;
};

const publicProposal = (g, proposal) => {
  const result = {};
  for (const field of [
    "id",
    "kind",
    "from",
    "to",
    "resource",
    "amount",
    "gold",
    "expires",
    "alliance",
    "peace",
  ]) {
    if (proposal[field] !== undefined) result[field] = proposal[field];
  }
  const participants = new Set([proposal.from, proposal.to]);
  const allowedEntities = new Set(
    [...(g.units ?? []), ...(g.cities ?? [])]
      .filter((entity) => participants.has(entity.owner))
      .map((entity) => entity.id),
  );
  const give = side(proposal.give, allowedEntities),
    receive = side(proposal.receive, allowedEntities);
  if (give) result.give = give;
  if (receive) result.receive = receive;

  // Labels/assets are optional contract disclosures. Restrict both maps to
  // entities named in the two sides, so arbitrary private or third-party data
  // cannot hitch a ride on a notification.
  const ids = new Set([
    ...(give?.units ?? []),
    ...(give?.cities ?? []),
    ...(receive?.units ?? []),
    ...(receive?.cities ?? []),
  ]);
  if (
    proposal.labels &&
    typeof proposal.labels === "object" &&
    !Array.isArray(proposal.labels)
  )
    result.labels = Object.fromEntries(
      Object.entries(proposal.labels).filter(
        ([id, label]) => ids.has(id) && typeof label === "string",
      ),
    );
  if (
    proposal.assets &&
    typeof proposal.assets === "object" &&
    !Array.isArray(proposal.assets)
  ) {
    result.assets = Object.fromEntries(
      Object.entries(proposal.assets)
        .filter(([id]) => ids.has(id))
        .map(([id, asset]) => {
          if (!asset || typeof asset !== "object" || Array.isArray(asset))
            return [id, {}];
          const safe = {};
          for (const field of [
            "type",
            "hp",
            "size",
            "xp",
            "population",
            "capital",
            "wallLevel",
          ])
            if (asset[field] !== undefined) safe[field] = asset[field];
          return [id, safe];
        }),
    );
  }
  return result;
};

/**
 * Append one durable, private trade status to both participating factions.
 * The same notice id is used in both inboxes so clients can de-duplicate a
 * transition while polling. No other faction receives it.
 */
export function notifyTrade(g, proposal, status) {
  if (!TRADE_NOTICE_STATUSES.includes(status))
    throw new Error(`지원하지 않는 거래 알림 상태예요: ${status}`);
  if (
    !proposal ||
    typeof proposal.from !== "string" ||
    typeof proposal.to !== "string" ||
    proposal.from === proposal.to
  )
    return null;

  const participants = [...new Set([proposal.from, proposal.to])];
  g.tradeNotices ??= {};
  for (const player of participants)
    if (!Array.isArray(g.tradeNotices[player])) g.tradeNotices[player] = [];
  const proposalView = publicProposal(g, proposal);
  // A successful operation should invoke this helper once. The guard keeps
  // retries or an accidental second hook from producing duplicate alerts for
  // the same proposal/status while preserving later status transitions.
  for (const player of participants)
    if (
      (g.tradeNotices?.[player] ?? []).some(
        (notice) =>
          notice.status === status &&
          notice.proposal?.id &&
          proposal.id &&
          notice.proposal.id === proposal.id,
      )
    )
      return null;

  const id = randomUUID();
  for (const player of participants) {
    g.tradeNotices[player].push({
      id,
      turn: g.turn,
      status,
      proposal: structuredClone(proposalView),
    });
    if (g.tradeNotices[player].length > 30)
      g.tradeNotices[player].splice(0, g.tradeNotices[player].length - 30);
  }
  return id;
}
