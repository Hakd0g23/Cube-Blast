// Fracture — core gameplay engine. Pure logic, no DOM/canvas dependency, so it
// can be unit-tested headlessly (see tests/core.test.mjs) and driven by any
// renderer. This module is the single source of truth for the fixed
// resolution order locked in design-doc-skeleton.md Section 3:
//
//   1. line clear resolves -> shards generated (Section 2, safety rule applied
//      at generation time)
//   2. shard queue insertion: room in queue -> queue; queue at cap -> force
//      insert into the active tray (overflow escalation)
//   3. tray refill (only once ALL tray slots are empty): queued shards drain
//      first, then fresh random pieces fill remaining slots
//   4. game-over check, run last, after whichever of 2/3 most recently
//      touched the tray
//
// Implementation decisions NOT dictated by the design doc (flagged here and
// in the build report, not silently buried):
//   - QUEUE_CAP = 4 (doc says "~3-4", picked the upper bound)
//   - No player-facing piece rotation (matches the doc's own cited genre
//     precedent: Block Blast / 1010! / Woodoku)
//   - Shard color = color of the piece the player just placed to trigger the
//     clear (well-defined even when one placement clears multiple lines at
//     once, unlike "color of the cells in the cleared line" which would be
//     ambiguous across cells placed at different times)
//   - Scoring model (points per cell, line-clear bonus, auto-convert value)
//     is an invented placeholder — Section 1 says only "clears -> scores",
//     Block Blast's actual scoring curve isn't specified in the doc.
//   - Overflow force-insert targets the tray slot just vacated by the piece
//     that triggered the clear first; if a second shard overflows in the same
//     turn, it takes the next empty tray slot; if none exists, it appends as
//     a temporary extra slot beyond the normal 3 (consumed/removed once
//     placed, tray returns to base size 3 on the next full refill). The doc
//     does not address simultaneous multi-shard overflow in one turn.
//
// Section 5b (first-session exposure scripting) implementation decisions,
// flagged the same way — see the "Section 5b" block below for the code:
//   - DEVIATION (game-designer re-verification, docs/playtest-findings.md
//     item 5): the design doc's own text says the scripted piece should be
//     "the round's 2nd or 3rd piece, not the 1st" (originally read as *dealt
//     tray-slot position*, slot index 1, not chronological play order — play
//     order is the player's choice; swapping a piece's shape after it's
//     already been looked at / mid-drag would be worse for legibility than
//     the alternative, so the shape is still committed once, at deal time,
//     unchanged). The STATED reason for "not 1st" was a redundant queue-
//     ceiling guard this implementation never actually relies on (it uses a
//     conservative "assume only 1 free tray slot" constant regardless of
//     real play order — see requiredQueueLenForOverflow). Re-verification
//     surfaced a real cost to keeping it at slot 1 that the doc's authors
//     couldn't have known about yet: a careless/naive-leaning play style
//     (picks tray slot 0 first, falls through only if unplaceable — see
//     tools/playtest-sim/sim10_onboarding_overflow_fix.mjs's "naive" bot,
//     modeled on the same profile playtest-findings.md item 1 identifies as
//     the actual at-risk audience) plays whatever sibling sits in slot 0
//     BEFORE the scripted piece nearly every round, which can silently
//     consume the exact board cells the scripted combo depends on (PM's
//     "secondary" finding, generalized — see docs/playtest-findings.md item
//     5). Moving the scripted piece to slot 0 removes the opportunity for
//     that failure mode entirely for exactly the play style most likely to
//     trigger it, at no measured cost to the combo-hoarder profile (whose
//     policy doesn't consider slot position at all) or to growth-safety
//     (unaffected by play order either way). A deliberate, data-backed
//     deviation from the doc's literal "not 1st" text — flagged here and in
//     the build report, not silently changed.
//   - The scripted combo is constructed by *scanning the real, player-built
//     board* for an already-existing >=3-line opportunity and dealing a
//     shape that completes it — never by fabricating/overwriting board cells
//     the player didn't place. tools/playtest-sim/sim8_onboarding_scripted.mjs
//     stamps the board directly, but that is a test-verification stand-in
//     ("the tutorial sets up this board"), not a live-gameplay technique —
//     overwriting a real player's placed cells in a shipped build would be a
//     visible, bug-shaped integrity problem. Consequence: the "guarantee"
//     is closer to "very likely, and retried every eligible round until it
//     happens" than a hard mathematical guarantee inside exactly clears 5-8.
//     Flagged in the build report as a resolved judgment call, not silently
//     decided.
//   - The other (non-scripted) slot(s) in an armed round are dealt shapes
//     verified incapable of clearing any line on the current board — this is
//     what makes the guard-rail check hold *by construction* in the common
//     case (queue level literally cannot move between arm-time and fire-time
//     from a sibling's clear if nothing else can generate a shard), rather
//     than by hoping the player plays the scripted slot first.
//   - The arm-time guard-rail check does NOT compare against the queue's raw
//     length at deal time. Only one of the round's TRAY_BASE_SIZE slots is
//     reserved for the scripted piece, so the *other* (TRAY_BASE_SIZE - 1)
//     slots still drain from the queue in that same refill, deterministically,
//     before the scripted piece is ever placed. The check therefore gates on
//     the length the queue will actually have *after* that same-refill drain
//     (see planOnboardingArm) — checking the raw pre-drain length would gate
//     on the wrong number and could arm rounds the fire-time check would
//     then have to reject.
//
// REVISION (game-designer, re-verification of a PM-found gap — see
// docs/playtest-findings.md item 4 and item 5 below): the ONE-SHOT version of
// drain-suppression + the ">= 3-line, single shared safe-level" version of
// arming above shipped with a real bug, not just a residual-risk footnote --
// re-verified with tools/playtest-sim/sim10_onboarding_overflow_fix.mjs
// against 300 games: overflow rate went from 0/300 to (see that file's
// latest run / docs/playtest-findings.md item 5 for the actual number).
// Root cause: forced-into-tray shard count is exactly
// max(0, shardCount - (QUEUE_CAP - queueLenAtFire)), and staying safe from
// tray growth (forced <= 1 free slot, conservatively assuming only 1 free
// slot — never relying on play order) requires forced === EXACTLY 1, which
// has exactly ONE solution for queueLenAtFire per shardCount, not a range:
//   queueLenAtFire === QUEUE_CAP - shardCount + 1
// A single shared "<= 2" gate (ONBOARDING_SAFE_QUEUE_LEVEL) is only that
// exact value for the 4-line/3-shard case; for the far more common 3-line/
// 2-shard case the correct value is 3, which the old "<=2" gate explicitly
// excluded — so 157/163 armed rounds in the PM's sim were structurally
// incapable of ever overflowing. Fixed by (1) computing the required exact
// queue level per combo size instead of reusing one shared ceiling, and
// (2) making drain-suppression repeat across multiple refills (bounded by
// ONBOARDING_MAX_SUPPRESSED_REFILLS) so the queue can actually climb toward
// that level via ordinary organic shard generation between refills, instead
// of a single suppression that can only *preserve* whatever level already
// happened to be there (usually ~0).

