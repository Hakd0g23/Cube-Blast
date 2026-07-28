// Cube Blast — dev-gated entry point for the Three.js scene/camera/lighting
// infra (workstream: threejs-scene-camera-setup). Mirrors the existing
// ?debug=1 pattern (src/main.js DEBUG_LOG_PANEL) for an opt-in dev flag:
// completely inert unless ?three=1 is present in the URL, so the shipping
// Canvas 2D game (src/main.js) is untouched by default. This keeps the
// foundational scene buildable/verifiable now without forcing the
// texture-mapping/mascot/UI-integration workstreams to land first just to
// avoid regressing the live game.
import { createThreeScene } from './threeScene.js';
import { QUEUE_CAP } from './core.js';

const THREE_PREVIEW = new URLSearchParams(location.search).has('three');

// ---- gameplay-state-wiring (2026-07-28) ------------------------------------
// Mirrors src/main.js's live game state (window.__fractureDebug.getState() --
// the same `state` object the Canvas 2D pointer-drag input mutates via
// core.js's placePiece/maybeRefillTray) into both the 3D scene (via
// handle.setBoardState) and the DOM tray/shard-queue overlay ui-overlay-
// integration built (index.html's #three-ui-overlay). No input handling here
// (that's input-raycasting, a later workstream) -- this is read-only mirror.

// Same [dr,dc]-cell-list extent calc as src/main.js's own (private)
// shapeExtent() -- small enough that duplicating it here beats exporting an
// internal helper from main.js for one call site.
function shapeExtent(cells) {
  let maxR = 0, maxC = 0;
  for (const [r, c] of cells) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
  return { rows: maxR + 1, cols: maxC + 1 };
}

function buildMiniPiece(shape, color) {
  const ext = shapeExtent(shape);
  const mini = document.createElement('div');
  mini.className = 'three-piece-mini';
  mini.style.gridTemplateColumns = `repeat(${ext.cols}, 1fr)`;
  mini.style.gridTemplateRows = `repeat(${ext.rows}, 1fr)`;
  for (const [r, c] of shape) {
    const cell = document.createElement('div');
    cell.className = 'three-piece-cell';
    cell.style.gridColumn = String(c + 1);
    cell.style.gridRow = String(r + 1);
    cell.style.background = color;
    mini.appendChild(cell);
  }
  return mini;
}

