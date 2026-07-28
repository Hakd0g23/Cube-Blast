// Cube Blast — entry point for the Three.js scene/camera/lighting/gameplay
// renderer. As of default-renderer-cutover (2026-07-28), Three.js is the
// PRIMARY renderer: it mounts by default (no query flag needed). The old
// Canvas 2D renderer (src/main.js's own draw()/pointer-drag code) is now the
// opt-out path, gated behind `?legacy2d=1` -- when that flag is present, this
// module does nothing at all and the shipping Canvas 2D game runs exactly as
// it always has. src/main.js itself keeps running unconditionally in BOTH
// modes regardless of this flag: it owns the core game state (core.js),
// leaderboard, settings, pause, and the window.__fractureDebug hook this
// module depends on to mirror state into the 3D scene -- only its OWN
// canvas's visuals/input are what get hidden/inert when Three.js is active
// (src/main.js's canvas pointer handlers are harmless no-ops once #stage is
// hidden via visibility:hidden, since a hidden canvas never receives pointer
// events -- confirmed, not assumed, during this cutover's verification).
import { createThreeScene } from './threeScene.js';
import { QUEUE_CAP, canPlaceAt } from './core.js';
import { FAMILY_BY_COLOR } from './blockTextureConfig.js';

const LEGACY_2D = new URLSearchParams(location.search).has('legacy2d');
const THREE_PREVIEW = !LEGACY_2D;

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

// Square-cell sizing, ported from src/main.js's own tray/queue draw code
// (shapeExtent + a single square `s` = min(availW/cols, availH/rows[, cap]))
// -- the DOM overlay used to stretch each cell to fill separate 1fr grid
// tracks per axis, which is fine for square shapes but turns a 1x3 piece
// into three tall skinny slivers instead of three square blocks. Sizing the
// mini container itself (in % of the slot's own design width/height, which
// stays proportional at any responsive scale since slot aspect-ratio is
// locked in CSS) keeps every cell square regardless of shape.
function squareCellFraction(ext, slotDesignW, slotDesignH, marginPx, capPx) {
  const availW = slotDesignW - marginPx;
  const availH = slotDesignH - marginPx;
  let s = Math.min(availW / Math.max(ext.cols, 1), availH / Math.max(ext.rows, 1));
  if (capPx) s = Math.min(s, capPx);
  s = Math.max(s, 1);
  return { widthPct: ((ext.cols * s) / slotDesignW) * 100, heightPct: ((ext.rows * s) / slotDesignH) * 100 };
}

function buildMiniPiece(shape, color, slotDesignW, slotDesignH, marginPx, capPx) {
  const ext = shapeExtent(shape);
  const mini = document.createElement('div');
  mini.className = 'three-piece-mini';
  mini.style.gridTemplateColumns = `repeat(${ext.cols}, 1fr)`;
  mini.style.gridTemplateRows = `repeat(${ext.rows}, 1fr)`;
  const { widthPct, heightPct } = squareCellFraction(ext, slotDesignW, slotDesignH, marginPx, capPx);
  mini.style.width = `${widthPct}%`;
  mini.style.height = `${heightPct}%`;
  for (const [r, c] of shape) {
    const cell = document.createElement('div');
    cell.className = 'three-piece-cell';
    cell.style.gridColumn = String(c + 1);
    cell.style.gridRow = String(r + 1);
    const family = FAMILY_BY_COLOR[color];
    if (family) {
      cell.style.backgroundColor = color;
      cell.style.backgroundImage = `url(./assets/blocks/${family}.png)`;
      cell.style.backgroundSize = 'cover';
    } else {
      cell.style.background = color;
    }
    mini.appendChild(cell);
  }
  return mini;
}