import { BOARD_SIZE, SHAPES, SHARD_SHAPES, SHARD_SHAPES_MULTI, COLORS, weightedPick, pick } from './pieces.js';

export const TRAY_BASE_SIZE = 3;
export const QUEUE_CAP = 4; // design doc: "~3-4 slots" — implementation picks 4.

export const SCORE_PER_CELL_PLACED = 1;   // placeholder scoring model
export const SCORE_PER_LINE_CLEAR = 10;   // placeholder scoring model
export const SCORE_PER_SHARD_CELL_AUTOCONVERT = 5; // placeholder scoring model

// Combo: consecutive placements that each clear >=1 line build a streak;
// a placement that clears nothing resets it. Bonus grows with streak length
// so back-to-back clears are worth progressively more than the same clears
// spread out — rewards sustained tempo, not just raw clear count.
export const SCORE_PER_COMBO_STEP = 15;   // placeholder scoring model

// Whole-field clear: flat bonus when a placement's line-clear leaves the
// board completely empty (the "perfect clear" moment).
export const SCORE_WHOLE_FIELD_CLEAR_BONUS = 200; // placeholder scoring model

// ---- Section 5b: first-session exposure scripting -------------------------
// Verified guard rail (docs/playtest-findings.md item 3 /
// docs/design-doc-skeleton.md Section 5b): the shard queue must be <= this
// level at the literal moment the scripted combo's clear resolves, or the
// tray-growth-past-base-size edge case (gap #7) becomes reachable.
export const ONBOARDING_SAFE_QUEUE_LEVEL = 2;
// Don't even attempt to arm a scripted round before this many real clears —
// keeps the scripted combo inside the design doc's "first ~5-8 clears"
// window in the common case.
export const ONBOARDING_ELIGIBLE_AFTER_CLEARS = 4;

// REVISION: drain-suppression is no longer one-shot (see header comment) --
// it now repeats across every eligible refill so the queue can actually
// climb toward whatever exact level the current best combo opportunity
// needs. Bounded so a session that never lines up the right board shape
// doesn't hold every future refill hostage for the rest of the game --
// picked to comfortably cover the "first ~5-8 clears" window's worth of
// refills without being effectively unbounded; re-verify this constant if
// tools/playtest-sim/sim10_onboarding_overflow_fix.mjs's overflow rate ever
// regresses after a change to QUEUE_CAP, TRAY_BASE_SIZE, or the easy-shape
// pool's clear frequency.
export const ONBOARDING_MAX_SUPPRESSED_REFILLS = 10;

export const FIRST_SHARD_CALLOUT_TEXT = "Shard saved! It'll pop back into your tray soon.";
export const FIRST_OVERFLOW_CALLOUT_TEXT = "Queue's full! This shard's in your tray now.";

// ---- Endless-mode difficulty waves -----------------------------------------
// Session-length difficulty axis, orthogonal to the shard/queue system's own
// skill-gated pressure (game-engineer review, see build report): waves only
// ever reweight which piece SHAPES get dealt (reusing the same
// EASY_SHAPES-restriction pattern Section 5b already uses for onboarding).
// They never touch shard generation, queue insertion, board size, or the
// ship-blocking safety rule, so they can't perturb the parameters that
// safety rule's "unreachable at current SHAPES weights" verdict depends on.
//
// Gated on state.onboarding.totalClears (a stable, already-tracked counter)
// rather than score, since score is explicitly a placeholder model (see
// SCORE_PER_* comments above) and shouldn't be load-bearing for a difficulty
// threshold.
export const WAVE_START_AFTER_CLEARS = 18; // past the Section 5b onboarding window (ONBOARDING_ELIGIBLE_AFTER_CLEARS=4 + its ~5-8 clear script window)
export const WAVE_INTERVAL_CLEARS = 18;    // clears between each wave bump
export const WAVE_MAX_TIER = 4;            // plateaus here — an endless ramp past legibility reads as grind, not skill

// Integer tier for a given clear count (0 = no waves active yet).
export function waveTierForClears(totalClears) {
  if (totalClears < WAVE_START_AFTER_CLEARS) return 0;
  return Math.min(WAVE_MAX_TIER, Math.floor((totalClears - WAVE_START_AFTER_CLEARS) / WAVE_INTERVAL_CLEARS) + 1);
}

// Fractional progress toward WAVE_MAX_TIER, used to blend shape weights
// smoothly rather than snapping the whole pool at each threshold (avoids a
// legibility cliff right at the boundary).
function waveDifficultyFraction(totalClears) {
  return waveTierForClears(totalClears) / WAVE_MAX_TIER;
}

export function waveCalloutText(tier) {
  return `Wave ${tier}! Trickier pieces from here.`;
}

// "Bias early tray draws toward easy clears" — restrict the weighted draw
// pool to small/simple shapes (mono/domino/tromino/square2/corner) while
// firstExposureComplete is false. Shape-set membership, not a doc-specified
// list — a gray-box implementation decision like pieces.js's own shape set.
export const EASY_SHAPE_IDS = new Set(['mono', 'domino_h', 'domino_v', 'tromino_h', 'tromino_v', 'square2', 'corner']);
const EASY_SHAPES = SHAPES.filter((s) => EASY_SHAPE_IDS.has(s.id));

// Wave difficulty reweighting (see WAVE_* constants above) — reuses
// EASY_SHAPE_IDS as the "taper down" set, mirrors it with a "ramp up" set.
const WAVE_HARD_IDS = new Set(['tetromino_h', 'tetromino_v', 'penta_h', 'penta_v', 'square3', 'L1', 'L2', 'L3', 'L4', 'T', 'Tv', 'S', 'Z']);

