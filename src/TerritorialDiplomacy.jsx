import React, { useState } from "react";
import { TYPES } from "../shared/rules.js";
import { territorialOption } from "./territorialDiplomacy.js";

export function TerritorialDiplomacy({ game, faction, disabled, onTrade }) {
  const [demand, setDemand] = useState("withdrawTroops");
  const [cityId, setCityId] = useState("");
  const [confirm, setConfirm] = useState(null);
  const option = territorialOption(game, faction.id);
  const cities = option?.cities ?? [];
  const chosenCity = cities.find((city) => city.id === cityId) ?? cities[0];
  const agreements = (game.territorialDiplomacy?.agreements ?? []).filter((record) =>
    (record.from === game.playerId && record.to === faction.id) || (record.to === game.playerId && record.from === faction.id));
  const causes = (game.territorialDiplomacy?.casusBelli ?? []).filter((record) => record.from === game.playerId && record.to === faction.id);
  const eligible = demand === "removeCity" ? !!chosenCity : option?.canWithdrawTroops === true;
  const confirmationKey = `${demand}:${demand === "removeCity" ? chosenCity?.id : "all"}`;
  const confirmed = confirm === confirmationKey;
  return <section className="territorial-diplomacy">
    <h3>국경·정착 최후통첩</h3>
    <p className="description">내 국경 안과 주변 2칸의 정착에 도시 철거를 요구할 수 있어요. 상대 군대가 3턴 연속 관측되면 철군을 요구할 수 있어요.</p>
    {agreements.map((record, index) => <p key={`${record.from}:${record.to}:${index}`} className="fine-print">{record.to === game.playerId ? "내 재정착·군대 재진입" : "상대 재정착·군대 재진입"} 금지 · {record.turnsRemaining ?? Math.max(0, record.until - game.turn)}턴 남음 · 선전포고 후 해제</p>)}
    {causes.map((cause, index) => <p key={`${cause.turn}:${index}`} className="fine-print">명분 획득 · {cause.turn}턴 · 국경 최후통첩 거절 또는 응답 기한 만료 · 명분 전쟁을 선택할 수 있어요.</p>)}
    {!faction.hostile && faction.relation !== "alliance" ? <>
      <label>요구 종류 <select aria-label="국경 최후통첩 종류" value={demand} onChange={(event) => { setDemand(event.target.value); setConfirm(false); }}>
        <option value="withdrawTroops">군대 철수</option><option value="removeCity">도시 자진 철거</option>
      </select></label>
      {demand === "removeCity" ? <label>철거 요구 도시 <select aria-label="철거 요구 도시" value={chosenCity?.id ?? ""} disabled={!cities.length} onChange={(event) => { setCityId(event.target.value); setConfirm(false); }}>
        {!cities.length ? <option value="">현재 관측되는 대상 도시 없음</option> : null}
        {cities.map((city) => <option key={city.id} value={city.id}>{city.name} · {city.q},{city.r}</option>)}
      </select></label> : <>
        <p>연속 주둔 관측 {option?.nearbyMilitaryTurns ?? 0}/3턴</p>
        <ul>{(option?.troops ?? []).map((unit) => <li key={unit.id}>{TYPES[unit.type]?.name ?? unit.type} · {unit.q},{unit.r}</li>)}</ul>
        <p className="fine-print">수락하면 현재 근접 군대 전체가 철수합니다. 위 목록은 현재 관측된 군대예요.</p>
      </>}
      <p className="fine-print">수락: 철거/철군과 10턴 재정착·군대 재진입 금지. 도시 철거 수락 시 해당 구역의 군대도 즉시 철수해요. 거절·기한 만료: 즉시 전쟁 명분 획득, 자동 개전 없이 명분 전쟁을 직접 선택. 응답 기한은 3턴입니다.</p>
      <button className={confirmed ? "danger-button" : "soft-button"} disabled={disabled || !eligible} onClick={async () => {
        if (!confirmed) { setConfirm(confirmationKey); return; }
        if (await onTrade({ action: "issueUltimatum", factionId: faction.id, demand, ...(demand === "removeCity" ? { cityId: chosenCity.id } : {}), deadlineTurns: 3 })) setConfirm(false);
      }}>{confirmed ? "국경 최후통첩 발송 확정" : "국경 최후통첩 보내기"}</button>
      {confirm ? <button className="soft-button" onClick={() => setConfirm(false)}>취소</button> : null}
      {!eligible ? <p className="fine-print">{demand === "removeCity" ? "국경 안·주변 2칸에 현재 관측된 대상 도시가 없어요." : "철군 최후통첩에는 3턴 연속 주둔 관측이 필요해요."}</p> : null}
    </> : null}
  </section>;
}
