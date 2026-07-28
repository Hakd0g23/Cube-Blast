import { createGame, placePiece, canPlaceAt, QUEUE_CAP, TRAY_BASE_SIZE, findAnyPlacement } from '../../src/core.js';
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
function botGreedyClear(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => { const score = m.lines*1000+m.adj; if (!best||score>best.score) return {...m, score}; return best; }, null);
}
function botComboHoarder(state) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  return moves.reduce((best, m) => { const score = m.lines>=2 ? m.lines*1000+m.adj : m.adj; if (!best||score>best.score) return {...m, score}; return best; }, null);
}

function playGame(botFn, seed, maxTurns) {
  const state = createGame(seed);
  let turn = 0;
  while (!state.gameOver && turn < maxTurns) {
    const move = botFn(state);
    if (!move) break;
    placePiece(state, move.slot, move.r, move.c);
    turn++;
  }
  return state;
}

function analyzeFinalTray(bots, N, maxTurns) {
  for (const [name, fn] of bots) {
    let deaths = 0, shardCulprits = 0, regularCulprits = 0, totalCulpritSlots = 0;
    let deathsWithAnyShardInTray = 0, deathsWithNoShardInTray = 0;
    for (let i = 0; i < N; i++) {
      const state = playGame(fn, 30000 + i, maxTurns);
      if (!state.gameOver) continue;
      deaths++;
      let hasShard = false;
      for (const slot of state.tray) {
        if (!slot) continue;
        totalCulpritSlots++;
        if (slot.isShard) { shardCulprits++; hasShard = true; } else regularCulprits++;
      }
      if (hasShard) deathsWithAnyShardInTray++; else deathsWithNoShardInTray++;
    }
    console.log(`\n${name}: ${deaths}/${N} games ended in game-over.`);
    console.log(`  final-tray slot composition at death: ${shardCulprits} shard slots, ${regularCulprits} regular slots (of ${totalCulpritSlots} total stuck pieces)`);
    console.log(`  deaths where a shard was sitting in the final stuck tray: ${deathsWithAnyShardInTray}/${deaths}`);
    console.log(`  deaths with NO shard involved at all (pure regular-piece jam): ${deathsWithNoShardInTray}/${deaths}`);
  }
}

analyzeFinalTray([['greedy-clearer', botGreedyClear], ['combo-hoarder', botComboHoarder]], 400, 3000);
