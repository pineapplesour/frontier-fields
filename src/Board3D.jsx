import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import {
  TYPES,
  unitMovement,
  unitStat,
  TERRAINS,
  RESOURCES,
  key,
  equal,
  label,
  neighbors,
  fromOffset,
  findRoute,
  extendRoute,
  routeSchedule,
  FACTIONS,
  landPrice,
  distance,
  WIDTH,
  HEIGHT,
  cityMaxHealth,
  maxHealth,
  productionType,
  isCivilian,
} from "../shared/rules.js";
import { approachCombatPreview, formationTierName } from "../shared/combat.js";
import {
  buildWorld,
  buildHighlights,
  disposeGroup,
  worldPoint,
  terrainHeight,
} from "./world3d.js";
import { Icon, UnitIcon } from "./Icons.jsx";
import { makeRoute, makeMotion, combatTiming } from "./motion3d.js";
import { playSound, unlockSound } from "./sound.js";
import { readCamera, saveCamera } from "./cameraPreferences.js";
import { shouldPlayTurnTransition } from "./turnAudio.js";
import {
  capturePresentation,
  combatOutcomePresentation,
  effectBatchIdentity,
  effectDisplayKey,
  lockedCombatEffects,
  resolvedCombatPoint,
  hasDamage,
  damageAmountText,
  damageTotal,
} from "./combatPresentation.js";
import { estimateCityProduction } from "./productionHelpers.js";
import { attackReadiness, cityDefenseSummary } from "./cityDefenseHelpers.js";
import { layoutMapLabels } from "./labelLayout.js";

const factionForBoard = (game, id) =>
  game?.factions?.find((f) => f.id === id) ??
  FACTIONS[id] ?? {
    name: id,
    color: "#68756a",
    symbol: "·",
  };

