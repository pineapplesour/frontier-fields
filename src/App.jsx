import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  TYPES,
  RESOURCES,
  TERRAINS,
  key,
  equal,
  distance,
  label,
  reachable,
  findRoute,
  growthHalfTarget,
  productionType,
  cityMaxHealth,
} from "../shared/rules.js";
import {
  Settings,
  Market,
  TileCompanion,
  HelpTip,
  RulesUpgradeSetting,
  BalanceSetting,
  ExperimentPanel,
  TurnModeSetting,
} from "./Extras.jsx";
import { FactionStrip, Civilization } from "./Civilizations.jsx";
import { readCamera } from "./cameraPreferences.js";
import { WarNotice } from "./WarNotice.jsx";
import { TradeNotice } from "./TradeNotice.jsx";
import { GuaranteeNotice } from "./GuaranteeNotice.jsx";
import { playSound, unlockSound } from "./sound.js";
import { useGame } from "./useGame.js";
import { resourceFlow } from "./resourceFlow.js";
import { Board } from "./Board3D.jsx";
import { Icon, UnitIcon } from "./Icons.jsx";
import {
  Modal,
  Selection,
  UnitDetails,
  Production,
  Rules,
  Penalties,
  Bar,
  CampDetails,
} from "./Panels.jsx";
import { FeedbackContext } from "./feedback.js";
import { SaveGames } from "./SaveGames.jsx";
import { resolveMapSelection, mapSelectionChoices } from "./selectionResolver.js";
import { cityFoodSummary, detailedLogisticsState, encampmentTargetCandidates } from "./logisticsHelpers.js";
import { canMergeEqualTier } from "./formationHelpers.js";
import { attackReadiness, cityDefenseSummary } from "./cityDefenseHelpers.js";
import { estimateCityProduction } from "./productionHelpers.js";
import {
  CityFoodDetails,
  DetailedLogisticsSetting,
  LaborDetails,
  LogisticsOverview,
  ManualShipmentControls,
  ManpowerDetails,
  MerchantStatus,
} from "./Logistics.jsx";

const defaultExpansionSeats = [
  { id: "p1", controller: "human", name: "방장" },
  { id: "p2", controller: "human", name: "손님" },
  { id: "p3", controller: "human", name: "세 번째 사람" },
  { id: "p4", controller: "agent", name: "API 조종자" },
  { id: "p5", controller: "npc", name: "규칙 문명" },
];

const controllerLabels = {
  human: "사람",
  agent: "API 조종",
  npc: "규칙 문명",
};
const maxNewGameSeats = 8;

