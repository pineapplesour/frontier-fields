import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FACTIONS, RESOURCES } from "../shared/rules.js";
import { DealSummary } from "./DealBuilder.jsx";
import { Icon } from "./Icons.jsx";
import {
  appendNoticeUpdates,
  initialNoticeState,
  noticeKey,
} from "./notificationHelpers.js";

const statusNames = {
  requested: "새 거래 제안",
  accepted: "거래 성립",
  rejected: "거래 거절",
  cancelled: "거래 취소",
  expired: "거래 만료",
};

const factionName = (id) => FACTIONS[id]?.name ?? id ?? "알 수 없는 문명";

function proposalDescription(proposal) {
  if (!proposal) return "거래 조건을 확인해 주세요.";
  if (proposal.kind === "ultimatum") return `금 요구 최후통첩 · ${proposal.gold}G 지급 요구 · ${proposal.expires}턴까지 응답 · 거절·미응답 시 자동 전쟁 없음`;
  if (proposal.kind === "trade")
    return `${RESOURCES[proposal.resource]?.name ?? proposal.resource} ${proposal.amount ?? 0}개 · ${proposal.gold ?? 0}G`;
  if (proposal.kind === "alliance") return "10턴 동맹 제안";
  if (proposal.kind === "peace")
    return `5턴 평화 협정 · ${proposal.gold ?? 0}G`;
  return "도시·유닛·자원·외교 조건을 묶은 제안";
}

const responseAction = (proposal, accepted) => {
  if (proposal?.kind === "peace")
    return accepted ? "acceptPeace" : "rejectPeace";
  return accepted ? "acceptProposal" : "rejectProposal";
};

export function TradeNotice({
  game,
  matchId,
  disabled = false,
  onTrade,
  soundEnabled: _soundEnabled,
  volume: _volume,
}) {
  const state = useRef(null);
  const noticeRef = useRef(null);
  const popup = useRef(null);
  const [notice, setNotice] = useState(null);
  const [portalHost, setPortalHost] = useState(document.body);
  const [responding, setResponding] = useState(false);

  const dismiss = () => {
    noticeRef.current = null;
    const queued = state.current?.queue?.shift() ?? null;
    noticeRef.current = queued;
    setNotice(queued);
    setResponding(false);
  };

  useEffect(() => {
    if (!game?.playerId) return;
    const current = state.current;
    let next;
    if (!current || current.matchId !== matchId) {
      // A saved/new match can replace the previous view while its popup is
      // still open. Drop that visual item before seeding the new match's
      // pending queue; historical outcomes remain marked seen below.
      noticeRef.current = null;
      setNotice(null);
      setResponding(false);
      const initial = initialNoticeState(game);
      next = {
        matchId,
        seen: initial.seen,
        seenLogical: initial.seenLogical,
        queue: [...initial.queue],
      };
    } else {
      next = appendNoticeUpdates(current, game);
    }
    state.current = next;
    if (!noticeRef.current && next.queue.length) {
      const first = next.queue.shift();
      noticeRef.current = first;
      setNotice(first);
    }
  }, [matchId, game?.revision, game?.tradeNotices, game?.diplomacy]);

  useEffect(() => {
    if (!notice) return;
    const syncHost = () =>
      setPortalHost(document.querySelector("dialog[open]") ?? document.body);
    syncHost();
    const observer = new MutationObserver(syncHost);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, [notice]);

  useEffect(() => {
    if (notice && popup.current?.showPopover) popup.current.showPopover();
  }, [notice, portalHost]);

  useEffect(() => {
    if (!notice) return;
    // A proposal is never accepted or rejected by timeout; timeout only
    // advances the visual queue so a later durable outcome can surface.
    const timer = setTimeout(dismiss, notice.status === "requested" ? 15000 : 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  const proposal = notice.proposal ?? {};
  const incoming =
    notice.status === "requested" && proposal.to === game.playerId;
  const actionable = incoming && game.diplomacy?.some((p) => p.id === proposal.id);
  const key = noticeKey(notice) ?? notice.id ?? proposal.id;
  const respond = async (accepted) => {
    if (!actionable || disabled || responding) return;
    setResponding(true);
    const ok = await onTrade({
      action: responseAction(proposal, accepted),
      proposalId: proposal.id,
    });
    if (ok) dismiss();
    else setResponding(false);
  };
  return createPortal(
    <div
      key={key}
      className={`trade-announcement trade-${notice.status}`}
      role={incoming ? "alertdialog" : "status"}
      aria-live="polite"
      ref={popup}
      popover="manual"
    >
      <Icon name="people" size={22} />
      <div className="trade-announcement-body">
        <small>
          {notice.turn ? `${notice.turn}턴 · ` : ""}
          {factionName(proposal.from)} → {factionName(proposal.to)}
        </small>
        <strong>{proposal.kind === "ultimatum" ? (statusNames[notice.status] ?? "거래 알림").replace("거래", "금 요구 최후통첩") : statusNames[notice.status] ?? "거래 알림"}</strong>
        <p>{proposalDescription(proposal)}</p>
        {proposal.kind === "deal" ? (
          <DealSummary
            proposal={{
              ...proposal,
              give: proposal.give ?? { gold: 0, resources: {}, units: [], cities: [] },
              receive: proposal.receive ?? {
                gold: 0,
                resources: {},
                units: [],
                cities: [],
              },
            }}
          />
        ) : null}
        {actionable ? (
          <div className="trade-notice-actions">
            <button
              className="primary"
              disabled={disabled || responding}
              onClick={() => respond(true)}
            >
              수락
            </button>
            <button
              className="soft-button"
              disabled={disabled || responding}
              onClick={() => respond(false)}
            >
              거절
            </button>
          </div>
        ) : null}
      </div>
      <button
        className="trade-notice-close"
        aria-label="거래 알림 닫기"
        onClick={dismiss}
      >
        <Icon name="close" size={15} />
      </button>
    </div>,
    portalHost,
  );
}
