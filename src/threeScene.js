// Cube Blast — Three.js scene/camera/lighting infrastructure (workstream:
// threejs-scene-camera-setup, later extended by texture-to-material-mapping).
// Per GDD section 4A, this is a FOUNDATIONAL pass: fixed orthographic
// camera, an 8x8 grid of naive BoxGeometry cubes, and real
// directional/hemisphere lighting that replaces the old Canvas 2D bevel
// trick as the depth cue. texture-to-material-mapping (2026-07-28) added:
// real assets/blocks/*.png textures on the 64 cube meshes (async-loaded,
// same "flat color first, texture appears once ready" fallback pattern as
// render-swap's 2D loadBlockTextures()), and a brick-textured backdrop wall
// (cropped from the Quaternius Cube World pack's Blocks_PixelArt.png, tiled
// via repeat-wrapping) replacing the flat #101114 fill. Still NOT in scope
// here (left for later workstreams, see progress.md sequencing):
//   - mascot-prop-placement: no Quaternius glTF props.
//   - ui-overlay-integration: this module doesn't touch the DOM score/tray
//     chrome and isn't wired into gameplay state (src/core.js) at all yet —
//     it renders a static demo board to prove the scene/camera/lighting
//     pipeline, not the live game.
//
// Grid math ported directly from the existing 2D layout constants (GDD 4A):
// cell size 56px, 8x8 grid, 4px gutters (docs/CubeWorld-GDD.md sec 2/4A;
// src/main.js computeLayout()/BOARD_SIZE). Three.js world units aren't
// pixels, so everything below is scaled by WORLD_UNITS_PER_PX = 1/56 —
// this is a unit-system conversion, not a layout redesign: one board cell
// is exactly 1 world unit, matching the 56px reference 1:1, and the 4px
// gutter becomes a proportional gap between cube meshes (4/56 world units)
// instead of the 2D renderer's flat grid-line stroke.

import * as THREE from 'https://unpkg.com/three@0.180.0/build/three.module.js';
// neon-blocks-pass: bloom post-processing so emissive "neon" cube faces
// actually read as glowing rather than just a slightly brighter flat color.
// Same pinned three@0.180.0 CDN version as the GLTFLoader import above, so
// the postprocessing examples modules are guaranteed API-compatible with the
// core three module also loaded from that version.
import { EffectComposer } from 'https://unpkg.com/three@0.180.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.180.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.180.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'https://unpkg.com/three@0.180.0/examples/jsm/postprocessing/OutputPass.js';
import { BOARD_SIZE } from './pieces.js';
import { FAMILY_BY_COLOR } from './blockTextureConfig.js';
// juice-effects-port: reuse the SAME pause-safe virtual clock ux-loading-pass
// built for the 2D renderer (src/main.js) rather than creating a second one --
// every timing calculation below reads through this single vnow(), so
// pause/resume correctness (setPaused()/isPaused() in main.js) carries over
// for free, exactly like it does for the 2D juice effects.
import { vnow } from './main.js';

export const CELL_PX = 56;
export const GUTTER_PX = 4;
const WORLD_UNITS_PER_PX = 1 / CELL_PX;
const CELL_STRIDE = 1; // one board cell == 1 world unit, by construction above
const GUTTER_WORLD = GUTTER_PX * WORLD_UNITS_PER_PX; // ~0.0714 world units
const CUBE_FOOTPRINT = CELL_STRIDE - GUTTER_WORLD; // visible gap between cubes
// depth-pass (2026-07-29): bumped from the original 0.4 -- against the
// ~0.93 XY footprint (CUBE_FOOTPRINT below) that read as a thin plate/tile,
// not a proper cube. 0.8 lands inside the "reads as a cube, not a brick or a
// slab" range without pushing the front face far enough forward to fight
// the fixed front-on camera framing. Every Z-offset elsewhere in this file
// that positions something "just in front of the cube face" (gold flash,
// shard/break-effect chips, placement preview, the ledge) is expressed
// RELATIVE to this constant already, so they scale with it automatically —
// re-checked by eye after this bump, not just assumed (see this pass's
// verification notes).
const CUBE_HEIGHT = 0.8; // chunky "voxel" look; not GDD-specified, first-pass value
const BOARD_HALF = (BOARD_SIZE - 1) / 2;

// Fixed FRONT-ON camera position (GDD 4A, corrected 2026-07-28: classic-
// Tetris "wall" framing, board is a vertical XY plane, camera looks straight
// down -Z at it — no elevation/tilt, no orbit/user controls). Distance is
// derived from board size so the whole 8x8 grid frames comfortably
// regardless of exact px constants above.
const CAMERA_DISTANCE = BOARD_SIZE * 1.35;
const BACKDROP_DEPTH = BOARD_SIZE * 0.75; // how far behind the board plane the backdrop wall sits

// scene-layout-cleanup (2026-07-29): the ORIGINAL symmetric-frustum framing
// packed the board, the ledge, and both mascot pairs into the same vertical
// span the fixed-size #three-stage-wrap square already had to also fit the
// DOM shard-queue row (top) and DOM tray row (bottom) OVER -- fixed with an
// asymmetric top/bottom frustum instead of one symmetric value:
//   - TOP_UI_MARGIN_FRAC: empty world-space band above the board's top edge,
//     sized to clear the shard-queue DOM row's own rendered height.
//   - BOARD_FRAC: the board's own share of the total canvas height.
//   - Everything else (derived, not independently chosen) becomes the
//     bottom margin, clearing the DOM tray row with room to spare.
//
// mascot-side-placement (2026-07-29, superseded by mascot-flank-tray below):
// originally flanked the board's LEFT/RIGHT sides at 3x scale, which needed
// BOARD_FRAC dropped from 0.53 to 0.48 to free real side-margin room for
// such large figures.
//
// mascot-flank-tray (block-blast-hud-pass): per user feedback, the board
// itself read as too small on mobile widths with that much side margin
// permanently reserved for tall mascots. Mascots+pets are relocated to flank
// the TRAY row instead (see MASCOT_SCALE_MULTIPLIER/MASCOT_CLUSTER_INNER_GAP
// below -- shrunk back down from 3x to a small "flanking a small tray"
// scale), which needs much less horizontal margin -- BOARD_FRAC bumped from
// 0.48 up to 0.64 (even above the original pre-mascot 0.53) to reclaim that
// freed width/height for a visibly bigger grid, which is exactly the
// mobile-width goal this pass is for. Since the container is a fixed SQUARE
// and cubes must stay undistorted (world-units-per-pixel equal on both axes
// -- see resize() below), BOARD_FRAC directly determines how much side
// margin exists for the now-much-smaller mascots too; re-tuned by eye
// against real screenshots, not a closed-form derivation -- if the mascot
// scale or the tray/queue row CSS change materially, re-check this framing
// against a fresh screenshot rather than assuming it still holds.
const BOARD_WORLD_HALF_HEIGHT = BOARD_HALF + CUBE_FOOTPRINT / 2; // board's own top/bottom (and, since square, left/right) edge distance from center
// re-loosened (block-blast-hud-pass, queue-clip-fix): 0.07 (tightened
// 2026-07-29 for the "too much dead air" complaint) turned out to be
// SMALLER than the queue row's real rendered height (label line + a full
// row of 4 slots, ~65-70px at typical viewport sizes) once threeBootstrap.js
// switched the queue row to bottom-anchored absolute positioning -- a
// too-small margin meant the row's own top edge landed above y=0 inside
// #three-stage-wrap, and #stage-wrap's overflow:hidden (added for the
// tray-bottom-clip fix) silently cropped that overflowing top portion, so
// only part of the queue slots ever painted. 0.115 leaves real headroom
// above the queue row's measured worst-case height instead of just visually
// "looking about right" -- re-check against a fresh screenshot/measurement
// if the queue row's own CSS (slot size, gap, label) changes again.
const TOP_UI_MARGIN_FRAC = 0.115;
const BOARD_FRAC = 0.64;
const TOTAL_WORLD_HEIGHT = (2 * BOARD_WORLD_HALF_HEIGHT) / BOARD_FRAC;
const FRUSTUM_TOP_WORLD = BOARD_WORLD_HALF_HEIGHT + TOP_UI_MARGIN_FRAC * TOTAL_WORLD_HEIGHT;
// tray-gap-fix (2026-07-29): the DOM #three-tray-row used to be pinned to
// the very bottom of #three-stage-wrap via CSS `justify-content:
// space-between` on its flex parent, with NO relation to where the board's
// bottom edge actually lands on screen. Since BOARD_FRAC+TOP_UI_MARGIN_FRAC
// only add up to 0.55 of the total square, the remaining 0.45 all became
// dead space between the rendered board and the tray row -- confirmed via
// a live screenshot measurement (board bottom sat at ~55% down the square,
// tray row started at ~87%). Exporting the board's own bottom-edge fraction
// here so threeBootstrap.js can position the tray row from actual world
// geometry instead of guessing from CSS flex alone.
export const BOARD_BOTTOM_FRAC = BOARD_FRAC + TOP_UI_MARGIN_FRAC;
// queue-gap-fix: same reasoning as BOARD_BOTTOM_FRAC above, but for the
// board's TOP edge -- the DOM #three-queue-row was only ever placed via CSS
// flex `justify-content: space-between` inside #three-ui-overlay (i.e. "top
// of the overlay's padding box"), with no relation to where the board's own
// top edge actually renders. TOP_UI_MARGIN_FRAC was tuned by eye against a
// specific queue-row height; once the row's real rendered height (label +
// slots) exceeds that margin, it visually overlaps the board's top edge.
// Exporting the fraction here lets threeBootstrap.js clamp the queue row's
// height/position against the board's real top edge the same way it already
// does for the tray row's bottom edge.
export const BOARD_TOP_FRAC = TOP_UI_MARGIN_FRAC;
const FRUSTUM_BOTTOM_WORLD = FRUSTUM_TOP_WORLD - TOTAL_WORLD_HEIGHT;
// Per-side horizontal room outside the board's own footprint (aspect=1
// container, so the same TOTAL_WORLD_HEIGHT applies horizontally too, per
// resize()'s uniform-world-units-per-pixel requirement). Used to spread the
// ambient side-decor particles below.
const SIDE_MARGIN_WORLD = (TOTAL_WORLD_HEIGHT - 2 * BOARD_WORLD_HALF_HEIGHT) / 2;

