import React, { useEffect, useRef, useState } from "react";
import { RELATIONS, RESOURCES, MARKET } from "../shared/rules.js";
import { Modal } from "./Panels.jsx";
import { Icon } from "./Icons.jsx";
import { DealBuilder, DealSummary } from "./DealBuilder.jsx";
import { factionFor, relationColor } from "./factions.js";
import { publicRelationAt, relationPresentation } from "./publicRelations.js";
import {
  guaranteeActions,
  guaranteeDirectionLabel,
  guaranteeRecords,
  guaranteeState,
  supportsGuarantees,
} from "./guaranteeHelpers.js";

function activeGuaranteeForPair(game, fromId, toId) {
  const state = guaranteeState(game, fromId, toId);
  return state.active ?? state.pending;
}

function GuaranteeBadge({ record, game, subjectId, compact = false }) {
  if (!record) return null;
  const names = Object.fromEntries(
    (game?.factions ?? []).map((faction) => [faction.id, faction.name]),
  );
  return (
    <span
      className={`guarantee-badge guarantee-${record.status}${compact ? " compact" : ""}`}
      title={`${names[record.from] ?? record.from}이 ${names[record.to] ?? record.to}의 독립을 보장합니다. 방어전 참전만 해당하며 동맹은 아닙니다.`}
    >
      <Icon name="shield" size={compact ? 12 : 14} />
      {guaranteeDirectionLabel(record, game.playerId, subjectId, names)}
    </span>
  );
}

export function FactionStrip({ game, onOpen }) {
  const lastRound = useRef(game.lastNpcTurns?.round);
  const [result, setResult] = useState(null);
  useEffect(() => {
    const run = game.lastNpcTurns;
    if (!run || run.round === lastRound.current) return;
    lastRound.current = run.round;
    setResult({ id: run.factions[0], round: run.round });
    const timers = run.factions
      .slice(1)
      .map((id, i) =>
        setTimeout(() => setResult({ id, round: run.round }), (i + 1) * 1300),
      );
    timers.push(setTimeout(() => setResult(null), run.factions.length * 1300));
    return () => timers.forEach(clearTimeout);
  }, [game.lastNpcTurns?.round]);
  return (
    <nav className="faction-strip" aria-label="문명과 외교 관계">
      {result ? (
        <span className="npc-turn-result" role="status">
          {result.round}턴 자동 세력 처리 결과 · {factionFor(game, result.id).name} 턴
          완료
        </span>
      ) : null}
      <span className="strip-title">문명</span>
      {game.factions.map((f) => (
        <button
          key={f.id}
          className={`faction-token ${f.id === game.activePlayer ? "current-turn" : ""} ${f.id === result?.id ? "turn-result" : ""}`}
          style={{ "--faction": relationColor(f) }}
          onClick={() => onOpen(f.id)}
          data-tip={`${f.name} · ${RELATIONS[f.relation]}${f.id === game.activePlayer ? " · 현재 행동 중" : ""} · 눌러서 문명과 외교`}
          aria-label={`${f.name} · ${RELATIONS[f.relation]}${f.id === game.activePlayer ? " · 현재 턴" : ""}`}
        >
          <span className="faction-emblem" style={{ background: f.color }}>{f.symbol}</span>
          <span className="faction-caption">
            {f.name
              .replace(" 도시국가", "")
              .replace(" 연맹", "")
              .replace(" 왕국", "")}
            <small style={{ color: relationColor(f) }}>
              {f.id === result?.id
                ? "✓ 턴 완료"
                : f.id === game.activePlayer
                  ? "● 현재 턴"
                  : RELATIONS[f.relation]}
            </small>
          </span>
        </button>
      ))}
    </nav>
  );
}

