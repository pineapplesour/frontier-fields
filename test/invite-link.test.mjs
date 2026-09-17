import test from "node:test";
import assert from "node:assert/strict";
import {
  inviteLinkFor,
  readJoinCode,
  withoutJoinCode,
} from "../src/inviteLink.js";

// 2026-09-18: a seat code can be handed over as a single URL so the guest does
// not have to paste a code into the lobby form.
test("invite link round-trips a seat code", () => {
  const link = inviteLinkFor("https://example.trycloudflare.com/", "AbC-123_xyz");
  assert.equal(link, "https://example.trycloudflare.com/#join=AbC-123_xyz");
  assert.equal(readJoinCode(link), "AbC-123_xyz");
  assert.equal(readJoinCode(`${link}&stale=1`), "AbC-123_xyz");
  assert.equal(
    withoutJoinCode(link),
    "https://example.trycloudflare.com/",
  );
});

test("join codes are read from the fragment or the query, never invented", () => {
  assert.equal(readJoinCode("https://x.test/?join=abcdefgh"), "abcdefgh");
  assert.equal(readJoinCode("https://x.test/#join=abcdefgh"), "abcdefgh");
  assert.equal(readJoinCode("https://x.test/#invite=abcdefgh"), "abcdefgh");
  assert.equal(readJoinCode("https://x.test/#%EC%B4%88%EB%8C%80=abcdefgh"), "abcdefgh");
  assert.equal(readJoinCode("https://x.test/"), null);
  assert.equal(readJoinCode("https://x.test/#join="), null);
  assert.equal(readJoinCode("https://x.test/#join=abc"), null);
  assert.equal(readJoinCode("https://x.test/#turn=4"), null);
  assert.equal(readJoinCode(""), null);
});

test("stripping a join code keeps unrelated parameters and the path", () => {
  assert.equal(
    withoutJoinCode("https://x.test/game?a=1&join=abcdefgh&b=2"),
    "https://x.test/game?a=1&b=2",
  );
  assert.equal(withoutJoinCode("https://x.test/?join=abcdefgh"), "https://x.test/");
  assert.equal(
    withoutJoinCode("https://x.test/#join=abcdefgh&turn=3"),
    "https://x.test/#turn=3",
  );
  assert.equal(withoutJoinCode("https://x.test/"), "https://x.test/");
});