// ---- juice-effects-port constants (workstream: juice-effects-port) --------
// Ported 1:1 from src/main.js's GDD-12 juice-pass numbers (same durations/
// magnitudes, just converted from px to world units via WORLD_UNITS_PER_PX
// where the 2D version was px-based). Kept as separate constants in this
// module (not imported from main.js) since main.js doesn't export its own
// internal timing constants -- these are intentionally duplicated NUMBERS,
// not duplicated LOGIC; the single source of truth for "should this number
// ever change" is still GDD section 12.
const DROP_IN_MS = 90;
const SQUASH_MS = 120;
const DROP_IN_PX = 10;
const SHARD_ARC_MS = 220;
const SHARD_LAND_SQUASH_MS = 100;
const GOLD_FLASH_MS = 150;
const MILESTONE_FLASH_MS = 120;
const ZOOM_PULSE_MS = 220;
const SHIMMER_PERIOD_MS = 3000;
const DEATH_DESATURATE_MS = 300;
const DEATH_SHAKE_MS = 300;
const DEATH_SHAKE_PX = 6;
const DEATH_FREEZE_MS = 120;
const GOLD_HEX = 0xf4c430; // literal #F4C430, same as main.js's GOLD constant

// ---- ledge/baseboard decoration (workstream: mascot-prop-placement) -------
// Originally the surface mascots stood on; mascot-side-placement (below)
// moved the mascots off it entirely, but the ledge itself stays as a small
// decorative baseboard/trim strip under the board (reads fine as arcade-
// cabinet-style trim even with nothing standing on it) -- removing it
// outright wasn't asked for and it costs nothing to keep.
const BOARD_BOTTOM_EDGE = -BOARD_HALF - CUBE_FOOTPRINT / 2; // y of the board's lowest cube edge
const LEDGE_HEIGHT = 0.3;
const LEDGE_DEPTH = 1.2;
const LEDGE_GAP = 0.12;
const LEDGE_TOP_Y = BOARD_BOTTOM_EDGE - LEDGE_GAP;
const LEDGE_CENTER_Y = LEDGE_TOP_Y - LEDGE_HEIGHT / 2;
const LEDGE_CENTER_Z = CUBE_HEIGHT / 2 + LEDGE_DEPTH / 2 - 0.1; // steps slightly toward the camera from the board plane
const LEDGE_WIDTH = BOARD_SIZE + 1.5; // a bit wider than the board

// ---- backdrop constants (neon-blocks-pass) -------------------------------
// backdrop-cleanup (2026-07-29): retired the tiled brick-wall texture here --
// the user called it "confusing" clutter behind an already-busy board.
// Replaced with a plain vertical dark gradient (built procedurally below,
// makeBackdropGradientTexture()) instead of any external image asset, so the
// backdrop reads as a clean neon-arcade void rather than a textured wall.
const BACKDROP_SIZE = BOARD_SIZE * 3; // matches backdropGeo's PlaneGeometry dimensions below


// ---- neon-blocks-pass: per-family neon material colors ------------------
// Replaces texture-to-material-mapping's PNG-textured cube materials
// (assets/blocks/*.png, block-map.json) entirely -- the user asked for a
// "neon blocks" look ("I guess lets keep them neon blocks"), which reads as
// flat glowing color, not a pixel-art block texture (the same "too busy"
// complaint that killed the brick backdrop applies to a photographic block
// texture fighting a glow effect). Built directly and SYNCHRONOUSLY from
// FAMILY_BY_COLOR's own 7 game-palette hex values (src/blockTextureConfig.js,
// the actual piece colors src/core.js deals cells in) -- no network fetch,
// no block-map.json dependency, no async load/fail path needed anymore for
// cube materials.
//
// vibrant-color-pass: FAMILY_BY_COLOR's hex values as authored are fairly
// muted (game-palette colors chosen for legibility against a plain 2D
// canvas fill, not for glow). boostSaturation() pushes each one toward
// fuller saturation/lightness before it becomes a material's base color/
// emissive tint, so the neon look reads as genuinely vibrant/punchy rather
// than just "the same muted color, now glowing."
// glow-dial-back (2026-07-29): the user said the first neon pass was "too
// bright" / blown-out. Dropped from 1.15 -- still glows, but the cube's own
// base color reads clearly instead of getting washed out to near-white by
// an overly hot emissive term stacked with bloom.
const NEON_EMISSIVE_INTENSITY = 0.55;
function boostSaturation(hex, satTarget = 0.92, lightTarget = 0.56) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  // Only ever push saturation/lightness UP toward the target, never down --
  // a source color that's already more vivid than the target should stay
  // that way rather than getting flattened toward it.
  const s = Math.max(hsl.s, satTarget);
  const l = Math.min(Math.max(hsl.l, lightTarget * 0.85), lightTarget);
  c.setHSL(hsl.h, s, l);
  return c;
}

/**
 * Builds the Three.js renderer/scene/camera/lighting infrastructure inside
 * `container` (an existing DOM element). Returns handles for the caller
 * (verification scripts, future workstreams) plus resize()/dispose().
 *
 * This does NOT start its own render loop tied to game state — render() is
 * exposed so a caller can drive it (rAF loop, or a single call for a
 * headless screenshot), keeping this module decoupled from src/main.js's
 * existing Canvas 2D game loop per the "foundational, later workstreams
 * depend on this" framing.
 */
