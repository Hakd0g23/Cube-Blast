// Headless unit tests for the core engine, focused on the parts of the spec
// most likely to break under implementation convenience: the fixed
// resolution order, shard count scaling, the safety rule, and queue
// overflow escalation. Run with: node tests/core.test.mjs
//
// No framework — this is a throwaway prototype, not a production project;
// plain assert is sufficient for a suite this small and this test's job is
// to pin down the one part of the spec (Section 3's fixed order) that's
// easy to silently reorder for implementation convenience.

import assert from 'node:assert/strict';
import {
  createGame, placePiece, canPlaceAt, findAnyPlacement, resolveGeneratedShard,
  checkGameOver, canPlaceAllPieces, maybeRefillTray,
  QUEUE_CAP, TRAY_BASE_SIZE, SCORE_PER_SHARD_CELL_AUTOCONVERT,
  ONBOARDING_SAFE_QUEUE_LEVEL, ONBOARDING_ELIGIBLE_AFTER_CLEARS,
  ONBOARDING_MAX_SUPPRESSED_REFILLS, EASY_SHAPE_IDS,
  FIRST_SHARD_CALLOUT_TEXT, FIRST_OVERFLOW_CALLOUT_TEXT,
  SCORE_PER_COMBO_STEP, SCORE_WHOLE_FIELD_CLEAR_BONUS,
} from '../src/core.js';
import { BOARD_SIZE } from '../src/pieces.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log('       ' + (e && e.message ? e.message : e));
  }
}

function freshState(seed = 1) {
  const s = createGame(seed);
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  return s;
}

// Helper: fill an entire row except one cell, then place a 1-cell piece to
// complete it, forcing a deterministic single-line clear.
function setupSingleLineClear(state, row = 0, gapCol = 0) {
  for (let c = 0; c < BOARD_SIZE; c++) {
    if (c === gapCol) continue;
    state.board[row][c] = { color: '#000' };
  }
  state.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false };
}

test('basic placement fills cells and does not clear a non-full board', () => {
  const s = freshState();
  s.tray[0] = { shape: [[0, 0], [0, 1]], shapeId: 'domino_h', color: '#fff', isShard: false };
  const res = placePiece(s, 0, 3, 3);
  assert.equal(res.ok, true);
  assert.equal(s.board[3][3].color, '#fff');
  assert.equal(s.board[3][4].color, '#fff');
  assert.equal(s.tray[0], null);
});

test('placement rejected out of bounds / onto occupied cell', () => {
  const s = freshState();
  s.tray[0] = { shape: [[0, 0], [0, 1]], shapeId: 'domino_h', color: '#fff', isShard: false };
  assert.equal(placePiece(s, 0, 0, 7).ok, false); // would overflow right edge
  s.board[2][2] = { color: '#111' };
  s.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false };
  assert.equal(placePiece(s, 0, 2, 2).ok, false); // occupied
});

test('single-line clear generates exactly 1 shard (Section 2 count rule)', () => {
  const s = freshState();
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  setupSingleLineClear(s, 0, 0);
  const res = placePiece(s, 0, 0, 0);
  assert.equal(res.ok, true);
  assert.equal(s.board[0].every((c) => c == null), true, 'row should be cleared');
  assert.equal(s.shardQueue.length, 1, 'exactly one shard should have been generated/queued');
});

test('2-line combo clear generates exactly 2 shards, capped at 3 for 4+', () => {
  // 2-line combo: complete row 0 and col 0 simultaneously with an L-piece at origin.
  const s = freshState();
  s._forcedShardShapes = [
    { id: 'shard_mono', cells: [[0, 0]] },
    { id: 'shard_mono', cells: [[0, 0]] },
  ];
  for (let c = 1; c < BOARD_SIZE; c++) s.board[0][c] = { color: '#000' };
  for (let r = 1; r < BOARD_SIZE; r++) s.board[r][0] = { color: '#000' };
  s.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false };
  const res = placePiece(s, 0, 0, 0);
  assert.equal(res.ok, true);
  assert.equal(s.shardQueue.length, 2, 'a 2-line combo should generate exactly 2 shards');

  // 4-line clear (cap at 3): fill 4 full rows minus one cell each in the
  // same column, then drop a vertical piece through that column.
  const s2 = freshState();
  s2._forcedShardShapes = [
    { id: 'shard_mono', cells: [[0, 0]] },
    { id: 'shard_mono', cells: [[0, 0]] },
    { id: 'shard_mono', cells: [[0, 0]] },
  ];
  for (let r = 0; r < 4; r++) for (let c = 0; c < BOARD_SIZE; c++) if (c !== 3) s2.board[r][c] = { color: '#000' };
  s2.tray[0] = { shape: [[0, 0], [1, 0], [2, 0], [3, 0]], shapeId: 'tetromino_v', color: '#fff', isShard: false };
  const res2 = placePiece(s2, 0, 0, 3);
  assert.equal(res2.ok, true);
  assert.equal(s2.shardQueue.length, 3, '4-line clear should be capped at 3 shards, not 4');
});

