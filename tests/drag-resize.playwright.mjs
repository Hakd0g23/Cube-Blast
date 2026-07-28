// Regression test for GitHub issue #1: endDrag(e) must re-sample the
// pointer position from the pointerup event instead of trusting the
// stale drag.x/drag.y left over from the last pointermove. A window
// resize (or, on mobile, an orientation change) between the last move
// and the release -- with zero pointer movement in between -- changes
// `layout`/canvas rect/DPR scaling; if endDrag doesn't re-derive the
// point, the drop cell is computed against stale pre-resize geometry.
//
// This is a real browser integration test (not a unit test) since the
// bug only manifests through the actual DOM pointer event pipeline
// (canvas.getBoundingClientRect(), window resize timing, etc.).
//
// Run with: node tests/drag-resize.playwright.mjs
// Requires: `npm install` (installs the `playwright` devDependency) and
// a static file server serving the repo root (this script starts one
// itself on an ephemeral port, no separate setup needed).

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

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

// Reproduces (in-browser, via page.evaluate) the exact math dragTargetCell()
// uses in src/main.js, so we can predict, from ground truth (rect + layout
// captured directly from the live page), which cell a given screen point
// SHOULD map to under the layout in effect at release time. We do not touch
// pointFromEvent/dragTargetCell's own correctness here -- those are existing,
// unit-testable, unchanged by this fix -- we only use their published formula
// to compute an independent expectation to compare the actual game-state
// outcome against.
function predictedCell(rect, layout, cellSize, ext, clientX, clientY) {
  const scaleX = layout.width / rect.width;
  const scaleY = layout.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  // NOTE: dragTargetCell() in src/main.js resolves the drop cell against the
  // same lifted position the piece is rendered at (see TOUCH_VISUAL_LIFT /
  // dragVisualLift), but that lift only applies for pointerType 'touch'.
  // This test drives page.mouse, i.e. pointerType 'mouse', which never gets
  // a lift, so the formula below (no lift) still matches.
  const ox = x - (ext.cols * cellSize) / 2;
  const oy = y - (ext.rows * cellSize) / 2;
  const c = Math.round((ox - layout.gridX) / cellSize);
  const r = Math.round((oy - layout.gridY) / cellSize);
  return { r, c };
}

