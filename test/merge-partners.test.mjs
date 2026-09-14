import test from "node:test";
import assert from "node:assert/strict";
import { mergePartners, NO_MERGE_PARTNER_TIP } from "../src/formationHelpers.js";

const unit = (id, q, r, extra = {}) => ({
  id, q, r, owner: "p1", type: "spearman", size: 1, hp: 100, ...extra,
});
const game = (units) => ({ playerId: "p1", units });

test("adjacent same-type equal-tier own units are merge partners", () => {
  const me = unit("a", 0, 0);
  const g = game([
    me,
    unit("b", 1, 0),
    unit("c", 0, 1, { size: 2 }),          // brigade vs battalion: different tier
    unit("d", 2, 0),                        // not adjacent
    unit("e", -1, 0, { type: "musketeer" }), // other type
    unit("f", 0, -1, { owner: "p2" }),      // not ours
    unit("g", 1, -1, { hp: 0 }),            // dead
    unit("h", -1, 1, { type: "builder" }),  // civilian
  ]);
  assert.deepEqual(mergePartners(g, me).map((u) => u.id), ["b"]);
});

test("brigade+brigade pairs and no partner cases", () => {
  const me = unit("a", 0, 0, { size: 2 });
  assert.deepEqual(
    mergePartners(game([me, unit("b", 1, 0, { size: 2 }), unit("c", 0, 1)]), me).map((u) => u.id),
    ["b"],
  );
  assert.deepEqual(mergePartners(game([me]), me), []);
  // Legacy size-3 formations and civilians never offer the button.
  assert.deepEqual(mergePartners(game([unit("x", 0, 0, { size: 3 }), unit("y", 1, 0, { size: 3 })]), unit("x", 0, 0, { size: 3 })), []);
  assert.deepEqual(mergePartners(game([unit("s", 0, 0, { type: "settler" }), unit("t", 1, 0, { type: "settler" })]), unit("s", 0, 0, { type: "settler" })), []);
  assert.deepEqual(mergePartners(null, me), []);
  assert.equal(typeof NO_MERGE_PARTNER_TIP, "string");
});