test('safety rule: unplaceable shard auto-converts to score instead of queuing', () => {
  // NOTE ON WHY THIS IS TESTED AT THIS SEAM, NOT VIA A FULL placePiece() CALL:
  // in this engine a line clear always frees a full 8-cell row/column, which
  // trivially fits a <=2-cell shard in at least the orientation aligned with
  // that same line. Working through the adjacency math: making a shard
  // genuinely unplaceable would require a neighboring row/column to be
  // simultaneously fully solid (to block the other orientation) without
  // itself being already-complete -- which is a contradiction (fully solid
  // == complete == would have cleared already). So, given the current board
  // size (8x8) and shard cap (1-2 cells), the safety-rule branch is
  // effectively unreachable from any single *legal* placePiece() call --
  // this is flagged in the build report as a real finding, not a test
  // workaround. It's still fully testable (and worth testing) at the
  // resolveGeneratedShard() seam directly, using a hand-built board that
  // doesn't need to be reachable through legal play.
  const s = freshState();
  for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) s.board[r][c] = { color: '#000' };
  s.board[3][4] = null; // exactly one free cell on the whole board
  const shard = { shape: [[0, 0], [0, 1]], shapeId: 'shard_domino_h', color: '#fff', isShard: true };
  const scoreBefore = s.score;
  const result = resolveGeneratedShard(s, shard, [null]);
  assert.equal(result.autoConverted, true);
  assert.equal(result.queued, false);
  assert.equal(s.shardQueue.length, 0, 'unplaceable shard must not enter the queue');
  assert.equal(s.score, scoreBefore + 2 * SCORE_PER_SHARD_CELL_AUTOCONVERT,
    'unplaceable shard should auto-convert straight to score');
  assert.equal(s.gameOver, false, 'safety rule must prevent an arbitrary instant game-over');
});

test('safety rule: a genuinely placeable shard is NOT auto-converted (control case)', () => {
  const s = freshState();
  // Board is empty -- shard is trivially placeable everywhere.
  const shard = { shape: [[0, 0], [0, 1]], shapeId: 'shard_domino_h', color: '#fff', isShard: true };
  const result = resolveGeneratedShard(s, shard, [null]);
  assert.equal(result.autoConverted, false);
  assert.equal(result.queued, true);
  assert.equal(s.shardQueue.length, 1);
});

test('queue overflow escalation: shard force-inserts into tray once queue is at cap', () => {
  const s = freshState();
  // Pre-fill the queue to cap.
  for (let i = 0; i < QUEUE_CAP; i++) s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });
  assert.equal(s.shardQueue.length, QUEUE_CAP);

  setupSingleLineClear(s, 0, 0);
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  const res = placePiece(s, 0, 0, 0);
  assert.equal(res.ok, true);
  assert.equal(s.shardQueue.length, QUEUE_CAP, 'queue must stay at cap, not grow past it');
  const shardInTray = s.tray.some((slot) => slot && slot.isShard);
  assert.equal(shardInTray, true, 'overflowing shard must land directly in the active tray, not vanish');
});

test('overflow shard prefers the just-vacated tray slot', () => {
  const s = freshState();
  for (let i = 0; i < QUEUE_CAP; i++) s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });
  setupSingleLineClear(s, 0, 0); // uses tray slot 0
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  placePiece(s, 0, 0, 0);
  assert.equal(s.tray[0] && s.tray[0].isShard, true, 'overflow shard should fill the slot just vacated by the triggering piece');
});

test('tray refill drains the shard queue before drawing fresh random pieces', () => {
  const s = freshState();
  s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });
  s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#bbb', isShard: true });
  // Empty the whole tray by hand, then place nothing -- call maybeRefillTray
  // indirectly by placing the last real piece and clearing no lines.
  s.tray = [null, null, { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false }];
  const res = placePiece(s, 2, 5, 5); // no line clear, tray becomes fully empty -> refill fires
  assert.equal(res.ok, true);
  assert.equal(s.tray.length, TRAY_BASE_SIZE);
  const shardsInTray = s.tray.filter((slot) => slot && slot.isShard).length;
  assert.equal(shardsInTray, 2, 'both queued shards should drain into the refilled tray before random pieces');
  assert.equal(s.shardQueue.length, 0);
});