// Design units mirroring src/main.js's QUEUE_SLOT/TRAY_SLOT_W/TRAY_SLOT_H
// constants -- the CSS slot sizes (.three-queue-slot/.three-tray-slot) are
// percentage-of-container but locked to these same aspect ratios via
// max-width + aspect-ratio, so these constants stay valid as a proportional
// reference at any responsive scale.
const QUEUE_SLOT_DESIGN = 46;
const TRAY_SLOT_DESIGN_W = 96;
const TRAY_SLOT_DESIGN_H = 86;

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
    if (shard) slot.appendChild(buildMiniPiece(shard.shape, shard.color, QUEUE_SLOT_DESIGN, QUEUE_SLOT_DESIGN, 10));
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
    if (piece) slot.appendChild(buildMiniPiece(piece.shape, piece.color, TRAY_SLOT_DESIGN_W, TRAY_SLOT_DESIGN_H, 16, 18));
    traySlots.appendChild(slot);
  }
}
// ---- input-raycasting (2026-07-28) ----------------------------------------
// Pointer-driven drag/drop against the live 3D scene. Pickup ORIGINATES on a
// DOM tray slot (#three-tray-slots, delegated so it survives the per-frame
// innerHTML rebuild renderTrayQueueOverlay does above) -- per the brief,
// this is a hybrid DOM-source/3D-target interaction, not a fully DOM drag or
// fully in-scene drag. Move/preview/drop-target detection raycasts against
// the 3D board plane (handle.pointerToBoardXY/cellAnchorFromWorld,
// src/threeScene.js) instead of reusing any 2D canvas-space math. Commit
// goes through window.__fractureDebug.placePiece(), the SAME
// performPlacement()->core.js placePiece() path real 2D pointer-drag input
// and the debug hook both already use (see gameplay-state-wiring notes,
// progress.md) -- no placement rule is reimplemented here; canPlaceAt() is
// used ONLY for the live green/red preview color, and placePiece() itself is
// the sole source of truth for whether a placement actually commits (it's
// already a safe no-op returning {ok:false} on an invalid target, so a
// stale/race-y anchor computed here can never corrupt state).
let threeDrag = null; // { trayIndex, piece, slotEl, anchor, valid }
let floatingPieceEl = null;

function updateFloatingPiece(clientX, clientY, piece) {
  if (!floatingPieceEl) {
    floatingPieceEl = document.createElement('div');
    floatingPieceEl.id = 'three-drag-floating-piece';
    document.body.appendChild(floatingPieceEl);
  }
  const ext = shapeExtent(piece.shape);
  floatingPieceEl.style.gridTemplateColumns = `repeat(${ext.cols}, 1fr)`;
  floatingPieceEl.style.gridTemplateRows = `repeat(${ext.rows}, 1fr)`;
  floatingPieceEl.innerHTML = '';
  // Same square-cell sizing as buildMiniPiece: the floating element's outer
  // box is a fixed 72x72 (CSS), but non-square shapes should only fill part
  // of it, not stretch to fill both axes independently.
  const { widthPct, heightPct } = squareCellFraction(ext, 72, 72, 0, 24);
  const boxW = (widthPct / 100) * 72;
  const boxH = (heightPct / 100) * 72;
  floatingPieceEl.style.width = `${boxW}px`;
  floatingPieceEl.style.height = `${boxH}px`;
  for (const [r, c] of piece.shape) {
    const cell = document.createElement('div');
    cell.className = 'three-piece-cell';
    cell.style.gridColumn = String(c + 1);
    cell.style.gridRow = String(r + 1);
    const family = FAMILY_BY_COLOR[piece.color];
    if (family) {
      cell.style.backgroundColor = piece.color;
      cell.style.backgroundImage = `url(./assets/blocks/${family}.png)`;
      cell.style.backgroundSize = 'cover';
    } else {
      cell.style.background = piece.color;
    }
    floatingPieceEl.appendChild(cell);
  }
  // Centered on the pointer, lifted up a bit so touch input isn't hidden
  // under the player's own finger -- same "lift above the touch point"
  // intent as src/main.js's TOUCH_VISUAL_LIFT for the 2D drag, applied
  // unconditionally here since this floating element is always separate
  // from the pointer itself (mouse or touch alike).
  floatingPieceEl.style.left = (clientX - boxW / 2) + 'px';
  floatingPieceEl.style.top = (clientY - boxH / 2 - 46) + 'px';
}