export const Board = memo(function Board(props) {
  const {
    game,
    matchId,
    selected,
    unit,
    mode,
    onTile,
    layer,
    zoom,
    onZoom,
    onClear,
    routeDisabled,
    mapPick,
    pickCandidates = [],
    onForecast,
  } = props;
  const faction = (id) => factionForBoard(game, id);
  const host = useRef(null),
    labels = useRef(null),
    runtime = useRef(null),
    latest = useRef(props);
  latest.current = props;
  const [hover, setHover] = useState(null),
    [failure, setFailure] = useState("");
  const [cameraZoom, setCameraZoom] = useState(zoom);
  const [draft, setDraft] = useState(null);
  const [turnFlash, setTurnFlash] = useState(false);
  const [visibleEffectKey, setVisibleEffectKey] = useState(null);
  const previousEffect = useRef({ matchId: null, serial: null, batchKey: "" });
  const turnView = useRef({ matchId: null, baselined: false });
  const timing = useMemo(() => combatTiming(game), [game.effectSerial]);
  const currentEffectKey = effectDisplayKey(
    game.effectSerial,
    game.effects,
    game.turn,
  );
  const showEffectOverlay =
    currentEffectKey != null && currentEffectKey === visibleEffectKey;
  const routePath =
    draft?.path ?? (unit?.order?.action === "move" ? unit.order.path : []);
  const routePlan = useMemo(() => {
    if (!unit) return { steps: [], turns: 0 };
    // An out-of-turn reservation cannot spend the stale remaining movement
    // points. Forecast it from a fresh next-own-turn budget so its first
    // marker is turn 2 rather than incorrectly showing movement this turn.
    const forecastUnit =
      game.activePlayer === game.playerId ? unit : { ...unit, movesLeft: 0 };
    return routeSchedule(
      game.tiles,
      forecastUnit,
      game.units,
      game.playerId,
      routePath,
      game.rivers,
      game.roads ?? game.logistics?.roads ?? [],
    );
  }, [game, unit, routePath]);
  const tileMap = useMemo(
    () => new Map(game.tiles.map((t) => [key(t), t])),
    [game.tiles],
  );
  const fortTile = tileMap.get(hover);
  const hoveredEnemy = useMemo(() =>
    game.units.find((u) => key(u) === hover && u.owner !== game.playerId) ??
    game.cities.find((c) => key(c) === hover && c.owner !== game.playerId) ??
    (fortTile?.fort?.hp > 0 && fortTile.fort.owner !== game.playerId
      ? {
          ...fortTile.fort,
          q: fortTile.q,
          r: fortTile.r,
          name: "요새",
          structure: true,
          hostile: game.factions.find((f) => f.id === fortTile.fort.owner)
            ?.hostile,
          ghost: !fortTile.visible,
        }
      : null), [game, hover, fortTile]);
  const preview = useMemo(() =>
    unit?.owner === game.playerId && !hoveredEnemy?.ghost
      ? approachCombatPreview(game, unit, hoveredEnemy)
      : null, [game, unit, hoveredEnemy]);
  const combatOutcome = combatOutcomePresentation({
    preview: preview?.approachUnavailable ? null : preview,
    attacker: unit,
    target: hoveredEnemy,
  });
  const ammo = attackReadiness(unit);
  const capture = capturePresentation({
    preview,
    attacker: unit,
    target: hoveredEnemy,
  });
  // The forecast is rendered by App inside the bottom dock, beside the
  // selected unit's description, so lift the derived data out of the board.
  const forecast = useMemo(
    () => (preview ? { preview, combatOutcome, capture, unit, target: hoveredEnemy } : null),
    [preview, unit, hoveredEnemy],
  );
  useEffect(() => {
    onForecast?.(forecast);
    return () => onForecast?.(null);
  }, [forecast, onForecast]);
  const resolvedEffectLabel = lockedCombatEffects(game.effects)
    .map(({ locked }) => (locked.to ? label(locked.to) : null))
    .find(Boolean);
  useEffect(() => {
    const container = host.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
    } catch {
      setFailure(
        "3D 지도를 표시하려면 브라우저의 하드웨어 가속을 켠 뒤 새로고침해 주세요.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor("#f5f7f3", 0);
    const canvas = renderer.domElement;
    canvas.className = "world-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute(
      "aria-label",
      "3D 육각 지도. 유닛 선택 후 우클릭 이동, 우클릭 드래그 경로 지정, Alt 드래그 회전, 휠 확대.",
    );
    container.appendChild(canvas);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#fff9e9", "#b9c6ad", 2.3));
    const sun = new THREE.DirectionalLight("#fff5dc", 2.1);
    sun.position.set(-12, 24, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -20,
      right: 20,
      top: 20,
      bottom: -20,
      near: 1,
      far: 65,
    });
    sun.shadow.normalBias = 0.025;
    sun.shadow.bias = -0.0004;
    scene.add(sun);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.ShadowMaterial({ opacity: 0.085 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.615;
    floor.receiveShadow = true;
    scene.add(floor);
    const camera = new THREE.OrthographicCamera(-18, 18, 12, -12, 0.1, 180);
    camera.position.set(20, 36, 42);
    camera.lookAt(0, 0, 0);
    const controls = new MapControls(camera, canvas);
    controls.enableDamping = false;
    controls.minZoom = 0.65;
    controls.maxZoom = 5;
    controls.minPolarAngle = 0.48;
    controls.maxPolarAngle = 1.05;
    controls.zoomToCursor = true;
    controls.rotateSpeed = 0.65;
    controls.panSpeed = 0.8;
    controls.mouseButtons.RIGHT = null;
    controls.target.set(0, 0, 0);
    controls.update();
    controls.saveState();
    const saved = readCamera();
    if (saved) {
      camera.position.fromArray(saved.position);
      controls.target.fromArray(saved.target);
      camera.zoom = saved.zoom;
      camera.updateProjectionMatrix();
      controls.update();
    }
    const rt = {
      renderer,
      scene,
      camera,
      controls,
      world: null,
      highlight: null,
      width: 1,
      height: 1,
      route: null,
      motion: null,
      poses: new Map(),
      tileMap: new Map(),
    };
    runtime.current = rt;
    const projectLabels = () => {
      const map = rt.tileMap;
      const projected = [];
      // Batch all layout reads before writes; animation does not set React
      // state or repeatedly force layout while arranging crowded nameplates.
      for (const node of labels.current?.children ?? []) {
        const t = map.get(`${node.dataset.q},${node.dataset.r}`);
        if (!t) continue;
        const pose = rt.poses.get(node.dataset.actorId);
        const p = pose
          ? pose.position
              .clone()
              .add(new THREE.Vector3(0, Number(node.dataset.alt ?? 0.03), 0))
          : worldPoint(t).setY(
              terrainHeight(t) + Number(node.dataset.alt ?? 0.03),
            );
        p.z += Number(node.dataset.forward ?? 0);
        p.x += Number(node.dataset.side ?? 0);
        p.project(camera);
        const visible =
          p.z >= -1 && p.z <= 1 && Math.abs(p.x) < 1.12 && Math.abs(p.y) < 1.12;
        projected.push({ node, visible, x: ((p.x + 1) * rt.width) / 2, y: ((1 - p.y) * rt.height) / 2,
          width: node.offsetWidth || 32, height: (node.offsetHeight || 22) + 6,
          // Candidate hit areas must not overlap at the default phone zoom.
          // Reserve these first, then retain unit-before-city label priority.
          priority: node.classList.contains("map-target-marker") ? -1 : node.classList.contains("world-unit-label") ? 0 : 1,
          arrange: node.matches(".map-target-marker, .world-city-label, .world-unit-label"),
        });
      }
      const arranged = new Map(layoutMapLabels(projected.filter(item => item.visible && item.arrange), rt.width, rt.height).map(item => [item.node, item]));
      for (const item of projected) {
        const position = arranged.get(item.node) ?? item;
        const { node } = item;
        node.style.display = item.visible ? "" : "none";
        node.style.left = `${position.x}px`;
        node.style.top = `${position.y}px`;
        const dx = item.x - position.x, dy = item.y - position.y;
        node.dataset.displaced = Math.hypot(dx, dy) > 8 ? "true" : "false";
        node.style.setProperty("--leader-length", `${Math.hypot(dx, dy)}px`);
        node.style.setProperty("--leader-angle", `${Math.atan2(dy, dx)}rad`);
      }
    };
    let frame = 0,
      lastFrame = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const draw = (time) => {
      frame = 0;
      if (document.hidden) return;
      if (time - lastFrame > 32) {
        lastFrame = time;
        const motion = rt.motion?.update(
          reduced.matches ? rt.motion.endTime + 1 : time,
        );
        rt.poses = motion?.poses ?? new Map();
        rt.world?.userData.animate(rt.poses, time, reduced.matches);
        if (motion?.active) renderer.shadowMap.needsUpdate = true;
        renderer.render(scene, camera);
        projectLabels();
        canvas.dataset.drawCalls = String(renderer.info.render.calls);
        canvas.dataset.triangles = String(renderer.info.render.triangles);
        canvas.dataset.motion = motion?.active ? "moving" : "idle";
      }
      if (!reduced.matches) frame = requestAnimationFrame(draw);
    };
    rt.render = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const visible = () => rt.render();
    document.addEventListener("visibilitychange", visible);
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      rt.width = width;
      rt.height = height;
      const aspect = width / height,
        span = Math.max(44, 49 / aspect);
      camera.left = (-span * aspect) / 2;
      camera.right = (span * aspect) / 2;
      camera.top = span / 2;
      camera.bottom = -span / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderer.shadowMap.needsUpdate = true;
      rt.render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();
    const changed = () => {
      setCameraZoom(camera.zoom);
      saveCamera(camera, controls);
      if (Math.abs(latest.current.zoom - camera.zoom) > 0.0001)
        latest.current.onZoom(camera.zoom);
      rt.render();
    };
    controls.addEventListener("change", changed);
    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2();
    const hitTest = (e) => {
      if (!rt.world) return null;
      const bounds = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(e.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(rt.world.children, false);
      return rt.world.userData.pick(hits[0]);
    };
    let down = null;
    let routeDrag = null;
    const startRoute = (e, forcedPoint) => {
      const state = latest.current;
      const blocked = state.routeDisabled ?? state.disabled;
      const attackBlocked =
        state.game.activePlayer === state.game.playerId &&
        state.unit?.attackUsed && !(state.game.experiment && state.unit.movesLeft > 0);
      if (
        e.button !== 2 ||
        !state.unit ||
        state.unit.owner !== state.game.playerId ||
        blocked ||
        attackBlocked
      )
        return false;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      const target = forcedPoint ?? hitTest(e),
        path = target ? findRoute(state.game, state.unit, target) : null;
      routeDrag = {
        id: e.pointerId,
        unitId: state.unit.id,
        turn: state.game.turn,
        path: path ?? [],
        valid: !!path,
        last: target ? key(target) : null,
        cancel:
          !!target &&
          target.id === state.unit.id &&
          state.unit.order?.action === "move",
        startX: e.clientX,
        startY: e.clientY,
      };
      setDraft({ path: path ?? [], invalid: !path });
      canvas.setPointerCapture(e.pointerId);
      return true;
    };
    rt.startRoute = startRoute;
    const pointerdown = (e) => {
      unlockSound();
      if (startRoute(e)) return;
      controls.mouseButtons.LEFT = e.altKey
        ? THREE.MOUSE.ROTATE
        : THREE.MOUSE.PAN;
      if (e.button === 0)
        down = {
          x: e.clientX,
          y: e.clientY,
          id: e.pointerId,
          rotate: e.altKey,
        };
    };
    const pointermove = (e) => {
      if (routeDrag) {
        if (
          Math.hypot(
            e.clientX - routeDrag.startX,
            e.clientY - routeDrag.startY,
          ) > 5
        )
          routeDrag.cancel = false;
        const state = latest.current,
          p = hitTest(e);
        if (
          p &&
          key(p) !== routeDrag.last &&
          state.unit?.id === routeDrag.unitId
        ) {
          const path = extendRoute(state.game, state.unit, routeDrag.path, p);
          routeDrag.last = key(p);
          routeDrag.valid = !!path;
          if (path) routeDrag.path = path;
          setDraft({ path: routeDrag.path, invalid: !path });
        }
        e.preventDefault();
        return;
      }
      if (down || e.buttons) return;
      const point = hitTest(e);
      setHover(point ? key(point) : null);
      canvas.style.cursor = point ? "pointer" : "grab";
    };
    const pointerup = (e) => {
      if (routeDrag && routeDrag.id === e.pointerId) {
        const d = routeDrag;
        const blocked = latest.current.routeDisabled ?? latest.current.disabled;
        routeDrag = null;
        if (canvas.hasPointerCapture(e.pointerId))
          canvas.releasePointerCapture(e.pointerId);
        if (
          d.cancel &&
          d.turn === latest.current.game.turn &&
          d.unitId === latest.current.unit?.id &&
          !blocked
        )
          latest.current.onCancelRoute();
        else if (
          d.valid &&
          d.path.length &&
          d.turn === latest.current.game.turn &&
          d.unitId === latest.current.unit?.id &&
          !blocked
        )
          latest.current.onRoute(d.path);
        setDraft(null);
        e.preventDefault();
        return;
      }
      if (
        down &&
        !down.rotate &&
        down.id === e.pointerId &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5
      ) {
        const point = hitTest(e);
        if (point) latest.current.onTile(point);
        else latest.current.onClear();
      }
      down = null;
    };
    const leave = () => {
      down = null;
      if (!routeDrag) setHover(null);
    };
    const keyboard = (e) => {
      const state = latest.current;
      if (e.key === "Escape") {
        routeDrag = null;
        setDraft(null);
        state.onClear();
        return;
      }
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Enter",
          " ",
        ].includes(e.key)
      )
        return;
      e.preventDefault();
      const p =
        state.selected ??
        state.game.units.find((u) => u.owner === state.game.playerId) ??
        fromOffset(2, 4);
      const offset = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[e.key];
      const next = offset
        ? fromOffset(
            Math.max(0, Math.min(WIDTH - 1, p.q + offset[0])),
            Math.max(
              0,
              Math.min(HEIGHT - 1, p.r + Math.floor(p.q / 2) + offset[1]),
            ),
          )
        : p;
      const tile = state.game.tiles.find((t) => equal(t, next));
      if (tile) state.onTile(tile);
    };
    canvas.addEventListener("pointerdown", pointerdown, true);
    canvas.addEventListener("pointermove", pointermove);
    canvas.addEventListener("pointerup", pointerup);
    canvas.addEventListener("pointerleave", leave);
    const cancelRoute = () => {
      routeDrag = null;
      setDraft(null);
      leave();
    };
    canvas.addEventListener("pointercancel", cancelRoute);
    const context = (e) => e.preventDefault();
    canvas.addEventListener("contextmenu", context);
    canvas.addEventListener("keydown", keyboard);
    const lost = (e) => {
      e.preventDefault();
      setFailure(
        "3D 화면 연결이 끊겼어요. 새로고침하면 같은 경기에 다시 연결해요.",
      );
    };
    const restored = () => setFailure("");
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      saveCamera(camera, controls);
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      document.removeEventListener("visibilitychange", visible);
      canvas.removeEventListener("contextmenu", context);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      canvas.removeEventListener("pointerdown", pointerdown, true);
      canvas.removeEventListener("pointermove", pointermove);
      canvas.removeEventListener("pointerup", pointerup);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointercancel", cancelRoute);
      canvas.removeEventListener("keydown", keyboard);
      disposeGroup(rt.world);
      disposeGroup(rt.highlight);
      disposeGroup(rt.route);
      disposeGroup(rt.motion?.group);
      floor.geometry.dispose();
      floor.material.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      runtime.current = null;
    };
  }, []);
  useEffect(() => {
    const rt = runtime.current;
    if (!rt) return;
    disposeGroup(rt.world);
    rt.world = buildWorld(game);
    rt.tileMap = new Map(game.tiles.map((t) => [key(t), t]));
    rt.scene.add(rt.world);
    rt.renderer.shadowMap.needsUpdate = true;
    rt.render();
  }, [game]);
  useEffect(() => {
    const rt = runtime.current;
    if (!rt) return;
    let impactTimer = null;
    const serial = Number(game.effectSerial);
    const batchKey = effectBatchIdentity(game.effects, game.turn);
    const displayKey = effectDisplayKey(serial, game.effects, game.turn);
    if (!Number.isFinite(serial)) {
      setVisibleEffectKey(null);
      rt.render();
      return;
    }
    if (previousEffect.current.matchId !== matchId) {
      setVisibleEffectKey(null);
      previousEffect.current = { matchId, serial, batchKey };
      disposeGroup(rt.motion?.group);
      rt.motion = null;
      rt.render();
      return;
    }
    if (
      serial <= Number(previousEffect.current.serial) ||
      (batchKey && batchKey === previousEffect.current.batchKey)
    ) {
      previousEffect.current.serial = Math.max(
        serial,
        Number(previousEffect.current.serial),
      );
      rt.render();
      return;
    }
    setVisibleEffectKey(displayKey);
    previousEffect.current.serial = serial;
    previousEffect.current.batchKey = batchKey;
    disposeGroup(rt.motion?.group);
    rt.motion = makeMotion(game, performance.now());
    rt.scene.add(rt.motion.group);
    const effects = game.effects ?? [];
    const audio = latest.current;
    if (audio.soundEnabled) {
      if (effects.some((x) => x.kind === "bombard"))
        playSound("cannon", audio.volume);
      else if (effects.some((x) => x.kind === "attack"))
        playSound(
          effects.some((x) => x.unitType === "musketeer") ? "musket" : "charge",
          audio.volume,
        );
      else if (effects.some((x) => x.kind === "move"))
        playSound("move", audio.volume);
      if (effects.some((x) => x.kind === "damage"))
        impactTimer = setTimeout(
          () => playSound("impact", latest.current.volume),
          timing.hit,
        );
    }
    rt.render();
    return () => {
      if (impactTimer !== null) clearTimeout(impactTimer);
    };
  }, [matchId, game.effectSerial, game.effects, game.turn, timing.hit]);
  useEffect(() => {
    if (turnView.current.matchId !== matchId) {
      turnView.current = { matchId, baselined: false };
    }
    const isBaseline = !turnView.current.baselined;
    turnView.current.baselined = true;
    const transitioned = shouldPlayTurnTransition(matchId, game, {
      baseline: isBaseline,
    });
    // A fresh Board instance can be created by a layout/modal remount. Its
    // first snapshot is a baseline even when the module-level tracker has
    // already observed this match; never replay that historical transition.
    if (!isBaseline && transitioned) {
      setTurnFlash(true);
      setDraft(null);
      if (props.soundEnabled) playSound("turn", props.volume);
      const t = setTimeout(() => setTurnFlash(false), 1800);
      return () => clearTimeout(t);
    }
  }, [matchId, game.revision, game.turn, game.activePlayer, props.soundEnabled, props.volume]);
  useEffect(() => {
    setDraft(null);
  }, [unit?.id]);
  useEffect(() => {
    const rt = runtime.current;
    if (!rt) return;
    disposeGroup(rt.route);
    const result = makeRoute(game, unit, routePath);
    rt.route = result.group;
    rt.scene.add(rt.route);
    rt.render();
  }, [game, unit, routePath]);
  useEffect(() => {
    const rt = runtime.current;
    if (!rt) return;
    disposeGroup(rt.highlight);
    rt.highlight = buildHighlights(game, selected, unit, mode, hover);
    rt.scene.add(rt.highlight);
    rt.render();
  }, [game, selected, unit, mode, hover]);
  useEffect(() => {
    const rt = runtime.current;
    if (rt) {
      rt.camera.zoom = zoom;
      rt.camera.updateProjectionMatrix();
      setCameraZoom(zoom);
      saveCamera(rt.camera, rt.controls);
      rt.render();
    }
  }, [zoom]);
  useEffect(() => {
    runtime.current?.render();
  }, [layer, game]);
  const reset = () => {
    runtime.current?.controls.reset();
    onZoom(1);
    runtime.current?.render();
  };
  const layerTiles =
    mode === "buyTile" && selected
      ? game.tiles.filter(
          (t) =>
            !t.owner &&
            t.terrain !== "mountain" &&
            distance(t, selected) <= 4 &&
            neighbors(t).some(
              (p) =>
                tileMap.get(key(p))?.cityId === selected.id &&
                tileMap.get(key(p))?.owner === game.playerId,
            ),
        )
      : layer === "coordinates"
        ? game.tiles
        : layer === "food"
          ? game.tiles.filter(
              (t) =>
                (t.visible || t.owner === game.playerId) &&
                t.terrain !== "mountain",
            )
          : layer === "resources"
            ? game.tiles.filter((t) => t.resource)
            : [];
  return (
    <div
      className="board-wrap board-3d"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="world-host" ref={host} />
      {unit?.owner === game.playerId && !unit.attackUsed ? (
        <div className="range-legend">
          <span>
            <i className="move-key" />
            이동 · {unit.movesLeft} MP
          </span>
              {!isCivilian(unit) ? (
                <span>
                  <i className="attack-key" />
                  공격 · {TYPES[unit.type].range}칸
                  {ammo.ready ? "" : " · 초석 부족"}
                </span>
              ) : null}
        </div>
      ) : mode === "cityAttack" ? (
        <div className="range-legend">
          <span>
            <i className="attack-key" />
            도시 포격 · 2칸
          </span>
        </div>
      ) : null}
      {failure ? (
        <p className="webgl-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className={`world-labels layer-${layer} ${mapPick?.kind === "merge" ? "merge-pick" : ""}`} ref={labels}>
        {mapPick?.kind === "merge" ? pickCandidates.map((point) => {
          const partner = game.units.find((u) => u.id === point.unitId);
          const name = partner ? TYPES[partner.type].name : "부대";
          return (
            <button key={`merge-${point.unitId}`} className="map-target-marker merge-target" data-q={point.q} data-r={point.r} data-alt=".65" aria-label={`${label(point)} ${name}${partner?.size > 1 ? ` ×${partner.size}` : ""} 부대와 합병`} onClick={() => onTile(point)}>
              <Icon name="merge" size={13} /> {name} 합병
            </button>
          );
        }) : mapPick ? pickCandidates.map((point) => (
          <button key={`pick-${point.q},${point.r}`} className={`map-target-marker ${equal(point, mapPick.target) ? "picked" : ""}`} data-q={point.q} data-r={point.r} data-alt=".65" aria-label={`영토 ${point.q},${point.r} 선택`} aria-pressed={equal(point, mapPick.target)} onClick={() => onTile(point)}>{equal(point, mapPick.target) ? "✓" : `${point.q},${point.r}`}</button>
        )) : null}
        {routePlan.steps
          .filter((s) => s.endOfTurn)
          .map((s, i) => (
            <span
              key={`route-${i}`}
              className={`route-turn ${s.turn === 1 ? "current" : ""}`}
              data-q={s.q}
              data-r={s.r}
              data-alt=".25"
              title={`${s.turn === 1 ? "이번 턴" : `${s.turn - 1}턴 후`} 도달 예상 · 상황에 따라 변경`}
            >
              <b>{s.turn}</b>
              {i === routePlan.steps.filter((x) => x.endOfTurn).length - 1 ? (
                <small>도착</small>
              ) : null}
            </span>
          ))}
        {showEffectOverlay
          ? (game.effects ?? [])
              .filter((e) => e.kind === "damage" || e.kind === "heal")
              .map((e, i) => {
                const point = resolvedCombatPoint(e, "target") ?? e.at;
                if (!point) return null;
                return (
                  <span
                    key={`damage-${game.effectSerial}-${i}`}
                    className={`damage-float ${e.kind === "heal" ? "heal-float" : ""} ${e.destroyed ? "destroyed" : ""}`}
                    style={{
                      animationDelay: `${e.kind === "heal" ? 0 : timing.hit}ms`,
                    }}
                    data-q={point.q}
                    data-r={point.r}
                    data-alt="1.55"
                  >
                    {e.kind === "heal" ? "+" : "−"}
                    {e.amount}
                    {e.destroyed ? (
                      <small>
                        {e.unit?.owner === game.playerId ? "아군 파괴됨" : "격파"}
                      </small>
                    ) : (
                      <small>{e.kind === "heal" ? "체력 회복" : "피격"}</small>
                    )}
                  </span>
                );
              })
          : null}
        {game.tiles
          .filter((t) => t.fort?.hp > 0)
          .map((t) => (
            <button
              key={`fort-${key(t)}`}
              className="world-fort-label"
              data-q={t.q}
              data-r={t.r}
              data-alt=".6"
              onClick={() => onTile(t)}
              data-tip={`요새 · ${t.fort.hp}/${t.fort.maxHp} · 아군 주둔 방어력 +25%${t.visible ? "" : " · 마지막 관측"}`}
            >
              <Icon name="walls" size={13} />
              <span>요새</span>
              {t.visible && (
                <MapHealth hp={t.fort.hp} max={t.fort.maxHp} name="요새" />
              )}
            </button>
          ))}
        {layerTiles.map((t) => (
          <button
            key={`tile-${key(t)}`}
            className="world-layer-label"
            data-q={t.q}
            data-r={t.r}
            data-alt=".18"
            aria-label={`${label(t)} ${TERRAINS[t.terrain].name}`}
            onClick={() => onTile(t)}
            onPointerDown={(e) => runtime.current?.startRoute(e, t)}
          >
            {mode === "buyTile" ? (
              `${landPrice(t, selected)}G`
            ) : layer === "coordinates" ? (
              label(t)
            ) : layer === "resources" ? (
              <Icon name={RESOURCES[t.resource].icon} size={14} />
            ) : (
              1 +
              t.fertility +
              neighbors(t).filter(
                (n) =>
                  tileMap.get(key(n))?.farm &&
                  tileMap.get(key(n))?.owner === game.playerId,
              ).length
            )}
          </button>
        ))}
        {[...game.cities, ...(game.cityContacts ?? [])].map((c) => {
          const defense = cityDefenseSummary(c);
          const production =
            c.owner === game.playerId && c.queue
              ? estimateCityProduction(c, c.queue, productionType(c.queue, c))
              : null;
          const productionDefinition = c.queue
            ? productionType(c.queue, c)
            : null;
          const productionEta = production
            ? production.complete
              ? "완성 · 도시 칸 또는 수용량 확보 대기"
              : production.turns == null
                ? `생산력 ${production.productionRate}/턴 · 진행 ${production.progress}/${production.cost}`
                : `예상 ${production.turns}턴 · 진행 ${production.progress}/${production.cost} 생산력`
            : null;
          return (
            <button
              key={c.id}
              className={`world-city-label ${c.owner !== game.playerId ? "enemy" : ""} ${c.ghost ? "remembered-city" : ""}`}
              data-q={c.q}
              data-r={c.r}
              data-forward="1.05"
              data-alt=".08"
              aria-label={`${c.name} 도시`}
              onClick={() =>
                onTile(
                  c.ghost
                    ? { ...c, kind: "cityContact", source: "cityLabel" }
                    : { ...c, source: "cityLabel" },
                )
              }
              onPointerDown={(e) => runtime.current?.startRoute(e, c)}
              style={{ background: faction(c.owner).color }}
              onPointerEnter={() => setHover(key(c))}
              onPointerLeave={() => setHover(null)}
              data-tip={
                c.ghost
                  ? `${c.name} · 마지막 인구 ${c.population ?? "미확인"} · ${c.lastSeenTurn}턴 마지막 관측 · 현재 상태는 미확인`
                  : `${faction(c.owner).name} · ${c.name} · 도시 HP ${defense.body ?? c.hp}/${defense.bodyMax ?? cityMaxHealth(c)} · 성벽 HP ${defense.wall}/${defense.wallMax} · 클릭하여 도시 정보`
              }
            >
              <Icon name="city" size={12} />
              {c.name}
              <small className="city-pop">
                <Icon name="people" size={11} />
                {c.population ?? "?"}{c.ghost ? " · 기억" : ""}
              </small>
              {production && productionDefinition ? (
                <span
                  className="city-production"
                  data-tip={`${productionDefinition.name} 생산 · 턴당 생산력 ${production.productionRate} · ${productionEta}`}
                >
                  {c.queue === "walls" ? (
                    <Icon name="walls" size={14} />
                  ) : (
                    <UnitIcon type={c.queue} size={14} />
                  )}
                  <b>
                    {production.complete
                      ? "대기"
                      : production.turns == null
                        ? "생산력 0/턴"
                        : `${production.turns}턴`}
                  </b>
                </span>
              ) : null}
              {c.wallLevel > 0 ? (
                <span className="wall-badge">
                  <Icon name="walls" size={12} />
                  {c.wallLevel}
                </span>
              ) : null}
              {!c.ghost && <>
                {defense.wallMax > 0 && <MapHealth hp={defense.wall} max={defense.wallMax} name={`${c.name} 성벽`} wall />}
                <MapHealth hp={defense.body ?? c.hp} max={defense.bodyMax ?? cityMaxHealth(c)} name={c.name} />
              </>}
            </button>
          );
        })}
        {game.units.map((u) => (
          <button
            key={u.id}
            className={`world-unit-label ${u.hostile ? "enemy" : ""} ${unit?.id === u.id ? "active" : ""} ${mapPick?.kind === "merge" && pickCandidates.some((c) => equal(c, u)) ? "pick-candidate" : ""}`}
            data-q={u.q}
            data-r={u.r}
            data-forward=".62"
            data-alt=".03"
            data-actor-id={u.id}
            data-side={
              game.units.some((e) => e.id !== u.id && equal(e, u))
                ? isCivilian(u)
                  ? ".75"
                  : "-.5"
                : 0
            }
            aria-label={`${u.owner === game.playerId ? "아군" : u.hostile ? "적" : "중립"} ${TYPES[u.type].name} ${label(u)}`}
            title={`${faction(u.owner).name} ${TYPES[u.type].name} · 체력 ${u.hp}/${maxHealth(u)} · 레벨 ${u.level}`}
            style={{
              "--faction": faction(u.owner).color,
              borderColor: faction(u.owner).color,
              color: faction(u.owner).color,
            }}
            onPointerEnter={() => setHover(key(u))}
            onPointerLeave={() => setHover(null)}
            onClick={() => onTile({ ...u, source: "unitLabel" })}
            onPointerDown={(e) =>
              TYPES[u.type]?.internal ? undefined : runtime.current?.startRoute(e, u)
            }
            data-tip={
              TYPES[u.type]?.internal
                ? `${faction(u.owner).name} ${TYPES[u.type].name} · 자동 운송 수송대 · 직접 명령 불가`
                : `${faction(u.owner).name} ${TYPES[u.type].name} · 체력 ${u.hp}/${maxHealth(u)} · 공격력 ${unitStat(u, "attack", game.balance?.unitAttack?.[u.type] ?? TYPES[u.type].attack)} · 이동력 ${u.movesLeft}/${unitMovement(u)} · ${u.fortified ? "방어 중" : u.fortifyPending ? "방어 준비 중" : u.attackUsed ? "공격 완료" : "행동 가능"}`
            }
          >
            <UnitIcon type={u.type} size={13} />
            <span className="unit-label-name">{TYPES[u.type].name}</span>
            {u.size > 1 ? <small>{formationTierName(u.size)}</small> : null}
            {u.order ? <i /> : null}
            <MapHealth hp={u.hp} max={maxHealth(u)} name={TYPES[u.type].name} />
          </button>
        ))}
        {(game.contacts ?? []).map((c) => (
          <button
            key={`contact-${c.id}`}
            className="world-unit-label ghost-label"
            data-q={c.q}
            data-r={c.r}
            data-forward=".6"
            onClick={() => onTile({ ...c, source: "unitLabel" })}
            onPointerDown={(e) => runtime.current?.startRoute(e, c)}
            aria-label={`마지막 목격 ${TYPES[c.type].name} ${label(c)}`}
            data-tip={`${TYPES[c.type].name} · ${c.lastSeenTurn}턴 마지막 목격 · 현재 위치가 아닙니다`}
          >
            <UnitIcon type={c.type} size={13} />
            <small>{Math.max(0, game.turn - c.lastSeenTurn)}턴 전</small>
          </button>
        ))}
      </div>
      {game.paused ? (
        <div className="paused-banner" role="status">
          <Icon name="pause" size={16} /> 일시정지 · 사용자만 재개 가능
        </div>
      ) : null}
      {turnFlash ? (
        <div className="turn-transition" role="status">
          <small>턴 {game.turn}</small>
          <strong>
            {game.activePlayer === game.playerId
              ? game.turnMode === "simultaneous"
                ? "동시 턴"
                : "내 턴"
              : game.turnMode === "simultaneous"
                ? "정산 대기"
                : "상대 턴"}
          </strong>
          <span>
            {game.activePlayer === game.playerId
              ? game.turnMode === "simultaneous"
                ? "모두 함께 행동해요 · 먼저 움직인 쪽이 칸을 차지해요"
                : "이동력과 공격 기회가 회복됐어요"
              : game.turnMode === "simultaneous"
                ? "다른 문명이 마치면 함께 정산돼요"
                : "상대가 행동하는 중이에요"}
          </span>
        </div>
      ) : null}
      {showEffectOverlay && (game.effects ?? []).some((e) => e.kind === "damage") ? (
        <div
          className="combat-notice"
          key={`notice-${game.effectSerial}`}
          style={{ animationDelay: `${timing.hit}ms` }}
          role="status"
        >
          <small className="combat-resolution-note">
            판정 완료 · 공격 확정 당시 좌표를 재생합니다
            {resolvedEffectLabel ? ` · ${resolvedEffectLabel}` : ""}
          </small>
          <strong className="combat-totals">
            교전 결과 · 아군 피해 {damageAmountText(damageTotal(game.effects, game.playerId, true))}
            {" / "}상대 피해 {damageAmountText(damageTotal(game.effects, game.playerId, false))}
          </strong>
          {game.effects
            .filter(hasDamage)
            .map((e, i) => (
              <span key={i}>
                {(e.unit?.owner ?? e.owner) === game.playerId ? "아군" : "상대"}{" "}
                {TYPES[e.unit?.type]?.name ?? e.name ?? "부대"} · {label(resolvedCombatPoint(e, "target") ?? e.at ?? { q: 0, r: 0 })}{" "}
                <b>
                  −{e.amount}
                  {e.destroyed ? " · 파괴됨" : ""}
                </b>
              </span>
            ))}
        </div>
      ) : null}
      {draft ? (
        <div className={`route-hint ${draft.invalid ? "invalid" : ""}`}>
          {draft.invalid
            ? "지나갈 수 없는 칸이에요"
            : `우클릭을 놓으면 이동 · ${routePlan.turns}턴 경로`}
          <small>1 = 이번 턴 · 숫자는 현재 시야 기준 예상</small>
        </div>
      ) : null}
      <div className="map-zoom">
        <button
          aria-label="지도 축소"
          onClick={() => onZoom(Math.max(0.65, cameraZoom - 0.2))}
        >
          <Icon name="minus" size={16} />
        </button>
        <button aria-label="지도 중앙 맞춤" onClick={reset}>
          {Math.round(cameraZoom * 100)}%
        </button>
        <button
          aria-label="지도 확대"
          onClick={() => onZoom(Math.min(5, cameraZoom + 0.2))}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      <span className="camera-hint">
        우클릭 이동<span>·</span>Alt + 드래그 회전<span>·</span>휠 확대
      </span>
    </div>
  );
});
function MapHealth({ hp, max, name, wall = false }) {
  const ratio = Math.max(0, Math.min(1, hp / max));
  return (
    <span
      className={`map-health ${wall ? "wall-health" : ""} ${ratio < 0.3 ? "critical" : ratio < 0.6 ? "wounded" : ""}`}
      role="meter"
      aria-label={`${name} 체력`}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={hp}
    >
      <span style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}