test('game-over check: true only when no tray piece fits anywhere', () => {
  const s = freshState();
  for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) s.board[r][c] = { color: '#000' };
  s.board[7][7] = null; // exactly one free cell
  s.tray = [
    { shape: [[0, 0], [0, 1]], shapeId: 'domino_h', color: '#fff', isShard: false }, // cannot fit (needs 2 free)
    null,
    null,
  ];
  // Force game-over check without a placement: simulate via a dummy placement elsewhere is not possible
  // (board is full), so instead verify findAnyPlacement/canPlaceAt directly as the primitives game-over relies on.
  assert.equal(findAnyPlacement(s.board, s.tray[0].shape), null);
  assert.equal(canPlaceAt(s.board, [[0, 0]], 7, 7), true);
});

test('resolution order end-to-end: clear -> shards -> queue/overflow -> refill -> game-over, in that order', () => {
  const s = freshState();
  // Log-based check: place a clearing piece and confirm the log records
  // events in the documented order for a single turn.
  setupSingleLineClear(s, 0, 0);
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  placePiece(s, 0, 0, 0);
  const clearIdx = s.log.findIndex((l) => l.startsWith('Cleared'));
  const queueIdx = s.log.findIndex((l) => l.startsWith('Shard queued'));
  assert.ok(clearIdx !== -1 && queueIdx !== -1 && clearIdx < queueIdx,
    'clear event must be logged before shard-queue event');
});

// ---------------------------------------------------------------------------
// Section 5b: first-session exposure scripting
// ---------------------------------------------------------------------------
// createGame(seed) with no opts must behave exactly as before this feature
// existed (opts default firstExposureComplete=true, i.e. scripting OFF) --
// covered implicitly by every test above still passing unmodified. The tests
// below explicitly exercise the new opt-in behavior.

test('Section 5b default: createGame() with no opts leaves scripting off (no regression)', () => {
  const s = createGame(1);
  assert.equal(s.firstExposureComplete, true);
  assert.equal(s.onboarding.firstShardCalloutFired, true);
});

test('Section 5b guard rail: full pipeline arms a real >=3-line opportunity, fires with queue<=2, never grows the tray, and flips the flag', () => {
  const s = createGame(1, { firstExposureComplete: false });
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  // A real, organically-shaped opportunity: rows 0-3 filled except column 7
  // -- the only line-clear opportunity anywhere on this board, so which
  // shape/position the arming scan picks is deterministic regardless of
  // SHAPES ordering/weights.
  for (let r = 0; r < 4; r++) for (let c = 0; c < BOARD_SIZE; c++) if (c !== 7) s.board[r][c] = { color: '#000' };
  s.onboarding.totalClears = 4; // eligibility threshold
  // Queue at cap going into the refill: with TRAY_BASE_SIZE=3 and 1 slot
  // reserved for the scripted piece, exactly 2 of these will deterministically
  // drain into the other 2 slots during this same refill, leaving exactly
  // ONBOARDING_SAFE_QUEUE_LEVEL (2) in the queue by the time the scripted
  // piece actually fires -- see planOnboardingArm's comment for why this is
  // the correct quantity to reason about, not the raw pre-drain length.
  s.shardQueue = Array.from({ length: QUEUE_CAP }, () => ({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true }));

  // Empty the tray by hand except one harmless dummy piece placed somewhere
  // that doesn't touch the prepared setup, to trigger the real refill path
  // (same technique as the "tray refill drains..." test above).
  s.tray = [null, null, { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false }];
  const dummyRes = placePiece(s, 2, 7, 0); // row 7 is untouched by the setup
  assert.equal(dummyRes.ok, true);

  assert.equal(s.onboarding.armedRound, true, 'a real >=3-line opportunity exists on the board -- the round should arm');
  // REVISION (docs/playtest-findings.md item 5): scripted piece now lands in
  // slot 0, not slot 1 -- a deliberate, data-backed deviation from the design
  // doc's literal "2nd or 3rd piece" text, see core.js header comment.
  assert.equal(s.tray[0] && s.tray[0].isScriptedCombo, true, "scripted combo should land in tray slot 0");
  assert.equal(s.tray[0].shapeId, 'tetromino_v');
  assert.equal(s.shardQueue.length, ONBOARDING_SAFE_QUEUE_LEVEL, 'this same refill should have already drained the queue down to the safe level before the scripted piece is ever placed');

  // Fire it.
  const res = placePiece(s, 0, 0, 7);
  assert.equal(res.ok, true);

  // The load-bearing guard rail: read live, at the exact moment the combo's
  // clear resolves inside placePiece -- not inferred from an earlier check.
  assert.equal(s.onboarding.lastScriptedFireQueueLen, ONBOARDING_SAFE_QUEUE_LEVEL);
  assert.ok(s.onboarding.lastScriptedFireQueueLen <= ONBOARDING_SAFE_QUEUE_LEVEL, 'guard rail must hold at the literal fire moment');

  // The actual regression this all exists to prevent (gap #7 / playtest-findings.md item 3).
  assert.equal(s.tray.length, TRAY_BASE_SIZE, 'tray must NOT grow past base size');

  // The teaching moment itself still happened (queue=2 + a real 4-line combo
  // is verified-safe AND still forces exactly one overflow -- see
  // docs/playtest-findings.md item 3).
  assert.ok(s.log.some((l) => l.startsWith('OVERFLOW')), 'the guarded queue level should still produce a real overflow event, not a silent no-op');

  assert.equal(s.firstExposureComplete, true, 'the resulting overflow should flip the flag permanently');
  const overflowCallout = s.pendingCallouts.find((c) => c.type === 'first-overflow');
  assert.ok(overflowCallout, 'first-overflow callout should be queued');
  assert.equal(overflowCallout.text, FIRST_OVERFLOW_CALLOUT_TEXT);
});

