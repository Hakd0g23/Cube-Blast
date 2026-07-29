// Permanent regression test for the Three.js live-gameplay path, which became
// the DEFAULT renderer as of the "default-renderer-cutover" workstream (see
// .claude/state/progress.md, "Phase: Three.js live-gameplay cutover"). Every
// prior verification pass for this path (gameplay-state-wiring,
// input-raycasting, juice-effects-port, default-renderer-cutover,
// cutover-qa-verification) used a THROWAWAY Playwright script and flagged the
// same gap every time: no permanent committed regression test existed for the
// path every real player now gets by default. This file closes that gap.
//
// Follows tests/drag-resize.playwright.mjs's own conventions: self-contained
// static file server started in-process on an ephemeral port (no external
// http-server/serve dependency), assert from node:assert/strict, a small
// test(name, fn) runner, clear pass/fail console output, non-zero exit on
// failure.
//
// Run with: node tests/threejs-gameplay.playwright.mjs
// Requires: `npm install` (playwright devDependency).

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.gltf': 'application/json',
  '.bin': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/') p = '/index.html';
        const full = path.join(ROOT, p);
        const data = await readFile(full);
        const ext = path.extname(full);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch (e) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log('       ' + (e && e.stack ? e.stack : e));
  }
}

// Filters the one confirmed-benign, pre-existing console.error this project's
// own cutover-qa-verification pass already identified: an AdSense report-only
// CSP frame-ancestors violation that fires independently of any gameplay
// interaction on longer-running sessions. Every other console error/pageerror
// still fails the run -- this does not weaken "zero errors" for this
// project's own code.
function isBenignAdsenseNoise(text) {
  return /frame-ancestors|adsbygoogle/i.test(text);
}

function attachErrorCollector(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isBenignAdsenseNoise(msg.text())) errors.push('console: ' + msg.text());
  });
  page.on('pageerror', (err) => {
    const text = String(err && err.stack ? err.stack : err);
    if (!isBenignAdsenseNoise(text)) errors.push('pageerror: ' + text);
  });
  return errors;
}

// Dispatches a real PointerEvent sequence (down/move.../up) with an explicit
// pointerType, so a genuine 'touch' drag can be exercised even though
// Playwright's own touchscreen API doesn't support pointerType (same
// established pattern this project's input-raycasting/cutover-qa-verification
// throwaway scripts used, per progress.md).
async function dispatchPointerDrag(page, fromEl, toPoints, pointerType) {
  await page.evaluate(
    ({ fromSelector, toPoints, pointerType }) => {
      function fire(target, type, x, y) {
        const ev = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType,
          isPrimary: true,
        });
        target.dispatchEvent(ev);
      }
      const fromEl = document.querySelector(fromSelector);
      const fromRect = fromEl.getBoundingClientRect();
      const fx = fromRect.left + fromRect.width / 2;
      const fy = fromRect.top + fromRect.height / 2;
      fire(fromEl, 'pointerdown', fx, fy);
      for (const [x, y] of toPoints) fire(window, 'pointermove', x, y);
      const [lastX, lastY] = toPoints[toPoints.length - 1];
      fire(window, 'pointerup', lastX, lastY);
    },
    { fromSelector: fromEl, toPoints, pointerType }
  );
}

