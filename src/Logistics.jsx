import React, { useEffect, useState } from "react";
import { Icon } from "./Icons.jsx";
import {
  cargoEntries,
  cargoForEntity,
  cargoStatus,
  cityFoodSummary,
  detailedLogisticsState,
  encampmentTargetCandidates,
  facilitySummary,
  logisticsCapability,
  laborSummary,
  manpowerSummary,
  merchantSummary,
  productionLogisticsOptions,
  structureSummary,
  territorySummary,
  unitManpowerSummary,
  unitFoodSummary,
} from "./logisticsHelpers.js";
import { estimateCityProduction } from "./productionHelpers.js";
import { FACTIONS, RESOURCES, TYPES, label } from "../shared/rules.js";

const numberText = (value, suffix = "") =>
  value == null ? "—" : `${value}${suffix}`;

const resourceName = (resource) => RESOURCES[resource]?.name ?? resource;

const resourceEntries = (definition) => {
  const values = definition?.resources ?? definition?.costs ?? {};
  return values && typeof values === "object" ? Object.entries(values) : [];
};

function cityFoodFootnote(summary, showStock) {
  if (showStock) {
    if (summary.net != null && summary.net >= 0)
      return "현재 생산으로 시민·병력 소비를 충당해요.";
    if (summary.starvationTurns == null) return "비축 고갈 예상: 계산 대기";
    if (summary.starvationTurns <= 0)
      return "비축 고갈 · 식량 보급이 필요해요";
    return `현재 소비 기준 ${summary.starvationTurns}턴 보급 가능`;
  }
  return summary.shortage
    ? "잉여 식량이 부족해 성장 진행이 멈추거나 인구가 줄 수 있어요."
    : "저장고 없이 생산·소비 잉여로 성장 속도를 계산해요.";
}