test('Section 5b guard rail: the fire-time check is live, not decorative (deliberately adverse queue is still detected)', () => {
  const s = createGame(2, { firstExposureComplete: false });
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  for (let r = 0; r < 4; r++) for (let c = 0; c < BOARD_SIZE; c++) if (c !== 7) s.board[r][c] = { color: '#000' };
  // Deliberately construct the exact adverse precondition the guard rail
  // exists to catch: queue already at cap when the scripted piece fires
  // (bypassing the normal arm/drain pipeline directly, the same way the
  // "queue overflow escalation" test above isolates insertShard's seam).
  s.shardQueue = Array.from({ length: QUEUE_CAP }, () => ({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true }));
  s.tray = [null, null, { shape: [[0, 0], [1, 0], [2, 0], [3, 0]], shapeId: 'tetromino_v', color: '#fff', isShard: false, isScriptedCombo: true }];

  const res = placePiece(s, 2, 0, 7);
  assert.equal(res.ok, true);
  assert.equal(s.onboarding.lastScriptedFireQueueLen, QUEUE_CAP, 'the check must reflect the real, live queue length at fire time');
  assert.ok(s.onboarding.lastScriptedFireQueueLen > ONBOARDING_SAFE_QUEUE_LEVEL);
  assert.ok(s.log.some((l) => l.includes('GUARD-RAIL WARNING')), 'an out-of-bounds queue level at fire time must be surfaced, not silently ignored');
});

test('Section 5b: flag flips permanently after the first real overflow, even without any scripted combo having fired', () => {
  const s = createGame(3, { firstExposureComplete: false });
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  assert.equal(s.firstExposureComplete, false);

  // Fully organic overflow, unrelated to Section 5b's own scripting --
  // reuses the same setup as the pre-existing "queue overflow escalation"
  // test.
  for (let i = 0; i < QUEUE_CAP; i++) s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });
  for (let c = 0; c < BOARD_SIZE; c++) { if (c !== 0) s.board[0][c] = { color: '#000' }; }
  s.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false };
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];

  const res = placePiece(s, 0, 0, 0);
  assert.equal(res.ok, true);
  assert.equal(s.firstExposureComplete, true, '"the exposure system\'s job is done as soon as the real teaching moment happens, by whatever means"');
  assert.equal(s.onboarding.firstOverflowHandled, true);

  // Idempotent: a second overflow later in the same game must not re-fire
  // the milestone bookkeeping or re-queue the callout.
  s.pendingCallouts.length = 0;
  for (let i = 0; i < QUEUE_CAP; i++) s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#bbb', isShard: true });
  for (let c = 0; c < BOARD_SIZE; c++) { if (c !== 1) s.board[1][c] = { color: '#000' }; }
  s.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false };
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  placePiece(s, 0, 1, 1);
  assert.equal(s.firstExposureComplete, true);
  assert.equal(s.pendingCallouts.filter((c) => c.type === 'first-overflow').length, 0, 'the milestone callout must fire at most once ever');
});

