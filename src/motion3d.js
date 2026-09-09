import * as THREE from "three";
import { key, routeSchedule } from "../shared/rules.js";
import { worldPoint, terrainHeight } from "./world3d.js";
import { resolvedCombatPoint } from "./combatPresentation.js";
// The board is flat and bounded: no east/west seam exists any more, so the
// nearest image of a point is the point itself and positions never wrap.
const circumference = Number.POSITIVE_INFINITY;
function nearestImage(_a, b) {
  return b.clone();
}
function wrapPosition(p) {
  return p;
}
export function combatTiming(game) {
  const counts = new Map();
  for (const e of game.effects ?? [])
    if (e.kind === "move")
      counts.set(e.unitId, (counts.get(e.unitId) ?? 0) + 1);
  const move = Math.max(0, ...counts.values()) * 520;
  const flight = (game.effects ?? []).some((e) => e.kind === "bombard")
    ? 1400
    : 650;
  return { move, flight, hit: move + flight, destroy: move + flight + 900 };
}

export function makeRoute(game, unit, path) {
  const group = new THREE.Group(),
    map = new Map(game.tiles.map((t) => [key(t), t]));
  const schedule = unit
    ? routeSchedule(
        game.tiles,
        unit,
        game.units,
        game.playerId,
        path,
        game.rivers,
        game.roads ?? game.logistics?.roads ?? [],
      )
    : { steps: [], turns: 0 };
  if (!unit || !path?.length) return { group, markers: [], turns: 0 };
  const pts = [unit, ...path].map((p) =>
    worldPoint(p).setY(terrainHeight(map.get(key(p))) + 0.17),
  );
  const segments = [[pts[0]]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1],
      b = pts[i];
    if (Math.abs(a.x - b.x) > circumference / 2) {
      const next = nearestImage(a, b),
        mid = a.clone().lerp(next, 0.5);
      segments.at(-1).push(mid);
      segments.push([
        mid
          .clone()
          .add(
            new THREE.Vector3(a.x > b.x ? -circumference : circumference, 0, 0),
          ),
        b,
      ]);
    } else segments.at(-1).push(b);
  }
  for (const segment of segments) {
    const curve = new THREE.CatmullRomCurve3(
      segment,
      false,
      "centripetal",
      0.1,
    );
    const border = new THREE.Mesh(
      new THREE.TubeGeometry(curve, pts.length * 10, 0.073, 6, false),
      new THREE.MeshBasicMaterial({
        color: "#285c50",
        depthTest: false,
        transparent: true,
        opacity: 0.8,
      }),
    );
    const line = new THREE.Mesh(
      new THREE.TubeGeometry(curve, pts.length * 10, 0.033, 6, false),
      new THREE.MeshBasicMaterial({ color: "#faf0c3", depthTest: false }),
    );
    border.renderOrder = 9;
    line.renderOrder = 10;
    group.add(border, line);
  }
  const end = pts.at(-1),
    ring = new THREE.Mesh(
      new THREE.RingGeometry(0.23, 0.32, 32),
      new THREE.MeshBasicMaterial({
        color: "#fff0b3",
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(end);
  ring.renderOrder = 11;
  group.add(ring);
  return {
    group,
    markers: schedule.steps.filter((s) => s.endOfTurn),
    turns: schedule.turns,
  };
}

export function makeMotion(game, now) {
  const group = new THREE.Group(),
    map = new Map(game.tiles.map((t) => [key(t), t])),
    tracks = new Map();
  const point = (p) =>
    worldPoint(p).setY(terrainHeight(map.get(key(p))) + 0.08);
  const effects = game.effects ?? [];
  for (const e of effects.filter((e) => e.kind === "move")) {
    if (!tracks.has(e.unitId)) tracks.set(e.unitId, [point(e.from)]);
    tracks.get(e.unitId).push(point(e.to));
  }
  const timing = combatTiming(game),
    moveDuration = timing.move;
  const bursts = [],
    attackVisuals = [];
  for (const e of effects.filter((e) =>
    ["bombard", "attack", "impact"].includes(e.kind),
  )) {
    const fromPoint = resolvedCombatPoint(e, "source"),
      toPoint = resolvedCombatPoint(e, "target");
    if (e.kind === "attack" && e.unitId && fromPoint && toPoint)
      attackVisuals.push({ effect: e, fromPoint, toPoint });
    const projectile = new THREE.Mesh(
      e.kind === "attack"
        ? new THREE.BoxGeometry(0.03, 0.03, 0.32)
        : new THREE.SphereGeometry(0.085, 8, 6),
      new THREE.MeshBasicMaterial({
        color: e.kind === "attack" ? "#fff3b8" : "#493f30",
      }),
    );
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 6),
      new THREE.MeshBasicMaterial({
        color: "#ffe3a0",
        transparent: true,
        opacity: 0,
      }),
    );
    const blast = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.28, 24),
      new THREE.MeshBasicMaterial({
        color: "#f0b464",
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    blast.rotation.x = -Math.PI / 2;
    const chips = Array.from({ length: 7 }, (_, i) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.11, 0.11),
        new THREE.MeshBasicMaterial({
          color: i % 2 ? "#c49c65" : "#e8cd9a",
          transparent: true,
          opacity: 0,
        }),
      );
      group.add(mesh);
      return mesh;
    });
    group.add(projectile, flash, blast);
    projectile.visible = false;
    bursts.push({
      effect: e,
      projectile,
      flash,
      blast,
      chips,
      // Capture endpoints at motion creation. Never look up a target unit's
      // current position during the animation (that would make a resolved
      // hit appear to home after a dodge/move).
      from: fromPoint
        ? point(fromPoint).add(new THREE.Vector3(0, 0.65, 0))
        : null,
      to: toPoint ? point(toPoint) : null,
    });
  }
  const duration = Math.max(
    moveDuration,
    bursts.length ? timing.hit + 2600 : 0,
    effects.some((e) => e.kind === "damage") ? timing.hit + 3600 : 0,
    effects.some((e) => e.kind === "build") ? 2000 : 0,
    effects.some((e) => e.kind === "heal") ? 2200 : 0,
  );
  return {
    group,
    tracks,
    duration,
    endTime: now + duration,
    damageDelay: timing.hit,
    update(time) {
      const elapsed = time - now,
        poses = new Map();
      for (const [id, points] of tracks) {
        const progress = Math.min(
            points.length - 1,
            Math.max(0, elapsed / 520),
          ),
          i = Math.min(points.length - 2, Math.floor(progress)),
          t = progress - i;
        const next = nearestImage(points[i], points[i + 1]);
        const p = wrapPosition(
            new THREE.Vector3().lerpVectors(points[i], next, t),
          ),
          delta = next.clone().sub(points[i]);
        p.y -= 0.08;
        poses.set(id, {
          position: p,
          yaw: Math.atan2(-delta.x, -delta.z),
          bounce:
            progress < points.length - 1
              ? Math.abs(Math.sin(progress * Math.PI * 2)) * 0.055
              : 0,
        });
      }
      for (const visual of attackVisuals) {
        const e = visual.effect,
          fromPoint = visual.fromPoint,
          toPoint = visual.toPoint;
        const age = elapsed - timing.move,
          from = point(fromPoint),
          to = nearestImage(from, point(toPoint)),
          delta = to.clone().sub(from);
        const melee = ["cavalry", "spearman"].includes(e.unitType);
        let progress =
          age < 0
            ? 0
            : age < timing.flight
              ? Math.sin(((age / timing.flight) * Math.PI) / 2)
              : Math.max(0, 1 - (age - timing.flight) / 450);
        const p = from
          .clone()
          .addScaledVector(
            delta,
            melee
              ? progress * (e.unitType === "cavalry" ? 0.65 : 0.28)
              : -Math.max(0, Math.sin(Math.max(0, age) * 0.04)) * 0.035,
          );
        p.y -= 0.08;
        if (age < timing.flight + 450)
          poses.set(e.unitId, {
            position: wrapPosition(p),
            yaw: Math.atan2(-delta.x, -delta.z),
            bounce: melee
              ? Math.abs(Math.sin(Math.max(0, age) * 0.025)) * 0.075
              : 0,
          });
      }
      for (const e of effects.filter((e) => e.kind === "build")) {
        const age = Math.max(0, elapsed),
          p = point(e.at);
        p.y -= 0.08;
        poses.set(e.unitId, {
          position: p,
          work: age < 1800 ? Math.sin(age * 0.016) : 0,
          tilt: age < 1800 ? Math.sin(age * 0.016) * 0.07 : 0,
          scale: e.consumed ? Math.max(0, Math.min(1, (2000 - age) / 200)) : 1,
        });
      }
      for (const e of effects.filter((e) => e.kind === "relocate")) {
        const t = Math.max(0, Math.min(1, (elapsed - timing.hit - 450) / 650)),
          from = point(e.from),
          to = point(e.to),
          delta = to.clone().sub(from);
        const position = from.lerp(to, t);
        position.y -= 0.08;
        poses.set(e.unitId, {
          position,
          yaw: Math.atan2(-delta.x, -delta.z),
          bounce:
            t > 0 && t < 1 ? Math.abs(Math.sin(t * Math.PI * 2)) * 0.055 : 0,
        });
      }
      for (const e of effects.filter((e) => e.kind === "heal")) {
        const base = poses.get(e.unitId),
          position =
            base?.position.clone() ??
            point(e.at).add(new THREE.Vector3(0, -0.08, 0));
        const pulse =
          Math.max(0, 1 - elapsed / 2200) * Math.sin(elapsed * 0.008);
        poses.set(e.unitId, {
          ...base,
          position,
          scale: 1 + Math.max(0, pulse) * 0.07,
          bounce: Math.abs(pulse) * 0.04,
        });
      }
      for (const e of effects.filter((e) => e.kind === "damage" && e.unitId)) {
        const age = elapsed - timing.hit,
          base = poses.get(e.unitId),
          damagePoint = resolvedCombatPoint(e, "target"),
          p = base?.position.clone() ??
            (damagePoint
              ? point(damagePoint).add(new THREE.Vector3(0, -0.08, 0))
              : null);
        if (!p) continue;
        if (age > 0 && age < 750)
          p.x += Math.sin(age * 0.048) * 0.09 * (1 - age / 750);
        const fall = e.destroyed
          ? Math.max(0, Math.min(1, (elapsed - timing.destroy) / 1100))
          : 0;
        poses.set(e.unitId, {
          ...base,
          position: p,
          scale: 1 - fall,
          tilt: fall * 1.1,
        });
      }
      for (const b of bursts) {
        const age = elapsed - moveDuration,
          flight = timing.flight,
          land = age - flight;
        if (b.from) {
          b.flash.position.copy(b.from);
          b.flash.material.opacity =
            age >= 0 && age < 160 ? (1 - age / 160) * 0.9 : 0;
          b.flash.scale.setScalar(1 + Math.min(160, Math.max(0, age)) / 120);
        }
        const melee =
          b.effect.kind === "attack" && b.effect.unitType !== "musketeer";
        b.projectile.visible =
          !melee && !!(b.from && b.to && age >= 0 && age < flight);
        if (melee) b.flash.material.opacity = 0;
        if (b.projectile.visible) {
          const t =
            b.effect.kind === "attack" ? (age % 220) / 220 : age / flight;
          const to = nearestImage(b.from, b.to);
          b.projectile.position.lerpVectors(b.from, to, t);
          if (b.effect.kind === "attack") b.projectile.lookAt(to);
          wrapPosition(b.projectile.position);
          b.projectile.position.y +=
            Math.sin(t * Math.PI) * (b.effect.kind === "bombard" ? 3.1 : 0);
        }
        if (b.to && land >= 0 && land < 1200) {
          const t = land / 1200;
          b.blast.position.copy(b.to);
          b.blast.material.opacity =
            (1 - t) * (b.effect.kind === "bombard" ? 0.8 : 0.3);
          b.blast.scale.setScalar(1 + t * 3);
          b.chips.forEach((m, i) => {
            const angle = (i * Math.PI * 2) / 7;
            m.position
              .copy(b.to)
              .add(
                new THREE.Vector3(
                  Math.cos(angle) * t * 0.85,
                  Math.sin(t * Math.PI) * 0.7,
                  Math.sin(angle) * t * 0.85,
                ),
              );
            m.rotation.set(t * 5, i + t * 4, t * 3);
            m.material.opacity = 1 - t;
          });
        } else {
          b.blast.material.opacity = 0;
          for (const m of b.chips) m.material.opacity = 0;
        }
      }
      return { poses, active: elapsed < duration, elapsed };
    },
  };
}