async function main() {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  // ---------------------------------------------------------------------
  await test('fresh load (default, no flag): __threeDebug exists, zero errors, everything reports ready', async () => {
    const page = await browser.newPage();
    const errors = attachErrorCollector(page);
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => !!window.__threeDebug, null, { timeout: 10000 });
    await page.waitForFunction(
      () => window.__threeDebug.materialsReady && window.__threeDebug.backdropTextureReady,
      null,
      { timeout: 10000 }
    );
    const ready = await page.evaluate(async () => {
      const d = window.__threeDebug;
      const [materialsOk, backdropOk] = await Promise.all([d.materialsReady(), d.backdropTextureReady()]);
      return {
        materialsOk,
        backdropOk,
        materialsFailed: d.materialsFailed(),
        backdropTextureFailed: d.backdropTextureFailed(),
        cubeCount: d.cubeCount(),
        cameraType: d.cameraType(),
      };
    });
    assert.equal(ready.materialsOk, true, 'materials should report ready');
    assert.equal(ready.backdropOk, true, 'backdrop should report ready');
    assert.equal(ready.materialsFailed, false);
    assert.equal(ready.backdropTextureFailed, false);
    assert.equal(ready.cubeCount, 64);
    assert.equal(ready.cameraType, 'OrthographicCamera');
    // Confirm Three.js is genuinely the active renderer, not just present.
    const mount = await page.evaluate(() => ({
      wrapDisplay: getComputedStyle(document.getElementById('three-stage-wrap')).display,
      stageVisibility: getComputedStyle(document.getElementById('stage')).visibility,
    }));
    assert.equal(mount.wrapDisplay, 'block');
    assert.equal(mount.stageVisibility, 'hidden');
    assert.deepEqual(errors, [], `expected zero console/page errors, got: ${JSON.stringify(errors)}`);
    await page.close();
  });

  // ---------------------------------------------------------------------
  await test('real mouse drag: pick up a tray piece and drop it onto a valid empty cell', async () => {
    const page = await browser.newPage();
    const errors = attachErrorCollector(page);
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => !!window.__threeDebug);
    await page.evaluate(async () => {
      const d = window.__threeDebug;
      await Promise.all([d.materialsReady(), d.backdropTextureReady()]);
    });

    const boardBefore = await page.evaluate(() => window.__fractureDebug.getState().board.map((row) => row.map((c) => !!c)));
    const occupiedBefore = boardBefore.flat().filter(Boolean).length;

    // Read both rects synchronously inside a single page.evaluate() rather
    // than via a Playwright locator/element handle: #three-tray-slots is
    // rebuilt from scratch (innerHTML='') every single rAF frame by
    // renderTrayQueueOverlay, so a locator's element handle can go stale
    // (detached) between resolving and reading its bounding box, silently
    // returning null instead of throwing -- the exact gotcha this project's
    // own cutover-qa-verification pass documented and fixed the same way.
    const { slotBox, canvasBox } = await page.evaluate(() => {
      const slotEl = document.querySelector('#three-tray-slots .three-tray-slot:not(.dashed)');
      const slotRect = slotEl.getBoundingClientRect();
      const c = window.__threeDebug.canvas();
      const canvasRect = c.getBoundingClientRect();
      return {
        slotBox: { x: slotRect.left + slotRect.width / 2, y: slotRect.top + slotRect.height / 2 },
        canvasBox: { x: canvasRect.left + canvasRect.width / 2, y: canvasRect.top + canvasRect.height / 2 },
      };
    });

    await page.mouse.move(slotBox.x, slotBox.y);
    await page.mouse.down();
    // Confirm the drag lifecycle genuinely engages mid-drag before releasing.
    await page.mouse.move(canvasBox.x, canvasBox.y, { steps: 6 });
    const mid = await page.evaluate(() => ({
      isDragging: window.__threeDebug.isDragging(),
      previewVisibleCount: window.__threeDebug.previewVisibleCount(),
      floatingPieceVisible: window.__threeDebug.floatingPieceVisible(),
    }));
    assert.equal(mid.isDragging, true);
    assert.ok(mid.previewVisibleCount > 0, 'expected a visible placement-preview mesh mid-drag');
    assert.equal(mid.floatingPieceVisible, true);

    await page.mouse.up();
    await page.waitForTimeout(100);

    const after = await page.evaluate(() => ({
      isDragging: window.__threeDebug.isDragging(),
      board: window.__fractureDebug.getState().board.map((row) => row.map((c) => !!c)),
    }));
    assert.equal(after.isDragging, false, 'drag state should be cleared after release');
    const occupiedAfter = after.board.flat().filter(Boolean).length;
    assert.ok(occupiedAfter > occupiedBefore, 'expected the board to gain at least one newly occupied cell from the real drag');

    assert.deepEqual(errors, [], `expected zero console/page errors, got: ${JSON.stringify(errors)}`);
    await page.close();
  });

  // ---------------------------------------------------------------------
  await test('forced line clear: a real shard arc fires and resolves', async () => {
    const page = await browser.newPage();
    const errors = attachErrorCollector(page);
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => !!window.__threeDebug);
    await page.evaluate(async () => {
      await Promise.all([
        window.__threeDebug.materialsReady(),
        window.__threeDebug.backdropTextureReady(),
      ]);
    });

    // Direct board setup (matching cutover-qa-verification's own throwaway-
    // script precedent): fill an entire row except one cell, place a mono
    // piece into the gap to force a real, deterministic single-line clear.
    const result = await page.evaluate(() => {
      const debug = window.__fractureDebug;
      const state = debug.getState();
      const targetRow = 4;
      for (let c = 0; c < 8; c++) {
        state.board[targetRow][c] = c === 0 ? null : { color: '#8e44ad' };
      }
      state.tray[0] = { shape: [[0, 0]], color: '#8e44ad', shapeId: 'mono' };
      const res = debug.placePiece(0, targetRow, 0);
      return { res };
    });
    assert.equal(result.res.ok, true, 'expected the forced placement to succeed');
    assert.equal(result.res.lineCount, 1, 'expected exactly one line clear from the forced setup');

    // Confirm a shard arc genuinely fired shortly after (before it can have
    // resolved) -- read in the same evaluate call as the trigger to avoid
    // eating the effect's own short window in cross-call IPC latency (a real
    // gotcha this project's own cutover-qa-verification pass documented).
    const shardArcCountSoonAfter = await page.evaluate(() => window.__threeDebug.shardArcCount());
    assert.ok(shardArcCountSoonAfter > 0, 'expected at least one shard arc in flight right after the forced clear');

    // Wait out the worst-case 1.8x time-dilated shard-arc window (matching
    // this project's own documented ~650ms worst case for a "big clear")
    // before asserting it genuinely resolves rather than getting stuck.
    await page.waitForTimeout(700);
    const shardArcCountAfter = await page.evaluate(() => window.__threeDebug.shardArcCount());
    assert.equal(shardArcCountAfter, 0, 'expected the shard arc to have fully resolved by 700ms');

    assert.deepEqual(errors, [], `expected zero console/page errors, got: ${JSON.stringify(errors)}`);
    await page.close();
  });

  // ---------------------------------------------------------------------
  await test('forced game-over: a genuine no-fit board fires the death sequence and shows the Game Over overlay', async () => {
    const page = await browser.newPage();
    const errors = attachErrorCollector(page);
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => !!window.__threeDebug);
    await page.evaluate(async () => {
      await Promise.all([
        window.__threeDebug.materialsReady(),
        window.__threeDebug.backdropTextureReady(),
      ]);
    });

    const result = await page.evaluate(() => {
      const debug = window.__fractureDebug;
      const state = debug.getState();

      // Corrected checkerboard-plus-one-carved-domino-opening construction
      // (per progress.md's "cutover-qa-verification" notes -- an earlier
      // attempt using a naive "fill all but one cell" or a dense sparse-gap
      // pattern accidentally self-cleared or produced already-complete
      // lines instead of reaching game-over):
      //
      // 1. Start from a true 8x8 checkerboard: (r+c) even -> filled,
      //    (r+c) odd -> empty. Every empty cell's orthogonal neighbors are
      //    all filled (parity flips on every step), so every gap is already
      //    an isolated single cell -- no domino/tromino/etc. fits anywhere.
      // 2. To create exactly one legal domino-shaped opening without
      //    merging into a larger connected region: empty the filled corner
      //    (0,0) (creates an L-tromino gap with its two already-empty
      //    neighbors (0,1)/(1,0)), then re-fill (1,0) -- this removes it
      //    from the gap, leaving a clean isolated 2-cell domino gap at
      //    exactly {(0,0),(0,1)}, with none of row0/col0 becoming fully
      //    filled either before or after the triggering placement (verified
      //    below via the placement's own lineCount).
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          state.board[r][c] = (r + c) % 2 === 0 ? { color: '#607d8b' } : null;
        }
      }
      state.board[0][0] = null;
      state.board[0][1] = null;
      state.board[1][0] = { color: '#607d8b' };

      // Slot 0: the one legal move (the domino-shaped gap). Slots 1/2:
      // multi-cell pieces that cannot fit any of the remaining isolated
      // single-cell gaps, so canPlaceAnySlot() is genuinely false once slot
      // 0 is committed (and no tray refill fires, since maybeRefillTray only
      // triggers once ALL slots are empty -- these stay non-null).
      state.tray[0] = { shape: [[0, 0], [0, 1]], color: '#e67e22', shapeId: 'domino_h' };
      state.tray[1] = { shape: [[0, 0], [0, 1], [1, 0], [1, 1]], color: '#e67e22', shapeId: 'square2' };
      state.tray[2] = { shape: [[0, 0], [0, 1], [1, 0], [1, 1]], color: '#e67e22', shapeId: 'square2' };
      state.shardQueue = [];
      state.mercyChargesRemaining = 0;

      const res = debug.placePiece(0, 0, 0);
      return {
        res,
        gameOverImmediately: state.gameOver,
      };
    });

    assert.equal(result.res.ok, true, 'expected the triggering placement itself to succeed');
    assert.equal(result.res.lineCount, 0, 'expected the triggering placement to NOT itself clear a line (would invalidate the scenario)');

    const midSequence = await page.evaluate(() => ({
      gameOver: window.__fractureDebug.getState().gameOver,
      isDeathSequenceActive: window.__threeDebug.isDeathSequenceActive(),
    }));
    assert.equal(midSequence.gameOver, true, 'expected state.gameOver to be true (no legal move left)');
    assert.equal(midSequence.isDeathSequenceActive, true, 'expected the 3D death sequence to be active shortly after game-over fires');

    // Documented budget: ~720ms death sequence (desaturate + shake + freeze)
    // plus the 180ms CSS overlay fade -- wait generously past that.
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => ({
      overlayShown: document.getElementById('overlay').classList.contains('show'),
      isDeathSequenceActive: window.__threeDebug.isDeathSequenceActive(),
    }));
    assert.equal(after.overlayShown, true, 'expected the Game Over overlay to show within its documented budget');
    assert.equal(after.isDeathSequenceActive, false, 'expected the 3D death sequence to have finished by the time the overlay shows');

    assert.deepEqual(errors, [], `expected zero console/page errors, got: ${JSON.stringify(errors)}`);
    await page.close();
  });

  // ---------------------------------------------------------------------
  await test('pause mid-effect: real Three.js state genuinely freezes, not just visually', async () => {
    const page = await browser.newPage();
    const errors = attachErrorCollector(page);
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => !!window.__threeDebug);
    await page.evaluate(async () => {
      await Promise.all([
        window.__threeDebug.materialsReady(),
        window.__threeDebug.backdropTextureReady(),
      ]);
    });

    // Force a real clear (landing anim + shard arc in flight), matching
    // juice-effects-port's/cutover-qa-verification's own precedent for this
    // exact check.
    const setup = await page.evaluate(() => {
      const debug = window.__fractureDebug;
      const state = debug.getState();
      const targetRow = 5;
      for (let c = 0; c < 8; c++) {
        state.board[targetRow][c] = c === 0 ? null : { color: '#16a085' };
      }
      // A cell outside the row being cleared, so a sample target still
      // exists on the board once the triggering row is wiped by the clear
      // (the row itself is emptied synchronously by placePiece, and nothing
      // else was on the board before this setup ran).
      state.board[0][0] = { color: '#2c3e50' };
      state.tray[0] = { shape: [[0, 0]], color: '#16a085', shapeId: 'mono' };
      const res = debug.placePiece(0, targetRow, 0);
      // Find a currently-occupied cell to sample color from throughout.
      let sampleCell = null;
      for (let r = 0; r < 8 && !sampleCell; r++) {
        for (let c = 0; c < 8 && !sampleCell; c++) {
          if (state.board[r][c]) sampleCell = { r, c };
        }
      }
      return { res, sampleCell };
    });
    assert.equal(setup.res.ok, true);
    assert.ok(setup.sampleCell, 'expected at least one occupied cell to sample a color from');

    const { r: sr, c: sc } = setup.sampleCell;

    await page.evaluate(() => window.__fractureDebug.setPaused(true));
    const before = await page.evaluate(
      ({ sr, sc }) => ({
        landingAnimCount: window.__threeDebug.landingAnimCount(),
        shardArcCount: window.__threeDebug.shardArcCount(),
        cubeColor: window.__threeDebug.cubeColor(sr, sc),
        pixelBuffer: window.__threeDebug.canvas().toDataURL(),
      }),
      { sr, sc }
    );

    await page.waitForTimeout(400);

    const after = await page.evaluate(
      ({ sr, sc }) => ({
        landingAnimCount: window.__threeDebug.landingAnimCount(),
        shardArcCount: window.__threeDebug.shardArcCount(),
        cubeColor: window.__threeDebug.cubeColor(sr, sc),
        pixelBuffer: window.__threeDebug.canvas().toDataURL(),
        isPaused: window.__fractureDebug.isPaused(),
      }),
      { sr, sc }
    );

    assert.equal(after.landingAnimCount, before.landingAnimCount, 'landingAnimCount should be frozen while paused');
    assert.equal(after.shardArcCount, before.shardArcCount, 'shardArcCount should be frozen while paused');
    assert.deepEqual(after.cubeColor, before.cubeColor, 'sampled cube color should be byte-identical while paused');
    assert.equal(after.pixelBuffer, before.pixelBuffer, 'the actual rendered pixel buffer should be byte-identical across the paused gap');
    assert.equal(after.isPaused, true, 'should still be paused (sanity check on the test itself)');

    await page.evaluate(() => window.__fractureDebug.setPaused(false));
    const resumed = await page.evaluate(() => window.__fractureDebug.isPaused());
    assert.equal(resumed, false, 'should resume cleanly with no errors');

    assert.deepEqual(errors, [], `expected zero console/page errors, got: ${JSON.stringify(errors)}`);
    await page.close();
  });

  // ---------------------------------------------------------------------
  await test('genuine touch-style drag (pointerType: touch) places a piece successfully', async () => {
    const page = await browser.newPage();
    const errors = attachErrorCollector(page);
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => !!window.__threeDebug);
    await page.evaluate(async () => {
      await Promise.all([
        window.__threeDebug.materialsReady(),
        window.__threeDebug.backdropTextureReady(),
      ]);
    });

    const boardBefore = await page.evaluate(() => window.__fractureDebug.getState().board.map((row) => row.map((c) => !!c)));
    const occupiedBefore = boardBefore.flat().filter(Boolean).length;

    const canvasCenter = await page.evaluate(() => {
      const c = window.__threeDebug.canvas();
      const r = c.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });

    await dispatchPointerDrag(
      page,
      '#three-tray-slots .three-tray-slot:not(.dashed)',
      [canvasCenter, canvasCenter],
      'touch'
    );
    await page.waitForTimeout(100);

    const after = await page.evaluate(() => ({
      isDragging: window.__threeDebug.isDragging(),
      board: window.__fractureDebug.getState().board.map((row) => row.map((c) => !!c)),
    }));
    assert.equal(after.isDragging, false, 'drag state should be cleared after a touch release');
    const occupiedAfter = after.board.flat().filter(Boolean).length;
    assert.ok(occupiedAfter > occupiedBefore, 'expected a real touch-driven drag to place a piece (board gained an occupied cell)');

    assert.deepEqual(errors, [], `expected zero console/page errors, got: ${JSON.stringify(errors)}`);
    await page.close();
  });

  // ---------------------------------------------------------------------
  await test('?legacy2d=1 still loads and is a fully functional fallback', async () => {
    const page = await browser.newPage();
    const errors = attachErrorCollector(page);
    await page.goto(`${base}/index.html?legacy2d=1`);
    await page.waitForFunction(() => !!window.__fractureDebug && !!window.__fractureDebug.geometry());

    const mount = await page.evaluate(() => ({
      threeDebugExists: !!window.__threeDebug,
      wrapDisplay: getComputedStyle(document.getElementById('three-stage-wrap')).display,
      stageVisibility: getComputedStyle(document.getElementById('stage')).visibility,
    }));
    assert.equal(mount.threeDebugExists, false, 'window.__threeDebug should not exist under ?legacy2d=1');
    assert.equal(mount.wrapDisplay, 'none');
    assert.equal(mount.stageVisibility, 'visible');

    // Basic interactivity sanity check (not a full re-test of
    // drag-resize.playwright.mjs's own territory): a real pointer drag from
    // the tray onto the board, using the 2D canvas's own exact geometry hook
    // (matches tests/drag-resize.playwright.mjs's own established pattern).
    const info = await page.evaluate(() => {
      const g = window.__fractureDebug.geometry();
      const state = window.__fractureDebug.getState();
      const piece = state.tray[0];
      let maxR = 0, maxC = 0;
      for (const [r, c] of piece.shape) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
      const rect = document.getElementById('stage').getBoundingClientRect();
      return {
        traySlot0: g.traySlotCenter(0),
        target: g.gridCellCenter(2, 2),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        canvasWidth: g.canvasWidth,
        canvasHeight: g.canvasHeight,
      };
    });
    const toClient = (pt) => ({
      x: info.rect.left + pt.x * (info.rect.width / info.canvasWidth),
      y: info.rect.top + pt.y * (info.rect.height / info.canvasHeight),
    });
    const from = toClient(info.traySlot0);
    const to = toClient(info.target);
    const boardBefore = await page.evaluate(() => JSON.stringify(window.__fractureDebug.getState().board));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    const boardAfter = await page.evaluate(() => JSON.stringify(window.__fractureDebug.getState().board));
    assert.notEqual(boardAfter, boardBefore, 'expected the legacy 2D canvas to accept a real pointer-drag placement');

    assert.deepEqual(errors, [], `expected zero console/page errors, got: ${JSON.stringify(errors)}`);
    await page.close();
  });

  await browser.close();
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
