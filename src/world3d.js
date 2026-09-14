import * as THREE from "three";
import {
  DIRECTIONS,
  TYPES,
  key,
  equal,
  neighbors,
  distance,
  reachable,
  FACTIONS,
  WIDTH,
  HEIGHT,
  blocksUnit,
  isCivilian,
} from "../shared/rules.js";
import { mountainBlocksLine } from "../shared/combat.js";

export const worldPoint = ({ q, r }) =>
  new THREE.Vector3(
    (q - (WIDTH - 1) / 2) * 1.5,
    0,
    (r + q / 2 - (HEIGHT - 0.5) / 2) * Math.sqrt(3),
  );
export const terrainHeight = (tile) =>
  tile?.terrain === "mountain" ? 0.68 : tile?.terrain === "hills" ? 0.55 : 0.24;

// A border's full thickness stays on its owner's side of the shared edge.
// Opposite nations therefore never draw coplanar, overlapping color strips.
export function territoryBorderEdge(tile, side, width = 0.09) {
  const radius = 1 - (width / 2 + 0.008) / (Math.sqrt(3) / 2);
  const theta = -side * Math.PI / 3;
  const point = angle => worldPoint(tile).add(new THREE.Vector3(
    Math.cos(angle) * radius, terrainHeight(tile) + 0.009, Math.sin(angle) * radius));
  return {a:point(theta), b:point(theta + Math.PI / 3), width};
}
const tone = {
  friendly: "#327b6c",
  enemy: "#bc745d",
  soil: "#bdab8c",
  rock: "#a6b0a4",
  cream: "#f0ead5",
  wood: "#8c7153",
  skin: "#e8c7a2",
  dark: "#46534c",
};
const noise = (q, r, n = 0) =>
  ((q * 53 + r * 97 + n * 131 + 19001) % 997) / 997;

