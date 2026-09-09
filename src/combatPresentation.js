import { label } from "../shared/rules.js";

export const hasDamage = (effect) =>
  effect?.kind === "damage" && Number.isFinite(effect.amount) && effect.amount > 0;

export const damageAmountText = (amount) =>
  Number.isFinite(amount) && amount > 0 ? `−${amount}` : "없음";

export const damageTotal = (effects, playerId, own) => {
  const receipts = effects.filter(e => e.kind === "combat-result");
  const damage = effects.filter(e => hasDamage(e) && ((e.unit?.owner ?? e.owner) === playerId) === own);
  if (!receipts.length) return damage.reduce((total, e) => total + e.amount, 0);
  return receipts.reduce((total, e) => total + (own ? e.ownDamage : e.opponentDamage), 0) +
    damage.filter(e => !e.receiptCovered).reduce((total, e) => total + e.amount, 0);
};

const coordinate = (value) =>
  value && Number.isFinite(Number(value.q)) && Number.isFinite(Number(value.r))
    ? { q: Number(value.q), r: Number(value.r) }
    : null;

const firstCoordinate = (...values) => {
  for (const value of values) {
    const point = coordinate(value);
    if (point) return point;
  }
  return null;
};

/**
 * Resolve an effect's visual endpoints once. Effects are public outcome data;
 * the renderer must never re-target a projectile by looking up a unit's later
 * position. `to`/`at` are the current server contract, while the extra names
 * let a newer server make the resolved coordinate explicit.
 */
export function resolvedCombatPoint(effect, side = "target") {
  if (!effect) return null;
  return side === "source"
    ? firstCoordinate(
        effect.from,
        effect.sourcePoint,
        effect.attackerAt,
        effect.source,
        effect.attacker,
        effect.origin,
      )
    : firstCoordinate(
        effect.to,
        effect.targetPoint,
        effect.resolvedTarget,
        effect.at,
        effect.target,
      );
}

export function lockedCombatEffect(effect, index = 0) {
  return {
    id: effect?.id ?? `${effect?.kind ?? "effect"}-${index}`,
    kind: effect?.kind ?? "effect",
    index,
    from: resolvedCombatPoint(effect, "source"),
    to: resolvedCombatPoint(effect, "target"),
    resolvedAt: effect?.resolvedAt ?? effect?.resolvedTurn ?? null,
  };
}

export function lockedCombatEffects(effects = []) {
  return effects
    .map((effect, index) => ({ effect, locked: lockedCombatEffect(effect, index) }))
    .filter(({ effect }) =>
      ["attack", "bombard", "impact", "damage"].includes(effect?.kind),
    );
}

// Effects are short-lived outcome data, but polling can deliver the same
// batch again with a newer observation revision. Prefer server event ids; the
// coordinate fallback keeps legacy payloads from replaying within one turn.
export function effectBatchIdentity(effects = [], turn = null) {
  return effects
    .map((effect, index) => {
      if (effect?.id != null) return `id:${effect.id}`;
      const source = resolvedCombatPoint(effect, "source");
      const target = resolvedCombatPoint(effect, "target");
      return JSON.stringify({
        index,
        turn,
        kind: effect?.kind ?? null,
        unitId: effect?.unitId ?? null,
        source,
        target,
        amount: effect?.amount ?? null,
        destroyed: effect?.destroyed ?? false,
      });
    })
    .join("|");
}

// A display key is intentionally tied to the authoritative effect serial and
// the resolved batch. A remounted board starts with no display key, so an old
// effect can remain in the snapshot without replaying its floating result.
export function effectDisplayKey(serial, effects = [], turn = null) {
  const revision = Number(serial);
  const batch = effectBatchIdentity(effects, turn);
  return Number.isFinite(revision) && batch ? `${revision}:${batch}` : null;
}

const numberOrNull = (value) =>
  Number.isFinite(Number(value)) ? Number(value) : null;

const firstNumber = (...values) => {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number != null) return number;
  }
  return null;
};

const booleanValue = (value, fallback = false) => {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = statusKey(value);
    if (["true", "yes", "required", "blocked", "가능"].includes(normalized))
      return true;
    if (["false", "no", "none", "clear", "불가"].includes(normalized))
      return false;
  }
  return fallback;
};

const range = (value) => {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const values = value.map(numberOrNull).filter((number) => number != null);
    if (values.length) return [Math.min(...values), Math.max(...values)];
    return null;
  }
  if (typeof value === "object") {
    const min = numberOrNull(value.min ?? value.low ?? value.from);
    const max = numberOrNull(value.max ?? value.high ?? value.to);
    if (min != null || max != null)
      return [min ?? max, max ?? min];
  }
  const number = numberOrNull(value);
  return number == null ? null : [number, number];
};

