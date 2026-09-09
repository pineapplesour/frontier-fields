#!/usr/bin/env node
// A transport-only client. No files, remembered positions, solver or game-playing code.
import { request } from "./client.mjs";
const [command = "help", ...args] = process.argv.slice(2);
const base = process.env.FIELDLINE_URL ?? "http://127.0.0.1:4318";
const match = process.env.FIELDLINE_MATCH;
const token = process.env.FIELDLINE_TOKEN;
try {
  let result;
  if (command === "help")
    result = {
      usage: [
        "game create <JSON: {mode, rulesVersion:'expansion-v1', seats:[{id,controller}]}>",
        "game join <invitation-code>",
        "game observe",
        "game invite <seat-id> (host only; returns that seat's code)",
        "game claim <seat-id> (host only; former NPC civilization)",
        "game city-settings <JSON: {turn, cityId, expansionTarget|null}>",
        "game citizen-settings <JSON: {turn, cityId, auto, lockedSlots, priority}>",
        "game settings <JSON: {turnSeconds?, paused?, supplyMode:'off'|'on', upgradeRules?:true}> (host; supply/rules changes while paused)",
        "game checkpoint (host only; private rolling-update checkpoint)",
        "game orders <JSON: {turn, orders, production}>",
        "game transaction <JSON: {turn, action, ...}; includes city-tile reassignment and supply-ON mobilizeUnit/cancelMobilization; guarantees are public guarantor→protected edges (issue/withdraw own-turn; accept/reject your defensive call off-turn)>",
        "game preview <JSON: {factionId, give, receive, alliance, peace}>",
        "game ready <turn>",
        "game wait <revision>",
      ],
      environment: [
        "FIELDLINE_URL (default http://127.0.0.1:4318)",
        "FIELDLINE_MATCH",
        "FIELDLINE_TOKEN",
      ],
      fairPlay:
        "Transport only. Never use files, histories, simulations, hidden-state inspection, or strategy code during a match. Normal conversational context may retain earlier observations.",
    };
  else if (command === "join")
    result = await request(base, "/join", {
      method: "POST",
      body: { code: args[0] },
    });
  else if (command === "create")
    result = await request(base, "/matches", {
      method: "POST",
      body: JSON.parse(args.join(" ")),
    });
  else {
    if (!match || !token)
      throw new Error("FIELDLINE_MATCH와 FIELDLINE_TOKEN이 필요해요.");
    const route = `/matches/${encodeURIComponent(match)}`;
    if (command === "observe") result = await request(base, route, { token });
    else if (command === "invite")
      result = await request(base, `${route}/invites`, {
        token,
        method: "POST",
        body: { seatId: args[0] },
      });
    else if (command === "claim")
      result = await request(base, `${route}/claim-npc`, {
        token,
        method: "POST",
        body: { seatId: args[0] },
      });
    else if (command === "city-settings")
      result = await request(base, `${route}/city-settings`, {
        token,
        method: "POST",
        body: JSON.parse(args.join(" ")),
      });
    else if (command === "citizen-settings")
      result = await request(base, `${route}/citizen-settings`, {
        token,
        method: "POST",
        body: JSON.parse(args.join(" ")),
      });
    else if (command === "settings")
      result = await request(base, `${route}/settings`, {
        token,
        method: "POST",
        body: JSON.parse(args.join(" ")),
      });
    else if (command === "checkpoint")
      result = await request(base, `${route}/runtime-checkpoint`, {
        token,
        method: "POST",
        body: {},
      });
    else if (command === "orders")
      result = await request(base, `${route}/orders`, {
        token,
        method: "POST",
        body: JSON.parse(args.join(" ")),
      });
    else if (command === "transaction")
      result = await request(base, `${route}/transactions`, {
        token,
        method: "POST",
        body: JSON.parse(args.join(" ")),
      });
    else if (command === "preview")
      result = await request(base, `${route}/deal-preview`, {
        token,
        method: "POST",
        body: JSON.parse(args.join(" ")),
      });
    else if (command === "ready")
      result = await request(base, `${route}/ready`, {
        token,
        method: "POST",
        body: { turn: Number(args[0]) },
      });
    else if (command === "wait")
      result = await request(
        base,
        `${route}/wait?revision=${Number(args[0])}`,
        { token },
      );
    else
      throw new Error("지원하지 않는 명령이에요. game help를 확인해 주세요.");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