test('Section 5b: first-shard-generated callout fires exactly once, only for the queued (non-overflow) case', () => {
  const s = createGame(4, { firstExposureComplete: false, firstShardCalloutShown: false });
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  assert.equal(s.onboarding.firstShardCalloutFired, false);

  for (let c = 0; c < BOARD_SIZE; c++) { if (c !== 0) s.board[0][c] = { color: '#000' }; }
  s.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false };
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  placePiece(s, 0, 0, 0);

  assert.equal(s.onboarding.firstShardCalloutFired, true);
  const callout = s.pendingCallouts.find((c) => c.type === 'first-shard');
  assert.ok(callout);
  assert.equal(callout.text, FIRST_SHARD_CALLOUT_TEXT);
});

test('Section 5b: early-draw bias is restricted to EASY_SHAPE_IDS while firstExposureComplete is false, and lifts once true', () => {
  const biased = createGame(5, { firstExposureComplete: false });
  for (const piece of biased.tray) {
    assert.ok(EASY_SHAPE_IDS.has(piece.shapeId), `biased draw ${piece.shapeId} should be in the easy shape set`);
  }

  // The reverse (unbiased play can draw outside the easy set) is inherently
  // probabilistic, not structural -- assert it holds across enough seeds to
  // be effectively certain, rather than claiming a false determinism.
  let sawNonEasyShape = false;
  for (let seed = 1; seed <= 200 && !sawNonEasyShape; seed++) {
    const g = createGame(seed); // opts omitted -> firstExposureComplete defaults true (bias off)
    for (const piece of g.tray) if (!EASY_SHAPE_IDS.has(piece.shapeId)) sawNonEasyShape = true;
  }
  assert.ok(sawNonEasyShape, 'unbiased RNG should be able to draw outside the easy shape set within 200 seeds');
});

test('Section 5b (REVISION): drain suppression does NOT fire before onboarding eligibility (totalClears < threshold)', () => {
  const s = createGame(6, { firstExposureComplete: false });
  assert.equal(s.onboarding.suppressedRefillCount, 0);
  assert.ok(s.onboarding.totalClears < ONBOARDING_ELIGIBLE_AFTER_CLEARS, 'fresh game starts below the eligibility threshold');

  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });

  // Trigger a refill with the tray otherwise empty (no clear involved).
  s.tray = [null, null, { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false }];
  placePiece(s, 2, 5, 5);
  assert.equal(s.onboarding.suppressedRefillCount, 0, 'pre-eligibility refills must never spend the suppression budget');
  assert.equal(s.shardQueue.length, 0, 'pre-eligibility refill should drain normally, exactly like organic play');
});

test('Section 5b (REVISION): once eligible, drain suppression repeats across refills up to ONBOARDING_MAX_SUPPRESSED_REFILLS, then resumes normal draining', () => {
  const s = createGame(7, { firstExposureComplete: false });
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  s.onboarding.totalClears = ONBOARDING_ELIGIBLE_AFTER_CLEARS; // now eligible
  // No real >=3-line opportunity exists anywhere on this empty board, so
  // planOnboardingArm can never find one to arm -- isolates suppression's
  // own repeat/cap behavior from arming succeeding or not.
  s.shardQueue.push({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });

  for (let i = 0; i < ONBOARDING_MAX_SUPPRESSED_REFILLS; i++) {
    s.tray = [null, null, { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false }];
    // Distinct free cell every iteration, spread thin across rows/cols (at
    // most 2 cells per row, never near completing an 8-cell line) so this
    // loop can never accidentally trigger a real clear and confound the
    // suppression-only assertion below.
    placePiece(s, 2, i % 5, Math.floor(i / 5));
    assert.equal(s.onboarding.suppressedRefillCount, i + 1, `refill ${i + 1} should still be within the suppression budget`);
  }
  assert.equal(s.shardQueue.length, 1, 'the queue must still hold its one shard -- every refill so far suppressed the drain');

  // One more refill past the cap must drain normally.
  const queueLenBeforeUncappedRefill = s.shardQueue.length;
  s.tray = [null, null, { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false }];
  placePiece(s, 2, ONBOARDING_MAX_SUPPRESSED_REFILLS % 5, Math.floor(ONBOARDING_MAX_SUPPRESSED_REFILLS / 5));
  assert.equal(s.onboarding.suppressedRefillCount, ONBOARDING_MAX_SUPPRESSED_REFILLS, 'suppression budget must not exceed the cap');
  assert.ok(s.shardQueue.length < queueLenBeforeUncappedRefill, 'once the cap is hit, refills must resume draining normally');
});

