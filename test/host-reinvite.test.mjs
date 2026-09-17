import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../server/http.mjs";

// 2026-09-18 user request: "방장 재초대도 되게" — the host seat can be
// re-invited so a host who lost the browser session (new tunnel origin, other
// device, cleared storage) recovers it with a short code instead of the raw
// token.  The invite is still minted only by an authenticated host, stays
// pending until redeemed, and redemption leaves exactly one live host session.
test("host seat re-invite hands the host session over exactly once", async (t) => {
  let clock = 200_000;
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

  const { data: host, status } = await req("/matches", {
    body: { mode: "duel" },
  });
  assert.equal(status, 201);
  const path = `/matches/${host.matchId}`;
  const { data: guest } = await req("/join", { body: { code: host.inviteCode } });
  assert.equal(guest.playerId, "p2");

  // Only the host mints invite codes.
  assert.equal(
    (
      await req(`${path}/invites`, {
        token: guest.token,
        body: { seatId: "p1" },
      })
    ).status,
    403,
  );
  // City-state and barbarian seats are never invite targets.
  for (const seatId of ["cs", "barb", "p9", "없는좌석"])
    assert.equal(
      (await req(`${path}/invites`, { token: host.token, body: { seatId } }))
        .status,
      400,
    );
  // A connected human seat is still protected against re-invite.
  assert.equal(
    (
      await req(`${path}/invites`, {
        token: host.token,
        body: { seatId: "p2" },
      })
    ).status,
    409,
  );

  const minted = await req(`${path}/invites`, {
    token: host.token,
    body: { seatId: "p1" },
  });
  assert.equal(minted.status, 200);
  assert.equal(minted.data.seatId, "p1");
  assert.equal(minted.data.host, true);
  assert.ok(minted.data.inviteCode);

  // Pending hand-off: the current host session keeps working.
  assert.equal((await req(path, { token: host.token })).status, 200);

  const handed = await req("/join", { body: { code: minted.data.inviteCode } });
  assert.equal(handed.status, 200);
  assert.equal(handed.data.playerId, "p1");
  assert.equal(handed.data.matchId, host.matchId);
  assert.notEqual(handed.data.token, host.token);
  // One use only.
  assert.equal(
    (await req("/join", { body: { code: minted.data.inviteCode } })).status,
    404,
  );
  // Exactly one live host: the old token is revoked, the new one is the host.
  assert.equal((await req(path, { token: host.token })).status, 401);
  assert.equal((await req(path, { token: handed.data.token })).status, 200);
  assert.equal(
    (await req(`${path}/start`, { token: handed.data.token, body: {} })).status,
    200,
  );
  assert.equal(
    (
      await req(`${path}/settings`, {
        token: handed.data.token,
        body: { paused: true },
      })
    ).data.paused,
    true,
  );
  // The recovered host can also mint the next host re-invite, while a guest
  // still cannot.
  assert.equal(
    (
      await req(`${path}/invites`, {
        token: handed.data.token,
        body: { seatId: "p1" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await req(`${path}/invites`, {
        token: guest.token,
        body: { seatId: "p1" },
      })
    ).status,
    403,
  );
});
