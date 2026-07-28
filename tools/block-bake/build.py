#!/usr/bin/env python3
"""
Cube World block-texture bake tool.

Crops 16x16 source tiles out of assets/cubeworld-source/Blocks_PixelArt.png
(a 5x5 grid, 80x80px total -> 16px tiles), upscales each to the game's
56x56 canvas cell size with nearest-neighbor (keeps pixel-art edges crisp,
no blur), and writes:
  - assets/blocks/block-atlas.png   -- single atlas, 8 cols x 1 row, 56px tiles
  - assets/blocks/<family>.png      -- same tiles as individual files (either
                                        consumption style works for the
                                        render-swap step; block-map.json
                                        documents both)
  - assets/blocks/block-map.json    -- family -> atlas coords + file path

Source note: assets/cubeworld-source/Atlas.png was inspected and rejected
for this job -- it's a flat material-color-swatch sheet for the pack's 3D
model UVs (solid color chips, no pixel-art texture detail), not a tileable
2D texture sheet. Blocks_PixelArt.png is the only one of the two source
sheets suited to per-cell 2D rendering, per GDD sec 8 assumption.

The pack's Blocks_PixelArt.png has no purple/amethyst tile at all, so the
amethyst family is derived procedurally in this script: the diamond-ore
tile's cyan gem pixels are hue-shifted to purple (rock/matrix pixels, which
are low-saturation, are left alone) -- keeps it visually consistent with
the other pixel-art tiles instead of pulling in a mismatched flat color.

Usage: python3 tools/block-bake/build.py
Requires Pillow (PIL). No other project tooling touched.
"""
import json
import colorsys
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "assets/cubeworld-source/Blocks_PixelArt.png"
OUT_DIR = REPO / "assets/blocks"
TILE_SRC = 16   # source tile size in Blocks_PixelArt.png (80x80 / 5x5 grid)
TILE_OUT = 56   # game cell size per GDD sec 3 (56x56px cells)

# family_name -> (col, row) in the 5x5 source grid, 0-indexed, (0,0) top-left
FAMILY_SOURCE_TILES = {
    "dirt_brown":     (2, 0),  # earthy brown grass-block side texture
    "grass_green":    (0, 3),  # solid green grass texture
    "stone_gray":     (2, 1),  # dark cobblestone
    "brick_red":      (3, 2),  # red brick pattern
    "planks_tan":     (1, 2),  # tan/lighter wood planks
    "diamond_cyan":   (1, 0),  # diamond ore (also the source for amethyst)
    "gold_yellow":    (3, 1),  # gold/sandstone block
    # amethyst_purple has no source tile; generated below from diamond_cyan
}

GDD_HEX = {
    "dirt_brown": "#7C5A3A",
    "grass_green": "#6AB04C",
    "stone_gray": "#8E8E8E",
    "brick_red": "#C0392B",
    "planks_tan": "#C9A24B",
    "diamond_cyan": "#4AA3DF",
    "amethyst_purple": "#B84AD1",
    "gold_yellow": "#F4C430",
}

# Ordered column layout for the atlas image (left to right).
ATLAS_ORDER = [
    "dirt_brown", "grass_green", "stone_gray", "brick_red",
    "planks_tan", "diamond_cyan", "amethyst_purple", "gold_yellow",
]


def crop_tile(sheet, col, row):
    x0, y0 = col * TILE_SRC, row * TILE_SRC
    return sheet.crop((x0, y0, x0 + TILE_SRC, y0 + TILE_SRC))


def upscale(tile):
    return tile.resize((TILE_OUT, TILE_OUT), Image.NEAREST)


def make_amethyst(diamond_tile_16):
    """Hue-shift the diamond ore tile's saturated (gem) pixels toward purple.
    Low-saturation rock/matrix pixels are left untouched so the stone base
    still reads as stone, only the ore veins change color family."""
    im = diamond_tile_16.convert("RGBA")
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s > 0.25:  # saturated gem pixel, not gray rock
                # target hue ~0.80 (purple/amethyst) instead of cyan's ~0.5
                h = 0.80
                s = min(1.0, s * 1.05)
                nr, ng, nb = colorsys.hsv_to_rgb(h, s, v)
                px[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    return im


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sheet = Image.open(SRC).convert("RGBA")

    tiles_16 = {}
    for family, (col, row) in FAMILY_SOURCE_TILES.items():
        tiles_16[family] = crop_tile(sheet, col, row)
    tiles_16["amethyst_purple"] = make_amethyst(tiles_16["diamond_cyan"])

    tiles_56 = {family: upscale(t) for family, t in tiles_16.items()}

    # Individual per-family PNGs.
    for family in ATLAS_ORDER:
        tiles_56[family].save(OUT_DIR / f"{family}.png")

    # Combined atlas: 8 columns x 1 row, 56px tiles (448x56 total).
    atlas = Image.new("RGBA", (TILE_OUT * len(ATLAS_ORDER), TILE_OUT), (0, 0, 0, 0))
    coords = {}
    for i, family in enumerate(ATLAS_ORDER):
        x = i * TILE_OUT
        atlas.paste(tiles_56[family], (x, 0))
        coords[family] = {"x": x, "y": 0, "w": TILE_OUT, "h": TILE_OUT, "col": i, "row": 0}
    atlas.save(OUT_DIR / "block-atlas.png")

    block_map = {
        "tileSize": TILE_OUT,
        "atlasPath": "assets/blocks/block-atlas.png",
        "families": {
            family: {
                "hex": GDD_HEX[family],
                "individualPath": f"assets/blocks/{family}.png",
                "atlas": coords[family],
            }
            for family in ATLAS_ORDER
        },
    }
    with open(OUT_DIR / "block-map.json", "w") as f:
        json.dump(block_map, f, indent=2)
        f.write("\n")

    print("Wrote", OUT_DIR / "block-atlas.png", atlas.size)
    for family in ATLAS_ORDER:
        print(" -", OUT_DIR / f"{family}.png")
    print("Wrote", OUT_DIR / "block-map.json")


if __name__ == "__main__":
    main()
