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

test("phone map picker reserves five 44px candidate targets before unit and city labels", () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({ id: `tile-${index}`, priority: -1, x: 185 + index * 9, y: 220 + index * 4, width: 44, height: 50 }));
  const labels = [...candidates,
    { id: "unit", priority: 0, x: 190, y: 223, width: 76, height: 50 },
    { id: "city", priority: 1, x: 190, y: 223, width: 100, height: 30 }];
  const result = layoutMapLabels(labels, 366, 666);
  assert.deepEqual(result.slice(0, 5).map((item) => item.id), candidates.map((item) => item.id));
  for (const [index, target] of result.entries()) {
    assert.ok(target.x >= target.width / 2 && target.x <= 366 - target.width / 2);
    assert.ok(target.y >= target.height / 2 && target.y <= 666 - target.height / 2);
    for (const other of result.slice(index + 1))
      assert.ok(Math.abs(target.x - other.x) >= (target.width + other.width) / 2 || Math.abs(target.y - other.y) >= (target.height + other.height) / 2, `${target.id} overlaps ${other.id}`);
  }
});
