// Fracture — Style C shard-sprite atlas layout constants.
// Single source of truth shared by the offline bake tool
// (tools/sprite-bake/bake.html + bake.mjs) and the runtime renderer
// (src/main.js), so the two can never drift out of sync on tile geometry.
//
// Layout: one atlas PNG, grid of (COLORS.length columns) x (ATLAS_VARIANTS
// rows). Each cell is a single "shard chip" sprite (the same per-cell unit
// drawPieceGrid already composes multi-cell shard shapes out of — a mono
// shard is 1 chip, a domino shard is 2 chips placed side by side with a
// gap). Column = which of the 7 colorblind-audited palette colors
// (src/pieces.js COLORS) is baked in; row = which of ATLAS_VARIANTS
// pre-baked silhouette/shading variants, so adjacent shard cells in the same
// game piece don't all render as visually-identical stamped copies.

export const ATLAS_TILE = 160; // px, master/bake resolution per chip tile.
// Sized for the largest real on-screen chip in this codebase (~37.5 CSS px,
// from the 48px cellSize board/drag case) at up to 3x devicePixelRatio
// (~112 physical px) with ~1.4x headroom, so no real device upscales a
// sprite past its native resolution. Kept as small as that headroom allows
// (not e.g. 256+) because atlas file size is a real mobile-bundle-size cost
// here (see docs/art-direction.md Style C entry).
export const ATLAS_VARIANTS = 6;
// 6, not more: the max shard cells ever visible simultaneously in this UI
// is small (3 queue slots x up to 2 cells + a handful of tray slots + one
// dragged piece), so 6 pre-baked variants is already comfortably above the
// point of visible repetition -- more would just inflate atlas size for no
// perceptible variety gain (mobile-bundle-size constraint, see
// docs/art-direction.md Style C entry).
export const ATLAS_PATH = './assets/sprites/shard-atlas.png';