// SHAPES reweighted for the current wave tier: easy shapes taper down (never
// below half their base weight, so they don't vanish from the pool
// entirely), hard shapes ramp up. frac===0 returns SHAPES itself unchanged
// (no allocation on the hot path before waves start).
function waveWeightedShapes(totalClears) {
  const frac = waveDifficultyFraction(totalClears);
  if (frac === 0) return SHAPES;
  return SHAPES.map((s) => {
    if (EASY_SHAPE_IDS.has(s.id)) return { ...s, weight: Math.max(s.weight * 0.5, s.weight * (1 - 0.6 * frac)) };
    if (WAVE_HARD_IDS.has(s.id)) return { ...s, weight: s.weight * (1 + 1.5 * frac) };
    return s;
  });
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

export function canPlaceAt(board, cells, r, c) {
  for (const [dr, dc] of cells) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || rr >= BOARD_SIZE || cc < 0 || cc >= BOARD_SIZE) return false;
    if (board[rr][cc] != null) return false;
  }
  return true;
}

export function findAnyPlacement(board, cells) {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (canPlaceAt(board, cells, r, c)) return { r, c };
    }
  }
  return null;
}

function stampPiece(board, cells, r, c, color) {
  for (const [dr, dc] of cells) board[r + dr][c + dc] = { color };
}

function isBoardEmpty(board) {
  for (const row of board) for (const cell of row) if (cell != null) return false;
  return true;
}

function findFullLines(board) {
  const rows = [];
  const cols = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    if (board[r].every((cell) => cell != null)) rows.push(r);
  }
  for (let c = 0; c < BOARD_SIZE; c++) {
    let full = true;
    for (let r = 0; r < BOARD_SIZE; r++) if (board[r][c] == null) { full = false; break; }
    if (full) cols.push(c);
  }
  return { rows, cols };
}

function clearLines(board, rows, cols) {
  for (const r of rows) for (let c = 0; c < BOARD_SIZE; c++) board[r][c] = null;
  for (const c of cols) for (let r = 0; r < BOARD_SIZE; r++) board[r][c] = null;
}

function shardCountForClear(lineCount) {
  // Section 2: 1 shard/single-line clear, 2/combo, capped at 3 for 4+.
  if (lineCount <= 0) return 0;
  if (lineCount === 1) return 1;
  if (lineCount <= 3) return 2;
  return 3;
}

// Would placing `cells` at (r,c) complete the row `index` (isRow) or column
// `index` (!isRow)? Checks the real board plus the cells this placement would
// add, without mutating anything.
function lineFullWithPlacement(board, r, c, isRow, index, cells) {
  for (let i = 0; i < BOARD_SIZE; i++) {
    const rr = isRow ? index : i;
    const cc = isRow ? i : index;
    const coveredByPlacement = cells.some(([dr, dc]) => r + dr === rr && c + dc === cc);
    if (board[rr][cc] == null && !coveredByPlacement) return false;
  }
  return true;
}

function countLinesCompletedAt(board, cells, r, c) {
  const rowsTouched = new Set();
  const colsTouched = new Set();
  for (const [dr, dc] of cells) { rowsTouched.add(r + dr); colsTouched.add(c + dc); }
  let count = 0;
  for (const rr of rowsTouched) if (lineFullWithPlacement(board, r, c, true, rr, cells)) count++;
  for (const cc of colsTouched) if (lineFullWithPlacement(board, r, c, false, cc, cells)) count++;
  return count;
}

// True if `cells` would complete a line at ANY legal placement on the
// current board — used to pick onboarding "sibling" pieces that are
// structurally guaranteed not to move the shard queue.
function pieceWouldEverClearALine(board, cells) {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (!canPlaceAt(board, cells, r, c)) continue;
      if (countLinesCompletedAt(board, cells, r, c) > 0) return true;
    }
  }
  return false;
}

// The exact queue length (conservative -- assumes only the scripted piece's
// own just-vacated slot is free, i.e. 1 free tray slot; this file never
// relies on an assumption about play order, see header comment) at which a
// combo generating `shardCount` shards produces EXACTLY ONE overflow-into-
// tray shard: enough to deliver the real teaching moment, never enough to
// trigger the tray-growth-past-base-size edge case (gap #7). There is
// exactly one solution per shardCount, not a range -- see REVISION note in
// the header comment for the arithmetic. shardCount=3 (4-line combo) solves
// to ONBOARDING_SAFE_QUEUE_LEVEL (2), kept as its own exported constant
// since it's asserted directly in tests.
function requiredQueueLenForOverflow(shardCount) {
  return QUEUE_CAP - shardCount + 1;
}

// Scans the current, real, player-built board (never fabricates cells — see
// header comment) for a placement that clears lines producing EXACTLY
// `shardCount` shards (per Section 2's shardCountForClear scaling),
// restricted to the design doc's "3-4 line combo" framing -- never arms on
// an ordinary 1-2 line clear just because it happens to also generate 2
// shards. Returns { shape, lineCount } or null.
function findComboOpportunityForShardCount(board, shardCount) {
  let best = null;
  for (const shape of SHAPES) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (!canPlaceAt(board, shape.cells, r, c)) continue;
        const lineCount = countLinesCompletedAt(board, shape.cells, r, c);
        if (lineCount < 3) continue; // design doc: "3-4 line combo" only
        if (shardCountForClear(lineCount) !== shardCount) continue;
        if (!best || lineCount > best.lineCount) best = { shape, lineCount };
      }
    }
  }
  return best;
}

function pickSiblingShapeAvoidingClears(state, board) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const shape = weightedPick(EASY_SHAPES, state.rng);
    if (!pieceWouldEverClearALine(board, shape.cells)) return shape;
  }
  return null; // no non-clearing shape existed on this board (rare/dense edge case)
}

