import React from "react";
import { TYPES } from "../shared/rules.js";
import { rangeText } from "./combatPresentation.js";

// Combat forecast shown in the bottom dock beside the selected unit's
// description. Data (preview / combatOutcome / capture) is derived in
// Board3D from the selected unit and the hovered enemy.
export function CombatForecast({ forecast }) {
  if (!forecast?.preview) return null;
  const { preview, combatOutcome, capture, unit, target } = forecast;
  return (
    <aside className="combat-preview" aria-label="교전 예상">
      <small>
        교전 예상 · {preview.approachFrom ? "접근 후 가정 · 현재 사거리 밖" : preview.legal ? "공격 가능" : "현재 공격 불가"}
      </small>
      <h3>
        {TYPES[unit.type].name} →{" "}
        {target.type
          ? TYPES[target.type].name
          : target.name}
      </h3>
      <div className="forecast-damage">
        <span>
          아군 예상 피해
          <strong>
            {preview.approachUnavailable ? "접근 경로 확인 필요" : `−${combatOutcome?.received ?? rangeText(preview.received ?? preview.counterDamageRange ?? preview.ownDamageRange) ?? "공개 범위 없음"}`}
          </strong>
        </span>
        <span>
          상대 예상 피해
          <strong>
            {preview.approachUnavailable ? "접근 경로 확인 필요" : `−${combatOutcome?.damage ?? rangeText(preview.dealt ?? preview.damageRange ?? preview.enemyDamageRange) ?? "공개 범위 없음"}`}
          </strong>
        </span>
      </div>
      <p>
        유효 공격 {Number.isFinite(Number(preview.attack)) ? Number(preview.attack).toFixed(1) : "공개 범위 없음"} · 방어{" "}
        {Number.isFinite(Number(preview.defense)) ? Number(preview.defense).toFixed(1) : "공개 범위 없음"}
      </p>
      {combatOutcome?.enemy ? (
        <p className={`combat-outcome ${combatOutcome.enemyTone}`}>
          상대 부대 · <strong>{combatOutcome.enemy}</strong>
        </p>
      ) : null}
      {combatOutcome?.own ? (
        <p className={`combat-outcome own-risk ${combatOutcome.ownTone}`}>
          {combatOutcome.own}
        </p>
      ) : null}
      {combatOutcome?.advantages.length ? (
        <div className="combat-advantages">
          <b>지형·구조 보정</b>
          {combatOutcome.advantages.map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>
      ) : null}
      {(preview.reasons ?? [])
        .filter((reason) => !combatOutcome || !combatOutcome.advantages.includes(reason))
        .map((r) => (
        <p key={r}>{r}</p>
        ))}
      {combatOutcome?.probability ? (
        <small>{combatOutcome.probabilityNote} · {combatOutcome.probability}</small>
      ) : null}
      <small>{preview.uncertainty ?? "현재 공개된 상태 기준 · 실제 판정은 서버 결과"}</small>
      {capture ? (
        <div className={`capture-preview capture-${capture.tone}`}>
          <b>{capture.label}</b>
          {capture.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
          <small>{capture.uncertainty}</small>
        </div>
      ) : null}
    </aside>
  );
}