function actionName(capability, names) {
  for (const name of names) {
    const value = capability?.actions?.[name];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export function DetailedLogisticsSetting({ game, busy, onChange }) {
  const state = detailedLogisticsState(game);
  const [pending, setPending] = useState(null);
  if (!state.supported) return null;
  const checked = pending == null ? state.enabled : pending;
  return (
    <div className="settings-section logistics-setting">
      <label htmlFor="detailed-logistics-switch">
        상세 보급 시스템
        <input
          id="detailed-logistics-switch"
          type="checkbox"
          checked={checked}
          disabled={busy || !state.canToggle}
          onChange={(event) => setPending(event.target.checked)}
        />
      </label>
      <p className="description">
        {state.enabled
          ? "비축 모드 ON · 도시 저장 식량, 유닛 식량과 실제 보급 화물을 사용해요."
          : "비축 모드 OFF · 저장 식량·유닛 식량 없이 턴당 생산−인구 소비 잉여로 성장해요. 기존 연결성·포위 규칙은 유지해요."}
        {" 초석 턴 유지비는 ON/OFF 모두 적용되며, 부족해도 기존 부대의 공격을 막지 않아요. 신규 생산에는 자원이 필요해요."}
        {!state.canToggle
          ? " 변경은 일시정지 중 방장만 할 수 있어요."
          : " 전환 전 운송 중 화물은 서버가 한 번만 정산해요."}
      </p>
      {pending != null && pending !== state.enabled ? (
        <div className="logistics-setting-confirm">
          <p>
            {pending
              ? "도시 비축·유닛 식량과 실제 화물 규칙을 켭니다. 기존 성장 진척은 그대로 유지하고 변환하지 않아요."
              : "도시 비축·유닛 식량과 운송 처리를 멈추고 생산−인구 소비 잉여만 계산해요. 기존 성장 진척은 그대로 두며 식량을 성장으로 바꾸지 않아요."}
          </p>
          <div>
            <button
              type="button"
              className="soft-button"
              disabled={busy}
              onClick={() => {
                onChange(pending);
                setPending(null);
              }}
            >
              전환 확인
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              취소
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function CityFoodDetails({ city, game, compact = false }) {
  const summary = cityFoodSummary(city, game);
  if (!summary.available) return null;
  const detailed = detailedLogisticsState(game).enabled;
  const showStock = detailed && summary.stockAvailable;
  return (
    <section className={`logistics-card city-food-details${compact ? " compact" : ""}`}>
      <header>
        <span>
          <Icon name="wheat" size={compact ? 15 : 18} /> 도시 식량
        </span>
        {summary.shortage ? (
          <strong className="logistics-alert">부족</strong>
        ) : (
          <strong className="logistics-good">{showStock ? "비축 중" : "잉여"}</strong>
        )}
      </header>
      <div className="logistics-metrics">
        {showStock ? (
          <span>
            저장 식량<strong>{numberText(summary.stored)}</strong>
          </span>
        ) : null}
        {showStock && summary.capacity != null ? (
          <span>
            저장 한도<strong>{numberText(summary.capacity)}</strong>
          </span>
        ) : null}
        <span>
          {showStock
            ? summary.growthProgressUnit === "fed-turns"
              ? "성장 진척(보급 턴)"
              : "성장 진척"
            : "성장 진척(잉여)"}
          <strong>
            {numberText(summary.progress)}
            {summary.target != null ? ` / ${summary.target}` : ""}
          </strong>
        </span>
        <span>
          생산 / 소비<strong>
            {numberText(summary.production, " / 턴")} · {numberText(summary.consumption, " / 턴")}
          </strong>
        </span>
        {showStock &&
        (summary.civilianFood != null || summary.militaryFood != null) ? (
          <span>
            시민 / 병력 소비<strong>
              {numberText(summary.civilianFood)} · {numberText(summary.militaryFood)} / 턴
            </strong>
          </span>
        ) : null}
        <span>
          순증가<strong>
            {summary.net == null ? "—" : `${summary.net >= 0 ? "+" : ""}${summary.net} / 턴`}
          </strong>
        </span>
      </div>
      <p className="logistics-footnote">
        {cityFoodFootnote(summary, showStock)}
        {summary.growthPaused
          ? " · 식량 부족으로 성장 정지"
          : summary.growthTurns == null
            ? ""
            : ` · 인구 +1까지 약 ${summary.growthTurns}턴`}
      </p>
    </section>
  );
}

const turnText = (value) =>
  value == null ? "—" : value <= 0 ? "이번 턴" : `${value}턴`;

export function ManpowerDetails({ city, game, disabled = false, onTrade, compact = false }) {
  const [type, setType] = useState("spearman");
  const state = detailedLogisticsState(game);
  const summary = manpowerSummary(city, game);
  if (!state.enabled || !summary.available) return null;
  const cancelAction =
    summary.cancelAction ??
    actionName(logisticsCapability(game), [
      "cancelMobilization",
      "cancelManpowerReservation",
      "cancelMobilizationQueue",
    ]);
  const canQueue =
    game?.rulesVersion === "expansion-v1" &&
    detailedLogisticsState(game).enabled &&
    typeof onTrade === "function";
  return (
    <section className={`logistics-card manpower-details${compact ? " compact" : ""}`}>
      <header>
        <span><Icon name="people" size={compact ? 15 : 18} /> 인구 동원</span>
        <strong className={summary.reason ? "logistics-alert" : "logistics-good"}>
          {summary.reason ? "부족" : "예약"}
        </strong>
      </header>
      <div className="logistics-metrics">
        <span>
          시민 예약<strong>{numberText(summary.reserved, "명")}</strong>
        </span>
        <span>
          출병 예정<strong>{numberText(summary.units, "기")}</strong>
        </span>
        <span>
          다음 출병<strong>{turnText(summary.nextDeparture)}</strong>
        </span>
        <span>
          완료 예상<strong>{turnText(summary.turns)}</strong>
        </span>
        {summary.unitType ? (
          <span>
            병종<strong>{TYPES[summary.unitType]?.name ?? summary.unitType}</strong>
          </span>
        ) : null}
        {summary.availableManpower != null ? (
          <span>
            동원 가능<strong>{numberText(summary.availableManpower, "명")}</strong>
          </span>
        ) : null}
      </div>
      {summary.pending?.length ? (
        <p className="logistics-footnote manpower-queue-list">
          {summary.pending.map((entry, index) => {
            const typeName = TYPES[entry.type]?.name ?? entry.type ?? "병력";
            const blocked = entry.blockedReason ? ` · ${entry.blockedReason}` : "";
            return `${index ? " · " : ""}${typeName} 1기${blocked}`;
          }).join("")}
        </p>
      ) : null}
      <p className="logistics-footnote">
        {summary.sequential === true
          ? "도시별 자기 턴에 한 기씩 순차 출병해요. 예약 시민은 출병 전까지 일해요."
          : "예약·출병 순서는 서버가 정한 동원 규칙을 따릅니다."}
        {summary.manpowerPerUnit != null
          ? ` · 1기당 ${summary.manpowerPerUnit}명`
          : ""}
      </p>
      {summary.reason ? <p className="logistics-footnote logistics-alert">{summary.reason}</p> : null}
      {canQueue ? (
        <div className="mobilization-form">
          <label>
            동원 병종
            <select value={type} onChange={(event) => setType(event.target.value)}>
              {Object.entries(TYPES)
                .filter(([, definition]) => !definition.civilian)
                .map(([id, definition]) => (
                  <option key={id} value={id}>{definition.name}</option>
                ))}
            </select>
          </label>
          <button
            className="soft-button logistics-action"
            disabled={disabled}
            onClick={() => onTrade({ action: "mobilizeUnit", cityId: city.id, type })}
          >
            1기 예약
          </button>
        </div>
      ) : null}
      {cancelAction && summary.pending?.[0]?.id && onTrade ? (
        <button
          className="soft-button logistics-action"
          disabled={disabled}
          onClick={() =>
            onTrade({
              action: cancelAction,
              cityId: city.id,
              mobilizationId: summary.pending[0].id,
            })
          }
        >
          동원 예약 취소
        </button>
      ) : null}
    </section>
  );
}

function assignmentEntries(assignments) {
  if (Array.isArray(assignments)) return assignments;
  if (assignments && typeof assignments === "object")
    return Object.entries(assignments).map(([name, count]) => ({ name, count }));
  return [];
}

function laborSlotLabel(slot) {
  if (!slot) return "시설";
  if (slot.kind === "farm") return "농지";
  if (slot.kind === "resource") return RESOURCES[slot.resource]?.name ?? "자원 시설";
  if (slot.kind === "trade") return "교역소";
  if (slot.kind === "production") return "도심 생산";
  return slot.name ?? slot.kind ?? "시설";
}

function laborYieldLabel(yieldType) {
  if (yieldType === "food") return "식량";
  if (yieldType === "production") return "생산력";
  if (yieldType === "gold") return "골드";
  return RESOURCES[yieldType]?.name ?? yieldType ?? "배치 가능";
}

export function LaborDetails({
  city,
  game,
  disabled = false,
  onCitizenSettings,
  compact = false,
}) {
  if (!detailedLogisticsState(game).enabled) return null;
  const summary = laborSummary(city);
  if (!summary.available) return null;
  const assignments = assignmentEntries(summary.assignments).slice(0, 4);
  const slots = (summary.slotList ?? []).slice(0, compact ? 4 : 8);
  const locked = new Set(summary.lockedSlots ?? []);
  const updatePolicy = (next) =>
    onCitizenSettings?.(city.id, {
      auto: next.auto ?? summary.auto,
      lockedSlots: next.lockedSlots ?? [...locked],
      priority: next.priority ?? summary.priority ?? [],
    });
  return (
    <section className={`logistics-card labor-details${compact ? " compact" : ""}`}>
      <header>
        <span><Icon name="tools" size={compact ? 15 : 18} /> 노동 배치</span>
        <strong>{summary.mode === "manual" ? "수동" : "자동"}</strong>
      </header>
      <div className="logistics-metrics">
        <span>
          배치 노동자<strong>{numberText(summary.assigned, "명")}</strong>
        </span>
        <span>
          사용 가능 자리<strong>{numberText(summary.slots, "칸")}</strong>
        </span>
        {summary.budget != null ? (
          <span>
            시민 예산<strong>{numberText(summary.budget, "명")}</strong>
          </span>
        ) : null}
      </div>
      {assignments.length ? (
        <p className="logistics-footnote">
          {assignments.map((entry, index) => {
            const name = laborSlotLabel(entry) ?? entry?.facility ?? "시설";
            const count = entry?.count ?? entry?.workers ?? entry?.amount;
            return `${index ? " · " : ""}${name}${count == null ? "" : ` ${count}명`}`;
          }).join("")}
        </p>
      ) : null}
      {slots.length ? (
        <div className="citizen-slot-list" aria-label="시민 노동 슬롯">
          {slots.map((slot) => {
            const isLocked = locked.has(slot.id);
            return (
              <button
                key={slot.id}
                type="button"
                className={`citizen-slot${isLocked ? " locked" : ""}`}
                disabled={disabled || !onCitizenSettings}
                onClick={() => {
                  const next = new Set(locked);
                  if (next.has(slot.id)) next.delete(slot.id);
                  else next.add(slot.id);
                  updatePolicy({ lockedSlots: [...next] });
                }}
                aria-pressed={isLocked}
                data-tip={isLocked ? "이 슬롯을 자동 배치에서 고정 해제" : "이 슬롯에 시민을 우선 고정"}
              >
                <span>{laborSlotLabel(slot)}</span>
                <small>{isLocked ? "고정" : laborYieldLabel(slot.yield)}</small>
              </button>
            );
          })}
        </div>
      ) : null}
      {onCitizenSettings ? (
        <label className="citizen-auto-toggle">
          자동 배치
          <input
            type="checkbox"
            checked={summary.auto !== false}
            disabled={disabled}
            onChange={(event) => updatePolicy({ auto: event.target.checked })}
          />
        </label>
      ) : null}
      {summary.issue ? <p className="logistics-footnote logistics-alert">{summary.issue}</p> : null}
      <p className="logistics-footnote">
        동원된 시민은 실제 노동 산출에서 빠지고, 해산 시 기록된 생존 인구만 반환돼요.
      </p>
    </section>
  );
}

export function UnitManpowerDetails({ unit, game, compact = false }) {
  if (!detailedLogisticsState(game).enabled) return null;
  const summary = unitManpowerSummary(unit);
  if (!summary.available) return null;
  const home = (game.cities ?? []).find((city) => city.id === summary.homeCityId);
  return (
    <section className={`logistics-card unit-manpower-details${compact ? " compact" : ""}`}>
      <header>
        <span><Icon name="people" size={compact ? 15 : 18} /> 인구 원장</span>
        <strong className="logistics-good">기록됨</strong>
      </header>
      <p className="logistics-footnote">
        기록된 동원 인구 <strong>{numberText(summary.tracked, "명")}</strong>
        {home ? ` · 원도시 ${home.name}` : ""}
        · 해산 시에만 현재 지배 문명으로 반환돼요.
      </p>
    </section>
  );
}

export function UnitFoodDetails({ unit, game, compact = false, disabled = false, onTrade }) {
  const [sourceCityId, setSourceCityId] = useState("");
  const [amount, setAmount] = useState(1);
  const [targetReserve, setTargetReserve] = useState(() =>
    Math.max(0, Number(unit?.targetReserve) || 0),
  );
  useEffect(() => {
    setTargetReserve(Math.max(0, Number(unit?.targetReserve) || 0));
  }, [unit?.id, unit?.targetReserve]);
  const state = detailedLogisticsState(game);
  const capability = logisticsCapability(game);
  const shipAction = actionName(capability, ["shipFoodToUnit", "sendFoodToUnit"]);
  const reserveAction = actionName(capability, ["setUnitFoodReserve", "setUnitReserve"]);
  const summary = unitFoodSummary(unit, game);
  const sourceCities = (game?.cities ?? []).filter(
    (city) => city.owner === game.playerId && !city.camp,
  );
  const selectedSourceCityId = sourceCities.some((city) => city.id === sourceCityId)
    ? sourceCityId
    : sourceCities.find((city) => city.id === unit?.homeCityId)?.id ?? sourceCities[0]?.id ?? "";
  if (!state.enabled || !summary.available) return null;
  return (
    <section className={`logistics-card unit-food-details${compact ? " compact" : ""}`}>
      <header>
        <span>
          <Icon name="wheat" size={compact ? 15 : 18} /> 유닛 보급
        </span>
        {summary.shortage ? (
          <strong className="logistics-alert">고갈</strong>
        ) : (
          <strong className="logistics-good">보급됨</strong>
        )}
      </header>
      <div className="logistics-metrics">
        <span>
          휴대 식량<strong>{numberText(summary.stock)}</strong>
        </span>
        <span>
          턴 소비<strong>{numberText(summary.consumption, " / 턴")}</strong>
        </span>
        <span>
          보급 가능<strong>{numberText(summary.starvationTurns, "턴")}</strong>
        </span>
        {summary.penalty != null ? (
          <span>
            전투 영향<strong>−{summary.penalty}</strong>
          </span>
        ) : null}
      </div>
      {summary.shortage ? (
        <p className="logistics-footnote">식량 부족이 길어질수록 공격력이 낮아져요.</p>
      ) : null}
      {unit.owner === game.playerId && (shipAction || reserveAction) ? (
        <div className="shipment-form unit-food-controls">
          {shipAction && sourceCities.length ? (
            <>
              <label>
                출발 도시
                <select
                  value={selectedSourceCityId}
                  onChange={(event) => setSourceCityId(event.target.value)}
                >
                  {sourceCities.map((city) => (
                    <option key={city.id} value={city.id}>{city.name}</option>
                  ))}
                </select>
              </label>
              <label>
                보급 수량
                <input
                  type="number"
                  min="1"
                  value={amount}
                  onChange={(event) => setAmount(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
              <button
                className="soft-button logistics-action"
                disabled={disabled || !selectedSourceCityId || !onTrade}
                onClick={() => onTrade({
                  action: shipAction,
                  fromCityId: selectedSourceCityId,
                  toUnitId: unit.id,
                  unitId: unit.id,
                  amount,
                })}
              >
                유닛에 보급 보내기
              </button>
            </>
          ) : null}
          {reserveAction ? (
            <>
              <label>
                유닛 목표량
                <input
                  type="number"
                  min="0"
                  value={targetReserve}
                  disabled={disabled}
                  onChange={(event) =>
                    setTargetReserve(Math.max(0, Number(event.target.value) || 0))
                  }
                />
              </label>
              <button
                className="soft-button logistics-action"
                disabled={disabled || !onTrade}
                onClick={() => onTrade({
                  action: reserveAction,
                  unitId: unit.id,
                  targetReserve,
                  target: targetReserve,
                })}
              >
                유닛 목표량 적용
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function statusLabels(summary) {
  const labels = [];
  if (summary.scorched) labels.push("청야");
  if (summary.plundered) labels.push("약탈됨");
  if (summary.repairRequired || summary.ruined) labels.push("복구 필요");
  return labels;
}

export function FacilityStatus({ tile, game, unit, disabled = false, onAction }) {
  const summary = facilitySummary(tile, game);
  if (!summary.available) return null;
  const labels = statusLabels(summary);
  const repairAction =
    typeof summary.repairAction === "string"
      ? summary.repairAction
      : summary.repairAction?.action ?? null;
  const farmAction =
    logisticsCapability(game).facilityActions?.farm ??
    logisticsCapability(game).facilityActions?.facility ??
    {};
  const action =
    typeof farmAction === "object" ? farmAction.action ?? null : null;
  const actionLabel =
    typeof farmAction === "object" ? farmAction.label ?? null : null;
  const isOwnMilitary =
    unit?.owner === game.playerId && TYPES[unit.type]?.civilian !== true;
  const isBuilder = unit?.owner === game.playerId && unit.type === "builder";
  const faction = game.factions?.find((candidate) => candidate.id === tile.owner);
  const atWar =
    tile.hostile === true ||
    faction?.hostile === true ||
    game.conflicts?.some(
      (pair) =>
        Array.isArray(pair) &&
        pair.includes(game.playerId) &&
        pair.includes(tile.owner),
    );
  const actualAction =
    action ??
    (game.rulesVersion === "expansion-v1"
      ? tile.owner === game.playerId
        ? "scorch"
        : atWar
          ? "pillage"
          : null
      : null);
  const actualActionLabel =
    actionLabel ?? (actualAction === "pillage" ? "약탈" : actualAction === "scorch" ? "청야" : null);
  const canImproveAction =
    isOwnMilitary &&
    !summary.repairRequired &&
    (tile.owner === game.playerId || atWar) &&
    actualAction;
  return (
    <section className={`logistics-card facility-status${labels.length ? " has-ruin" : ""}`}>
      <header>
        <span>
          <Icon name={summary.kind === "farm" ? "wheat" : "hammer"} size={17} />
          시설 상태
        </span>
        {labels.length ? (
          <strong className="logistics-alert">{labels.join(" · ")}</strong>
        ) : (
          <strong className="logistics-good">운영 중</strong>
        )}
      </header>
      {summary.kind ? (
        <p>
          {summary.kind === "farm"
            ? "농지"
            : summary.kind === "resource"
              ? RESOURCES[tile.resource]?.improvement ?? "자원 시설"
              : summary.kind}
        </p>
      ) : null}
      {summary.scorched || summary.plundered ? (
        <p className="logistics-footnote">
          청야·약탈은 시설 수익을 멈추고, 건축자의 복구가 필요해요.
        </p>
      ) : null}
      {summary.kind === "farm" && summary.heal === 50 ? (
        <p className="logistics-footnote">
          청야 또는 약탈 시 아군 병력 1개체에 총 <strong>+50 HP</strong> (최대 체력까지만)를 적용해요.
        </p>
      ) : null}
      {repairAction && isBuilder && onAction ? (
        <button
          className="soft-button logistics-action"
          disabled={disabled}
          onClick={() => onAction(repairAction, { target: { q: tile.q, r: tile.r } })}
        >
          <Icon name="tools" size={15} /> 시설 복구
        </button>
      ) : canImproveAction && onAction ? (
        <button
          className="soft-button logistics-action"
          disabled={disabled}
          onClick={() => onAction(actualAction, { target: { q: tile.q, r: tile.r } })}
        >
          {actualActionLabel ?? (actualAction === "pillage" ? "약탈" : "청야")}
        </button>
      ) : null}
    </section>
  );
}

export function TerritoryAssignmentDetails({ tile, game, disabled = false, onTrade }) {
  // Keep this hook before the capability/observation guard.  A tile can move
  // between an unassigned observation and an owned tile while polling; hook
  // order must not depend on which shape arrived in that render.
  const [destination, setDestination] = useState("");
  const summary = territorySummary(tile, game);
  if (!summary.available) return null;
  const own = summary.owner === game.playerId;
  const cities = game.cities ?? [];
  const currentCity = cities.find((city) => city.id === summary.cityId);
  const ownerName =
    game.factions?.find((faction) => faction.id === summary.owner)?.name ??
    FACTIONS[summary.owner]?.name ??
    summary.owner ??
    "소속 확인 중";
  const currentCityName =
    summary.cityName ?? currentCity?.name ?? (summary.cityId ?? "소속 도시 확인 중");
  const options = summary.options
    .map((option) => {
      if (typeof option === "string") {
        const city = cities.find((candidate) => candidate.id === option);
        return { id: option, name: city?.name ?? option };
      }
      const id = option?.id ?? option?.cityId;
      return {
        id,
        name:
          option?.name ??
          cities.find((candidate) => candidate.id === id)?.name ?? id,
        disabled:
          option?.allowed === false ||
          option?.eligible === false ||
          option?.disabled === true,
        reason:
          option?.reason ??
          option?.issue ??
          option?.unavailableReason ??
          null,
      };
    })
    .filter((option) => option.id != null);
  const eligibleOptions = options.filter((option) => !option.disabled);
  const blockedOptions = options.filter((option) => option.disabled);
  const action = typeof summary.action === "string" ? summary.action : null;
  const selectedDestination = eligibleOptions.some((option) => option.id === destination)
    ? destination
    : eligibleOptions[0]?.id ?? "";
  const reason = summary.isCenter
    ? "도심 타일은 양도할 수 없어요."
    : summary.issue
      ? String(summary.issue)
      : !own
        ? "내 문명의 타일만 재배정할 수 있어요."
        : eligibleOptions.length
          ? ""
          : "재배정 가능한 아군 도시가 없어요.";
  return (
    <section className="logistics-card territory-assignment">
      <header>
        <span><Icon name="layers" size={17} /> 타일 소속</span>
        <strong className={own ? "logistics-good" : "logistics-alert"}>{ownerName}</strong>
      </header>
      <p>
        현재 소속 도시 <strong>{currentCityName}</strong>
      </p>
      {blockedOptions.length ? (
        <p className="logistics-footnote logistics-alert">
          {blockedOptions
            .map((option) => `${option.name}: ${option.reason ?? "서버 검증상 불가"}`)
            .join(" · ")}
        </p>
      ) : null}
      {reason ? <p className="logistics-footnote logistics-alert">{reason}</p> : null}
      {own && !summary.isCenter && eligibleOptions.length ? (
        <div className="territory-form">
          <label>
            재배정 도시
            <select value={selectedDestination} onChange={(event) => setDestination(event.target.value)}>
              {eligibleOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>
          <button
            className="soft-button logistics-action"
            disabled={disabled || !action || !selectedDestination || selectedDestination === summary.cityId || !onTrade}
            onClick={() => onTrade({ action, target: { q: tile.q, r: tile.r }, cityId: selectedDestination })}
          >
            도시 소속 변경
          </button>
        </div>
      ) : null}
      {own && !summary.isCenter && !action && eligibleOptions.length ? (
        <p className="logistics-footnote">재배정 가능 도시를 확인했지만 서버 작업 계약이 아직 제공되지 않았어요.</p>
      ) : null}
      <p className="logistics-footnote">
        주는 도시와 받는 도시의 도심·연결 영토를 서버가 함께 검증해요.
      </p>
    </section>
  );
}

export function StructureStatus({ tile, game }) {
  const summary = structureSummary(tile, game);
  if (!summary.available) return null;
  const structureLabel =
    summary.kind === "fort"
      ? "요새"
      : summary.kind === "bastion"
        ? "거점"
        : "주둔지";
  return (
    <section className="logistics-card structure-status">
      <header>
        <span>
          <Icon name="walls" size={17} /> {structureLabel}
        </span>
        <strong className={summary.repairRequired ? "logistics-alert" : "logistics-good"}>
          {summary.captured
            ? "점령됨 · 위치 사용 가능"
            : summary.repairRequired
              ? "복구 필요"
              : summary.built
                ? "운영 중"
                : "상태 확인 중"}
        </strong>
      </header>
      <div className="logistics-metrics">
        <span>
          시설 HP<strong>{numberText(summary.hp)}{summary.maxHp != null ? ` / ${summary.maxHp}` : ""}</strong>
        </span>
        <span>
          성벽 HP<strong>{numberText(summary.walls)}</strong>
        </span>
      </div>
      <p className="logistics-footnote">
        {summary.captured
          ? "점령 즉시 소유권이 바뀌지만, 시설 HP를 되살리려면 복구가 필요해요."
          : "도시 중심 타일 밖의 위치 보너스와 성벽 상태를 표시해요."}
      </p>
    </section>
  );
}

export function MerchantStatus({ city, game, disabled = false, onTrade }) {
  const [destination, setDestination] = useState("");
  const [kind, setKind] = useState("resource");
  const [resource, setResource] = useState("iron");
  const [amount, setAmount] = useState(1);
  const summary = merchantSummary(game, city);
  if (!summary.available) return null;
  const capability = logisticsCapability(game);
  const queueAction = actionName(capability, ["queueMerchant"]);
  const routeAction = actionName(capability, ["merchantRoute", "sendMerchant"]);
  const merchants = (game.units ?? []).filter(
    (unit) =>
      unit.owner === game.playerId &&
      unit.type === "merchant" &&
      (unit.tradingPostCityId === city.id || unit.homeCityId === city.id),
  );
  const destinations = (game.cities ?? []).filter(
    (candidate) => candidate.owner === game.playerId && candidate.id !== city.id && !candidate.camp,
  );
  const selectedDestination = destinations.some((candidate) => candidate.id === destination)
    ? destination
    : destinations[0]?.id ?? "";
  const selectedMerchant = merchants[0];
  const detailed = detailedLogisticsState(game).enabled;
  return (
    <section className="logistics-card merchant-status">
      <header>
        <span>
          <Icon name="link" size={17} /> 교역소 · 상인
        </span>
        <strong className={summary.remaining ? "logistics-good" : "logistics-alert"}>
          {summary.built ? "건설됨" : "건설 필요"}
        </strong>
      </header>
      <div className="logistics-metrics">
        <span>
          상인 정원<strong>{summary.inUse} / {summary.capacity}</strong>
        </span>
        <span>
          이동 중<strong>{summary.traveling}</strong>
        </span>
        <span>
          예약<strong>{summary.ordered}</strong>
        </span>
      </div>
      <p className="logistics-footnote">
        도시마다 교역소 1개 · 활성·이동·예약 상인을 모두 정원에 포함해요.
      </p>
      {queueAction && summary.built && summary.remaining > 0 && onTrade ? (
        <button
          className="soft-button logistics-action"
          disabled={disabled}
          onClick={() => onTrade({ action: queueAction, cityId: city.id })}
        >
          상인 1명 생산 예약
        </button>
      ) : null}
      {routeAction && selectedMerchant && destinations.length && onTrade ? (
        <div className="shipment-form merchant-route-form">
          <label>
            목적지 도시
            <select
              value={selectedDestination}
              disabled={disabled}
              onChange={(event) => setDestination(event.target.value)}
            >
              {destinations.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
          </label>
          <label>
            화물 종류
            <select value={kind} disabled={disabled} onChange={(event) => setKind(event.target.value)}>
              {detailed ? <option value="food">식량</option> : null}
              <option value="resource">자원</option>
            </select>
          </label>
          {kind === "resource" ? (
            <label>
              자원
              <select value={resource} disabled={disabled} onChange={(event) => setResource(event.target.value)}>
                {Object.entries(RESOURCES).map(([id, definition]) => (
                  <option key={id} value={id}>{definition.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            수량
            <input
              type="number"
              min="1"
              value={amount}
              disabled={disabled}
              onChange={(event) => setAmount(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          <button
            className="soft-button logistics-action"
            disabled={disabled || !selectedDestination}
            onClick={() => onTrade({
              action: routeAction,
              merchantId: selectedMerchant.id,
              fromCityId: city.id,
              toCityId: selectedDestination,
              kind,
              resource: kind === "resource" ? resource : null,
              amount,
            })}
          >
            화물 운송 시작
          </button>
        </div>
      ) : null}
    </section>
  );
}

function productionOptionCopy(type, definition) {
  if (definition?.placement === "offCenter" || definition?.placement === "outsideCityCenter")
    return "도시 중심 밖의 빈 타일에 배치해요.";
  if (type === "tradingPost" || type === "tradingpost")
    return "도시마다 1개 · 상인 1명 정원";
  if (type === "merchant") return "생산 후 출발 도시와 목적지 도시를 선택해요.";
  return definition?.description ?? "확장 생산 항목";
}

export function LogisticsProductionOptions({ game, city, disabled, onChoose, encampmentTarget: controlledTarget, onEncampmentTarget, onPickEncampment }) {
  const [localTarget, setLocalTarget] = useState("");
  const encampmentTarget = controlledTarget ?? localTarget;
  const setEncampmentTarget = onEncampmentTarget ?? setLocalTarget;
  const options = productionLogisticsOptions(game, city);
  if (!options.length) return null;
  const inventory = game.economy?.resources ?? {};
  const queueDefinition = options.find(([type]) => type === city.queue)?.[1];
  const encampmentOption = options.find(([type, definition]) =>
    type === "encampment" && definition?.requiresTarget,
  );
  const encampmentTargets = encampmentOption
    ? encampmentTargetCandidates(game, city)
    : [];
  const selectedEncampmentTarget = encampmentTargets.some(
    (tile) => `${tile.q},${tile.r}` === encampmentTarget,
  )
    ? encampmentTarget
    : encampmentTargets[0]
      ? `${encampmentTargets[0].q},${encampmentTargets[0].r}`
      : "";
  const targetPoint = selectedEncampmentTarget
    ? selectedEncampmentTarget.split(",").map(Number)
    : null;
  return (
    <section className="logistics-production-options">
      <h3>교역·주둔지</h3>
      {encampmentOption ? (
        <label className="production-target-picker">
          주둔지 배치 타일
          <select
            value={selectedEncampmentTarget}
            disabled={disabled || !encampmentTargets.length}
            onChange={(event) => setEncampmentTarget(event.target.value)}
          >
            {encampmentTargets.map((tile) => (
              <option key={`${tile.q},${tile.r}`} value={`${tile.q},${tile.r}`}>
                {label(tile)} · {tile.terrain === "hills" ? "구릉지" : "평지"}
              </option>
            ))}
          </select>
          {onPickEncampment ? <button type="button" className="soft-button full" disabled={disabled || !encampmentTargets.length} onClick={onPickEncampment}>지도에서 선택하기</button> : null}
          <small>
            {encampmentTargets.length
              ? "도심 밖 · 현재 관측된 아군 도시 소속 빈 타일"
              : "관측된 배치 가능 타일이 없어요. 서버가 최종 검증해요."}
          </small>
        </label>
      ) : null}
      <div className="production-list">
        {options.map(([type, rawDefinition]) => {
          const definition = rawDefinition && typeof rawDefinition === "object"
            ? rawDefinition
            : {};
          const resources = resourceEntries(definition);
          const affordable = resources.every(([resource, amount]) =>
            (Number(inventory[resource]) || 0) +
              (queueDefinition && queueDefinition !== definition
                ? Number(queueDefinition.resources?.[resource] ?? queueDefinition.costs?.[resource] ?? 0)
                : 0) >= Number(amount),
          );
          const rawCost = definition.cost ?? definition.productionCost;
          const estimate = Number.isFinite(Number(rawCost))
            ? estimateCityProduction(city, type, { cost: Number(rawCost) })
            : null;
          const eta = !estimate
            ? "비용 확인 중"
            : estimate.complete
              ? "완성 대기"
              : estimate.turns == null
                ? `생산력 ${estimate.productionRate}/턴`
                : `예상 ${estimate.turns}턴`;
          const requiresTarget = definition.requiresTarget === true || type === "encampment";
          const missingTarget = requiresTarget && !selectedEncampmentTarget;
          const missing = resources
            .filter(([resource, amount]) => (Number(inventory[resource]) || 0) < Number(amount))
            .map(([resource, amount]) => `${resourceName(resource)} ${Number(amount) - (Number(inventory[resource]) || 0)} 부족`)
            .join(" · ");
          return (
            <button
              key={type}
              className={`production-row logistics-production-row ${city.queue === type ? "selected" : ""}`}
              disabled={disabled || !affordable || missingTarget}
              onClick={() =>
                onChoose(
                  type,
                  type === "encampment" && targetPoint
                    ? { q: targetPoint[0], r: targetPoint[1] }
                    : null,
                )
              }
            >
              <div className="production-icon">
                <Icon name={definition.icon ?? (type === "encampment" ? "walls" : "link")} />
              </div>
              <span>
                <strong>{definition.name ?? type}</strong>
                <small>{productionOptionCopy(type, definition)}</small>
                <span className="cost">
                  <span><Icon name="hammer" size={14} /> 생산력 비용 {definition.cost ?? definition.productionCost ?? "—"}</span>
                  {resources.map(([resource, amount]) => (
                    <span key={resource}>
                      <Icon name={RESOURCES[resource]?.icon ?? "flag"} size={14} />
                      {resourceName(resource)} {amount}
                    </span>
                  ))}
                </span>
              </span>
              <b className="production-eta" aria-label={`${definition.name ?? type} ${affordable && !missingTarget ? eta : missingTarget ? "배치 타일 필요" : missing}`}>
                {missingTarget ? "배치 타일 필요" : affordable ? eta : missing || "자원 부족"}
              </b>
            </button>
          );
        })}
      </div>
      <p className="logistics-footnote">
        이 항목은 서버가 생산·정원·배치 가능 여부를 최종 확인해요.
      </p>
    </section>
  );
}

export function CargoStatus({ game, entity, compact = false }) {
  const cargo = cargoForEntity(game, entity);
  if (!cargo.length) return null;
  return (
    <section className={`logistics-card cargo-status${compact ? " compact" : ""}`}>
      <header>
        <span>
          <Icon name="link" size={17} /> 실제 운송
        </span>
        <strong>{cargo.length}건</strong>
      </header>
      <div className="cargo-status-list">
        {cargo.slice(0, compact ? 2 : 6).map((entry) => {
          const goods = entry.goods ?? entry.amount ?? entry.resource ?? "화물";
          const from = entry.fromCityName ?? entry.fromCityId ?? "출발지";
          const to = entry.toCityName ?? entry.toCityId ?? "목적지";
          const goodsKind = goods?.resource ?? goods?.kind ?? "화물";
          const goodsAmount = goods?.amount ?? goods?.quantity;
          const goodsText =
            goods && typeof goods === "object"
              ? goodsAmount == null
                ? String(goodsKind)
                : `${goodsKind} ${goodsAmount}`
              : String(goods);
          return (
            <div key={entry.id ?? entry.cargoId ?? entry.shipmentId}>
              <span>{goodsText}</span>
              <small>{from} → {to} · {cargoStatus(entry)}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function RoadStatus({ game, compact = false }) {
  const roads = Array.isArray(game?.logistics?.roads)
    ? game.logistics.roads
    : Array.isArray(game?.roads)
      ? game.roads
      : [];
  if (!roads.length) return null;
  return (
    <section className={`logistics-card road-status${compact ? " compact" : ""}`}>
      <header>
        <span><Icon name="link" size={17} /> 운송 도로</span>
        <strong>{roads.length}구간</strong>
      </header>
      <p className="logistics-footnote">
        상인·수송대가 실제로 통과한 구간만 표시해요. 도로는 보너스 이동 경로로 사용돼요.
      </p>
    </section>
  );
}

export function ManualShipmentControls({ game, city, disabled, onTrade }) {
  const state = detailedLogisticsState(game);
  const capability = logisticsCapability(game);
  const sendAction = actionName(capability, ["sendSupply", "sendShipment", "shipFood"]);
  const reserveAction = actionName(capability, ["setFoodReserve", "setTargetReserve", "setReserve", "setStockTarget"]);
  const cities = (game.cities ?? []).filter((candidate) => candidate.owner === game.playerId);
  const [destination, setDestination] = useState(cities.find((candidate) => candidate.id !== city?.id)?.id ?? "");
  const [amount, setAmount] = useState(1);
  const [reserve, setReserve] = useState(city?.targetFoodStock ?? city?.targetReserve ?? 0);
  if (!state.enabled || !city || (!sendAction && !reserveAction)) return null;
  return (
    <section className="logistics-card shipment-controls">
      <header>
        <span><Icon name="arrow" size={17} /> 보급 조정</span>
        <small>실제 운송</small>
      </header>
      {sendAction && cities.length > 1 ? (
        <div className="shipment-form">
          <label>
            도착 도시
            <select value={destination} onChange={(event) => setDestination(event.target.value)}>
              {cities.filter((candidate) => candidate.id !== city.id).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
          </label>
          <label>
            식량 수량
            <input type="number" min="1" value={amount} onChange={(event) => setAmount(Math.max(1, Number(event.target.value) || 1))} />
          </label>
          <button
            className="soft-button logistics-action"
            disabled={disabled || !destination}
            onClick={() => onTrade({ action: sendAction, fromCityId: city.id, toCityId: destination, resource: "food", amount })}
          >
            보급 보내기
          </button>
        </div>
      ) : null}
      {reserveAction ? (
        <div className="shipment-form">
          <label>
            목표 저장량
            <input type="number" min="0" value={reserve} onChange={(event) => setReserve(Math.max(0, Number(event.target.value) || 0))} />
          </label>
          <button
            className="soft-button logistics-action"
            disabled={disabled}
            onClick={() => onTrade({ action: reserveAction, cityId: city.id, resource: "food", targetReserve: reserve, target: reserve })}
          >
            목표 저장량 적용
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function LogisticsSelectionDetails({
  game,
  city,
  unit,
  tile,
  disabled,
  tradeDisabled = disabled,
  onAction,
  onTrade,
  onCitizenSettings,
}) {
  const state = detailedLogisticsState(game);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [city?.id, unit?.id, tile?.q, tile?.r]);
  if (!state.supported) return null;
  return (
    <div className="logistics-selection-details">
      <button
        type="button"
        className="soft-button logistics-details-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon
          name="arrow"
          size={13}
          className={`logistics-details-chevron${expanded ? " expanded" : ""}`}
        />
        {expanded ? "보급·노동 상세 닫기" : "보급·노동 상세 보기"}
      </button>
      {expanded ? (
        <>
          {unit ? <UnitFoodDetails unit={unit} game={game} compact disabled={tradeDisabled} onTrade={onTrade} /> : null}
          {city ? <CityFoodDetails city={city} game={game} compact /> : null}
          {city ? (
            <ManpowerDetails
              city={city}
              game={game}
              disabled={disabled}
              onTrade={onTrade}
              compact
            />
          ) : null}
          {city ? (
            <LaborDetails
              city={city}
              game={game}
              disabled={disabled}
              onCitizenSettings={onCitizenSettings}
              compact
            />
          ) : null}
          {unit ? <UnitManpowerDetails unit={unit} game={game} compact /> : null}
          {city ? (
            <MerchantStatus
              city={city}
              game={game}
              disabled={tradeDisabled}
              onTrade={onTrade}
            />
          ) : null}
          {tile ? <FacilityStatus tile={tile} game={game} unit={unit} disabled={disabled} onAction={onAction} /> : null}
          {tile ? <TerritoryAssignmentDetails tile={tile} game={game} disabled={disabled} onTrade={onTrade} /> : null}
          {tile ? <StructureStatus tile={tile} game={game} /> : null}
          {(city || unit) ? <CargoStatus game={game} entity={city ?? unit} compact /> : null}
          {(city || unit) ? <RoadStatus game={game} compact /> : null}
          {city && onTrade ? <ManualShipmentControls game={game} city={city} disabled={tradeDisabled} onTrade={onTrade} /> : null}
        </>
      ) : null}
    </div>
  );
}

export function LogisticsOverview({ game }) {
  const state = detailedLogisticsState(game);
  if (!state.supported) return null;
  const cities = (game.cities ?? []).filter((city) => city.owner === game.playerId);
  const cargo = state.enabled ? cargoEntries(game) : [];
  return (
    <section className="logistics-overview" aria-label="상세 보급 현황">
      <header>
        <div>
          <h3>상세 보급 현황</h3>
          <p>
            {state.enabled
              ? "실제 화물·도시 저장량·유닛 보급을 표시해요."
              : "비축 모드 OFF · 도시별 생산−인구 소비 잉여와 성장 예상만 표시해요."}
          </p>
        </div>
        <Icon name="link" size={18} />
      </header>
      <div className="logistics-overview-cities">
        {cities.map((city) => <CityFoodDetails key={city.id} city={city} game={game} compact />)}
      </div>
      {cargo.length ? <p className="logistics-footnote">운송 중 화물 {cargo.length}건</p> : null}
    </section>
  );
}
