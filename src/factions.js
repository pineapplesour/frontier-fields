import { FACTIONS } from "../shared/rules.js";

export const RELATION_COLORS = {
  war: "#d64545",
  alliance: "#3267d6",
  good: "#279d88",
  bad: "#d87924",
  denounced: "#d87924",
  neutral: "#78827e",
};

export const relationColor = (faction) =>
  faction.relation === "self" ? faction.color :
    RELATION_COLORS[faction.relation] ?? RELATION_COLORS.neutral;

// Observations carry the authoritative lobby-defined faction metadata.  The
// static table remains the compatibility fallback for legacy observations.
export function factionFor(game, id) {
  return (
    game?.factions?.find((f) => f.id === id) ??
    FACTIONS[id] ?? {
      id,
      name: id,
      color: "#68756a",
      symbol: "·",
      kind: "independent",
    }
  );
}
