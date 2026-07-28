// sim8: verifies whether the proposed onboarding script (suppress queue-drain
// + guarantee an early 3-4 line combo within the first 5-8 clears, to force a
// teaching shard-overflow) can trigger the tray-growth edge case documented
// in playtest-findings.md item 2.
//
// This does NOT re-run the adversarial-bot search from sim5/sim6/sim7 (that
// already answered the *unscripted* play question). It directly scripts the
// exact sequence a tutorial would author: controlled piece dealing (to
// suppress drains and build the queue) + a hand-placed guaranteed combo piece
// (to simulate "script a guaranteed 3-4 line combo"), using the same
// createGame/placePiece API as real play. Board/tray state is mutated
// directly only to stand in for "the tutorial deals you this piece / sets up
// this board" -- every clear/shard/overflow resolution still goes through the
// real engine (placePiece -> resolveGeneratedShard -> insertShard); nothing
// about the shard/overflow logic itself is bypassed or reimplemented.

import { createGame, placePiece, QUEUE_CAP, TRAY_BASE_SIZE } from '../../src/core.js';
import { BOARD_SIZE } from '../../src/pieces.js';

function dumpTray(state) {
  return state.tray.map((t, i) => t ? `${i}:${t.isShard ? 'SHARD:' + t.shapeId : t.shapeId}` : `${i}:-`).join(' | ');
}
function fillRow(board, row, skipCol) {
  for (let c = 0; c < BOARD_SIZE; c++) if (c !== skipCol) board[row][c] = { color: '#x' };
}
function buildupToQueueLen(state, targetLen) {
  // "Suppress a drain opportunity": deal a mono into slot 0 each turn and
  // always complete the same single row -> 1-line clear -> 1 shard/turn.
  // Slots 1/2 are never touched, so the tray never goes fully empty and the
  // natural "drain queue into tray on full-empty refill" path never fires.
  for (let i = 0; i < targetLen; i++) {
    fillRow(state.board, 4, 0);
    state.tray[0] = { shape: [[0, 0]], shapeId: 'mono', color: '#e74c3c', isShard: false };
    placePiece(state, 0, 4, 0);
  }
}
function runCombo(state, comboLines, label) {
  // comboLines=3 -> tromino_v clearing rows 0-2 (2 shards, per shardCountForClear)
  // comboLines=4 -> tetromino_v clearing rows 0-3 (3 shards, capped)
  const cells = Array.from({ length: comboLines }, (_, i) => [i, 0]);
  for (let r = 0; r < comboLines; r++) fillRow(state.board, r, 0);
  state.tray[0] = { shape: cells, shapeId: `combo${comboLines}`, color: '#3498db', isShard: false };
  const before = state.log.length;
  placePiece(state, 0, 0, 0);
  const grew = state.tray.length > TRAY_BASE_SIZE;
  console.log(`  [${label}] queue=${state.shardQueue.length}/${QUEUE_CAP} -> tray.length=${state.tray.length} grew=${grew}`);
  for (const l of state.log.slice(before)) console.log('      ' + l);
  return grew;
}

console.log('=== Matrix: comboLines x queueLenAtComboStart x freeTraySlotsAtComboStart ===');
const results = [];
for (const comboLines of [3, 4]) {
  for (const freeSlots of [1, 2]) {
    for (let q = 0; q <= QUEUE_CAP; q++) {
      const state = createGame(1);
      buildupToQueueLen(state, q);
      if (freeSlots === 2) state.tray[1] = null; // simulate: player already played their 2nd dealt piece this round too
      const label = `comboLines=${comboLines} freeSlots=${freeSlots} queueAtStart=${q}`;
      const grew = runCombo(state, comboLines, label);
      results.push({ comboLines, freeSlots, q, grew });
    }
  }
}

console.log('\n=== SUMMARY (grew=true rows only) ===');
for (const r of results) if (r.grew) console.log(`comboLines=${r.comboLines} freeSlots=${r.freeSlots} queueAtComboStart=${r.q}/${QUEUE_CAP} -> TRAY GREW`);

console.log('\n=== Formula check: shardsToOverflow = max(0, shardCount - (QUEUE_CAP - queueLen)); grew iff shardsToOverflow > freeSlots ===');
function shardCountForClear(lineCount) { if (lineCount<=0) return 0; if (lineCount===1) return 1; if (lineCount<=3) return 2; return 3; }
let mismatches = 0;
for (const r of results) {
  const shardCount = shardCountForClear(r.comboLines);
  const overflow = Math.max(0, shardCount - (QUEUE_CAP - r.q));
  const predicted = overflow > r.freeSlots;
  if (predicted !== r.grew) { mismatches++; console.log(`MISMATCH: ${JSON.stringify(r)} predicted=${predicted}`); }
}
console.log(mismatches === 0 ? 'Formula matches all observed results exactly.' : `${mismatches} mismatches found.`);
