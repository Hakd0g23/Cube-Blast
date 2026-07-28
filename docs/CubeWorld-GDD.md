# Fracture: Cube World Edition - Game Design Document

## 1. Summary
Fracture is a block-placement puzzle game where you drag polyomino pieces from a tray onto an 8×8 grid to clear full rows/columns, now reskinned so every filled cell renders as a textured Cube World voxel block instead of a flat color, with the same "shard queue" pressure mechanic driving the loss condition.

- Assumptions:
  - This is a reskin/asset-integration task on an existing, working Canvas 2D puzzle game; core rules stay identical.
  - The "block files" are a Minecraft-style block texture atlas (dirt, stone, ores, brick, planks, etc.) and the Cube World render sheet is reference art/mood only, not a runtime spritesheet.
  - Rendering remains Canvas 2D (existing engine); no migration to 3D/Three.js.
  - Block textures are square tiles supplied as a single PNG atlas (grid of tiles) or individual PNGs; we treat them as 2D textures drawn per cell.
  - High score persists via localStorage under key `fracture-cubeworld-highscores`.
  - Both desktop (mouse) and mobile (touch) are supported, matching the current release.

## 2. Technical Requirements
- Rendering: Three.js 3D (WebGL), migrated from Canvas 2D as of the 2026-07-28 rendering pivot — same top-down camera angle and grid layout, existing 2D block textures reused as materials. See new section 4A for the full spec.
- Single HTML file with inline CSS and JS; Three.js loaded as a module/bundle dependency
- Unit system: pixels. Reference scale: one grid cell = 56×56 pixels; the 8×8 board = 448×448 pixels plus 4px gutters.
- Asset loading: block textures loaded from an image atlas or individual images before play; game shows a brief "Loading blocks…" state until decode completes.

