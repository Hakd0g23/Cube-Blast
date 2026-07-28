import { createGame, placePiece, QUEUE_CAP, TRAY_BASE_SIZE } from '../../src/core.js';
import { BOARD_SIZE } from '../../src/pieces.js';

function freshState(seed) {
  const s = createGame(seed);
  s.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  return s;
}

console.log('--- Scenario 1: queue already full (4/4), trigger a 2-line combo ---');
{
  const s = freshState(1);
  for (let i = 0; i < QUEUE_CAP; i++) s.shardQueue.push({ shape: [[0,0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });
  // set up a 2-line combo: fill row0 minus col0, fill col0 minus row0, place an L at (0,0)
  for (let c = 1; c < BOARD_SIZE; c++) s.board[0][c] = { color: '#000' };
  for (let r = 1; r < BOARD_SIZE; r++) s.board[r][0] = { color: '#000' };
  s.tray[0] = { shape: [[0,0]], shapeId: 'mono', color: '#fff', isShard: false };
  s.tray[1] = { shape: [[0,0],[0,1]], shapeId: 'domino_h', color: '#eee', isShard: false };
  s.tray[2] = { shape: [[0,0],[0,1]], shapeId: 'domino_h', color: '#ddd', isShard: false };
  const before = s.log.length;
  placePiece(s, 0, 0, 0);
  console.log('tray.length after:', s.tray.length, 'queue.length:', s.shardQueue.length);
  console.log(s.log.slice(before).join('\n'));
  console.log('tray contents:', s.tray.map(t => t ? (t.isShard ? 'SHARD:'+t.shapeId : t.shapeId) : 'null'));
}

console.log('\n--- Scenario 2: queue already full, trigger a 4-line combo (3 shards) ---');
{
  const s = freshState(2);
  for (let i = 0; i < QUEUE_CAP; i++) s.shardQueue.push({ shape: [[0,0]], shapeId: 'shard_mono', color: '#aaa', isShard: true });
  for (let r = 0; r < 4; r++) for (let c = 0; c < BOARD_SIZE; c++) if (c !== 3) s.board[r][c] = { color: '#000' };
  s.tray[0] = { shape: [[0,0],[1,0],[2,0],[3,0]], shapeId: 'tetromino_v', color: '#fff', isShard: false };
  s.tray[1] = { shape: [[0,0],[0,1]], shapeId: 'domino_h', color: '#eee', isShard: false };
  s.tray[2] = { shape: [[0,0],[0,1]], shapeId: 'domino_h', color: '#ddd', isShard: false };
  const before = s.log.length;
  placePiece(s, 0, 0, 3);
  console.log('tray.length after:', s.tray.length, 'queue.length:', s.shardQueue.length);
  console.log(s.log.slice(before).join('\n'));
  console.log('tray contents:', s.tray.map(t => t ? (t.isShard ? 'SHARD:'+t.shapeId : t.shapeId) : 'null'));

  console.log('\n  ...now what happens on the NEXT few turns as the inflated tray drains?');
  // Place remaining pieces one by one on empty board areas to walk toward a refill.
  for (let i = 0; i < 5 && !s.gameOver; i++) {
    const idx = s.tray.findIndex(t => t != null);
    if (idx === -1) break;
    const piece = s.tray[idx];
    // find any placeable spot
    let placed = false;
    for (let r = 0; r < BOARD_SIZE && !placed; r++) for (let c = 0; c < BOARD_SIZE && !placed; c++) {
      const before2 = s.log.length;
      const res = placePiece(s, idx, r, c);
      if (res.ok) { placed = true; console.log(`  turn: placed slot ${idx} (${piece.shapeId}) at (${r},${c}) -> tray.length=${s.tray.length}`, s.log.slice(before2).join(' | ')); }
    }
  }
}
