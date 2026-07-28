// Verifies the mercy-piece fix (core.js checkGameOver) actually moves the
// documented 17-41 turn death number for weak/naive players, not just that
// it passes unit tests. Compares WITH mercy (default engine behavior) against
// a baseline run where mercyChargesRemaining is forced to 0 right after
// createGame, i.e. exactly the pre-fix behavior, same seeds, same bot.
//
// Also covers the skilled profiles (greedy-clearer, combo-hoarder) per
// game-engineer's follow-up: the original run only checked naive/random and
// couldn't speak to "does mercy erode decision density for skilled players."
// A skilled bot should engage mercy near 0% -- if it doesn't, that's a sign
// EASY_SHAPES-fit logic or wave-tier pacing is creating false dead-ends even
// for good play, not that the naive-bot numbers are wrong.
//
// Each mercy-fire event also records turn number + board-fill% at that
// moment, split by bot profile, to distinguish "genuine late-game top-out"
// (late, high fill) from "early misplay spiral" (mid-game, moderate fill).
import { createGame, placePiece, canPlaceAt, TRAY_BASE_SIZE, largestEmptyRegionSize } from '../../src/core.js';
import { BOARD_SIZE } from '../../src/pieces.js';

function cloneBoard(b) { return b.map(row => row.slice()); }
function evalLinesForBoard(board) {
  let rows = 0, cols = 0;
  for (let r = 0; r < BOARD_SIZE; r++) if (board[r].every(c => c != null)) rows++;
  for (let c = 0; c < BOARD_SIZE; c++) {
    let full = true;
    for (let r = 0; r < BOARD_SIZE; r++) if (board[r][c] == null) { full = false; break; }
    if (full) cols++;
  }
  return rows + cols;
}
function adjacencyScore(board, cells, r, c) {
  let score = 0;
  for (const [dr, dc] of cells) {
    const rr = r + dr, cc = c + dc;
    for (const [nr, nc] of [[rr - 1, cc], [rr + 1, cc], [rr, cc - 1], [rr, cc + 1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) { score += 1; continue; }
      if (board[nr][nc] != null) score += 2;
    }
  }
  return score;
}
function allMoves(state) {
  const moves = [];
  for (let slot = 0; slot < state.tray.length; slot++) {
    const piece = state.tray[slot];
    if (!piece) continue;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (!canPlaceAt(state.board, piece.shape, r, c)) continue;
        const b = cloneBoard(state.board);
        for (const [dr, dc] of piece.shape) b[r + dr][c + dc] = { color: '#x' };
        const lines = evalLinesForBoard(b);
        const adj = adjacencyScore(state.board, piece.shape, r, c);
        moves.push({ slot, r, c, lines, adj });
      }
    }
  }
  return moves;
}

// Bot A from sim2.mjs: greedy-clearer -- always maximizes lines cleared, "optimal" player.
function botGreedyClear(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => {
    const score = m.lines * 1000 + m.adj;
    if (!best || score > best.score) return { ...m, score };
    return best;
  }, null);
}

// Bot B from sim2.mjs: combo-hoarder -- avoids single-line clears in favor of building 2+ combos.
function botComboHoarder(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => {
    const score = m.lines >= 2 ? m.lines * 1000 + m.adj : m.adj;
    if (!best || score > best.score) return { ...m, score };
    return best;
  }, null);
}

// Bot C from sim2.mjs: naive/careless -- first legal placement it finds,
// slot 0 first. This is the profile the 17-41 turn finding is about.
function botNaive(state) {
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

// Bot D from sim2.mjs: uniformly random legal move -- weaker still, useful
// as a lower bound / stress case for how often mercy actually engages.
function botRandom(state, rng) {
  const moves = [];
  for (let slot = 0; slot < state.tray.length; slot++) {
    const piece = state.tray[slot];
    if (!piece) continue;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (canPlaceAt(state.board, piece.shape, r, c)) moves.push({ slot, r, c });
      }
    }
  }
  if (!moves.length) return null;
  return moves[Math.floor(rng() * moves.length)];
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillPercent(board) {
  let filled = 0;
  for (const row of board) for (const cell of row) if (cell != null) filled++;
  return (100 * filled) / (BOARD_SIZE * BOARD_SIZE);
}

