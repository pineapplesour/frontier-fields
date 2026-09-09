// Read only the server's explicitly public relation matrix. The client must
// not infer unknown pairs as neutral: a missing row means that no public
// relation was supplied in this observation.
const matrixSources = (game) => [
  game?.publicRelations,
  game?.publicRelationMatrix,
  game?.relationMatrix,
  game?.relations?.public,
].filter(Boolean);

const relationValue = (entry) => {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  return (
    entry.relation ??
    entry.status ??
    entry.label ??
    entry.state ??
    null
  );
};

function fromMatrix(matrix, fromId, toId) {
  if (Array.isArray(matrix)) {
    const row = matrix.find(
      (entry) =>
        entry &&
        ((entry.from ?? entry.source ?? entry.a) === fromId &&
          (entry.to ?? entry.target ?? entry.b) === toId),
    );
    return relationValue(row);
  }
  if (!matrix || typeof matrix !== "object") return null;
  const row = matrix[fromId];
  if (row && typeof row === "object") {
    const direct = relationValue(row[toId]);
    if (direct != null) return direct;
  }
  const pair = matrix[`${fromId}:${toId}`] ?? matrix[`${fromId}|${toId}`];
  return relationValue(pair);
}

export function publicRelationAt(game, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return "self";
  for (const matrix of matrixSources(game)) {
    const relation = fromMatrix(matrix, fromId, toId);
    if (relation != null) return relation;
  }
  // A per-faction row is also an explicit public API shape; use it only when
  // the backend labels the nested values as publicRelations/publicRelation.
  const faction = game?.factions?.find((entry) => entry.id === fromId);
  const nested = faction?.publicRelations ?? faction?.publicRelation;
  if (nested) {
    const relation = fromMatrix(nested, fromId, toId) ?? relationValue(nested[toId]);
    if (relation != null) return relation;
  }
  return null;
}

const relationDefinitions = [
  {
    keys: ["war", "hostile", "enemy", "conflict"],
    label: "전쟁",
    tone: "war",
    icon: "target",
  },
  {
    keys: [
      "guarantee",
      "guaranteed",
      "guarantor",
      "protecting",
      "independence-guarantee",
      "independent-guarantee",
    ],
    label: "독립보장",
    tone: "guarantee",
    icon: "shield",
  },
  {
    keys: ["alliance", "ally", "allied"],
    label: "동맹",
    tone: "alliance",
    icon: "link",
  },
  {
    keys: ["peace", "truce"],
    label: "평화 협정",
    tone: "peace",
    icon: "shield",
  },
  {
    keys: ["friendly", "good", "friend"],
    label: "우호",
    tone: "friendly",
    icon: "people",
  },
  {
    keys: ["denounced", "denounce", "condemned"],
    label: "공개 비난",
    tone: "denounced",
    icon: "flag",
  },
  {
    keys: ["unfriendly", "bad", "hostile-neutral", "unhappy"],
    label: "불편",
    tone: "unfriendly",
    icon: "flag",
  },
  {
    keys: ["neutral", "unknown", "none"],
    label: "중립",
    tone: "neutral",
    icon: "info",
  },
  {
    keys: ["self"],
    label: "내 문명",
    tone: "self",
    icon: "people",
  },
];

export function relationPresentation(value) {
  if (value == null || value === "")
    return {
      label: "공개 정보 없음",
      tone: "unknown",
      icon: "info",
      known: false,
    };
  const raw = String(value);
  const normalized = raw.toLowerCase();
  const definition = relationDefinitions.find((entry) =>
    entry.keys.includes(normalized),
  );
  return {
    label: definition?.label ?? raw,
    tone: definition?.tone ?? "unknown",
    icon: definition?.icon ?? "info",
    known: true,
  };
}
