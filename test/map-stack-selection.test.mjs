import test from "node:test";
import assert from "node:assert/strict";
import { mapSelectionChoices, resolveMapSelection } from "../src/selectionResolver.js";

test("stack chooser exposes civilian, military and city from observation, never remembered contacts", () => {
  const game = { playerId: "p1", units: [
    { id: "builder", type: "builder", owner: "p1", q: 2, r: 3 },
    { id: "guard", type: "spearman", owner: "p1", q: 2, r: 3 },
    { id: "elsewhere", owner: "p1", q: 9, r: 9 },
  ], cities: [{ id: "city", owner: "p1", q: 2, r: 3 }],
  contacts: [{ id: "old", q: 2, r: 3 }] };
  assert.deepEqual(mapSelectionChoices(game, { q: 2, r: 3 }).map(({ id }) => id), ["builder", "guard", "city"]);
  for (const id of ["builder", "guard"])
    assert.equal(resolveMapSelection(game, { id, q: 2, r: 3, source: "unitLabel" }).selection.id, id);
  assert.equal(resolveMapSelection(game, { id: "city", q: 2, r: 3, source: "cityLabel" }).selection.id, "city");
  assert.deepEqual(mapSelectionChoices(game, { q: 0, r: 0 }), []);
});