function Clock({ game, onSettings }) {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  // Deadlines are server timestamps. Convert the local tick into server time
  // using the offset measured when this observation arrived, so a phone or
  // PC whose clock runs a few seconds off never displays 62 seconds.
  const offset =
    Number.isFinite(game.serverTime) && Number.isFinite(game.receivedAt)
      ? game.serverTime - game.receivedAt
      : 0;
  const now = tick + offset;
  const limit = (game.turnSeconds ?? 60) * 1000;
  const seconds = game.paused
    ? Math.ceil(Math.min(limit, game.pausedRemaining) / 1000)
    : game.deadline
      ? Math.max(0, Math.ceil(Math.min(limit, game.deadline - now) / 1000))
      : null;
  const duration = game.paused
    ? (game.turnSeconds ?? 60) * 1000
    : game.turnStartedAt
      ? game.deadline - game.turnStartedAt
      : (game.turnSeconds ?? 60) * 1000;
  const remaining =
    seconds === null
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            (game.paused ? game.pausedRemaining : game.deadline - now) /
              duration,
          ),
        );
  return (
    <button
      onClick={onSettings}
      data-tip={`턴당 ${game.turnSeconds ?? 60}초 · 눌러서 설정. 다음 턴부터 양쪽 플레이어에게 적용돼요.`}
      className={`turn-clock ${seconds !== null && seconds <= 10 ? "urgent" : ""}`}
      aria-label={`턴 ${game.turn} · ${seconds === null ? "시작 대기" : `${seconds}초 남음`} · 시간 설정`}
    >
      <span>
        <em
          className={
            game.activePlayer === game.playerId ? "my-turn" : "their-turn"
          }
        >
          {game.spectator ? "멸망 · 관전" : game.paused
            ? "일시정지"
            : game.activePlayer === game.playerId
              ? game.turnMode === "simultaneous"
                ? "동시 턴"
                : "내 턴"
              : game.turnMode === "simultaneous"
                ? "정산 대기"
                : "상대 턴"}
        </em>{" "}
        <b>{Math.min(game.turn, game.maxTurns)}</b>
      </span>
      {seconds !== null ? (
        <strong>
          <Icon name="clock" size={15} />
          {String(Math.floor(seconds / 60)).padStart(2, "0")}:
          {String(seconds % 60).padStart(2, "0")}
        </strong>
      ) : (
        <small>{game.mode === "practice" ? "연습" : "대기실"}</small>
      )}
      {seconds !== null ? (
        <span className="clock-track" aria-hidden="true">
          <i style={{ transform: `scaleX(${remaining})` }} />
        </span>
      ) : null}
    </button>
  );
}
export default function App() {
  const api = useGame(),
    { game, session, busy, error } = api;
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("inspect");
  const [spawnTool, setSpawnTool] = useState({ type: "spearman", side: "mine", hp: 100 });
  const [layer, setLayer] = useState("terrain");
  const [zoom, setZoom] = useState(() => readCamera()?.zoom ?? 1);
  const [modal, setModal] = useState(null);
  const [mapPick, setMapPick] = useState(null);
  const [stackPick, setStackPick] = useState(null);
  const [encampmentSelection, setEncampmentSelection] = useState({});
  const [newGameSetup, setNewGameSetup] = useState(null);
  const [diplomaticTarget, setDiplomaticTarget] = useState("p2");
  const openCivilization = (id) => {
    setDiplomaticTarget(id);
    setModal("diplomacy");
  };
  const [code, setCode] = useState("");
  const [toast, setToast] = useState("");
  const [pendingShot, setPendingShot] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(
    () => localStorage.getItem("fieldline-sound") !== "off",
  );
  const [volume, setVolume] = useState(() => {
    const n = Number(localStorage.getItem("fieldline-volume") ?? 0.2);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.2;
  });
  useEffect(() => {
    localStorage.setItem("fieldline-sound", soundEnabled ? "on" : "off");
    localStorage.setItem("fieldline-volume", String(volume));
  }, [soundEnabled, volume]);
  const contact =
    selected?.kind === "contact"
      ? game?.contacts?.find((c) => c.id === selected.id)
      : null;
  const unit =
    selected?.kind === "unit"
      ? game?.units.find((u) => u.id === selected.id)
      : null;
  const city =
    selected?.kind === "city"
      ? game?.cities.find((c) => c.id === selected.id)
      : null;
  const tile = game?.tiles.find((t) =>
    equal(t, unit ?? city ?? contact ?? selected),
  );
  // Turn-scoped actions retain the original own-turn gate. Routes and trade
  // negotiations use narrower gates because the server accepts those while
  // the other player is active (but never while paused or outside planning).
  const planningDisabled =
    busy || game?.spectator || game?.paused || game?.phase !== "planning";
  const combatDisabled =
    planningDisabled || game?.ready || game?.activePlayer !== game?.playerId;
  const routeDisabled =
    planningDisabled ||
    (game?.activePlayer === game?.playerId && game?.ready);
  const tradeDisabled = planningDisabled;
  const disabled = combatDisabled;
  const pickCity = game?.cities.find((candidate) => candidate.id === mapPick?.cityId && candidate.owner === game.playerId);
  const pickCandidates = !pickCity ? [] : mapPick.kind === "growth"
    ? pickCity.expansionCandidates ?? []
    : encampmentTargetCandidates(game, pickCity);
  const finishMapPick = () => {
    if (pickCity) setSelected({ kind: "city", id: pickCity.id, q: pickCity.q, r: pickCity.r });
    setModal(mapPick?.returnModal ?? null);
    setMapPick(null);
    setMode("inspect");
  };
  const startMapPick = (kind) => {
    setStackPick(null);
    setMapPick({ kind, cityId: city.id, returnModal: modal, target: null });
    setMode("mapPick");
    setModal(null);
  };
  const clear = useCallback(() => {
    setSelected(null);
    setMode("inspect");
    setPendingShot(null);
    setMapPick(null);
    setStackPick(null);
  }, []);
  const promptedProduction = useRef(new Set());
  useEffect(() => {
    if (
      !game ||
      game.activePlayer !== game.playerId ||
      game.phase !== "planning" ||
      game.paused ||
      busy ||
      modal || mapPick
    )
      return;
    const c = game.cities.find(
      (c) =>
        c.owner === game.playerId && !c.camp &&
        c.productionPending &&
        !promptedProduction.current.has(
          `${session?.matchId}:${c.id}:${c.lastProduction?.turn}`,
        ),
    );
    if (!c) return;
    promptedProduction.current.add(
      `${session?.matchId}:${c.id}:${c.lastProduction?.turn}`,
    );
    setSelected({ kind: "city", id: c.id, q: c.q, r: c.r });
    setModal("production");
  }, [game, modal, mapPick, busy, session?.matchId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    setMode("inspect");
  }, [game?.turn, game?.activePlayer]);
  useEffect(() => {
    clear();
  }, [session?.matchId, clear]);
  const onAction = async (action, extra = {}) => {
    if (!unit) return;
    if (["attack", "bombard"].includes(action)) {
      const readiness = attackReadiness(unit);
      if (!readiness.ready) {
        api.setError(readiness.reason ?? "초석이 부족해 공격할 수 없어요.");
        return;
      }
    }
    const ok = await api.order([{ unitId: unit.id, action, ...extra }]);
    if (ok) {
      setMode("inspect");
      const updatedUnit = ok.units?.find((candidate) => candidate.id === unit.id);
      const queued = action === "move" && updatedUnit?.order?.queued;
      if (action === "found") {
        const founded = ok.cities.find(
          (c) => c.owner === game.playerId && equal(c, unit),
        );
        if (founded) setSelected({ ...founded, kind: "city" });
      }
      setToast(
        action === "cancel"
          ? "명령을 취소했어요."
          : action === "fortify"
            ? "방어 준비 · 다음 턴부터 방어 보너스 적용"
            : action === "move"
              ? queued
                ? "다음 내 턴에 이동하도록 예약했어요."
                : "이동했어요. 남은 경로는 다음 턴에 이어져요."
              : action === "found"
                ? "새 도시를 세웠어요. 개척자는 정착하며 소모돼요."
                : action === "scorch"
                  ? "시설을 청야했어요. 시설 수익이 멈추고 건축자 복구가 필요해요."
                  : action === "pillage"
                    ? "시설을 약탈했어요. 보상이 적용되고 건축자 복구가 필요해요."
                    : action === "repair"
                      ? "시설을 복구했어요."
                : "이번 턴에 실행했어요.",
      );
      if (
        soundEnabled &&
        ["farm", "develop", "fort", "found", "scorch", "pillage", "repair"].includes(action)
      )
        playSound("build", volume);
    }
    return ok;
  };
  const onRoute = async (path) => {
    if (
      !unit ||
      routeDisabled ||
      (game.activePlayer === game.playerId && unit.attackUsed && !(game.experiment && unit.movesLeft > 0))
    )
      return;
    await onAction("move", { target: path.at(-1), path });
  };
  const proposalActions = new Set([
    "offerDeal",
    "offerTrade",
    "peace",
    "alliance",
    "gift",
    "acceptProposal",
    "rejectProposal",
    "cancelProposal",
    "acceptPeace",
    "rejectPeace",
    "cancelPeace",
    "guarantee",
    "withdrawGuarantee",
    "acceptGuaranteeCall",
    "declineGuaranteeCall",
    "acceptGuarantee",
    "rejectGuarantee",
    "cancelGuarantee",
    "issueGuarantee",
    "revokeGuarantee",
    "acceptCallToArms",
    "declineCallToArms",
    "acceptDefensiveCall",
    "declineDefensiveCall",
  ]);
  const onTrade = async (data) => {
    const ok = await api.transact(data);
    if (ok) {
      // Proposal lifecycle feedback is delivered by durable trade notices;
      // avoid a second generic toast/build cue that competes with the popup.
      const lifecycleAction =
        proposalActions.has(data.action) ||
        /guarantee|calltoarms|defensivecall/i.test(data.action ?? "");
      if (!lifecycleAction) {
        setToast("거래를 반영했어요.");
        if (soundEnabled) playSound("build", volume);
      }
    }
    return ok;
  };
  const changeMode = (next) => {
    setMode(next);
    setModal(null);
  };
  const onTile = useCallback(
    async (point) => {
      if (!point) return;
      if (mapPick) {
        if (pickCandidates.some((candidate) => equal(candidate, point)))
          setMapPick((current) => ({ ...current, target: { q: point.q, r: point.r } }));
        else setToast("표시된 배치 가능 영토를 선택해 주세요.");
        return;
      }
      setStackPick(null);
      if (mode === "inspect" && (!point.source || point.source === "body") && mapSelectionChoices(game, point).length > 1) {
        setStackPick({ q: point.q, r: point.r });
        return;
      }
      if (mode === "spawn" && game.experiment && game.playerId === "p1") {
        const ok = await api.transact({
          action: "spawn",
          type: spawnTool.type,
          factionId: spawnTool.side === "enemy" ? "barb" : game.playerId,
          target: { q: point.q, r: point.r },
          hp: spawnTool.hp,
        });
        if (ok)
          setToast(
            `${TYPES[spawnTool.type].name} 소환 · ${spawnTool.side === "enemy" ? "야만인(적)" : "내 편"} · 체력 ${spawnTool.hp}`,
          );
        return;
      }
      if (point.kind === "cityContact") {
        setSelected({ kind: "tile", q: point.q, r: point.r });
        setToast(
          `${point.name} · 마지막 인구 ${point.population ?? "미확인"} · ${point.lastSeenTurn}턴에 확인한 도시예요. 현재 상태는 시야가 필요해요.`,
        );
        setMode("inspect");
        return;
      }
      const resolved = resolveMapSelection(game, point, {
        source: point.source ?? "body",
      });
      const pickedUnit =
        resolved.selection?.kind === "unit"
          ? game.units.find((candidate) => candidate.id === resolved.selection.id)
          : null;
      // A left click on the already selected unit is the non-drag equivalent
      // of right-click cancellation. Keep this before mode-specific targeting
      // so it also works while the move mode is still open.
      if (
        pickedUnit &&
        pickedUnit.id === unit?.id &&
        pickedUnit.owner === game.playerId &&
        pickedUnit.order?.action === "move" &&
        !routeDisabled
      ) {
        await onAction("cancel");
        return;
      }
      if (mode === "cityAttack" && city?.owner === game.playerId) {
        if (
          !combatDisabled &&
          (await api.order([
            {
              cityId: city.id,
              action: "cityBombard",
              target: { q: point.q, r: point.r },
            },
          ]))
        )
          setMode("inspect");
        return;
      }
      if (mode === "buyTile" && city?.owner === game.playerId) {
        if (
          !combatDisabled &&
          (await onTrade({
            action: "buyTile",
            cityId: city.id,
            target: { q: point.q, r: point.r },
          }))
        )
          setMode("inspect");
        return;
      }
      if (unit?.owner === game.playerId && mode !== "inspect") {
        if (mode === "move" ? routeDisabled : combatDisabled) return;
        const target = { q: point.q, r: point.r };
        if (mode === "move") {
          const path = findRoute(game, unit, target);
          if (!path?.length) {
            api.setError("이동할 수 있는 칸을 선택해 주세요.");
            return;
          }
          await onRoute(path);
        } else if (mode === "bombardRelocate") {
          if (
            distance(unit, target) > TYPES.artillery.range ||
            equal(unit, target)
          ) {
            api.setError("포격 사거리 안의 칸을 선택해 주세요.");
            return;
          }
          setPendingShot(target);
          setMode("retreat");
        } else if (mode === "attack")
          await onAction(unit.type === "artillery" ? "bombard" : "attack", {
            target,
          });
        else if (mode === "retreat")
          await onAction("bombard", {
            target: pendingShot,
            retreat: target,
          });
        return;
      }
      if (resolved.civilizationId) {
        openCivilization(resolved.civilizationId);
        return;
      }
      const next = resolved.selection;
      if (next?.kind === "cityContact") {
        const memory = game.cityContacts?.find((c) => c.id === next.id);
        setSelected({ kind: "tile", q: next.q, r: next.r });
        setToast(
          `${memory?.name ?? "도시"} · 마지막 인구 ${memory?.population ?? "미확인"} · ${memory?.lastSeenTurn ?? game.turn}턴에 확인한 도시예요. 현재 상태는 시야가 필요해요.`,
        );
      } else setSelected(next);
      setMode("inspect");
    },
    [
      game,
      unit,
      city,
      mode,
      combatDisabled,
      routeDisabled,
      onAction,
      onRoute,
      soundEnabled,
      volume,
      pendingShot,
      spawnTool,
      mapPick,
      pickCandidates,
    ],
  );
  async function newGame(type, options = {}) {
    if (await api.create(type, options)) {
      setModal(type === "duel" ? "lobby" : null);
      setNewGameSetup(null);
      clear();
    }
  }
  if (!game)
    return (
      <main className="loading-screen">
        <div className="wordmark">
          들녘<span>FIELDLINE</span>
        </div>
        <p>{error || "지도를 펼치고 있어요."}</p>
        {error ? (
          <button className="primary" onClick={() => location.reload()}>
            다시 연결
          </button>
        ) : null}
      </main>
    );
  const friendly = game.units.filter((u) => u.owner === game.playerId);
  const totalOrders = friendly.filter((u) => u.order).length;
  const layers = ["terrain", "food", "resources", "coordinates"];
  const layerNames = {
    terrain: "지도",
    food: "식량",
    resources: "자원",
    coordinates: "좌표",
  };
  const expansion = game.rulesVersion === "expansion-v1";
  const selectedCityFood = city ? cityFoodSummary(city, game) : null;
  const selectedCityDefense = city ? cityDefenseSummary(city) : null;
  const selectedProduction =
    city?.queue
      ? estimateCityProduction(
          city,
          city.queue,
          productionType(city.queue, city),
        )
      : null;
  const playerSeats = (game.seats ?? []).filter((seat) =>
    seat.id?.startsWith("p"),
  );
  const missingSeats = playerSeats.filter(
    (seat) => seat.controller !== "npc" && !seat.connected,
  );
  const openExpansionSetup = () => {
    setNewGameSetup({
      rulesVersion: "expansion-v1",
      turnMode: "sequential",
      seats: defaultExpansionSeats.map((seat) => ({ ...seat })),
    });
    setModal("new-game");
  };
  const updateSetupSeat = (seatId, patch) => {
    setNewGameSetup((current) =>
      current
        ? {
            ...current,
            seats: current.seats.map((seat) =>
              seat.id === seatId ? { ...seat, ...patch } : seat,
            ),
          }
        : current,
    );
  };
  const addSetupSeat = () => {
    setNewGameSetup((current) => {
      if (!current || current.seats.length >= maxNewGameSeats) return current;
      const index = current.seats.length + 1;
      return {
        ...current,
        seats: [
          ...current.seats,
          {
            id: `p${index}`,
            controller: "npc",
            name: `규칙 문명 ${index - 2}`,
          },
        ],
      };
    });
  };
  const removeSetupSeat = (seatId) => {
    setNewGameSetup((current) => {
      if (!current || current.seats.length <= 2 || seatId === "p1") return current;
      const seats = current.seats
        .filter((seat) => seat.id !== seatId)
        .map((seat, index) => ({ ...seat, id: `p${index + 1}` }));
      return { ...current, seats };
    });
  };
  return (
    <FeedbackContext.Provider value={error}>
      <main
        className={`game-shell ${selected ? "has-selection" : ""}`}
        onPointerDown={unlockSound}
      >
        <HelpTip />
        <WarNotice game={game} soundEnabled={soundEnabled} volume={volume} />
        <TradeNotice
          game={game}
          matchId={session?.matchId}
          disabled={tradeDisabled}
          onTrade={onTrade}
          soundEnabled={soundEnabled}
          volume={volume}
        />
        <GuaranteeNotice
          game={game}
          matchId={session?.matchId}
          disabled={tradeDisabled}
          onTrade={onTrade}
        />
        <Board
          game={game}
          matchId={session?.matchId}
          selected={unit ?? city ?? selected}
          unit={mapPick ? null : unit}
          mode={mode}
          onTile={onTile}
          layer={layer}
          zoom={zoom}
          onZoom={setZoom}
          onClear={mapPick ? finishMapPick : clear}
          mapPick={mapPick}
          pickCandidates={pickCandidates}
          onRoute={onRoute}
          onCancelRoute={() => onAction("cancel")}
          disabled={disabled}
          routeDisabled={routeDisabled}
          soundEnabled={soundEnabled}
          volume={volume}
        />
        {mapPick ? (
          <section className="map-target-toolbar" aria-label="지도에서 영토 선택">
            <strong>{mapPick.kind === "growth" ? "다음 성장 영토" : "주둔지 배치 영토"}</strong>
            <span aria-live="polite">{mapPick.target ? `선택: ${mapPick.target.q},${mapPick.target.r}` : `강조된 ${pickCandidates.length}개 영토 중 하나를 누르세요.`}</span>
            <button disabled={!mapPick.target || disabled || !pickCandidates.some((candidate) => equal(candidate, mapPick.target))} onClick={async () => {
              if (mapPick.kind === "growth") {
                if (!await api.citySettings(mapPick.cityId, mapPick.target)) return;
                setToast("다음 성장 영토를 지정했어요.");
              } else setEncampmentSelection((current) => ({ ...current, [mapPick.cityId]: `${mapPick.target.q},${mapPick.target.r}` }));
              finishMapPick();
            }}>선택 확정</button>
            <button disabled={!mapPick.target} onClick={() => setMapPick((current) => ({ ...current, target: null }))}>선택 지우기</button>
            <button onClick={finishMapPick}>취소 · 돌아가기</button>
          </section>
        ) : null}
        {stackPick && !mapPick ? (
          <section className="map-target-toolbar stack-picker" aria-label="같은 타일의 대상 선택">
            <strong>{stackPick.q},{stackPick.r} · 선택할 대상</strong>
            {mapSelectionChoices(game, stackPick).map((choice) => {
              const entity = (choice.kind === "unit" ? game.units : game.cities).find((item) => item.id === choice.id);
              return <button key={`${choice.kind}:${choice.id}`} onClick={() => { setSelected(choice); setStackPick(null); }}>
                {choice.kind === "unit" ? <UnitIcon type={entity.type} /> : <Icon name="city" />}
                {choice.kind === "unit" ? TYPES[entity.type].name : entity.name}
                {entity.owner === game.playerId ? " · 내 편" : ""}
                {choice.kind === "unit" ? ` · 체력 ${entity.hp}` : " · 도시"}
              </button>;
            })}
            <button onClick={() => { setSelected({ kind: "tile", ...stackPick }); setStackPick(null); }}>영토 보기</button>
            <button onClick={() => setStackPick(null)}>취소</button>
          </section>
        ) : null}
        <header className="topbar">
          <button
            className="wordmark"
            onClick={() => setModal("menu")}
            aria-label="들녘 메뉴"
          >
            들녘<span>FIELDLINE</span>
          </button>
          <div className="economy-summary" aria-label="도시 경제">
            <button
              data-tip={
                game.economy.armyCapacityEnabled === false
                  ? "전체 도시 인구. 인구당 시민 식량을 소비하고 골드 2를 제공해요. 상세 보급 ON에서는 병력 수용량 대신 인구 동원 대기열을 사용해요."
                  : "전체 도시 인구. 인구당 식량 1을 소비하고, 골드 2와 병력 수용량 2를 제공해요."
              }
              onClick={() => setModal("resources")}
            >
              <Icon name="people" size={17} />
              <b>{game.economy.population}</b>
            </button>
            <button
              data-tip="턴당 식량 순증가 = 농지·도시 식량 생산 − 인구 소비. 도시를 누르면 다음 성장까지 남은 턴을 볼 수 있어요."
              onClick={() => setModal("resources")}
            >
              <Icon name="wheat" size={18} />
              <b>
                {game.economy.foodNet >= 0 ? "+" : ""}
                {game.economy.foodNet}
              </b>
            </button>
            <button
              data-tip="전체 도시의 턴당 생산력. 각 도시에서 선택한 유닛 생산에 사용돼요."
              onClick={() => setModal("resources")}
            >
              <Icon name="hammer" size={17} />
              <b>+{game.economy.production}</b>
            </button>
            <button
              className="gold-stat"
              data-tip={`골드 ${game.economy.gold ?? 0} · 턴당 +${game.economy.goldIncome ?? 0}. 영토 구매, 시장 거래, 평화 협상에 사용해요. 눌러서 시장.`}
              onClick={() => setModal("market")}
            >
              <small>G</small>
              <b>{game.economy.gold ?? 0}</b>
            </button>
            <div className="resource-stocks" aria-label="국가 자원 비축량">
              {Object.entries(RESOURCES).map(([r, d]) => (
                <button
                  key={r}
                  data-tip={`${d.name} ${game.economy.resources[r]}/${game.economy.resourceCapacity ?? game.economy.population * 5} · 생산 +${resourceFlow(game.economy, r).gross} − 유지비 ${resourceFlow(game.economy, r).upkeep} = ${resourceFlow(game.economy, r).signed}/턴 · 총인구 × 5 비축 한도. 초석은 화약 부대의 턴 유지비로 소모되고 공격 시 추가 소모는 없어요. 부족해도 기존 부대는 공격하며, 신규 생산에는 자원이 필요해요. 시작 비축이 한도를 넘으면 기존 수량은 보존해요.`}
                  onClick={() => setModal("resources")}
                >
                  <Icon name={d.icon} size={16} />
                  <span>{d.name}</span>
                  <b>
                    {game.economy.resources[r]}
                    <small>
                      /
                      {game.economy.resourceCapacity ??
                        game.economy.population * 5}
                    </small>
                  </b>
                  <em className={resourceFlow(game.economy, r).net < 0 ? "resource-deficit" : undefined}>{resourceFlow(game.economy, r).signed}/턴</em>
                </button>
              ))}
            </div>
          </div>
          <div className="header-right">
            <Clock game={game} onSettings={() => setModal("settings")} />
            {game.playerId === "p1" ? (
              <button
                className={`icon-button pause-button ${game.paused ? "active" : ""}`}
                aria-label={game.paused ? "경기 재개" : "경기 일시정지"}
                data-tip="사용자만 경기 전체를 일시정지·재개할 수 있어요. 양쪽 명령과 초시계가 함께 멈춰요."
                disabled={busy || game.phase !== "planning"}
                onClick={() => api.pause(!game.paused)}
              >
                <Icon name={game.paused ? "play" : "pause"} size={18} />
              </button>
            ) : null}
            <button
              className="ready-button header-end-turn"
              disabled={
                busy ||
                game.spectator ||
                game.paused ||
                game.ready ||
                (game.phase === "planning" &&
                  game.activePlayer !== game.playerId)
              }
              onClick={() =>
                game.phase === "lobby"
                  ? setModal("lobby")
                  : game.phase === "finished"
                    ? setModal("result")
                    : api.ready()
              }
              data-tip="이번 턴 도시 성장·생산을 정산하고 상대에게 차례를 넘겨요."
            >
              {game.spectator ? "관전 중" : game.phase === "lobby"
                ? "대기실"
                : game.phase === "finished"
                  ? "경기 결과"
                  : game.activePlayer !== game.playerId
                    ? game.turnMode === "simultaneous"
                      ? "대기 중"
                      : "상대 턴"
                    : game.turnMode === "simultaneous"
                      ? "행동 완료"
                      : "턴 마치기"}
              <Icon name="arrow" size={16} />
            </button>
            <button
              className="icon-button menu-button"
              aria-label="게임 메뉴"
              onClick={() => setModal("menu")}
            >
              <Icon name="menu" />
            </button>
          </div>
          <div className="header-diplomacy">
            <FactionStrip game={game} onOpen={openCivilization} />
            <div className="quick-nav">
              <button onClick={() => setModal("diplomacy")}>외교</button>
              <button onClick={() => setModal("market")}>시장</button>
            </div>
          </div>
        </header>
        <div className="map-title">
          <span
            className={`faction-dot ${game.playerId === "p2" ? "red" : ""}`}
          />
          {game.playerId === "p1" ? "서부 평원" : "동부 평원"}
          <small>
            {game.mode === "practice"
              ? game.experiment
                ? "실험 모드 연습 · 즉시 소환"
                : "연습 · 방어 상대 / 독립 세력"
              : game.turnMode === "simultaneous"
                ? `동시 턴 대전 · ${(game.activeSeats ?? []).length}명 행동 중`
                : "교대 턴 대전"}
          </small>
        </div>
        <button
          className={`layer-toggle ${layer !== "terrain" ? "on" : ""}`}
          onClick={() =>
            setLayer(layers[(layers.indexOf(layer) + 1) % layers.length])
          }
          title="지도 → 식량 → 자원 → 좌표"
        >
          <Icon name="layers" size={16} />
          {layerNames[layer]}
        </button>
        {game.experiment && game.playerId === "p1" ? (
          <ExperimentPanel
            game={game}
            onEdit={(data) => api.transact(data)}
            tool={spawnTool}
            setTool={setSpawnTool}
            active={mode === "spawn"}
            busy={busy}
            unit={selected?.kind === "unit" ? game.units.find((u) => u.id === selected.id) ?? null : null}
            onToggle={() => setMode(mode === "spawn" ? "inspect" : "spawn")}
            onRemove={async () => {
              const target = selected?.kind === "unit" ? game.units.find((u) => u.id === selected.id) : null;
              if (!target) return;
              if (await api.transact({ action: "removeUnit", unitId: target.id })) {
                setSelected(null);
                setToast("유닛을 제거했어요.");
              }
            }}
          />
        ) : null}
        {mode !== "inspect" && !mapPick ? (
          <div className="mode-hint">
            <span>
              {mode === "spawn"
                ? "소환할 칸을 클릭하세요 · 실험 모드"
                : mode === "buyTile"
                ? "구매할 땅을 선택하세요 · 도시 영토에 인접한 미소유 땅"
                : mode === "move"
                  ? "이동할 칸을 선택하세요"
                  : mode === "retreat"
                    ? "포격 후 이동할 인접 칸을 선택하세요"
                    : "공격할 칸을 선택하세요"}
            </span>
            <button
              onClick={() => setMode("inspect")}
              aria-label="대상 선택 취소"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="error-toast" role="alert">
            {error}
            <button aria-label="오류 닫기" onClick={() => api.setError("")}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ) : toast ? (
          <div className="toast" role="status">
            <Icon name="check" size={16} />
            {toast}
          </div>
        ) : null}
        <div className="bottom-left">
          <button className="floating-button" onClick={() => setModal("units")}>
            <Icon name="flag" size={17} />
            병력 <b>{friendly.length}</b>
          </button>
          {game.events.length ? (
            <button
              className="floating-button event-button"
              onClick={() => setModal("events")}
            >
              이번 턴 소식 <b>{game.events.length}</b>
            </button>
          ) : null}
        </div>
        {selected && tile && !mapPick && !stackPick ? (
          <div className="selection-dock">
            {unit || city || contact ? (
              <TileCompanion game={game} tile={tile} />
            ) : null}
            {contact ? (
              <section className="selection contact-selection">
                <button
                  className="selection-close icon-button"
                  onClick={clear}
                  aria-label="선택 해제"
                >
                  <Icon name="close" size={16} />
                </button>
                <h2>{TYPES[contact.type].name} · 마지막 관측</h2>
                <p>
                  {label(contact)} · {contact.lastSeenTurn}턴에 확인
                </p>
                <small>
                  현재 위치나 생존 여부는 알 수 없어요. 해당 칸을 다시 관측하면
                  갱신돼요.
                </small>
              </section>
            ) : (
              <Selection
                game={game}
                unit={unit}
                city={city}
                tile={tile}
                mode={mode}
                disabled={disabled}
                routeDisabled={routeDisabled}
                tradeDisabled={tradeDisabled}
                onMode={changeMode}
                onAction={onAction}
                onClose={clear}
                onDetails={() => setModal("details")}
                onProduction={() => setModal("production")}
                onMerge={() => setModal("merge")}
                onBuyTile={() => setMode("buyTile")}
                onDiplomacy={openCivilization}
                onTrade={onTrade}
                onCitizenSettings={api.citizenSettings}
              />
            )}
          </div>
        ) : null}
        {modal === "saves" ? (
          <SaveGames
            game={game}
            busy={busy}
            onSave={api.saveGame}
            onLoad={async (id) => {
              const loaded = await api.loadGame(id);
              if (loaded) {
                clear();
                setModal(loaded.phase === "lobby" ? "lobby" : null);
              }
            }}
            onClose={() => setModal(null)}
          />
        ) : null}
        {modal === "settings" ? (
          <Settings
            game={game}
            busy={busy}
            onSave={api.settings}
            onOpenSaves={() => setModal("saves")}
            onClose={() => setModal(null)}
            soundEnabled={soundEnabled}
            setSoundEnabled={setSoundEnabled}
            volume={volume}
            setVolume={setVolume}
            >
            <RulesUpgradeSetting
              game={game}
              busy={busy}
              onUpgrade={async (settings) => {
                const updated = await api.settings(settings);
                if (updated) setToast("최신 규칙을 적용했어요. 현재 경기 진행은 유지돼요.");
                return updated;
              }}
            />
            <DetailedLogisticsSetting
              game={game}
              busy={busy}
              onChange={(enabled) => api.settings({ supplyMode: enabled ? "on" : "off" })}
            />
            <TurnModeSetting
              game={game}
              busy={busy}
              onChange={(turnMode) => api.settings({ turnMode })}
            />
            <BalanceSetting
              game={game}
              busy={busy}
              onChange={(balance) => api.settings({ balance })}
            />
          </Settings>
        ) : null}
        {modal === "new-game" && newGameSetup ? (
          <Modal
            title="확장 대전 설정"
            wide
            onClose={() => {
              setNewGameSetup(null);
              setModal("menu");
            }}
          >
            <p className="description">
              시작 전에 좌석 수와 조종 방식을 정하세요. 방장은 사람으로 고정되고,
              나머지는 사람·API·규칙 문명 중에서 고를 수 있어요.
            </p>
            <label className="new-game-turn-mode">
              턴 방식
              <select
                value={newGameSetup.turnMode ?? "sequential"}
                disabled={busy}
                onChange={(event) =>
                  setNewGameSetup((current) =>
                    current ? { ...current, turnMode: event.target.value } : current,
                  )
                }
              >
                <option value="sequential">교대 턴 · 좌석 순서대로 한 명씩</option>
                <option value="simultaneous">동시 턴 · 모두 같은 시간에 행동, 함께 정산</option>
              </select>
              <small>
                동시 턴에서는 명령이 즉시 적용되고, 같은 칸은 먼저 움직인 쪽이 차지해요.
                전원이 준비 완료하거나 시간이 끝나면 한 번에 정산돼요.
              </small>
            </label>
            <div className="new-game-seat-header">
              <div>
                <strong>
                  참가 좌석 {newGameSetup.seats.length} / {maxNewGameSeats}
                </strong>
                <small>최소 2명 · 최대 {maxNewGameSeats}명</small>
              </div>
              <button
                type="button"
                className="soft-button"
                disabled={busy || newGameSetup.seats.length >= maxNewGameSeats}
                onClick={addSetupSeat}
              >
                <Icon name="plus" size={15} /> 좌석 추가
              </button>
            </div>
            <div className="new-game-seat-list">
              {newGameSetup.seats.map((seat, index) => {
                const seatNameId = `new-seat-name-${seat.id}`;
                const seatControllerId = `new-seat-controller-${seat.id}`;
                return (
                  <div className="new-game-seat" key={seat.id}>
                    <span className="new-game-seat-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <label htmlFor={seatNameId}>
                      좌석 이름
                      <input
                        id={seatNameId}
                        value={seat.name ?? ""}
                        disabled={busy}
                        onChange={(event) =>
                          updateSetupSeat(seat.id, { name: event.target.value })
                        }
                      />
                    </label>
                    <label htmlFor={seatControllerId}>
                      조종 방식
                      <select
                        id={seatControllerId}
                        value={seat.controller}
                        disabled={busy || index === 0}
                        onChange={(event) =>
                          updateSetupSeat(seat.id, {
                            controller: event.target.value,
                          })
                        }
                      >
                        {Object.entries(controllerLabels).map(([value, name]) => (
                          <option key={value} value={value}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="text-button new-game-seat-remove"
                      disabled={
                        busy || index === 0 || newGameSetup.seats.length <= 2
                      }
                      onClick={() => removeSetupSeat(seat.id)}
                      aria-label={`${seat.name || `좌석 ${index + 1}`} 삭제`}
                    >
                      삭제
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="fine-print new-game-seat-note">
              좌석을 줄여도 방장은 유지돼요. API·규칙 문명 좌석은 연결을 기다리지 않고
              시작할 수 있고, 사람 좌석은 대기실에서 초대 코드를 만들어요.
            </p>
            <div className="new-game-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setNewGameSetup(null);
                  setModal("menu");
                }}
              >
                취소
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || newGameSetup.seats.length < 2}
                onClick={() =>
                  newGame("duel", {
                    rulesVersion: newGameSetup.rulesVersion,
                    turnMode: newGameSetup.turnMode ?? "sequential",
                    seats: newGameSetup.seats.map((seat) => ({
                      id: seat.id,
                      controller: seat.controller,
                      name: seat.name?.trim() || seat.id,
                    })),
                  })
                }
              >
                대전 만들기 <Icon name="arrow" size={16} />
              </button>
            </div>
          </Modal>
        ) : null}
        {modal === "market" ? (
          <Market
            game={game}
            disabled={tradeDisabled}
            onTrade={onTrade}
            onClose={() => setModal(null)}
          />
        ) : null}
        {modal === "diplomacy" ? (
          <Civilization
            game={game}
            factionId={diplomaticTarget}
            onSelect={setDiplomaticTarget}
            disabled={combatDisabled}
            tradeDisabled={tradeDisabled}
            onTrade={onTrade}
            onPreview={api.previewDeal}
            onClose={() => setModal(null)}
          />
        ) : null}
        {modal === "menu" ? (
          <Modal title="들녘" onClose={() => setModal(null)}>
            <p className="description">
              농지를 가꾸고, 전선을 읽는 작은 전략 게임.
            </p>
            <div className="menu-list">
              <button onClick={() => setModal("settings")}>
                <Icon name="clock" />
                설정<span>턴 시간 · 소리</span>
              </button>
              <button onClick={() => setModal("saves")}>
                <Icon name="layers" />
                저장 · 불러오기<span>서버에 보관</span>
              </button>
              <button onClick={() => setModal("market")}>
                <Icon name="iron" />
                시장<span>식량 · 자원 · 유닛 거래</span>
              </button>
              <button onClick={() => setModal("diplomacy")}>
                <Icon name="flag" />
                외교<span>세력 · 평화 협상</span>
              </button>
              <button onClick={() => newGame("practice")} disabled={busy}>
                <Icon name="flag" />새 연습<span>기본 연습 · 구 규칙</span>
              </button>
              <button
                onClick={() => newGame("practice", { experiment: true })}
                disabled={busy}
              >
                <Icon name="flag" />실험 모드 연습
                <span>유닛 즉시 소환 · 공격력 수치 실험</span>
              </button>
              <button onClick={() => newGame("duel")} disabled={busy}>
                <Icon name="people" />
                대전 만들기<span>기본 2인 · 구 규칙</span>
              </button>
              <button
                onClick={openExpansionSetup}
                disabled={busy}
              >
                <Icon name="people" />
                확장 대전 만들기<span>좌석·조종 방식 선택</span>
              </button>
              {game.playerId === "p1" ? (
                <button
                  onClick={async () => {
                    const result = await api.checkpoint();
                    if (result) setToast("현재 경기의 재시작 지점을 기록했어요.");
                  }}
                  disabled={busy}
                >
                  <Icon name="layers" />
                  안전한 개발 업데이트 지점<span>현재 상태·시간 보존</span>
                </button>
              ) : null}
              <button onClick={() => setModal("join")}>
                <Icon name="link" />
                초대 코드로 참가
              </button>
              <button onClick={() => setModal("rules")}>
                <Icon name="info" />
                게임 규칙
              </button>
              {game.mode === "duel" && game.phase === "lobby" ? (
                <button onClick={() => setModal("lobby")}>
                  <Icon name="clock" />
                  대기실로 돌아가기
                </button>
              ) : null}
            </div>
          </Modal>
        ) : null}
        {modal === "resources" ? (
          <Modal title="자원과 내정" onClose={() => setModal(null)}>
            <p className="description">
              건축자로 매장지를 개발하면 보급이 연결된 시설에서 자원을 얻어요.
            </p>
            <div className="resource-list">
              {Object.entries(RESOURCES).map(([r, def]) => (
                <div key={r}>
                  <Icon name={def.icon} size={26} />
                  <span>
                    {def.name}
                    <small>{def.improvement}</small>
                  </span>
                  <strong>{game.economy.resources[r]}</strong>
                  <small className={resourceFlow(game.economy, r).net < 0 ? "resource-deficit" : undefined}>
                    {resourceFlow(game.economy, r).signed} / 턴<br />
                    생산 {resourceFlow(game.economy, r).gross} · 유지비 {resourceFlow(game.economy, r).upkeep}
                  </small>
                </div>
              ))}
            </div>
            <div className="detail-grid">
              <div>
                전체 인구<strong>{game.economy.population}명</strong>
              </div>
              {game.economy.armyCapacityEnabled !== false ? (
                <div>
                  병력 수용량
                  <strong>
                    {game.economy.used} / {game.economy.capacity}
                  </strong>
                </div>
              ) : null}
              {expansion ? (
                <div>
                  생산 인구 배정
                  <strong>
                    {game.economy.manpowerCost}명 / 도시 최소 {game.economy.minimumCityPopulation}명
                  </strong>
                </div>
              ) : null}
              <div>
                식량 순증가
                <strong>
                  {game.economy.foodNet >= 0 ? "+" : ""}
                  {game.economy.foodNet} / 턴
                </strong>
              </div>
              <div>
                전체 생산<strong>+{game.economy.production} / 턴</strong>
              </div>
            </div>
            <LogisticsOverview game={game} />
            <button
              className="soft-button full"
              onClick={() => {
                setLayer("resources");
                setModal(null);
              }}
            >
              지도에서 매장지 보기
              <Icon name="arrow" size={17} />
            </button>
          </Modal>
        ) : null}
        {modal === "units" ? (
          <Modal title="아군 병력" onClose={() => setModal(null)}>
            <div className="unit-list">
              {friendly.map((u) => (
                <button
                  key={u.id}
                  onClick={() => {
                    setSelected({ kind: "unit", id: u.id, q: u.q, r: u.r });
                    setModal(null);
                    setMode("inspect");
                  }}
                >
                  <div className="mini-unit">
                    <UnitIcon type={u.type} />
                  </div>
                  <span>
                    <strong>
                      {TYPES[u.type].name}
                      {u.size > 1 ? ` ×${u.size}` : ""}
                    </strong>
                    <small>
                      {label(u)} · 레벨 {u.level}
                      {u.order ? " · 명령 예약됨" : ""}
                    </small>
                  </span>
                  <b>
                    {u.hp}
                    <small> / {maxHealthLocal(u)}</small>
                  </b>
                  <Icon name="arrow" size={16} />
                </button>
              ))}
            </div>
            <div className="city-list">
              {game.cities
                .filter((c) => c.owner === game.playerId)
                .map((c) => (
                  <button
                    className="soft-button"
                    key={c.id}
                    onClick={() => {
                      setSelected({ kind: "city", id: c.id, q: c.q, r: c.r });
                      setModal(null);
                    }}
                  >
                    <Icon name="city" />
                    {c.name}
                    <small>인구 {c.population}</small>
                  </button>
                ))}
            </div>
          </Modal>
        ) : null}
        {modal === "details" ? (
          <Modal
            title={
              unit
                ? `${TYPES[unit.type].name} 상세`
                : city
                  ? `${city.name} 상세`
                  : "지형 정보"
            }
            onClose={() => setModal(null)}
          >
            {unit ? (
              <UnitDetails
                unit={unit}
                game={game}
                disabled={disabled}
                onAction={async (...args) => {
                  await onAction(...args);
                  setModal(null);
                }}
                onMode={changeMode}
                onMerge={() => setModal("merge")}
                onTrade={onTrade}
                tradeDisabled={tradeDisabled}
              />
            ) : city?.camp ? (
              <CampDetails game={game} city={city} disabled={disabled} onTrade={onTrade} />
            ) : city ? (
              <>
            <CityFoodDetails city={city} game={game} />
            <ManpowerDetails
              city={city}
              game={game}
              disabled={combatDisabled}
              onTrade={onTrade}
            />
            <LaborDetails
              city={city}
              game={game}
              disabled={combatDisabled}
              onCitizenSettings={api.citizenSettings}
            />
            <MerchantStatus
              city={city}
              game={game}
              disabled={tradeDisabled}
              onTrade={onTrade}
            />
            <ManualShipmentControls
              city={city}
              game={game}
              disabled={tradeDisabled}
              onTrade={onTrade}
            />
                <div className="detail-grid">
                  <div>
                    인구<strong>{city.population}</strong>
                  </div>
                  <div>
                    도시 본체 HP
                    <strong>
                      {selectedCityDefense?.body ?? city.hp} / {selectedCityDefense?.bodyMax ?? cityMaxHealth(city)}
                    </strong>
                  </div>
                  <div>
                    성벽 HP
                    <strong>
                      {selectedCityDefense?.wall ?? 0} / {selectedCityDefense?.wallMax ?? 0}
                      {city.wallLevel ? ` · ${city.wallLevel}레벨` : ""}
                    </strong>
                  </div>
                  <div>
                    성장 진척
                    <strong>
                      {selectedCityFood?.progress ?? 0} / {city.growthTarget}
                      {detailedLogisticsState(game).enabled
                        ? " · 보급 턴 진척"
                        : " · 식량 잉여 누적"}
                    </strong>
                  </div>
                  <div>
                    {detailedLogisticsState(game).enabled
                      ? "식량 생산 / 시민 소비"
                      : "식량 잉여 (생산−시민 소비)"}
                    <strong>
                      {selectedCityFood?.production ?? city.foodGross ?? "—"} / {selectedCityFood?.consumption ?? city.population ?? "—"}
                      {selectedCityFood?.net != null
                        ? ` · ${selectedCityFood.net >= 0 ? "+" : ""}${selectedCityFood.net} / 턴`
                        : ""}
                    </strong>
                  </div>
                  {detailedLogisticsState(game).enabled && selectedCityFood?.stockAvailable ? (
                    <div>
                      도시 저장 식량
                      <strong>
                        {selectedCityFood.stored}
                        {selectedCityFood.capacity != null
                          ? ` / ${selectedCityFood.capacity}`
                          : ""}
                      </strong>
                    </div>
                  ) : null}
                  <div>
                    턴당 생산<strong>{city.productionRate}</strong>
                  </div>
                  <div>
                    생산 완료
                    <strong>
                      {!selectedProduction
                        ? "대기 없음"
                        : selectedProduction.complete
                          ? "완성 · 배치/수용량 대기"
                          : selectedProduction.turns == null
                            ? `생산력 ${selectedProduction.productionRate}/턴 · 진행 ${selectedProduction.progress}/${selectedProduction.cost}`
                            : `${selectedProduction.turns}턴 · 진행 ${selectedProduction.progress}/${selectedProduction.cost} 생산력`}
                    </strong>
                  </div>
                  <div>
                    기아 예상
                    <strong>
                      {detailedLogisticsState(game).enabled
                        ? selectedCityFood?.starvationTurns == null
                          ? "안정"
                          : selectedCityFood.starvationTurns === 0
                            ? "저장 식량 없음"
                            : `${selectedCityFood.starvationTurns}턴`
                        : selectedCityFood?.shortage
                          ? "잉여 부족"
                          : "생산−소비 양호"}
                    </strong>
                  </div>
                </div>
                <Bar
                  value={selectedCityFood?.progress ?? 0}
                  max={city.growthTarget}
                />
                {city.owner === game.playerId ? (
                  <div className="trade-controls">
                    <label htmlFor="growth-target">
                      다음 성장 영토
                      <select
                        id="growth-target"
                        value={
                          city.expansionTarget
                            ? `${city.expansionTarget.q},${city.expansionTarget.r}`
                            : ""
                        }
                        disabled={disabled}
                        onChange={async (e) => {
                          const [q, r] = e.target.value
                            ? e.target.value.split(",").map(Number)
                            : [null, null];
                          if (await api.citySettings(city.id, q === null ? null : { q, r }))
                            setToast(
                              q === null
                                ? "성장 영토를 자동 선택으로 바꿨어요."
                                : "다음 성장 영토를 지정했어요.",
                            );
                        }}
                      >
                        <option value="">자동 선택 · 비옥도 우선</option>
                        {(city.expansionCandidates ?? []).map((target) => (
                          <option
                            key={`${target.q},${target.r}`}
                            value={`${target.q},${target.r}`}
                          >
                            {label(target)} · {target.q},{target.r}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="soft-button full" disabled={disabled || !city.expansionCandidates?.length} onClick={() => startMapPick("growth")}>지도에서 선택하기</button>
                    <small>
                      인구 성장 식량 {growthHalfTarget(city.population)}에서 1칸,
                      정수 인구 증가에서 1칸 · 반경 최대 3칸
                    </small>
                  </div>
                ) : null}
                <Penalties entity={city} />
                {city.owner === game.playerId ? <button className="danger-button full" disabled={disabled || !!city.razeIssue} title={city.razeIssue ?? "도시와 영토를 포기합니다. 마지막 도시라면 패배할 수 있어요."} onClick={() => setModal("razeCity")}>도시 자진 철거</button> : null}
              </>
            ) : tile ? (
              <p>
                {label(tile)} · {TERRAINS[tile.terrain].name} · 비옥도{" "}
                {tile.fertility}
              </p>
            ) : null}
          </Modal>
        ) : null}
        {modal === "razeCity" && city ? (
          <Modal title={`${city.name} · 자진 철거 확인`} onClose={() => setModal("details")}>
            <p>{city.name} 도시를 자진 철거합니다. 이 도시와 도시 기능을 잃으며 되돌릴 수 없어요. 다른 내 도시가 이어받을 수 없는 영토는 해제됩니다. 수도도 철거할 수 있으며, 마지막 도시를 철거하면 패배할 수 있어요.</p>
            <p>상대의 정착 최후통첩을 수락하려는 경우에는 외교 창에서 해당 최후통첩을 수락하세요. 그 수락에는 10턴 재정착 금지 조건도 함께 적용됩니다.</p>
            <div className="time-presets">
              <button className="danger-button" disabled={disabled || city.owner !== game.playerId || !!city.razeIssue} onClick={async () => {
                if (await onTrade({ action: "razeCity", cityId: city.id })) { setModal(null); clear(); setToast("도시를 자진 철거했어요."); }
              }}>도시 철거 확정</button>
              <button onClick={() => setModal("details")}>취소 · 도시로 돌아가기</button>
            </div>
          </Modal>
        ) : null}
        {modal === "production" && city && !city.camp ? (
          <Modal title={`${city.name} · 생산`} onClose={() => setModal(null)}>
            <Production
              game={game}
              city={city}
              encampmentTarget={encampmentSelection[city.id] ?? ""}
              onEncampmentTarget={(value) => setEncampmentSelection((current) => ({ ...current, [city.id]: value }))}
              onPickEncampment={() => startMapPick("encampment")}
              disabled={disabled}
              onTrade={onTrade}
              onChoose={async (type, target = null) => {
                if (await api.produce(city.id, type, target)) {
                  setModal(null);
                  setToast(
                    type
                      ? `${productionType(type, city)?.name ?? game.productionTypes?.[type]?.name ?? type} 생산을 예약했어요.`
                      : "생산 안 함 · 식량 생산 +25%로 전환했어요.",
                  );
                }
              }}
              onBuy={async (type) => {
                const ok = await api.transact({
                  action: "buyUnit",
                  cityId: city.id,
                  type,
                });
                if (ok) {
                  setModal(null);
                  setToast(
                    `${productionType(type, city).name}을 즉시 구매했어요 · 인구 0.5 배정`,
                  );
                }
                return ok;
              }}
            />
          </Modal>
        ) : null}
        {modal === "merge" && unit ? (
          <Modal title="부대 합병" onClose={() => setModal(null)}>
            <p className="description">
              같은 크기의 같은 병종만 합쳐요 · 1+1=2, 2+2=4. 기존 3개 편성은 유지돼요.
            </p>
            {friendly
              .filter(
                (u) =>
                  u.id !== unit.id &&
                  u.type === unit.type &&
                  distance(u, unit) <= 1 &&
                  canMergeEqualTier(unit, u),
              )
              .map((u) => (
                <button
                  className="soft-button full"
                  key={u.id}
                  disabled={disabled}
                  onClick={async () => {
                    await onAction("merge", { targetId: u.id });
                    setModal(null);
                  }}
                >
                  <UnitIcon type={u.type} />
                  {label(u)} {TYPES[u.type].name} ×{u.size}
                  <Icon name="merge" />
                </button>
              ))}
            {!friendly.some(
              (u) =>
                u.id !== unit.id &&
                u.type === unit.type &&
                distance(u, unit) <= 1 &&
                canMergeEqualTier(unit, u),
            ) ? (
              <p className="empty-state">
                지금 인접한 합병 대상이 없어요.
                <br />
                같은 크기의 같은 병종을 옆 칸으로 이동시켜 주세요.
              </p>
            ) : null}
          </Modal>
        ) : null}
        {modal === "lobby" ? (
          <Modal title="대전 대기실" onClose={() => setModal(null)}>
            <p className="description">
              {expansion
                ? "사람·API 좌석이 참가한 뒤 방장이 시작해요. 규칙 문명은 자동으로 준비되며, 시작 전에는 시간이 흐르지 않아요."
                : "상대도 참가한 뒤 방장이 시작해요. 시작 전에는 시간이 흐르지 않아요."}
            </p>
            {expansion ? (
              <>
                <div className="lobby-seat-list">
                  {playerSeats.map((seat) => {
                    const invite = session.inviteCodes?.[seat.id];
                    const controller =
                      seat.controller === "npc"
                        ? "규칙 문명"
                        : seat.controller === "agent"
                          ? "API 조종"
                          : "사람";
                    return (
                      <div className="lobby-status" key={seat.id}>
                        <span
                          className={`status-dot ${seat.connected ? "" : "waiting"}`}
                        />
                        <span>
                          {seat.name || seat.id} · {controller} ·{" "}
                          {seat.connected ? "참가 완료" : "기다리는 중"}
                        </span>
                        {game.playerId === "p1" &&
                        seat.id !== "p1" &&
                        seat.controller === "npc" ? (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={async () => {
                              if (await api.claimNpc(seat.id))
                                setToast(`${seat.name || seat.id} 초대 코드를 만들었어요.`);
                            }}
                          >
                            사람에게 초대
                          </button>
                        ) : null}
                        {invite ? (
                          <div className="invite-code">
                            <code>{invite}</code>
                            <button
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(invite);
                                  setToast(`${seat.name || seat.id} 코드를 복사했어요.`);
                                } catch {
                                  setToast("코드를 선택해 복사해 주세요.");
                                }
                              }}
                            >
                              복사
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <p className="fine-print">
                  방장 화면에만 좌석별 초대 코드가 보여요. 참가자는 자기 좌석과
                  관측 가능한 지도만 받아요.
                </p>
              </>
            ) : session.inviteCode && !game.opponentConnected ? (
              <>
                <label className="input-label">상대 초대 코드</label>
                <div className="invite-code">
                  <code>{session.inviteCode}</code>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(session.inviteCode);
                        setToast("초대 코드를 복사했어요.");
                      } catch {
                        setToast("코드를 선택해 복사해 주세요.");
                      }
                    }}
                  >
                    복사
                  </button>
                </div>
                <p className="fine-print">
                  대화 상대에게 이 코드를 전달하면 텍스트 API로 참가할 수
                  있어요.
                </p>
              </>
            ) : null}
            {!expansion ? (
              <>
                <div className="lobby-status">
                  <span className="status-dot" />나 · 참가 완료
                </div>
                <div className="lobby-status">
                  <span
                    className={`status-dot ${game.opponentConnected ? "" : "waiting"}`}
                  />
                  {game.opponentConnected
                    ? "상대 · 참가 완료"
                    : "상대 · 기다리는 중"}
                </div>
              </>
            ) : null}
            {game.playerId === "p1" ? (
              <button
                className="primary full"
                disabled={
                  busy ||
                  (expansion ? missingSeats.length > 0 : !game.opponentConnected) ||
                  game.phase !== "lobby"
                }
                onClick={async () => {
                  if (await api.start()) setModal(null);
                }}
              >
                경기 시작
                <Icon name="arrow" />
              </button>
            ) : (
              <p>방장이 시작하면 첫 턴이 열려요.</p>
            )}
          </Modal>
        ) : null}
        {modal === "join" ? (
          <Modal title="대전 참가" onClose={() => setModal(null)}>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (await api.join(code.trim())) setModal("lobby");
              }}
            >
              <label className="input-label" htmlFor="invite">
                초대 코드
              </label>
              <input
                id="invite"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                required
                placeholder="상대가 보낸 코드"
              />
              <button
                className="primary full"
                disabled={busy || !code.trim()}
                type="submit"
              >
                참가
                <Icon name="arrow" />
              </button>
            </form>
          </Modal>
        ) : null}
        {modal === "rules" ? (
          <Modal title="게임 규칙" wide onClose={() => setModal(null)}>
            <Rules />
          </Modal>
        ) : null}
        {modal === "events" ? (
          <Modal title="이번 턴 소식" onClose={() => setModal(null)}>
            <ul className="event-list">
              {game.events.map((e, i) => (
                <li key={i}>{e.text}</li>
              ))}
            </ul>
          </Modal>
        ) : null}
        {modal === "result" ? (
          <Modal
            title={
              game.winner === "draw"
                ? "무승부"
                : game.winner === game.playerId
                  ? "승리했어요"
                  : "이번 전선은 여기까지"
            }
            onClose={() => setModal(null)}
          >
            <p className="description">
              {game.winner === "draw"
                ? "두 진영의 최종 점수가 같아요."
                : game.winner === game.playerId
                  ? "농지와 병력으로 전선을 지켜냈어요."
                  : "다른 배치와 생산 순서로 다시 도전해 보세요."}
            </p>
            {game.events
              .filter((e) => e.text.startsWith("최종"))
              .map((e, i) => (
                <p key={i}>{e.text}</p>
              ))}
            <button
              className="primary full"
              onClick={() => newGame("practice")}
            >
              새 연습
              <Icon name="arrow" />
            </button>
          </Modal>
        ) : null}
      </main>
    </FeedbackContext.Provider>
  );
}
const maxHealthLocal = (u) => 100 * u.size;
