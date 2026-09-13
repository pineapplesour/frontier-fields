export const ANY_TURN_TRADES = new Set([
  "buy", "sell", "buyUnit", "sellUnit", "disbandUnit", "offerDeal", "issueUltimatum", "offerTrade", "peace", "alliance", "gift",
  "acceptProposal", "rejectProposal", "cancelProposal", "acceptPeace", "rejectPeace", "cancelPeace",
  // Defensive call decisions are responses to a public war event and may be
  // made off-turn.  Issuing/withdrawing a guarantee remains an own-turn
  // unilateral diplomatic action, like denouncement or a declaration of war.
  "acceptGuarantee", "rejectGuarantee",
  // Experiment-practice sandbox actions; the engine rejects them outside an
  // experiment match regardless of turn.
  "spawn", "removeUnit", "experimentEdit", "experimentCosts",
]);