const percent = (value) => {
  const n = numberOrNull(value);
  if (n == null) return null;
  const result = n >= 0 && n <= 1 ? n * 100 : n;
  return `${Math.round(result)}%`;
};

export const rangeText = (value, suffix = "") => {
  const values = range(value);
  if (!values) return null;
  const [min, max] = values;
  return min === max
    ? `${Math.round(min)}${suffix}`
    : `${Math.round(min)}~${Math.round(max)}${suffix}`;
};

const statusKey = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const finiteBounds = (value) => {
  const values = range(value);
  return values && values.every((number) => Number.isFinite(number))
    ? values
    : null;
};

const textValue = (value) => {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const named = value.label ?? value.name ?? value.reason ?? value.text;
  if (named != null) return String(named).trim() || null;
  const source =
    value.sourceTerrain ?? value.fromTerrain ?? value.attackerTerrain ?? value.source;
  const target =
    value.targetTerrain ?? value.toTerrain ?? value.defenderTerrain ?? value.target;
  const sourceName = typeof source === "string" ? source : source?.name;
  const targetName = typeof target === "string" ? target : target?.name;
  return sourceName && targetName
    ? `${sourceName} → ${targetName}`
    : null;
};

const detailValue = (value) => {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const text = textValue(value);
  const amount = firstNumber(value.value, value.amount, value.bonus, value.delta);
  if (!text) return amount == null ? null : String(amount);
  if (amount == null) return text;
  const percentAmount =
    value.unit === "%" ||
    value.percent === true ||
    (Math.abs(amount) <= 1 &&
      ["bonus", "delta", "multiplier"].some((key) => key in value));
  const rendered = percentAmount
    ? `${amount > 0 ? "+" : ""}${Math.round(amount * 100)}%`
    : `${amount > 0 ? "+" : ""}${amount}`;
  return `${text} ${rendered}`;
};

const detailList = (...values) =>
  values
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (value == null) return [];
      return [value];
    })
    .map(detailValue)
    .filter(Boolean);

const explicitProbability = (value) => {
  if (!value || typeof value !== "object") return null;
  // A numeric probability is shown only when the server explicitly supplies
  // a distribution/derived outcome object. A loose `chance` field is not
  // enough: the client must never invent or imply hidden RNG math.
  const distribution =
    value.distribution ??
    value.outcomeDistribution ??
    value.damageDistribution ??
    value.deathDistribution;
  if (!distribution || typeof distribution !== "object") return null;
  const supported =
    distribution.supportsProbability === true ||
    distribution.calculated === true ||
    distribution.exact === true;
  if (!supported) return null;
  return percent(
    distribution.probability ??
      distribution.chance ??
      value.probability ??
      value.chance,
  );
};

const outcomeStatus = (value) => {
  if (typeof value === "boolean") return value ? "possible" : "difficult";
  if (typeof value !== "string" && (!value || typeof value !== "object"))
    return null;
  const raw = statusKey(
    typeof value === "string"
      ? value
      : value.status ?? value.state ?? value.certainty ?? value.label,
  );
  if (
    ["certain", "sure", "guaranteed", "확실"].includes(raw) ||
    raw.includes("확실")
  )
    return "certain";
  if (
    ["possible", "can", "cankill", "가능"].includes(raw) ||
    raw.includes("가능")
  )
    return "possible";
  if (
    ["difficult", "unlikely", "cannot", "impossible", "어려움"].includes(raw) ||
    raw.includes("어려움")
  )
    return "difficult";
  if (["high", "likely", "risk", "높음", "위험"].includes(raw))
    return "possible";
  if (["low", "minor", "낮음"].includes(raw)) return "difficult";
  if (["none", "no", "없음", "없다"].includes(raw)) return "none";
  if (
    (typeof value === "object" && value.certain === true) ||
    (typeof value === "object" && value.guaranteed === true)
  )
    return "certain";
  if (typeof value === "object" && (value.possible === true || value.canKill === true))
    return "possible";
  if (typeof value === "object" && (value.possible === false || value.canKill === false))
    return "difficult";
  if (typeof value === "object" && value.death != null)
    return outcomeStatus(value.death);
  if (typeof value === "object" && value.risk != null)
    return outcomeStatus(value.risk);
  return null;
};

const outcomeLabel = {
  certain: "격파확실",
  possible: "격파가능",
  difficult: "격파어려움",
};

const boundsOutcome = (damage, hp) => {
  const bounds = finiteBounds(damage);
  const health = numberOrNull(hp);
  if (!bounds) return null;
  if (health == null || health <= 0) return null;
  if (bounds[0] >= health) return "certain";
  if (bounds[1] >= health) return "possible";
  return "difficult";
};

