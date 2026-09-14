import React, { useContext, useEffect, useRef, useState } from "react";
import {
  TYPES,
  unitMovement,
  unitStat,
  RESOURCES,
  TERRAINS,
  XP_THRESHOLDS,
  label,
  key,
  neighbors,
  distance,
  maxHealth,
  formationName,
  siegePenalty,
  RELATIONS,
  productionType,
  cityMaxHealth,
  settlementIssue,
  farmTerrainYield,
  wheatFoodBonus,
  FEATURES,
  CHOP_PRODUCTION,
  HARVEST_FOOD,
  HARVEST_PRODUCTION,
  HARVEST_RESOURCE_AMOUNT,
  WHEAT_FARM_FOOD_BONUS,
  PRODUCTION_BANK_CAP,
} from "../shared/rules.js";
import { combatStrength, formationTierName } from "../shared/combat.js";
import { fortIssue } from "../shared/structures.js";
import { constructionIssue, featureActionIssue } from "../shared/construction.js";
import { Icon, UnitIcon } from "./Icons.jsx";
import { FeedbackContext } from "./feedback.js";
import { factionFor } from "./factions.js";
import { estimateCityProduction, confirmClearProduction } from "./productionHelpers.js";
import { cityFoodSummary, detailedLogisticsState } from "./logisticsHelpers.js";
import {
  LogisticsProductionOptions,
  ManpowerDetails,
  LogisticsSelectionDetails,
  UnitFoodDetails,
} from "./Logistics.jsx";
import {
  attackReadiness,
  cityDefenseSummary,
  wallRepairEligibility,
} from "./cityDefenseHelpers.js";
import { canMergeEqualTier, canMergeFromTier, mergePartners, NO_MERGE_PARTNER_TIP } from "./formationHelpers.js";

