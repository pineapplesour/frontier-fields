import { RESOURCES, equal } from "./rules.js";
export function constructionIssue(view, unit, action) {
  const tile = view.tiles.find((t) => equal(t, unit));
  if (unit?.type !== "builder") return "건축자를 선택해 주세요.";
  if (!unit.charges) return "남은 건설 횟수가 없어요.";
  if (!tile || tile.terrain === "unknown" || tile.terrain === "mountain") return "이동 가능한 탐사된 땅에 건설해 주세요.";
  if (tile.owner !== unit.owner) return "내 도시 영토에서만 건설할 수 있어요. 먼저 영토를 확보해 주세요.";
  if (view.cities.some((c) => equal(c, tile))) return "도시 중심 타일에는 시설을 지을 수 없어요.";
  if (tile.ruin) return "폐허는 먼저 건축자로 복구해야 해요.";
  if (tile.fort?.hp > 0) return "요새가 있는 타일이에요.";
  if (tile.developed) return "자원 시설이 이미 완성되어 있어요.";
  if (action === "develop" && !RESOURCES[tile.resource]) return "철·말·초석 매장지에서 개발할 수 있어요.";
  if (action === "farm" && tile.farm) return "농지가 이미 있어요.";
  return null;
}