/**
 * Present only public, server-backed combat bounds. The old shared preview
 * has damage intervals but no probability distribution, so the UI derives
 * the three visible death labels from interval-vs-visible-HP bounds and keeps
 * numeric probabilities hidden unless an exact server distribution exists.
 */
export function combatOutcomePresentation({ preview, attacker, target }) {
  if (!preview || !attacker || !target || target.ghost) return null;
  const city = !target.type;
  const outcome = preview.outcome ?? preview.prediction ?? {};
  const defenderOutcome =
    outcome.enemy ??
    outcome.defender ??
    outcome.target ??
    preview.targetOutcome ??
    preview.kill ??
    preview.enemyDeathCertain ??
    preview.targetDeathCertain ??
    preview.enemyDeath ??
    preview.enemyDeathPossible ??
    preview.targetDeath ??
    preview.defenderDeath;
  const attackerOutcome =
    outcome.own ??
    outcome.attacker ??
    outcome.source ??
    preview.attackerOutcome ??
    preview.ownCasualty ??
    preview.ownCasualtyRisk ??
    preview.attackerDeath;
  const dealt = finiteBounds(
    preview.dealt ?? preview.damageRange ?? preview.enemyDamageRange,
  );
  const received = finiteBounds(
    preview.received ?? preview.counterDamageRange ?? preview.ownDamageRange,
  );
  const enemyStatus =
    outcomeStatus(defenderOutcome) ??
    (!city ? boundsOutcome(dealt, target.hp) : null);
  const ownStatus =
    outcomeStatus(attackerOutcome) ??
    (received?.[1] <= 0 ? "none" : boundsOutcome(received, attacker.hp));
  const presentedEnemyStatus = enemyStatus === "none" ? "difficult" : enemyStatus;
  const advantageLines = detailList(
    preview.advantages,
    preview.modifiers,
    preview.terrainAdvantage,
    preview.structureAdvantage,
    preview.positionAdvantage,
    preview.sourcePositionAdvantage,
    preview.reasonDetails,
  );
  const reasons = Array.isArray(preview.reasons) ? preview.reasons : [];
  const positionReasons = reasons.filter((reason) =>
    /지형|구릉|평원|성벽|요새|도시|방어 태세|구조|고지|terrain|fort|wall/i.test(
      String(reason),
    ),
  );
  const lines = [...new Set([...advantageLines, ...positionReasons])];
  const probability = explicitProbability(outcome) ?? explicitProbability(preview);
  return {
    enemy:
      city || !presentedEnemyStatus
        ? null
        : outcomeLabel[presentedEnemyStatus],
    enemyTone: presentedEnemyStatus ?? "uncertain",
    own:
      ownStatus === "none"
        ? "아군 전사위험 없음"
        : ownStatus === "certain"
        ? "아군 전사확실"
        : ownStatus === "possible"
          ? "아군 전사위험"
          : ownStatus === "difficult"
            ? "아군 전사어려움"
            : null,
    ownTone: ownStatus ?? "uncertain",
    damage: rangeText(dealt),
    received: rangeText(received),
    advantages: lines,
    probability,
    probabilityNote: probability ? "서버가 제공한 판정 분포" : null,
  };
}

/**
 * Convert optional server capture metadata into a short, explicit explanation.
 * Missing metadata is shown as uncertainty rather than inferred as success or
 * failure, so a public observation can never promise a hidden capture result.
 */