// Decides (without mutating anything) whether the round about to be dealt
// should be armed with the Section 5b scripted combo, and if so, where.
//
// IMPORTANT: `suppressDrain` must be the SAME value maybeRefillTray is about
// to use for its own queue-drain step below. One reserved slot (the target)
// means exactly (TRAY_BASE_SIZE - 1) of the OTHER slots can still drain from
// the queue in this same refill, deterministically, before the scripted
// piece is ever placed — so the queue level "at the literal moment the
// combo fires" is not just today's raw queue length, it's the length AFTER
// that deterministic same-refill drain. Gating on the raw pre-drain length
// here would be checking the wrong quantity — see build report.
function planOnboardingArm(state, suppressDrain) {
  const ob = state.onboarding;
  if (state.firstExposureComplete || ob.firstOverflowHandled) return null;
  if (ob.totalClears < ONBOARDING_ELIGIBLE_AFTER_CLEARS) return null;

  const drainableSlots = TRAY_BASE_SIZE - 1; // 1 slot reserved for the scripted piece
  const shardsThatWillDrain = suppressDrain ? 0 : Math.min(state.shardQueue.length, drainableSlots);
  const postDrainQueueLen = state.shardQueue.length - shardsThatWillDrain;

  // Guard rail, arm-time half — the load-bearing, literal, real-time check
  // is in placePiece at the moment the combo's clear actually resolves; this
  // is what makes that check reliably pass (by construction), not a
  // substitute for it.
  //
  // REVISION: no longer a single "<= ONBOARDING_SAFE_QUEUE_LEVEL" ceiling —
  // that let 3-line/2-shard arms through at queue levels (0, 1, 2) that are
  // structurally incapable of ever producing an overflow (see header comment
  // REVISION note). Each combo size has exactly one queue level that both
  // overflows AND stays growth-safe; only arm when the queue is AT that
  // level for the size of opportunity actually available. Try the bigger,
  // more decisive combo first (4-line/3-shard) as a tie-break preference
  // only, not because it's more likely to be found on the board.
  for (const shardCount of [3, 2]) {
    if (postDrainQueueLen !== requiredQueueLenForOverflow(shardCount)) continue;
    const opportunity = findComboOpportunityForShardCount(state.board, shardCount);
    if (opportunity) {
      return { targetSlot: 0, shape: opportunity.shape, lineCount: opportunity.lineCount };
    }
  }
  return null; // queue isn't at a useful level for any combo size yet, or no matching opportunity exists on the board this round — try again next round
}

function newRandomPiece(state) {
  const pool = state.firstExposureComplete === false
    ? EASY_SHAPES
    : waveWeightedShapes(state.onboarding ? state.onboarding.totalClears : 0);
  const shape = weightedPick(pool, state.rng);
  const color = pick(COLORS, state.rng);
  return { shape: shape.cells, shapeId: shape.id, color, isShard: false };
}

function newShard(state, color, multi) {
  // test seam: allow deterministic shard shapes to be forced in unit tests.
  let shape;
  if (state._forcedShardShapes && state._forcedShardShapes.length) {
    shape = state._forcedShardShapes.shift();
  } else {
    shape = weightedPick(multi ? SHARD_SHAPES_MULTI : SHARD_SHAPES, state.rng);
  }
  return { shape: shape.cells, shapeId: shape.id, color, isShard: true };
}

/**
 * @param {number} seed
 * @param {object} [opts]
 * @param {boolean} [opts.firstExposureComplete] - Section 5b persisted flag.
 *   Defaults to true (scripting OFF) so existing callers (tests, ad-hoc
 *   sims) that don't pass opts see unchanged behavior; main.js is
 *   responsible for reading the real persisted value (default false for a
 *   player who's never completed first exposure) and passing it in.
 * @param {boolean} [opts.firstShardCalloutShown] - has the player already
 *   seen the "first shard generated" callout in a previous session? Also
 *   defaults to true (already shown / suppressed) for the same reason.
 */
export function createGame(seed = Date.now(), opts = {}) {
  const firstExposureComplete = opts.firstExposureComplete !== undefined ? opts.firstExposureComplete : true;
  const firstShardCalloutFired = opts.firstShardCalloutShown !== undefined ? opts.firstShardCalloutShown : true;
  const state = {
    board: emptyBoard(),
    tray: [],
    shardQueue: [],
    score: 0,
    comboStreak: 0, // consecutive clearing placements; resets on a non-clearing placement
    gameOver: false,
    // One-shot save against death-by-plain-misplacement (docs/playtest-findings.md:
    // naive players die in 17-41 turns before the shard system ever engages).
    // Flat, not scaling with wave tier or onboarding state -- deliberately kept
    // orthogonal to the shard/tray-growth safety valves elsewhere in this file.
    mercyChargesRemaining: 1,
    rng: mulberry32(seed >>> 0),
    log: [],
    turn: 0,
    firstExposureComplete,
    // Non-blocking pulse callouts (Section 5b) queued here for main.js to
    // drain and render — core.js has no DOM, so it can only describe the
    // event, not display it.
    pendingCallouts: [],
    onboarding: {
      totalClears: 0,             // real clear-events seen since game start
      armedRound: false,          // is the CURRENT round's tray scripted
      firstOverflowHandled: false,// has the milestone first-ever overflow fired
      // REVISION: was a one-shot `drainSuppressionAvailable` boolean — see
      // header comment. Now a bounded counter so suppression can repeat
      // across refills until the queue actually reaches a useful level.
      suppressedRefillCount: 0,
      // REVISION (see the insertShard growth-safety-valve comment below):
      // true for the whole round following a refill whose drain was
      // suppressed, false otherwise. Needed because repeated suppression
      // reopens the tray-growth risk (gap #7) for ANY clear that happens
      // during that round — not just a scripted piece's own clear — since
      // it artificially recreates the "queue held near cap" precondition
      // playtest-findings.md item 3 identified as dangerous, for a whole
      // round's worth of play, not one instant.
      suppressedThisRound: false,
      firstShardCalloutFired,
      waveTier: 0, // current endless-mode difficulty wave (see WAVE_* constants)
    },
  };
  for (let i = 0; i < TRAY_BASE_SIZE; i++) state.tray.push(newRandomPiece(state));
  return state;
}

function logEvent(state, msg) {
  state.log.push(msg);
  if (state.log.length > 200) state.log.shift();
}

