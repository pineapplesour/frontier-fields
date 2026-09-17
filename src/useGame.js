import { useCallback, useEffect, useRef, useState } from "react";
import { readJoinCode, withoutJoinCode } from "./inviteLink.js";

const apiOrigin = String(import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function api(path, { session, body, signal } = {}) {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await response.json();
  if (!response.ok) {
    const e = new Error(data.error ?? "연결을 확인해 주세요.");
    e.status = response.status;
    throw e;
  }
  return data;
}
const storageKey = "fieldline-session-v1";
export function useGame() {
  const [session, setSession] = useState(null);
  const [game, setGame] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef(null);
  const sessionRef = useRef(null);
  function receive(data, matchId = null) {
    if (matchId && sessionRef.current?.matchId !== matchId) return;
    const revision = Number(data?.revision),
      currentRevision = Number(current.current?.revision);
    if (
      !current.current ||
      (Number.isFinite(revision) &&
        (!Number.isFinite(currentRevision) || revision > currentRevision))
    ) {
      data.receivedAt = Date.now();
      current.current = data;
      setGame(data);
      setError("");
    }
  }
  function adopt(data) {
    const s = {
      matchId: data.matchId,
      playerId: data.playerId,
      token: data.token,
      inviteCode: data.inviteCode ?? null,
      // Invite codes are host-only, seat-scoped capabilities.  Joining a
      // match deliberately receives an empty map instead of another seat's
      // credentials.
      inviteCodes: data.inviteCodes ?? {},
    };
    sessionStorage.setItem(storageKey, JSON.stringify(s));
    sessionRef.current = s;
    data.observation.receivedAt = Date.now();
    current.current = data.observation;
    setGame(data.observation);
    setSession(s);
    setError("");
  }
  useEffect(() => {
    let active = true;
    // Invite link: "#join=<code>" joins that seat on load.  The code is a
    // single-use capability, so it is taken out of the address bar right away.
    const linkedCode = readJoinCode(
      typeof window === "undefined" ? "" : window.location.href,
    );
    if (linkedCode)
      try {
        window.history.replaceState(
          null,
          "",
          withoutJoinCode(window.location.href),
        );
      } catch {}
    (async () => {
      try {
        let saved;
        try {
          saved = JSON.parse(sessionStorage.getItem(storageKey));
        } catch {}
        // An invite link outranks whatever this tab was showing: opening a
        // link is an explicit "join this seat" action, and the code is only
        // in the URL on that first open (it is stripped right away).
        if (linkedCode)
          try {
            const joined = await api("/join", { body: { code: linkedCode } });
            if (active) adopt(joined);
            return;
          } catch (e) {
            if (e.status !== 404) throw e;
            if (active)
              setError(
                "초대 링크가 만료됐어요. 초대 코드는 한 번만 쓸 수 있어요.",
              );
          }
        if (saved) {
          try {
            const state = await api(`/matches/${saved.matchId}`, {
              session: saved,
            });
            if (active) {
              sessionRef.current = saved;
              state.receivedAt = Date.now();
              current.current = state;
              setGame(state);
              setSession(saved);
            }
            return;
          } catch (e) {
            if (e.status !== 401) throw e;
          }
        }
        const data = await api("/matches", { body: { mode: "practice" } });
        if (active) adopt(data);
      } catch (e) {
        if (active) setError(e.message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let active = true;
    (async () => {
      while (active) {
        try {
          const data = await api(
            `/matches/${session.matchId}/wait?revision=${current.current?.revision ?? 0}`,
            { session, signal: controller.signal },
          );
          // The previous long-poll can still resolve after a session switch.
          // Carry the request's match id through the monotonic receive gate so
          // an old match can never overwrite the resumed/new match snapshot.
          if (active) receive(data, session.matchId);
        } catch (e) {
          if (!active) return;
          setError(
            e.status === 401
              ? "서버가 다시 시작됐어요. 메뉴에서 새 연습을 열어 주세요."
              : e.message,
          );
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [session]);
  async function perform(fn) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const create = (mode, options = {}) =>
    perform(async () => {
      adopt(await api("/matches", { body: { mode, ...options } }));
      return true;
    });
  const join = (code) =>
    perform(async () => {
      adopt(await api("/join", { body: { code } }));
      return true;
    });
  const action = (suffix, body) =>
    perform(async () => {
      const data = await api(`/matches/${session.matchId}/${suffix}`, {
        session,
        body,
      });
      receive(data, session.matchId);
      return data;
    });
  const inviteSeat = (seatId) =>
    perform(async () => {
      const data = await api(`/matches/${session.matchId}/invites`, {
        session,
        body: { seatId },
      });
      const next = {
        ...session,
        inviteCode:
          data.seatId === "p2" ? data.inviteCode : session.inviteCode,
        inviteCodes: { ...(session.inviteCodes ?? {}), [data.seatId]: data.inviteCode },
      };
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setSession(next);
      receive(await api(`/matches/${session.matchId}`, { session: next }));
      return data;
    });
  const claimNpc = (seatId) =>
    perform(async () => {
      const data = await api(`/matches/${session.matchId}/claim-npc`, {
        session,
        body: { seatId },
      });
      const next = {
        ...session,
        inviteCodes: { ...(session.inviteCodes ?? {}), [data.seatId]: data.inviteCode },
      };
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setSession(next);
      receive(await api(`/matches/${session.matchId}`, { session: next }));
      return data;
    });
  const checkpoint = () =>
    perform(() =>
      api(`/matches/${session.matchId}/runtime-checkpoint`, {
        session,
        body: {},
      }),
    );
  const preview = useCallback(
    (data, signal) =>
      api(`/matches/${session.matchId}/deal-preview`, {
        session,
        body: data,
        signal,
      }),
    [session],
  );
  return {
    game,
    session,
    error,
    setError,
    busy,
    create,
    join,
    order: (orders) => action("orders", { turn: game.turn, orders }),
    produce: (cityId, type, target = null) =>
      action("orders", {
        turn: game.turn,
        production: [{ cityId, type, ...(target ? { target } : {}) }],
      }),
    ready: () => action("ready", { turn: game.turn }),
    unready: () => action("unready", { turn: game.turn }),
    start: () => action("start", {}),
    settings: (value) =>
      action(
        "settings",
        value && typeof value === "object" ? value : { turnSeconds: value },
      ),
    citizenSettings: (cityId, settings = {}) =>
      action("citizen-settings", { turn: game.turn, cityId, ...settings }),
    pause: (paused) => action("settings", { paused }),
    citySettings: (cityId, expansionTarget) =>
      action("city-settings", {
        turn: game.turn,
        cityId,
        expansionTarget,
      }),
    inviteSeat,
    claimNpc,
    checkpoint,
    transact: (data) => action("transactions", { turn: game.turn, ...data }),
    previewDeal: preview,
    saveGame: (name) =>
      perform(() =>
        api(`/matches/${session.matchId}/save`, { session, body: { name } }),
      ),
    loadGame: (id) =>
      perform(async () => {
        const data = await api("/saves/load", { body: { id } });
        adopt(data);
        return data.observation;
      }),
  };
}
