import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const RUNTIME_CHECKPOINT_VERSION = 1;
export const RUNTIME_CHECKPOINT_FILE = "fieldline-runtime-checkpoint.json";

const jsonGame = (game) => JSON.parse(JSON.stringify(game));

function payloadFor(matches, now) {
  const entries = [];
  for (const [matchId, match] of matches) {
    entries.push({
      matchId,
      game: jsonGame(match.game),
      // Tokens are capabilities, not player-visible game state.  The file is
      // private (0700/0600) and never mounted under the HTTP static root.
      tokens: { ...match.tokens },
      invites: { ...(match.invites ?? {}) },
      touched: match.touched,
    });
  }
  return {
    version: RUNTIME_CHECKPOINT_VERSION,
    checkpointedAt: now,
    matches: entries,
  };
}

function validatePayload(payload) {
  if (
    !payload ||
    payload.version !== RUNTIME_CHECKPOINT_VERSION ||
    !Number.isFinite(payload.checkpointedAt) ||
    !Array.isArray(payload.matches)
  )
    throw new Error("호환되지 않는 런타임 체크포인트예요.");
  const ids = new Set();
  for (const entry of payload.matches) {
    if (
      !entry ||
      typeof entry.matchId !== "string" ||
      ids.has(entry.matchId) ||
      !entry.game ||
      !entry.tokens ||
      typeof entry.tokens.p1 !== "string"
    )
      throw new Error("런타임 체크포인트 항목을 확인해 주세요.");
    ids.add(entry.matchId);
  }
  return payload;
}

/**
 * Write the live-match registry atomically.  This helper has no HTTP-facing
 * read path; callers receive metadata only.  A temporary sibling and rename
 * keep a process restart from observing a partially-written world.
 */
export async function writeRuntimeCheckpoint(directory, matches, now = Date.now()) {
  if (!directory) throw new Error("런타임 체크포인트 위치가 필요해요.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, RUNTIME_CHECKPOINT_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = payloadFor(matches, now);
  try {
    await writeFile(tmp, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(tmp);
    } catch {}
    throw error;
  }
  return {
    version: payload.version,
    checkpointedAt: payload.checkpointedAt,
    matchCount: payload.matches.length,
  };
}

export async function readRuntimeCheckpoint(directory) {
  if (!directory) return null;
  let raw;
  try {
    raw = await readFile(path.join(directory, RUNTIME_CHECKPOINT_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return validatePayload(JSON.parse(raw));
}

export function readRuntimeCheckpointSync(directory) {
  if (!directory) return null;
  let raw;
  try {
    raw = readFileSync(path.join(directory, RUNTIME_CHECKPOINT_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return validatePayload(JSON.parse(raw));
}

export function restoreRuntimeEntries(payload, restoreGame) {
  validatePayload(payload);
  if (typeof restoreGame !== "function") throw new TypeError("restoreGame 함수가 필요해요.");
  return payload.matches.map((entry) => ({
    matchId: entry.matchId,
    game: restoreGame(entry.game, payload.checkpointedAt),
    tokens: { ...entry.tokens },
    invites: { ...(entry.invites ?? {}) },
    touched: entry.touched ?? payload.checkpointedAt,
  }));
}