export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  const error = useContext(FeedbackContext);
  useEffect(() => {
    ref.current.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="modal-body">
        {error ? (
          <p className="modal-error" role="alert">
            {error}
          </p>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}
export function Bar({ value, max, tone = "" }) {
  return (
    <div
      className={`bar ${tone}`}
      role="progressbar"
      aria-label="진행도"
      aria-valuenow={value}
      aria-valuemin="0"
      aria-valuemax={max}
    >
      <span
        style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }}
      />
    </div>
  );
}
export function Cost({ type, city, definition }) {
  const def = definition ?? productionType(type, city);
  return (
    <span className="cost">
      <span>
        <Icon name="hammer" size={14} />
        생산력 비용 {def.cost}
      </span>
      {Object.entries(def.resources).map(([r, n]) => (
        <span key={r}>
          <Icon name={RESOURCES[r].icon} size={14} />
          {RESOURCES[r].name} {n}
        </span>
      ))}
    </span>
  );
}
export function Penalties({ entity }) {
  return (
    <>
      {entity.isolation > 0 ? (
        <div className="penalty">
          <Icon name="link" size={15} />
          {entity.supplied ? "보급 회복 중" : "보급 단절"} · 전투/생산 −
          {Math.round(siegePenalty(entity.isolation) * 100)}%
        </div>
      ) : null}
      {entity.riverTurns > 0 ? (
        <div className="penalty">
          <Icon name="flag" size={15} />
          도하 불이익 −20% · {entity.riverTurns}턴 남음
        </div>
      ) : null}
    </>
  );
}
export function CampDetails({ game, city, unit, disabled, onTrade }) {
  if (!city?.camp) return null;
  const state = city.campState;
  const garrison = unit?.owner === game.playerId && !TYPES[unit.type]?.civilian && !TYPES[unit.type]?.internal ? unit
    : game.units.find((candidate) => candidate.owner === game.playerId && key(candidate) === key(city) && !TYPES[candidate.type]?.civilian && !TYPES[candidate.type]?.internal);
  return <section className="logistics-card" aria-label="야만인 거점 약탈">
    <strong>{city.name} · 야만인 거점</strong>
    <p>거점은 일반 도시로 성장하거나 유닛을 생산하지 않아요. 점령한 거점 위의 군사 유닛으로 10턴마다 약탈할 수 있어요.</p>
    <p>약탈 보상: 식량 {state?.pillageFood ?? 20} + 골드 {state?.pillageGold ?? 20}. 식량은 가까운 내 일반 도시로 보냅니다.</p>
    {state ? <p>{state.canPillage ? "지금 약탈 가능" : `다음 약탈 ${Math.max(0, (state.nextPillageTurn ?? game.turn) - game.turn)}턴 후`}</p> : null}
    <button className="soft-button" disabled={disabled || !garrison || state?.canPillage !== true} onClick={() => onTrade({ action: "pillageCamp", cityId: city.id, unitId: garrison.id })}>거점 약탈 · 식량 20 / 골드 20</button>
    {!garrison ? <p className="fine-print">거점 칸에 내 군사 유닛을 배치하세요.</p> : null}
  </section>;
}
export function Selection({
  game,
  unit,
  city,
  tile,
  mode,
  disabled,
  routeDisabled = disabled,
  tradeDisabled = disabled,
  onMode,
  onAction,
  onClose,
  onDetails,
  onProduction,
  onMerge,
  onBuyTile,
  onDiplomacy,
  onTrade,
  onCitizenSettings,
}) {
  const own = unit?.owner === game.playerId;
  const adjacent = tile
    ? neighbors(tile).filter((n) =>
        game.tiles.some(
          (t) => key(t) === key(n) && t.farm && t.owner === game.playerId,
        ),
      ).length
    : 0;
  const def = unit ? TYPES[unit.type] : null;
  const internal = def?.internal === true;
  const ammo = unit ? attackReadiness(unit) : null;
  const assignedCity =
    tile?.cityId != null
      ? game.cities.find((candidate) => candidate.id === tile.cityId)
      : null;
  const tileFaction = tile?.owner ? factionFor(game, tile.owner) : null;
  const tileOwnerName = tileFaction?.name ?? tile?.owner;
  const tileCityName =
    tile?.cityName ?? assignedCity?.name ?? (tile?.cityId != null ? `도시 ${tile.cityId}` : null);
  const resourceConversion =
    game.capabilities?.resourceConversion === true ||
    game.rulesVersion === "expansion-v1";
  const detailedSupply = detailedLogisticsState(game).enabled;
  const cityFood = city ? cityFoodSummary(city, game) : null;
  const cityDefense = city ? cityDefenseSummary(city) : null;
  const growthProgress = cityFood?.progress ?? (detailedSupply ? city?.growthProgress : city?.food);
  const growthTarget = cityFood?.target ?? city?.growthTarget;
  const developmentIssue =
    unit?.type === "builder"
      ? constructionIssue(game, unit, "develop") ??
        (unit.movesLeft <= 0
          ? "이번 턴에 남은 이동력이 있어야 건설할 수 있어요."
          : null)
      : null;
  const movesIssue =
    unit?.movesLeft <= 0 ? "이번 턴에 남은 이동력이 있어야 할 수 있어요." : null;
  const chopIssue =
    unit?.type === "builder" ? featureActionIssue(game, unit, "chop") ?? movesIssue : null;
  const harvestIssue =
    unit?.type === "builder" ? featureActionIssue(game, unit, "harvest") ?? movesIssue : null;
  const harvestTip = tile
    ? tile.feature === "wheat"
      ? `${FEATURES.wheat.name} 수확 · 즉시 식량 +${HARVEST_FOOD} · 생산력 +${HARVEST_PRODUCTION} · 밀밭이 사라져요. 건설 1회 소모.`
      : RESOURCES[tile.resource]
        ? `${RESOURCES[tile.resource].name} 매장지 채굴 · 즉시 ${RESOURCES[tile.resource].name} +${HARVEST_RESOURCE_AMOUNT} · 생산력 +${HARVEST_PRODUCTION} · 매장지가 영구히 사라져요(개발 대신 선택). 건설 1회 소모.`
        : null
    : null;
  const queueDefinition = city?.queue
    ? productionType(city.queue, city)
    : null;
  const queueEstimate = queueDefinition
    ? estimateCityProduction(city, city.queue, queueDefinition)
    : null;
  return (
    <section className="selection" aria-label="선택 정보">
      <button
        className="selection-close icon-button"
        aria-label="선택 해제"
        onClick={onClose}
      >
        <Icon name="close" size={16} />
      </button>
      <div className="selection-main">
        <div
          className={`selection-symbol ${unit && !own ? "enemy" : ""}`}
          style={{ color: factionFor(game, (unit ?? city)?.owner).color }}
        >
          {unit ? (
            <UnitIcon type={unit.type} size={30} />
          ) : (
            <Icon
              name={
                city
                  ? "city"
                  : tile?.terrain === "mountain"
                    ? "mountain"
                    : tile?.terrain === "hills"
                      ? "hills"
                      : "wheat"
              }
              size={30}
            />
          )}
        </div>
        <div className="selection-title">
          <h2>
            {unit ? def.name : city ? city.name : TERRAINS[tile.terrain].name}
            {unit && unit.size > 1 ? (
              <span className="formation-count">{formationTierName(unit.size)} ×{unit.size}</span>
            ) : null}
          </h2>
          <p>
            {label(unit ?? city ?? tile)}
            <span>·</span>
            {unit
              ? `레벨 ${unit.level}`
              : city
                ? `인구 ${city.population ?? "?"}`
                : tile.terrain === "unknown"
                  ? "아직 탐사하지 않은 땅"
                  : `비옥도 ${tile.fertility} / 3`}
            {unit?.fortified || unit?.fortifyPending ? (
              <>
                <span>·</span>
                {unit.fortified ? "방어 중" : "방어 준비 중"}
              </>
            ) : null}
          </p>
          {unit || city ? (
            <small
              className="entity-allegiance"
              style={{ color: factionFor(game, (unit ?? city).owner).color }}
            >
              {factionFor(game, (unit ?? city).owner).name} ·{" "}
              {
                RELATIONS[
                  game.factions.find((f) => f.id === (unit ?? city).owner)
                    ?.relation
                ]
              }
              {city
                ? ` · 본체 ${cityDefense?.body ?? city.hp}/${cityDefense?.bodyMax ?? cityMaxHealth(city)} · 성벽 ${cityDefense?.wall ?? 0}/${cityDefense?.wallMax ?? 0}`
                : ""}
            </small>
          ) : null}
          {unit && (
            <div
              className="selection-xp"
              data-tip="공격·방어·승리로 경험치를 얻어요."
            >
              <span>
                경험치 {unit.xp} ·{" "}
                {XP_THRESHOLDS[unit.level] == null
                  ? "최고 레벨"
                  : `다음 레벨까지 ${Math.max(0, XP_THRESHOLDS[unit.level] - unit.xp)}`}
              </span>
              <Bar
                value={unit.xp - (XP_THRESHOLDS[unit.level - 1] ?? 0)}
                max={
                  (XP_THRESHOLDS[unit.level] ?? unit.xp) -
                    (XP_THRESHOLDS[unit.level - 1] ?? 0) || 1
                }
              />
            </div>
          )}
        </div>
        {unit ? (
          <div className="selection-numbers">
            <span>
              {unit.hp}
              <small> / {maxHealth(unit)}</small>
            </span>
            <Bar value={unit.hp} max={maxHealth(unit)} />
          </div>
        ) : city?.owner === game.playerId && !city.camp ? (
          <div className="selection-numbers">
            <span>
              인구 <b className="population-number">{city.population}</b>
            </span>
            <Bar value={growthProgress ?? 0} max={growthTarget ?? 1} />
          </div>
        ) : !city &&
          !unit &&
          tile?.terrain !== "mountain" &&
          tile?.terrain !== "unknown" ? (
          <div className="selection-numbers">
            <span>
              {farmTerrainYield(tile).name} 예상 <b>식량 +{farmTerrainYield(tile).base + tile.fertility + adjacent + wheatFoodBonus(tile)}{farmTerrainYield(tile).production ? " · 생산 +1" : ""}{wheatFoodBonus(tile) ? ` · ${FEATURES.wheat.name} +${wheatFoodBonus(tile)}` : ""}</b>
            </span>
            <small>인접 농지 {adjacent}칸{tile.feature ? ` · ${FEATURES[tile.feature]?.name ?? tile.feature}` : ""}</small>
          </div>
        ) : null}
      </div>
      {!unit && !city ? (
        <p className="entity-allegiance">
          {tile.terrain === "unknown"
            ? "소유국 · 도시 미확인"
            : tile.owner
              ? `${tileOwnerName ?? "소유국 확인 중"} · ${tileCityName ?? "도시 미확인"}`
              : "미소유 영토"}
        </p>
      ) : null}
      {unit && own ? (
        <div className="unit-status">
          <span data-tip="평지 1, 구릉지 2 소모. 적 인접 칸에 들어가면 남은 이동력이 0이 돼요.">
            공격 <b>{unitStat(unit, "attack", game.balance?.unitAttack?.[unit.type] ?? def.attack)}</b> · 유효{" "}
            {combatStrength(unit, false, game).toFixed(1)} · 이동력{" "}
            <b>
              {unit.movesLeft} / {unitMovement(unit)}
            </b>
            {game.experiment ? ` · 공격 ${unit.attacksLeft ?? (unit.attackUsed ? 0 : 1)}회 남음` : ""}
          </span>
          <span>
            {internal
              ? "자동 보급 수송대 · 직접 명령 불가"
              : unit.type === "builder"
              ? `건설 ${unit.charges}회 남음`
              : unit.type === "settler"
                ? "도시 개척 · 정착 시 소모"
              : ammo?.ready === false
                ? ammo.reason
              : unit.attackUsed
                ? "공격 완료 · 이번 턴 행동 종료"
                : `공격 가능 · ${unit.attacksLeft ?? 1}회`}
          </span>
          {unit.fortified ? (
            <span className="defending">방어 중 +25%</span>
          ) : unit.fortifyPending ? (
            <span>다음 턴 방어 태세</span>
          ) : null}
        </div>
      ) : null}
      {city?.owner === game.playerId && !city.camp ? (
        <div className="city-growth">
          <span
            data-tip={
              detailedSupply
                ? "도시 저장 식량이 시민·병력 소비를 충당한 턴에만 성장 진척이 올라가요."
                : "턴당 도시·농지 식량 생산에서 인구 소비를 뺀 잉여가 성장 진척에 반영돼요."
            }
          >
            식량 <b>+{cityFood?.production ?? city.foodGross}</b> − 소비{" "}
            {cityFood?.consumption ?? city.population} ={" "}
            <b>
              {(cityFood?.net ?? city.foodNet) >= 0 ? "+" : ""}
              {cityFood?.net ?? city.foodNet}
            </b>
          </span>
          <span
            className="city-stored-production"
            data-tip={`생산을 예약하지 않은 턴의 생산력은 최대 ${PRODUCTION_BANK_CAP}까지 비축되고, 다음 생산 예약에 즉시 더해져요.`}
          >
            비축 생산력 <b>{city.storedProduction ?? 0}</b>
          </span>
          {detailedSupply && cityFood?.stockAvailable ? (
            <span
              className="city-food-stock-inline"
              data-tip="상세 보급 ON에서만 사용하는 도시 저장 식량입니다. 성장 진척과 별도예요."
            >
              저장 <b>{cityFood.stored}</b>
              {cityFood.capacity != null ? ` / ${cityFood.capacity}` : ""}
            </span>
          ) : null}
          <strong>
            {detailedSupply
              ? cityFood?.shortage
                ? "식량 부족 · 성장 정지/인구 감소"
                : cityFood?.growthTurns == null
                  ? "성장 진척 확인 중"
                  : cityFood.growthTurns <= 0
                    ? "다음 정산에 인구 +1"
                    : `${cityFood.growthTurns}턴 뒤 인구 +1`
              : growthProgress >= growthTarget
                ? "다음 턴 인구 +1"
                : (cityFood?.net ?? city.foodNet) > 0
                  ? `${Math.ceil((growthTarget - growthProgress) / (cityFood?.net ?? city.foodNet))}턴 뒤 인구 +1`
                  : "성장 정체"}
          </strong>
        </div>
      ) : null}
      {unit && own && !internal ? (
        <div className="selection-actions">
          <button
            className={`soft-button ${mode === "move" ? "active" : ""}`}
            disabled={
              routeDisabled ||
              (game.activePlayer === game.playerId && unit.attackUsed && !(game.experiment && unit.movesLeft > 0))
            }
            data-tip={
              game.activePlayer === game.playerId
                ? "우클릭 이동 · 우클릭을 누른 채 드래그하면 경유지 지정. 1은 이번 턴, 2는 다음 턴. 남은 경로는 턴마다 자동 진행돼요."
                : "상대 턴에도 우클릭 이동 경로를 예약할 수 있어요. 다음 내 턴에 2번부터 자동 진행돼요."
            }
            onClick={() => onMode(mode === "move" ? "inspect" : "move")}
          >
            <Icon name="move" size={17} />
            이동 <small>{unit.movesLeft}</small>
          </button>
          {unit.type === "builder" ? (
            <>
              <button
                className="primary"
                disabled={
                  disabled ||
                  unit.movesLeft <= 0 ||
                  !unit.charges ||
                  tile.farm ||
                  tile.developed ||
                  tile.feature === "forest" ||
                  tile.fort?.hp > 0 ||
                  tile.owner !== game.playerId ||
                  game.cities.some((c) => key(c) === key(unit))
                }
                onClick={() => onAction("farm")}
                data-tip={
                  tile.feature === "forest"
                    ? "숲을 먼저 베어야 농지를 지을 수 있어요."
                    : `즉시 농지를 조성하고 이번 턴 이동력을 모두 써요.${tile.feature === "wheat" ? ` 밀밭 농지는 식량 +${WHEAT_FARM_FOOD_BONUS}.` : ""} 건설 1회 소모, 마지막 건설 후 건축자는 사라져요.`
                }
              >
                <Icon name="wheat" size={17} />
                농지 조성{tile.feature === "wheat" ? ` · 밀 +${WHEAT_FARM_FOOD_BONUS}` : ""}
              </button>
              {tile.feature === "forest" ? (
                <button
                  className="soft-button"
                  disabled={disabled || !!chopIssue}
                  onClick={() => onAction("chop")}
                  data-tip={chopIssue ?? `숲 벌목 · 가장 가까운 내 도시에 즉시 생산력 +${CHOP_PRODUCTION} · 건설 1회 소모.`}
                >
                  <Icon name="tools" size={17} />
                  벌목 · 생산 +{CHOP_PRODUCTION}
                </button>
              ) : null}
              {tile.feature === "wheat" || (RESOURCES[tile.resource] && !tile.developed) ? (
                <button
                  className="soft-button"
                  disabled={disabled || !!harvestIssue}
                  onClick={() => onAction("harvest")}
                  data-tip={harvestIssue ?? harvestTip}
                >
                  <Icon name={tile.feature === "wheat" ? "wheat" : RESOURCES[tile.resource].icon} size={17} />
                  {tile.feature === "wheat"
                    ? `수확 · 식량 +${HARVEST_FOOD} · 생산 +${HARVEST_PRODUCTION}`
                    : `채굴 · ${RESOURCES[tile.resource].name} +${HARVEST_RESOURCE_AMOUNT} · 생산 +${HARVEST_PRODUCTION}`}
                </button>
              ) : null}
              <button
                className="soft-button"
                disabled={
                  disabled || unit.movesLeft <= 0 || !!fortIssue(game, unit)
                }
                onClick={() => onAction("fort")}
                data-tip={
                  fortIssue(game, unit) ??
                  "건설 1회 · 요새 체력 80 · 아군 주둔 방어력 +25%"
                }
              >
                <Icon name="walls" size={17} />
                요새
              </button>
              {tile.resource ? (
                <button
                  className="soft-button"
                  disabled={
                    disabled ||
                    unit.movesLeft <= 0 ||
                    !unit.charges ||
                    !!developmentIssue ||
                    tile.farm && !resourceConversion
                  }
                  onClick={() => onAction("develop")}
                  data-tip={
                    developmentIssue ??
                    (tile.farm
                      ? resourceConversion
                        ? `${RESOURCES[tile.resource].improvement}로 전환 · 농지 식량이 사라지고 건설 1회와 남은 이동력을 모두 사용해요.`
                        : `${RESOURCES[tile.resource].improvement} 전환은 서버 업데이트 후 가능해요. 현재 경기에서는 농지가 있는 타일에 사용할 수 없어요.`
                      : `${RESOURCES[tile.resource].improvement} · 건설 1회와 남은 이동력을 모두 사용해요.`)
                  }
                >
                  <Icon name={RESOURCES[tile.resource].icon} size={17} />
                  {RESOURCES[tile.resource].improvement}
                </button>
              ) : null}
            </>
          ) : unit.type === "settler" ? (
            <button
              className="primary"
              disabled={
                disabled || unit.movesLeft <= 0 || !!settlementIssue(game, unit)
              }
              onClick={() => onAction("found")}
              data-tip={
                settlementIssue(game, unit) ??
                "인구 1의 도시를 즉시 세워요. 개척자는 소모되고 동행한 전투 부대는 남아요."
              }
            >
              <Icon name="settler" size={17} />
              도시 세우기
            </button>
          ) : (
            <>
              <button
                className={`soft-button ${mode === "attack" ? "active" : ""}`}
                disabled={disabled || unit.attackUsed || ammo?.ready === false}
                data-tip={ammo?.reason ?? `공격 ${unit.attacksLeft ?? 1}회 남음. 공격하면 남은 이동력을 모두 소모해요. 공격 기회가 남았다면 이동력이 없어도 사거리 안의 적을 공격할 수 있어요.`}
                onClick={() => onMode(mode === "attack" ? "inspect" : "attack")}
              >
                <Icon name="target" size={17} />
                {unit.type === "artillery" ? "포격" : "공격"}
              </button>
              <button
                className="soft-button"
                disabled={
                  disabled ||
                  unit.movesLeft <= 0 ||
                  unit.attackUsed ||
                  unit.fortified ||
                  unit.fortifyPending ||
                  unit.movesLeft < def.movement
                }
                data-tip="이번 턴 이동하지 않은 유닛만 준비 가능. 한 턴 뒤 방어력 +25%, 이동이나 공격 시 해제돼요."
                onClick={() => onAction("fortify")}
              >
                <Icon name="shield" size={17} />
                방어
              </button>
            </>
          )}
          {!def?.civilian && canMergeFromTier(unit) ? (
            <button
              className={`soft-button merge-button ${mode === "mapPick" ? "active" : ""}`}
              disabled={disabled || mergePartners(game, unit).length === 0}
              aria-disabled={disabled || mergePartners(game, unit).length === 0}
              data-tip={
                mergePartners(game, unit).length
                  ? `지도에서 강조된 인접 부대를 누르면 바로 합병 명령을 보내요 (${unit.size === 1 ? "대대+대대→여단" : "여단+여단→사단"}).`
                  : NO_MERGE_PARTNER_TIP
              }
              title={mergePartners(game, unit).length ? undefined : NO_MERGE_PARTNER_TIP}
              onClick={onMerge}
            >
              <Icon name="merge" size={17} />
              합병
            </button>
          ) : null}
          <button className="soft-button details-button" onClick={onDetails}>
            <Icon name="info" size={17} />
            <span>상세</span>
          </button>
        </div>
      ) : unit && own && internal ? (
        <div className="selection-actions">
          <p className="builder-action-note" role="note">
            이 수송대는 서버가 자동 운행해요. 직접 이동·공격·합병·해산할 수 없어요.
          </p>
          <button className="soft-button details-button" onClick={onDetails}>
            <Icon name="info" size={17} />
            <span>운송 상세</span>
          </button>
        </div>
      ) : city?.owner === game.playerId && !city.camp ? (
        <div className="selection-actions">
          <span className="city-queue">
            {city.queue
              ? `${queueDefinition.name} · ${queueEstimate.complete ? "완성 대기 · 도시 칸/수용량" : queueEstimate.turns == null ? "생산력 없음" : `예상 ${queueEstimate.turns}턴`}`
              : "생산할 유닛을 선택하세요"}
          </span>
          <button
            className="primary"
            disabled={disabled}
            onClick={onProduction}
          >
            <Icon name="hammer" size={16} />
            {city.queue ? "생산 변경" : "생산"}
          </button>
          <button
            className="soft-button"
            aria-label="도시 상세"
            onClick={onDetails}
          >
            <Icon name="info" size={17} />
          </button>
          <button
            className="soft-button"
            disabled={disabled}
            onClick={onBuyTile}
            data-tip="도시 영토에 이어진 4칸 이내의 미소유 땅을 골드로 구매해요. 인구가 늘어도 영토가 자동 확장돼요."
          >
            영토 구매
          </button>
        </div>
      ) : (
        <p className="tile-note">
          {unit
            ? "현재 시야에서 확인한 병력입니다."
            : tile.terrain === "unknown"
              ? "지형·비옥도·자원은 탐사해야 확인할 수 있어요."
              : tile.terrain === "mountain"
                ? "산지는 이동할 수 없어요."
                : tile.resource
                  ? `${RESOURCES[tile.resource].name} 매장지 · 건축자로 시설을 개발하거나, 채굴해 즉시 ${RESOURCES[tile.resource].name} +${HARVEST_RESOURCE_AMOUNT} · 생산력 +${HARVEST_PRODUCTION}을 얻고 없앨 수 있어요.`
                  : tile.feature === "forest"
                    ? `숲 · 건축자가 베면 즉시 생산력 +${CHOP_PRODUCTION}. 농지는 벌목 후에 지을 수 있어요.`
                    : tile.feature === "wheat"
                      ? `밀밭 · 농지를 지으면 식량 +${WHEAT_FARM_FOOD_BONUS}, 수확하면 즉시 식량 +${HARVEST_FOOD} · 생산력 +${HARVEST_PRODUCTION}.`
                      : "건축자가 이 칸에 있으면 농지를 조성할 수 있어요."}
        </p>
      )}
      {city?.owner === game.playerId && city.wallLevel > 0 ? (
        <button
          className={`soft-button city-fire ${mode === "cityAttack" ? "active" : ""}`}
          disabled={disabled || city.attackUsed || cityDefense?.wall <= 0}
          onClick={() =>
            onMode(mode === "cityAttack" ? "inspect" : "cityAttack")
          }
          data-tip={
            cityDefense?.wall > 0
              ? "성벽 포격 · 사거리 2 · 턴당 1회 · 시야 안의 적 유닛만 공격 가능"
              : "성벽 HP가 0이라 포격할 수 없어요. 도시 성벽을 먼저 수리하세요."
          }
        >
          <Icon name="target" size={16} />
          {city.attackUsed
            ? "포격 완료"
            : cityDefense?.wall > 0
              ? "도시 포격"
              : "포격 불가 · 성벽 수리 필요"}{" "}
          · 성벽 {city.wallLevel}레벨
        </button>
      ) : null}
      {(unit || city) && (unit ?? city).owner !== game.playerId ? (
        <div className="selection-actions">
          {unit ? (
            <span>
              공격력 {def.attack} · 방어력 {def.defense}
            </span>
          ) : (
            <span>
              체력 {city.hp}/{cityMaxHealth(city)}
            </span>
          )}
          <button
            className="soft-button"
            onClick={() => onDiplomacy((unit ?? city).owner)}
          >
            문명 · 외교
          </button>
          {unit ? (
            <button className="soft-button" onClick={onDetails}>
              상세
            </button>
          ) : null}
        </div>
      ) : null}
      {unit?.order ? (
        <div className="queued-order">
          <span>
            <i />
            {
              {
                move: unit.order.blocked
                  ? "진로 막힘 · 이동 대기"
                  : unit.order.queued
                    ? "다음 내 턴 이동 예약"
                    : "남은 이동 경로",
                attack: "공격 예약",
                bombard: "포격 예약",
                farm: "농지 조성 예약",
                develop: "자원 개발 예약",
                chop: "벌목 예약",
                harvest: "수확 예약",
                found: "도시 건설 예약",
                fortify: "방어 준비 · 다음 턴부터 적용",
                merge: "합병 예약",
              }[unit.order.action]
            }
            {unit.order.target ? ` · ${label(unit.order.target)}` : ""}
          </span>
          <button
            disabled={
              unit.order.action === "move" ? routeDisabled : disabled
            }
            onClick={() => onAction("cancel")}
          >
            취소
          </button>
        </div>
      ) : null}
      {unit?.type === "builder" && tile.resource ? (
        <p className="builder-action-note" role="note">
          {developmentIssue
            ? developmentIssue
            : tile.farm
              ? resourceConversion
                ? `${RESOURCES[tile.resource].improvement} 전환 가능 · 농지 식량을 없애고 건설 1회와 남은 이동력을 모두 사용해요.`
                : `${RESOURCES[tile.resource].improvement} 전환은 서버 업데이트 후 가능해요 · 현재 경기에서는 농지가 있는 타일에 사용할 수 없어요.`
              : `${RESOURCES[tile.resource].improvement} 건설 가능 · 보급된 시설은 턴마다 ${RESOURCES[tile.resource].name} 1을 생산해요.`}
        </p>
      ) : null}
      {unit ? (
        <Penalties entity={unit} />
      ) : city ? (
        <Penalties entity={city} />
      ) : null}
      <CampDetails game={game} city={city?.camp ? city : game.cities.find((candidate) => candidate.camp && unit && key(candidate) === key(unit))} unit={unit} disabled={disabled} onTrade={onTrade} />
      <LogisticsSelectionDetails
        game={game}
        city={city?.camp ? null : city}
        unit={unit}
        tile={tile}
        disabled={disabled}
        tradeDisabled={tradeDisabled}
        onAction={unit ? onAction : null}
        onTrade={onTrade}
        onCitizenSettings={onCitizenSettings}
      />
    </section>
  );
}
export function UnitDetails({
  unit,
  game,
  disabled,
  onAction,
  onMode,
  onMerge,
  onTrade,
  tradeDisabled = disabled,
}) {
  const def = TYPES[unit.type];
  const tile = game.tiles.find((t) => key(t) === key(unit));
  const own = unit.owner === game.playerId;
  const resourceConversion =
    game.capabilities?.resourceConversion === true ||
    game.rulesVersion === "expansion-v1";
  const developmentIssue =
    constructionIssue(game, unit, "develop") ??
    (unit.movesLeft <= 0
      ? "이번 턴에 남은 이동력이 있어야 건설할 수 있어요."
      : null);
  const ammo = attackReadiness(unit);
  const adjacentFarms = neighbors(unit).filter((n) =>
    game.tiles.some(
      (t) => key(t) === key(n) && t.farm && t.owner === game.playerId,
    ),
  ).length;
  return (
    <>
      <p className="description">{def.description}</p>
      <p
        className="entity-allegiance"
        style={{ color: factionFor(game, unit.owner).color }}
      >
        소속 · {factionFor(game, unit.owner).name} / 유효 공격{" "}
        {combatStrength(unit, false, game).toFixed(1)} · 유효 방어{" "}
        {combatStrength(unit, true, game).toFixed(1)}
      </p>
      {ammo.available ? (
        <p className={ammo.ready ? "logistics-footnote" : "logistics-footnote logistics-alert"}>
          {ammo.reason ?? `턴당 초석 유지비 ${ammo.cost} · 공격 시 추가 소모 없음 · 부족해도 기존 부대 공격 가능`}
        </p>
      ) : null}
      <div className="detail-grid">
        <div>
          편성<strong>{formationName(unit.size)}</strong>
        </div>
        <div>
          체력
          <strong>
            {unit.hp} / {maxHealth(unit)}
          </strong>
        </div>
        <div>
          남은 이동력
          <strong>
            {unit.movesLeft} / {def.movement}
          </strong>
        </div>
        <div>
          공격 사거리<strong>{def.range}칸</strong>
        </div>
        <div>
          전투력
          <strong>
            공격 {def.attack} · 방어 {def.defense}
          </strong>
        </div>
        <div>
          경험치
          <strong>
            {unit.xp} / {XP_THRESHOLDS[unit.level] ?? "최고 레벨"}
          </strong>
        </div>
      </div>
      <Bar value={unit.xp} max={XP_THRESHOLDS[unit.level] ?? unit.xp} />
      <Penalties entity={unit} />
      <UnitFoodDetails
        unit={unit}
        game={game}
        disabled={tradeDisabled}
        onTrade={onTrade}
      />
      {own && !def?.internal ? (
        <>
          <p className="description">
            {unit.fortified
              ? "방어 태세: 방어력 +25%. 이동·공격하면 해제돼요."
              : "방어 명령을 내리고 한 턴 제자리에 있으면 방어력이 25% 올라요."}
          </p>
          {unit.type === "builder" ? (
            <div className="stack-actions">
              <div className="detail-grid">
                <div>
                  현재 땅 비옥도<strong>{tile.fertility} / 3</strong>
                </div>
                <div>
                  인접 아군 농지<strong>{adjacentFarms}칸</strong>
                </div>
                <div>
                  {tile.farm ? "현재 농지 식량" : "농지 조성 시 식량"}
                  <strong>+{farmTerrainYield(tile).base + tile.fertility + adjacentFarms + wheatFoodBonus(tile)} / 턴{farmTerrainYield(tile).production ? " · 구릉지 농지 생산 +1" : ""}{wheatFoodBonus(tile) ? ` · 밀밭 +${wheatFoodBonus(tile)}` : ""}</strong>
                </div>
              </div>
              <p>
                남은 건설 횟수 <strong>{unit.charges} / 3</strong>
              </p>
              {tile.resource ? (
                <button
                  className="soft-button"
                  disabled={
                    disabled ||
                    unit.movesLeft <= 0 ||
                    !unit.charges ||
                    tile.developed ||
                    (tile.farm && !resourceConversion) ||
                    tile.fort?.hp > 0 ||
                    tile.owner !== game.playerId
                  }
                  onClick={() => onAction("develop")}
                >
                  <Icon name={RESOURCES[tile.resource].icon} />
                  {RESOURCES[tile.resource].improvement} 개발 · 건설 1회
                </button>
              ) : null}
              {tile.resource ? (
                <small className="builder-action-note" role="note">
                  {developmentIssue
                    ? developmentIssue
                    : tile.farm && !resourceConversion
                      ? "농지 전환은 서버 업데이트 후 가능해요."
                      : tile.farm
                        ? "농지 식량이 사라지고 건설 1회와 남은 이동력을 모두 사용해요."
                        : `보급된 ${RESOURCES[tile.resource].improvement}은 턴마다 ${RESOURCES[tile.resource].name} 1을 생산해요.`}
                </small>
              ) : null}
              <button
                className="soft-button"
                disabled={
                  disabled || unit.movesLeft <= 0 || !!fortIssue(game, unit)
                }
                onClick={() => onAction("fort")}
              >
                <Icon name="walls" />
                요새 건설 · 체력 80 / 주둔 방어력 +25%
              </button>
              <small>
                {fortIssue(game, unit) ?? "빈 영토에 요새를 지을 수 있어요."} 새
                도시는 개척자로 세워요.
              </small>
            </div>
          ) : unit.type === "settler" ? (
            <div className="stack-actions">
              <p className="description">
                개척자는 전투하지 않아요. 전투 부대와 같은 칸에서 이동·호위할 수
                있으며, 도시를 세우면 개척자만 소모돼요.
              </p>
              <button
                className="primary full"
                disabled={
                  disabled ||
                  unit.movesLeft <= 0 ||
                  !!settlementIssue(game, unit)
                }
                onClick={() => onAction("found")}
              >
                <Icon name="settler" />
                도시 세우기 · 개척자 소모
              </button>
              <small>
                {settlementIssue(game, unit) ??
                  "정착 가능 · 인구 1 · 기존 도시와 4칸 이상 간격"}
              </small>
            </div>
          ) : canMergeFromTier(unit) ? (
            <button
              className="soft-button full"
              disabled={disabled || unit.movesLeft <= 0 || unit.attackUsed}
              onClick={onMerge}
            >
              <Icon name="merge" />
              인접한 같은 편제의 같은 병종과 합병 ({unit.size === 1 ? "대대+대대→여단" : "여단+여단→사단"})
            </button>
          ) : unit.size === 3 ? (
            <p className="builder-action-note" role="note">
              기존 3개 편성은 유지돼요. 새 합병은 대대+대대→여단, 여단+여단→사단만 가능해요.
            </p>
          ) : null}
          {unit.type === "artillery" ? (
            <button
              className="soft-button full"
              disabled={disabled || unit.attackUsed || !ammo.ready}
              onClick={() => onMode("bombardRelocate")}
              data-tip={ammo.reason ?? "포병의 특수 행동. 포격할 칸을 먼저 선택한 뒤 재배치할 인접 칸을 선택하면, 포격 후 1칸 이동해요. 공격 기회를 소모해요."}
            >
              <Icon name="move" />
              포격 + 1칸 재배치
            </button>
          ) : null}
        </>
      ) : own && def?.internal ? (
        <p className="builder-action-note" role="note">
          자동 보급 수송대는 서버 운송에만 사용되며 직접 이동·공격·합병·해산할 수 없어요.
        </p>
      ) : null}
    </>
  );
}
export function Production({ game, city, disabled, onChoose, onTrade, onBuy, encampmentTarget, onEncampmentTarget, onPickEncampment }) {
  const [wallRepairTarget, setWallRepairTarget] = useState("");
  const detailedSupply = detailedLogisticsState(game).enabled;
  const wallRepair = wallRepairEligibility(city, game.turn);
  const showWallRepair =
    wallRepair.available && wallRepair.wall < wallRepair.wallMax;
  const wallRepairCandidates = Array.isArray(city.wallRepairCandidates)
    ? city.wallRepairCandidates
        .map((candidate) => ({
          ...candidate,
          q: Number(candidate?.q),
          r: Number(candidate?.r),
        }))
        .filter(
          (candidate) =>
            Number.isFinite(candidate.q) && Number.isFinite(candidate.r),
        )
    : [];
  const wallRepairTargets = [
    ...(showWallRepair
      ? [
          {
            key: "city",
            label: "도시 성벽",
            target: null,
            wallHp: wallRepair.wall,
            wallMaxHp: wallRepair.wallMax,
            issue: wallRepair.eligible ? null : wallRepair.reason,
          },
        ]
      : []),
    ...wallRepairCandidates.map((candidate) => ({
      key: `${candidate.q},${candidate.r}`,
      label: `주둔지 성벽 · ${candidate.q},${candidate.r}`,
      target: { q: candidate.q, r: candidate.r },
      wallHp: candidate.wallHp,
      wallMaxHp: candidate.wallMaxHp,
      issue: candidate.repairIssue ?? candidate.issue ?? null,
    })),
  ];
  const selectedWallRepairKey = wallRepairTargets.some(
    (target) => target.key === wallRepairTarget,
  )
    ? wallRepairTarget
    : wallRepairTargets[0]?.key ?? "";
  const selectedWallRepair = wallRepairTargets.find(
    (target) => target.key === selectedWallRepairKey,
  );
  const wallRepairDefinition = selectedWallRepair?.target
    ? productionType("wallRepair", {
        ...city,
        productionTarget: selectedWallRepair.target,
        productionTargetWallMaxHp: selectedWallRepair.wallMaxHp,
        wallRepairStartHp: selectedWallRepair.wallHp,
      })
    : productionType("wallRepair", city);
  const regularTypes = Object.entries(TYPES).filter(
    ([type, definition]) =>
      !definition.internal &&
      type !== "merchant" &&
      (!detailedSupply || definition.civilian),
  );
  return (
    <>
      <p className="description">
        {city.name} · 턴당 생산력 {city.productionRate} · 비축 생산력 {city.storedProduction ?? 0}
        {game.economy.armyCapacityEnabled !== false
          ? ` · 병력 ${game.economy.used}/${game.economy.capacity}`
          : " · 상세 보급 ON · 병력 수용량 대신 인구 동원"}
      </p>
      {wallRepairTargets.length > 1 ? (
        <label className="production-target-picker">
          성벽 수리 대상
          <select
            value={selectedWallRepairKey}
            disabled={disabled}
            onChange={(event) => setWallRepairTarget(event.target.value)}
          >
            {wallRepairTargets.map((target) => (
              <option key={target.key} value={target.key}>
                {target.label}
                {target.wallHp != null && target.wallMaxHp != null
                  ? ` · ${target.wallHp}/${target.wallMaxHp}`
                  : ""}
              </option>
            ))}
          </select>
          <small>공격이 멈춘 뒤 5턴이 지나야 수리할 수 있어요.</small>
        </label>
      ) : wallRepairTargets.length === 1 && wallRepairTargets[0].target ? (
        <p className="production-target-note">
          {wallRepairTargets[0].label} · {wallRepairTargets[0].wallHp ?? "?"}/
          {wallRepairTargets[0].wallMaxHp ?? "?"}
        </p>
      ) : null}
      <div className="production-list">
        {[
          ...regularTypes.map(([type]) => [type, productionType(type, city)]),
          ...((city.wallLevel ?? 0) < 3
            ? [["walls", productionType("walls", city)]]
            : []),
          ...(wallRepairTargets.length
            ? [["wallRepair", wallRepairDefinition]]
            : []),
        ].map(([type, def]) => {
          const requiredManpower =
            type === "walls" || type === "wallRepair"
              ? 0
              : game.economy.manpowerCost ?? 0.5;
          const availableManpower =
            city.population + (city.manpowerReserved ?? 0) -
            (game.economy.minimumCityPopulation ?? 1);
          const manpowerAffordable = availableManpower >= requiredManpower;
          const wallRepairAllowed =
            type !== "wallRepair" ||
            (selectedWallRepair && !selectedWallRepair.issue);
          const affordable =
            wallRepairAllowed &&
            manpowerAffordable &&
            Object.entries(def.resources).every(
              ([r, n]) =>
                game.economy.resources[r] +
                  (city.queue
                    ? (productionType(city.queue, city).resources[r] ?? 0)
                    : 0) >=
                n,
            );
          const estimate = estimateCityProduction(city, type, def);
          const eta = estimate.complete
            ? "완성 대기"
            : estimate.turns == null
              ? `생산력 ${estimate.productionRate}/턴`
              : `예상 ${estimate.turns}턴`;
          const price = game.economy.unitPrices?.[type] ?? def.cost;
          const buyable =
            !!onBuy &&
            (game.capabilities?.populationRules === true || game.rulesVersion === "expansion-v1") &&
            !!TYPES[type] &&
            !TYPES[type].internal &&
            type !== "merchant" &&
            (!detailedSupply || TYPES[type].civilian);
          return (
            <div
              key={type}
              className={`production-row-wrap ${city.queue === type ? "selected" : ""}`}
            >
            <button
              disabled={disabled || !affordable}
              className={`production-row ${city.queue === type ? "selected" : ""}`}
              onClick={() =>
                onChoose(
                  type,
                  type === "wallRepair" && selectedWallRepair?.target
                    ? selectedWallRepair.target
                    : null,
                )
              }
            >
              <div className="production-icon">
                {type === "walls" || type === "wallRepair" ? (
                  <Icon name="walls" />
                ) : (
                  <UnitIcon type={type} />
                )}
              </div>
              <span>
                <strong>{def.name}</strong>
                <small>{def.description}</small>
                <Cost type={type} city={city} definition={def} />
              </span>
              <b className="production-eta" aria-label={`${def.name} ${eta}`}>
                {affordable
                  ? eta
                  : type === "wallRepair" && !wallRepairAllowed
                    ? selectedWallRepair?.issue ?? "수리 대상의 조건을 확인해 주세요."
                  : !manpowerAffordable
                    ? `인구 ${Math.max(0, requiredManpower - availableManpower).toFixed(1)} 부족`
                  : Object.entries(def.resources)
                      .filter(
                        ([r, n]) =>
                          game.economy.resources[r] +
                            (city.queue
                              ? (productionType(city.queue, city).resources[
                                  r
                                ] ?? 0)
                              : 0) <
                          n,
                      )
                      .map(
                        ([r, n]) =>
                          `${RESOURCES[r].name} ${n - game.economy.resources[r] - (city.queue ? (productionType(city.queue, city).resources[r] ?? 0) : 0)} 부족`,
                      )
                      .join(" · ")}
              </b>
            </button>
            {buyable ? (
              <button
                className="production-buy"
                disabled={
                  disabled ||
                  !manpowerAffordable ||
                  (game.economy.gold ?? 0) < price ||
                  Object.entries(def.resources).some(
                    ([r, n]) => (game.economy.resources[r] ?? 0) < n,
                  )
                }
                onClick={() => onBuy(type)}
                aria-label={`${def.name} 골드로 즉시 구매 · ${price}G`}
                data-tip={`골드 ${price}로 지금 바로 생성해요 · 인구 0.5 배정 · 자원 조건은 생산과 같아요.`}
              >
                {price}G
              </button>
            ) : null}
            </div>
          );
        })}
      </div>
      {detailedSupply ? (
        <>
          <p className="description logistics-production-note">
            상세 보급 ON에서는 전투 병력을 인구 동원 대기열에서 한 기씩 예약해요.
          </p>
          <ManpowerDetails
            city={city}
            game={game}
            disabled={disabled}
            onTrade={onTrade}
          />
        </>
      ) : null}
      <LogisticsProductionOptions
        encampmentTarget={encampmentTarget}
        onEncampmentTarget={onEncampmentTarget}
        onPickEncampment={onPickEncampment}
        game={game}
        city={city}
        disabled={disabled}
        onChoose={onChoose}
      />
      {
        <button
          className="text-button"
          disabled={disabled}
          onClick={() => {
            if (!confirmClearProduction(city)) return;
            onChoose(null);
          }}
        >
          <Icon name="wheat" size={16} /> 생산 안 함 · 식량 생산 +25% · 생산력 비축(최대 {PRODUCTION_BANK_CAP})
        </button>
      }
      {(game.capabilities?.populationRules === true || game.rulesVersion === "expansion-v1") && onBuy && detailedSupply ? (
        <small className="logistics-footnote">
          상세 보급 ON에서는 전투 병력 즉시 구매를 숨기고 인구 동원 대기열에서 예약해요. 각 줄의 골드 버튼은 민간 유닛만 보여요.
        </small>
      ) : null}
      <p className="fine-print">
        자원은 생산을 예약할 때 차감돼요. 생산을 바꾸거나 취소하면 예약 자원이
        반환돼요. 생산 종류를 바꾸면 쌓인 생산력은 초기화돼요. 생산을 예약하지
        않은 턴의 생산력은 최대 {PRODUCTION_BANK_CAP}까지 비축되어 다음 예약에 즉시
        더해지고, 완성 후 남은 생산력도 비축돼요. 건축가와 전투
        유닛은 도시 칸에 함께 있을 수 있고, 같은 분류가 있거나 수용량이 가득
        차면 완성 대기해요. 생산·즉시 구매마다 인구 0.5를
        배정하고, 도시는 최소 인구 1명을 남겨요. 성벽은 3레벨까지 증축하며
        유닛 칸을 사용하지 않아요.
      </p>
    </>
  );
}
export function Rules() {
  return (
    <div className="rules-content">
      <p>
        농지로 인구를 늘리고, 자원으로 병력을 갖추고, 상대의 전선을 돌파하세요.
      </p>
      <h3>턴과 승리</h3>
      <p>
        내 턴 60초 → 상대 턴 60초로 번갈아 행동해요. 시간 초과나 ‘턴 마치기’는
        내 도시의 식량·성장·생산을 정산하고 상대에게 넘겨요. 설정에서 방장이
        10~300초로 바꾸면 다음 차례부터 양쪽에 적용돼요. 이동·공격·건설은 내
        턴에 즉시 실행돼요. 네 문명의 수도를 모두 확보하면 승리해요. 수도는 방어
        시설 파괴 후 창병·머스킷병·기병으로 진입해 점령해요. 40턴에는 인구×5 +
        농지×3 + 병력 편성×2 점수로 결정해요.
      </p>
      <h3>내정과 자원</h3>
      <p>
        농지 식량은 기본 1 + 비옥도 + 인접한 아군 농지 수예요. 구릉지 농지는 평지보다 식량이 1 적고 도시 생산력을 1 더해요. 보급 OFF에서는
        도시별 생산에서 시민 소비를 뺀 잉여로 성장 진척을 계산하며, 이 진척을
        저장 식량·거래·수송 화물로 취급하지 않아요. 보급 ON에서는 도시 저장
        식량과 유닛별 식량을 따로 사용해요. 도시의 병력 소비 수치는 보급 수요를
        보여주는 정보이고, 실제 병력 식량은 유닛 보급으로 정산돼요. 철·말·초석
        매장지를 건축자로 개발하면 보급된 시설마다 턴당 자원 1을 얻어요.
      </p>
      <h3>생산력 비축과 지형 특성</h3>
      <p>
        도시가 아무것도 생산하지 않는 턴의 생산력은 최대 {PRODUCTION_BANK_CAP}까지
        비축되고, 다음 생산을 예약하면 즉시 더해져요. 완성 후 남는 생산력도
        비축돼요. 평지·구릉지에는 숲, 비옥한 평지에는 밀밭이 있어요. 건축자가
        숲을 베면(건설 1회) 가장 가까운 내 도시에 즉시 생산력 +{CHOP_PRODUCTION}을
        주고, 숲이 있는 칸은 벌목 후에만 농지를 지을 수 있어요. 밀밭에 농지를
        지으면 황금빛 농지가 되어 식량 +{WHEAT_FARM_FOOD_BONUS}을 더 내고, 대신
        수확하면(건설 1회) 즉시 식량 +{HARVEST_FOOD} · 생산력 +{HARVEST_PRODUCTION}을
        얻고 밀밭이 사라져요. 개발하지 않은 철·말·초석 매장지는 채굴해(건설
        1회) 즉시 자원 +{HARVEST_RESOURCE_AMOUNT} · 생산력 +{HARVEST_PRODUCTION}을
        얻을 수 있지만 매장지는 영구히 사라져요. 벌목·수확은 내 영토나 내
        영토에 인접한 빈 땅에서만 할 수 있어요.
      </p>
      <p>
        유닛은 도시 타일에 생성돼요. 보급 ON의 전투 병력은 도시별 인구 동원
        대기열에서 예약하고 자기 턴마다 한 기씩 출병해요. 예약 시민은 출병 전까지
        일하며, 성공 출병 때만 인구 0.5명이 배정돼요. 보급 OFF의 기본 생산은
        기존 생산 방식을 따르고, 도시는 모드 전환으로 인구·성장 진척을 잃지 않아요.
        민간 유닛 1개와 전투 부대 1개는 같은 칸을 공유할 수 있어요.
      </p>
      <p>
        개척자는 생산력 40으로 생산하고 이동력 2·시야 3을 가져요. 기존 도시에서
        4칸 이상 떨어진 평지에 인구 1의 도시를 세우면 소모돼요. 다른 문명
        영토에는 정착할 수 없으며, 건축자는 도시를 세우지 않아요.
      </p>
      <h3>영토·골드·외교</h3>
      <p>
        상단 문명 아이콘이나 상대 도시를 누르면 외교 창이 열려요.
        전쟁·동맹·좋음·보통·사이나쁜·공개비난 관계를 표시해요. 거래 창 양쪽
        카드에서 골드·자원·도시·유닛·참전을 고르고 10턴 동맹도 함께 제안할 수
        있어요. 사람 상대는 직접 수락해야 소유권 이전·참전이 성립해요.
        선전포고는 모든 세력에 알려져요. 일시정지는 사용자 p1만 가능하며 모든
        명령과 초시계가 멈춰요.
      </p>
      <h3>성벽과 범위</h3>
      <p>공개비난은 10턴 지속되고 3턴이 지나면 공식 전쟁을 선포할 수 있어요. 비난 중에는 동맹을 맺을 수 없어요. 동맹은 10턴마다 갱신할 수 있고 공격·방어 전쟁에 함께 참전해요. 개전 후 10턴 동안 평화 협정은 금지돼요. 기습 전쟁은 제3국과의 관계를 악화시켜요.</p>
      <p>내 국경 안과 주변 2칸에 상대가 정착하면 도시 자진 철거를, 상대 군대가 3턴 연속 관측되면 철군을 최후통첩으로 요구할 수 있어요. 수락하면 10턴간 재정착·군대 재진입이 금지되며 먼저 선전포고해야 다시 들어갈 수 있어요. 거절하면 즉시 명분을 얻고 직접 명분 전쟁을 선포할 수 있어요. 도시 상세에서는 자진 철거를 확인 후 실행할 수 있고, 마지막 도시를 철거하면 패배할 수 있어요.</p>
      <p>
        도시 생산에서 성벽을 1~3레벨로 건설·증축해요. 비용은 30·55·80 생산력,
        레벨마다 체력 +50. 성벽 도시에서는 보이는 2칸 이내 적 유닛에 턴당 한 번
        포격할 수 있어요. 흰 외곽선은 남은 이동력 기준 이동 범위, 붉은 외곽선은
        공격 사거리예요. 적에게 커서를 올리면 현재 관측한 상태로 예상 피해와
        지형·상성 보정을 보여줘요.
      </p>
      <p>
        인구 3명마다 자연 확장 반경이 1 늘어나 최대 3칸까지 확장돼요. 인접한
        미소유 땅은 골드로 구매할 수 있어요. 골드는 인구당 턴에 2를 얻고,
        식량·자원·유닛 판매로도 얻어요. 시장에서 식량·자원을 구매하거나 평화
        제안금으로 쓸 수 있어요. 일반 세력은 중립으로 시작하며 선전포고해야
        공격할 수 있어요. 제3세력·도시국가와의 평화는 40G 이상, 플레이어 상대는
        직접 수락해야 해요. 협정은 5턴이며 야만인은 상시 적대예요.
      </p>
      <p>
        확장 대전은 정착 전의 개척자와 병력으로 시작해요. 인구 성장 식량의
        절반에서 영토 1칸, 정수 인구 증가에서 다음 1칸을 얻고 자동 영토는
        반경 3칸을 넘지 않아요. 생산·즉시 구매 유닛은 도시 인구 0.5를
        배정하며 최소 인구 1명을 남겨요. 해산은 기록된 인구만 반환하고,
        전투 사망·판매는 반환하지 않아요. 기존 저장 유닛은 0 비용으로
        이관되어 업데이트 때 인구가 갑자기 줄지 않아요.
      </p>
      <h3>병종과 합병</h3>
      <p>
        창병은 자원 없이 생산하며 기병에게 피해 ×2. 기병은 말 2가 필요하고
        머스킷병에게 ×2. 머스킷병은 초석 2, 포병은 철 2·초석 2가 필요해요.
        포병은 근접 직접 공격을 받을 때 피해 ×2. 반대로 자신을 상대하는 병종을
        공격하면(역상성) 피해 ×0.75예요. 한 유닛은 대대예요. 인접한 같은
        병종은 같은 편제끼리만 합쳐요: 대대+대대→여단, 여단+여단→사단. 대대는
        여단에 합칠 수 없고 사단은 더 합칠 수 없어요. 기존 3개 편성은 그대로
        유지되며, 합병 후 체력을 합산하고 경험치는 편성 수로 가중 평균해요.
      </p>
      <h3>전투 결과와 경험치</h3>
      <p>
        전투에서 두 부대가 모두 전멸하는 일은 없어요. 서로 치명타를 주고받으면
        남은 전력이 더 높은 쪽(동률이면 공격자)이 체력 1로 살아남아요. 전투에
        참여한 부대는 매 전투마다 경험치 +1, 적 부대를 격파하면 +3, 상대 전력이
        1.5배 이상이거나 역상성이거나 상대 편제가 더 클 때 격파하면 +5를 얻어요.
        공격력과 방어력은 남은 체력에 정비례해요: 체력 50%면 −50%, 체력 10%면
        −90%이고 하한은 없어요.
      </p>
      <h3>이동과 지형</h3>
      <p>
        평지는 이동력 1, 구릉지는 2, 산지는 이동 불가예요. 적 병력의 인접 칸에
        들어가면 이동이 멈춰요. 이미 적 옆에 있다면 한 칸만 이동할 수 있어요.
        구릉지의 방어력은 +20%. 강을 건너면 도하 턴과 이후 2턴 동안 전투력 −20%,
        강 너머 직접 공격은 추가 −25%예요. 포병 포격, 머스킷병 2칸 사격, 도시 성벽
        포격 같은 원거리 사격은 사수와 목표 사이 직선의 중간 칸이 산이면 불가능해요.
        직선이 두 칸 사이를 정확히 지나면 두 칸이 모두 산일 때만 막혀요.
      </p>
      <p>
        유닛을 선택한 뒤 우클릭하면 이동해요. 우클릭을 누른 채 경유지를 그릴
        수도 있어요. 경로 숫자 1은 이번 내 턴, 2는 다음 내 턴이에요. 남은 경로는
        다음 내 턴 시작에 진행돼요. 같은 유닛을 좌클릭하면 남은 경로만 취소돼요.
        공격은 턴당 1회이고 이동력을 모두 소모해요. 공격하지 않았다면 이동력이
        0이어도 바로 옆의 적을 공격할 수 있어요. 적에게 이동 명령을 내리면 접근
        후 교전해요.
      </p>
      <h3>방어와 보급</h3>
      <p>
        방어 명령으로 한 턴 제자리에 머물면 다음 전투부터 방어력 +25%. 이동·공격
        시 해제돼요. 12칸 이상의 통행 가능한 배후지와 이어진 아군 도시가 보급의
        기반이에요. 그 도시와 연결된 육로로 병력과 시설에 보급해요. 산, 적 도시,
        적 점유·통제 칸은 보급을 막으며 영토 색깔만으로는 끊기지 않아요. 아군
        병력이 있는 칸은 적 인접 통제를 상쇄해요. 유닛과 도시의 보급이 끊기면 매
        턴 불이익 12%가 쌓여 최대 60%가 되고, 3턴째부터 체력도 줄어요. 연결이
        회복되면 매 턴 12%씩 풀려요.
      </p>
      <h3>시야와 경험치</h3>
      <p>
        시야 밖의 적은 현재 위치 대신 마지막 관측 위치를 흐리게 표시해요. UI와
        API 모두 같은 게임 내 관측 기록을 받아요. 20×20 지도는 동쪽과 서쪽이
        연결되고 북·남쪽은 연결되지 않아요. 미탐사 지역은 지형·비옥도·매장
        자원까지 숨겨요. 고지도 무늬는 실제 지형과 무관하며 한 번 탐사한 지형은
        기억돼요. 포병이 발사하면 발사 위치만 노출되고, 이후 이동한 위치는
        알려주지 않아요. 포격이 명중하면 해당 적과 칸은 이번 턴에 드러나요. 적이
        다른 시야 밖 칸으로 이동하면 마지막 위치만 남고, 빗나가면 적 위치를
        알려주지 않아요. 적과 교전하면 공격자와 방어자 모두 경험치 2, 격파 시
        공격자는 4를 더 얻어요. 레벨당 전투력이 8% 올라요.
      </p>
      <p>
        공성 피해는 병종·현재 체력·경험치·보급을 반영해요. 포병은 공성 보너스
        +35%를 받지만 가까운 적에게 취약해 호위가 필요해요. 안전한 곳에서 이번
        턴에 공격하지 않았으면 이동했어도 턴 종료 시 편성 하나당 체력 8을
        회복해요. 합병한 턴이나 보급 단절 중에는 회복하지 않아요.
      </p>
      <h3>AI와의 공정한 경기</h3>
      <p>
        상대는 플레이어에게 보이는 상태를 텍스트로 받아 직접 명령해요. 외부 전략
        메모, 계산·시뮬레이션 코드, 다른 에이전트, 숨겨진 상태 접근은 금지예요.
        대화 문맥에 과거 관측이 남을 수 있다는 한계는 있어요. 연습 모드의 상대는
        명령 없이 방어만 하고 3초 뒤 차례를 넘기며, 실제 추론 AI가 아니에요.
        청람·자운은 자기 관측만으로 농지·자원 개발, 병력 생산, 정찰,
        방어·회복·교전과 외교를 판단하는 게임 내 NPC예요.
      </p>
      <p className="fine-print">
        현재 경기는 서버 메모리에 있어요. 서버를 재시작하면 경기가 초기화돼요.
      </p>
    </div>
  );
}
