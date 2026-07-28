import { createGame, placePiece, canPlaceAt, QUEUE_CAP } from '../../src/core.js';
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
  return moves.reduce((best, m) => { const score = m.lines>=2 ? m.lines*1000+m.adj : m.adj; if (!best||score>best.score) return {...m, score}; return best; }, null);
}

const state = createGame(9017);
let turn = 0;
while (!state.gameOver && turn < 220) {
  const move = botComboHoarder(state);
  if (!move) break;
  const before = state.log.length;
  placePiece(state, move.slot, move.r, move.c);
  turn++;
  if (turn >= 200) {
    const newLines = state.log.slice(before);
    console.log(`turn ${turn}: tray=${state.tray.map(t=>t?(t.isShard?'S:'+t.shapeId:t.shapeId):'-').join(',')} | queue=${state.shardQueue.length}/${QUEUE_CAP} | score=${state.score}`);
    for (const l of newLines) console.log('    ' + l);
  }
}