export function PublicRelationsMatrix({ game, faction }) {
  const others = game.factions.filter((other) => other.id !== faction.id);
  const rows = others.map((other) => {
    const relation = relationPresentation(
      publicRelationAt(game, faction.id, other.id),
    );
    const guarantee =
      activeGuaranteeForPair(game, faction.id, other.id) ??
      activeGuaranteeForPair(game, other.id, faction.id);
    return { other, relation, guarantee };
  });
  return (
    <section
      className="public-relations"
      aria-label={`${faction.name}의 공개 외교 관계`}
    >
      <div className="public-relations-head">
        <div>
          <h3>{faction.name}의 관계표</h3>
          <p>공개된 정보만 표시해요. 비어 있는 관계는 아직 확인되지 않았어요.</p>
        </div>
        <Icon name="people" size={18} />
      </div>
      <div className="public-relations-list">
        {rows.map(({ other, relation, guarantee }) => (
          <div
            className={`public-relation-row relation-${relation.tone}${guarantee ? " has-guarantee" : ""}`}
            key={other.id}
          >
            <span
              className="public-relation-emblem"
              style={{ "--faction": other.color }}
              aria-hidden="true"
            >
              {other.symbol}
            </span>
            <strong>{other.name}</strong>
            <span className="public-relation-state">
              <Icon name={relation.icon} size={14} />
              {relation.label}
            </span>
            {guarantee ? (
              <GuaranteeBadge
                record={guarantee}
                game={game}
                subjectId={
                  guarantee.from === game.playerId
                    ? guarantee.to
                    : guarantee.to === game.playerId
                      ? guarantee.from
                      : other.id
                }
                compact
              />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function GuaranteePanel({ game, faction, disabled, onTrade }) {
  if (!supportsGuarantees(game)) return null;
  const records = guaranteeRecords(game).filter(
    (record) =>
      (record.from === faction.id || record.to === faction.id) &&
      ["active", "pending"].includes(record.status),
  );
  const byPair = new Map();
  for (const record of records) {
    const pair = `${record.from}->${record.to}`;
    const existing = byPair.get(pair);
    if (!existing || record.status === "active") byPair.set(pair, record);
  }
  const visible = [...byPair.values()];
  const outgoing = guaranteeState(game, game.playerId, faction.id);
  const incoming = guaranteeState(game, faction.id, game.playerId);
  const actions = guaranteeActions(game);
  const names = Object.fromEntries(
    game.factions.map((entry) => [entry.id, entry.name]),
  );
  const act = (action, record = null) =>
    onTrade({
      action,
      factionId: faction.id,
      ...(record?.explicitId ? { guaranteeId: record.id } : {}),
    });
  const canManage =
    faction.id !== game.playerId && faction.kind !== "barbarian";
  return (
    <section className="guarantee-panel" aria-label="독립보장">
      <div className="guarantee-panel-head">
        <div>
          <h3>
            <Icon name="shield" size={16} /> 독립보장
          </h3>
          <p>
            공격을 받은 경우에만 방어전 참전을 요청해요. 독립보장은 동맹이나
            공격 명령 자동 수락이 아니에요.
          </p>
        </div>
        <span className="guarantee-rule">방어전만</span>
      </div>
      {visible.length ? (
        <div className="guarantee-relation-list">
          {visible.map((record) => {
            const from = factionFor(game, record.from);
            const to = factionFor(game, record.to);
            return (
              <div
                className="guarantee-relation-row"
                key={`${record.id}:${record.from}:${record.to}`}
              >
                <span
                  className="guarantee-faction-icon"
                  style={{ "--faction": from.color }}
                  title={from.name}
                  aria-label={from.name}
                >
                  {from.symbol}
                </span>
                <span className="guarantee-relation-arrow" aria-hidden="true">
                  →
                </span>
                <span
                  className="guarantee-faction-icon"
                  style={{ "--faction": to.color }}
                  title={to.name}
                  aria-label={to.name}
                >
                  {to.symbol}
                </span>
                <span className="guarantee-relation-copy">
                  <strong>
                    {names[record.from] ?? record.from} → {names[record.to] ?? record.to}
                  </strong>
                  <small>독립보장 · 방어전 참전만</small>
                </span>
                <GuaranteeBadge
                  record={record}
                  game={game}
                  subjectId={
                    record.from === game.playerId
                      ? record.to
                      : record.to === game.playerId
                        ? record.from
                        : faction.id
                  }
                  compact
                />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="guarantee-empty">현재 공개된 독립보장이 없어요.</p>
      )}
      {canManage ? (
        <div className="guarantee-actions">
          {outgoing.active ? (
            <>
              <span className="guarantee-status guarantee-status-outgoing">
                <Icon name="shield" size={14} /> 독립보장중
              </span>
              <button
                className="soft-button"
                disabled={disabled}
                onClick={() => act(actions.withdraw, outgoing.active)}
              >
                보장 철회
              </button>
            </>
          ) : outgoing.pending ? (
            <span className="guarantee-status guarantee-status-pending">
              독립보장 요청 처리 중
            </span>
          ) : incoming.active ? (
            <span className="guarantee-status guarantee-status-incoming">
              <Icon name="shield" size={14} /> 보장받음
            </span>
          ) : incoming.pending ? (
            <span className="guarantee-status guarantee-status-pending">
              보장 요청 처리 중
            </span>
          ) : (
            <button
              className="soft-button guarantee-issue-button"
              disabled={disabled}
              onClick={() => act(actions.issue)}
            >
              <Icon name="shield" size={15} /> 독립 보장하기
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function Civilization({
  game,
  factionId,
  disabled,
  tradeDisabled = disabled,
  onTrade,
  onPreview,
  onClose,
  onSelect,
}) {
  const f =
    game.factions.find((f) => f.id === factionId) ??
    game.factions.find((f) => f.id !== game.playerId);
  const [confirm, setConfirm] = useState(null),
    [gold, setGold] = useState(40),
    [deadlineTurns, setDeadlineTurns] = useState(3),
    [resource, setResource] = useState("iron"),
    [amount, setAmount] = useState(1),
    [price, setPrice] = useState(7),
    [tab, setTab] = useState("relations");
  const own = f.id === game.playerId,
    barbarian = f.kind === "barbarian",
    profileRelation = relationPresentation(f.hostile ? "war" : f.relation),
    pending = game.diplomacy.filter(
      (p) => {
        const kind = String(p.kind ?? p.type ?? "").toLowerCase();
        return (
          (p.from === f.id || p.to === f.id) &&
          !kind.includes("guarantee") &&
          kind !== "protection"
        );
      },
    ),
    atPeace = f.peaceUntil >= game.turn;
  const act = async (action) => {
    if (
      ["declareWar", "denounce", "breakAlliance"].includes(action) &&
      confirm !== action
    ) {
      setConfirm(action);
      return;
    }
    await onTrade({
      action,
      factionId: f.id,
      ...(action === "peace"
        ? { gold }
        : action === "gift"
          ? { gold: 20 }
          : action === "offerTrade"
            ? { resource, amount, gold: price }
            : {}),
    });
    setConfirm(null);
  };
  const independentAction = (action) =>
    [
      "peace",
      "gift",
      "alliance",
      "offerTrade",
      "offerDeal",
      "issueUltimatum",
      "acceptProposal",
      "rejectProposal",
      "cancelProposal",
      "acceptPeace",
      "rejectPeace",
      "cancelPeace",
    ].includes(action)
      ? tradeDisabled
      : disabled;
  return (
    <Modal title={`${f.name} · 문명`} onClose={onClose} wide={tab === "trade"}>
      <div className="civ-profile" style={{ "--faction": f.color }}>
        <span className="faction-emblem">{f.symbol}</span>
        <div>
          <h3>{f.name}</h3>
          <p>
            {own
              ? "내 문명"
              : game.seats?.some(seat => seat.id === f.id && seat.controller === "npc")
                ? "규칙 기반 문명"
              : f.kind === "player"
                ? "직접 플레이하는 상대"
                : f.kind === "independent"
                  ? "규칙 기반 문명"
                  : barbarian
                    ? "파괴 가능한 자동 생성 거점"
                    : "방어 중심 도시국가"}
          </p>
        </div>
        <strong className={`civ-profile-status relation-${profileRelation.tone}`}>
          {RELATIONS[f.relation] ?? profileRelation.label}
        </strong>
      </div>
      <div className="civ-switcher">
        {game.factions.map((x) => (
          <button
            key={x.id}
            onClick={() => {
              onSelect(x.id);
              setConfirm(null);
              setTab("relations");
            }}
            style={{ color: x.color }}
            aria-label={`${x.name} 문명 보기`}
          >
            {x.symbol}
          </button>
        ))}
      </div>
      <div className="civ-tabs">
        <button
          className={tab === "relations" ? "active" : ""}
          onClick={() => setTab("relations")}
        >
          외교 관계
        </button>
        <button
          className={tab === "trade" ? "active" : ""}
          onClick={() => setTab("trade")}
          disabled={own || barbarian}
        >
          거래
        </button>
      </div>
      {tab === "relations" ? (
        <>
          <PublicRelationsMatrix game={game} faction={f} />
          {!own && !barbarian && !f.hostile ? <p className="description">
            상대 영토 진입: {f.openBordersUntil > game.turn ? `${f.openBordersUntil - game.turn}턴 허용` : "국경개방 거래 필요"}
            {" · "}내 영토 개방: {f.grantedBordersUntil > game.turn ? `${f.grantedBordersUntil - game.turn}턴 남음` : "닫힘"}
          </p> : null}
          <GuaranteePanel
            game={game}
            faction={f}
            disabled={disabled}
            onTrade={onTrade}
          />
          <p className="description">
            {own
              ? "내 도시와 병력은 아래 목록이나 지도에서 선택할 수 있어요."
              : barbarian
                ? "항상 적대합니다. 거점을 파괴하면 그곳에서 병력이 더 생성되지 않아요."
                : f.hostile
                  ? "전쟁 중입니다. 평화 협정을 제안할 수 있어요."
                  : f.relation === "alliance"
                    ? `동맹 ${f.allianceUntil - game.turn + 1}턴 남음 · 공격 금지 · 시야 공유 없음`
                    : atPeace
                      ? `평화 협정 ${f.peaceUntil - game.turn + 1}턴 남음 · 선전포고 불가`
                      : "선전포고 전에는 공격할 수 없어요. 공개비난은 전쟁과 별개이며 10턴간 표시돼요."}
          </p>
          {!own && !barbarian ? (
            <div className="civ-actions">
              {!f.hostile && f.relation !== "alliance" && !atPeace ? (
                <div className="peace-offer">
                  <label>금 요구 최후통첩 <input aria-label="최후통첩 요구 골드" type="number" min="1" max="10000" value={gold} onChange={e => setGold(Number(e.target.value))} /></label>
                  <label>응답 기한 <input aria-label="최후통첩 응답 기한" type="number" min="1" max="10" value={deadlineTurns} onChange={e => setDeadlineTurns(Number(e.target.value))} />턴</label>
                  <button className="soft-button" disabled={tradeDisabled || pending.length > 0 || !Number.isInteger(gold) || gold < 1 || gold > 10000 || !Number.isInteger(deadlineTurns) || deadlineTurns < 1 || deadlineTurns > 10} onClick={async () => {
                    if (confirm !== "issueUltimatum") { setConfirm("issueUltimatum"); return; }
                    await onTrade({ action: "issueUltimatum", factionId: f.id, gold, deadlineTurns });
                    setConfirm(null);
                  }}>{confirm === "issueUltimatum" ? "최후통첩 발송 확정" : "최후통첩 보내기"}</button>
                  <p className="fine-print">거절·기한 만료 후 전쟁 선포는 직접 선택해요. 자동 전쟁은 없어요. 규칙 기반 문명은 금 요구를 거절해요.</p>
                </div>
              ) : null}
              {f.hostile ? (
                <label className="peace-offer">
                  제안금{" "}
                  <input
                    aria-label="평화 제안금"
                    type="number"
                    min="0"
                    max={game.economy.gold}
                    value={gold}
                    onChange={(e) => setGold(Number(e.target.value))}
                  />
                  <button
                    className="soft-button"
                    disabled={independentAction("peace") || pending.length > 0}
                    onClick={() => act("peace")}
                  >
                    평화 제안
                  </button>
                </label>
              ) : (
                <>
                  <button
                    className={
                      confirm === "declareWar" ? "danger-button" : "soft-button"
                    }
                    disabled={disabled || atPeace || f.relation === "alliance"}
                    onClick={() => act("declareWar")}
                  >
                    <Icon name="flag" size={16} />
                    {confirm === "declareWar" ? "선전포고 확정" : "전쟁 선포"}
                  </button>
                  <button
                    className="soft-button"
                    disabled={disabled || f.relation === "alliance"}
                    onClick={() => act("denounce")}
                  >
                    {confirm === "denounce" ? "공개비난 확정" : "공개비난"}
                  </button>
                  <button
                    className="soft-button"
                    disabled={
                      independentAction(
                        f.relation === "alliance" ? "breakAlliance" : "alliance",
                      ) || pending.length > 0
                    }
                    onClick={() =>
                      act(
                        f.relation === "alliance"
                          ? "breakAlliance"
                          : "alliance",
                      )
                    }
                  >
                    {f.relation === "alliance"
                      ? confirm === "breakAlliance"
                        ? "동맹 파기 확정"
                        : "동맹 파기"
                      : "동맹 요청"}
                  </button>
                  <button
                    className="soft-button"
                    disabled={independentAction("gift") || game.economy.gold < 20}
                    onClick={() => act("gift")}
                  >
                    우호 선물 · 20G
                  </button>
                </>
              )}
            </div>
          ) : null}
          {!own && !barbarian ? (
            <p className="fine-print">
              상대 플레이어의 동맹·평화·거래는 직접 수락해야 성립해요. 규칙 기반
              문명은 ‘좋음’ 관계에서 동맹을 수락해요. 동맹 10턴, 평화 5턴.
            </p>
          ) : null}
        </>
      ) : (
        <DealBuilder
          key={f.id}
          game={game}
          faction={f}
          disabled={tradeDisabled}
          onTrade={onTrade}
          onPreview={onPreview}
        />
      )}
      {pending.map((p) => (
        <div className="peace-proposal" key={p.id}>
          <strong>
            {factionFor(game, p.from).name} → {factionFor(game, p.to).name}
          </strong>
          {p.kind === "deal" ? <DealSummary proposal={p} game={game} /> : null}
          <p>
            {p.kind === "deal"
              ? "통합 거래 제안"
              : p.kind === "ultimatum"
                ? `금 요구 최후통첩 · ${p.gold}G 지급 요구 · 미응답 시 자동 전쟁 없음`
              : p.kind === "alliance"
                ? "10턴 동맹"
                : p.kind === "trade"
                  ? `${RESOURCES[p.resource].name} ${p.amount}개 판매 / ${p.gold}G`
                  : `5턴 평화 / ${p.gold}G`}{" "}
            · {p.expires - game.turn}턴 뒤 만료
          </p>
          {p.from === game.playerId ? (
            <button
              className="soft-button"
              disabled={independentAction("cancelProposal")}
              onClick={() =>
                onTrade({ action: "cancelProposal", proposalId: p.id })
              }
            >
              {p.kind === "ultimatum" ? "최후통첩 철회" : "제안 취소 · 보관분 반환"}
            </button>
          ) : (
            <div className="time-presets">
              <button
                disabled={independentAction("acceptProposal")}
                onClick={() =>
                  onTrade({ action: "acceptProposal", proposalId: p.id })
                }
              >
                {p.kind === "ultimatum" ? `${p.gold}G 지급하고 수락` : "수락"}
              </button>
              <button
                disabled={independentAction("rejectProposal")}
                onClick={() =>
                  onTrade({ action: "rejectProposal", proposalId: p.id })
                }
              >
                거절
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="known-cities">
        <h3>{own ? "내 도시" : "현재 관측되는 도시"}</h3>
        {game.cities
          .filter((c) => c.owner === f.id)
          .map((c) => (
            <p key={c.id}>
              {c.name}
              <span>
                체력 {c.hp} · 성벽 {c.wallLevel ?? 0}레벨
              </span>
            </p>
          ))}
        {!game.cities.some((c) => c.owner === f.id) ? (
          <p className="fine-print">현재 시야 안에서 확인된 도시가 없어요.</p>
        ) : null}
      </div>
    </Modal>
  );
}
