// Cube Blast — block texture map path, shared constant (mirrors the pattern
// established by spriteAtlasConfig.js for the shard atlas). The actual tile
// geometry (per-family atlas x/y/w/h, hex fallback colors, tile size) lives
// in the JSON itself (assets/blocks/block-map.json), produced by the
// asset-prep workstream — not duplicated here, so the two can't drift.
export const BLOCK_MAP_PATH = './assets/blocks/block-map.json';
