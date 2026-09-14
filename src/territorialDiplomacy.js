export function ultimatumDescription(proposal) {
  if (proposal?.demand === "removeCity")
    return `정착 최후통첩 · ${proposal.cityName ?? proposal.cityId ?? "대상 도시"} 자진 철거 요구 · 철거는 되돌릴 수 없고 마지막 도시라면 패배할 수 있어요 · 해당 구역 군대도 즉시 철수 · 수락 시 10턴 재정착·군대 재진입 금지(선전포고 후 해제)`;
  if (proposal?.demand === "withdrawTroops")
    return "철군 최후통첩 · 국경 안과 주변 2칸의 군대를 철수 · 수락 시 10턴 재정착·군대 재진입 금지(선전포고 후 해제)";
  return `금 요구 최후통첩 · ${proposal?.gold ?? 0}G 지급 요구`;
}

export function ultimatumAcceptanceLabel(proposal) {
  if (proposal?.demand === "removeCity") return "도시 철거 및 10턴 금지 수락";
  if (proposal?.demand === "withdrawTroops") return "군대 철수 및 10턴 금지 수락";
  return `${proposal?.gold ?? 0}G 지급하고 수락`;
}

export const isTerritorialUltimatum = (proposal) =>
  proposal?.kind === "ultimatum" && ["removeCity", "withdrawTroops"].includes(proposal.demand);

export function territorialOption(game, factionId) {
  return game?.territorialDiplomacy?.options?.find((option) => option.factionId === factionId) ?? null;
}