// Insert a single shard per the queue/overflow rule. `vacatedSlotRef` is a
// one-element array acting as a mutable "next preferred empty slot" pointer
// so multiple shards generated in the same turn hand off correctly.
function insertShard(state, shard, vacatedSlotRef) {
  if (state.shardQueue.length < QUEUE_CAP) {
    state.shardQueue.push(shard);
    logEvent(state, `Shard queued (${shard.shapeId}, ${shard.color}). Queue ${state.shardQueue.length}/${QUEUE_CAP}.`);
    return { overflow: false };
  }
  // Overflow escalation: queue is at cap, force-insert into active tray.
  let targetIndex = -1;
  if (vacatedSlotRef[0] !== null && state.tray[vacatedSlotRef[0]] == null) {
    targetIndex = vacatedSlotRef[0];
  } else {
    targetIndex = state.tray.findIndex((slot) => slot == null);
  }

  // GROWTH SAFETY VALVE (game-designer re-verification, docs/playtest-findings.md
  // item 5): no empty tray slot exists, so the general-case rule below would
  // grow the tray past TRAY_BASE_SIZE. Section 8 item 2 already resolved
  // that as fine to LEAVE UNCAPPED for genuine organic play — real growth
  // there requires a compound precondition confirmed near-unreachable across
  // ~4,200 sim games (9/2000 even under an adversarial extreme-hoarder bot,
  // and never inflating tray size in practice). That verdict does NOT carry
  // over to a round where Section 5b's onboarding system elevated the queue
  // toward an armed combo's required level: that state deliberately (or, in
  // the second case below, incidentally) recreates the "queue held near cap"
  // precondition for the *whole round*, so a SECOND, unplanned clear later
  // in that same round can compound with the scripted piece's own overflow
  // and blow past the per-event-safe queue level this file otherwise
  // guarantees. Two independently-confirmed ways in:
  //   - `suppressedThisRound`: drain suppression itself held the queue near
  //     cap (confirmed reachable in re-verification, seeds 107 and 240 of
  //     tools/playtest-sim/sim10_onboarding_overflow_fix.mjs) -- a sibling
  //     piece that was verified safe against the board at deal time becomes
  //     newly clear-capable once an earlier placement in the same round
  //     changes the board.
  //   - `armedRound` without suppression: the queue can organically already
  //     sit AT QUEUE_CAP the instant an eligible refill fires (suppression
  //     never engages here -- see maybeRefillTray's `state.shardQueue.length
  //     < QUEUE_CAP` guard -- but the refill can still arm, because the
  //     deterministic same-refill drain of the OTHER slots can land exactly
  //     on a combo's required post-drain level). That refill deals REAL,
  //     un-vetted drained shards into the round's non-scripted slots (shard
  //     siblings are deliberately never reshaped -- see header comment,
  //     "Section 3 owns that semantics"). If one of those shard siblings gets
  //     played and clears a line before the scripted piece does, its own
  //     overflow can consume the only slot the scripted piece's overflow was
  //     counting on. Confirmed independently reachable by direct simulation
  //     (armed-while-unsuppressed: 46/20,000 games under an adversarial
  //     extreme-hoarder bot; actual compounding sibling clear + reproduced
  //     tray growth to length 5: a hand-constructed repro against this exact
  //     engine, not just traced) -- this is not a hypothetical, `armedRound`
  //     was a real, unguarded second path to the identical bug the
  //     `suppressedThisRound` check already exists to close.
  // Rather than trying to dynamically re-validate every remaining tray piece
  // against the board after every placement (which would mean silently
  // reshaping a piece the player is already looking at mid-round -- worse
  // for legibility than the alternative, same principle the header comment
  // already applies to scripted-piece construction), fail closed both ways:
  // mirror the Section 2 ship-blocking safety rule and auto-convert this
  // shard straight to score instead of growing the tray. Scoped tightly to
  // an active onboarding round (`suppressedThisRound` OR `armedRound`) so it
  // never fires for ordinary organic play outside one -- the locked "leave
  // uncapped" verdict for genuine organic play is unchanged.
  if (targetIndex === -1 && state.onboarding &&
      (state.onboarding.suppressedThisRound || state.onboarding.armedRound)) {
    state.score += shard.shape.length * SCORE_PER_SHARD_CELL_AUTOCONVERT;
    logEvent(state, `[onboarding] GROWTH SAFETY VALVE: queue full, tray full, during an onboarding-affected round (suppressed=${state.onboarding.suppressedThisRound}, armed=${state.onboarding.armedRound}) -- shard ${shard.shapeId} (${shard.color}) auto-converted to score (+${shard.shape.length * SCORE_PER_SHARD_CELL_AUTOCONVERT}) instead of growing the tray past base size.`);
    return { overflow: true, growthPrevented: true };
  }
  // Tag so main.js can render a non-color overflow cue on whichever slot
  // this actually landed in — most overflow shards land back in a regular
  // slot (0..TRAY_BASE_SIZE-1), not just the rare tray-grew extra slot, so
  // the render-side highlight can't rely on slot index alone.
  shard.arrivedViaOverflow = true;
  if (targetIndex === -1) {
    state.tray.push(shard); // temporary extra slot beyond base size 3
    logEvent(state, `OVERFLOW: queue full, tray full -> shard force-appended as extra tray slot (${shard.shapeId}, ${shard.color}).`);
  } else {
    state.tray[targetIndex] = shard;
    if (vacatedSlotRef[0] === targetIndex) vacatedSlotRef[0] = null;
    logEvent(state, `OVERFLOW: queue full -> shard force-inserted into tray slot ${targetIndex} (${shard.shapeId}, ${shard.color}).`);
  }
  return { overflow: true };
}

