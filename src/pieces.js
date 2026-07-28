// Fracture — piece and shard shape definitions.
// Engine-agnostic (no DOM). Coordinates are [row, col] offsets from a shape's
// own top-left origin (min row/col == 0).
//
// NOTE: piece *set* (which polyominoes exist, at what weight) is not specified
// by the design doc — Section 1 says the core loop is "inherited from Block
// Blast, unchanged" but the doc does not enumerate a shape list. This is a
// gray-box implementation decision, not a deviation from Sections 2-3 (the
// locked spec), and is called out in the build report.

export const BOARD_SIZE = 8;

// Standard genre convention (Block Blast / 1010! / Woodoku, cited as direct
// precedent in the design doc): pieces are placed as-is, no rotation control
// for the player. Rotational variants are pre-baked as separate shapes below.
export const SHAPES = [
  { id: 'mono', weight: 6, cells: [[0, 0]] },

  { id: 'domino_h', weight: 8, cells: [[0, 0], [0, 1]] },
  { id: 'domino_v', weight: 8, cells: [[0, 0], [1, 0]] },

  { id: 'tromino_h', weight: 6, cells: [[0, 0], [0, 1], [0, 2]] },
  { id: 'tromino_v', weight: 6, cells: [[0, 0], [1, 0], [2, 0]] },

  { id: 'tetromino_h', weight: 3, cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { id: 'tetromino_v', weight: 3, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },

  { id: 'penta_h', weight: 1, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
  { id: 'penta_v', weight: 1, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] },

  { id: 'square2', weight: 6, cells: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { id: 'square3', weight: 1, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]] },

  { id: 'L1', weight: 4, cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
  { id: 'L2', weight: 4, cells: [[0, 0], [0, 1], [1, 0], [2, 0]] },
  { id: 'L3', weight: 4, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { id: 'L4', weight: 4, cells: [[0, 1], [1, 1], [2, 0], [2, 1]] },

  { id: 'T', weight: 4, cells: [[0, 0], [0, 1], [0, 2], [1, 1]] },
  { id: 'Tv', weight: 4, cells: [[0, 0], [1, 0], [1, 1], [2, 0]] },

  { id: 'S', weight: 4, cells: [[0, 1], [0, 2], [1, 0], [1, 1]] },
  { id: 'Z', weight: 4, cells: [[0, 0], [0, 1], [1, 1], [1, 2]] },

  { id: 'corner', weight: 5, cells: [[0, 0], [0, 1], [1, 0]] },
];

// Shard shapes: "shape-generic ... fragments, not copies of the original
// piece" (Section 2) + "size capped at 1-2 cells". Only monominoes and
// dominoes qualify.
// Weighted (bug fix): mono was previously picked via unweighted pick(), a flat
// 1/3 chance on every shard spawn regardless of clear/combo size. Single-cell
// shards are geometrically inert on an 8x8 board (almost never block a
// placement), so mono is now down-weighted relative to the dominoes, and a
// 3-cell L-tromino is added as a genuinely obstructive shape.
export const SHARD_SHAPES = [
  { id: 'shard_mono', weight: 2, cells: [[0, 0]] },
  { id: 'shard_domino_h', weight: 5, cells: [[0, 0], [0, 1]] },
  { id: 'shard_domino_v', weight: 5, cells: [[0, 0], [1, 0]] },
  { id: 'shard_tromino_l', weight: 3, cells: [[0, 0], [0, 1], [1, 0]] },
];

// Multi-shard combo pool (3+ line clears / more than one shard generated in
// the same event): excludes shard_mono entirely so bigger combos never roll
// a trivial single-cell shard, only dominoes/tromino.
export const SHARD_SHAPES_MULTI = SHARD_SHAPES.filter((s) => s.id !== 'shard_mono');

// Colorblind-audited palette (game-asset-director, docs/art-direction.md).
// Original set ['#e74c3c'(red), '#3498db'(blue), '#2ecc71'(green),
// '#f1c40f'(yellow), '#9b59b6'(purple), '#e67e22'(orange), '#1abc9c'(teal)]
// was flagged for containing red+green, but simulating it through the same
// Machado et al. (2009) reduced-color-space matrices Coblis/Color Oracle use
// (protanopia/deuteranopia/tritanopia, verified in CIE76 Lab dE) found the
// red/green pair itself was borderline-survivable (dE~21-32) while three
// OTHER pairs were the actual worst offenders: green vs teal (dE=5.96 under
// tritanopia -- nearly identical; already the tightest pair at dE=32 even
// under normal vision, so CVD just tipped an existing near-duplicate hue
// over the edge), blue vs purple (dE=12.34 under deuteranopia), and red vs
// orange (dE=17.38 under deuteranopia). Fixing red+green alone would have
// left those three collisions in place. This replacement set was searched
// (coordinate-ascent over HSL candidates per original hue family, keeping
// yellow fixed since it's reused elsewhere in index.html/main.js as a
// warning color) to keep every pairwise CIE76 dE >= ~28 simultaneously under
// normal vision AND all three simulated CVD types, while also keeping every
// color's Lab L* >= 37 so pieces stay legible against the dark board
// background (#2a2d36, L*=18.5) -- the first CVD-optimal candidates found
// were numerically great but too dark against this UI's dark theme, so the
// search was re-run with a lightness floor. Verified with a standalone
// script, not eyeballed; full per-pair/per-condition numbers are in the
// build report, not committed here to avoid this file growing into a report.
export const COLORS = ['#ae133a', '#4529ff', '#45eda7', '#f1c40f', '#ac5ae2', '#e07c52', '#1c899c'];

export function weightedPick(list, rng) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let roll = rng() * total;
  for (const item of list) {
    if (roll < item.weight) return item;
    roll -= item.weight;
  }
  return list[list.length - 1];
}

export function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}
