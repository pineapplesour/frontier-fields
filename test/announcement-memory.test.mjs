import test from "node:test";
import assert from "node:assert/strict";
import {
  readAnnouncementMemory,
  unseenAnnouncements,
  writeAnnouncementMemory,
} from "../src/announcementMemory.js";

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
};
const war = (id, turn) => ({ id, type: "war", from: "p1", to: "p2", turn });

test("first load on a browser adopts the backlog as history", () => {
  const { show, memory } = unseenAnnouncements([war("a", 18), war("b", 40)], null, 47);
  assert.deepEqual(show, []);
  assert.deepEqual(memory, { ids: ["a", "b"], baselineTurn: 47 });
});

test("a new announcement after the baseline shows once, then is remembered", () => {
  const storage = memStorage();
  let memory = unseenAnnouncements([war("a", 18)], null, 20).memory;
  writeAnnouncementMemory("m1", memory, storage);
  memory = readAnnouncementMemory("m1", storage);
  const first = unseenAnnouncements([war("a", 18), war("c", 21)], memory, 21);
  assert.deepEqual(first.show.map((a) => a.id), ["c"]);
  writeAnnouncementMemory("m1", first.memory, storage);
  // Reload: same observation again must be silent.
  const reload = unseenAnnouncements(
    [war("a", 18), war("c", 21)],
    readAnnouncementMemory("m1", storage),
    21,
  );
  assert.deepEqual(reload.show, []);
});

test("an old announcement unseen on a fresh device never replays", () => {
  const memory = { ids: [], baselineTurn: 47 };
  const { show } = unseenAnnouncements([war("old", 18)], memory, 47);
  assert.deepEqual(show, []);
});

test("memory is per match and tolerates corrupt storage", () => {
  const storage = memStorage();
  storage.setItem("fieldline-announcements-v1:bad", "{not json");
  assert.equal(readAnnouncementMemory("bad", storage), null);
  writeAnnouncementMemory("m2", { ids: ["x"], baselineTurn: 3 }, storage);
  assert.equal(readAnnouncementMemory("m1", storage), null);
  assert.deepEqual(readAnnouncementMemory("m2", storage), { ids: ["x"], baselineTurn: 3 });
});
