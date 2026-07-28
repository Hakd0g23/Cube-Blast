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
// Adversarial: deliberately prefer NON-scripted slots that clear a line, to
// maximize the sibling-clears-first pathway the bug depended on.
function adversarialMove(state, rng) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  const scriptedSlot = state.tray.findIndex(p => p && p.isScriptedCombo);
  const nonScriptedClears = moves.filter(m => m.slot !== scriptedSlot && m.lines > 0);
  if (nonScriptedClears.length) return nonScriptedClears[Math.floor(rng() * nonScriptedClears.length)];
  const anyClear = moves.filter(m => m.lines > 0);
  if (anyClear.length) return anyClear[Math.floor(rng() * anyClear.length)];
  return moves[Math.floor(rng() * moves.length)];
}
function mulberry32(a) { return function() { a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

let maxTray = 0, games = 0, growthSeeds = [];
for (let seed = 1; seed <= 5000; seed++) {
  const rng = mulberry32(seed * 999331);
  const state = createGame(seed, { firstExposureComplete: false, firstShardCalloutShown: false });
  games++;
  let turn = 0;
  while (!state.gameOver && turn < 400) {
    const move = adversarialMove(state, rng);
    if (!move) break;
    placePiece(state, move.slot, move.r, move.c);
    turn++;
    if (state.tray.length > maxTray) { maxTray = state.tray.length; }
    if (state.tray.length > 3) growthSeeds.push(seed);
  }
}
console.log(JSON.stringify({ games, maxTraySeen: maxTray, growthEventCount: growthSeeds.length, growthSeeds: [...new Set(growthSeeds)].slice(0,10) }, null, 2));