// Only player-scoped observations enter this renderer. No game-engine imports.
export function buildWorld(game) {
  const group = new THREE.Group();
  const faction = (id) =>
    game.factions?.find((f) => f.id === id) ??
    FACTIONS[id] ?? {
      color: tone.enemy,
      name: id,
    };
  const boxes = [],
    hexes = [];
  const tileMap = new Map(game.tiles.map((t) => [key(t), t]));
  const casualties = (game.effects ?? [])
    .filter(
      (e) =>
        e.destroyed && e.unit && !game.units.some((u) => u.id === e.unit.id),
    )
    .map((e) => e.unit);
  const builders = (game.effects ?? [])
    .filter(
      (e) =>
        e.kind === "build" &&
        e.unit &&
        !game.units.some((u) => u.id === e.unitId),
    )
    .map((e) => e.unit);
  const visibleUnits = [...game.units, ...casualties, ...builders];
  const places = new Set(
    [...visibleUnits, ...game.cities, ...(game.cityContacts ?? [])].map(key),
  );
  const actors = new Map(
    visibleUnits.map((u, i) => [
      u.id,
      {
        entity: u,
        origin: worldPoint(u).setY(terrainHeight(tileMap.get(key(u)))),
        parts: [],
        phase: i * 1.71,
      },
    ]),
  );
  const geometryBox = new THREE.BoxGeometry(1, 1, 1);
  const geometryHex = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
  geometryHex.rotateY(Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  const add = (
    list,
    x,
    y,
    z,
    w,
    h,
    d,
    color,
    point,
    rotation = 0,
    part = null,
  ) => list.push({ x, y, z, w, h, d, color, point, rotation, part });
  const box = (p, x, y, z, w, h, d, color) =>
    add(
      boxes,
      p.origin.x + x,
      p.origin.y + y + h / 2,
      p.origin.z + z,
      w,
      h,
      d,
      color,
      p.entity,
      p.rotation ?? 0,
      p.part ?? null,
    );
  const line = (a, b, color, width = 0.025, height = 0.025, entity = null) => {
    const dx = b.x - a.x,
      dz = b.z - a.z;
    add(
      boxes,
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      (a.z + b.z) / 2,
      Math.hypot(dx, dz),
      height,
      width,
      color,
      entity,
      -Math.atan2(dz, dx),
    );
  };
  const root = (point, y = terrainHeight(tileMap.get(key(point)))) => ({
    origin: worldPoint(point).setY(y),
    entity: point,
  });
  const hex = (t, y, h, color, scale = 0.981) => {
    const p = worldPoint(t);
    add(hexes, p.x, y, p.z, scale, h, scale, color, t);
  };
  function tree(p, x, z, s = 0.75) {
    box(p, x, 0, z, 0.13 * s, 0.48 * s, 0.13 * s, tone.wood);
    box(p, x, 0.36 * s, z, 0.55 * s, 0.38 * s, 0.55 * s, "#719e67");
    box(
      p,
      x - 0.05 * s,
      0.74 * s,
      z - 0.03 * s,
      0.36 * s,
      0.24 * s,
      0.36 * s,
      "#92b47b",
    );
  }
  function horse(p, x = 0, z = 0, scale = 1, color = "#b59470") {
    const b = (xx, y, zz, w, h, d, c = color) =>
      box(
        p,
        x + xx * scale,
        y * scale,
        z + zz * scale,
        w * scale,
        h * scale,
        d * scale,
        c,
      );
    for (const a of [-0.18, 0.18])
      for (const c of [-0.25, 0.25]) b(a, 0, c, 0.11, 0.4, 0.11, tone.dark);
    b(0, 0.32, 0, 0.42, 0.32, 0.7);
    b(0, 0.5, -0.27, 0.25, 0.43, 0.23);
    b(0, 0.78, -0.4, 0.24, 0.23, 0.36);
    b(-0.07, 0.99, -0.34, 0.055, 0.13, 0.075);
    b(0.07, 0.99, -0.34, 0.055, 0.13, 0.075);
    b(0, 0.54, 0.33, 0.08, 0.26, 0.15, tone.dark);
    b(0, 0.64, 0.04, 0.46, 0.06, 0.29, tone.wood);
  }
  function soldier(
    p,
    type,
    x = 0,
    z = 0,
    scale = 1,
    team = tone.friendly,
    raised = 0,
  ) {
    const b = (xx, y, zz, w, h, d, color) =>
      box(
        p,
        x + xx * scale,
        raised + y * scale,
        z + zz * scale,
        w * scale,
        h * scale,
        d * scale,
        color,
      );
    b(-0.1, 0, 0, 0.14, 0.31, 0.17, tone.dark);
    b(0.1, 0, 0, 0.14, 0.31, 0.17, tone.dark);
    b(0, 0.28, 0, 0.36, 0.35, 0.23, team);
    b(-0.23, 0.3, 0, 0.12, 0.28, 0.16, tone.skin);
    p.part = type === "builder" ? "hammer" : null;
    b(0.23, 0.3, 0, 0.12, 0.28, 0.16, team);
    p.part = null;
    b(0, 0.64, 0, 0.29, 0.26, 0.27, tone.skin);
    b(0, 0.87, 0, 0.33, 0.12, 0.32, type === "builder" ? "#ead393" : team);
    b(
      0,
      0.84,
      -0.11,
      0.4,
      0.055,
      0.23,
      type === "builder" ? "#ead393" : tone.dark,
    );
    if (type === "spearman") {
      b(0.31, 0.15, -0.04, 0.045, 0.99, 0.045, tone.wood);
      b(0.31, 1.14, -0.04, 0.09, 0.16, 0.09, "#d8ded9");
      b(-0.32, 0.35, -0.07, 0.12, 0.38, 0.3, team);
      b(-0.39, 0.48, -0.07, 0.03, 0.11, 0.15, tone.cream);
    } else if (type === "musketeer") {
      b(0.21, 0.35, -0.24, 0.09, 0.12, 0.54, tone.wood);
      b(0.21, 0.39, -0.54, 0.06, 0.075, 0.4, tone.dark);
      b(-0.08, 0.33, -0.125, 0.05, 0.32, 0.025, tone.cream);
    } else if (type === "builder") {
      p.part = "hammer";
      b(0.29, 0.05, -0.08, 0.045, 0.7, 0.045, tone.wood);
      b(0.29, 0.72, -0.08, 0.32, 0.16, 0.16, tone.dark);
      p.part = null;
      b(0, 0.3, 0.17, 0.29, 0.26, 0.13, tone.wood);
    } else if (type === "settler") {
      // A packed handcart and a faction pennant, distinct from a builder's hammer.
      b(0, 0.31, 0.34, 0.5, 0.32, 0.46, tone.wood);
      b(0, 0.63, 0.34, 0.54, 0.14, 0.5, tone.cream);
      b(-0.29, 0.15, 0.34, 0.1, 0.24, 0.25, tone.dark);
      b(0.29, 0.15, 0.34, 0.1, 0.24, 0.25, tone.dark);
      b(0.32, 0.4, 0.12, 0.04, 1, 0.04, tone.wood);
      b(0.45, 1.12, 0.12, 0.28, 0.21, 0.04, team);
    }
  }
  function cannon(p, x, z, scale, team) {
    const b = (xx, y, zz, w, h, d, c) =>
      box(
        p,
        x + xx * scale,
        y * scale,
        z + zz * scale,
        w * scale,
        h * scale,
        d * scale,
        c,
      );
    b(0, 0.18, 0.0, 0.68, 0.15, 0.65, team);
    b(-0.37, 0.04, 0, 0.16, 0.47, 0.47, tone.dark);
    b(0.37, 0.04, 0, 0.16, 0.47, 0.47, tone.dark);
    b(-0.46, 0.2, 0, 0.03, 0.14, 0.14, tone.wood);
    b(0.46, 0.2, 0, 0.03, 0.14, 0.14, tone.wood);
    b(0, 0.34, -0.23, 0.27, 0.26, 0.95, "#647369");
    b(0, 0.4, -0.72, 0.16, 0.15, 0.02, "#253b34");
    b(0, 0.15, 0.49, 0.19, 0.13, 0.52, tone.wood);
  }
  function city(p, team) {
    box(p, 0, 0, 0, 1.2, 0.07, 1.1, "#d7d1b5");
    const house = (x, z, w, h, d) => {
      box(p, x, 0.07, z, w, h, d, tone.cream);
      box(p, x, 0.07 + h, z, w + 0.06, 0.12, d + 0.06, team);
      box(p, x, 0.19 + h, z, w * 0.75, 0.1, d + 0.02, team);
      box(p, x, 0.29 + h, z, w * 0.48, 0.09, d - 0.04, team);
      box(p, x, 0.18, z - d / 2 - 0.008, 0.09, 0.18, 0.02, tone.dark);
    };
    house(-0.34, 0.2, 0.36, 0.38, 0.4);
    house(0.31, 0.22, 0.38, 0.44, 0.45);
    house(0.03, -0.26, 0.49, 0.72, 0.42);
    box(p, 0.18, 1.08, -0.28, 0.035, 0.58, 0.035, tone.wood);
    box(p, 0.32, 1.4, -0.28, 0.27, 0.18, 0.035, team);
    for (const x of [-0.59, 0.59])
      box(p, x, 0.07, 0.46, 0.14, 0.2, 0.14, "#b4c396");
    if (p.entity.wallLevel) {
      const h = 0.24 + p.entity.wallLevel * 0.12;
      for (const side of [-1, 1]) {
        box(p, side * 0.72, 0, 0, 0.14, h, 1.56, "#abb4b1");
        box(p, 0, 0, side * 0.72, 1.56, h, 0.14, "#abb4b1");
        for (const x of [-0.6, 0, 0.6]) {
          box(p, side * 0.72, h, x, 0.17, 0.13, 0.19, team);
          box(p, x, h, side * 0.72, 0.19, 0.13, 0.17, team);
        }
      }
    }
  }
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.MeshBasicMaterial({ color: "#d5e6ee" }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -0.69;
  group.add(sea);
  // Decorative chart marks are seeded from coordinates, never from hidden terrain.
  for (const t of game.tiles) {
    const active = t.visible || t.owner === game.playerId,
      h = terrainHeight(t),
      p = root(t);
    if (t.terrain === "unknown") {
      // Base ends at .17, parchment ends at .24: never coplanar (zoom z-fighting).
      hex(t, -0.215, 0.77, "#d9cfb5");
      hex(t, 0.205, 0.07, "#e9dfc5", 0.991);
      const ink = "#baaa89",
        mark = Math.floor(noise(t.q, t.r) * 17);
      if (mark % 5 === 0)
        for (let z = -0.28; z <= 0.28; z += 0.28) {
          const a = p.origin.clone().add(new THREE.Vector3(-0.45, 0.012, z)),
            b = a.clone().add(new THREE.Vector3(0.22, 0, -0.06)),
            c = b.clone().add(new THREE.Vector3(0.23, 0, 0.06)),
            d = c.clone().add(new THREE.Vector3(0.23, 0, -0.06));
          line(a, b, ink, 0.018, 0.008, t);
          line(b, c, ink, 0.018, 0.008, t);
          line(c, d, ink, 0.018, 0.008, t);
        }
      else if (mark % 7 === 0) {
        const a = p.origin.clone().add(new THREE.Vector3(-0.35, 0.01, 0.25)),
          b = p.origin.clone().add(new THREE.Vector3(0, 0.01, -0.35)),
          c = p.origin.clone().add(new THREE.Vector3(0.35, 0.01, 0.25));
        line(a, b, ink, 0.02, 0.009, t);
        line(b, c, ink, 0.02, 0.009, t);
        line(a, c, ink, 0.02, 0.009, t);
      }
      continue;
    }
    const grass = active
      ? ["#cbd3a5", "#bacd94", "#a9c48a", "#9dbb7a"][t.fertility]
      : "#d4dbce";
    hex(t, (h - 0.13 - 0.6) / 2, h + 0.47, active ? tone.soil : "#c2c8bd");
    hex(
      t,
      h - 0.065,
      0.13,
      t.terrain === "mountain" ? (active ? "#b4b9a7" : "#c9d1c5") : grass,
      0.988,
    );
    if (t.terrain === "mountain") {
      const colors = active
        ? ["#b6bca9", "#a6ae9f", "#ccd1ba"]
        : ["#ccd3c8", "#c4cec3", "#e0e6d9"];
      box(p, 0, 0, 0, 1.03, 0.54, 1.06, colors[0]);
      box(p, -0.13, 0.54, -0.1, 0.69, 0.52, 0.69, colors[1]);
      box(p, -0.18, 1.06, -0.12, 0.38, 0.43, 0.41, colors[2]);
      box(p, 0.48, 0, 0.27, 0.39, 0.25, 0.42, colors[1]);
      box(p, -0.47, 0, 0.26, 0.31, 0.33, 0.45, colors[0]);
    } else if (t.terrain === "hills" && !(t.farm && active)) {
      box(p, -0.3, 0, -0.3, 0.59, 0.22, 0.5, grass);
      box(
        p,
        -0.39,
        0.22,
        -0.34,
        0.34,
        0.16,
        0.32,
        active ? "#b8cc99" : "#dae0d3",
      );
      box(p, 0.43, 0, 0.28, 0.33, 0.12, 0.36, grass);
    }
    if (t.farm && active && t.terrain === "hills") {
      // Three contour terraces replace the plain field's flat furrows.
      // This changes farmland geometry only, never actor model altitude.
      for (let level = 0; level < 3; level++) {
        const z = -0.36 + level * 0.36;
        const rise = (2 - level) * 0.14;
        box(p, 0, 0.003, z, 1.08, rise + 0.075, 0.34, "#8b8067");
        box(p, 0, rise + 0.076, z, 1.02, 0.035, 0.28, "#b1aa6c");
        for (let x = -0.42; x < 0.5; x += 0.21)
          box(p, x, rise + 0.11, z, 0.09, 0.12, 0.17, "#d8bd67");
      }
    } else if (t.farm && active) {
      // A farm on a wheat feature is a golden field; ordinary farms keep the
      // muted straw palette.
      const wheat = t.feature === "wheat";
      box(p, 0, 0.003, 0, 1.04, 0.04, 1.1, wheat ? "#b8924a" : "#a9956d");
      for (let x = -0.39; x <= 0.4; x += 0.26) {
        box(p, x, 0.05, 0, 0.16, 0.035, 1.04, wheat ? "#d9a93d" : "#c6ad69");
        for (let z = -0.44; z < 0.5; z += 0.2)
          box(
            p,
            x,
            0.085,
            z,
            0.1,
            (wheat ? 0.19 : 0.15) + noise(t.q, t.r, Math.round(z * 10)) * 0.08,
            0.09,
            wheat ? "#f3c94a" : "#e4c576",
          );
      }
    } else if (t.feature === "wheat" && !t.resource && !t.fort) {
      // Wild wheat: golden tufts in a loose ring, not the ordered farm rows.
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2 + noise(t.q, t.r, k) * 0.8;
        const d = 0.22 + noise(t.q, t.r, k + 9) * 0.3;
        box(
          p,
          Math.cos(a) * d,
          0,
          Math.sin(a) * d,
          0.11,
          active ? 0.2 + noise(t.q, t.r, k + 3) * 0.1 : 0.14,
          0.11,
          active ? (k % 2 ? "#e9bd3e" : "#f2d35c") : "#d9d3b6",
        );
      }
    } else if (
      !places.has(key(t)) &&
      t.terrain === "plains" &&
      !t.feature &&
      !t.resource &&
      !t.fort
    ) {
      if (active)
        for (let k = 0; k < 3; k++)
          box(
            p,
            -0.55 + noise(t.q, t.r, k) * 0.9,
            0.0,
            -0.52 + noise(t.q, t.r, k + 4) * 0.9,
            0.09,
            0.035,
            0.09,
            "#ccdaae",
          );
    }
    if (t.feature === "forest" && !t.farm && !t.resource && !(t.fort?.hp > 0)) {
      // Visible trees mean exactly one thing: a choppable forest feature.
      // Three trunks per hex keep the canopy readable at map scale.
      const spots = [
        [-0.32, -0.22, 0.65],
        [0.3, 0.18, 0.55],
        [-0.05, 0.36, 0.45],
      ];
      for (const [x, z, sc] of spots) {
        const jitter = noise(t.q, t.r, Math.round(x * 10 + z * 100)) * 0.1;
        if (active) tree(p, x + jitter, z - jitter, sc);
        else {
          box(p, x, 0, z, 0.1 * sc / 0.65, 0.29 * sc / 0.65, 0.1 * sc / 0.65, "#b7c1b1");
          box(p, x, 0.28 * sc / 0.65, z, 0.38 * sc / 0.65, 0.31 * sc / 0.65, 0.38 * sc / 0.65, "#c4cebd");
        }
      }
    }
    if (t.fort?.hp > 0) {
      const stone = active ? "#a5aea0" : "#c0c9bb";
      for (const x of [-0.6, 0.6])
        for (const z of [-0.6, 0.6]) {
          box(p, x, 0, z, 0.25, 0.46, 0.25, stone);
          box(p, x, 0.46, z, 0.29, 0.08, 0.29, active ? "#d6d9c9" : "#cad1c2");
        }
      for (const x of [-0.6, 0.6]) box(p, x, 0, 0, 0.16, 0.25, 1.12, stone);
      for (const z of [-0.6, 0.6]) box(p, 0, 0, z, 1.12, 0.25, 0.16, stone);
      box(p, 0.6, 0.52, 0.6, 0.035, 0.45, 0.035, tone.wood);
      box(
        p,
        0.71,
        0.77,
        0.6,
        0.23,
        0.14,
        0.035,
        faction(t.fort.owner).color ?? tone.cream,
      );
    }
    if (t.resource) {
      if (t.resource === "horses") {
        if (active) horse(p, 0.15, 0.12, 0.46, "#b39570");
        else box(p, 0.15, 0, 0.12, 0.28, 0.22, 0.36, "#bdc8b7");
      } else
        for (let i = 0; i < 3; i++)
          box(
            p,
            -0.23 + i * 0.23,
            0.02,
            (i % 2) * 0.17,
            0.25,
            0.14 + (i % 2) * 0.13,
            0.25,
            active
              ? t.resource === "iron"
                ? "#859589"
                : "#e9e4cc"
              : "#bdc7b8",
          );
      if (t.developed && active) {
        for (const x of [-0.6, 0.6]) {
          box(p, x, 0, 0, 0.055, 0.29, 1.03, tone.wood);
          box(p, x, 0.3, 0, 0.04, 0.035, 1.13, "#c7b58b");
        }
        box(p, 0, 0.1, 0.55, 1.16, 0.035, 0.04, tone.wood);
      }
    }
    if (t.owner)
      neighbors(t).forEach((n, i) => {
        const next = tileMap.get(key(n)),
          national = next?.owner !== t.owner;
        if (!national && next?.cityId === t.cityId) return;
        const theta = (-i * Math.PI) / 3,
          a = worldPoint(t),
          b = a.clone();
        a.add(
          new THREE.Vector3(
            Math.cos(theta) * 0.986,
            h + 0.009,
            Math.sin(theta) * 0.986,
          ),
        );
        b.add(
          new THREE.Vector3(
            Math.cos(theta + Math.PI / 3) * 0.986,
            h + 0.009,
            Math.sin(theta + Math.PI / 3) * 0.986,
          ),
        );
        if (national) {
          const inset = territoryBorderEdge(t, i);
          a.copy(inset.a);
          b.copy(inset.b);
        }
        line(
          a,
          b,
          national ? (faction(t.owner).color ?? "#666666") : "#f8f4dc",
          national ? 0.09 : 0.035,
          national ? 0.055 : 0.025,
          t,
        );
      });
  }
  for (const river of game.rivers) {
    const index = neighbors(river.a).findIndex((n) => equal(n, river.b));
    const theta = (-index * Math.PI) / 3,
      p = worldPoint(river.a),
      h =
        Math.max(
          terrainHeight(tileMap.get(key(river.a))),
          terrainHeight(tileMap.get(key(river.b))),
        ) + 0.02;
    const a = p
      .clone()
      .add(new THREE.Vector3(Math.cos(theta), h, Math.sin(theta)));
    const b = p
      .clone()
      .add(
        new THREE.Vector3(
          Math.cos(theta + Math.PI / 3),
          h,
          Math.sin(theta + Math.PI / 3),
        ),
      );
    line(a, b, "#91bfbd", 0.16, 0.035, river.a);
    line(a, b, "#c0dcd0", 0.032, 0.042, river.a);
  }
  for (const c of [...game.cities, ...(game.cityContacts ?? [])])
    city(
      root(c),
      c.ghost ? "#b5bfb2" : (faction(c.owner).color ?? tone.enemy),
    );
  for (const u of [...visibleUnits, ...(game.contacts ?? [])]) {
    const team = u.ghost ? "#96a6a1" : (faction(u.owner).color ?? tone.enemy),
      p = root(u);
    if (visibleUnits.some((e) => e.id !== u.id && equal(e, u)))
      p.origin.x += isCivilian(u) ? 0.38 : -0.3;
    hexes.push({
      x: p.origin.x,
      y: p.origin.y + 0.022,
      z: p.origin.z,
      w: 0.55,
      h: 0.045,
      d: 0.55,
      color: team,
      point: u,
    });
    const scale = u.size === 1 ? 0.83 : u.size === 2 ? 0.6 : 0.52;
    const locations =
      u.size === 1
        ? [[0, 0]]
        : u.size === 2
          ? [
              [-0.25, 0],
              [0.25, 0.1],
            ]
          : [
              [-0.26, 0.2],
              [0.27, 0.2],
              [0, -0.3],
            ];
    for (const [x, z] of locations) {
      if (u.type === "artillery") cannon(p, x, z, scale, team);
      else if (u.type === "cavalry") {
        horse(p, x, z, scale);
        soldier(p, "cavalry", x, z, scale * 0.7, team, 0.58 * scale);
      } else soldier(p, u.type, x, z, scale, team);
    }
    if (u.fortified)
      for (const x of [-0.4, 0, 0.4])
        box(p, x, 0, 0.5, 0.34, 0.18, 0.2, "#d4c5a0");
  }
  const ghostMaterial = new THREE.MeshStandardMaterial({
    color: "#bed0cc",
    roughness: 1,
    transparent: true,
    opacity: 0.27,
    depthWrite: false,
  });
  for (const [records, geometry, ghost] of [
    [boxes.filter((b) => !b.point?.ghost), geometryBox, false],
    [hexes.filter((b) => !b.point?.ghost), geometryHex, false],
    [boxes.filter((b) => b.point?.ghost), geometryBox, true],
    [hexes.filter((b) => b.point?.ghost), geometryHex, true],
  ]) {
    if (!records.length) continue;
    const mesh = new THREE.InstancedMesh(
        geometry,
        ghost ? ghostMaterial : material,
        records.length,
      ),
      dummy = new THREE.Object3D(),
      color = new THREE.Color();
    records.forEach((b, i) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.rotation.set(0, b.rotation ?? 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(b.color));
      if (b.point?.type && actors.has(b.point.id) && !ghost)
        actors.get(b.point.id).parts.push({
          mesh,
          index: i,
          base: dummy.matrix.clone(),
          part: b.part,
        });
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = !ghost;
    mesh.receiveShadow = true;
    mesh.userData.points = records.map((b) => b.point);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  group.userData.pick = (hit) => hit?.object.userData.points?.[hit.instanceId];
  group.userData.actors = actors;
  const transform = new THREE.Matrix4(),
    originMatrix = new THREE.Matrix4(),
    posed = new THREE.Matrix4(),
    dummy = new THREE.Object3D();
  group.userData.animate = (poses, time, reduced = false) => {
    const dirty = new Set();
    for (const [id, a] of actors) {
      const pose = poses.get(id),
        p = pose?.position ?? a.origin;
      dummy.position.copy(p);
      dummy.rotation.set(
        0,
        pose?.yaw ??
          (a.entity.owner === "p1"
            ? -Math.PI / 2
            : a.entity.owner === "p2"
              ? Math.PI / 2
              : 0),
        0,
      );
      const breath = reduced ? 0 : Math.sin(time * 0.0023 + a.phase) * 0.018;
      const scale = pose?.scale ?? 1;
      dummy.scale.set(scale, (1 + breath) * scale, scale);
      dummy.rotation.z = pose?.tilt ?? 0;
      dummy.position.y += pose?.bounce ?? 0;
      dummy.updateMatrix();
      originMatrix.makeTranslation(-a.origin.x, -a.origin.y, -a.origin.z);
      transform.multiplyMatrices(dummy.matrix, originMatrix);
      for (const part of a.parts) {
        posed.multiplyMatrices(transform, part.base);
        if (part.part === "hammer" && pose?.work) {
          const bend = new THREE.Matrix4().makeRotationX(pose.work * 1.2);
          const pivot = new THREE.Vector3(
            a.origin.x,
            a.origin.y + 0.58,
            a.origin.z,
          );
          const m = new THREE.Matrix4()
            .makeTranslation(pivot.x, pivot.y, pivot.z)
            .multiply(bend)
            .multiply(
              new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z),
            );
          posed.multiplyMatrices(transform, m.multiply(part.base));
        }
        part.mesh.setMatrixAt(part.index, posed);
        dirty.add(part.mesh);
      }
    }
    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  };
  return group;
}

export function rangeBoundary(tiles, included) {
  const edges = [];
  for (const t of tiles)
    if (included.has(key(t)))
      neighbors(t).forEach((n, i) => {
        if (included.has(key(n))) return;
        const theta = (-i * Math.PI) / 3,
          p = worldPoint(t),
          y = terrainHeight(t) + 0.14;
        edges.push({
          a: p
            .clone()
            .add(new THREE.Vector3(Math.cos(theta), y, Math.sin(theta))),
          b: p
            .clone()
            .add(
              new THREE.Vector3(
                Math.cos(theta + Math.PI / 3),
                y,
                Math.sin(theta + Math.PI / 3),
              ),
            ),
          tile: key(t),
          neighbor: key(n),
        });
      });
  return edges;
}
function addRangeBoundary(group, game, tiles, color, type, inset = 1) {
  const edges = rangeBoundary(game.tiles, tiles);
  if (!edges.length) return;
  group.userData[type] = {
    tiles: [...tiles],
    edges: edges.map((e) => ({ tile: e.tile, neighbor: e.neighbor })),
  };
  const endpoint = (p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
  const remaining = new Set(edges),
    chains = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(first);
    const points = [first.a.clone(), first.b.clone()];
    while (true) {
      const end = endpoint(points.at(-1)),
        e = [...remaining].find(
          (e) => endpoint(e.a) === end || endpoint(e.b) === end,
        );
      if (!e) break;
      remaining.delete(e);
      points.push((endpoint(e.a) === end ? e.b : e.a).clone());
      if (endpoint(points.at(-1)) === endpoint(points[0])) break;
    }
    chains.push(points);
  }
  for (const chain of chains) {
    const closed = endpoint(chain[0]) === endpoint(chain.at(-1));
    if (closed) chain.pop();
    if (chain.length < 2) continue;
    const center = chain
      .reduce((sum, p) => sum.add(p), new THREE.Vector3())
      .multiplyScalar(1 / chain.length);
    const pts = chain.map((p) => p.clone().lerp(center, inset < 1 ? 0.018 : 0));
    const smooth = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i],
        before = pts[(i - 1 + pts.length) % pts.length],
        after = pts[(i + 1) % pts.length];
      if (!closed && (i === 0 || i === pts.length - 1)) smooth.push(p);
      else {
        smooth.push(p.clone().lerp(before, 0.16));
        smooth.push(p.clone().lerp(after, 0.16));
      }
    }
    const curve = new THREE.CatmullRomCurve3(smooth, closed, "centripetal");
    for (const [radius, tone, opacity, order] of [
      [0.062, type === "movement" ? "#365c54" : "#fff7ee", 0.28, 7],
      [0.032, type === "movement" ? "#fffdf6" : "#c95350", 1, 8],
    ]) {
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(
          curve,
          Math.max(12, smooth.length * 4),
          radius,
          6,
          closed,
        ),
        new THREE.MeshBasicMaterial({
          color: tone,
          transparent: opacity < 1,
          opacity,
          depthTest: false,
          depthWrite: false,
        }),
      );
      mesh.renderOrder = order;
      mesh.userData.range = type;
      group.add(mesh);
    }
  }
}
export function buildHighlights(game, selected, unit, mode, hover) {
  const group = new THREE.Group(),
    tileMap = new Map(game.tiles.map((t) => [key(t), t]));
  const own = unit?.owner === game.playerId;
  const moves =
    own && ["move", "inspect"].includes(mode) && (!unit.attackUsed || (game.experiment && unit.movesLeft > 0))
      ? reachable(
          game.tiles,
          unit,
          game.units,
          game.playerId,
          game.rivers,
          game.roads ?? game.logistics?.roads ?? [],
        )
      : new Map();
  const legal = (t) =>
    mode === "buyTile"
      ? selected &&
        !t.owner &&
        t.terrain !== "mountain" &&
        distance(t, selected) <= 4 &&
        neighbors(t).some(
          (p) =>
            tileMap.get(key(p))?.cityId === selected.id &&
            tileMap.get(key(p))?.owner === game.playerId,
        )
      : mode === "move" || mode === "inspect"
        ? moves.has(key(t)) &&
          !equal(unit, t) &&
          !game.units.some((u) => equal(u, t) && blocksUnit(unit, u)) &&
          !game.cities.some(
            (c) => c.owner !== game.playerId && c.hp > 0 && equal(c, t),
          )
        : mode === "cityAttack"
          ? selected?.owner === game.playerId &&
            distance(selected, t) <= 2 &&
            !equal(selected, t) &&
            t.visible &&
            !mountainBlocksLine(game, selected, t)
          : mode === "retreat"
            ? distance(unit, t) === 1 && t.terrain !== "mountain"
            : mode === "attack" || mode === "bombardRelocate"
              ? distance(unit, t) <= TYPES[unit.type].range &&
                !equal(unit, t) &&
                (unit.type === "artillery" || t.visible) &&
                !mountainBlocksLine(game, unit, t)
              : false;
  function outline(t, color, opacity = 1) {
    const p = worldPoint(t),
      h = terrainHeight(t) + 0.035;
    const geometry = new THREE.RingGeometry(0.89, 0.96, 6);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.copy(p).setY(h);
    mesh.renderOrder = 3;
    group.add(mesh);
  }
  for (const t of game.tiles) {
    if (equal(t, selected)) outline(t, "#fff8d9");
    else if (mode === "buyTile" && legal(t)) outline(t, "#ffe4a0", 0.8);
    else if (key(t) === hover) outline(t, "#ffffff", 0.6);
  }
  if (moves.size > 1) {
    const area = new Set(
      [...moves.keys()].filter(
        (k) =>
          !game.cities.some(
            (c) => key(c) === k && c.owner !== game.playerId && c.hp > 0,
          ),
      ),
    );
    addRangeBoundary(group, game, area, "#ffffff", "movement");
  }
  const shooter = mode === "cityAttack" ? selected : own ? unit : null;
  if (
    shooter &&
    !shooter.attackUsed &&
    (!shooter.type || TYPES[shooter.type].range > 0) &&
    !["buyTile", "retreat"].includes(mode)
  ) {
    const range = shooter.type ? TYPES[shooter.type].range : 2;
    const area = new Set(
      game.tiles
        .filter(
          (t) =>
            distance(shooter, t) <= range &&
            (!shooter.type || shooter.type !== "artillery" ? t.visible : true) &&
            !mountainBlocksLine(game, shooter, t),
        )
        .map(key),
    );
    // Slightly inset red contour keeps coincident white movement edges distinguishable.
    addRangeBoundary(group, game, area, "#e33d36", "attack", 0.91);
  }
  if (mode === "retreat" && unit)
    addRangeBoundary(
      group,
      game,
      new Set(game.tiles.filter((t) => equal(t, unit) || legal(t)).map(key)),
      "#ffffff",
      "movement",
    );
  for (const u of game.units.filter(
    (u) =>
      u.owner === game.playerId && u.order?.target && u.order.action !== "move",
  )) {
    const points = [u, ...(u.order.path ?? [u.order.target])].map((t) =>
      worldPoint(t).setY(terrainHeight(tileMap.get(key(t))) + 0.2),
    );
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({
        color: u.order.action === "move" ? "#fdf9dc" : "#b86248",
        dashSize: 0.13,
        gapSize: 0.09,
        depthTest: false,
      }),
    );
    line.computeLineDistances();
    line.renderOrder = 5;
    group.add(line);
  }
  return group;
}

export function disposeGroup(group) {
  if (!group) return;
  const geometries = new Set(),
    materials = new Set();
  group.traverse((obj) => {
    if (obj.geometry) geometries.add(obj.geometry);
    if (obj.material)
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(
        (m) => materials.add(m),
      );
    if (obj.isInstancedMesh) obj.dispose();
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  group.removeFromParent();
}
