import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  observe,
  addUnit,
  submitOrders,
} from "../server/engine.mjs";
import { makeMotion, makeRoute, combatTiming } from "../src/motion3d.js";
import { neighbors, key } from "../shared/rules.js";
import {
  buildWorld,
  buildHighlights,
  disposeGroup,
  worldPoint,
  territoryBorderEdge,
} from "../src/world3d.js";

test("3D coordinates preserve equal spacing across all six hex neighbors", () => {
  const p = { q: 5, r: 2 };
  for (const n of neighbors(p))
    assert.ok(
      Math.abs(worldPoint(p).distanceTo(worldPoint(n)) - Math.sqrt(3)) < 1e-10,
    );
});

test("all six shared national borders keep their full thickness inside their own territory", () => {
  const tile={q:5,r:2,terrain:"plains"};
  neighbors(tile).forEach((neighbor, side) => {
    const center=worldPoint(tile), other=worldPoint(neighbor);
    const normal=other.clone().sub(center).normalize();
    const shared=center.clone().add(other).multiplyScalar(0.5);
    const left=territoryBorderEdge(tile,side);
    const right=territoryBorderEdge({...neighbor,terrain:"plains"},(side+3)%6);
    for(const p of [left.a,left.b]) assert.ok(p.clone().sub(shared).dot(normal)+left.width/2 < -0.007);
    for(const p of [right.a,right.b]) assert.ok(p.clone().sub(shared).dot(normal)-right.width/2 > 0.007);
  });
});
test("voxel scene batches blocks and hexes and contains only observed entity identifiers", () => {
  const g = createGame(),
    view = observe(g, "p1"),
    world = buildWorld(view);
  assert.equal(world.children.length, 3); // two instanced terrain/model batches + unlit ocean
  const allowed = new Set([...view.units, ...view.cities].map((x) => x.id));
  for (const mesh of world.children) {
    if (!mesh.isInstancedMesh) {
      assert.ok(mesh.material.isMeshBasicMaterial);
      continue;
    }
    assert.ok(mesh.isInstancedMesh);
    assert.ok(mesh.count > 0);
    assert.equal(mesh.userData.points.length, mesh.count);
    for (const point of mesh.userData.points)
      if (point?.id) assert.ok(allowed.has(point.id));
    assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
  }
  const unit = view.units[0];
  assert.ok(
    world.children.some((m) =>
      m.userData.points?.some((p) => p?.id === unit.id),
    ),
  );
  disposeGroup(world);
});
test("3D movement and selection overlays build from the same scoped observation", () => {
  const view = observe(createGame(), "p1"),
    u = view.units.find((x) => x.type === "cavalry");
  const highlights = buildHighlights(view, u, u, "move", key(u));
  assert.ok(highlights.children.length > 1);
  for (const object of highlights.children)
    assert.ok(object.position.toArray().every(Number.isFinite));
  disposeGroup(highlights);
});
test("casualty remains visible through projectile flight then collapses gradually; matrices remain finite", () => {
  const g = createGame();
  g.units = [];
  g.cities = [];
  g.rivers = [];
  g.wars = ["p1|p2"];
  for (const t of g.tiles) t.terrain = "plains";
  const a = addUnit(g, "p1", "artillery", { q: 2, r: 3 }),
    b = addUnit(g, "p2", "spearman", { q: 4, r: 3 }, { hp: 1 });
  submitOrders(g, "p1", {
    turn: 1,
    orders: [{ unitId: a.id, action: "bombard", target: { q: 4, r: 3 } }],
  });
  const view = observe(g, "p1"),
    world = buildWorld(view),
    motion = makeMotion(view, 100),
    timing = combatTiming(view);
  assert.ok(!view.units.some((u) => u.id === b.id));
  assert.ok(world.userData.actors.has(b.id));
  assert.equal(timing.flight, 1400);
  assert.ok(motion.duration >= 4000);
  assert.equal(motion.update(100 + timing.hit - 1).poses.get(b.id).scale, 1);
  const halfway = motion
    .update(100 + timing.destroy + 550)
    .poses.get(b.id).scale;
  assert.ok(halfway > 0.4 && halfway < 0.6);
  const final = motion.update(motion.endTime + 1);
  assert.equal(final.poses.get(b.id).scale, 0);
  world.userData.animate(final.poses, motion.endTime + 1, true);
  for (const mesh of world.children)
    if (mesh.isInstancedMesh)
      assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
  disposeGroup(world);
  disposeGroup(motion.group);
});
