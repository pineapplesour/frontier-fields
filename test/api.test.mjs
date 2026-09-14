import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../server/http.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("HTTP seats, one-use invite, private orders, readiness, cutoff, and MCP observation", async (t) => {
  let clock = 100_000;
  const { app, close } = createApi({ now: () => clock });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    close();
    server.closeAllConnections();
    server.close();
  });
  const req = async (path, { token, body } = {}) => {
    const r = await fetch(`${url}/api${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  const { data: a, status } = await req("/matches", { body: { mode: "duel" } });
  assert.equal(status, 201);
  const path = `/matches/${a.matchId}`;
  assert.equal((await req(path)).status, 401);
  assert.equal((await req(path, { token: "wrong" })).status, 401);
  assert.equal(
    (await req("/join", { body: { code: "없는 코드" } })).status,
    404,
  );
  const { data: b } = await req("/join", { body: { code: a.inviteCode } });
  assert.equal(b.playerId, "p2");
  assert.equal(
    (await req("/join", { body: { code: a.inviteCode } })).status,
    404,
  );
  assert.equal(
    (await req(`${path}/start`, { token: b.token, body: {} })).status,
    403,
  );
  const started = await req(`${path}/start`, { token: a.token, body: {} });
  assert.equal(started.data.deadline, 160000);
  const paused = await req(`${path}/settings`, {
    token: a.token,
    body: { paused: true },
  });
  assert.equal(paused.data.paused, true);
  assert.equal(paused.data.deadline, null);
  assert.equal(
    (await req(`${path}/settings`, { token: b.token, body: { paused: false } }))
      .status,
    403,
  );
  assert.equal(
    (await req(`${path}/ready`, { token: a.token, body: { turn: 1 } })).status,
    409,
  );
  // Sequential matches have no ready to take back.
  const noUnready = await req(`${path}/unready`, { token: a.token, body: { turn: 1 } });
  assert.equal(noUnready.status, 409);
  assert.match(noUnready.data.error ?? JSON.stringify(noUnready.data), /교대 턴/);
  const resumed = await req(`${path}/settings`, {
    token: a.token,
    body: { paused: false },
  });
  assert.equal(resumed.data.deadline, 160000);
  const unit = a.observation.units.find((u) => u.type === "builder");
  assert.equal(
    (
      await req(`${path}/orders`, {
        token: b.token,
        body: { turn: 1, orders: [{ unitId: unit.id, action: "fortify" }] },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await req(`${path}/orders`, {
        token: a.token,
        body: { turn: 1, orders: [{ unitId: unit.id, action: "farm" }] },
      })
    ).status,
    200,
  );
  const enemyView = (await req(path, { token: b.token })).data;
  assert.ok(!enemyView.units.some((u) => u.id === unit.id));
  assert.equal(enemyView.economy.resources.niter, 3);
  const client = new Client({ name: "fieldline-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["tools/mcp.mjs"],
    cwd: process.cwd(),
    env: {
      FIELDLINE_URL: url,
      FIELDLINE_MATCH: a.matchId,
      FIELDLINE_TOKEN: a.token,
    },
  });
  await client.connect(transport);
  try {
    const toolList = await client.listTools();
    assert.equal(toolList.tools.length, 8);
    assert.ok(
      toolList.tools
        .find((t) => t.name === "game_orders")
        .inputSchema.properties.orders.items.properties.action.enum.includes(
          "fort",
        ),
    );
    const quote = JSON.parse(
      (
        await client.callTool({
          name: "game_deal_preview",
          arguments: { factionId: "p3", receive: { resources: { iron: 1 } } },
        })
      ).content[0].text,
    );
    assert.equal(quote.status, "insufficient");
    assert.equal(quote.additionalGold, 7);
    assert.equal(
      (await req(`${path}/deal-preview`, { body: { factionId: "p3" } })).status,
      401,
    );
    const observation = await client.callTool({
      name: "game_observe",
      arguments: {},
    });
    const m = JSON.parse(observation.content[0].text);
    assert.equal(m.playerId, "p1");
    assert.ok(
      m.units.every(
        (u) =>
          u.owner === "p1" ||
          m.tiles.some((t) => t.q === u.q && t.r === u.r && t.visible),
      ),
    );
    const traded = await client.callTool({
      name: "game_transaction",
      arguments: { turn: 1, action: "sell", resource: "iron", amount: 1 },
    });
    assert.equal(
      JSON.parse(traded.content[0].text).economy.gold,
      m.economy.gold + 7,
    );
    const readyResult = await client.callTool({
      name: "game_ready",
      arguments: { turn: 1 },
    });
    assert.equal(JSON.parse(readyResult.content[0].text).activePlayer, "p2");
  } finally {
    await client.close();
  }
  const second = await req(`${path}/ready`, {
    token: b.token,
    body: { turn: 1 },
  });
  assert.equal(second.data.turn, 2);
  const firstView = (await req(path, { token: a.token })).data;
  assert.equal(firstView.units.find((u) => u.id === unit.id).charges, 2);
  clock = firstView.deadline;
  const late = await req(`${path}/orders`, {
    token: a.token,
    body: { turn: 2, orders: [{ unitId: unit.id, action: "fortify" }] },
  });
  assert.equal(late.status, 409);
  assert.equal((await req(path, { token: a.token })).data.activePlayer, "p2");
});