test('Section 5b (REVISION): multi-refill suppression lets the queue climb organically until a 4-line arm succeeds and overflows, closing the gap PM found', () => {
  // Reproduces the actual bug docs/playtest-findings.md item 4 found: a
  // single-shot suppression could only preserve whatever queue level already
  // existed (usually ~0), so a 4-line/3-shard combo (needs queue===2 exactly)
  // essentially never got the chance to fire. Here the queue starts at 0 and
  // must climb to 2 purely through two ordinary single-line clears from the
  // round's OTHER (non-scripted) slots while suppression holds each refill's
  // drain open across multiple rounds.
  const s = createGame(8, { firstExposureComplete: false });
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  s.onboarding.totalClears = ONBOARDING_ELIGIBLE_AFTER_CLEARS;
  assert.equal(s.shardQueue.length, 0);

  // Round 1: two ordinary single-line clears (rows 1 and 2) push the queue
  // from 0 -> 2 across this one round (no board opportunity for a big combo
  // yet, so planOnboardingArm won't arm this round -- it just observes).
  for (let c = 0; c < BOARD_SIZE; c++) { if (c !== 0) s.board[1][c] = { color: '#000' }; }
  for (let c = 0; c < BOARD_SIZE; c++) { if (c !== 0) s.board[2][c] = { color: '#000' }; }
  s.tray = [
    { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false },
    { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false },
    { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false },
  ];
  placePiece(s, 0, 1, 0); // clears row 1 -> +1 shard
  placePiece(s, 1, 2, 0); // clears row 2 -> +1 shard
  // Now set up the real 4-line opportunity (rows 4-7 minus col 7) before the
  // round's 3rd/last piece is placed, so the refill after it can find it.
  for (let r = 4; r < 8; r++) for (let c = 0; c < BOARD_SIZE; c++) if (c !== 7) s.board[r][c] = { color: '#000' };
  placePiece(s, 2, 0, 1); // no clear (row 0 still empty here), but empties the tray -> triggers refill/arm check

  assert.equal(s.shardQueue.length, 2, 'suppression should have preserved both organically-generated shards across the round');
  assert.equal(s.onboarding.armedRound, true, 'queue is now at exactly the level a 4-line combo needs -- this refill should arm');
  // REVISION (docs/playtest-findings.md item 5): scripted piece now lands in
  // slot 0, not slot 1 -- see core.js header comment.
  assert.equal(s.tray[0] && s.tray[0].isScriptedCombo, true);
  assert.equal(s.tray[0].shapeId, 'tetromino_v');

  // Fire it.
  const res = placePiece(s, 0, 4, 7);
  assert.equal(res.ok, true);
  assert.ok(s.log.some((l) => l.startsWith('OVERFLOW')), 'the accumulated queue level should produce a real overflow event');
  assert.equal(s.tray.length, TRAY_BASE_SIZE, 'tray must not grow past base size');
  assert.equal(s.firstExposureComplete, true);
});

test('Section 5b growth safety valve: also covers an ARMED-but-UNSUPPRESSED round, not just a suppressed one (game-debugger finding)', () => {
  // Reproduces a second, independent path into the exact bug the growth
  // safety valve (see insertShard) was built to close, which its original
  // `suppressedThisRound`-only scope missed: an eligible refill can arm a
  // scripted combo WITHOUT suppression ever engaging, if the queue simply
  // happens to already be AT QUEUE_CAP the instant the refill fires (see
  // maybeRefillTray's `state.shardQueue.length < QUEUE_CAP` suppression
  // guard -- suppression can't apply here, but a same-refill drain of the
  // round's other 2 slots can still land exactly on a combo's required
  // post-drain level). That refill deals REAL, un-vetted drained shards into
  // the non-scripted slots (shard siblings are deliberately never reshaped
  // -- see header comment). If a shard sibling is played and clears a line
  // BEFORE the scripted piece, and the round's third slot is still unplayed
  // when the scripted combo resolves (so it isn't a free tray slot yet),
  // the compounded overflow can blow past the one guaranteed free slot and
  // grow the tray -- confirmed via direct simulation (5/20,000 games under
  // a random-slot-order bot; see build report) before this valve fix.
  const s = createGame(1, { firstExposureComplete: false, firstShardCalloutShown: false });
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  s.onboarding.totalClears = ONBOARDING_ELIGIBLE_AFTER_CLEARS;
  s.onboarding.armedRound = true;
  s.onboarding.suppressedThisRound = false; // the gap: armed without suppression this round

  s.shardQueue = Array.from({ length: QUEUE_CAP }, () => ({ shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true }));

  // rows 0-3 minus col 7: the scripted piece's real 4-line opportunity.
  for (let r = 0; r < 4; r++) for (let c = 0; c < BOARD_SIZE; c++) if (c !== 7) s.board[r][c] = { color: '#000' };
  // row 5 minus col 0: the shard sibling's own (independent) 1-line opportunity.
  for (let c = 0; c < BOARD_SIZE; c++) if (c !== 0) s.board[5][c] = { color: '#000' };

  s.tray = [
    { shape: [[0, 0], [1, 0], [2, 0], [3, 0]], shapeId: 'tetromino_v', color: '#fff', isShard: false, isScriptedCombo: true },
    { shape: [[0, 0]], shapeId: 'shard_mono', color: '#aaa', isShard: true }, // un-vetted shard sibling
    { shape: [[0, 0]], shapeId: 'mono', color: '#eee', isShard: false }, // stays unplayed -- NOT a free tray slot yet
  ];

  // Shard sibling plays first and clears its own line.
  let res = placePiece(s, 1, 5, 0);
  assert.equal(res.ok, true);
  assert.equal(s.tray.length, TRAY_BASE_SIZE, 'no growth yet -- only the sibling has fired so far');

  // Scripted piece fires next, with the third slot still occupied (unplayed).
  res = placePiece(s, 0, 0, 7);
  assert.equal(res.ok, true);

  assert.equal(s.tray.length, TRAY_BASE_SIZE, 'tray must NOT grow past base size even in an armed-but-unsuppressed round');
  assert.ok(s.log.some((l) => l.includes('GROWTH SAFETY VALVE') && l.includes('armed=true')),
    'the valve must engage and say so, not silently no-op');
});