async function main() {
  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch();

  await test('resize-during-drag: pointerup lands on the CURRENT-layout cell, not the stale pre-resize one (issue #1)', async () => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 300, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => !!window.__fractureDebug && !!window.__fractureDebug.geometry());

    // Grab layout A (pre-resize) ground truth straight from the live page,
    // by reverse-deriving gridX/gridY/cellSize from two grid-cell centers
    // (avoids needing new debug internals beyond the existing QA hook).
    const layoutInfoA = await page.evaluate(() => {
      const g = window.__fractureDebug.geometry();
      const c00 = g.gridCellCenter(0, 0);
      const c10 = g.gridCellCenter(1, 0);
      const cellSize = c10.y - c00.y;
      const gridX = c00.x - cellSize / 2;
      const gridY = c00.y - cellSize / 2;
      const rect = document.getElementById('stage').getBoundingClientRect();
      const state = window.__fractureDebug.getState();
      const piece = state.tray[0];
      let maxR = 0, maxC = 0;
      for (const [r, c] of piece.shape) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
      return {
        layout: { width: g.canvasWidth, height: g.canvasHeight, gridX, gridY },
        cellSize,
        ext: { rows: maxR + 1, cols: maxC + 1 },
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        traySlot0: g.traySlotCenter(0),
      };
    });

    // Pick a target cell (well inside the board) and compute the exact
    // client-space point that -- under layout A -- makes dragTargetCell()
    // land precisely on it. This is the "last pointermove" position.
    const targetA = { r: 2, c: 2 };
    const { layout: layoutA, cellSize: sA, ext, rect: rectA } = layoutInfoA;
    const dragXA = layoutA.gridX + targetA.c * sA + (ext.cols * sA) / 2;
    const dragYA = layoutA.gridY + targetA.r * sA + (ext.rows * sA) / 2;
    // Invert pointFromEvent's scaling (scale is ~1 here since rect.width ===
    // layout.width, but do it properly so this doesn't silently assume that).
    const clientX = rectA.left + dragXA * (rectA.width / layoutA.width);
    const clientY = rectA.top + dragYA * (rectA.height / layoutA.height);

    // Start the drag and move to the computed point -- this is the "last
    // pointermove" before the resize, matching the bug report exactly.
    // traySlot0 is in logical/canvas-space; convert to client/screen space
    // via the canvas rect (same relationship pointFromEvent relies on).
    const traySlotClientX = rectA.left + layoutInfoA.traySlot0.x * (rectA.width / layoutA.width);
    const traySlotClientY = rectA.top + layoutInfoA.traySlot0.y * (rectA.height / layoutA.height);
    await page.mouse.move(traySlotClientX, traySlotClientY);
    await page.mouse.down();
    await page.mouse.move(clientX, clientY, { steps: 1 });

    // Sanity check: confirm the move alone (no resize) really would have
    // targeted targetA under layout A, so the test's own math is right
    // before we even get to the bug scenario.
    // (dragTargetCell isn't directly exposed; we trust the derivation above
    // since it's the published formula from src/main.js lines 486-495.)

    // Resize the window -- changes layout (gridX/gridY/cellSize) with ZERO
    // pointer movement afterward, exactly the repro from the bug report.
    await page.setViewportSize({ width: 460, height: 900 });
    // Let main.js's resize listener (computeLayout(); draw();) run.
    await page.waitForTimeout(50);

    // Capture ground truth for layout B (post-resize) directly from the page,
    // and predict where THIS release, at the SAME client point, should land
    // under the current (post-resize) layout.
    const layoutInfoB = await page.evaluate(() => {
      const g = window.__fractureDebug.geometry();
      const c00 = g.gridCellCenter(0, 0);
      const c10 = g.gridCellCenter(1, 0);
      const cellSize = c10.y - c00.y;
      const gridX = c00.x - cellSize / 2;
      const gridY = c00.y - cellSize / 2;
      const rect = document.getElementById('stage').getBoundingClientRect();
      return {
        layout: { width: g.canvasWidth, height: g.canvasHeight, gridX, gridY },
        cellSize,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    });

    // Confirm the test setup actually exercises a layout change (otherwise
    // this test would pass vacuously even with the bug present).
    assert.notEqual(layoutInfoB.cellSize, sA, 'test setup sanity: resize must actually change cellSize, or this test proves nothing');

    const expected = predictedCell(layoutInfoB.rect, layoutInfoB.layout, layoutInfoB.cellSize, ext, clientX, clientY);
    assert.notDeepEqual(expected, targetA, 'test setup sanity: resize must change the predicted drop cell, or this test proves nothing');

    const boardBefore = await page.evaluate(() => JSON.parse(JSON.stringify(window.__fractureDebug.getState().board)));

    // Release with ZERO intervening pointermove -- the exact repro.
    await page.mouse.up();
    await page.waitForTimeout(50);

    const stateAfter = await page.evaluate(() => window.__fractureDebug.getState());
    const boardAfter = stateAfter.board;

    // Find which cells got newly filled by this drop.
    const filled = [];
    for (let r = 0; r < boardAfter.length; r++) {
      for (let c = 0; c < boardAfter[r].length; c++) {
        if (!boardBefore[r][c] && boardAfter[r][c]) filled.push({ r, c });
      }
    }
    assert.ok(filled.length > 0, 'expected the drop to place the piece somewhere on the board');

    // The piece's own top-left anchor should be at (expected.r, expected.c)
    // (dragTargetCell returns the anchor cell that placePiece uses).
    const minR = Math.min(...filled.map(f => f.r));
    const minC = Math.min(...filled.map(f => f.c));

    assert.deepEqual(
      { r: minR, c: minC },
      expected,
      `piece should drop at the CURRENT-layout cell ${JSON.stringify(expected)} (matching the pointer's real on-screen position post-resize), ` +
      `not the stale pre-resize cell ${JSON.stringify(targetA)}. Got {r:${minR}, c:${minC}}.`
    );

    await page.close();
  });

  await browser.close();
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
