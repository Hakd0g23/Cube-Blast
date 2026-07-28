import {
  createGame, placePiece, canPlaceAt, findAnyPlacement, QUEUE_CAP, TRAY_BASE_SIZE,
} from '../../src/core.js';
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
    for (const [nr, nc] of [[rr-1,cc],[rr+1,cc],[rr,cc-1],[rr,cc+1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) { score += 1; continue; }
      if (board[nr][nc] != null) score += 2;
    }
  }
  return score;
}

// Greedy 1-ply bot: for each fillable tray slot, for each legal position,
// score = lines cleared (heavily weighted) + adjacency/compactness tiebreak.
// Picks the best (slot, r, c) each turn. Reasonably competent, no lookahead,
// no explicit combo-holding strategy (matches what an average genre player does).
function chooseMove(state) {
  let best = null;
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
        const score = lines * 1000 + adj;
        if (!best || score > best.score) best = { slot, r, c, score, lines };
      }
    }
  }
  return best;
}

function playGame(seed, maxTurns = 5000) {
  const state = createGame(seed);
  const trayMax = { size: TRAY_BASE_SIZE };
  let turnsWithInflatedTray = 0;
  let maxTraySeen = TRAY_BASE_SIZE;
  let overflowEvents = 0;
  let autoConvertEvents = 0;
  let queueFullTurns = 0;
  let turn = 0;
  let logTail = [];
  let lastFullDrainTurn = 0;
  let longestNoDrainStreak = 0;

  while (!state.gameOver && turn < maxTurns) {
    const move = chooseMove(state);
    if (!move) break; // shouldn't happen if gameOver check is correct, but guard anyway
    const before = state.log.length;
    const wasAllEmptyPossible = state.tray.every(s => s == null);
    placePiece(state, move.slot, move.r, move.c);
    turn++;

    const newLines = state.log.slice(before);
    for (const l of newLines) {
      if (l.startsWith('OVERFLOW')) overflowEvents++;
      if (l.includes('auto-converted to score')) autoConvertEvents++;
    }
    if (state.tray.length > TRAY_BASE_SIZE) turnsWithInflatedTray++;
    if (state.tray.length > maxTraySeen) maxTraySeen = state.tray.length;
    if (state.shardQueue.length >= QUEUE_CAP) queueFullTurns++;

    // track drain streaks: a "drain" is a tray refill event (log line 'Tray refill slot 0')
    const drained = newLines.some(l => l.includes('Tray refill slot 0'));
    if (drained) {
      const streak = turn - lastFullDrainTurn;
      if (streak > longestNoDrainStreak) longestNoDrainStreak = streak;
      lastFullDrainTurn = turn;
    }

    logTail = state.log.slice(-400); // keep recent for inspection
  }
  const finalStreak = turn - lastFullDrainTurn;
  if (finalStreak > longestNoDrainStreak) longestNoDrainStreak = finalStreak;

  return {
    seed, turns: turn, score: state.score, gameOver: state.gameOver,
    maxTraySeen, turnsWithInflatedTray, overflowEvents, autoConvertEvents,
    queueFullTurns, longestNoDrainStreak, log: state.log, finalTray: state.tray,
    finalQueueLen: state.shardQueue.length,
  };
}

const N = parseInt(process.argv[2] || '300', 10);
const results = [];
for (let i = 0; i < N; i++) {
  results.push(playGame(1000 + i));
}

function summarize(key) {
  const vals = results.map(r => r[key]);
  const sum = vals.reduce((a,b)=>a+b,0);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  return { avg: (sum/vals.length).toFixed(2), max, min };
}

console.log(`=== ${N} simulated games ===`);
console.log('turns:', summarize('turns'));
console.log('score:', summarize('score'));
console.log('maxTraySeen (base=3):', summarize('maxTraySeen'));
console.log('turnsWithInflatedTray (tray.length>3):', summarize('turnsWithInflatedTray'));
console.log('overflowEvents per game:', summarize('overflowEvents'));
console.log('autoConvertEvents per game (should be ~0 per doc math):', summarize('autoConvertEvents'));
console.log('queueFullTurns per game:', summarize('queueFullTurns'));
console.log('longestNoDrainStreak (turns between full-tray-empty refills):', summarize('longestNoDrainStreak'));

// distribution of maxTraySeen
const dist = {};
for (const r of results) dist[r.maxTraySeen] = (dist[r.maxTraySeen]||0)+1;
console.log('\nmaxTraySeen distribution:', dist);

// games that ended via death vs maxTurns cap
const died = results.filter(r => r.gameOver).length;
console.log(`\ngames that hit GAME OVER: ${died}/${N}`);

// Find the game with the largest tray inflation for detailed inspection
const worst = results.reduce((a,b) => a.maxTraySeen > b.maxTraySeen ? a : b);
console.log(`\n--- Worst tray-inflation game: seed=${worst.seed}, maxTraySeen=${worst.maxTraySeen}, turns=${worst.turns} ---`);

// Find a mid-length game to inspect log for tension/punishment qualitative read
const midGame = results.find(r => r.turns > 50 && r.gameOver) || results[0];
console.log(`\n--- Sample game for qualitative log read: seed=${midGame.seed}, turns=${midGame.turns}, score=${midGame.score} ---`);

import fs from 'node:fs';
fs.writeFileSync('/private/tmp/claude-501/-Users-chamie/600e5cbc-781a-4e75-b516-9bfdfbad228f/scratchpad/worst_tray_log.txt', worst.log.join('\n'));
fs.writeFileSync('/private/tmp/claude-501/-Users-chamie/600e5cbc-781a-4e75-b516-9bfdfbad228f/scratchpad/sample_game_log.txt', midGame.log.join('\n'));
fs.writeFileSync('/private/tmp/claude-501/-Users-chamie/600e5cbc-781a-4e75-b516-9bfdfbad228f/scratchpad/all_results.json', JSON.stringify(results.map(r => ({seed:r.seed, turns:r.turns, score:r.score, gameOver:r.gameOver, maxTraySeen:r.maxTraySeen, turnsWithInflatedTray:r.turnsWithInflatedTray, overflowEvents:r.overflowEvents, autoConvertEvents:r.autoConvertEvents, queueFullTurns:r.queueFullTurns, longestNoDrainStreak:r.longestNoDrainStreak})), null, 2));
console.log('\nWrote worst_tray_log.txt, sample_game_log.txt, all_results.json to scratchpad.');
