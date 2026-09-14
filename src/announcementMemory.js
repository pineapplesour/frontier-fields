// Per-browser memory of which match announcements (war declarations …) were
// already shown, so a reload, save/load or pause→resume never replays them.
//
// Record shape (per match): { ids: [announcementId…], baselineTurn }.
// A browser with no record adopts the current turn as its baseline: every
// announcement already present is treated as history and only announcements
// from that turn onward can ever be shown, so an old backlog is never
// replayed on a fresh device either.
const PREFIX = "fieldline-announcements-v1:";
const MAX_IDS = 64;

const memoryKey = (matchId) => `${PREFIX}${matchId}`;

export function readAnnouncementMemory(matchId, storage = globalThis.localStorage) {
  if (!matchId || !storage) return null;
  try {
    const raw = storage.getItem(memoryKey(matchId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.ids)) return null;
    return {
      ids: parsed.ids.filter((id) => typeof id === "string"),
      baselineTurn: Number.isFinite(Number(parsed.baselineTurn))
        ? Number(parsed.baselineTurn)
        : 0,
    };
  } catch {
    return null;
  }
}

export function writeAnnouncementMemory(matchId, memory, storage = globalThis.localStorage) {
  if (!matchId || !storage || !memory) return;
  try {
    storage.setItem(
      memoryKey(matchId),
      JSON.stringify({
        ids: memory.ids.slice(-MAX_IDS),
        baselineTurn: memory.baselineTurn,
      }),
    );
  } catch {
    // Storage may be unavailable (private mode, quota); showing nothing
    // twice within one page life is still guaranteed by the caller's state.
  }
}

/**
 * Decide which announcements are new for this browser.
 * Returns { show, memory } where `show` is the announcements to surface
 * (oldest first) and `memory` is the updated record to persist.
 */
export function unseenAnnouncements(announcements, memory, currentTurn) {
  const list = (announcements ?? []).filter((a) => a && typeof a.id === "string");
  const turn = Number.isFinite(Number(currentTurn)) ? Number(currentTurn) : 0;
  if (!memory) {
    // First contact with this match on this browser: everything present is
    // history; only announcements from this turn onward are new.
    return {
      show: [],
      memory: { ids: list.map((a) => a.id), baselineTurn: turn },
    };
  }
  const seen = new Set(memory.ids);
  const show = list.filter(
    (a) => !seen.has(a.id) && Number(a.turn ?? turn) >= memory.baselineTurn,
  );
  for (const a of list) seen.add(a.id);
  return {
    show,
    memory: { ids: [...seen].slice(-MAX_IDS), baselineTurn: memory.baselineTurn },
  };
}