// Rebuilds the tray/shard-queue DOM overlay's slot contents from live state.
// Full rebuild each call (no diffing) -- a handful of DOM nodes for an 8x8-
// scale game, not a perf-sensitive path.
function renderTrayQueueOverlay(state) {
  const queueLabel = document.getElementById('three-queue-label');
  const queueSlots = document.getElementById('three-queue-slots');
  const trayLabel = document.getElementById('three-tray-label');
  const traySlots = document.getElementById('three-tray-slots');
  if (!queueLabel || !queueSlots || !trayLabel || !traySlots) return;

  queueLabel.textContent = `Shard Queue (${state.shardQueue.length}/${QUEUE_CAP})`;
  queueSlots.innerHTML = '';
  for (let i = 0; i < QUEUE_CAP; i++) {
    const shard = state.shardQueue[i];
    const slot = document.createElement('div');
    slot.className = 'three-slot three-queue-slot' + (shard ? '' : ' dashed');
    if (shard) slot.appendChild(buildMiniPiece(shard.shape, shard.color));
    queueSlots.appendChild(slot);
  }

  trayLabel.textContent = 'Tray';
  traySlots.innerHTML = '';
  // state.tray.length can exceed the base 3 slots (core.js's overflow-
  // escalation temporary extra slot) -- rendered dynamically, not capped.
  for (let i = 0; i < state.tray.length; i++) {
    const piece = state.tray[i];
    const slot = document.createElement('div');
    slot.className = 'three-slot three-tray-slot' + (piece ? '' : ' dashed');
    if (piece) slot.appendChild(buildMiniPiece(piece.shape, piece.color));
    traySlots.appendChild(slot);
  }
}
if (THREE_PREVIEW) {
  const stage2D = document.getElementById('stage');
  const wrap = document.getElementById('three-stage-wrap');
  if (wrap) {
    wrap.style.display = 'block';
    if (stage2D) stage2D.style.visibility = 'hidden';

    const handle = createThreeScene(wrap);

    function currentSize() {
      // Match the same responsive board footprint the 2D layout uses
      // (src/main.js computeLayout(): maxW = min(innerWidth-24, 480), square).
      const size = Math.min(window.innerWidth - 24, 480);
      return { width: size, height: size };
    }

    function resizeToViewport() {
      const { width, height } = currentSize();
      wrap.style.width = width + 'px';
      wrap.style.height = height + 'px';
      handle.resize(width, height);
    }
    resizeToViewport();
    window.addEventListener('resize', resizeToViewport);

    // Pulls the live src/core.js game state (the SAME state object real
    // Canvas 2D pointer-drag input mutates via src/main.js's
    // performPlacement -> core.js placePiece) and mirrors it onto the 3D
    // cube meshes + DOM tray/queue overlay. window.__fractureDebug is set at
    // the bottom of src/main.js's synchronous top-level module code; both
    // <script type="module"> tags in index.html execute in document order
    // (main.js before threeBootstrap.js), so it's already present by the
    // time this module runs -- the `debug &&` guard below is defensive only
    // (e.g. if main.js's own script tag is ever reordered or fails to load).
    function syncFromGameState() {
      const debug = window.__fractureDebug;
      if (!debug) return;
      const state = debug.getState();
      handle.setBoardState(state.board);
      renderTrayQueueOverlay(state);
    }

    function loop() {
      syncFromGameState();
      handle.render();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // Verification/QA hook, matching the existing window.__fractureDebug
    // pattern (src/main.js) so headless/windowed Playwright scripts can
    // assert on scene contents without scraping internals ad hoc.
    window.__threeDebug = {
      cubeCount: () => handle.cubes.length,
      cubePositions: () => handle.cubes.map((c) => ({ r: c.r, c: c.c, x: c.mesh.position.x, y: c.mesh.position.y, z: c.mesh.position.z })),
      cameraType: () => handle.camera.type,
      cameraPosition: () => ({ x: handle.camera.position.x, y: handle.camera.position.y, z: handle.camera.position.z }),
      lightCount: () => handle.scene.children.filter((o) => o.isLight).length,
      canvas: () => handle.renderer.domElement,
      renderOnce: () => handle.render(),
      // mascot-prop-placement additions:
      ledgePosition: () => ({ x: handle.ledge.position.x, y: handle.ledge.position.y, z: handle.ledge.position.z }),
      mascotsReady: () => handle.mascotsLoaded.then(() => true),
      mascotCount: () => handle.mascots.length,
      mascotInfo: () =>
        handle.mascots.map((m) => ({
          name: m.name,
          x: m.root.position.x,
          y: m.root.position.y,
          z: m.root.position.z,
          scale: m.root.scale.x,
        })),
      // texture-to-material-mapping additions:
      materialsReady: () => handle.materialsReadyPromise,
      backdropTextureReady: () => handle.backdropTextureLoaded,
      materialsFailed: () => handle.isMaterialsFailed(),
      backdropTextureFailed: () => handle.isBackdropTextureFailed(),
      cubeFamilies: () => handle.cubes.map((c) => ({ r: c.r, c: c.c, family: c.family })),
      backdropHasMap: () => !!handle.ground.material.map,
      // gameplay-state-wiring additions: assert the 3D scene + DOM overlay
      // genuinely mirror live src/core.js state, not just their own internal
      // consistency.
      forceSync: () => syncFromGameState(),
      cubeVisibility: () => handle.cubes.map((c) => ({ r: c.r, c: c.c, visible: c.mesh.visible, family: c.family })),
      visibleCubeCount: () => handle.cubes.filter((c) => c.mesh.visible).length,
      queueOverlayLabel: () => document.getElementById('three-queue-label')?.textContent ?? null,
      trayOverlayLabel: () => document.getElementById('three-tray-label')?.textContent ?? null,
      queueOverlayFilledCount: () => document.querySelectorAll('#three-queue-slots .three-slot:not(.dashed)').length,
      queueOverlaySlotCount: () => document.querySelectorAll('#three-queue-slots .three-slot').length,
      trayOverlaySlotCount: () => document.querySelectorAll('#three-tray-slots .three-slot').length,
      trayOverlayFilledCount: () => document.querySelectorAll('#three-tray-slots .three-slot:not(.dashed)').length,
    };
  }
}
