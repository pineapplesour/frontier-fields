import express from "express";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { saveStore } from "./saves.mjs";
import {
  createGame,
  observe,
  submitOrders,
  ready,
  advanceDue,
  startGame,
  GameError,
  setSettings,
  setCitySettings,
  setCitizenSettings,
  claimNpcSeat,
  transact,
  previewDeal,
  restoreRuntimeGame,
} from "./engine.mjs";
import {
  readRuntimeCheckpointSync,
  restoreRuntimeEntries,
  writeRuntimeCheckpoint,
} from "./runtimeCheckpoint.mjs";
import { directSeatIds, normalizeSeats } from "./lobby.mjs";

const token = () => randomBytes(24).toString("base64url");
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createApi({
  now = Date.now,
  saveDirectory,
  runtimeCheckpointDirectory,
  resumeRuntime = false,
  allowedOrigins = [],
} = {}) {
  const app = express();
  const saves = saveStore(saveDirectory);
  const matches = new Map();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.headers.origin) {
      try {
        const requestOrigin = new URL(req.headers.origin).origin;
        const sameHost = new URL(req.headers.origin).host === req.headers.host;
        const explicitlyAllowed = allowedOrigins.includes(requestOrigin);
        if (!sameHost && !explicitlyAllowed)
          return res
            .status(403)
            .json({ error: "다른 사이트에서 보낸 요청은 허용하지 않아요." });
        if (explicitlyAllowed) {
          res.set("Access-Control-Allow-Origin", requestOrigin);
          res.set("Vary", "Origin");
          res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
          res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        }
      } catch {
        return res.status(403).json({ error: "요청 출처를 확인해 주세요." });
      }
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  if (resumeRuntime && runtimeCheckpointDirectory) {
    const checkpoint = readRuntimeCheckpointSync(runtimeCheckpointDirectory);
    if (checkpoint)
      for (const entry of restoreRuntimeEntries(
        checkpoint,
        (snapshot, checkpointedAt) =>
          restoreRuntimeGame(snapshot, checkpointedAt, now()),
      ))
        matches.set(entry.matchId, entry);
  }
  function sweep() {
    for (const [id, m] of matches) {
      advanceDue(m.game, now());
      if (now() - m.touched > 12 * 3600_000) matches.delete(id);
    }
  }
  const ticker = setInterval(sweep, 250);
  ticker.unref();
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, name: "FIELDLINE", version: "0.1.0" }),
  );
  app.post("/api/matches", (req, res) => {
    if (matches.size >= 150)
      return res.status(429).json({
        error: "열린 경기가 너무 많아요. 잠시 후 다시 시도해 주세요.",
      });
    const mode = req.body?.mode === "duel" ? "duel" : "practice";
    // An experiment practice uses the current expansion rules with the host
    // alone against rule civilizations, so balance tests match real duels.
    const experiment = req.body?.experiment === true && mode === "practice";
    const rulesVersion =
      experiment ||
      req.body?.rulesVersion === "expansion-v1" ||
      req.body?.setup === "expansion" ||
      Array.isArray(req.body?.seats)
        ? "expansion-v1"
        : "legacy";
    let seats = null;
    if (rulesVersion === "expansion-v1")
      try {
        seats = normalizeSeats(
          experiment && !Array.isArray(req.body?.seats)
            ? [
                { id: "p1", controller: "human", name: "실험 방장" },
                { id: "p2", controller: "npc", name: "규칙 문명 1" },
                { id: "p3", controller: "npc", name: "규칙 문명 2" },
              ]
            : req.body?.seats,
          { expansion: true },
        );
      } catch (error) {
        throw new GameError(error.message);
      }
    const id = randomBytes(6).toString("hex");
    const secret = token();
    const game = createGame({
      mode,
      seed: randomInt(2 ** 31),
      now: now(),
      rulesVersion,
      seats,
      factionDefinitions: req.body?.factionDefinitions,
      experiment: req.body?.experiment === true,
      turnMode: req.body?.turnMode === "simultaneous" ? "simultaneous" : "sequential",
    });
    const seatIds = directSeatIds(game.players);
    const invites = Object.fromEntries(
      seatIds
        .filter((p) => p !== "p1")
        .map((p) => [p, randomBytes(9).toString("base64url")]),
    );
    const entry = {
      game,
      tokens: Object.fromEntries(
        Object.keys(game.players).map((p) => [p, p === "p1" ? secret : null]),
      ),
      invites: mode === "duel" || rulesVersion === "expansion-v1" ? invites : {},
      touched: now(),
    };
    // Legacy practice keeps its existing immediate p2 seat and no lobby;
    // future setups always expose an explicit lobby with seat-scoped invites.
    if (rulesVersion === "expansion-v1") entry.game.phase = "lobby";
    // Experiment practices have no other direct seats: start at once.
    if (experiment && entry.game.experiment) startGame(entry.game, now());
    entry.invite = entry.invites.p2 ?? null;
    matches.set(id, entry);
    const inviteCodes =
      rulesVersion === "expansion-v1"
        ? { ...entry.invites }
        : entry.invite
          ? { p2: entry.invite }
          : {};
    res.status(201).json({
      matchId: id,
      playerId: "p1",
      token: secret,
      inviteCode: entry.invite,
      inviteCodes,
      observation: observe(entry.game, "p1", now()),
    });
  });
  app.post("/api/join", (req, res) => {
    const code = req.body?.code;
    const found = [...matches.entries()].flatMap(([id, m]) =>
      Object.entries(m.invites ?? {}).map(([seatId, invite]) => ({
        id,
        m,
        seatId,
        invite,
      })),
    ).find((x) => same(x.invite, code));
    if (!found)
      return res
        .status(404)
        .json({ error: "유효하지 않거나 이미 사용한 초대 코드예요." });
    const { id, m, seatId } = found;
    const secret = token();
    m.tokens[seatId] = secret;
    delete m.invites[seatId];
    if (m.invite === found.invite) m.invite = null;
    m.game.players[seatId].connected = true;
    if (
      m.game.players[seatId].controller === "npc" ||
      m.game.players[seatId].npc === true
    ) {
      // A claimed NPC stops making decisions at the exact moment its human
      // invite is redeemed; ownership and all historical state stay intact.
      m.game.players[seatId].controller = "human";
      m.game.players[seatId].npc = false;
    }
    m.game.revision++;
    m.touched = now();
    res.json({
      matchId: id,
      playerId: seatId,
      token: secret,
      inviteCode: null,
      observation: observe(m.game, seatId, now()),
    });
  });
  app.post("/api/saves/load", async (req, res) => {
    if (matches.size >= 150)
      throw new GameError("열린 경기가 너무 많아요.", 429);
    const game = await saves.load(req.body?.id, now());
    const id = randomBytes(6).toString("hex"),
      secret = token();
    const seatIds = directSeatIds(game.players),
      invites = Object.fromEntries(
        seatIds
          .filter((p) => p !== "p1")
          .map((p) => [p, randomBytes(9).toString("base64url")]),
      );
    const entry = {
      game,
      tokens: Object.fromEntries(
        Object.keys(game.players).map((p) => [p, p === "p1" ? secret : null]),
      ),
      invites,
      invite: invites.p2 ?? null,
      touched: now(),
    };
    matches.set(id, entry);
    res.json({
      matchId: id,
      playerId: "p1",
      token: secret,
      inviteCode: entry.invite,
      inviteCodes: { ...invites },
      observation: observe(game, "p1", now()),
    });
  });
  const authenticated = (req, res, next) => {
    const m = matches.get(req.params.id);
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const player =
      m &&
      Object.keys(m.tokens).find(
        (p) => m.tokens[p] && same(m.tokens[p], bearer),
      );
    if (!player)
      return res.status(401).json({ error: "경기 참가 권한이 필요해요." });
    m.touched = now();
    advanceDue(m.game, now());
    req.match = m;
    req.player = player;
    next();
  };
  app.get("/api/matches/:id", authenticated, (req, res) =>
    res.json(observe(req.match.game, req.player, now())),
  );
  app.post("/api/matches/:id/save", authenticated, async (req, res) => {
    if (req.player !== "p1")
      throw new GameError("사용자 방장만 저장할 수 있어요.", 403);
    res
      .status(201)
      .json(await saves.save(req.match.game, req.body?.name, now()));
  });
  app.post("/api/matches/:id/start", authenticated, (req, res) => {
    if (req.player !== "p1")
      throw new GameError("방장이 경기를 시작할 수 있어요.", 403);
    startGame(req.match.game, now());
    res.json(observe(req.match.game, req.player, now()));
  });
  app.post("/api/matches/:id/invites", authenticated, (req, res) => {
    if (req.player !== "p1")
      throw new GameError("방장만 참가 초대 코드를 만들 수 있어요.", 403);
    const seatId = req.body?.seatId,
      seat = req.match.game.players?.[seatId];
    if (!seat || seatId === "p1" || seatId === "cs" || seatId === "barb")
      throw new GameError("초대할 문명 좌석을 확인해 주세요.");
    const npcControlled = seat.controller === "npc" || seat.npc === true;
    if (seat.connected && !npcControlled)
      throw new GameError(
        "이미 참가한 사용자가 있는 좌석은 재초대할 수 없어요.",
        409,
      );
    const code = randomBytes(9).toString("base64url");
    req.match.invites ??= {};
    req.match.invites[seatId] = code;
    req.match.tokens[seatId] = null;
    seat.connected = false;
    req.match.game.revision++;
    res.json({ seatId, inviteCode: code });
  });
  app.post("/api/matches/:id/claim-npc", authenticated, (req, res) => {
    if (req.player !== "p1")
      throw new GameError("방장만 NPC 문명을 양도할 수 있어요.", 403);
    const result = claimNpcSeat(req.match.game, "p1", req.body?.seatId);
    req.match.invites ??= {};
    const code = randomBytes(9).toString("base64url");
    req.match.invites[result.seatId] = code;
    req.match.tokens[result.seatId] = null;
    res.json({ ...result, inviteCode: code });
  });
  app.post("/api/matches/:id/orders", authenticated, (req, res) =>
    res.json(submitOrders(req.match.game, req.player, req.body, now())),
  );
  app.post("/api/matches/:id/ready", authenticated, (req, res) =>
    res.json(ready(req.match.game, req.player, req.body.turn, now())),
  );
  app.post("/api/matches/:id/settings", authenticated, (req, res) =>
    res.json(setSettings(req.match.game, req.player, req.body, now())),
  );
  app.post("/api/matches/:id/city-settings", authenticated, (req, res) =>
    res.json(setCitySettings(req.match.game, req.player, req.body, now())),
  );
  app.post("/api/matches/:id/citizen-settings", authenticated, (req, res) =>
    res.json(setCitizenSettings(req.match.game, req.player, req.body, now())),
  );
  app.post("/api/matches/:id/transactions", authenticated, (req, res) =>
    res.json(transact(req.match.game, req.player, req.body, now())),
  );
  app.post("/api/matches/:id/deal-preview", authenticated, (req, res) =>
    res.json(previewDeal(req.match.game, req.player, req.body, now())),
  );
  app.post("/api/matches/:id/runtime-checkpoint", authenticated, async (req, res) => {
    if (req.player !== "p1")
      throw new GameError("방장만 런타임 체크포인트를 만들 수 있어요.", 403);
    if (!runtimeCheckpointDirectory)
      throw new GameError("이 서버에서는 런타임 체크포인트를 지원하지 않아요.");
    const metadata = await writeRuntimeCheckpoint(
      runtimeCheckpointDirectory,
      matches,
      now(),
    );
    res.status(201).json({ matchId: req.params.id, ...metadata });
  });
  app.get("/api/matches/:id/wait", authenticated, async (req, res) => {
    const revision = Number(req.query.revision);
    const started = now();
    while (
      req.match.game.revision === revision &&
      now() - started < 25_000 &&
      !res.destroyed
    ) {
      await new Promise((r) => setTimeout(r, 200));
      advanceDue(req.match.game, now());
    }
    if (!res.destroyed) res.json(observe(req.match.game, req.player, now()));
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "없는 게임 API예요." }),
  );
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status ?? 500).json({
      error:
        error instanceof GameError
          ? error.message
          : error.type === "entity.parse.failed"
            ? "JSON 형식을 확인해 주세요."
            : "요청을 처리하지 못했어요.",
    });
  });
  return {
    app,
    checkpointRuntime: () =>
      runtimeCheckpointDirectory
        ? writeRuntimeCheckpoint(runtimeCheckpointDirectory, matches, now())
        : Promise.reject(new GameError("이 서버에서는 런타임 체크포인트를 지원하지 않아요.")),
    close: () => clearInterval(ticker),
  };
}
