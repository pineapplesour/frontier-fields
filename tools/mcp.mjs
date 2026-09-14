#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { request } from "./client.mjs";
const base = process.env.FIELDLINE_URL ?? "http://127.0.0.1:4318";
let match = process.env.FIELDLINE_MATCH;
let credential = process.env.FIELDLINE_TOKEN;
let expansionMode =
  process.env.FIELDLINE_EXPANSION_MCP === "1" || !match || !credential;
if (match && credential)
  try {
    const probe = await request(base, `/matches/${encodeURIComponent(match)}`, {
      token: credential,
    });
    expansionMode = probe.rulesVersion === "expansion-v1";
  } catch {}
const server = new Server(
  { name: "fieldline", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
const tools = [
  ...(expansionMode
    ? [
        {
          name: "game_create",
          description:
            "Create a new expansion-v1 game with up to eight seats. Human and agent seats are direct controllers; npc seats use bounded observation-only rules. Returns only your scoped observation, never other seat tokens or private start coordinates.",
          inputSchema: {
            type: "object",
            properties: {
              mode: { enum: ["practice", "duel"] },
              rulesVersion: { const: "expansion-v1" },
              seats: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", pattern: "^p[1-8]$" },
                    controller: { enum: ["human", "agent", "npc"] },
                    name: { type: "string", maxLength: 40 },
                  },
                  required: ["id", "controller"],
                  additionalProperties: false,
                },
              },
            },
            required: ["seats"],
            additionalProperties: false,
          },
        },
        {
          name: "game_invite",
          description:
            "Host-only: issue one seat-scoped invitation code. The response contains only that code, never any seat token.",
          inputSchema: {
            type: "object",
            properties: { seatId: { type: "string", pattern: "^p[1-8]$" } },
            required: ["seatId"],
            additionalProperties: false,
          },
        },
        {
          name: "game_claim_npc",
          description:
            "Host-only: transfer controller metadata for a former NPC civilization to a future human invite. Cities, units, ownership and history stay unchanged.",
          inputSchema: {
            type: "object",
            properties: { seatId: { type: "string", pattern: "^p[1-8]$" } },
            required: ["seatId"],
            additionalProperties: false,
          },
        },
        {
          name: "game_city_settings",
          description:
            "Choose an eligible adjacent frontier tile for the next half-population territory expansion, or null for deterministic automatic fallback. Expansion stops at radius three.",
          inputSchema: {
            type: "object",
            properties: {
              turn: { type: "integer" },
              cityId: { type: "string" },
              expansionTarget: {
                anyOf: [
                  {
                    type: "object",
                    properties: { q: { type: "integer" }, r: { type: "integer" } },
                    required: ["q", "r"],
                    additionalProperties: false,
                  },
                  { type: "null" },
                ],
              },
            },
            required: ["turn", "cityId", "expansionTarget"],
            additionalProperties: false,
          },
        },
        {
          name: "game_citizen_settings",
          description:
            "Set whole-citizen worker locks and priorities for existing farm/resource/trading-post/worksite slots. Allocation is bounded by current civilian population and never creates facilities.",
          inputSchema: {
            type: "object",
            properties: {
              turn: { type: "integer" },
              cityId: { type: "string" },
              auto: { type: "boolean" },
              lockedSlots: { type: "array", items: { type: "string" }, maxItems: 40 },
              priority: { type: "array", items: { type: "string" }, maxItems: 40 },
            },
            required: ["turn", "cityId"],
            additionalProperties: false,
          },
        },
        {
          name: "game_runtime_checkpoint",
          description:
            "Host-only: atomically checkpoint the private runtime registry for a rolling local-dev restart. Returns metadata only; no world or hidden state is returned.",
          inputSchema: { type: "object", additionalProperties: false },
        },
        {
          name: "game_settings",
          description:
            "Host-only match settings. Detailed supply mode is off by default and can change atomically only while the match is paused; off uses surplus growth and on enables city/unit food stock plus mobilization.",
          inputSchema: {
            type: "object",
            properties: {
              turnSeconds: { type: "integer", minimum: 10, maximum: 300 },
              paused: { type: "boolean" },
              supplyMode: { enum: ["off", "on"] },
              upgradeRules: { type: "boolean", description: "Paused host opt-in: update this existing match's rules while preserving cities, units, ownership and controllers." },
            },
            additionalProperties: false,
          },
        },
      ]
    : []),
  {
    name: "game_join",
    description:
      "Join one game with the human’s invitation. Keeps only the session credential in process memory; no strategy notes.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "game_observe",
    description:
      "Get your scoped 20x20 cylindrical world (east/west wrap), explored geography, own routes, resources, diplomacy, pause state and in-game last-seen contacts. Unknown tiles expose no terrain. Contacts are old sightings, never current hidden enemy state. No notes or strategy scripts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "game_orders",
    description:
      "Execute chosen actions immediately, not a solver. Movement spends movesLeft and remaining routes persist across turns. Attack once per turn and exhaust movement; adjacent attack remains possible at zero movement if unused. Builder construction spends all movement and one charge. Produce a settler (40 production) to found a city: found consumes that settler on an unowned or own plains tile at least 4 hexes from other cities, with movement remaining. A civilian and own military escort may share a tile. Optional path is an explicit adjacent route. Never write strategy scripts or notes.",
    inputSchema: {
      type: "object",
      properties: {
        turn: { type: "integer" },
        orders: {
          type: "array",
          items: {
            type: "object",
            properties: {
              unitId: { type: "string" },
              cityId: { type: "string" },
              action: {
                type: "string",
                enum: [
                  "move",
                  "attack",
                  "bombard",
                  "farm",
                  "develop",
                  "chop",
                  "harvest",
                  "pillage",
                  "scorch",
                  "repair",
                  "repairStructure",
                  "fort",
                  "found",
                  "fortify",
                  "merge",
                  "cancel",
                  "cityBombard",
                ],
              },
              target: {
                type: "object",
                properties: { q: { type: "integer" }, r: { type: "integer" } },
                required: ["q", "r"],
                additionalProperties: false,
              },
              retreat: {
                type: "object",
                properties: { q: { type: "integer" }, r: { type: "integer" } },
                required: ["q", "r"],
                additionalProperties: false,
              },
              targetId: { type: "string" },
              path: {
                type: "array",
                maxItems: 400,
                items: {
                  type: "object",
                  properties: {
                    q: { type: "integer" },
                    r: { type: "integer" },
                  },
                  required: ["q", "r"],
                  additionalProperties: false,
                },
              },
            },
            required: ["action"],
            oneOf: [{ required: ["unitId"] }, { required: ["cityId"] }],
            additionalProperties: false,
          },
        },
        production: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cityId: { type: "string" },
              type: {
                enum: [
                  "spearman",
                  "musketeer",
                  "cavalry",
                  "artillery",
                  "builder",
                  "settler",
                  "walls",
                  "wallRepair",
                  "tradingPost",
                  "encampment",
                  "merchant",
                  null,
                ],
              },
              target: {
                type: "object",
                description: "Off-center owned city tile for encampment construction or targeted wall repair.",
                properties: { q: { type: "integer" }, r: { type: "integer" } },
                required: ["q", "r"], additionalProperties: false,
              },
            },
            required: ["cityId", "type"],
            additionalProperties: false,
          },
        },
      },
      required: ["turn"],
      additionalProperties: false,
    },
  },
  {
    name: "game_transaction",
    description:
      "Choose a market trade, unit purchase/disband, city-tile reassignment, sequential supply-ON mobilization/cancellation, tile purchase, diplomacy action or peace proposal. Supply-ON mobilization reserves no population or resources until one legal unit dispatches on that city's own turn (maximum one per city turn); pending citizens keep working. Disband returns only tracked surviving manpower, while war death and sale never refund it. Prices/resources and city worker slots are authoritative in observation; peace to a human requires acceptance. A guarantee is a public guarantor→protected edge; issuing/withdrawing is own-turn, while the guarantor may accept/reject a defensive call off-turn.",
    inputSchema: {
      type: "object",
      properties: {
        turn: { type: "integer" },
        action: {
          enum: [
            "buy",
            "sell",
            "sellUnit",
            "buyTile",
            "reassignTile",
            "assignTile",
            "peace",
            "acceptPeace",
            "rejectPeace",
            "cancelPeace",
            "declareWar",
            "denounce",
            "alliance",
            "breakAlliance",
            "gift",
            "buyUnit",
            "mobilizeUnit",
            "queueMobilization",
            "cancelMobilization",
            "disbandUnit",
            "offerTrade",
            "acceptProposal",
            "rejectProposal",
            "cancelProposal",
            "offerDeal",
            "guarantee",
            "withdrawGuarantee",
            "acceptGuarantee",
            "rejectGuarantee",
                  "setFoodReserve", "setUnitReserve",
            "shipFood",
            "shipFoodToUnit",
            "shipResource",
            "autoSupply",
            "queueMerchant",
            "merchantRoute",
            "interceptCargo",
            "returnCargo",
          ],
        },
        resource: { enum: ["food", "iron", "horses", "niter"] },
        type: {
          enum: [
            "spearman",
            "musketeer",
            "cavalry",
            "artillery",
            "builder",
            "settler",
            "merchant",
          ],
        },
        amount: { type: "number", exclusiveMinimum: 0, maximum: 100000 },
        targetReserve: { type: "number", minimum: 0 },
        fromCityId: { type: "string" },
        toUnitId: { type: "string" },
        merchantId: { type: "string" },
        shipmentId: { type: "string" },
        recipient: { type: "string" },
        kind: { enum: ["food", "resource"] },
        cityId: { type: "string" },
        unitId: { type: "string" },
        retainVeteranCount: { type: "integer", minimum: 0, maximum: 3 },
        mobilizationId: { type: "string" },
        queueId: { type: "string" },
        toCityId: { type: "string" },
        target: {
          type: "object",
          properties: { q: { type: "integer" }, r: { type: "integer" } },
          required: ["q", "r"],
          additionalProperties: false,
        },
        factionId: { type: "string" },
        protectedId: {
          type: "string",
          description: "Alias for the civilization/city-state being guaranteed.",
        },
        gold: { type: "integer", minimum: 0 },
        proposalId: { type: "string" },
        callId: {
          type: "string",
          description: "Your scoped defensive guarantee-call ID.",
        },
        guaranteeCallId: {
          type: "string",
          description: "Alias for your scoped defensive guarantee-call ID.",
        },
        alliance: { type: "boolean" },
        peace: { type: "boolean" },
        give: {
          type: "object",
          description:
            "Items offered by you: gold (integer), resources {iron,horses,niter}, units [observed owned IDs], cities [owned IDs], warAgainst (faction ID or null). Gold/resources escrow until acceptance; capital transfers can decide victory.",
        },
        receive: {
          type: "object",
          description:
            "Items requested from partner, same structure as give. Only currently observed partner city/unit IDs may be requested. No hidden inventory disclosure. Human consent required; war participation executes and broadcasts only on acceptance.",
        },
      },
      required: ["turn", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "game_deal_preview",
    description:
      "Read-only negotiation quote, identical to the UI. Returns NPC acceptance and required additional gold, or human-consent-required. Does not spend resources or expose private inventories.",
    inputSchema: {
      type: "object",
      properties: {
        factionId: { type: "string" },
        give: { type: "object" },
        receive: { type: "object" },
        alliance: { type: "boolean" },
        peace: { type: "boolean" },
      },
      required: ["factionId"],
      additionalProperties: false,
    },
  },
  {
    name: "game_ready",
    description:
      "Finish your active turn now: settle your cities then hand off to the opponent. Only activePlayer can act. Default 60 seconds per player, configurable globally. At your next turn, movement/attack refill and your remaining routes advance. Already executed actions cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { turn: { type: "integer" } },
      required: ["turn"],
      additionalProperties: false,
    },
  },
  {
    name: "game_unready",
    description:
      "Simultaneous mode only: cancel your ready state before the round settles (while other direct seats are still acting and the countdown has not ended). Afterwards orders and transactions are accepted again as normal.",
    inputSchema: {
      type: "object",
      properties: { turn: { type: "integer" } },
      required: ["turn"],
      additionalProperties: false,
    },
  },
  {
    name: "game_wait",
    description:
      "Wait at most 25 seconds for a new revision. Returns current player-scoped observation. No busy polling.",
    inputSchema: {
      type: "object",
      properties: { revision: { type: "integer" } },
      required: ["revision"],
      additionalProperties: false,
    },
  },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    let result;
    const a = params.arguments ?? {};
    if (params.name === "game_create") {
      if (credential)
        throw new Error("이미 경기에 참가했어요. 먼저 별도 세션을 사용해 주세요.");
      const created = await request(base, "/matches", {
        method: "POST",
        body: { ...a, rulesVersion: "expansion-v1" },
      });
      match = created.matchId;
      credential = created.token;
      result = created.observation;
    } else if (params.name === "game_join") {
      if (credential)
        throw new Error(
          "이미 경기에 참가했어요. 경기 중 좌석을 바꿀 수 없어요.",
        );
      const joined = await request(base, "/join", {
        method: "POST",
        body: { code: a.code },
      });
      match = joined.matchId;
      credential = joined.token;
      result = joined.observation;
    } else {
      if (!credential || !match)
        throw new Error("먼저 game_join으로 참가해 주세요.");
      const route = `/matches/${encodeURIComponent(match)}`;
      if (params.name === "game_observe")
        result = await request(base, route, { token: credential });
      else if (params.name === "game_invite")
        result = await request(base, `${route}/invites`, {
          token: credential,
          method: "POST",
          body: { seatId: a.seatId },
        });
      else if (params.name === "game_claim_npc")
        result = await request(base, `${route}/claim-npc`, {
          token: credential,
          method: "POST",
          body: { seatId: a.seatId },
        });
      else if (params.name === "game_city_settings")
        result = await request(base, `${route}/city-settings`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_citizen_settings")
        result = await request(base, `${route}/citizen-settings`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_runtime_checkpoint")
        result = await request(base, `${route}/runtime-checkpoint`, {
          token: credential,
          method: "POST",
          body: {},
        });
      else if (params.name === "game_settings")
        result = await request(base, `${route}/settings`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_orders")
        result = await request(base, `${route}/orders`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_transaction")
        result = await request(base, `${route}/transactions`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_deal_preview")
        result = await request(base, `${route}/deal-preview`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_ready")
        result = await request(base, `${route}/ready`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_unready")
        result = await request(base, `${route}/unready`, {
          token: credential,
          method: "POST",
          body: a,
        });
      else if (params.name === "game_wait")
        result = await request(
          base,
          `${route}/wait?revision=${Number(a.revision)}`,
          { token: credential },
        );
      else throw new Error("알 수 없는 도구예요.");
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
