// Re-verification of the Section 5b overflow-rate FIX (game-designer
// dispatch, docs/playtest-findings.md item 5 -- follows on from the PM's
// gap-finding run, sim9_pm_verify_5b_overflow_rate.mjs).
//
// Runs TWO bot policies against the real engine (src/core.js), not a
// reimplementation:
//   - hoarder: same combo-hoarder policy PM used in sim9, kept for a direct
//     apples-to-apples before/after comparison of the exact scenario that
//     found the gap.
//   - naive: same careless/first-legal-move policy as
//     tools/playtest-sim/sim2.mjs's botNaive -- this is the actual at-risk
//     audience Section 5b exists to protect (playtest-findings.md item 1:
//     "naive/weak players die in 17-41 turns... shard system may never
//     engage"), so the hoarder-only number alone is not sufficient evidence
//     the fix works for the population it was built for.
//
// Also tracks:
//   - tray-growth (gap #7) -- must stay 0 across every run, this is the
//     regression the growth safety valve exists to prevent.
//   - "silent misses" -- an armed round whose scripted piece never actually
//     fires a >=3-line clear before the round ends (PM's secondary finding:
//     sibling pieces consuming the board cells the plan depended on, plus
//     any other cause of the same symptom).
//   - turn-of-first-overflow, to sanity-check it still lands early relative
//     to a full game, not just "eventually, off in the very long tail."
//
// Run: node tools/playtest-sim/sim10_onboarding_overflow_fix.mjs [gameCount]

import { createGame, placePiece, canPlaceAt, TRAY_BASE_SIZE, ONBOARDING_ELIGIBLE_AFTER_CLEARS } from '../../src/core.js';
import { BOARD_SIZE } from '../../src/pieces.js';

function cloneBoard(b) { return b.map(row => row.slice()); }
function evalLinesForBoard(board) {
  let rows = 0, cols = 0;
  for (let r = 0; r < BOARD_SIZE; r++) if (board[r].every(c => c != null)) rows++;
  for (let c = 0; c < BOARD_SIZE; c++) { let full = true; for (let r=0;r<BOARD_SIZE;r++) if (board[r][c]==null){full=false;break;} if (full) cols++; }
  return rows + cols;
}
function allMoves(state) {
  const moves = [];
  for (let slot = 0; slot < state.tray.length; slot++) {
    const piece = state.tray[slot];
    if (!piece) continue;
    for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) {
      if (!canPlaceAt(state.board, piece.shape, r, c)) continue;
      const b = cloneBoard(state.board);
      for (const [dr, dc] of piece.shape) b[r+dr][c+dc] = { color: '#x' };
      moves.push({ slot, r, c, lines: evalLinesForBoard(b) });
    }
  }
  return moves;
}
// Bot B (sim2.mjs/sim9's policy): combo-hoarder -- prefers any 2+ line clear
// over a 1-line clear, otherwise avoids clearing at all if it can help it.
function hoarderMove(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => {
    const score = m.lines >= 2 ? m.lines * 1000 : -m.lines;
    if (!best || score > best.score) return { ...m, score };
    return best;
  }, null);
}
// Bot C (sim2.mjs's botNaive): careless -- first legal placement for tray
// slot 0, falling through to slot 1/2 if slot 0 has no legal placement. No
// clear-seeking, no compactness. This is the weak/inattentive-casual
// profile Section 5b was written for.
function naiveMove(state) {
  for (let slot = 0; slot < state.tray.length; slot++) {
    const piece = state.tray[slot];
    if (!piece) continue;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (canPlaceAt(state.board, piece.shape, r, c)) return { slot, r, c };
      }
    }
  }
  return null;
}

function runBotPolicy(name, moveFn, N) {
  let armedCount = 0, armedLineCounts = {};
  let overflowCount = 0, maxTrayLenSeen = TRAY_BASE_SIZE, growthEvents = 0;
  let games = 0, gamesWithFirstOverflow = 0, gamesNeverEligible = 0;
  let firstOverflowTurns = [];
  let silentMisses = 0, silentMissSeeds = [];
  let growthSeeds = [];

  for (let seed = 1; seed <= N; seed++) {
    const state = createGame(seed, { firstExposureComplete: false, firstShardCalloutShown: false });
    games++;
    let turn = 0;
    let sawFirstOverflowThisGame = false;
    let pendingArmFired = null; // true/false/null while an armed round is in flight
    while (!state.gameOver && turn < 500) {
      const move = moveFn(state);
      if (!move) break;
      const before = state.log.length;
      placePiece(state, move.slot, move.r, move.c);
      turn++;
      const newLogs = state.log.slice(before);
      for (const l of newLogs) {
        const armMatch = l.match(/armed scripted (\d+)-line combo.*queue will be (\d+)\/(\d+)/);
        if (armMatch) {
          if (pendingArmFired === false) { silentMisses++; silentMissSeeds.push(seed); }
          armedCount++;
          const lc = armMatch[1];
          armedLineCounts[lc] = (armedLineCounts[lc]||0)+1;
          pendingArmFired = false; // reset -- waiting to see if THIS arm fires
        }
        if (l.includes('scripted combo fired with queue')) pendingArmFired = true;
        if (l.startsWith('OVERFLOW')) overflowCount++;
      }
      if (state.tray.length > maxTrayLenSeen) {
        maxTrayLenSeen = state.tray.length;
        growthEvents++;
        growthSeeds.push({ seed, turn, trayLen: state.tray.length });
      }
      if (state.pendingCallouts?.length) {
        for (const co of state.pendingCallouts) {
          if (co.type === 'first-overflow') {
            firstOverflowTurns.push(turn);
            sawFirstOverflowThisGame = true;
          }
        }
        state.pendingCallouts.length = 0;
      }
    }
    // Game ended (or hit the turn cap) with an arm still pending -> counts as
    // a silent miss too (the round never got to complete, e.g. game-over).
    if (pendingArmFired === false) { silentMisses++; silentMissSeeds.push(seed); }
    if (sawFirstOverflowThisGame) gamesWithFirstOverflow++;
    if (state.onboarding.totalClears < ONBOARDING_ELIGIBLE_AFTER_CLEARS) gamesNeverEligible++;
  }

  const avg = (arr) => arr.length ? (arr.reduce((a,b)=>a+b,0) / arr.length) : null;
  return {
    bot: name,
    games,
    armedCount,
    armedLineCounts,
    overflowCount,
    gamesWithFirstOverflow,
    gamesWithZeroOverflow: games - gamesWithFirstOverflow,
    overflowRatePct: +(100 * gamesWithFirstOverflow / games).toFixed(1),
    gamesNeverReachedEligibility: gamesNeverEligible,
    avgTurnOfFirstOverflow: avg(firstOverflowTurns) === null ? null : +avg(firstOverflowTurns).toFixed(1),
    medianTurnOfFirstOverflow: firstOverflowTurns.length ? firstOverflowTurns.slice().sort((a,b)=>a-b)[Math.floor(firstOverflowTurns.length/2)] : null,
    silentMisses,
    silentMissRatePct: armedCount ? +(100 * silentMisses / armedCount).toFixed(1) : 0,
    growthEvents,
    maxTrayLenSeen,
    growthSeeds: growthSeeds.slice(0, 5),
  };
}

const N = Number(process.argv[2]) || 300;
const results = [runBotPolicy('hoarder', hoarderMove, N), runBotPolicy('naive', naiveMove, N)];
console.log(JSON.stringify(results, null, 2));
