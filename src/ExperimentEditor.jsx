import React, { useState } from "react";
import { TYPES, label, maxHealth, unitMovement, unitAttacks, unitStat } from "../shared/rules.js";

const fields = {
  movement: ["턴당 이동력", 0, 100], attacks: ["턴당 공격 횟수", 0, 100],
  attack: ["기본 공격력", 0, 1000], defense: ["기본 방어력", 1, 1000],
  maxHealth: ["기본 최대 체력 (병력 1개당)", 1, 10000],
  isolationPenalty: ["보급 단절 시 페널티 %", 0, 90],
  riverPenalty: ["도하 후 페널티 %", 0, 90],
  crossingPenalty: ["강 건너 공격 페널티 %", 0, 90],
  woundedPenalty: ["체력 손실 페널티 최대 %", 0, 100],
  jointPenalty: ["합동공격 추가 방향당 페널티 %", 0, 90],
};

export function ExperimentEditor({ game, unit, busy, onEdit }) {
  const [scope, setScope] = useState("current");
  const [field, setField] = useState("movesLeft");
  const [value, setValue] = useState(4);
  const [notice, setNotice] = useState("");
  const currentFields = {
    movesLeft: ["남은 이동력", 0, 100], attacksLeft: ["남은 공격 횟수", 0, 100],
    hp: ["현재 체력", 1, unit ? maxHealth(unit) : 100],
    isolation: ["보급 단절 누적 턴", 0, 10], riverTurns: ["도하 페널티 남은 턴", 0, 20],
  };
  const available = scope === "current" ? currentFields : fields;
  const definition = available[field] ?? Object.values(available)[0];
  return (
    <details className="experiment-editor">
      <summary>유닛 수치 · 자원 소비 설정</summary>
      <div className="experiment-costs">
        <label><input type="checkbox" checked={game.experimentCosts?.upkeep === true} disabled={busy}
          onChange={(e) => onEdit({ action: "experimentCosts", upkeep: e.target.checked, attack: game.experimentCosts?.attack === true })} />부대 유지비 사용 (초석·식량)</label>
        <label><input type="checkbox" checked={game.experimentCosts?.attack === true} disabled={busy}
          onChange={(e) => onEdit({ action: "experimentCosts", upkeep: game.experimentCosts?.upkeep === true, attack: e.target.checked })} />공격 시 초석 소비 사용</label>
        <small>기본은 생산 비용만 사용. 공격 소비만 켜면 매 공격마다 초석을 사용하고, 유지비도 켜면 납부한 턴은 중복 차감하지 않아요.</small>
      </div>
      {unit ? <>
        <p>{label(unit)} {TYPES[unit.type].name} · {game.factions.find((f) => f.id === unit.owner)?.name}</p>
        <p>체력 {unit.hp}/{maxHealth(unit)} · 이동 {unit.movesLeft}/{unitMovement(unit)} · 공격 {unit.attacksLeft ?? (unit.attackUsed ? 0 : unitAttacks(unit))}/{unitAttacks(unit)}회<br />
          공격력 {unitStat(unit, "attack", game.balance?.unitAttack?.[unit.type] ?? TYPES[unit.type].attack)} · 방어력 {unitStat(unit, "defense", TYPES[unit.type].defense)}</p>
        <label>적용 범위<select aria-label="실험 적용 범위" value={scope} onChange={(e) => {
          setScope(e.target.value); setField(e.target.value === "current" ? "movesLeft" : "movement"); setNotice("");
        }}>
          <option value="current">현재 남은 수치</option><option value="temporary">다음 자기 턴까지</option>
          <option value="unit">선택 유닛 영구</option><option value="type">같은 병종 전체 기본값</option>
        </select></label>
        <label>변경 항목<select aria-label="실험 변경 항목" value={field} onChange={(e) => { setField(e.target.value); setNotice(""); }}>
          {Object.entries(available).map(([key, [name]]) => <option key={key} value={key}>{name}</option>)}
        </select></label>
        <label>설정값<input aria-label="실험 설정값" type="number" min={definition[1]} max={definition[2]} step="1" value={value} onChange={(e) => setValue(e.target.value)} /></label>
        <button disabled={busy || !Number.isInteger(Number(value)) || Number(value) < definition[1] || Number(value) > definition[2]}
          onClick={async () => {
            const ok = await onEdit({ action: "experimentEdit", unitId: unit.id, scope, values: { [field]: Number(value) } });
            if (ok) setNotice(`${definition[0]} → ${value} 적용됨`);
          }}>수치 적용</button>
        <small>유닛별 설정이 병종 기본값보다 우선합니다. 병종 기본값은 모든 진영의 기존·신규 유닛에 적용돼요. 페널티 수치는 해당 조건일 때만 적용됩니다. 합동공격은 총 50%까지.</small>
        <span role="status">{notice}</span>
      </> : <p>지도에서 변경할 유닛을 선택하세요.</p>}
    </details>
  );
}
