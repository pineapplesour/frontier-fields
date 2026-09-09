import React, { useState } from "react";
import { Modal } from "./Panels.jsx";
const storageKey = "fieldline-saves-v1";
function readSaves() {
  try {
    const list = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
export function SaveGames({ game, busy, onSave, onLoad, onClose }) {
  const [name, setName] = useState(
    `${game.turn}턴 · ${game.mode === "duel" ? "대전" : "연습"}`,
  );
  const [saves, setSaves] = useState(readSaves);
  const [confirm, setConfirm] = useState(null),
    [message, setMessage] = useState("");
  return (
    <Modal title="저장 · 불러오기" onClose={onClose}>
      <p className="description">
        서버에 저장하고 이 브라우저에 목록을 보관해요. 불러오면 일시정지 상태로
        열려요. 대전은 새 초대 코드로 상대를 다시 초대해 주세요.
      </p>
      <form
        className="save-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const saved = await onSave(name);
          if (!saved) return;
          const next = [saved, ...saves];
          setSaves(next);
          try {
            localStorage.setItem(storageKey, JSON.stringify(next));
            setMessage("저장했어요. 서버를 재시작해도 불러올 수 있어요.");
          } catch {
            setMessage(
              "서버 저장은 완료했지만 브라우저 목록을 기록하지 못했어요. 브라우저 저장 공간을 확인해 주세요.",
            );
          }
        }}
      >
        <label htmlFor="save-name">저장 이름</label>
        <div>
          <input
            id="save-name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || game.playerId !== "p1" || !name.trim()}
          >
            현재 경기 저장
          </button>
        </div>
      </form>
      {message ? (
        <p className="save-message" role="status">
          {message}
        </p>
      ) : null}
      <div className="save-list">
        {saves.length ? (
          saves.map((s) => (
            <div key={s.id}>
              <span>
                <strong>{s.name}</strong>
                <small>
                  {new Date(s.savedAt).toLocaleString("ko-KR")} · {s.turn}턴
                </small>
              </span>
              <button
                className={confirm === s.id ? "primary" : "soft-button"}
                disabled={busy}
                onClick={async () => {
                  if (confirm !== s.id) {
                    setConfirm(s.id);
                    return;
                  }
                  await onLoad(s.id);
                }}
              >
                {confirm === s.id ? "불러오기 확정" : "불러오기"}
              </button>
              {confirm === s.id ? (
                <p>
                  현재 화면을 저장본으로 전환해요. 저장하지 않은 진행은 저장본에
                  포함되지 않아요.
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <p className="description">아직 저장한 경기가 없어요.</p>
        )}
      </div>
    </Modal>
  );
}