export function maybeRefillTray(state) {
  if (!state.tray.every((slot) => slot == null)) return;
  const ob = state.onboarding;

  // Section 5b (REVISION — see header comment / playtest-findings.md item
  // 4): suppressing a single refill's drain can only *preserve* whatever
  // queue level already happened to exist, never *raise* it — and organic
  // queue level sits near 0 most of the time. So suppression now applies
  // across every eligible refill (not one-shot), letting the queue actually
  // climb via ordinary shard generation between refills, until it reaches
  // whatever exact level the current best combo opportunity needs, or until
  // ONBOARDING_MAX_SUPPRESSED_REFILLS is hit. Gated on the same eligibility
  // window as arming (totalClears >= ONBOARDING_ELIGIBLE_AFTER_CLEARS) so
  // the bounded budget isn't spent on refills that happen before there's
  // any chance of arming yet.
  const onboardingEligible = !state.firstExposureComplete && ob && !ob.firstOverflowHandled &&
    ob.totalClears >= ONBOARDING_ELIGIBLE_AFTER_CLEARS;
  // Only suppress while the queue hasn't already saturated (QUEUE_CAP) --
  // once it has, suppression can't help it climb further (insertShard never
  // lets it exceed QUEUE_CAP anyway) and any subsequent shard generation
  // already overflows on its own regardless of tray-refill behavior, so the
  // teaching moment is achieved organically at that point either way.
  // IMPORTANT: this must stay <= the higher of the two per-combo-size
  // targets (requiredQueueLenForOverflow(2) === 3) *inclusive* -- suppression
  // needs to still be active exactly AT queue===3 to hold it there for a
  // 3-line/2-shard arm; cutting it off at "< 3" (as an earlier version of
  // this fix did) causes the very next refill to immediately drain the queue
  // back down before a 3-line arm ever gets the chance, silently
  // reintroducing the same class of bug this fix exists to close. Mirrors
  // the original one-shot guard's own "only suppress below the safe level"
  // condition, generalized to the top of the two per-combo-size targets.
  const suppressDrain = onboardingEligible && ob.suppressedRefillCount < ONBOARDING_MAX_SUPPRESSED_REFILLS &&
    state.shardQueue.length < QUEUE_CAP;

  // Decide arming BEFORE draining (see planOnboardingArm) — the target slot
  // must be reserved so the drain loop below never fills it with a real
  // shard that would then just be silently discarded when the scripted
  // piece is written into it.
  const armPlan = ob ? planOnboardingArm(state, suppressDrain) : null;

  if (ob) ob.suppressedThisRound = suppressDrain;

  if (suppressDrain) {
    ob.suppressedRefillCount += 1;
    logEvent(state, `[onboarding] suppressed this round's queue drain (queue was ${state.shardQueue.length}/${QUEUE_CAP}, suppressed refill ${ob.suppressedRefillCount}/${ONBOARDING_MAX_SUPPRESSED_REFILLS}).`);
  }

  const fresh = [];
  for (let i = 0; i < TRAY_BASE_SIZE; i++) {
    if (armPlan && i === armPlan.targetSlot) {
      fresh.push(null); // reserved — filled in below, after draining
      continue;
    }
    if (!suppressDrain && state.shardQueue.length > 0) {
      const shard = state.shardQueue.shift();
      fresh.push(shard);
      logEvent(state, `Tray refill slot ${i}: drained shard from queue (${shard.shapeId}, ${shard.color}). Queue ${state.shardQueue.length}/${QUEUE_CAP}.`);
    } else {
      fresh.push(newRandomPiece(state));
    }
  }

  if (armPlan) {
    fresh[armPlan.targetSlot] = {
      shape: armPlan.shape.cells,
      shapeId: armPlan.shape.id,
      color: pick(COLORS, state.rng),
      isShard: false,
      isScriptedCombo: true,
    };
    // Re-check the OTHER slots against what actually got dealt into them
    // (which may include a drained shard, not just a fresh random piece).
    for (let i = 0; i < fresh.length; i++) {
      if (i === armPlan.targetSlot) continue;
      const sibling = fresh[i];
      // Never reshape a drained shard — Section 3 owns that semantics, not
      // Section 5b; a shard sibling clearing a line before the scripted
      // piece is placed is a documented, narrow residual risk (see build
      // report), closed by the live fire-time check in placePiece instead.
      if (!sibling || sibling.isShard) continue;
      if (pieceWouldEverClearALine(state.board, sibling.shape)) {
        const safeShape = pickSiblingShapeAvoidingClears(state, state.board);
        if (safeShape) fresh[i] = { shape: safeShape.cells, shapeId: safeShape.id, color: pick(COLORS, state.rng), isShard: false };
      }
    }
    ob.armedRound = true;
    logEvent(state, `[onboarding] armed scripted ${armPlan.lineCount}-line combo in tray slot ${armPlan.targetSlot} (queue will be ${state.shardQueue.length}/${QUEUE_CAP} at fire time).`);
  } else if (ob) {
    ob.armedRound = false;
  }

  // Joint-solvability mercy (game-designer follow-up to the single-piece
  // MERCY_MAX_OPEN_REGION rule above): a fresh 3-piece tray can pass the
  // OLD check (every piece fits *somewhere*, independently) while still
  // having no order that lands all three -- e.g. two pieces only fit the
  // same cells. Shares the same one-shot mercyChargesRemaining budget as the
  // single-piece rule (a deliberate choice, not an oversight: this is a
  // strictly rarer, strictly stronger trigger condition, not a second free
  // resource) -- consuming it here means the game guarantees THIS freshly-
  // dealt hand has a way through, at the cost of not also being able to save
  // a later genuine top-out. Only ever swaps a fresh, non-shard, non-scripted
  // slot (shards/scripted pieces keep their existing "never reshape" rules)
  // and only when a swap can be found that actually restores solvability --
  // if no candidate works, the tray is left as dealt rather than pretending
  // to have fixed it. Deliberately does NOT protect against a player
  // misplacing pieces after this check passes -- see build report.
  if (fresh.every((slot) => slot != null) && state.mercyChargesRemaining > 0) {
    const shapes = fresh.map((slot) => slot.shape);
    if (!canPlaceAllPieces(state.board, shapes)) {
      const bySize = [...EASY_SHAPES].sort((a, b) => a.cells.length - b.cells.length);
      outer:
      for (let i = 0; i < fresh.length; i++) {
        if (armPlan && i === armPlan.targetSlot) continue; // never touch the scripted piece
        if (fresh[i].isShard) continue; // never reshape a drained shard -- Section 3 owns that semantics
        for (const candidate of bySize) {
          const trial = shapes.slice();
          trial[i] = candidate.cells;
          if (canPlaceAllPieces(state.board, trial)) {
            fresh[i] = { shape: candidate.cells, shapeId: candidate.id, color: pick(COLORS, state.rng), isShard: false, isMercy: true };
            state.mercyChargesRemaining -= 1;
            logEvent(state, `MERCY: freshly dealt tray had no order that placed all ${fresh.length} pieces -- swapped slot ${i} for a guaranteed-fit ${candidate.id} (charges remaining: ${state.mercyChargesRemaining}).`);
            state.pendingCallouts.push({ type: 'mercy', text: 'This hand always has a way through -- find it.' });
            break outer;
          }
        }
      }
    }
  }

  state.tray = fresh;
}

// Smallest EASY_SHAPES shape that fits somewhere on `board` right now, or
// null if the board has zero empty cells (degenerate/unreachable -- even a
// mono can't land). Not clear-avoiding (see MERCY_MIN_FILL_PERCENT comment
// below for why that layer doesn't matter): whether the mercy piece itself
// completes a line isn't the lever that controls rescue magnitude.
function findMercyShape(board) {
  const bySize = [...EASY_SHAPES].sort((a, b) => a.cells.length - b.cells.length);
  for (const shape of bySize) {
    if (findAnyPlacement(board, shape.cells) != null) return shape;
  }
  return null;
}

