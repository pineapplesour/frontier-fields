import { randomUUID } from "node:crypto";
import { FACTIONS } from "../shared/rules.js";
import { notifyTrade } from "./notifications.mjs";
import { territorialUltimatumOptions, territorialZone, planTerritorialWithdrawal,
  applyTerritorialWithdrawal, acceptTerritorialPromise, recordTerritorialRefusal } from "./diplomacyRules.mjs";

// Demands never reserve the recipient's private treasury and never trigger war.
// Refusal and timeout leave the sender's existing explicit war choice intact.
export function handleUltimatum(g, player, raw, { GameError, event, atWar, relation, observation, razeCity }) {
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
      if (["withdrawTroops", "removeCity"].includes(p.demand)) {
        const zone = g.territorialDemandZones?.[p.id];
        if (!Array.isArray(zone) || !zone.length) fail("최후통첩의 보호 영역을 확인할 수 없어요. 제안을 철회해 주세요.");
        if (p.demand === "removeCity") {
          if (!g.cities?.some(c => c.id === p.cityId && c.owner === player && !c.camp && c.hp > 0))
            fail("철거 대상 도시의 소유권 또는 상태가 바뀌었어요.");
          if (typeof razeCity !== "function") fail("도시 철거 기능을 사용할 수 없어요.");
        }
        const withdrawal = planTerritorialWithdrawal(g, player, zone);
        if (!withdrawal) fail("군사를 안전하게 철수시킬 합법적인 빈 타일이 없어요. 먼저 철수 경로를 확보해 주세요.");
        // All relocation exits are validated first. The engine demolition
        // callback must also validate before changing city/territory state.
        if (p.demand === "removeCity") razeCity(g, player, p.cityId);
        applyTerritorialWithdrawal(withdrawal);
        acceptTerritorialPromise(g, p);
      } else {
        if (!Number.isInteger(p.gold) || p.gold < 1 || (g.gold[player] ?? 0) < p.gold)
          fail("요구한 골드를 지불할 수 없어요.");
        g.gold[player] -= p.gold;
        g.gold[p.from] = (g.gold[p.from] ?? 0) + p.gold;
      }
    }
    const status = raw.action === "acceptProposal" ? "accepted" : raw.action === "cancelProposal" ? "cancelled" : "rejected";
    if (status === "rejected") recordTerritorialRefusal(g, p);
    g.proposals = g.proposals.filter(x => x.id !== p.id);
    if (g.territorialDemandZones) delete g.territorialDemandZones[p.id];
    notifyTrade(g, p, status);
    event(g, [p.from, p.to], status === "accepted"
      ? ["withdrawTroops", "removeCity"].includes(p.demand)
        ? `영토 최후통첩 수락: ${p.demand === "removeCity" ? "도시를 철거하고 " : ""}인근 군사를 합법적인 영역 밖으로 즉시 이전했어요. 10턴 동안 선전포고 전에는 약속한 영역에 군사 이동·정착을 할 수 없어요.`
        : `최후통첩 수락: ${p.gold}G를 지급했어요.`
      : status === "rejected" && p.demand && p.demand !== "gold"
        ? "영토 최후통첩을 거절했어요. 요구한 문명이 즉시 명분 전쟁을 선포할 수 있어요."
        : "최후통첩이 종료됐어요. 전쟁은 별도로 선포해야 해요.");
    return true;
  }
  if (raw.action !== "issueUltimatum") return false;
  const to = raw.factionId, gold = raw.gold, deadline = raw.deadlineTurns ?? 3, demand = raw.demand ?? "gold";
  if (!(g.factions ?? FACTIONS)[to] || to === player || to === "barb") fail("최후통첩을 보낼 문명을 선택해 주세요.");
  if (!["gold", "withdrawTroops", "removeCity"].includes(demand)) fail("지원하지 않는 최후통첩 요구예요.");
  if ((demand === "gold" && (!Number.isInteger(gold) || gold < 1 || gold > 10000)) || !Number.isInteger(deadline) || deadline < 1 || deadline > 10)
    fail("요구 골드는 1~10000G, 응답 기한은 1~10턴으로 지정해 주세요.");
  if (atWar(g, player, to) || relation(g, player, to) === "alliance" || (g.peaceUntil?.[pair(player, to)] ?? -1) >= g.turn)
    fail("전쟁·동맹·평화 협정 중에는 최후통첩을 보낼 수 없어요.");
  if (g.proposals.some(p => pair(p.from, p.to) === pair(player, to))) fail("기존 제안에 먼저 응답해 주세요.");
  let city = null;
  if (demand !== "gold") {
    const eligible = territorialUltimatumOptions(g, player, observation).find(option => option.factionId === to);
    if (demand === "withdrawTroops" && !eligible?.canWithdrawTroops)
      fail("상대 군사가 내 국경과 주변 2칸에 3턴 연속 관측되어야 철군을 요구할 수 있어요.");
    if (demand === "removeCity") {
      city = eligible?.cities.find(candidate => candidate.id === raw.cityId);
      if (!city) fail("현재 관측되는 내 국경과 주변 2칸의 상대 도시를 선택해 주세요.");
    }
  }
  const p = { id: randomUUID(), kind: "ultimatum", demand, from: player, to, ...(demand === "gold" ? { gold } : {}),
    ...(city ? { cityId: city.id, cityName: city.name } : {}), expires: g.turn + deadline };
  // Conservative rule-based policy: refuse coercive gold demands, without
  // consulting hidden military strength or disclosing private stock levels.
  if (!g.players?.[to] || g.players[to].controller === "npc" || g.players[to].npc) {
    recordTerritorialRefusal(g, p);
    notifyTrade(g, p, "rejected");
    event(g, [player, to], demand === "gold" ? "규칙 기반 문명이 최후통첩을 거절했어요. 전쟁은 별도로 선포해야 해요." : "규칙 기반 문명이 영토 최후통첩을 거절했어요. 명분 전쟁을 즉시 선포할 수 있어요.");
  } else {
    if (demand !== "gold") {
      g.territorialDemandZones ??= {};
      g.territorialDemandZones[p.id] = territorialZone(g, player);
    }
    g.proposals.push(p);
    notifyTrade(g, p, "requested");
    event(g, [player, to], demand === "gold"
      ? `최후통첩: ${deadline}턴 안에 ${gold}G 지급을 요구했어요. 미응답 시 자동 전쟁은 없어요.`
      : `영토 최후통첩: ${deadline}턴 안에 ${demand === "removeCity" ? "지정 도시 철거와 인근 군사 철수" : "군사 철수"}를 요구했어요. 수락 시 10턴 동안 재진입·정착이 제한되고 거절·미응답 시 명분 전쟁이 가능해요.`);
  }
  return true;
}