export function createThreeScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1e1f22); // GDD sec 3 dark charcoal board background

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  // Front-on: camera sits on the +Z axis, looking straight down -Z at the
  // board's XY plane (X = column, Y = row going up, Z = depth toward/away
  // from camera). No elevation, no tilt.
  camera.position.set(0, 0, CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);
  // No OrbitControls import anywhere in this module — explicit GDD 4A scope cut.

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Basic shadow setup only (GDD 4A: "no dynamic shadow-map tuning beyond
  // the basic light setup") — default PCF map, no per-light bias/normalBias
  // tuning pass.
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  // ---- neon-blocks-pass: bloom post-processing ---------------------------
  // A composer pipeline (RenderPass -> UnrealBloomPass -> OutputPass)
  // replaces the old single renderer.render(scene, camera) call in render()
  // below.
  // glow-dial-back (2026-07-29): the first pass (strength 0.55, radius 0.5,
  // threshold 0.72) read as blown-out/washed-out per feedback -- strength
  // dropped and threshold raised further so only the genuinely brightest
  // emissive neon faces (and gold-flash/shard effects) bloom at all, and
  // radius trimmed so the glow that IS there stays a tight halo around the
  // cube rather than smearing across neighboring cells.
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.35, 0.82);
  composer.addPass(bloomPass);
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // ---- lighting: replaces the retired Canvas 2D bevel trick -------------
  // GDD 4A: real directional + hemisphere lighting is the depth cue now,
  // not a bolt-on. Source block textures were confirmed flat/unbevelled, so
  // there's nothing baked-in for this lighting to fight.
  // lighting-pass-2 (2026-07-29): the user said "we need more lighting"
  // even after the first contrast pass (bumped key + one cool fill). Bumped
  // key/fill further still, AND — leaning into the neon-blocks direction
  // instead of just brighter white light — added two low-intensity COLORED
  // accent point lights (cyan from one side, magenta from the other) near
  // the board plane. Their job isn't scene-wide illumination (that's still
  // the key/fill/hemisphere's job) -- it's tinting the cube faces' own
  // highlights with a bit of arcade-neon color so the glow reads as
  // deliberately colorful, not just "brighter."
  const hemi = new THREE.HemisphereLight(0xbcd4f2, 0x2a2118, 0.45);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xfff2d9, 2.1);
  // Re-aimed for the front-on wall: light comes from upper-camera-side
  // (off to one side and above, and slightly toward the camera in Z) so the
  // cube faces facing the viewer still pick up visible directional shading
  // instead of being lit edge-on/from behind the board.
  keyLight.position.set(BOARD_SIZE * 0.6, BOARD_SIZE * 0.7, BOARD_SIZE * 0.9);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  // Tight-ish shadow frustum fitted to the board footprint (not a tuning
  // pass, just enough that shadows land on the board instead of nowhere).
  const shadowExtent = BOARD_SIZE * 0.9;
  keyLight.shadow.camera.left = -shadowExtent;
  keyLight.shadow.camera.right = shadowExtent;
  keyLight.shadow.camera.top = shadowExtent;
  keyLight.shadow.camera.bottom = -shadowExtent;
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = BOARD_SIZE * 4;
  scene.add(keyLight);
  scene.add(keyLight.target);

  // Secondary fill/rim light: opposite side (lower-left, and behind toward
  // the backdrop) at low intensity and a cool tint so it reads as
  // reflected-ambient bounce rather than a second obvious sun — its job is
  // only to lift shadowed cube faces off pure black, not to compete with
  // the key light. No shadow casting (a fill light casting its own shadow
  // just muddies the key light's shadow instead of adding depth).
  const fillLight = new THREE.DirectionalLight(0x9fc4ff, 0.7);
  fillLight.position.set(-BOARD_SIZE * 0.7, -BOARD_SIZE * 0.3, BOARD_SIZE * 0.5);
  scene.add(fillLight);
  scene.add(fillLight.target);

  // Neon accent point lights -- low intensity, short range (distance cutoff
  // via .distance so they only touch the board area, not the whole scene),
  // no shadows (accent lights, not a depth cue). Positioned just in front of
  // the board plane on either side so they catch the cube faces' emissive
  // highlights without visibly lighting the backdrop behind them.
  const accentLeft = new THREE.PointLight(0x33e6ff, 6, BOARD_SIZE * 1.6, 2);
  accentLeft.position.set(-BOARD_SIZE * 0.55, BOARD_SIZE * 0.1, CUBE_HEIGHT * 2);
  scene.add(accentLeft);
  const accentRight = new THREE.PointLight(0xff3ec8, 6, BOARD_SIZE * 1.6, 2);
  accentRight.position.set(BOARD_SIZE * 0.55, -BOARD_SIZE * 0.1, CUBE_HEIGHT * 2);
  scene.add(accentRight);

  // ---- backdrop wall (GDD 4A, corrected 2026-07-28: front-on framing has
  // no floor visible — replaces the old ground/table stub plane with a flat
  // backdrop wall behind the board plane, facing the camera).
  // backdrop-cleanup (2026-07-29): retired the tiled brick texture (called
  // out as "confusing" clutter) in favor of a plain, clean vertical dark
  // gradient built procedurally on an offscreen canvas -- no network asset,
  // nothing to fail-and-fallback on, so this is applied synchronously
  // instead of the old async load-then-swap pattern.
  const backdropGeo = new THREE.PlaneGeometry(BACKDROP_SIZE, BACKDROP_SIZE);
  const backdropMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(backdropGeo, backdropMat);
  // Upright, facing +Z (toward the camera), sitting behind the board plane.
  ground.position.z = -BACKDROP_DEPTH;
  // scene-layout-cleanup follow-up (2026-07-29): was `true` -- the backdrop
  // plane (BACKDROP_SIZE=24) is far larger than keyLight's shadow-camera
  // frustum (shadowExtent = BOARD_SIZE*0.9 = 7.2, sized for the board's own
  // footprint), so the area outside that frustum showed a visible hard seam
  // (a large wrong-looking dark/light "blob" cutting across the backdrop) --
  // confirmed via screenshot once the wider side-mascot framing revealed
  // more of the backdrop than the old framing ever showed. A flat gradient
  // "clean neon void" backdrop was never meant to catch a realistic shadow
  // anyway, so simplest correct fix is to just not have it receive shadows
  // at all rather than trying to size a shadow camera to match it.
  ground.receiveShadow = false;
  scene.add(ground);

  // backdrop-theming (2026-07-29): the gradient used to be hardcoded dark
  // regardless of the page's own light/dark toggle (index.html's
  // [data-theme="dark"|"light"] CSS custom-property system driving
  // everything else). src/main.js's applyTheme() sets
  // document.documentElement.dataset.theme synchronously at module load
  // (before this module ever runs, per script-order -- confirmed by the
  // same reasoning threeBootstrap.js's own window.__fractureDebug-ordering
  // comment already documents) and again on every toggle click, so reading
  // that attribute directly (no import needed) is the same source of truth
  // main.js's own theme()/getComputedStyle helper uses. A MutationObserver
  // on that one attribute (not a custom event/callback wired through
  // threeBootstrap.js) keeps this self-contained and reacts correctly no
  // matter what triggers the change.
  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }
  // Dark: navy-charcoal top fading to near-black bottom -- a "clean neon-
  // arcade void" rather than a lit wall, so the glowing cubes/mascots read
  // as the scene's actual focal points against it.
  // Light: kept deliberately UN-white (soft blue-gray, in the same family as
  // index.html's light-theme --canvas-bg #eef0f4/--empty-cell #dfe2e8, just
  // a shade moodier) -- a literal white backdrop would blow out the neon
  // emissive/bloom entirely, so this still reads as "light theme" without
  // fighting the glow effect it's supposed to be backing.
  const BACKDROP_GRADIENT_STOPS = {
    dark: ['#1b1f2c', '#12141c', '#08090c'],
    light: ['#dde2ea', '#c7ccd6', '#aeb4c0'],
  };
  function makeBackdropGradientTexture(theme) {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const stops = BACKDROP_GRADIENT_STOPS[theme] || BACKDROP_GRADIENT_STOPS.dark;
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, stops[0]);
    grad.addColorStop(0.55, stops[1]);
    grad.addColorStop(1, stops[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  function applyBackdropForCurrentTheme() {
    const tex = makeBackdropGradientTexture(currentTheme());
    if (backdropMat.map) backdropMat.map.dispose();
    backdropMat.map = tex;
    backdropMat.needsUpdate = true;
  }
  applyBackdropForCurrentTheme();
  backdropMat.color.set(0xffffff); // let the gradient texture supply color; a tint would otherwise darken it
  const backdropThemeObserver = new MutationObserver(() => applyBackdropForCurrentTheme());
  backdropThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // No network fetch anymore -- built synchronously above, so this always
  // resolves true immediately. Kept as a Promise (not a plain boolean) so
  // existing callers (threeBootstrap.js Promise.all(...), Playwright tests)
  // that await it keep working unchanged.
  let backdropTextureFailed = false;
  const backdropTextureLoaded = Promise.resolve(true);

  // ---- side-decor ambient particles (2026-07-29) -------------------------
  // Per user screenshot feedback: the side margins beyond the mascot
  // clusters (MASCOT_SIDE_MARGIN_WORLD's outer half, out to the frustum
  // edge) read as bare/empty once the mascots themselves stopped filling
  // that space. A drifting field of soft glowing motes -- reusing the SAME
  // cyan/magenta neon palette the accentLeft/accentRight point lights above
  // already established (0x33e6ff / 0xff3ec8), so this reads as "belongs to
  // this scene's lighting", not a new color language -- fills that bare
  // space without competing with gameplay: kept BEHIND the mascots/board
  // (negative Z, between the board plane and the backdrop), low opacity,
  // additive blending (glow, not solid clutter), and slow/subtle drift
  // rather than anything fast enough to catch the eye mid-play.
  //
  // One shared THREE.Points cloud (not per-particle meshes) for the usual
  // "don't reach for more machinery than the naive approach needs" reason
  // this file already applies to the board cubes above (naive BoxGeometry
  // per cell, no InstancedMesh) -- a few dozen points is nowhere near where
  // per-mesh overhead would matter, and Points is the simplest correct tool
  // for "a field of soft dots."
  const SIDE_PARTICLE_COUNT_PER_SIDE = 22;
  const SIDE_PARTICLE_COUNT = SIDE_PARTICLE_COUNT_PER_SIDE * 2;
  // Soft round glow sprite (radial-gradient canvas texture), same offscreen-
  // canvas technique as makeBackdropGradientTexture above -- avoids a hard
  // square dot (THREE.Points' default) reading as a UI/debug artifact rather
  // than ambient scenery.
  function makeGlowDotTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const sideParticleGeo = new THREE.BufferGeometry();
  const sideParticlePositions = new Float32Array(SIDE_PARTICLE_COUNT * 3);
  const sideParticleColors = new Float32Array(SIDE_PARTICLE_COUNT * 3);
  // Per-particle animation state, kept in parallel plain arrays (not on the
  // geometry) since only positions/colors are actual GPU attributes here --
  // baseY/phase/speed/drift are CPU-side inputs to updateSideParticles().
  const sideParticleBaseY = new Float32Array(SIDE_PARTICLE_COUNT);
  const sideParticleBaseX = new Float32Array(SIDE_PARTICLE_COUNT);
  const sideParticlePhase = new Float32Array(SIDE_PARTICLE_COUNT);
  const sideParticleBobSpeed = new Float32Array(SIDE_PARTICLE_COUNT);
  const sideParticleDriftAmp = new Float32Array(SIDE_PARTICLE_COUNT);
  const cyanColor = new THREE.Color(0x33e6ff);
  const magentaColor = new THREE.Color(0xff3ec8);
  for (let i = 0; i < SIDE_PARTICLE_COUNT; i++) {
    const side = i < SIDE_PARTICLE_COUNT_PER_SIDE ? -1 : 1;
    // Spread across the FULL side margin (from just outside the board's own
    // edge out to the frustum's outer edge) -- covers both the inner gap
    // beside the board AND the outer gap beyond the side margin, per the
    // "bare space on both sides" report (not just the outermost strip).
    const marginT = Math.random(); // 0 = just past the board edge, 1 = frustum edge
    const x = side * (BOARD_WORLD_HALF_HEIGHT + 0.6 + marginT * (SIDE_MARGIN_WORLD - 0.6));
    const y = FRUSTUM_BOTTOM_WORLD + Math.random() * TOTAL_WORLD_HEIGHT;
    // Between the board plane and the backdrop -- reads as background
    // atmosphere, never overlapping/occluding the board, mascots, or the
    // placement-preview/juice-effect layers (all of which sit at z >= 0).
    const z = -1.5 - Math.random() * (BACKDROP_DEPTH - 2);
    sideParticleBaseX[i] = x;
    sideParticleBaseY[i] = y;
    sideParticlePositions[i * 3] = x;
    sideParticlePositions[i * 3 + 1] = y;
    sideParticlePositions[i * 3 + 2] = z;
    const col = side < 0 ? cyanColor : magentaColor;
    sideParticleColors[i * 3] = col.r;
    sideParticleColors[i * 3 + 1] = col.g;
    sideParticleColors[i * 3 + 2] = col.b;
    sideParticlePhase[i] = Math.random() * Math.PI * 2;
    // Slow, gentle bob (full cycle 6-11s) and a small horizontal drift
    // amplitude (<=0.35 world units) -- deliberately subtle per the "don't
    // distract from gameplay" brief, tuned by eye against a real screenshot.
    sideParticleBobSpeed[i] = (2 * Math.PI) / (6000 + Math.random() * 5000);
    sideParticleDriftAmp[i] = 0.15 + Math.random() * 0.2;
  }
  sideParticleGeo.setAttribute('position', new THREE.BufferAttribute(sideParticlePositions, 3));
  sideParticleGeo.setAttribute('color', new THREE.BufferAttribute(sideParticleColors, 3));
  const sideParticleTexture = makeGlowDotTexture();
  // size-in-pixels-not-world-units fix (2026-07-29): this scene's camera is
  // ORTHOGRAPHIC (see `const camera = new THREE.OrthographicCamera(...)`
  // above) -- three.js's Points vertex shader only applies the
  // sizeAttenuation distance-scale branch when the projection matrix is
  // PERSPECTIVE (`isPerspectiveMatrix`); under orthographic projection
  // `gl_PointSize` is always the material's raw `size` value directly, in
  // screen PIXELS, regardless of the sizeAttenuation flag. The original
  // 0.55 here was chosen as if it were a world-unit size (matching this
  // file's board/mascot convention of everything else being in world
  // units) -- that rendered as a sub-pixel, invisible point. Confirmed via a
  // real windowed Playwright run: with size=0.55 nothing appeared on
  // screen at all; bumping to a real pixel size (14) made the glow dots
  // clearly visible without reading as clutter.
  const sideParticleMat = new THREE.PointsMaterial({
    size: 14,
    map: sideParticleTexture,
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false, // additive-style glow shouldn't punch a hole in the backdrop behind it
    blending: THREE.AdditiveBlending,
    sizeAttenuation: false, // no-op under orthographic (see comment above) -- explicit for clarity
  });
  const sideParticles = new THREE.Points(sideParticleGeo, sideParticleMat);
  scene.add(sideParticles);
  function updateSideParticles(now) {
    const posAttr = sideParticleGeo.attributes.position;
    for (let i = 0; i < SIDE_PARTICLE_COUNT; i++) {
      const t = now * sideParticleBobSpeed[i] + sideParticlePhase[i];
      posAttr.array[i * 3] = sideParticleBaseX[i] + Math.sin(t * 0.6) * sideParticleDriftAmp[i];
      posAttr.array[i * 3 + 1] = sideParticleBaseY[i] + Math.sin(t) * sideParticleDriftAmp[i] * 1.4;
    }
    posAttr.needsUpdate = true;
  }

  // ---- 8x8 grid of naive BoxGeometry cubes -------------------------------
  // Deliberately one Mesh per cell (64 meshes), NOT InstancedMesh, per GDD
  // 4A explicit scope cut ("build naive first; only reach for InstancedMesh
  // if profiling shows it's actually needed"). Cubes sit in the vertical XY
  // plane facing the camera: X = column, Y = row going up, Z = depth
  // (thickness) toward the camera — not a horizontal XZ ground layout.
  const cubeGeo = new THREE.BoxGeometry(CUBE_FOOTPRINT, CUBE_FOOTPRINT, CUBE_HEIGHT);
  // Flat placeholder material — shared by every cube until per-family
  // textures finish loading below (async), same first-paint fallback
  // contract as the backdrop above and as render-swap's 2D drawBlockCell().
  const placeholderMat = new THREE.MeshStandardMaterial({ color: 0x8fa3b8, roughness: 0.85, metalness: 0.05 });
  // grid-visibility-fix: empty board cells used to be fully hidden
  // (cube.visible = false), which erased the 8x8 grid structure entirely
  // whenever a cell was unoccupied -- against the dark brick backdrop there
  // was nothing to read as "a board" at all. The reference image always
  // shows a dim placeholder tile per empty cell. Reuse the same dark tone
  // the 2D renderer's CSS custom property --empty-cell already uses
  // (index.html: #2a2d36 dark theme baseline) so the empty-slot look stays
  // visually consistent with the 2D renderer instead of inventing a new
  // color. Slightly lower roughness/higher metalness than placeholderMat so
  // it still catches a faint highlight from the key light and reads as a
  // recessed "socket," not just a flat gray square.
  const emptyCellMat = new THREE.MeshStandardMaterial({ color: 0x2a2d36, roughness: 0.9, metalness: 0.1 });
  // juice-effects-port: all 64 cube meshes live under one Group so the zoom
  // pulse (GDD 12.4, board scales 1.0->1.03->1.0) and the death-sequence
  // shake (GDD 12.8, 6px/300ms-decay) can be applied as a single group
  // transform without touching the backdrop/ledge/mascots, which shouldn't
  // participate in either effect.
  const boardGroup = new THREE.Group();
  scene.add(boardGroup);
  const cubes = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      // grid-visibility-fix: start on the dim empty-slot material instead of
      // placeholderMat, and stay VISIBLE — every cube renders from frame
      // one, occupied or not, so the 8x8 grid structure always reads even
      // before the first setBoardState() call lands.
      const cube = new THREE.Mesh(cubeGeo, emptyCellMat);
      // Row 0 is the top of the board on screen, so row increases downward
      // in board-space but Y increases upward in world-space — flip r here.
      const baseY = (BOARD_HALF - r) * CELL_STRIDE;
      cube.position.set((c - BOARD_HALF) * CELL_STRIDE, baseY, CUBE_HEIGHT / 2);
      cube.castShadow = true;
      cube.receiveShadow = true;
      boardGroup.add(cube);
      // baseY/baseMat/ownMaterial/baseColor are juice-effects-port additions:
      // baseY is the cube's resting Y (landing drop-in animates away from and
      // back to this); ownMaterial is a lazily-created per-cube clone of
      // whichever shared family material this cell currently uses, so idle
      // shimmer (GDD 12.6) and death desaturation (GDD 12.8) can vary the
      // clone's own .color per cube without mutating the shared family
      // material every other cube of that family also uses.
      cubes.push({ r, c, mesh: cube, family: null, baseY, baseMat: null, ownMaterial: null, baseColor: null });
    }
  }

  // ---- per-family NEON block materials (neon-blocks-pass, 2026-07-29) ----
  // Replaces texture-to-material-mapping's PNG-texture-per-family loader
  // entirely -- built synchronously, directly from FAMILY_BY_COLOR's own
  // 7 game-palette hex values (src/blockTextureConfig.js), boosted via
  // boostSaturation() for the vibrant-color-pass ask, then used as BOTH the
  // material's base color and its emissive glow so occupied cells actually
  // read as lit-from-within rather than merely brightly colored. `familyByName`
  // still keys by family name (not the raw hex) so setBoardState() below and
  // triggerShardArc()'s existing FAMILY_BY_COLOR lookup didn't need to change
  // shape -- only what a "family" material IS changed (neon color, not a
  // loaded texture).
  const familyMaterials = [];
  const familyByName = new Map();
  for (const [colorHex, familyName] of Object.entries(FAMILY_BY_COLOR)) {
    const neonColor = boostSaturation(colorHex);
    const mat = new THREE.MeshStandardMaterial({
      color: neonColor,
      emissive: neonColor,
      emissiveIntensity: NEON_EMISSIVE_INTENSITY,
      roughness: 0.35,
      metalness: 0.15,
    });
    const entry = { name: familyName, mat };
    familyMaterials.push(entry);
    familyByName.set(familyName, entry);
  }
  // Nothing here is ever network-dependent anymore, so this always resolves
  // true/false=failed immediately -- kept as a Promise (not a plain boolean)
  // purely so existing callers (threeBootstrap.js, Playwright tests) that
  // await materialsReadyPromise / read isMaterialsFailed() keep working
  // unchanged.
  let materialsFailed = false;
  const materialsReadyPromise = Promise.resolve(true);

  // ---- live board-state sync (gameplay-state-wiring) ---------------------
  // Reads src/core.js's board grid (rows of either null or {color}) the same
  // way the 2D renderer's draw() loop does (src/main.js: `state.board[r][c]`,
  // `cell.color` -> drawBlockCell(x, y, size, cell.color)) and mirrors it
  // onto the 64 cube meshes: occupied cell -> visible with the matching
  // family material (FAMILY_BY_COLOR, same mapping as the 2D renderer);
  // empty cell -> hidden. Cheap full 64-cube refresh per call (no diffing) —
  // adequate for an 8x8 grid, not a perf-critical size, per this workstream's
  // scope. Safe to call before materials finish loading: falls back to the
  // shared placeholderMat until familyByName has the real entry.
  let lastBoardState = null;
  function setBoardState(board) {
    lastBoardState = board;
    for (const entry of cubes) {
      const cell = board && board[entry.r] ? board[entry.r][entry.c] : null;
      if (cell == null) {
        // grid-visibility-fix: stay visible on the dim empty-slot material
        // rather than hiding the mesh, so the grid structure never
        // disappears. Also clean up any leftover per-cell material clone
        // from a previous occupied state (a cell can go occupied -> empty
        // via a line clear) so it doesn't leak.
        if (entry.ownMaterial) {
          entry.ownMaterial.dispose();
          entry.ownMaterial = null;
        }
        entry.baseMat = null;
        entry.baseColor = null;
        entry.mesh.material = emptyCellMat;
        entry.mesh.visible = true;
        entry.family = null;
        continue;
      }
      entry.mesh.visible = true;
      const familyName = FAMILY_BY_COLOR[cell.color] || null;
      const chosen = familyName ? familyByName.get(familyName) : null;
      const baseMat = chosen ? chosen.mat : placeholderMat;
      // juice-effects-port: only (re)clone when the underlying family
      // material actually changed for this cell (new placement, or a color
      // swap once materials finish loading) -- this function is called every
      // rAF frame by threeBootstrap's syncFromGameState(), so cloning
      // unconditionally here would allocate + leak a new Material every
      // frame for every occupied cell.
      if (entry.baseMat !== baseMat) {
        if (entry.ownMaterial) entry.ownMaterial.dispose();
        entry.baseMat = baseMat;
        entry.ownMaterial = baseMat.clone();
        entry.baseColor = entry.ownMaterial.color.clone();
        entry.mesh.material = entry.ownMaterial;
      }
      entry.family = chosen ? chosen.name : null;
    }
  }

  // ---- ledge/shelf placeholder (mascot-prop-placement) ------------------
  // Minimal box standing in for the reference image's ledge — sits just
  // below the board's bottom edge and steps slightly toward the camera so
  // mascots standing on it read as "in front of" the wall, not floating
  // inside it. Flat placeholder color matching the existing backdrop-stub
  // convention; real ledge/brick material is out of this workstream's scope.
  const ledgeGeo = new THREE.BoxGeometry(LEDGE_WIDTH, LEDGE_HEIGHT, LEDGE_DEPTH);
  const ledgeMat = new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.9, metalness: 0.02 });
  const ledge = new THREE.Mesh(ledgeGeo, ledgeMat);
  ledge.position.set(0, LEDGE_CENTER_Y, LEDGE_CENTER_Z);
  ledge.castShadow = true;
  ledge.receiveShadow = true;
  scene.add(ledge);

  // ---- juice-effects-port: gold flash overlay (GDD 12.3/12.4) -----------
  // A single translucent gold plane sitting just in front of the cube faces,
  // toggled/faded via triggerGoldFlash() below -- literal #F4C430 at up to
  // 25% alpha, same numbers as main.js's 2D board-wide fillRect flash, just
  // as a real mesh instead of a canvas fill.
  const goldFlashGeo = new THREE.PlaneGeometry(BOARD_SIZE * CELL_STRIDE, BOARD_SIZE * CELL_STRIDE);
  const goldFlashMat = new THREE.MeshBasicMaterial({
    color: GOLD_HEX,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const goldFlashMesh = new THREE.Mesh(goldFlashGeo, goldFlashMat);
  goldFlashMesh.position.z = CUBE_HEIGHT + 0.04; // in front of cube faces, behind the placement-preview layer (0.06)
  goldFlashMesh.visible = false;
  boardGroup.add(goldFlashMesh);

  // ---- juice-effects-port: shard chip geometry (GDD 12.2/7) -------------
  // Small chip mesh reused for every in-flight shard arc -- each arc gets its
  // own Mesh+Material instance (cheap, few concurrent arcs at a time) so
  // per-arc opacity/scale (the landing squash pulse) doesn't fight other
  // concurrently-flying arcs sharing one material.
  const SHARD_CHIP_WORLD = 16 * WORLD_UNITS_PER_PX; // matches 2D drawShardArcs' `size=16` chip footprint
  const shardChipGeo = new THREE.BoxGeometry(SHARD_CHIP_WORLD, SHARD_CHIP_WORLD, CUBE_HEIGHT * 0.3);

  // ---- input-raycasting (workstream: input-raycasting) ------------------
  // Pointer-driven drag/drop lives in src/threeBootstrap.js (DOM tray slots
  // are the drag *source*), but "where would this land on the board" is a
  // 3D-scene question -- raycast the pointer against the board's flat XY
  // plane (z=0, same plane every cube's face-center sits just in front of)
  // rather than mesh-picking the thin cube fronts, per the brief. A plane
  // intersection is robust regardless of z (cube thickness) or whether a
  // given cell is currently visible/occupied.
  const raycaster = new THREE.Raycaster();
  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  function pointerToBoardXY(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const point = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(boardPlane, point);
    return hit ? { x: point.x, y: point.y } : null;
  }

  // Inverts the same cell-center formula used to position cube meshes above
  // ((c - BOARD_HALF) * CELL_STRIDE, (BOARD_HALF - r) * CELL_STRIDE) to find
  // the shape's top-left anchor (r0, c0) given the WORLD-space point the
  // piece's own bounding-box center should sit at -- mirrors src/main.js's
  // dragTargetCell() px-space math, just in continuous world units instead
  // of canvas pixels (1 world unit == 1 board cell, by construction above).
  const BOARD_EDGE = BOARD_HALF + CELL_STRIDE / 2;
  function cellAnchorFromWorld(x, y, ext) {
    const c0 = Math.round(x + BOARD_EDGE - (ext.cols * CELL_STRIDE) / 2);
    const r0 = Math.round(BOARD_EDGE - y - (ext.rows * CELL_STRIDE) / 2);
    return { r: r0, c: c0 };
  }

  // Placement preview: a small pool of translucent boxes (reused across
  // drags, not allocated per-frame) sitting just in front of the cube faces.
  // Simple overlay-mesh approach per the brief's "your call on simplest
  // correct approach" -- avoids mutating the real per-family cube materials
  // (which would have to be restored exactly afterward, more bookkeeping for
  // no visual benefit over a dedicated highlight layer).
  const MAX_PREVIEW_CELLS = 9; // largest defined piece (SHAPES 'square3', pieces.js) has 9 cells
  const previewGeo = new THREE.BoxGeometry(CUBE_FOOTPRINT, CUBE_FOOTPRINT, CUBE_HEIGHT * 0.15);
  const previewMatValid = new THREE.MeshBasicMaterial({ color: 0x2ecc71, transparent: true, opacity: 0.55, depthWrite: false });
  const previewMatInvalid = new THREE.MeshBasicMaterial({ color: 0xe74c3c, transparent: true, opacity: 0.55, depthWrite: false });
  const previewMeshes = [];
  for (let i = 0; i < MAX_PREVIEW_CELLS; i++) {
    const mesh = new THREE.Mesh(previewGeo, previewMatValid);
    mesh.position.z = CUBE_HEIGHT + 0.06; // just in front of every cube face, always visible
    mesh.visible = false;
    scene.add(mesh);
    previewMeshes.push(mesh);
  }

  function setPlacementPreview(shapeCells, r0, c0, valid) {
    const mat = valid ? previewMatValid : previewMatInvalid;
    let i = 0;
    for (; i < shapeCells.length && i < previewMeshes.length; i++) {
      const [dr, dc] = shapeCells[i];
      const r = r0 + dr;
      const c = c0 + dc;
      const mesh = previewMeshes[i];
      mesh.material = mat;
      mesh.position.x = (c - BOARD_HALF) * CELL_STRIDE;
      mesh.position.y = (BOARD_HALF - r) * CELL_STRIDE;
      mesh.visible = true;
    }
    for (; i < previewMeshes.length; i++) previewMeshes[i].visible = false;
  }

  function clearPlacementPreview() {
    for (const mesh of previewMeshes) mesh.visible = false;
  }

  // ==== juice-effects-port (workstream: juice-effects-port) ================
  // Re-ports every GDD-12 effect src/main.js's 2D juice-pass built, as real
  // Three.js mesh transforms/material changes instead of canvas draws. Every
  // timing calculation below reads through the imported vnow() (main.js) --
  // the SAME pause-safe virtual clock the 2D effects use -- so pause/resume
  // freezes these too, for free, with no extra bookkeeping here. All of this
  // runs from render() below (called every rAF frame by threeBootstrap's
  // loop()), matching this scene's existing "poll every frame" convention
  // (gameplay-state-wiring's setBoardState) rather than adding a second,
  // separate ticker system.

  // ---- 12.1/12.2: landing drop-in + squash-and-settle --------------------
  const landingAnims = new Map(); // key `${r},${c}` -> { startedAt }
  function triggerLandingAnim(cells, r0, c0) {
    const now = vnow();
    for (const [dr, dc] of cells) landingAnims.set(`${r0 + dr},${r0 + dc}`, { startedAt: now });
  }
  function updateLandingAnims(now) {
    for (const entry of cubes) {
      const key = `${entry.r},${entry.c}`;
      const anim = landingAnims.get(key);
      if (!anim) {
        entry.mesh.position.y = entry.baseY;
        if (entry.mesh.scale.x !== 1 || entry.mesh.scale.y !== 1) entry.mesh.scale.set(1, 1, 1);
        continue;
      }
      const elapsed = now - anim.startedAt;
      if (elapsed > DROP_IN_MS + SQUASH_MS) {
        landingAnims.delete(key);
        entry.mesh.position.y = entry.baseY;
        entry.mesh.scale.set(1, 1, 1);
        continue;
      }
      if (elapsed < DROP_IN_MS) {
        const t = elapsed / DROP_IN_MS;
        const eased = 1 - (1 - t) * (1 - t); // ease-out, matches main.js landingTransformFor
        const offsetWorld = DROP_IN_PX * WORLD_UNITS_PER_PX * (1 - eased);
        entry.mesh.position.y = entry.baseY + offsetWorld; // starts above resting Y, eases down into place
        entry.mesh.scale.set(1, 1, 1);
      } else {
        const st = Math.min(1, (elapsed - DROP_IN_MS) / SQUASH_MS);
        const dip = Math.sin(st * Math.PI) * 0.06; // 1.0 -> 0.94 -> 1.0
        entry.mesh.position.y = entry.baseY;
        entry.mesh.scale.set(1 + dip * 0.5, 1 - dip, 1);
      }
    }
  }

  // ---- 12.2/7: shard arc from cleared line to its shard-queue slot -------
  // Source position is derived the same way main.js's performPlacement
  // computes it (average of each cleared row's board-center-X point and each
  // cleared col's board-center-Y point), just in world units with the board
  // centered on the origin instead of canvas px with layout.gridX/Y offsets.
  const shardArcs = []; // { mesh, fromX, fromY, toX, toY, startedAt, slowFactor }
  function shardArcSourceWorld(rows, cols) {
    const points = [];
    for (const r of rows) points.push({ x: 0, y: (BOARD_HALF - r) * CELL_STRIDE });
    for (const c of cols) points.push({ x: (c - BOARD_HALF) * CELL_STRIDE, y: 0 });
    if (!points.length) return { x: 0, y: 0 };
    return {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length,
    };
  }
  function triggerShardArc(rows, cols, colorHex, bigClear, targetsWorld) {
    if (!targetsWorld.length) return;
    const now = vnow();
    const from = shardArcSourceWorld(rows, cols);
    // GDD 12.4 time-dilation on a big clear -- same 1.8x stretch main.js uses.
    const slowFactor = bigClear ? 1.8 : 1;
    const familyName = FAMILY_BY_COLOR[colorHex] || null;
    const famEntry = familyName ? familyByName.get(familyName) : null;
    // neon-blocks-pass: family materials no longer carry a .map (PNG texture
    // retired) -- tint the chip with the family's own boosted neon color
    // (its MeshStandardMaterial.color) instead of the old "white base +
    // texture supplies the actual color" trick.
    for (const target of targetsWorld) {
      const mat = new THREE.MeshBasicMaterial({
        color: famEntry ? famEntry.mat.color : new THREE.Color(colorHex),
        transparent: true,
      });
      const mesh = new THREE.Mesh(shardChipGeo, mat);
      mesh.position.set(from.x, from.y, CUBE_HEIGHT + 0.08);
      scene.add(mesh);
      shardArcs.push({ mesh, fromX: from.x, fromY: from.y, toX: target.x, toY: target.y, startedAt: now, slowFactor });
    }
  }
  function updateShardArcs(now) {
    for (let i = shardArcs.length - 1; i >= 0; i--) {
      const a = shardArcs[i];
      const arcDur = SHARD_ARC_MS * a.slowFactor;
      const totalDur = arcDur + SHARD_LAND_SQUASH_MS * a.slowFactor;
      const elapsed = now - a.startedAt;
      if (elapsed >= totalDur) {
        scene.remove(a.mesh);
        a.mesh.material.dispose(); // never disposes .map -- that's the shared family texture
        shardArcs.splice(i, 1);
        continue;
      }
      if (elapsed < arcDur) {
        const t = elapsed / arcDur;
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out, matches main.js drawShardArcs
        const x = a.fromX + (a.toX - a.fromX) * eased;
        const y = a.fromY + (a.toY - a.fromY) * eased;
        const arcHeightWorld = 26 * WORLD_UNITS_PER_PX; // matches main.js's arcHeight=26px
        const yArc = y + Math.sin(eased * Math.PI) * arcHeightWorld; // +Y is "up" in this world, so the arc peak adds +Y
        a.mesh.position.set(x, yArc, CUBE_HEIGHT + 0.08);
        a.mesh.scale.set(1, 1, 1);
        a.mesh.material.opacity = 1;
      } else {
        const st = Math.min(1, (elapsed - arcDur) / (SHARD_LAND_SQUASH_MS * a.slowFactor));
        const scale = 1 + Math.sin(st * Math.PI) * 0.35; // landing squash pulse
        a.mesh.position.set(a.toX, a.toY, CUBE_HEIGHT + 0.08);
        a.mesh.scale.set(scale, scale, 1);
        a.mesh.material.opacity = Math.max(0, 1 - st);
      }
    }
  }

  // ---- break-effect-pass (2026-07-29): shatter burst on line clear ------
  // triggerShardArc above already flies one chip PER SHARD-QUEUE-SLOT from
  // the cleared line toward the queue -- but that's a queue-bound projectile,
  // not a "this cube just broke" moment at the cell itself. This adds a
  // separate, purely-cosmetic burst per CLEARED CELL (not per queue target):
  // a quick bright flash quad over the cell plus a handful of small chip
  // fragments that scatter outward and shrink/fade, both driven by the same
  // vnow()-based pause-safe timing every other juice effect here uses. Reuses
  // shardChipGeo (already declared above) for the fragments instead of a new
  // geometry -- cheap, and visually consistent with the shard-arc chips.
  const BREAK_FLASH_MS = 140;
  const BREAK_FRAGMENT_MS = 260;
  const BREAK_FRAGMENTS_PER_CELL = 5;
  const BREAK_FRAGMENT_SPEED_MIN = 1.1; // world units/sec
  const BREAK_FRAGMENT_SPEED_MAX = 2.2;
  const breakFlashGeo = new THREE.PlaneGeometry(CUBE_FOOTPRINT, CUBE_FOOTPRINT);
  const breakFlashes = []; // { mesh, startedAt }
  const breakFragments = []; // { mesh, startedAt, vx, vy }
  function triggerBreakEffect(rows, cols, colorHex) {
    const now = vnow();
    const familyName = FAMILY_BY_COLOR[colorHex] || null;
    const famEntry = familyName ? familyByName.get(familyName) : null;
    const color = famEntry ? famEntry.mat.color : new THREE.Color(colorHex);
    // Union of every cell in the cleared rows/cols (a row contributes all 8
    // columns, a col contributes all 8 rows; intersections deduped) -- same
    // "which cells actually cleared" set the 2D renderer's own line-clear
    // sweep would touch, just derived here instead of threaded through the
    // hook payload as a third parallel list.
    const seen = new Set();
    const cellsList = [];
    const addCell = (r, c) => {
      const key = `${r},${c}`;
      if (seen.has(key)) return;
      seen.add(key);
      cellsList.push([r, c]);
    };
    for (const r of rows) for (let c = 0; c < BOARD_SIZE; c++) addCell(r, c);
    for (const c of cols) for (let r = 0; r < BOARD_SIZE; r++) addCell(r, c);
    for (const [r, c] of cellsList) {
      const cx = (c - BOARD_HALF) * CELL_STRIDE;
      const cy = (BOARD_HALF - r) * CELL_STRIDE;
      const flashMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false });
      const flashMesh = new THREE.Mesh(breakFlashGeo, flashMat);
      flashMesh.position.set(cx, cy, CUBE_HEIGHT + 0.1);
      scene.add(flashMesh);
      breakFlashes.push({ mesh: flashMesh, startedAt: now });
      for (let i = 0; i < BREAK_FRAGMENTS_PER_CELL; i++) {
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
        const mesh = new THREE.Mesh(shardChipGeo, mat);
        mesh.position.set(cx, cy, CUBE_HEIGHT + 0.06);
        scene.add(mesh);
        const angle = Math.random() * Math.PI * 2;
        const speed = BREAK_FRAGMENT_SPEED_MIN + Math.random() * (BREAK_FRAGMENT_SPEED_MAX - BREAK_FRAGMENT_SPEED_MIN);
        breakFragments.push({
          mesh,
          startedAt: now,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
        });
      }
    }
  }
  function updateBreakEffect(now) {
    for (let i = breakFlashes.length - 1; i >= 0; i--) {
      const f = breakFlashes[i];
      const elapsed = now - f.startedAt;
      if (elapsed >= BREAK_FLASH_MS) {
        scene.remove(f.mesh);
        f.mesh.material.dispose();
        breakFlashes.splice(i, 1);
        continue;
      }
      const t = elapsed / BREAK_FLASH_MS;
      const scale = 1 + t * 0.5; // quick outward pop
      f.mesh.scale.set(scale, scale, 1);
      f.mesh.material.opacity = 0.95 * (1 - t);
    }
    for (let i = breakFragments.length - 1; i >= 0; i--) {
      const a = breakFragments[i];
      const elapsed = now - a.startedAt;
      if (elapsed >= BREAK_FRAGMENT_MS) {
        scene.remove(a.mesh);
        a.mesh.material.dispose();
        breakFragments.splice(i, 1);
        continue;
      }
      const t = elapsed / BREAK_FRAGMENT_MS;
      const dtSec = elapsed / 1000;
      // Position is recomputed from a cached origin + velocity*elapsed each
      // frame (not integrated incrementally) so it stays exact regardless of
      // frame timing jitter -- origin is cached on first update since the
      // fragment's spawn position (set in triggerBreakEffect) is itself the
      // origin, just not stored under this name yet.
      const originX = a.mesh.userData.originX ?? (a.mesh.userData.originX = a.mesh.position.x);
      const originY = a.mesh.userData.originY ?? (a.mesh.userData.originY = a.mesh.position.y);
      a.mesh.position.x = originX + a.vx * dtSec;
      a.mesh.position.y = originY + a.vy * dtSec;
      const scale = Math.max(0.05, 1 - t);
      a.mesh.scale.set(scale, scale, 1);
      a.mesh.material.opacity = 1 - t;
    }
  }

  // ---- 12.3/12.4: gold flash + zoom pulse --------------------------------
  let goldFlash = null; // { startedAt, duration }
  function triggerGoldFlash(duration = GOLD_FLASH_MS) {
    goldFlash = { startedAt: vnow(), duration };
  }
  function updateGoldFlash(now) {
    if (!goldFlash) {
      if (goldFlashMesh.visible) goldFlashMesh.visible = false;
      return;
    }
    const life = 1 - (now - goldFlash.startedAt) / goldFlash.duration;
    if (life <= 0) {
      goldFlash = null;
      goldFlashMesh.visible = false;
      return;
    }
    goldFlashMesh.visible = true;
    goldFlashMesh.material.opacity = Math.max(0, Math.min(1, life)) * 0.25; // matches main.js's 25% max alpha
  }

  let zoomPulse = null; // { startedAt }
  function triggerZoomPulse() {
    zoomPulse = { startedAt: vnow() };
  }

  // ---- 12.8: death sequence (desaturate -> shake -> freeze-frame) --------
  let deathSeq = null; // { startedAt }
  function triggerDeathSequence() {
    deathSeq = { startedAt: vnow() };
  }
  function deathDesaturateAmount(now) {
    if (!deathSeq) return 0;
    return Math.max(0, Math.min(1, (now - deathSeq.startedAt) / DEATH_DESATURATE_MS));
  }
  function isDeathFreezeActive(now) {
    if (!deathSeq) return false;
    const elapsed = now - deathSeq.startedAt;
    const freezeStart = DEATH_DESATURATE_MS + DEATH_SHAKE_MS;
    const freezeEnd = freezeStart + DEATH_FREEZE_MS;
    if (elapsed >= freezeEnd) {
      // Sequence fully complete -- reset, same as main.js's own
      // `deathSeq = null` once its ticker finishes (deathDesaturateAmount
      // reverts to 0 automatically from here on, matching the 2D behavior of
      // the board reverting right as the Game Over overlay fades in on top).
      deathSeq = null;
      return false;
    }
    return elapsed >= freezeStart && elapsed < freezeEnd;
  }

  // Combined per-frame update for zoom scale + death-sequence board-group
  // shake -- both are board-group-level transforms, applied together so one
  // function owns boardGroup.scale/position each frame.
  function updateZoomAndShake(now) {
    let zoomScale = 1;
    if (zoomPulse) {
      const t = (now - zoomPulse.startedAt) / ZOOM_PULSE_MS;
      if (t >= 1) {
        zoomPulse = null;
      } else {
        zoomScale = 1 + Math.sin(t * Math.PI) * 0.03; // 1.0 -> 1.03 -> 1.0
      }
    }
    boardGroup.scale.set(zoomScale, zoomScale, 1);

    let sx = 0, sy = 0;
    if (deathSeq) {
      const elapsed = now - deathSeq.startedAt;
      if (elapsed >= DEATH_DESATURATE_MS && elapsed < DEATH_DESATURATE_MS + DEATH_SHAKE_MS) {
        const t = (elapsed - DEATH_DESATURATE_MS) / DEATH_SHAKE_MS;
        const falloff = 1 - t; // linear decay, matches main.js's currentShakeOffset
        const magnitude = DEATH_SHAKE_PX * WORLD_UNITS_PER_PX * falloff;
        const angle = Math.random() * Math.PI * 2;
        sx = Math.cos(angle) * magnitude;
        sy = Math.sin(angle) * magnitude;
      }
    }
    boardGroup.position.set(sx, sy, 0);
  }

  // ---- 12.6: idle shimmer, and the death-desaturate wash, both per-cube --
  // Applied to each cube's own material clone's .color (see setBoardState's
  // ownMaterial cloning above) so every placed cube shimmers on its own
  // phase-offset sine wave, exactly like main.js's per-cell shimmerAlphaFor.
  const scratchColor = new THREE.Color();
  function updateCubeVisuals(now) {
    const desat = deathDesaturateAmount(now);
    for (const entry of cubes) {
      if (!entry.mesh.visible || !entry.ownMaterial || !entry.baseColor) continue;
      const phase = (entry.r * 7 + entry.c * 13) % 1000; // per-cell phase offset, matches main.js shimmerAlphaFor
      const t = ((now + phase) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
      const shimmer = Math.sin(t * Math.PI * 2) * 0.02; // +-2% brightness
      scratchColor.copy(entry.baseColor).multiplyScalar(1 + shimmer);
      if (desat > 0) {
        const gray = scratchColor.r * 0.299 + scratchColor.g * 0.587 + scratchColor.b * 0.114;
        scratchColor.lerp(new THREE.Color(gray, gray, gray), desat);
      }
      entry.ownMaterial.color.copy(scratchColor);
    }
  }

  // getCellSizePx (threeBootstrap-DOM-drag-preview-sizing addition,
  // 2026-07-29): last CSS-pixel width/height resize() was called with, kept
  // so getCellSizePx() can recompute after every resize without needing its
  // own args threaded through. resize() is always called with CSS pixels
  // (see threeBootstrap.js's handle.resize(width, height) call site), same
  // units renderer.domElement's on-screen box is measured in.
  let lastResizeHeightPx = null;
  function resize(width, height) {
    // scene-layout-cleanup: asymmetric top/bottom (FRUSTUM_TOP_WORLD /
    // FRUSTUM_BOTTOM_WORLD, computed near the top of this file) replace the
    // old single symmetric halfExtent -- see that block's comment for why.
    // Horizontal half-extent is derived from the SAME total vertical world
    // span (not an independent value) so world-units-per-pixel stays equal
    // on both axes regardless of container aspect -- an asymmetric top/
    // bottom paired with an unrelated left/right span would otherwise
    // squash or stretch every cube non-uniformly.
    const aspect = width / Math.max(1, height);
    const halfHorizontal = (TOTAL_WORLD_HEIGHT * aspect) / 2;
    camera.left = -halfHorizontal;
    camera.right = halfHorizontal;
    camera.top = FRUSTUM_TOP_WORLD;
    camera.bottom = FRUSTUM_BOTTOM_WORLD;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    composer.setPixelRatio(pixelRatio);
    bloomPass.setSize(width, height);
    lastResizeHeightPx = height;
  }

  // getCellSizePx(): current on-screen pixel size of one board grid cell
  // (square, per CELL_STRIDE's world-units-per-cell == 1 construction and
  // resize()'s equal-world-units-per-pixel-on-both-axes guarantee -- see
  // that function's own comment). Projects CELL_STRIDE world units through
  // the orthographic camera's current (camera.top - camera.bottom) world
  // span divided by the last CSS-pixel height resize() saw, i.e. world-
  // units-per-pixel, inverted. Stays accurate across resize() calls since
  // it re-reads both the camera's live frustum and lastResizeHeightPx every
  // call rather than caching a px value. Added for threeBootstrap.js's DOM
  // floating drag-preview piece, which previously hardcoded a 72px/24px-
  // per-cell box that no longer matches the real board once BOARD_FRAC
  // made the stage scale responsively.
  function getCellSizePx() {
    if (!lastResizeHeightPx) return 0;
    const worldSpan = camera.top - camera.bottom;
    const worldUnitsPerPx = worldSpan / lastResizeHeightPx;
    return CELL_STRIDE / worldUnitsPerPx;
  }

  function render() {
    // juice-effects-port: advance every vnow()-keyed effect once per frame,
    // BEFORE the actual GPU render call -- this is what makes pause/resume
    // freeze all of it: while main.js's isPaused is true, vnow() is pinned,
    // so every one of these updates computes the exact same values every
    // frame and nothing visibly advances.
    const now = vnow();
    updateLandingAnims(now);
    updateShardArcs(now);
    updateBreakEffect(now);
    updateGoldFlash(now);
    updateZoomAndShake(now);
    updateCubeVisuals(now);
    updateSideParticles(now);
    if (isDeathFreezeActive(now)) return; // GDD 12.8 freeze-frame: skip this render call entirely, same as main.js's draw()-skip
    // neon-blocks-pass: composer.render() (RenderPass+UnrealBloomPass+
    // OutputPass) replaces the old direct renderer.render(scene, camera).
    composer.render();
  }

  function dispose() {
    backdropThemeObserver.disconnect();
    scene.remove(sideParticles);
    sideParticleGeo.dispose();
    sideParticleMat.dispose();
    sideParticleTexture.dispose();
    cubeGeo.dispose();
    placeholderMat.dispose();
    emptyCellMat.dispose();
    familyMaterials.forEach(({ mat }) => {
      if (mat.map) mat.map.dispose();
      mat.dispose();
    });
    for (const entry of cubes) {
      if (entry.ownMaterial) entry.ownMaterial.dispose();
    }
    for (const a of shardArcs) {
      scene.remove(a.mesh);
      a.mesh.material.dispose();
    }
    for (const f of breakFlashes) {
      scene.remove(f.mesh);
      f.mesh.material.dispose();
    }
    for (const a of breakFragments) {
      scene.remove(a.mesh);
      a.mesh.material.dispose();
    }
    breakFlashGeo.dispose();
    shardChipGeo.dispose();
    goldFlashGeo.dispose();
    goldFlashMat.dispose();
    if (backdropMat.map) backdropMat.map.dispose();
    backdropGeo.dispose();
    backdropMat.dispose();
    ledgeGeo.dispose();
    ledgeMat.dispose();
    previewGeo.dispose();
    previewMatValid.dispose();
    previewMatInvalid.dispose();
    composer.dispose();
    bloomPass.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  return {
    scene,
    camera,
    renderer,
    cubes,
    ground,
    ledge,
    keyLight,
    fillLight,
    hemi,
    resize,
    render,
    dispose,
    setBoardState,
    // threeBootstrap-DOM-drag-preview-sizing addition:
    getCellSizePx,
    // input-raycasting additions:
    pointerToBoardXY,
    cellAnchorFromWorld,
    setPlacementPreview,
    clearPlacementPreview,
    previewMeshes,
    boardHalf: BOARD_HALF,
    materialsReadyPromise,
    backdropTextureLoaded,
    isMaterialsFailed: () => materialsFailed,
    isBackdropTextureFailed: () => backdropTextureFailed,
    // juice-effects-port additions:
    boardGroup,
    triggerLandingAnim,
    triggerShardArc,
    triggerGoldFlash,
    triggerZoomPulse,
    triggerDeathSequence,
    // break-effect-pass addition:
    triggerBreakEffect,
    sideParticles,
    // verification-only getters (window.__threeDebug wires these up):
    landingAnimCount: () => landingAnims.size,
    shardArcCount: () => shardArcs.length,
    breakFragmentCount: () => breakFragments.length,
    isBreakEffectActive: () => breakFragments.length > 0 || breakFlashes.length > 0,
    isGoldFlashActive: () => !!goldFlash,
    isZoomPulseActive: () => !!zoomPulse,
    isDeathSequenceActive: () => !!deathSeq,
    boardGroupScale: () => boardGroup.scale.x,
    boardGroupPosition: () => ({ x: boardGroup.position.x, y: boardGroup.position.y }),
    cubeColor: (r, c) => {
      const entry = cubes.find((e) => e.r === r && e.c === c);
      return entry && entry.ownMaterial ? entry.ownMaterial.color.getHexString() : null;
    },
  };
}
