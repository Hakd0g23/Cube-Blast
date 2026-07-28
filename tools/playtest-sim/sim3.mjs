import { createGame, placePiece, canPlaceAt, QUEUE_CAP, TRAY_BASE_SIZE } from '../../src/core.js';
import { BOARD_SIZE } from '../../src/pieces.js';

function cloneBoard(b) { return b.map(row => row.slice()); }
function evalLinesForBoard(board) {
  let rows = 0, cols = 0;
  for (let r = 0; r < BOARD_SIZE; r++) if (board[r].every(c => c != null)) rows++;
  for (let c = 0; c < BOARD_SIZE; c++) { let full = true; for (let r=0;r<BOARD_SIZE;r++) if (board[r][c]==null){full=false;break;} if (full) cols++; }
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
    for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) {
      if (!canPlaceAt(state.board, piece.shape, r, c)) continue;
      const b = cloneBoard(state.board);
      for (const [dr, dc] of piece.shape) b[r+dr][c+dc] = { color:'#x' };
      moves.push({ slot, r, c, lines: evalLinesForBoard(b), adj: adjacencyScore(state.board, piece.shape, r, c) });
    }
  }
  return moves;
}
function botComboHoarder(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => {
    const score = m.lines >= 2 ? m.lines*1000 + m.adj : m.adj;
    if (!best || score > best.score) return { ...m, score };
    return best;
  }, null);
}

function playGame(seed, maxTurns) {
  const state = createGame(seed);
  let turn = 0;
  const overflowTurns = [];
  while (!state.gameOver && turn < maxTurns) {
    const move = botComboHoarder(state);
    if (!move) break;
    const before = state.log.length;
    const preTray = state.tray.length, preQueue = state.shardQueue.length;
    placePiece(state, move.slot, move.r, move.c);
    turn++;
    const newLines = state.log.slice(before);
    if (newLines.some(l => l.startsWith('OVERFLOW'))) {
      overflowTurns.push({ turn, preTray, preQueue, postTray: state.tray.length, postQueue: state.shardQueue.length, lines: newLines });
    }
  }
  return { seed, turns: turn, overflowTurns, gameOver: state.gameOver };
}

let totalOverflow = 0;
let gamesWithOverflow = 0;
const N = 500;
for (let i = 0; i < N; i++) {
  const r = playGame(9000 + i, 3000);
  if (r.overflowTurns.length > 0) {
    gamesWithOverflow++;
    totalOverflow += r.overflowTurns.length;
    if (gamesWithOverflow <= 5) {
      console.log(`\nseed=${r.seed} turns=${r.turns} overflow count=${r.overflowTurns.length}`);
      for (const o of r.overflowTurns) console.log(JSON.stringify(o, null, 1));
    }
  }
}
console.log(`\n\n${gamesWithOverflow}/${N} combo-hoarder games had >=1 overflow event. total overflow events: ${totalOverflow}`);
