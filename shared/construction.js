import { RESOURCES, equal, neighbors, FEATURES } from "./rules.js";
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
  if (action === "farm" && tile.feature === "forest") return "숲을 먼저 베어야 농지를 지을 수 있어요.";
  return null;
}
// Chop (forest) and harvest (wheat or an undeveloped resource deposit) share
// the farm placement rules, except that an unowned tile adjacent to the
// builder's own territory is also allowed.
export function featureActionIssue(view, unit, action) {
  const tile = view.tiles.find((t) => equal(t, unit));
  if (unit?.type !== "builder") return "건축자를 선택해 주세요.";
  if (!unit.charges) return "남은 건설 횟수가 없어요.";
  if (!tile || tile.terrain === "unknown" || tile.terrain === "mountain") return "이동 가능한 탐사된 땅에서만 할 수 있어요.";
  const adjacentOwn = neighbors(tile).some((n) =>
    view.tiles.some((t) => equal(t, n) && t.owner === unit.owner),
  );
  if (tile.owner !== unit.owner && !(tile.owner == null && adjacentOwn))
    return "내 영토이거나 내 영토에 인접한 빈 땅에서만 할 수 있어요.";
  if (view.cities.some((c) => equal(c, tile))) return "도시 중심 타일에서는 할 수 없어요.";
  if (tile.ruin) return "폐허는 먼저 건축자로 복구해야 해요.";
  if (tile.developed) return "자원 시설이 이미 완성되어 있어요.";
  if (action === "chop" && tile.feature !== "forest") return "벨 숲이 없어요.";
  if (action === "harvest" && tile.feature !== "wheat" && !RESOURCES[tile.resource])
    return "수확할 밀밭이나 철·말·초석 매장지가 없어요.";
  if (!view.cities.some((c) => c.owner === unit.owner && !c.camp))
    return "수확물을 받을 아군 도시가 필요해요.";
  return null;
}
export const featureName = (feature) => FEATURES[feature]?.name ?? null;
