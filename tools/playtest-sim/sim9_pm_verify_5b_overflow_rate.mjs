import { createGame, placePiece, canPlaceAt } from '../../src/core.js';
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
function hoarderMove(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => {
    const score = m.lines >= 2 ? m.lines * 1000 : -m.lines;
    if (!best || score > best.score) return { ...m, score };
    return best;
  }, null);
}

let armedCount = 0, armedLineCounts = {}, armedFollowedByOverflow = 0, armedFollowedByFullNoOverflow = 0;
let games = 0, firstOverflowSeen = 0;
for (let seed = 1; seed <= 300; seed++) {
  const state = createGame(seed, { firstExposureComplete: false, firstShardCalloutShown: false });
  games++;
  let turn = 0;
  let pendingArm = null;
  while (!state.gameOver && turn < 500) {
    const move = hoarderMove(state);
    if (!move) break;
    const before = state.log.length;
    placePiece(state, move.slot, move.r, move.c);
    turn++;
    const newLogs = state.log.slice(before);
    for (const l of newLogs) {
      const armMatch = l.match(/armed scripted (\d+)-line combo.*queue will be (\d+)\/(\d+)/);
      if (armMatch) {
        armedCount++;
        const lc = armMatch[1];
        armedLineCounts[lc] = (armedLineCounts[lc]||0)+1;
      }
    }
    if (state.pendingCallouts?.length) {
      for (const co of state.pendingCallouts) if (co.type === 'first-overflow') firstOverflowSeen++;
      state.pendingCallouts.length = 0;
    }
  }
}
console.log(JSON.stringify({ games, armedCount, armedLineCounts, firstOverflowSeen }, null, 2));
