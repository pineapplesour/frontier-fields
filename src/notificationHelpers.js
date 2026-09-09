const incomingProposal = (proposal, playerId) =>
  !!proposal && proposal.to === playerId;

export const noticeProposalId = (notice) =>
  notice?.proposal?.id ?? notice?.proposalId ?? null;

// Event ids are the durable deduplication key. A proposal id is only a
// fallback for synthetic pending notices or older payloads without event ids.
export const noticeKey = (notice) => {
  const identity = notice?.id ?? noticeProposalId(notice);
  return identity == null
    ? null
    : `${identity}:${notice?.status ?? "unknown"}`;
};

const noticeLogicalKey = (notice) => {
  const identity = noticeProposalId(notice) ?? notice?.id;
  return identity == null
    ? null
    : `${identity}:${notice?.status ?? "unknown"}`;
};

export function proposalNotice(proposal, turn) {
  if (proposal?.id == null) return null;
  return {
    id: proposal.id,
    turn: proposal.turn ?? turn,
    status: "requested",
    proposal: structuredClone(proposal),
    synthetic: true,
  };
}

export function noticeCandidates(game) {
  const notices = Array.isArray(game?.tradeNotices)
    ? game.tradeNotices.filter(Boolean)
    : [];
  const pending = (game?.diplomacy ?? [])
    .filter((proposal) => incomingProposal(proposal, game.playerId))
    .map((proposal) => proposalNotice(proposal, game.turn))
    .filter(Boolean);
  const byLogical = new Map();
  // Synthetic pending entries fill gaps in older observations; a real durable
  // event with the same proposal/status should always win over the synthetic
  // fallback. Later durable entries replace earlier copies from polling.
  for (const notice of [...pending, ...notices]) {
    const fingerprint = noticeLogicalKey(notice);
    if (fingerprint) byLogical.set(fingerprint, notice);
  }
  return [...byLogical.values()];
}

export function isPendingIncomingNotice(notice, playerId, diplomacy) {
  const proposalId = noticeProposalId(notice);
  return (
    notice?.status === "requested" &&
    incomingProposal(notice.proposal, playerId) &&
    (diplomacy === undefined ||
      diplomacy.some(
        (proposal) =>
          proposal.id === proposalId && incomingProposal(proposal, playerId),
      ))
  );
}

export function initialNoticeState(game) {
  const seen = new Set();
  const seenLogical = new Set();
  const queue = [];
  for (const notice of noticeCandidates(game)) {
    const fingerprint = noticeKey(notice);
    const logical = noticeLogicalKey(notice);
    const synthetic = notice.synthetic || !notice.id;
    if (!fingerprint) continue;
    if (isPendingIncomingNotice(notice, game.playerId, game.diplomacy))
      queue.push(notice);
    else seen.add(fingerprint);
    if (logical && synthetic) seenLogical.add(logical);
  }
  for (const notice of queue) {
    const fingerprint = noticeKey(notice);
    if (fingerprint) seen.add(fingerprint);
  }
  return { seen, seenLogical, queue };
}

export function appendNoticeUpdates(state, game) {
  const seen = new Set(state?.seen ?? []);
  const seenLogical = new Set(state?.seenLogical ?? []);
  const queue = [...(state?.queue ?? [])];
  for (const notice of noticeCandidates(game)) {
    const fingerprint = noticeKey(notice);
    const logical = noticeLogicalKey(notice);
    const synthetic = notice.synthetic || !notice.id;
    if (
      !fingerprint ||
      seen.has(fingerprint) ||
      (logical && seenLogical.has(logical))
    )
      continue;
    seen.add(fingerprint);
    if (logical && synthetic) seenLogical.add(logical);
    if (
      notice.status === "requested" &&
      !isPendingIncomingNotice(notice, game.playerId, game.diplomacy)
    )
      continue;
    queue.push(notice);
  }
  return { seen, seenLogical, queue };
}

export function dequeueNotice(state) {
  return {
    current: state?.queue?.[0] ?? null,
    queue: state?.queue?.slice(1) ?? [],
  };
}
