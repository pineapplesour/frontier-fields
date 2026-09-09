import test from "node:test";
import assert from "node:assert/strict";
import { readCamera, saveCamera } from "../src/cameraPreferences.js";

test("camera preferences retain position and zoom only, with bounded validation", () => {
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
  };
  saveCamera(
    { position: { toArray: () => [10, 20, 30] }, zoom: 1.6 },
    { target: { toArray: () => [2, 0, 3] } },
  );
  assert.deepEqual(readCamera(), {
    position: [10, 20, 30],
    target: [2, 0, 3],
    zoom: 1.6,
  });
  assert.deepEqual(Object.keys(readCamera()).sort(), [
    "position",
    "target",
    "zoom",
  ]);
  saveCamera(
    { position: { toArray: () => [10, 20, 30] }, zoom: 99 },
    { target: { toArray: () => [2, 0, 3] } },
  );
  assert.equal(readCamera(), null);
  delete globalThis.sessionStorage;
});
test("first sound awaits suspended audio context resume rather than dropping the cue", async () => {
  let notes = 0;
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  class Audio {
    state = "suspended";
    currentTime = 0;
    destination = {};
    async resume() {
      await Promise.resolve();
      this.state = "running";
    }
    createOscillator() {
      notes++;
      return {
        frequency: param,
        connect() {},
        start() {},
        stop() {},
        disconnect() {},
      };
    }
    createGain() {
      return { gain: param, connect() {}, disconnect() {} };
    }
  }
  globalThis.window = { AudioContext: Audio };
  const { playSound } = await import("../src/sound.js");
  await playSound("war", 0.2);
  assert.equal(notes, 3);
  await playSound("war", 0);
  assert.equal(notes, 3);
  delete globalThis.window;
});
