import {
  createGame, placePiece, canPlaceAt, QUEUE_CAP, TRAY_BASE_SIZE,
} from '../../src/core.js';
import { BOARD_SIZE } from '../../src/pieces.js';
import fs from 'node:fs';

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

// Bot A: greedy-clearer (always maximize lines, tiebreak adjacency) — "optimal" player
function botGreedyClear(state, rng) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => {
    const score = m.lines * 1000 + m.adj;
    if (!best || score > best.score) return { ...m, score };
    return best;
  }, null);
}

// Bot B: combo-hoarder — avoids single-line clears in favor of building, takes 2+ combos eagerly
function botComboHoarder(state, rng) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => {
    const score = m.lines >= 2 ? m.lines * 1000 + m.adj : m.adj;
    if (!best || score > best.score) return { ...m, score };
    return best;
  }, null);
}

// Bot C: naive/careless — picks first legal placement it finds for tray slot 0
// (falls to next slot if slot0 unplaceable), no clear-seeking, no compactness.
// Simulates an average/inattentive casual player.
function botNaive(state, rng) {
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

// Bot D: random legal — picks a uniformly random legal move among ALL slot/pos options.
function botRandom(state, rng) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves[Math.floor(rng() * moves.length)];
}

function playGame(botFn, seed, maxTurns) {
  const state = createGame(seed);
  let rngLocal = (function(a){a=a>>>0;return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};})(seed ^ 0x9e3779b9);
  let turnsWithInflatedTray = 0, maxTraySeen = TRAY_BASE_SIZE, overflowEvents = 0, autoConvertEvents = 0, queueFullTurns = 0;
  let turn = 0, lastFullDrainTurn = 0, longestNoDrainStreak = 0;
  let inflatedTraySamples = [];
  while (!state.gameOver && turn < maxTurns) {
    const move = botFn(state, rngLocal);
    if (!move) break;
    const before = state.log.length;
    placePiece(state, move.slot, move.r, move.c);
    turn++;
    const newLines = state.log.slice(before);
    for (const l of newLines) {
      if (l.startsWith('OVERFLOW')) overflowEvents++;
      if (l.includes('auto-converted to score')) autoConvertEvents++;
    }
    if (state.tray.length > TRAY_BASE_SIZE) {
      turnsWithInflatedTray++;
      if (inflatedTraySamples.length < 3) inflatedTraySamples.push({turn, traySize: state.tray.length, queueLen: state.shardQueue.length, log: newLines});
    }
    if (state.tray.length > maxTraySeen) maxTraySeen = state.tray.length;
    if (state.shardQueue.length >= QUEUE_CAP) queueFullTurns++;
    const drained = newLines.some(l => l.includes('Tray refill slot 0'));
    if (drained) {
      const streak = turn - lastFullDrainTurn;
      if (streak > longestNoDrainStreak) longestNoDrainStreak = streak;
      lastFullDrainTurn = turn;
    }
  }
  const finalStreak = turn - lastFullDrainTurn;
  if (finalStreak > longestNoDrainStreak) longestNoDrainStreak = finalStreak;
  return { seed, turns: turn, score: state.score, gameOver: state.gameOver, maxTraySeen, turnsWithInflatedTray, overflowEvents, autoConvertEvents, queueFullTurns, longestNoDrainStreak, log: state.log, inflatedTraySamples };
}

function runSuite(name, botFn, N, maxTurns) {
  const results = [];
  for (let i = 0; i < N; i++) results.push(playGame(botFn, 5000 + i, maxTurns));
  const summarize = (key) => {
    const vals = results.map(r => r[key]);
    return { avg: (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2), max: Math.max(...vals), min: Math.min(...vals) };
  };
  console.log(`\n=== Bot: ${name} (${N} games, cap ${maxTurns} turns) ===`);
  console.log('turns:', summarize('turns'));
  console.log('score:', summarize('score'));
  console.log('maxTraySeen:', summarize('maxTraySeen'));
  console.log('turnsWithInflatedTray:', summarize('turnsWithInflatedTray'));
  console.log('overflowEvents/game:', summarize('overflowEvents'));
  console.log('autoConvertEvents/game:', summarize('autoConvertEvents'));
  console.log('queueFullTurns/game:', summarize('queueFullTurns'));
  console.log('longestNoDrainStreak:', summarize('longestNoDrainStreak'));
  const died = results.filter(r => r.gameOver).length;
  console.log(`games hit GAME OVER: ${died}/${N}`);
  const dist = {};
  for (const r of results) dist[r.maxTraySeen] = (dist[r.maxTraySeen]||0)+1;
  console.log('maxTraySeen distribution:', dist);
  return results;
}

const N = parseInt(process.argv[2] || '150', 10);
const CAP = parseInt(process.argv[3] || '3000', 10);

const resA = runSuite('greedy-clearer (optimal)', botGreedyClear, N, CAP);
const resB = runSuite('combo-hoarder', botComboHoarder, N, CAP);
const resC = runSuite('naive/careless', botNaive, N, CAP);
const resD = runSuite('random-legal', botRandom, N, CAP);

// Save interesting logs
function saveWorst(results, label) {
  const worst = results.reduce((a,b) => a.maxTraySeen > b.maxTraySeen ? a : b);
  fs.writeFileSync(`/private/tmp/claude-501/-Users-chamie/600e5cbc-781a-4e75-b516-9bfdfbad228f/scratchpad/worst_${label}.txt`,
    `seed=${worst.seed} maxTraySeen=${worst.maxTraySeen} turns=${worst.turns} overflowEvents=${worst.overflowEvents}\n\n` +
    'INFLATED TRAY SAMPLES:\n' + JSON.stringify(worst.inflatedTraySamples, null, 2) + '\n\nFULL LOG TAIL:\n' + worst.log.join('\n'));
}
saveWorst(resA, 'greedy');
saveWorst(resB, 'hoarder');
saveWorst(resC, 'naive');
saveWorst(resD, 'random');

console.log('\nSaved worst-case logs for each bot to scratchpad.');
