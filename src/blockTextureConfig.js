// Cube Blast — block texture map path, shared constant (mirrors the pattern
// established by spriteAtlasConfig.js for the shard atlas). The actual tile
// geometry (per-family atlas x/y/w/h, hex fallback colors, tile size) lives
// in the JSON itself (assets/blocks/block-map.json), produced by the
// asset-prep workstream — not duplicated here, so the two can't drift.
export const BLOCK_MAP_PATH = './assets/blocks/block-map.json';

// Color->family mapping (GDD section 8), the single source of truth for
// which baked block-texture family a given piece/cell color renders as.
// Originally defined inline in src/main.js (render-swap workstream); pulled
// out here (gameplay-state-wiring, 2026-07-28) so the Three.js scene
// (src/threeScene.js) can reuse the exact same mapping instead of
// reinventing/duplicating it. src/main.js now imports this instead of
// defining its own copy -- see its own comment for the per-color rationale
// (7 palette colors -> 7 of 8 baked families; dirt_brown intentionally
// unused).
export const FAMILY_BY_COLOR = {
  '#ae133a': 'brick_red',
  '#4529ff': 'stone_gray',
  '#45eda7': 'grass_green',
  '#f1c40f': 'gold_yellow',
  '#ac5ae2': 'amethyst_purple',
  '#e07c52': 'planks_tan',
  '#1c899c': 'diamond_cyan',
};