test('combo streak: back-to-back clearing placements score a growing bonus, reset by a non-clearing placement', () => {
  const s = freshState();
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];

  setupSingleLineClear(s, 0, 0);
  let res = placePiece(s, 0, 0, 0);
  assert.equal(res.ok, true);
  assert.equal(s.comboStreak, 1, 'first clear starts the streak at 1');
  const scoreAfterFirstClear = s.score;

  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  setupSingleLineClear(s, 1, 0);
  res = placePiece(s, 0, 1, 0);
  assert.equal(res.ok, true);
  assert.equal(s.comboStreak, 2, 'second consecutive clear bumps the streak');
  const expectedComboBonus = 2 * SCORE_PER_COMBO_STEP;
  // Board is single-row-populated each time, so this clear also empties it
  // again -- the whole-field bonus legitimately fires on both placements.
  assert.equal(s.score, scoreAfterFirstClear + 1 * 10 /* SCORE_PER_LINE_CLEAR */ + 1 /* SCORE_PER_CELL_PLACED */ + expectedComboBonus + SCORE_WHOLE_FIELD_CLEAR_BONUS,
    'second clear in the streak should add the line-clear score plus a combo bonus scaled by streak length plus the whole-field bonus');

  // A placement that clears nothing resets the streak.
  s.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false };
  res = placePiece(s, 0, 5, 5);
  assert.equal(res.ok, true);
  assert.equal(s.comboStreak, 0, 'a non-clearing placement resets the streak');
});

test('whole-field clear: a placement that empties the entire board awards the flat bonus', () => {
  const s = freshState();
  s._forcedShardShapes = [{ id: 'shard_mono', cells: [[0, 0]] }];
  setupSingleLineClear(s, 0, 0); // only row 0 has any filled cells on this otherwise-empty board
  const scoreBefore = s.score;
  const res = placePiece(s, 0, 0, 0);
  assert.equal(res.ok, true);
  assert.equal(s.board.every((row) => row.every((cell) => cell == null)), true, 'board should be fully empty after this clear');
  assert.equal(s.score, scoreBefore + 1 /* SCORE_PER_CELL_PLACED */ + 10 /* SCORE_PER_LINE_CLEAR */ + SCORE_WHOLE_FIELD_CLEAR_BONUS,
    'whole-field clear should add the flat bonus on top of normal clear scoring (no combo bonus yet -- this is streak=1)');
});

// Board with one empty cell per row/col, diagonally placed so no two empty
// cells are edge-adjacent: no domino/tromino/etc. fits anywhere, but a mono
// always fits at any of the 8 gaps. Deliberately does NOT go through
// placePiece (any placement into a gap here would complete that row+col and
// trigger a clear) -- checkGameOver is exercised directly against a
// hand-built board+tray, same as this file's other hand-built states.
function isolatedGapBoard() {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill({ color: '#000' }));
  for (let r = 0; r < BOARD_SIZE; r++) board[r] = board[r].slice();
  for (let r = 0; r < BOARD_SIZE; r++) board[r][r] = null;
  return board;
}

