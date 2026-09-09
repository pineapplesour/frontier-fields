import {
  FACTIONS,
  MAX_CIVILIZATIONS,
  factionsFor,
} from "../shared/rules.js";

const ID = /^p[1-8]$/;
const CONTROLLERS = new Set(["human", "agent", "npc"]);

const direct = (controller, npc = false) => controller !== "npc" && !npc;

/**
 * Normalize a lobby seat declaration without creating credentials.  A seat
 * is a civilization controller, not a token: credentials are issued by the
 * HTTP layer only after a seat-scoped invite is redeemed.
 */
export function normalizeSeats(input, { expansion = false } = {}) {
  const requested = Array.isArray(input) ? input : null;
  const defaults = expansion
    ? [
        { id: "p1", controller: "human", role: "host" },
        { id: "p2", controller: "human" },
        { id: "p3", controller: "npc" },
        { id: "p4", controller: "npc" },
      ]
    : [
        { id: "p1", controller: "human", role: "host" },
        { id: "p2", controller: "agent" },
        { id: "p3", controller: "npc" },
        { id: "p4", controller: "npc" },
      ];
  const source = requested?.length ? requested : defaults;
  if (source.length > MAX_CIVILIZATIONS)
    throw new Error(`문명은 최대 ${MAX_CIVILIZATIONS}개까지 참가할 수 있어요.`);
  const seats = source.map((raw, index) => {
    const id = raw?.id ?? `p${index + 1}`;
    if (!ID.test(id)) throw new Error("문명 좌석 ID는 p1~p8 형식이어야 해요.");
    const controller = raw?.controller ?? (index < 2 ? "human" : "npc");
    if (!CONTROLLERS.has(controller))
      throw new Error("문명 조종 방식은 human, agent 또는 npc여야 해요.");
    return {
      id,
      controller,
      role: id === "p1" ? "host" : "player",
      name: typeof raw?.name === "string" ? raw.name.trim().slice(0, 40) : null,
      connected: id === "p1" || controller === "npc",
      ready: false,
      claimable: false,
    };
  });
  if (!seats.some((s) => s.id === "p1"))
    throw new Error("p1 방장 좌석이 필요해요.");
  const ids = new Set();
  for (const seat of seats) {
    if (ids.has(seat.id)) throw new Error("중복된 문명 좌석이에요.");
    ids.add(seat.id);
  }
  // p1 is the only host and is always a human seat.  The agent seat remains
  // a direct controller; it is deliberately never rewritten as a rule NPC.
  const host = seats.find((s) => s.id === "p1");
  if (host.controller !== "human")
    throw new Error("p1 방장 좌석은 human이어야 해요.");
  return seats;
}

export function publicSeats(players = {}) {
  return Object.entries(players).map(([id, seat]) => ({
    id: seat.id ?? id,
    controller:
      seat.controller ?? (seat.npc ? "npc" : id === "p2" ? "agent" : "human"),
    role: seat.role,
    name: seat.name ?? null,
    connected: !!seat.connected,
    ready: !!seat.ready,
    claimable: !!seat.claimable,
  }));
}

export function seatFactions(seats, definitions = {}) {
  const ids = [...seats.map((seat) => seat.id), "cs", "barb"];
  return factionsFor(ids, {
    ...definitions,
    ...Object.fromEntries(
      seats.map((seat) => [
        seat.id,
        {
          ...(definitions[seat.id] ?? {}),
          ...(seat.name ? { name: seat.name } : {}),
          kind: "player",
        },
      ]),
    ),
    cs: FACTIONS.cs,
    barb: FACTIONS.barb,
  });
}

export function directSeatIds(players = {}) {
  return Object.entries(players)
    .filter(([, seat]) => direct(seat.controller, seat.npc))
    .map(([id, seat]) => seat.id ?? id);
}

export function npcSeatIds(players = {}) {
  return Object.entries(players)
    .filter(([, seat]) => seat.controller === "npc" || seat.npc === true)
    .map(([id, seat]) => seat.id ?? id);
}

export function isDirectSeat(players, id) {
  return !!players?.[id] && direct(players[id].controller, players[id].npc);
}