// Size (in cells) of the largest 4-connected contiguous empty region on
// `board`. This is the fragmentation metric mercy eligibility is gated on
// (see MERCY_MAX_OPEN_REGION below) -- raw fill% (an earlier, reverted
// iteration) doesn't distinguish "genuinely cramped everywhere" from
// "plenty of open space, just not shaped like this tray," and sim13 showed
// those two situations both happen at the same ~49-65% fill across every
// bot skill level. Largest-contiguous-empty-region does distinguish them.
export function largestEmptyRegionSize(board) {
  const seen = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));
  let largest = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] != null || seen[r][c]) continue;
      let size = 0;
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [rr, cc] = stack.pop();
        size++;
        for (const [nr, nc] of [[rr - 1, cc], [rr + 1, cc], [rr, cc - 1], [rr, cc + 1]]) {
          if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
          if (board[nr][nc] != null || seen[nr][nc]) continue;
          seen[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }
      if (size > largest) largest = size;
    }
  }
  return largest;
}

// Gate, verified via tools/playtest-sim/sim13_mercy_piece_verify.mjs: mercy
// firing for a greedy-clearer bot on a board with plenty of open space
// elsewhere (just not shaped like its current tray) nearly doubled its total
// game length (968->1691 avg turns) by unsticking a merely LOCALLY-blocked
// board that the bot's ordinary next few draws could resume normal, lengthy
// play from -- not a genuine top-out. Two earlier iterations didn't fix this:
// constraining the mercy piece's own shape (the cascade comes from ANY legal
// placement unsticking the board, not the mercy piece's own combo) and
// gating on raw fill% (all four bot profiles' dead-ends cluster at the same
// 49-65% fill regardless of skill, so there's no separate high-fill
// "genuine top-out" population to reserve mercy for).
//
// Gating on fragmentation instead targets the actual mechanism: if the
// largest open region left on the board is still bigger than this cap, the
// board isn't really stuck -- there's real room elsewhere, just a tray/shape
// mismatch, and a real player's next few random draws would likely resolve
// it same as the bot's did. Below the cap, there's nowhere meaningful left
// regardless of what shape shows up next -- that's the genuine top-out mercy
// exists to catch.
//
// Calibrated against sim13_mercy_piece_verify.mjs (300 games/profile): at 6,
// greedy-clearer/combo-hoarder (skilled) lifetime shift is negligible
// (967.9->974.5 and 210.3->213.2 avg turns, <1.5% change -- no windfall),
// while naive/random (weak) still get a real, much smaller than uncapped,
// assist (40.0->41.1 and 17.9->19.6 avg turns) at a lower, more plausible
// engagement rate (16.7%/37.7% of games, vs. 100% uncapped) -- consistent
// with "occasionally saves a genuine top-out," not "saves every game."
export const MERCY_MAX_OPEN_REGION = 6;

// True if there exists SOME order to place every shape in `pieces` such that
// each placement is individually legal on the board at the moment it's made,
// applying line-clears in between (real placePiece clear rules, just no
// shard generation -- this is a "can these pieces physically all land
// somewhere" check for tray-deal-time solvability, not a full turn
// simulation). Backtracking search: 3 pieces x <=64 board cells is small
// enough to run once per tray refill without a noticeable frame hitch.
export function canPlaceAllPieces(board, pieces) {
  if (pieces.length === 0) return true;
  for (let i = 0; i < pieces.length; i++) {
    const shape = pieces[i];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (!canPlaceAt(board, shape, r, c)) continue;
        const next = board.map((row) => row.slice());
        stampPiece(next, shape, r, c, '#');
        const { rows, cols } = findFullLines(next);
        if (rows.length || cols.length) clearLines(next, rows, cols);
        const rest = pieces.slice(0, i).concat(pieces.slice(i + 1));
        if (canPlaceAllPieces(next, rest)) return true;
      }
    }
  }
  return false;
}

export function checkGameOver(state) {
  const anyFits = state.tray.some((slot) => slot != null && findAnyPlacement(state.board, slot.shape) != null);
  if (!state.tray.some((slot) => slot != null) || anyFits) return;

  if (state.mercyChargesRemaining > 0 && largestEmptyRegionSize(state.board) <= MERCY_MAX_OPEN_REGION) {
    const mercyShape = findMercyShape(state.board);
    if (mercyShape) {
      const slotIndex = state.tray.findIndex((slot) => slot != null);
      state.mercyChargesRemaining -= 1;
      state.tray[slotIndex] = {
        shape: mercyShape.cells,
        shapeId: mercyShape.id,
        color: pick(COLORS, state.rng),
        isShard: false,
        isMercy: true,
      };
      logEvent(state, `MERCY: no tray piece fit anywhere (largest open region ${largestEmptyRegionSize(state.board)} cells) -- swapped tray slot ${slotIndex} (was unplaceable) for a guaranteed-fit ${mercyShape.id} (charges remaining: ${state.mercyChargesRemaining}).`);
      state.pendingCallouts.push({ type: 'mercy', text: 'One more move -- a piece just cleared a path for you.' });
      return;
    }
  }

  state.gameOver = true;
  logEvent(state, 'GAME OVER: no tray piece fits anywhere on the board.');
}

/**
 * Resolve a single already-generated shard against the current board: apply
 * the ship-blocking safety rule (Section 2), and on success, the queue /
 * overflow-escalation insertion rule (Section 3, step 2). Split out from
 * placePiece so it's independently unit-testable without needing to
 * construct a full, "legally reachable" clear -- see tests/core.test.mjs for
 * why that's structurally near-impossible to do for the safety-rule branch
 * given this engine's whole-line-clear mechanics.
 */
export function resolveGeneratedShard(state, shard, vacatedSlotRef) {
  const placeable = findAnyPlacement(state.board, shard.shape) != null;
  if (!placeable) {
    // Ship-blocking safety rule: unplaceable shard auto-converts to score.
    state.score += shard.shape.length * SCORE_PER_SHARD_CELL_AUTOCONVERT;
    logEvent(state, `Shard ${shard.shapeId} (${shard.color}) unplaceable anywhere -> auto-converted to score (+${shard.shape.length * SCORE_PER_SHARD_CELL_AUTOCONVERT}).`);
    return { queued: false, autoConverted: true };
  }
  const { overflow } = insertShard(state, shard, vacatedSlotRef);
  const ob = state.onboarding;

  // Section 5b comprehension callouts — each fires at most once ever (the
  // "already fired" flags are seeded from persisted state via createGame's
  // opts, so a returning player who's already seen these doesn't see them
  // again on a fresh game).
  if (!overflow && ob && !ob.firstShardCalloutFired) {
    ob.firstShardCalloutFired = true;
    state.pendingCallouts.push({ type: 'first-shard', text: FIRST_SHARD_CALLOUT_TEXT });
  }
  if (overflow && ob && !ob.firstOverflowHandled) {
    ob.firstOverflowHandled = true;
    // "After that first overflow fires, flip the flag permanently... hand
    // back to true RNG." Fires on ANY first overflow (organic or scripted) —
    // the exposure system's job is done as soon as the real teaching moment
    // happens, by whatever means it happened.
    state.firstExposureComplete = true;
    state.pendingCallouts.push({ type: 'first-overflow', text: FIRST_OVERFLOW_CALLOUT_TEXT });
  }

  return { queued: true, autoConverted: false };
}