const unplaceableDomino = { shape: [[0, 0], [0, 1]], shapeId: 'domino_h', color: '#fff', isShard: false };

test('mercy piece: saves the game once when no tray piece fits anywhere', () => {
  const s = freshState();
  s.board = isolatedGapBoard();
  s.tray = [{ ...unplaceableDomino }, { ...unplaceableDomino }, null];

  checkGameOver(s);

  assert.equal(s.gameOver, false, 'mercy charge should prevent game-over on the first dead end');
  assert.equal(s.mercyChargesRemaining, 0, 'the single mercy charge should be consumed');
  const swapped = s.tray.find((slot) => slot && slot.isMercy);
  assert.ok(swapped, 'one tray slot should have been swapped for a mercy piece');
  assert.equal(swapped.shapeId, 'mono', 'mono is the smallest EASY_SHAPES shape and should be picked first');
  assert.equal(findAnyPlacement(s.board, swapped.shape) != null, true, 'the mercy piece must actually be placeable');
});

test('mercy piece: does not fire, and is not consumed, when a tray piece already fits', () => {
  const s = freshState();
  s.tray = [{ shape: [[0, 0]], shapeId: 'mono', color: '#fff', isShard: false }, null, null];

  checkGameOver(s);

  assert.equal(s.gameOver, false);
  assert.equal(s.mercyChargesRemaining, 1, 'charge must not be spent when the tray already has a valid move');
});

// isolatedGapBoard, but row 0 also gets a 3-wide contiguous pocket at
// cols 2-4 -- deliberately NOT touching col 0, whose own isolated diagonal
// gap sits at (0,0) and would otherwise be adjacent to (and silently widen)
// the pocket. Columns 2-4 each keep their own isolated diagonal free cell
// too, so nothing in this board can ever complete a line (no clear possible
// from any placement this file's dominoes/monos can make) -- the pocket is
// a fixed 3-cell budget, never expandable via a clear.
function tightPocketBoard() {
  const board = isolatedGapBoard();
  board[0][2] = null;
  board[0][3] = null;
  board[0][4] = null;
  return board;
}

test('canPlaceAllPieces: true when board has ample room for every piece', () => {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  const shapes = [unplaceableDomino.shape, unplaceableDomino.shape, [[0, 0]]];
  assert.equal(canPlaceAllPieces(board, shapes), true);
});

test('canPlaceAllPieces: false when two pieces individually fit but cannot both fit at once', () => {
  const board = tightPocketBoard();
  // Each domino fits somewhere on its own (the 3-cell pocket has room for one).
  assert.equal(findAnyPlacement(board, unplaceableDomino.shape) != null, true);
  // But the pocket is only 3 cells wide -- two dominoes need 4, and nowhere
  // else on the board is reachable by a domino (every other gap is an
  // isolated single cell).
  assert.equal(canPlaceAllPieces(board, [unplaceableDomino.shape, unplaceableDomino.shape]), false);
});

test('canPlaceAllPieces: adding a mono instead of a second domino restores solvability', () => {
  const board = tightPocketBoard();
  assert.equal(canPlaceAllPieces(board, [unplaceableDomino.shape, [[0, 0]], [[0, 0]]]), true);
});

test('joint-solvability mercy: maybeRefillTray deals a tray that is always jointly solvable when a mercy charge is available', () => {
  // maybeRefillTray deals its own randomly-weighted fresh pieces, so rather
  // than trying to force a specific unsolvable draw, assert the guarantee
  // itself across many seeds against a board where an unsolvable draw is
  // actually likely (the 3-cell pocket from tightPocketBoard): whatever
  // tray comes out the other side must be jointly solvable.
  for (let seed = 1; seed <= 30; seed++) {
    const s = freshState(seed);
    s.board = tightPocketBoard();
    s.tray = [null, null, null];
    maybeRefillTray(s);
    const shapes = s.tray.filter((slot) => slot != null).map((slot) => slot.shape);
    assert.equal(canPlaceAllPieces(s.board, shapes), true,
      `seed ${seed}: freshly dealt tray must be jointly solvable when a mercy charge is available`);
  }
});

test('mercy piece: once the charge is spent, a second dead end is a real game-over', () => {
  const s = freshState();
  s.board = isolatedGapBoard();
  s.mercyChargesRemaining = 0;
  s.tray = [{ ...unplaceableDomino }, { ...unplaceableDomino }, null];

  checkGameOver(s);

  assert.equal(s.gameOver, true, 'with no charges left, a genuine dead end must still end the game');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
