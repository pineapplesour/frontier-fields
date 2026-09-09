import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FACTIONS } from "../shared/rules.js";
import { Icon } from "./Icons.jsx";
import {
  appendGuaranteeNoticeUpdates,
  guaranteeActions,
  guaranteeNoticeKey,
  initialGuaranteeNoticeState,
  isPendingIncomingGuaranteeNotice,
} from "./guaranteeHelpers.js";

const statusNames = {
  requested: "방어전 참전 요청",
  accepted: "방어전 참전 동의",
  rejected: "방어전 참전 거절",
  cancelled: "독립보장 취소",
  expired: "참전 요청 만료",
};

function factionName(game, id) {
  return (
    game?.factions?.find((faction) => faction.id === id)?.name ??
    FACTIONS[id]?.name ??
    id ??
    "알 수 없는 문명"
  );
}

function callDescription(game, notice) {
  const proposal = notice?.proposal ?? {};
  const protectedName = factionName(game, proposal.protected);
  const attackerName = factionName(game, proposal.attacker);
  if (proposal.attacker && proposal.protected)
    return `${attackerName}이 ${protectedName}을 공격했어요. 독립보장에 따른 방어전 참전 여부를 선택하세요.`;
  if (proposal.protected)
    return `${protectedName}에 대한 방어전 참전 여부를 선택하세요.`;
  return "독립보장에 따른 방어전 참전 여부를 선택하세요.";
}

function outcomeDescription(game, notice) {
  const proposal = notice?.proposal ?? {};
  const protectedName = factionName(game, proposal.protected);
  if (notice.status === "accepted")
    return `${protectedName}에 대한 방어전 참전 동의가 기록됐어요. 동맹이 되거나 공격 명령이 자동으로 생긴 것은 아니며, 공식 전쟁 공지를 따릅니다.`;
  if (notice.status === "rejected")
    return `${protectedName}에 대한 방어전 참전 거절이 기록됐어요. 동맹 파기나 추가 공격 명령을 뜻하지 않습니다.`;
  if (notice.status === "cancelled") return "독립보장 또는 참전 요청이 취소됐어요.";
  if (notice.status === "expired") return "응답하지 않은 참전 요청이 만료됐어요.";
  return "독립보장 상태가 갱신됐어요.";
}

export function GuaranteeNotice({
  game,
  matchId,
  disabled = false,
  onTrade,
}) {
  const state = useRef(null);
  const noticeRef = useRef(null);
  const popup = useRef(null);
  const [notice, setNotice] = useState(null);
  const [responding, setResponding] = useState(false);
  const [portalHost, setPortalHost] = useState(() =>
    typeof document === "undefined" ? null : document.body,
  );

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
      noticeRef.current = null;
      setNotice(null);
      setResponding(false);
      const initial = initialGuaranteeNoticeState(game);
      next = {
        matchId,
        seen: initial.seen,
        queue: [...initial.queue],
      };
    } else {
      next = appendGuaranteeNoticeUpdates(current, game);
    }
    state.current = next;
    if (!noticeRef.current && next.queue.length) {
      const first = next.queue.shift();
      noticeRef.current = first;
      setNotice(first);
    }
  }, [
    matchId,
    game?.playerId,
    game?.revision,
    game?.guaranteeNotices,
    game?.callToArmsNotices,
    game?.guaranteeCalls,
    game?.defensiveCalls,
    game?.notifications,
  ]);

  useEffect(() => {
    if (!notice || typeof document === "undefined") return undefined;
    // A popover rendered outside an open modal is visible but inert. Portal it
    // into that dialog so the consent buttons remain usable while diplomacy or
    // another modal is open.
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
    if (!notice) return undefined;
    // A request never changes game state by timing out. Advancing the visual
    // queue only keeps a later durable outcome from being hidden behind it.
    const timer = setTimeout(
      dismiss,
      notice.status === "requested" ? 15000 : 8000,
    );
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice || !portalHost) return null;
  const proposal = notice.proposal ?? {};
  const incoming = isPendingIncomingGuaranteeNotice(notice, game.playerId);
  const noticeId = guaranteeNoticeKey(notice) ?? notice.id ?? proposal.id;
  const respond = async (accepted) => {
    if (!incoming || disabled || responding) return;
    setResponding(true);
    const actions = guaranteeActions(game);
    const action = accepted ? actions.acceptCall : actions.declineCall;
    const callId =
      proposal.callId ??
      proposal.id ??
      notice.callId ??
      notice.guaranteeCallId ??
      notice.id;
    const body = {
      action,
      ...(callId ? { callId, guaranteeCallId: callId } : {}),
      ...(proposal.guaranteeId ? { guaranteeId: proposal.guaranteeId } : {}),
      ...(notice.id ? { noticeId: notice.id } : {}),
    };
    const ok = await onTrade(body);
    if (ok) dismiss();
    else setResponding(false);
  };
  const outcome = !incoming || notice.status !== "requested";
  const fromName = factionName(game, proposal.guarantor ?? proposal.from);
  const protectedName = factionName(game, proposal.protected ?? proposal.to);
  return createPortal(
    <div
      key={noticeId}
      className={`guarantee-announcement guarantee-${notice.status}`}
      role={incoming ? "alertdialog" : "status"}
      aria-live="polite"
      ref={popup}
      popover="manual"
    >
      <Icon name="shield" size={23} />
      <div className="guarantee-announcement-body">
        <small>
          {notice.turn ? `${notice.turn}턴 · ` : ""}
          {fromName} → {protectedName}
        </small>
        <strong>{statusNames[notice.status] ?? "독립보장 알림"}</strong>
        <p>{outcome ? outcomeDescription(game, notice) : callDescription(game, notice)}</p>
        {incoming ? (
          <div className="guarantee-notice-actions">
            <button
              className="primary"
              disabled={disabled || responding}
              onClick={() => respond(true)}
            >
              참전 동의
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
        className="guarantee-notice-close"
        aria-label="독립보장 알림 닫기"
        onClick={dismiss}
      >
        <Icon name="close" size={15} />
      </button>
    </div>,
    portalHost,
  );
}
