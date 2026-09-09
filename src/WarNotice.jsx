import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playSound } from "./sound.js";
import { Icon } from "./Icons.jsx";
import { factionFor } from "./factions.js";
export function WarNotice({ game, soundEnabled, volume }) {
  const last = game.announcements?.at(-1),
    previous = useRef(null),
    [notice, setNotice] = useState(null);
  const popup = useRef(null);
  const [portalHost, setPortalHost] = useState(document.body);
  useEffect(() => {
    if (!notice) return;
    // A popover outside an open modal is visible but still inert. Keep the
    // announcement in the active modal's subtree so its close button works.
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
    if (!last || previous.current === last.id) return;
    previous.current = last.id;
    setNotice(last);
    if (soundEnabled) playSound("war", volume);
    const t = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(t);
  }, [last?.id]);
  return notice
    ? createPortal(
        <div
          className="war-announcement"
          role="alert"
          ref={popup}
          popover="manual"
        >
          <Icon name="flag" size={22} />
          <div>
            <small>모든 세력에 전달된 소식 · {notice.turn}턴</small>
            <strong>전쟁이 선포되었습니다</strong>
            <p>
              <span style={{ color: factionFor(game, notice.from).color }}>
                {factionFor(game, notice.from).name}
              </span>{" "}
              →{" "}
              <span style={{ color: factionFor(game, notice.to).color }}>
                {factionFor(game, notice.to).name}
              </span>
            </p>
          </div>
          <button aria-label="전쟁 알림 닫기" onClick={() => setNotice(null)}>
            <Icon name="close" size={15} />
          </button>
        </div>,
        portalHost,
      )
    : null;
}
