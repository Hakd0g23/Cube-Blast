import { createGame, placePiece, canPlaceAt } from '../../src/core.js';
import { BOARD_SIZE } from '../../src/pieces.js';

// Careless player: plays tray slots in order 0,1,2, takes the FIRST legal
// placement it finds (scan r,c in order) -- never searches for the
// combo-completing spot. This matches the profile the 41-44% miss-rate
// finding (and the hint proposal) is actually about.
function carelessMove(state) {
  for (let slot = 0; slot < state.tray.length; slot++) {
    const piece = state.tray[slot];
    if (!piece) continue;
    for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) {
      if (canPlaceAt(state.board, piece.shape, r, c)) return { slot, r, c };
    }
  }
  return null;
}

let games = 0, everArmed = 0, scriptedComboLanded = 0, overflowedViaFallbackOnly = 0, neverOverflowed = 0;
let armAttemptsList = [];
for (let seed = 1; seed <= 500; seed++) {
  const state = createGame(seed, { firstExposureComplete: false, firstShardCalloutShown: false });
  games++;
  let turn = 0;
  let armAttempts = 0;
  let scriptedLanded = false;
  let anyOverflow = false;
  while (!state.gameOver && turn < 500) {
    const scriptedSlot = state.tray.findIndex(p => p && p.isScriptedCombo);
    const move = carelessMove(state);
    if (!move) break;
    const isScriptedMove = scriptedSlot !== -1 && move.slot === scriptedSlot;
    const before = state.log.length;
    const res = placePiece(state, move.slot, move.r, move.c);
    turn++;
    const newLogs = state.log.slice(before);
    for (const l of newLogs) {
      if (/armed scripted/.test(l)) armAttempts++;
      if (/OVERFLOW/.test(l)) anyOverflow = true;
    }
    if (isScriptedMove) {
      const clearedThisTurn = newLogs.some(l => /^Cleared/.test(l));
      if (clearedThisTurn && newLogs.some(l => /OVERFLOW/.test(l))) scriptedLanded = true;
    }
  }
  armAttemptsList.push(armAttempts);
  if (armAttempts > 0) everArmed++;
  if (scriptedLanded) scriptedComboLanded++;
  else if (anyOverflow) overflowedViaFallbackOnly++;
  else neverOverflowed++;
}
const avgAttempts = armAttemptsList.reduce((a,b)=>a+b,0) / games;
const maxAttempts = Math.max(...armAttemptsList);
console.log(JSON.stringify({
  games, everArmed,
  scriptedComboLandedCount: scriptedComboLanded,
  scriptedComboLandedPctOfEverArmed: everArmed ? (scriptedComboLanded / everArmed * 100).toFixed(1) : 'n/a',
  overflowedViaFallbackOnly, neverOverflowed,
  avgArmAttemptsPerGame: avgAttempts.toFixed(2), maxArmAttemptsSeen: maxAttempts,
}, null, 2));