export function capturePresentation({ preview, target, attacker, effect }) {
  if (
    !target ||
    target.ghost ||
    target.type ||
    target.structure ||
    target.fort
  )
    return null;
  const raw = preview?.capture ?? preview?.cityCapture ?? {};
  const walls = raw.walls ?? raw.wall ?? {};
  const cityState = raw.city ?? {};
  const entry = raw.entry ?? {};
  const wallHp = firstNumber(
    raw.wallHp,
    raw.wallsHp,
    walls.hp,
    walls.current,
    target.wallHp,
    target.wallsHp,
    target.wall?.hp,
  );
  const wallDamage =
    raw.wallDamage ?? raw.wallsDamage ?? walls.damage ?? preview?.wallDamage;
  const cityHp = firstNumber(raw.cityHp, cityState.hp, target.hp);
  const garrisonBlocked = booleanValue(
    raw.garrisonBlocked ??
      raw.blockedByGarrison ??
      entry.garrisonBlocked ??
      entry.blocked ??
      target.garrisonBlocked,
    false,
  );
  const garrisonProtected = booleanValue(
    raw.garrisonProtected ??
      raw.protectedGarrison ??
      raw.garrison?.protected ??
      cityState.garrisonProtected ??
      target.garrisonProtected ??
      target.garrison?.protected,
    false,
  );
  const requiresEntry = booleanValue(
    raw.requiresEntry ?? raw.entryRequired ?? entry.required,
    true,
  );
  const nextTurn = booleanValue(
    raw.nextTurn ?? raw.requiresNextTurn ?? entry.nextTurn,
    false,
  );
  const status = statusKey(raw.status ?? raw.state ?? raw.blockedBy);
  const canCaptureValue = raw.canCapture ?? raw.captureable ?? raw.ready;
  const canCapture =
    canCaptureValue == null ? null : booleanValue(canCaptureValue, false);
  const cityDamage =
    raw.cityDamage ?? cityState.damage ?? preview?.bodyDamage ?? preview?.dealt;
  const lines = [];
  let tone = "uncertain";

  if (raw.message || raw.reason) lines.push(String(raw.message ?? raw.reason));
  if (["wallbreak", "walls", "wall"].includes(status)) {
    lines.push("성벽을 먼저 모두 무너뜨린 뒤 도시 체력을 줄여야 해요.");
    tone = "blocked";
  } else if (["garrisonblocked", "garrison", "protectedgarrison"].includes(status)) {
    lines.push("주둔군이 남아 있어 도시 진입이 막혀요.");
    tone = "blocked";
  } else if (
    ["nextturn", "nextownturn", "wait", "cityzeroentry", "city0entry"].includes(
      status,
    )
  ) {
    lines.push("이번 판정으로는 점령되지 않아요. 다음 내 턴에 진입해야 해요.");
    tone = "next";
  } else if (["ready", "capture", "capturable"].includes(status)) {
    lines.push("점령 조건이 충족됐어요. 전투 유닛이 도시 칸으로 진입하면 점령해요.");
    tone = "ready";
  }

  if (garrisonBlocked && !lines.some((line) => line.includes("주둔군"))) {
    lines.push("주둔군이 남아 있어 도시 진입이 막혀요.");
    tone = "blocked";
  }
  if (garrisonProtected && cityHp != null && cityHp > 0) {
    lines.push("도시 본체가 0이 될 때까지 주둔군이 보호돼요.");
  }
  if (wallHp != null && wallHp > 0) {
    const wallRange = rangeText(wallDamage);
    lines.push(
      wallRange
        ? `남은 성벽 ${wallHp} · 이번 공격 성벽 피해 ${wallRange}`
        : `남은 성벽 ${wallHp} · 성벽을 먼저 파괴해야 해요`,
    );
    if (wallDamage == null || range(wallDamage)?.[1] < wallHp) tone = "blocked";
  }
  if (cityHp != null && cityHp > 0) {
    const damage = rangeText(cityDamage);
    lines.push(
      damage
        ? `도시 체력 ${cityHp} · 예상 피해 ${damage}`
        : `도시 체력 ${cityHp} · 체력을 0까지 낮춰야 해요`,
    );
    if (tone === "uncertain") tone = "next";
  }
  if (requiresEntry && !lines.some((line) => line.includes("진입"))) {
    lines.push("도시 체력 0 이후 전투 유닛이 도시 칸으로 진입해야 점령해요.");
  }
  if (attacker?.movesLeft <= 0 && requiresEntry && !nextTurn) {
    lines.push("현재 이동력 0 · 공격은 가능하지만 점령 진입은 다음 내 턴이에요.");
    if (tone !== "blocked") tone = "next";
  }
  if (nextTurn && !lines.some((line) => line.includes("다음 내 턴"))) {
    lines.push("점령 진입은 다음 내 턴에 가능해요.");
    tone = "next";
  }
  if (canCapture === true) {
    lines.push("점령 조건 충족 가능");
    tone = "ready";
  } else if (canCapture === false && !lines.length) {
    lines.push("현재 공격으로는 점령할 수 없어요.");
    tone = "blocked";
  }
  const probabilityText =
    explicitProbability(raw) ?? explicitProbability(preview);
  if (probabilityText) lines.push(`점령 확률 ${probabilityText} · 판정 범위 기준`);

  if (!lines.length)
    lines.push("점령 여부는 성벽·도시 체력·주둔군·진입 순서에 따라 달라져요.");
  return {
    label: canCapture === true ? "도시 점령 가능" : "도시 점령 가능 여부",
    tone,
    lines: [...new Set(lines)],
    coordinate: resolvedCombatPoint(effect, "target"),
    uncertainty: probabilityText ? "확률은 현재 공개된 판정 범위예요." : "현재 공개된 상태 기준 · 결과는 전투 판정으로 확정돼요.",
  };
}

export function resolvedCoordinateLabel(effect) {
  const point = resolvedCombatPoint(effect, "target");
  return point ? label(point) : null;
}