## 3. Canvas & Viewport
- Board render area: 8×8 grid at 56px cells with 4px gutters (~480×480px playfield). Surrounding HTML panels (score, tray, leaderboard, How to play) remain as in the current release.
- Background: dark charcoal (#1E1F22) matching current dark theme; light theme toggle swaps to (#F4F1EA) parchment.
- Aspect ratio behavior: playfield is fixed square; page layout is responsive/letterboxed around it. On mobile, board scales down uniformly to fit width, tray reflows beneath.

## 4. Visual Style & Art Direction
Chunky, cozy voxel look inspired by the Cube World / blocky Minecraft aesthetic. Cells become "cubes" with soft top-face highlight and darker bottom edge to imply 3D depth on a 2D grid.

Color palette with purpose:
- #7C5A3A dirt/brown — earthy block family
- #6AB04C grass green — nature block accent + clear-flash tint
- #8E8E8E stone gray — neutral/heavy blocks
- #C0392B brick red — warm danger/high-value blocks
- #C9A24B planks/tan — wood family
- #4AA3DF diamond/ice cyan — cool premium blocks
- #B84AD1 amethyst purple — rare block accent
- #F4C430 gold/ore yellow — highlight, milestone, score glow
- #1E1F22 board background (dark)
- #101114 grid gutter shadow

Art style: flat 2D cells textured with pixel-art voxel block faces; subtle beveled edge shading drawn per cell to sell depth. Blocky, readable, warm.

Mood/atmosphere: relaxed, tactile, "building" satisfaction; each placement should feel like snapping a real cube into place.

## 4A. Rendering, Camera & Lighting Pivot (Three.js 3D — added 2026-07-28)

**Scope:** rendering-layer upgrade only. Board rules, scoring, shard-queue mechanic, piece behavior, color/texture families (section 4), and juice timings (section 12 values) are UNCHANGED — this section specifies how the same game now gets drawn. Synthesized from threejs-feasibility-framing (game-engineer) and the re-scoped 3d-asset-audit (game-asset-director), reconciled where they conflicted (see mascot-props below).

**Scene & camera:**
- Board geometry: each cell becomes a `BoxGeometry` cube (or an imported Quaternius glTF block mesh where one maps cleanly to an existing family — see texture/material mapping below), replacing the flat `drawBlockCell` canvas rect. Grid math (cell size, gutters, board origin) ports directly from the existing 2D layout constants — no redesign needed.
- Camera: `OrthographicCamera`, FRONT-ON, facing the board straight-on along a single fixed axis — the board is a VERTICAL plane facing the camera (classic-Tetris framing), not a top-down/angled-down view of a flat horizontal grid. The reference screenshot's angled isometric-top-down look applies only to block texture/style reference now, NOT to camera framing (corrected 2026-07-28 — supersedes the prior "angled top-down" line below).
- Board orientation: cells stack/sit in a vertical XY plane; camera looks straight down the Z axis at that plane (no angle, no tilt, no perspective distortion).
- No scrolling, no dynamic camera movement — matches section 8's "static board".

**Lighting (replaces the old bevel trick):**
- The current Canvas 2D "bevel" (white 12%-alpha top overlay, black 18%-alpha bottom/right overlay, per `drawBlockCell`) has no direct 3D equivalent and is retired outright. A real directional/hemisphere light setup takes over that job on the actual cube geometry — this is a first-class rendering decision, not a missing feature: source textures were confirmed flat/unbevelled (`assets/blocks/*.png`, 56×56 RGBA tiles baked by `tools/block-bake/build.py`), so lighting is free to fully own the depth cue with no baked-in shading to conflict with.
- No dynamic shadow-map tuning or per-wave lighting changes beyond what replaces the bevel (explicit scope cut, keeps the first Three.js lighting pass bounded).

**Materials & textures:**
- Reuse `assets/blocks/*.png` directly as `map` on `MeshStandardMaterial` — no separate top/side texture variants needed; the light does the shading work the bevel used to.
- Textures get padded to 64×64 POT with `ClampToEdgeWrapping` (a rerun of `tools/block-bake/build.py`) before use as WebGL textures.
- `FAMILY_BY_COLOR`'s existing 7→8 family mapping (progress.md render-swap notes) carries over unchanged.

**Mascot props (reconciled decision — game-engineer and game-asset-director's briefs conflicted here):**
- Use STATIC (non-rigged, non-animated) Quaternius glTF meshes from `~/Downloads/Cube World - Aug 2023/` (Animals/Enemies folders — chicken, creeper-like mob) via `GLTFLoader`. Placement is revised for the front-on wall composition (2026-07-28): props sit to the SIDES of the vertical board plane (flanking it left/right, facing camera), not arranged around a floor-level board — there is no floor for them to stand on in this framing.
- This is the locked call, not open for re-litigation: it gets the real body-silhouette game-asset-director found necessary (a textured box doesn't read as a mascot), while keeping game-engineer's actual risk — a new animation-import pipeline stacked on a first Three.js pass — off the table, since a static prop is just load-and-place, no `AnimationMixer`/rig system involved.
- If Quaternius's low-poly style visually clashes against the board's flat pixel-art blocks, a shared unlit/toon material pass is the fallback (flagged by game-asset-director, not committed to unless verification shows a real clash).

**Backdrop (revised 2026-07-28 — was "ground/table surface"):**
- With a front-on wall view, there is no floor plane visible (the camera never looks down at a ground). The void-around-the-board concern is instead handled by a flat BACKDROP/background wall behind the board plane — a simple dark background material or plane, matching the existing dark palette in section 4. No skybox, no ground texture, no table surface needed.

**UI (unchanged in approach):**
- Score/tray/piece-preview UI stays DOM/CSS overlay on top of the WebGL canvas, exactly as it overlays the Canvas 2D board today — not migrated into the 3D scene. This keeps `ui-overlay-integration` a thin layer, not a rewrite.

**Known first-time-in-this-workspace risks (no prior Three.js work exists here — flagged, not blockers):**
- UV-mapping the existing flat textures onto `BoxGeometry`'s 6 faces per cell.
- Mobile WebGL support and context-loss handling (the game ships to mobile touch per section 13).
- Draw-call count at 64+ board meshes plus mascot props and shard-queue chips: build naive (individual meshes) first; only reach for `InstancedMesh` if profiling shows it's actually needed (explicit scope cut against premature optimization).

**Explicit scope cuts for this pivot (v1):**
- No dynamic lighting/shadow tuning beyond the bevel replacement.
- No camera movement or orbit controls.
- No premature `InstancedMesh` adoption.
- No UI migration into the 3D scene.
- Mascots are static (non-animated) props, not rigged characters.

## 5. Player Specifications
There is no avatar. The "player" acts through a held piece (cursor/finger) and the tray.

- Held-piece appearance: the polyomino currently being dragged, rendered as textured cubes at ~85% cell opacity while dragging, snapping to full opacity on valid hover.
- Piece sizes: composed of 1–5 cells; each cell is 56×56px.
- Piece colors: each piece is assigned one block texture (from the block family) so its shards match on clear.
- Starting position: tray holds up to 3 pieces at bottom.
- Movement constraints: pieces move freely with pointer while dragging; on drop they snap to the nearest valid grid-aligned position or return to tray if invalid.

Animated "characters" (block cells) states:
- Idle: placed cubes gently sit; on hover of a valid drop, a soft outline pulses.
- Place: cube "drops in" (see 12.1).
- Clear: cube brightens then shatters into shards (see 12.8-style micro effect).

## 6. Physics & Movement
This is a grid puzzle; motion is UI easing, not simulated gravity. Values below govern feel.

| Property | Value | Unit |
|----------|-------|------|
| Drag follow smoothing | 0.35 lerp per frame | fraction/frame |
| Snap-to-cell duration | 90 | ms |
| Place drop-in offset | 10 | px (from above) |
| Return-to-tray duration | 140 | ms |
| Clear shatter travel | 60–120 | px |
| Clear shatter duration | 320 | ms |

"Up" is negative Y (screen convention). Placed cubes appear to settle downward into their cell.

## 7. Obstacles/Enemies (Shards & Shard Queue)
The pressure mechanic, unchanged in rules, reskinned as falling blocks.

- Appearance: shards are small textured mini-cubes (28×28px) matching the block family/color of the piece that triggered the clear.
- Colors: inherit the clearing piece's block texture tint.
- Spawn position: after any line clear, 1–3 shards scatter back onto random empty board cells.
- Movement behavior: shards arc from the cleared line to their target empty cell (see 12), then become permanent occupied cells of that block type.
- Movement constraints: shards only occupy grid-aligned empty cells — matching the player's grid-only placement (symmetry maintained: both player and shards act only on discrete grid cells).
- Shard queue: top-of-board queue holds up to 4 slots. If the queue fills, the next shard skips the line and force-inserts a block directly into the player's tray (adding a forced piece), exactly as in the current release.
- Despawn condition: shards convert to permanent blocks on landing; those blocks despawn only when cleared as part of a full row/column.

Shard animation feel: quick pop-out, short arc, firm "clack" settle (squash on landing).

## 8. World & Environment
- Static board (no scrolling). The environment is the 8×8 grid of empty cells rendered as faint recessed sockets (#101114 inset with 1px highlight rim).
- Difficulty ramps in waves the longer you survive — later waves deal trickier pieces; current wave number shows next to the score (unchanged).

Block-texture assets:
- Purpose: each filled cell and each piece cell is drawn using a block texture from the supplied atlas (e.g., dirt, grass, stone, brick, planks, diamond ore, amethyst).
- Mapping: the existing color families map to block textures:
  - Teal/cyan → diamond/ice block
  - Yellow/gold → gold ore / sandstone block
  - Red → brick block
  - Green → grass/emerald block
  - Orange → planks/wood block
  - Purple → amethyst block
- Fallback appearance: if a texture fails to load or is missing, draw the original flat color for that family with a beveled edge so the game stays fully playable.
- Rendering per cell: draw the texture tile scaled to 56×56, then overlay a top-edge highlight (white 12% alpha, top ~8px) and bottom/right edge shadow (black 18% alpha, ~6px) to give the voxel "cube" look consistently across all textures.

## 9. Collision & Scoring
- Placement validation: a piece is placeable only if every one of its cells maps to an empty grid cell within bounds (exact grid overlap test).
- Hitbox: snapping uses cell-center nearest-neighbor; the drop is accepted if the piece's footprint aligns fully to empty cells. Forgiveness: accept snap if pointer is within 28px (half a cell) of a valid alignment.
- Game over trigger: when none of the pieces currently in the tray can fit anywhere on the board (unchanged).
- Scoring:
  - +1 per cell placed.
  - Line clear: +10 per cleared line, with a multiplier for simultaneous multi-line clears (×2 for 2 lines, ×3 for 3+).
  - Wave bonus applied as waves increase.
- Near-miss / "close call": clearing a line that leaves only ≤2 empty cells on the board triggers a celebratory flash (see 12.3).
- High score storage: localStorage key `fracture-cubeworld-highscores` (JSON array, top 10). Existing leaderboard panel is preserved.

## 10. Controls
| Input | Action | Condition |
|-------|--------|-----------|
| Mouse down on tray piece | Pick up / start drag | Playing, piece exists |
| Mouse move | Move held piece | While dragging |
| Mouse up over valid cells | Place piece (snaps in) | Valid footprint |
| Mouse up over invalid area | Return piece to tray | Invalid footprint |
| Touch drag | Same as mouse drag | Mobile |
| P or Escape | Pause / resume | Playing |
| New Game button | Restart | Any time |
| Theme toggle (moon icon) | Dark/light swap | Any time |

## 11. Game States

**Menu / How to play:**
- Displayed below the board (as in current release): the four "How to play" bullets, plus a one-line control hint: "Drag blocks from the tray onto the grid. Fill a full row or column to clear it."
- Controls MUST be visible here.
- Start: game is immediately playable; New Game resets.

**Playing:**
- Active: board, tray (up to 3 pieces), shard queue (0/4), score, best, wave, leaderboard.
- Persistent control hint under the tray: "Drag a block onto the grid • Fill a row/column to clear."

**Paused:**
- Trigger: P or Escape.
- Shows dimmed board with "Paused — press P to resume" centered.
- All animations, shard motion, and input on pieces frozen.

**Game Over:**
- Trigger: no tray piece fits anywhere.
- Shows final score, best, and a "New Game" prompt; if score enters top 10, prompt for name entry into leaderboard.
- Retry: click New Game.

## 12. Game Feel & Juice

### 12.1 Input Response
- Pick up: piece scales to 1.06 and lifts (drop shadow grows) instantly on grab.
- Hover valid: target cells show a glowing outline in the piece's block-family color; held piece snaps to full opacity.
- Place: each cube of the piece "drops in" from 10px above with a 90ms ease-out then a 6% squash-and-settle.
- Denied drop: invalid target flashes red outline (120ms) and piece eases back to tray (140ms) with a small shake.

### 12.2 Animation Timing
- Squash/stretch on place: scale 1.0→0.94→1.0 over 120ms, ease-out then bounce settle.
- Line clear brighten: cells flash to +40% brightness over 90ms before shattering.
- Shard arc: 220ms ease-in-out from source to target cell, +100ms landing squash.
- UI transitions (pause overlay, game over): fade 180ms.

### 12.3 Near-Miss / Big-Clear Rewards
- Detection: a clear that empties ≥3 lines at once, OR leaves the board nearly empty (≤2 cells).
- Visual: board-wide gold flash (#F4C430 at 25% alpha, 150ms) + brief 0.5x time dilation on the shatter.
- Audio cue: out of scope (sound excluded); use visual gold flash as the reward signal.
- Score: floating "+N" text rises 30px and fades over 600ms above the cleared area.

### 12.4 Screen Effects
| Effect | Trigger | Feel |
|--------|---------|------|
| Shake | Game over | 6px amplitude, 300ms decay |
| Flash | Multi-line clear / near-miss | Gold #F4C430, 25% alpha, 150ms |
| Zoom pulse | 3+ line simultaneous clear | Board scales 1.0→1.03→1.0, 220ms |
| Time dilation | Big clear shatter | 0.5x for 200ms then ramp back |

### 12.5 Progressive Intensity
Tied to wave number (existing wave system):
- Waves 1–2: neutral block families (dirt, stone, planks); calm.
- Waves 3–4: introduce ore blocks (gold, diamond) with faint sparkle overlay on those cells.
- Waves 5+: amethyst/brick blocks appear; board gutter tint shifts slightly warmer; clear flashes intensify by +10% alpha.

### 12.6 Idle Life
- Placed cubes: top-face highlight subtly shimmers (2% brightness oscillation, ~3s period).
- Ore/diamond blocks: occasional single sparkle glint drifts across the tile.
- Tray pieces: gentle 2px vertical bob (staggered per piece) while awaiting placement.
- Shard queue slots: empty slots softly pulse their rim.

### 12.7 Milestone Celebrations
- Milestone interval: every 500 points.
- Celebration: score text pops (scale 1.0→1.2→1.0, 250ms) with a gold glow and a single board-wide gold flash (120ms).
- New high score: leaderboard entry highlights gold and pulses; "New Best!" banner fades in above the score for 1.2s.

### 12.8 Death Sequence
- Trigger: no piece fits.
- Player visual: all placed cubes desaturate to gray over 300ms, then the board does a single 6px shake.
- Screen effect: brief freeze-frame (120ms) then dim overlay fades in with Game Over panel.
- Timing: total ~600ms before Game Over UI is interactive.

## 13. UX Requirements
- Controls shown in the How-to-play panel (required) and as a persistent hint under the tray during play (required).
- Forgiving placement: accept snap within 28px (half a cell) of a fully valid alignment.
- Mobile/touch: full drag-and-drop parity; board scales to fit width; tray reflows beneath board; tap-and-hold to pick up.
- Loading: show "Loading blocks…" until textures decode; fall back to flat colors if any asset fails so the game never blocks on missing art.
- Theme toggle preserved (dark/light).

## 14. Out of Scope (V1)
- Sound and music.
- ~~Migration to 3D / Three.js rendering.~~ **Superseded 2026-07-28: this migration is now in scope and underway. See section 4A.**
- Animated Cube World characters/creatures (trees, animals, mobs from the render sheet are reference only).
- New gameplay mechanics beyond the existing block-clear + shard-queue rules.
- Power-ups, undo, or hints.
- Settings menu beyond existing theme toggle.
- Online multiplayer or cloud sync.

## 15. Success Criteria
- [ ] Runs from single HTML file without errors.
- [ ] Block textures load and render one texture per occupied cell and per tray piece.
- [ ] Missing/failed textures fall back to original flat colors with beveled edges (game stays playable).
- [ ] Controls visible in How-to-play AND as a persistent hint during gameplay.
- [ ] Drag/drop feels instant; pick-up lifts and hover shows valid-target glow same frame.
- [ ] Placement has drop-in + squash-and-settle follow-through.
- [ ] Line clears brighten then shatter into color-matched shards that arc back to empty cells.
- [ ] Shard queue fills to 4 and force-inserts into the tray when overfull (rule preserved).
- [ ] Multi-line and near-empty clears trigger gold flash / zoom / time-dilation reward.
- [ ] Score updates with pop feedback; milestones every 500 celebrate.
- [ ] Top-10 high scores persist across sessions under `fracture-cubeworld-highscores`.
- [ ] Pause/resume (P/Escape) freezes everything.
- [ ] Game over triggers desaturate + shake + freeze-frame before panel.
- [ ] Placement snapping feels fair within a 28px tolerance.
- [ ] Idle blocks shimmer and tray pieces bob when player does nothing.
- [ ] Works on desktop mouse and mobile touch with responsive scaling.