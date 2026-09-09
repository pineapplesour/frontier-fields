import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { GameError, restoreGame } from "./engine.mjs";

// Opaque capabilities only. Never return serialized worlds or random state to a player.
export function saveStore(directory) {
  return {
    async save(game, name, now) {
      if (!directory)
        throw new GameError("이 서버에서는 저장을 지원하지 않아요.");
      if (typeof name !== "string" || !name.trim() || name.length > 40)
        throw new GameError("저장 이름은 1~40자로 입력해 주세요.");
      const id = randomBytes(24).toString("hex");
      const snapshot = JSON.parse(JSON.stringify(game));
      snapshot.pausedRemaining = game.paused
        ? game.pausedRemaining
        : Math.max(0, (game.deadline ?? now + game.turnSeconds * 1000) - now);
      const metadata = {
        id,
        name: name.trim(),
        turn: game.turn,
        mode: game.mode,
        savedAt: now,
      };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(directory, `${id}.json`),
        JSON.stringify({ version: 1, metadata, game: snapshot }),
        { flag: "wx", mode: 0o600 },
      );
      return metadata;
    },
    async load(id, now) {
      if (!directory || !/^[a-f0-9]{48}$/.test(id ?? ""))
        throw new GameError("저장본을 찾을 수 없어요.", 404);
      let data;
      try {
        data = JSON.parse(
          await readFile(path.join(directory, `${id}.json`), "utf8"),
        );
      } catch {
        throw new GameError("저장본을 읽을 수 없어요.", 404);
      }
      if (data.version !== 1)
        throw new GameError("호환되지 않는 저장 버전이에요.");
      return restoreGame(data.game, now);
    },
  };
}
