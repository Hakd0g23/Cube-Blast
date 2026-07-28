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
// Extreme hoarder: NEVER take a 1-line clear if literally any non-clearing move
// exists anywhere in the tray; only take 1-line clears when forced (no other move).
function botExtremeHoarder(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  const multi = moves.filter(m => m.lines >= 2);
  if (multi.length) return multi.reduce((b,m)=> !b || (m.lines*1000+m.adj)>(b.lines*1000+b.adj) ? m : b);
  const nonClear = moves.filter(m => m.lines === 0);
  if (nonClear.length) return nonClear.reduce((b,m)=> !b || m.adj > b.adj ? m : b);
  // forced: only 1-line-clear moves available
  return moves.reduce((b,m)=> !b || m.adj > b.adj ? m : b);
}

function playGame(seed, maxTurns) {
  const state = createGame(seed);
  let turn = 0;
  let maxTray = TRAY_BASE_SIZE, maxQueueFull = 0, overflowCount = 0, doubleOverflowTurns = 0;
  while (!state.gameOver && turn < maxTurns) {
    const move = botExtremeHoarder(state);
    if (!move) break;
    const before = state.log.length;
    placePiece(state, move.slot, move.r, move.c);
    turn++;
    const newLines = state.log.slice(before);
    const overflowsThisTurn = newLines.filter(l => l.startsWith('OVERFLOW')).length;
    overflowCount += overflowsThisTurn;
    if (overflowsThisTurn >= 2) doubleOverflowTurns++;
    if (state.tray.length > maxTray) maxTray = state.tray.length;
    if (state.shardQueue.length >= QUEUE_CAP) maxQueueFull++;
  }
  return { seed, turns: turn, maxTray, overflowCount, doubleOverflowTurns, gameOver: state.gameOver };
}

const N = parseInt(process.argv[2] || '2000', 10);
let maxTrayEver = 3, gamesWithOverflow = 0, gamesWithDouble = 0, totalOverflow = 0;
const trayDist = {};
for (let i = 0; i < N; i++) {
  const r = playGame(20000 + i, 3000);
  trayDist[r.maxTray] = (trayDist[r.maxTray]||0) + 1;
  if (r.maxTray > maxTrayEver) maxTrayEver = r.maxTray;
  if (r.overflowCount > 0) gamesWithOverflow++;
  if (r.doubleOverflowTurns > 0) { gamesWithDouble++; console.log('DOUBLE OVERFLOW FOUND:', r); }
  totalOverflow += r.overflowCount;
}
console.log(`\nExtreme hoarder bot, ${N} games:`);
console.log('max tray size ever observed:', maxTrayEver);
console.log('tray-size distribution:', trayDist);
console.log(`games with >=1 overflow: ${gamesWithOverflow}/${N}, total overflow events: ${totalOverflow}`);
console.log(`games with a same-turn double-overflow (the actual tray-inflation trigger): ${gamesWithDouble}/${N}`);
