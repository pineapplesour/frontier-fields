import { randomUUID } from "node:crypto";
import { FACTIONS } from "../shared/rules.js";
import { notifyTrade } from "./notifications.mjs";

// Demands never reserve the recipient's private treasury and never trigger war.
// Refusal and timeout leave the sender's existing explicit war choice intact.
export function handleUltimatum(g, player, raw, { GameError, event, atWar, relation }) {
  const fail = (message) => { throw new GameError(message); };
  const pair = (a, b) => [a, b].sort().join("|");
  if (["acceptProposal", "rejectProposal", "cancelProposal"].includes(raw.action)) {
    const p = g.proposals.find(p => p.id === raw.proposalId && p.kind === "ultimatum");
    if (!p) return false;
    if ((raw.action === "cancelProposal" ? p.from : p.to) !== player)
      fail("응답할 수 없는 최후통첩이에요.");
    if (raw.action === "acceptProposal") {
      if (p.expires <= g.turn) fail("최후통첩 응답 기한이 지났어요.");
      if (atWar(g, p.from, p.to)) fail("이미 전쟁 중인 최후통첩은 수락할 수 없어요.");
      if (!Number.isInteger(p.gold) || p.gold < 1 || (g.gold[player] ?? 0) < p.gold)
        fail("요구한 골드를 지불할 수 없어요.");
      g.gold[player] -= p.gold;
      g.gold[p.from] = (g.gold[p.from] ?? 0) + p.gold;
    }
    const status = raw.action === "acceptProposal" ? "accepted" : raw.action === "cancelProposal" ? "cancelled" : "rejected";
    g.proposals = g.proposals.filter(x => x.id !== p.id);
    notifyTrade(g, p, status);
    event(g, [p.from, p.to], status === "accepted" ? `최후통첩 수락: ${p.gold}G를 지급했어요.` : "최후통첩이 종료됐어요. 전쟁은 별도로 선포해야 해요.");
    return true;
  }
  if (raw.action !== "issueUltimatum") return false;
  const to = raw.factionId, gold = raw.gold, deadline = raw.deadlineTurns ?? 3;
  if (!(g.factions ?? FACTIONS)[to] || to === player || to === "barb") fail("최후통첩을 보낼 문명을 선택해 주세요.");
  if (!Number.isInteger(gold) || gold < 1 || gold > 10000 || !Number.isInteger(deadline) || deadline < 1 || deadline > 10)
    fail("요구 골드는 1~10000G, 응답 기한은 1~10턴으로 지정해 주세요.");
  if (atWar(g, player, to) || relation(g, player, to) === "alliance" || (g.peaceUntil?.[pair(player, to)] ?? -1) >= g.turn)
    fail("전쟁·동맹·평화 협정 중에는 최후통첩을 보낼 수 없어요.");
  if (g.proposals.some(p => pair(p.from, p.to) === pair(player, to))) fail("기존 제안에 먼저 응답해 주세요.");
  const p = { id: randomUUID(), kind: "ultimatum", from: player, to, gold, expires: g.turn + deadline };
  // Conservative rule-based policy: refuse coercive gold demands, without
  // consulting hidden military strength or disclosing private stock levels.
  if (!g.players?.[to] || g.players[to].controller === "npc" || g.players[to].npc) {
    notifyTrade(g, p, "rejected");
    event(g, [player, to], "규칙 기반 문명이 최후통첩을 거절했어요. 전쟁은 별도로 선포해야 해요.");
  } else {
    g.proposals.push(p);
    notifyTrade(g, p, "requested");
    event(g, [player, to], `최후통첩: ${deadline}턴 안에 ${gold}G 지급을 요구했어요. 미응답 시 자동 전쟁은 없어요.`);
  }
  return true;
}