/**
 * Attempt to place tray[trayIndex] at board (r,c). Runs the full fixed
 * resolution order on success. Returns { ok, reason? }.
 */
export function placePiece(state, trayIndex, r, c) {
  if (state.gameOver) return { ok: false, reason: 'game-over' };
  const piece = state.tray[trayIndex];
  if (!piece) return { ok: false, reason: 'empty-slot' };
  if (!canPlaceAt(state.board, piece.shape, r, c)) return { ok: false, reason: 'blocked' };

  stampPiece(state.board, piece.shape, r, c, piece.color);
  state.score += piece.shape.length * SCORE_PER_CELL_PLACED;
  state.tray[trayIndex] = null;
  const vacatedSlotRef = [trayIndex];
  state.turn += 1;

  // Step 1: line clear + shard generation.
  const { rows, cols } = findFullLines(state.board);
  const lineCount = rows.length + cols.length;
  let comboStreak = 0;
  let wholeFieldClear = false;
  if (lineCount > 0) {
    clearLines(state.board, rows, cols);
    state.score += lineCount * SCORE_PER_LINE_CLEAR;

    state.comboStreak += lineCount;
    comboStreak = state.comboStreak;
    if (state.comboStreak > 1) {
      const comboBonus = state.comboStreak * SCORE_PER_COMBO_STEP;
      state.score += comboBonus;
      logEvent(state, `Combo x${state.comboStreak}! (+${comboBonus})`);
    }

    if (isBoardEmpty(state.board)) {
      wholeFieldClear = true;
      state.score += SCORE_WHOLE_FIELD_CLEAR_BONUS;
      logEvent(state, `Whole-field clear! (+${SCORE_WHOLE_FIELD_CLEAR_BONUS})`);
    }

    logEvent(state, `Cleared ${lineCount} line(s) (rows:[${rows}] cols:[${cols}]) with a ${piece.color} ${piece.shapeId}.`);
    if (state.onboarding) {
      state.onboarding.totalClears += 1;
      const newTier = waveTierForClears(state.onboarding.totalClears);
      if (newTier > state.onboarding.waveTier) {
        state.onboarding.waveTier = newTier;
        state.pendingCallouts.push({ type: 'wave', tier: newTier, text: waveCalloutText(newTier) });
      }
    }

    if (piece.isScriptedCombo && lineCount >= 3) {
      // Guard rail (design doc Section 5b / playtest-findings.md items 3-4):
      // literal, real-time read of the queue level at the exact moment the
      // scripted combo's clear resolves — checked here, at shard-generation
      // time, not at deal/arm time. This is what tests/core.test.mjs asserts
      // directly, and what a naive "looks roughly near cap" version of this
      // script got wrong (see playtest-findings.md item 3).
      //
      // REVISION: the required queue level is now specific to this combo's
      // actual shard count, not one shared constant — a 3-line/2-shard combo
      // legitimately (and safely) fires at queue=3, which used to
      // over-trigger this warning as a false positive (see header comment
      // REVISION note). Only the "too high" direction (risking tray growth)
      // is a real WARNING; "too low" just means this particular arm won't
      // overflow (harmless, no growth risk) — logged for diagnostics, not
      // alarmed, since planOnboardingArm/suppression will retry.
      const queueLenAtFire = state.shardQueue.length;
      const shardCountThisCombo = shardCountForClear(lineCount);
      const requiredQueueLenAtFire = requiredQueueLenForOverflow(shardCountThisCombo);
      state.onboarding.lastScriptedFireQueueLen = queueLenAtFire;
      if (queueLenAtFire > requiredQueueLenAtFire) {
        logEvent(state, `[onboarding] GUARD-RAIL WARNING: scripted combo fired with queue ${queueLenAtFire}/${QUEUE_CAP}, above the verified-safe level ${requiredQueueLenAtFire}/${QUEUE_CAP} for this ${shardCountThisCombo}-shard combo. This should not happen given the arm-time gate + non-clearing sibling shapes; if it does, normal engine resolution still runs below, unmodified, exactly as it would for organic play.`);
      } else if (queueLenAtFire < requiredQueueLenAtFire) {
        logEvent(state, `[onboarding] scripted combo fired with queue ${queueLenAtFire}/${QUEUE_CAP}, below the ${requiredQueueLenAtFire}/${QUEUE_CAP} needed for this ${shardCountThisCombo}-shard combo to overflow — no teaching moment this time, arm logic will retry a later round.`);
      } else {
        logEvent(state, `[onboarding] scripted combo fired with queue ${queueLenAtFire}/${QUEUE_CAP}, exactly the level needed for this ${shardCountThisCombo}-shard combo to overflow -- teaching moment on track.`);
      }
    }

    const shardCount = shardCountForClear(lineCount);
    for (let i = 0; i < shardCount; i++) {
      const shard = newShard(state, piece.color, shardCount > 1);
      // Steps 1 (safety rule) + 2 (queue/overflow) for this shard.
      resolveGeneratedShard(state, shard, vacatedSlotRef);
    }
  } else {
    state.comboStreak = 0;
  }

  // Step 3: tray refill (queue drains first), only once ALL slots empty.
  maybeRefillTray(state);

  // Step 4: game-over check, last.
  checkGameOver(state);

  // Additive fields only (existing callers/tests only ever assert `.ok`) --
  // gives main.js enough structured info to drive sound/juice effects
  // (line-clear chime + flash/shake, shard-scatter sound) without re-parsing
  // state.log strings or re-deriving line count from board diffing.
  return {
    ok: true, lineCount, rows, cols, shardCount: lineCount > 0 ? shardCountForClear(lineCount) : 0,
    comboStreak, wholeFieldClear,
  };
}

export function canPlaceAnySlot(state) {
  return state.tray.some((slot) => slot != null && findAnyPlacement(state.board, slot.shape) != null);
}