function removeFloatingPiece() {
  if (floatingPieceEl) {
    floatingPieceEl.remove();
    floatingPieceEl = null;
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

    // ---- input-raycasting: drag lifecycle ---------------------------------
    const traySlots = document.getElementById('three-tray-slots');

    function trayIndexOfSlot(slotEl) {
      return Array.prototype.indexOf.call(traySlots.children, slotEl);
    }

    function updateDragPreview(clientX, clientY) {
      if (!threeDrag) return;
      const world = handle.pointerToBoardXY(clientX, clientY);
      if (!world) {
        threeDrag.anchor = null;
        handle.clearPlacementPreview();
        return;
      }
      const ext = shapeExtent(threeDrag.piece.shape);
      const anchor = handle.cellAnchorFromWorld(world.x, world.y, ext);
      const debug = window.__fractureDebug;
      const state = debug ? debug.getState() : null;
      const valid = !!state && canPlaceAt(state.board, threeDrag.piece.shape, anchor.r, anchor.c);
      threeDrag.anchor = anchor;
      threeDrag.valid = valid;
      handle.setPlacementPreview(threeDrag.piece.shape, anchor.r, anchor.c, valid);
    }

    function startDrag(e, slotEl) {
      const debug = window.__fractureDebug;
      if (!debug) return;
      const state = debug.getState();
      if (state.gameOver || debug.isPaused()) return; // matches 2D pointerdown's own guards
      const idx = trayIndexOfSlot(slotEl);
      const piece = state.tray[idx];
      if (idx < 0 || !piece) return;
      threeDrag = { trayIndex: idx, piece, slotEl, anchor: null, valid: false };
      slotEl.classList.add('three-drag-source');
      updateFloatingPiece(e.clientX, e.clientY, piece);
      updateDragPreview(e.clientX, e.clientY);
      e.preventDefault();
    }

    function endDrag() {
      if (!threeDrag) return;
      const { trayIndex, anchor, valid, slotEl } = threeDrag;
      threeDrag = null;
      slotEl.classList.remove('three-drag-source');
      handle.clearPlacementPreview();
      removeFloatingPiece();
      const debug = window.__fractureDebug;
      // Commit via the SAME performPlacement()/core.js placePiece() path the
      // 2D canvas drag and the existing debug hook both use -- placePiece()
      // itself is the single source of truth for validity (it safely no-ops
      // on an out-of-bounds/occupied target), the `valid`/`anchor` computed
      // during the drag are only used to decide whether it's worth calling
      // at all (an anchor that went off-plane, e.g. pointerup outside the
      // canvas entirely, never reaches core.js).
      if (debug && anchor && valid) debug.placePiece(trayIndex, anchor.r, anchor.c);
      syncFromGameState();
    }

    // Pickup: delegated on the stable #three-tray-slots container so it
    // survives renderTrayQueueOverlay's per-frame innerHTML rebuild of its
    // children (see comment above traySlots' declaration).
    traySlots.addEventListener('pointerdown', (e) => {
      const slotEl = e.target.closest('.three-tray-slot');
      if (!slotEl || slotEl.classList.contains('dashed')) return;
      startDrag(e, slotEl);
    });

    // Move/release/cancel are tracked at window level, not on the tray slot
    // or the canvas alone -- the drag needs to keep tracking the pointer
    // across both (over the tray on pickup, over the 3D canvas mid-drag,
    // possibly back off either edge), and pointer capture on a DOM element
    // that itself gets destroyed/rebuilt mid-drag (the tray slot does, every
    // frame) would silently drop capture. window-level listeners sidestep
    // that entirely. Pointer events (not separate mouse/touch handlers) work
    // identically for `pointerType: 'mouse'` and `'touch'`.
    window.addEventListener('pointermove', (e) => {
      if (!threeDrag) return;
      updateFloatingPiece(e.clientX, e.clientY, threeDrag.piece);
      updateDragPreview(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', (e) => {
      if (!threeDrag) return;
      // Re-sample the anchor from the release position itself (matches the
      // 2D endDrag's own "re-sample from the pointerup event" precedent —
      // see src/main.js's endDrag comment) rather than trusting whatever the
      // last pointermove left behind.
      updateDragPreview(e.clientX, e.clientY);
      endDrag();
    });
    window.addEventListener('pointercancel', () => {
      if (!threeDrag) return;
      threeDrag.anchor = null;
      endDrag();
    });

    // ---- juice-effects-port (2026-07-28) -----------------------------------
    // Registers the hooks src/main.js's performPlacement/checkMilestone/
    // refreshChrome call (unconditionally, but as inert optional-chained
    // no-ops when this file's THREE_PREVIEW gate is off) -- this is the SAME
    // trigger point real 2D pointer-drag input and 3D input-raycasting's
    // debug.placePiece() commit both already funnel through, so no placement/
    // clear logic is duplicated here, only the resulting cosmetic effects.
    function queueSlotTargetsWorld(queueLenBefore, newlyQueued) {
      const slotEls = document.querySelectorAll('#three-queue-slots .three-slot');
      const targets = [];
      for (let i = 0; i < newlyQueued; i++) {
        const el = slotEls[queueLenBefore + i];
        if (!el) continue; // matches 2D's own "skip if no queue slot" scope cut (overflow shard went straight to tray)
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const world = handle.pointerToBoardXY(cx, cy);
        if (world) targets.push(world);
      }
      return targets;
    }

    window.__threeJuiceHooks = {
      onPlacement(payload) {
        handle.triggerLandingAnim(payload.cells, payload.r0, payload.c0);
        if (payload.lineCount > 0) {
          // break-effect-pass: the per-cell shatter burst fires for EVERY
          // clear, independent of whether any shard actually got queued
          // (payload.newlyQueued can be 0 -- e.g. an overflow shard skipped
          // the queue straight into the tray) -- it's cosmetic feedback on
          // the cells themselves, not tied to the queue-arc mechanic below.
          handle.triggerBreakEffect(payload.rows, payload.cols, payload.color);
          // mascot-reactions: same "any real clear" gate: humanoids/pets
          // react to a small clear, all four react bigger on a combo/bigClear.
          handle.triggerMascotReact(payload.lineCount, payload.bigClear);
        }
        if (payload.lineCount > 0 && payload.newlyQueued > 0) {
          // Force the DOM queue-slot overlay to reflect the just-committed
          // state BEFORE reading its slot positions -- this hook fires
          // synchronously inside performPlacement, ahead of this file's own
          // next rAF-driven syncFromGameState() call, so the overlay could
          // otherwise still show the pre-placement queue for one frame.
          syncFromGameState();
          const targets = queueSlotTargetsWorld(payload.queueLenBefore, payload.newlyQueued);
          handle.triggerShardArc(payload.rows, payload.cols, payload.color, payload.bigClear, targets);
        }
        if (payload.lineCount > 0 && payload.bigClear) {
          handle.triggerGoldFlash(); // default duration, matches main.js's GOLD_FLASH_MS
          if (payload.lineCount >= 3) handle.triggerZoomPulse();
        }
      },
      onMilestone() {
        handle.triggerGoldFlash(120); // matches main.js's MILESTONE_FLASH_MS
      },
      onDeathSequence() {
        handle.triggerDeathSequence();
      },
    };

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
      // input-raycasting additions:
      isDragging: () => !!threeDrag,
      dragAnchor: () => (threeDrag ? { r: threeDrag.anchor?.r, c: threeDrag.anchor?.c, valid: threeDrag.valid } : null),
      previewVisibleCount: () => handle.previewMeshes.filter((m) => m.visible).length,
      floatingPieceVisible: () => !!document.getElementById('three-drag-floating-piece'),
      // juice-effects-port additions:
      landingAnimCount: () => handle.landingAnimCount(),
      shardArcCount: () => handle.shardArcCount(),
      isGoldFlashActive: () => handle.isGoldFlashActive(),
      isZoomPulseActive: () => handle.isZoomPulseActive(),
      isDeathSequenceActive: () => handle.isDeathSequenceActive(),
      boardGroupScale: () => handle.boardGroupScale(),
      boardGroupPosition: () => handle.boardGroupPosition(),
      cubeColor: (r, c) => handle.cubeColor(r, c),
      // break-effect-pass additions:
      breakFragmentCount: () => handle.breakFragmentCount(),
      isBreakEffectActive: () => handle.isBreakEffectActive(),
      // mascot-reactions additions:
      mascotActiveClip: (name) => handle.mascotActiveClip(name),
      triggerMascotReact: (lineCount, bigClear) => handle.triggerMascotReact(lineCount, bigClear),
    };
  }
}
