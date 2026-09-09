import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import {
  MARKET,
  RESOURCES,
  TYPES,
  maxHealth,
  label,
  neighbors,
  key,
  TERRAINS,
} from "../shared/rules.js";
import { Icon } from "./Icons.jsx";
import { Modal } from "./Panels.jsx";
import { unlockSound, playSound, soundStatus } from "./sound.js";
import { factionFor } from "./factions.js";
import { detailedLogisticsState } from "./logisticsHelpers.js";
import { ExperimentEditor } from "./ExperimentEditor.jsx";

export function HelpTip() {
  const [tip, setTip] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (
      tip &&
      ref.current?.showPopover &&
      !ref.current.matches(":popover-open")
    )
      ref.current.showPopover();
  }, [tip]);
  useEffect(() => {
    const show = (e) => {
      const el = e.target.closest?.("[data-tip],button,[title],input,select");
      if (!el) {
        setTip(null);
        return;
      }
      const text =
        el.dataset.tip ||
        el.title ||
        el.getAttribute("aria-label") ||
        el.textContent?.trim();
      if (!text) {
        setTip(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setTip({
        text,
        x: Math.max(
          12,
          Math.min(innerWidth - 292, rect.left + rect.width / 2 - 140),
        ),
        y: rect.top > 110 ? rect.top - 12 : rect.bottom + 12,
        above: rect.top > 110,
      });
    };
    const hide = () => setTip(null);
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("focusout", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("focusout", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);
  return tip
    ? createPortal(
        <div
          ref={ref}
          popover="manual"
          role="tooltip"
          className="help-tip"
          style={{
            left: tip.x,
            top: tip.y,
            transform: tip.above ? "translateY(-100%)" : undefined,
          }}
        >
          {tip.text}
        </div>,
        document.body,
      )
    : null;
}

export function Settings({
  game,
  busy,
  onSave,
  onClose,
  onOpenSaves,
  soundEnabled,
  setSoundEnabled,
  volume,
  setVolume,
  children,
}) {
  const [seconds, setSeconds] = useState(game.turnSeconds ?? 60);
  const [saved, setSaved] = useState(false);
  const [audioStatus, setAudioStatus] = useState("");
  return (
    <Modal title="설정" onClose={onClose}>
      <button className="soft-button full" onClick={onOpenSaves}>
        경기 저장 · 불러오기
      </button>
      <div className="settings-section">
        <label htmlFor="turn-seconds">
          턴 제한 시간 <strong>{seconds}초</strong>
        </label>
        <input
          id="turn-seconds"
          type="range"
          min="10"
          max="300"
          step="5"
          value={seconds}
          onChange={(e) => {
            setSeconds(Number(e.target.value));
            setSaved(false);
          }}
          disabled={game.playerId !== "p1"}
          data-tip="10~300초. 방장이 변경하면 다음 턴부터 양쪽 플레이어에게 똑같이 적용돼요."
        />
        <div className="time-presets">
          {[30, 60, 90, 120, 180, 300].map((n) => (
            <button
              className={n === seconds ? "active" : ""}
              key={n}
              disabled={game.playerId !== "p1"}
              onClick={() => {
                setSeconds(n);
                setSaved(false);
              }}
            >
              {n}초
            </button>
          ))}
        </div>
        <p className="description">
          다음 턴부터 경기 전체에 적용돼요. 진행 중인 초시계는 초기화하지
          않아요.{game.playerId !== "p1" ? " 시간 변경은 방장만 가능해요." : ""}
        </p>
        <button
          className="primary full"
          disabled={busy || game.playerId !== "p1"}
          onClick={async () => {
            if (await onSave(seconds)) setSaved(true);
          }}
        >
          {saved ? "저장됨 · 다음 턴부터 적용" : "턴 시간 저장"}
        </button>
      </div>
      <div className="settings-section">
        <label htmlFor="sound-switch">
          게임 소리{" "}
          <input
            id="sound-switch"
            type="checkbox"
            checked={soundEnabled}
            onChange={(e) => {
              unlockSound();
              setSoundEnabled(e.target.checked);
              if (e.target.checked) playSound("move", volume);
            }}
          />
        </label>
        <label htmlFor="sound-volume">
          볼륨 <strong>{Math.round(volume * 100)}%</strong>
        </label>
        <input
          id="sound-volume"
          type="range"
          min="0"
          max="1"
          step=".05"
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          onPointerUp={() => {
            unlockSound();
            if (soundEnabled) playSound("move", volume);
          }}
        />
        <p className="description">
          이동 · 건설 · 총격 · 포격 · 피격 · 턴 전환 · 선전포고. 이 기기의 소리
          설정만 저장돼요.
        </p>
        <button
          className="soft-button"
          disabled={!soundEnabled || volume <= 0}
          onClick={() => {
            playSound("war", volume);
            setTimeout(
              () =>
                setAudioStatus(
                  soundStatus().state === "running"
                    ? "효과음을 재생했어요. 들리지 않으면 기기·브라우저의 음소거도 확인해 주세요."
                    : "브라우저의 소리 재생 권한을 확인해 주세요.",
                ),
              300,
            );
          }}
        >
          효과음 테스트
        </button>
        {audioStatus ? (
          <p className="fine-print" role="status">
            {audioStatus}
          </p>
        ) : null}
      </div>
      {children}
    </Modal>
  );
}

/**
 * Host-editable combat numbers. Values mirror the server's `balance`
 * observation field; the server clamps and stores them, so this form never
 * invents a rule the engine does not apply.
 */
export function BalanceSetting({ game, busy, onChange }) {
  const balance = game.balance ?? {};
  const [draft, setDraft] = useState(() => ({
    unitAttack: { ...(balance.unitAttack ?? {}) },
    counterMultiplier: balance.counterMultiplier ?? 1,
    cityBaseAttack: balance.cityBaseAttack ?? 20,
    cityAttackPerPop: balance.cityAttackPerPop ?? 3,
  }));
  const [status, setStatus] = useState("");
  const host = game.playerId === "p1";
  const editable =
    host &&
    (game.experiment ||
      game.mode === "practice" ||
      game.paused === true ||
      game.phase === "lobby");
  const setField = (field, value) =>
    setDraft({ ...draft, [field]: Number(value) });
  return (
    <div className="settings-section balance-setting">
      <h3>전투 밸런스</h3>
      <p className="description">
        병종별 기본 공격력, 근접 반격 배율, 도시 수비 반격(기본 + 인구 × 계수).
        연습·실험 경기에서는 언제든, 대전에서는 일시정지 중에만 방장이 바꿀 수
        있어요. 바뀐 값은 다음 전투부터 양쪽 모두에게 적용돼요.
      </p>
      <div className="balance-grid">
        {Object.entries(draft.unitAttack).map(([type, value]) => (
          <label key={type}>
            {TYPES[type]?.name ?? type} 공격력
            <input
              type="number"
              min="1"
              max="200"
              value={value}
              disabled={!editable}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  unitAttack: { ...draft.unitAttack, [type]: Number(e.target.value) },
                })
              }
            />
          </label>
        ))}
        <label>
          근접 반격 배율
          <input
            type="number"
            step="0.05"
            min="0"
            max="3"
            value={draft.counterMultiplier}
            disabled={!editable}
            onChange={(e) => setField("counterMultiplier", e.target.value)}
          />
        </label>
        <label>
          도시 반격 기본
          <input
            type="number"
            min="0"
            max="200"
            value={draft.cityBaseAttack}
            disabled={!editable}
            onChange={(e) => setField("cityBaseAttack", e.target.value)}
          />
        </label>
        <label>
          도시 반격 인구당
          <input
            type="number"
            min="0"
            max="50"
            value={draft.cityAttackPerPop}
            disabled={!editable}
            onChange={(e) => setField("cityAttackPerPop", e.target.value)}
          />
        </label>
      </div>
      <button
        className="primary full"
        disabled={busy || !editable}
        onClick={async () => {
          const ok = await onChange(draft);
          setStatus(ok ? "적용됨 · 다음 전투부터 반영" : "적용하지 못했어요");
        }}
      >
        밸런스 적용
      </button>
      <p className="fine-print" role="status">
        {status ||
          (!host
            ? "방장만 바꿀 수 있어요."
            : editable
              ? ""
              : "대전에서는 일시정지 중에만 바꿀 수 있어요.")}
      </p>
    </div>
  );
}

/** Host switch between sequential seats and one shared simultaneous round. */
export function TurnModeSetting({ game, busy, onChange }) {
  const host = game.playerId === "p1";
  const editable = host && (game.paused === true || game.phase === "lobby");
  const current = game.turnMode ?? "sequential";
  return (
    <div className="settings-section turn-mode-setting">
      <h3>턴 방식</h3>
      <p className="description">
        턴 방식은 상세 보급·자원 소비 설정과 별개예요. 바꿔도 기존 경제 규칙은 유지돼요.{" "}
        교대 턴은 좌석 순서대로 한 명씩, 동시 턴은 모든 문명이 같은 시간에
        움직이고 전원 준비 완료나 시간 종료 때 함께 정산해요. 같은 칸은 먼저
        움직인 쪽이 차지해요. 대기실이거나 일시정지 중일 때 방장이 바꿀 수 있어요.
      </p>
      <div className="time-presets">
        {[
          ["sequential", "교대 턴"],
          ["simultaneous", "동시 턴"],
        ].map(([value, name]) => (
          <button
            key={value}
            className={current === value ? "active" : ""}
            disabled={busy || !editable || current === value}
            onClick={() => onChange(value)}
          >
            {name}
          </button>
        ))}
      </div>
      {!editable ? (
        <p className="fine-print">
          {host ? "일시정지하거나 대기실에서 바꿀 수 있어요." : "방장만 바꿀 수 있어요."}
        </p>
      ) : null}
    </div>
  );
}

/** Experiment-practice sandbox: pick a unit, a side and a tile to spawn. */
export function ExperimentPanel({
  game,
  tool,
  setTool,
  active,
  onToggle,
  unit,
  onRemove,
  onEdit,
  busy,
}) {
  const types = Object.entries(TYPES).filter(([, t]) => !t.internal);
  return (
    <div className="experiment-panel" role="group" aria-label="실험 모드">
      <strong>실험 모드 · 즉시 소환</strong>
      <label>
        병종
        <select
          value={tool.type}
          onChange={(e) => setTool({ ...tool, type: e.target.value })}
        >
          {types.map(([type, t]) => (
            <option key={type} value={type}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        진영
        <select
          value={tool.side}
          onChange={(e) => setTool({ ...tool, side: e.target.value })}
        >
          <option value="mine">내 편</option>
          <option value="enemy">적 · 야만인</option>
        </select>
      </label>
      <label>
        체력
        <input
          type="number"
          min="1"
          max="100"
          value={tool.hp}
          onChange={(e) =>
            setTool({
              ...tool,
              hp: Math.max(1, Math.min(100, Number(e.target.value) || 100)),
            })
          }
        />
      </label>
      <button
        className={active ? "primary" : "soft-button"}
        onClick={onToggle}
        disabled={busy}
      >
        {active ? "소환 중 · 지도 칸을 클릭" : "칸 클릭으로 소환"}
      </button>
      <button
        className="text-button"
        disabled={busy || !unit}
        onClick={onRemove}
      >
        {unit
          ? `${label(unit)} ${TYPES[unit.type]?.name ?? ""} 제거`
          : "선택한 유닛 제거"}
      </button>
      <ExperimentEditor key={unit?.id ?? "none"} game={game} unit={unit} busy={busy} onEdit={onEdit} />
    </div>
  );
}

export function RulesUpgradeSetting({ game, busy, onUpgrade }) {
  const compatibility = game?.compatibility;
  if (!compatibility?.canUpgradeRules) return null;
  const canApply =
    game.playerId === "p1" && game.paused === true && game.phase === "planning";
  return (
    <div className="settings-section rules-upgrade-setting">
      <h3>최신 규칙 적용</h3>
      <p className="description">
        현재 지도·도시·유닛·턴은 유지한 채 확장 규칙을 적용해요. 이후 성장 반경은
        3칸, 유닛 생산은 0.5명 동원, 건축자 생산 비용은 2배가 됩니다.
      </p>
      <button
        type="button"
        className="soft-button full"
        disabled={busy || !canApply}
        onClick={() => onUpgrade({ upgradeRules: true })}
      >
        현재 경기에 최신 규칙 적용
      </button>
      {!canApply ? (
        <small className="fine-print">
          일시정지한 방장만 적용할 수 있어요.
        </small>
      ) : null}
    </div>
  );
}

export function Market({ game, disabled, onTrade, onClose }) {
  const cities = game.cities.filter((c) => c.owner === game.playerId);
  const logisticsState = detailedLogisticsState(game);
  const detailedSupply = logisticsState.enabled;
  const offSupply = logisticsState.supported && !detailedSupply;
  const [cityId, setCityId] = useState(cities[0]?.id ?? "");
  const [amount, setAmount] = useState(1),
    [confirm, setConfirm] = useState(null);
  const city = cities.find((c) => c.id === cityId);
  return (
    <Modal title="시장" onClose={onClose}>
      <div className="market-balance">
        <span>보유 골드</span>
        <strong>{game.economy.gold} G</strong>
        <small>+{game.economy.goldIncome} / 턴</small>
      </div>
      <div className="trade-controls">
        <label>
          식량 거래 도시
          <select value={cityId} onChange={(e) => setCityId(e.target.value)}>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          거래 수량
          <select
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          >
            {[1, 5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n}개
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="market-list">
        {Object.entries(MARKET).map(([resource, rate]) => {
          const foodTradeLocked = resource === "food" && offSupply;
          const stock =
            resource === "food"
              ? (city?.food ?? 0)
              : game.economy.resources[resource];
          return (
            <div key={resource}>
              <Icon
                name={resource === "food" ? "wheat" : RESOURCES[resource].icon}
              />
              <span>
                <strong>
                  {foodTradeLocked ? "식량 거래 잠김" : resource === "food" ? "비축 식량" : RESOURCES[resource].name}
                </strong>
                <small>
                  {foodTradeLocked
                    ? "상세 보급 ON에서 가능"
                    : resource === "food"
                      ? `저장 ${stock}`
                      : `보유 ${stock}`}
                </small>
              </span>
              <button
                className="soft-button"
                disabled={
                  disabled ||
                  foodTradeLocked ||
                  game.economy.gold < rate.buy * amount ||
                  (resource === "food" &&
                    city?.foodCapacity != null &&
                    stock + amount > city.foodCapacity)
                }
                onClick={() =>
                  onTrade({ action: "buy", resource, amount, cityId })
                }
                data-tip={
                  foodTradeLocked
                    ? "식량 거래는 상세 보급 ON에서 가능해요. OFF에서는 도시별 잉여 식량으로만 성장해요."
                    : `${amount}개 구매 · ${rate.buy * amount}골드 지불.`
                }
              >
                구매 {rate.buy * amount}G
              </button>
              <button
                className="soft-button"
                disabled={
                  disabled ||
                  foodTradeLocked ||
                  stock < amount
                }
                onClick={() =>
                  onTrade({ action: "sell", resource, amount, cityId })
                }
                data-tip={
                  foodTradeLocked
                    ? "식량 거래는 상세 보급 ON에서 가능해요. OFF에서는 도시별 잉여 식량으로만 성장해요."
                    : `${amount}개 판매 · ${rate.sell * amount}골드 수령`
                }
              >
                판매 {rate.sell * amount}G
              </button>
            </div>
          );
        })}
      </div>
      <h3>유닛 관리</h3>
      <p className="description">
        판매한 부대는 즉시 사라지고 골드를 받아요. 해산은 추적된 인구만
        현재 문명의 도시에 돌려주며, 전투로 잃거나 판매한 부대는 반환하지 않아요.
      </p>
      <div className="sell-units">
        {game.units
          .filter((u) => u.owner === game.playerId && !TYPES[u.type]?.internal)
          .map((u) => (
            <div key={u.id}>
              <span>
                {TYPES[u.type].name} · {label(u)}
              </span>
              <button
                className={confirm === u.id ? "danger-button" : "soft-button"}
                disabled={disabled}
                onClick={async () => {
                  if (confirm !== u.id) {
                    setConfirm(u.id);
                    return;
                  }
                  if (await onTrade({ action: "sellUnit", unitId: u.id }))
                    setConfirm(null);
                }}
              >
                {confirm === u.id
                  ? "판매 확정"
                  : `${Math.max(1, Math.floor((TYPES[u.type].cost * u.size * 0.8 * u.hp) / maxHealth(u)))}G 판매`}
              </button>
              <button
                className={confirm === `disband:${u.id}` ? "danger-button" : "soft-button"}
                disabled={disabled}
                onClick={async () => {
                  const key = `disband:${u.id}`;
                  if (confirm !== key) {
                    setConfirm(key);
                    return;
                  }
                  if (await onTrade({ action: "disbandUnit", unitId: u.id }))
                    setConfirm(null);
                }}
              >
                {confirm === `disband:${u.id}`
                  ? "해산 확정"
                  : u.manpowerCost > 0
                    ? `해산 · 인구 ${u.manpowerCost} 반환`
                    : "해산"}
              </button>
            </div>
          ))}
      </div>
    </Modal>
  );
}

export function Diplomacy({
  game,
  disabled,
  tradeDisabled = disabled,
  onTrade,
  onClose,
}) {
  const [offer, setOffer] = useState(40),
    [war, setWar] = useState(null);
  return (
    <Modal title="외교" onClose={onClose}>
      <p className="description">
        일반 세력은 중립으로 시작해요. 선전포고해야 공격할 수 있어요. 평화
        협정은 5턴이며, 제3세력은 40G 이상을 수락해요. 상대 플레이어는 자기 턴에
        수락해야 해요. 야만인은 상시 적대예요.
      </p>
      <label className="offer-input">
        평화 제안금{" "}
        <input
          aria-label="평화 제안 골드"
          type="number"
          min="0"
          max={game.economy.gold}
          value={offer}
          onChange={(e) =>
            setOffer(Math.max(0, Math.floor(Number(e.target.value))))
          }
        />{" "}
        G <small>보유 {game.economy.gold}G</small>
      </label>
      <div className="faction-list">
        {game.factions
          .filter((f) => f.id !== game.playerId)
          .map((f) => (
            <div key={f.id}>
              <i style={{ background: f.color }} />
              <span>
                <strong>{f.name}</strong>
                <small>
                  {f.kind === "barbarian"
                    ? "상시 적대"
                    : f.hostile
                      ? "교전 중"
                      : f.peaceUntil >= game.turn
                        ? `평화 협정 · ${f.peaceUntil - game.turn + 1}턴`
                        : "중립"}
                </small>
              </span>
              {f.kind !== "barbarian" ? (
                f.hostile ? (
                  <button
                    className="soft-button"
                    disabled={
                      tradeDisabled ||
                      offer > game.economy.gold ||
                      game.diplomacy.some(
                        (p) => p.from === f.id || p.to === f.id,
                      )
                    }
                    onClick={() =>
                      onTrade({ action: "peace", factionId: f.id, gold: offer })
                    }
                  >
                    평화 제안
                  </button>
                ) : (
                  <button
                    className={war === f.id ? "danger-button" : "soft-button"}
                    disabled={disabled || f.peaceUntil >= game.turn}
                    onClick={async () => {
                      if (war !== f.id) {
                        setWar(f.id);
                        return;
                      }
                      await onTrade({ action: "declareWar", factionId: f.id });
                      setWar(null);
                    }}
                  >
                    {war === f.id ? "선전포고 확정" : "선전포고"}
                  </button>
                )
              ) : null}
            </div>
          ))}
      </div>
      {game.diplomacy.map((p) => (
        <div className="peace-proposal" key={p.id}>
          <strong>
            {factionFor(game, p.from).name} → {factionFor(game, p.to).name}
          </strong>
          <p>
            {p.gold}G · 5턴 평화 제안 · {p.expires - game.turn}턴 뒤 만료
          </p>
          {p.from === game.playerId ? (
            <button
              className="soft-button"
              disabled={tradeDisabled}
              onClick={() =>
                onTrade({ action: "cancelPeace", proposalId: p.id })
              }
            >
              제안 취소 · 골드 반환
            </button>
          ) : (
            <div className="time-presets">
              <button
                disabled={tradeDisabled}
                onClick={() =>
                  onTrade({ action: "acceptPeace", proposalId: p.id })
                }
              >
                수락
              </button>
              <button
                disabled={tradeDisabled}
                onClick={() =>
                  onTrade({ action: "rejectPeace", proposalId: p.id })
                }
              >
                거절
              </button>
            </div>
          )}
        </div>
      ))}
    </Modal>
  );
}

export function TileCompanion({ game, tile }) {
  // `cityId` is the authoritative assignment.  A city name is optional in
  // the public tile payload, so resolve it only by id (never by nearest city)
  // before falling back to the server's display name.
  const assignedCity = tile?.cityId
    ? game.cities.find((city) => city.id === tile.cityId)
    : null;
  const ownerFaction = tile?.owner ? factionFor(game, tile.owner) : null;
  const ownerName = ownerFaction?.name ?? tile?.owner ?? "미소유 영토";
  const assignedCityName =
    tile?.cityName ?? assignedCity?.name ?? (tile?.cityId ? `도시 ${tile.cityId}` : null);
  const adjacent = neighbors(tile).filter((p) =>
    game.tiles.some(
      (t) =>
        key(t) === key(p) &&
        t.farm &&
        t.owner === (tile.owner ?? game.playerId),
    ),
  ).length;
  return (
    <aside className="tile-companion" aria-label="현재 타일 정보">
      <div>
        <strong>
          {label(tile)} · {TERRAINS[tile.terrain].name}
        </strong>
        <small>
          {tile.terrain === "unknown"
            ? "소유국 · 도시 미확인"
            : tile.owner
              ? `${ownerName} · ${assignedCityName ?? "도시 미확인"}`
              : "미소유 영토"}
        </small>
      </div>
      <p>
        {tile.terrain === "unknown"
          ? "탐사 후 지형·자원 공개"
          : tile.terrain === "mountain"
            ? "이동 불가"
            : `이동력 ${TERRAINS[tile.terrain].cost} · 비옥도 ${tile.fertility}/3`}
      </p>
      {tile.fort?.hp > 0 ? (
        <div className="tile-yield">
          <Icon name="walls" size={17} />
          <span>
            요새{" "}
            <b>
              {tile.fort.hp}/{tile.fort.maxHp}
            </b>
            <small>
              아군 주둔 방어력 +25%{tile.visible ? "" : " · 마지막 관측"}
            </small>
          </span>
        </div>
      ) : tile.terrain !== "mountain" && tile.terrain !== "unknown" ? (
        <div
          className="tile-yield"
          data-tip="농지 식량 = 기본 1 + 비옥도 + 인접한 같은 세력 농지 수. 여섯 방향 인접을 계산해요."
        >
          <Icon name="wheat" size={17} />
          <span>
            {tile.farm ? "농지" : "농지 예상"}{" "}
            <b>+{1 + tile.fertility + adjacent}</b>
            <small>인접 {adjacent}면</small>
          </span>
        </div>
      ) : null}
      {tile.resource ? (
        <small>
          {RESOURCES[tile.resource].name} ·{" "}
          {tile.developed
            ? `${RESOURCES[tile.resource].improvement} · +1/턴 (보급 필요)`
            : "미개발 매장지"}
        </small>
      ) : null}
      {tile.terrain === "hills" ? <small>구릉지 방어력 +20%</small> : null}
      {!tile.visible && tile.owner !== game.playerId ? (
        <small>
          {tile.explored
            ? `시야 밖 · ${tile.lastSeenTurn}턴 관측 정보`
            : "미탐사 · 고지도 무늬는 실제 지형과 무관"}
        </small>
      ) : null}
    </aside>
  );
}