function playGame(botFn, seed, maxTurns, disableMercy) {
  const state = createGame(seed);
  if (disableMercy) state.mercyChargesRemaining = 0;
  const rng = mulberry32(seed ^ 0x1234abcd);
  let turn = 0;
  let mercyFired = 0;
  let mercyFireTurn = null;
  let mercyFireFillPercent = null;
  let mercyFireOpenRegion = null;
  while (!state.gameOver && turn < maxTurns) {
    const before = state.mercyChargesRemaining;
    const move = botFn(state, rng);
    if (!move) break;
    placePiece(state, move.slot, move.r, move.c);
    turn++;
    if (state.mercyChargesRemaining < before) {
      mercyFired++;
      mercyFireTurn = turn;
      mercyFireFillPercent = fillPercent(state.board);
      mercyFireOpenRegion = largestEmptyRegionSize(state.board);
    }
  }
  return { seed, turns: turn, gameOver: state.gameOver, mercyFired, mercyFireTurn, mercyFireFillPercent, mercyFireOpenRegion };
}

function summarize(results) {
  const turns = results.map(r => r.turns).sort((a, b) => a - b);
  const died = results.filter(r => r.gameOver).length;
  const mercySaves = results.filter(r => r.mercyFired > 0).length;
  const avg = (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1);
  const median = turns[Math.floor(turns.length / 2)];
  const p10 = turns[Math.floor(turns.length * 0.1)];
  return { avg, median, p10, min: turns[0], max: turns[turns.length - 1], died, mercySaves, N: results.length };
}

function summarizeMercyFireContext(withMercyResults) {
  const fired = withMercyResults.filter(r => r.mercyFired > 0);
  if (!fired.length) return { count: 0 };
  const turns = fired.map(r => r.mercyFireTurn).sort((a, b) => a - b);
  const fills = fired.map(r => r.mercyFireFillPercent).sort((a, b) => a - b);
  const regions = fired.map(r => r.mercyFireOpenRegion).sort((a, b) => a - b);
  const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
  return {
    count: fired.length,
    avgFireTurn: avg(turns), medianFireTurn: turns[Math.floor(turns.length / 2)],
    avgFillPercentAtFire: avg(fills), medianFillPercentAtFire: fills[Math.floor(fills.length / 2)],
    avgOpenRegionAtFire: avg(regions), medianOpenRegionAtFire: regions[Math.floor(regions.length / 2)],
  };
}

function runComparison(name, botFn, N, maxTurns) {
  const withMercy = [];
  const withoutMercy = [];
  for (let i = 0; i < N; i++) {
    const seed = 9000 + i;
    withMercy.push(playGame(botFn, seed, maxTurns, false));
    withoutMercy.push(playGame(botFn, seed, maxTurns, true));
  }
  const sM = summarize(withMercy);
  const sB = summarize(withoutMercy);
  const fireCtx = summarizeMercyFireContext(withMercy);
  console.log(`\n=== ${name} (${N} games, same seeds both arms) ===`);
  console.log('baseline (mercy off, i.e. pre-fix):', sB);
  console.log('with mercy (current engine):       ', sM);
  console.log(`turn-of-death shift: avg ${sB.avg} -> ${sM.avg}, median ${sB.median} -> ${sM.median}, p10 ${sB.p10} -> ${sM.p10}`);
  console.log(`mercy engaged in ${sM.mercySaves}/${N} games (${(100 * sM.mercySaves / N).toFixed(1)}%)`);
  console.log('mercy-fire context (turn / board-fill% at the moment mercy fired):', fireCtx);
}

const N = parseInt(process.argv[2] || '300', 10);
const CAP = parseInt(process.argv[3] || '3000', 10);

runComparison('greedy-clearer (optimal/skilled)', botGreedyClear, N, CAP);
runComparison('combo-hoarder (skilled)', botComboHoarder, N, CAP);
runComparison('naive/careless', botNaive, N, CAP);
runComparison('random-legal', botRandom, N, CAP);
