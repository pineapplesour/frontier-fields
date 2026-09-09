import test from "node:test";
import assert from "node:assert/strict";
import { layoutMapLabels } from "../src/labelLayout.js";

test("crowded city and unit nameplates remain independently clickable without changing map anchors", () => {
  const labels = Array.from({length: 12}, (_, id) => ({ id, priority: id ? 1 : 0, x: 180 + id * 2, y: 180 + id, width: id ? 34 : 90, height: 28 }));
  const before = structuredClone(labels);
  const result = layoutMapLabels(labels, 390, 450);
  assert.deepEqual(labels, before);
  assert.deepEqual(result, layoutMapLabels(labels, 390, 450));
  for (let i = 0; i < result.length; i++) {
    const a = result[i];
    assert.ok(a.x >= a.width / 2 && a.x <= 390 - a.width / 2);
    for (const b of result.slice(i + 1)) assert.ok(Math.abs(a.x-b.x) >= (a.width+b.width)/2 || Math.abs(a.y-b.y) >= (a.height+b.height)/2, `${a.id} overlaps ${b.id}`);
  }
});
