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
import { GLTFLoader } from 'https://unpkg.com/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';
import { BOARD_SIZE } from './pieces.js';
import { BLOCK_MAP_PATH, FAMILY_BY_COLOR } from './blockTextureConfig.js';
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
const CUBE_HEIGHT = 0.4; // chunky "voxel" look; not GDD-specified, first-pass value
const BOARD_HALF = (BOARD_SIZE - 1) / 2;

// Fixed FRONT-ON camera position (GDD 4A, corrected 2026-07-28: classic-
// Tetris "wall" framing, board is a vertical XY plane, camera looks straight
// down -Z at it — no elevation/tilt, no orbit/user controls). Distance is
// derived from board size so the whole 8x8 grid frames comfortably
// regardless of exact px constants above.
const CAMERA_DISTANCE = BOARD_SIZE * 1.35;
const FRUSTUM_MARGIN = 1.25; // extra headroom so the board doesn't clip frustum edges
const BACKDROP_DEPTH = BOARD_SIZE * 0.75; // how far behind the board plane the backdrop wall sits

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

// ---- mascot-prop-placement (workstream: mascot-prop-placement) ------------
// Per progress.md's threejs-scene-camera-setup rework notes: the reference
// composition puts standing mascot props on a ledge/shelf BELOW the board
// wall, not flanking its floor-level sides (that was the original, now-
// superseded GDD 4A wording). There is no ledge geometry yet anywhere in the
// scene, so this workstream adds a minimal placeholder ledge/shelf mesh
// alongside the props. texture-to-material-mapping (a separate, parallel
// workstream) owns the backdrop's actual brick material — this ledge is a
// flat placeholder color, same convention as the existing backdrop stub.
const BOARD_BOTTOM_EDGE = -BOARD_HALF - CUBE_FOOTPRINT / 2; // y of the board's lowest cube edge
const LEDGE_HEIGHT = 0.3;
const LEDGE_DEPTH = 1.2;
const LEDGE_GAP = 0.05; // small visual gap between the board's bottom edge and the ledge top
const LEDGE_TOP_Y = BOARD_BOTTOM_EDGE - LEDGE_GAP;
const LEDGE_CENTER_Y = LEDGE_TOP_Y - LEDGE_HEIGHT / 2;
const LEDGE_CENTER_Z = CUBE_HEIGHT / 2 + LEDGE_DEPTH / 2 - 0.1; // steps slightly toward the camera from the board plane
const LEDGE_WIDTH = BOARD_SIZE + 1.5; // a bit wider than the board so flanking props have room

// ---- texture-to-material-mapping constants -------------------------------
// Backdrop brick texture: cropped 16x16 tile from the Quaternius Cube World
// pack's Blocks_PixelArt.png (Downloads/Cube World - Aug 2023/), copied into
// assets/blocks/ so the game doesn't depend on the user's Downloads folder at
// runtime (same self-contained-assets convention as MASCOTS above). Repeated
// via texture.repeat, not a single stretched image, so it reads as an actual
// brick wall rather than one giant smeared brick.
const BRICK_TEXTURE_PATH = new URL('../assets/blocks/brick_wall_quaternius.png', import.meta.url).href;
const BRICK_TILE_WORLD_SIZE = 0.5; // world units per brick tile repeat — an aesthetic choice, not derived from any GDD px spec
const BACKDROP_SIZE = BOARD_SIZE * 3; // matches backdropGeo's PlaneGeometry dimensions below

// Mascot glTF assets (real Quaternius CC0 static meshes, per GDD 4A's
// locked static/non-rigged decision) — self-contained single-file glTF
// (base64-embedded buffers/images), copied from the audited source pack
// into assets/mascots/ so the game doesn't depend on the user's Downloads
// folder at runtime.
//
// mascot-swap (2026-07-28): replaced the original Chicken/Zombie pair with
// a girl, boy, dog, and cat to match the "Block Blast!"-style reference
// (humanoid mascots + a dog/cat), superseding mascot-prop-placement's
// original "no literal creeper mesh exists" workaround entirely — Zombie is
// no longer used at all. Source: Characters/glTF/Character_Female_1.gltf,
// Characters/glTF/Character_Male_1.gltf, Animals/glTF/Dog.gltf,
// Animals/glTF/Cat.gltf from the same audited Quaternius pack, all
// confirmed self-contained (no external .bin/texture references) before
// copying.
//
// LEDGE_MARGIN keeps the same "how far from the ledge's ends" convention
// the original 2-prop layout used (1.1 world units in from each edge);
// four props are now spread evenly across the space between those margins
// instead of just the two flanking ends.
const LEDGE_MARGIN = 1.1;
const LEDGE_USABLE_HALF = LEDGE_WIDTH / 2 - LEDGE_MARGIN;
function ledgeSlotX(index, count) {
  if (count === 1) return 0;
  const t = index / (count - 1); // 0..1 across the usable ledge span
  return -LEDGE_USABLE_HALF + t * (2 * LEDGE_USABLE_HALF);
}
const MASCOTS = [
  { url: new URL('../assets/mascots/Character_Female_1.gltf', import.meta.url).href, targetHeight: 1.3, x: ledgeSlotX(0, 4) },
  { url: new URL('../assets/mascots/Character_Male_1.gltf', import.meta.url).href, targetHeight: 1.35, x: ledgeSlotX(1, 4) },
  { url: new URL('../assets/mascots/Dog.gltf', import.meta.url).href, targetHeight: 0.55, x: ledgeSlotX(2, 4) },
  { url: new URL('../assets/mascots/Cat.gltf', import.meta.url).href, targetHeight: 0.4, x: ledgeSlotX(3, 4) },
];

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

  // ---- lighting: replaces the retired Canvas 2D bevel trick -------------
  // GDD 4A: real directional + hemisphere lighting is the depth cue now,
  // not a bolt-on. Source block textures were confirmed flat/unbevelled, so
  // there's nothing baked-in for this lighting to fight.
  const hemi = new THREE.HemisphereLight(0x9fb8d9, 0x3a2f26, 0.55);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xfff2d9, 1.1);
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

  // ---- backdrop wall (GDD 4A, corrected 2026-07-28: front-on framing has
  // no floor visible — replaces the old ground/table stub plane with a flat
  // backdrop wall behind the board plane, facing the camera). Flat
  // #101114 fill is the fallback/first-paint state; texture-to-material-
  // mapping swaps it for a tiled brick texture once loaded (matches the
  // "flat color first, texture appears once ready" pattern the 2D
  // render-swap workstream established for block cells) -----------------
  const backdropGeo = new THREE.PlaneGeometry(BACKDROP_SIZE, BACKDROP_SIZE);
  const backdropMat = new THREE.MeshStandardMaterial({ color: 0x101114 }); // GDD sec 4 gutter-shadow color, stub/fallback
  const ground = new THREE.Mesh(backdropGeo, backdropMat);
  // Upright, facing +Z (toward the camera), sitting behind the board plane.
  ground.position.z = -BACKDROP_DEPTH;
  ground.receiveShadow = true;
  scene.add(ground);

  const textureLoader = new THREE.TextureLoader();
  let backdropTextureFailed = false;
  const backdropTextureLoaded = new Promise((resolve) => {
    textureLoader.load(
      BRICK_TEXTURE_PATH,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.NearestFilter; // pixel-art tile, keep it crisp instead of blurred
        const repeats = BACKDROP_SIZE / BRICK_TILE_WORLD_SIZE;
        tex.repeat.set(repeats, repeats);
        backdropMat.map = tex;
        backdropMat.color.set(0xffffff); // let the texture supply color; tint would otherwise darken it
        backdropMat.needsUpdate = true;
        resolve(true);
      },
      undefined,
      () => {
        // Fallback: leave backdropMat's flat #101114 fill in place (already
        // applied above) — same "stays playable, just untextured" contract
        // render-swap established for the 2D board-cell fallback.
        backdropTextureFailed = true;
        resolve(false);
      }
    );
  });

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
      const cube = new THREE.Mesh(cubeGeo, placeholderMat);
      // Row 0 is the top of the board on screen, so row increases downward
      // in board-space but Y increases upward in world-space — flip r here.
      const baseY = (BOARD_HALF - r) * CELL_STRIDE;
      cube.position.set((c - BOARD_HALF) * CELL_STRIDE, baseY, CUBE_HEIGHT / 2);
      cube.castShadow = true;
      cube.receiveShadow = true;
      // Hidden until the first real board-state sync (gameplay-state-wiring)
      // assigns real occupied/empty state — an unoccupied board cell has no
      // family to show, so cubes start invisible rather than a flat demo
      // color, per the "empty cell -> hidden/dim" fallback contract this
      // workstream's brief calls for.
      cube.visible = false;
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

  // ---- per-family block materials (texture-to-material-mapping, extended
  // by gameplay-state-wiring) ------------------------------------------------
  // Reuses the SAME assets/blocks/block-map.json + assets/blocks/*.png the
  // 2D renderer's loadBlockTextures() already established as the single
  // source of truth for block art (GDD 4A: "reuse assets/blocks/*.png
  // as-is"), and the SAME FAMILY_BY_COLOR color->family mapping the 2D
  // renderer uses (src/blockTextureConfig.js) — not a re-derived/duplicated
  // mapping. `familyByName` lets setBoardState() below look up the right
  // material for whatever color a real occupied board cell holds, once
  // materials finish loading (each family's own load resolves to either a
  // real texture or a flat per-family hex fallback, same "stays playable
  // either way" contract as the 2D renderer's drawBlockCell()).
  const familyMaterials = [];
  const familyByName = new Map();
  let materialsFailed = false;
  const materialsReadyPromise = (async () => {
    let mapData;
    try {
      const res = await fetch(BLOCK_MAP_PATH);
      if (!res.ok) throw new Error('block-map fetch failed: ' + res.status);
      mapData = await res.json();
    } catch (err) {
      materialsFailed = true;
      return false; // leave every cube on placeholderMat — same fallback contract as 2D
    }
    const familyNames = Object.keys(mapData.families);
    await Promise.all(
      familyNames.map(
        (name) =>
          new Promise((resolve) => {
            const family = mapData.families[name];
            textureLoader.load(
              family.individualPath,
              (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.magFilter = THREE.NearestFilter; // pixel-art source, keep crisp
                tex.generateMipmaps = false;
                tex.minFilter = THREE.LinearFilter;
                const entry = { name, mat: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.05 }) };
                familyMaterials.push(entry);
                familyByName.set(name, entry);
                resolve(true);
              },
              undefined,
              () => {
                // Per-family fallback: flat fill using the family's own hex
                // (still distinct per family, closer to render-swap's own
                // per-color flat fallback than falling all the way back to
                // one shared placeholder color would be).
                const entry = {
                  name,
                  mat: new THREE.MeshStandardMaterial({ color: new THREE.Color(family.hex), roughness: 0.85, metalness: 0.05 }),
                };
                familyMaterials.push(entry);
                familyByName.set(name, entry);
                resolve(false);
              }
            );
          })
      )
    );
    if (familyMaterials.length === 0) {
      materialsFailed = true;
      return false;
    }
    // No demo assignment anymore (gameplay-state-wiring) — cubes stay hidden
    // until setBoardState() below is driven by the caller's render loop with
    // real board state. If setBoardState() already ran once before materials
    // finished loading (board had cells occupied on first sync, materials
    // still async), re-apply it now so those cells pick up their real
    // family instead of staying on the flat placeholder forever.
    if (lastBoardState) setBoardState(lastBoardState);
    return true;
  })();

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
        entry.mesh.visible = false;
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

  // ---- mascot props (static/non-rigged Quaternius glTF, GDD 4A) ---------
  // Loaded async (GLTFLoader.loadAsync); each model's own bounding box is
  // used to normalize scale to a target on-screen height (source pack
  // meshes aren't authored to a shared scale) and to plant its feet exactly
  // on the ledge's top surface, rather than guessing a fixed scale/offset
  // per file.
  const gltfLoader = new GLTFLoader();
  const mascots = [];
  const mascotsLoaded = Promise.all(
    MASCOTS.map((cfg) =>
      gltfLoader.loadAsync(cfg.url).then((gltf) => {
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const scale = size.y > 0 ? cfg.targetHeight / size.y : 1;
        root.scale.setScalar(scale);

        // Re-measure after scaling to plant feet on the ledge precisely
        // (bounding box min.y is the model's lowest point post-scale).
        const scaledBox = new THREE.Box3().setFromObject(root);
        const feetY = scaledBox.min.y;
        const centerZOffset = (scaledBox.max.z + scaledBox.min.z) / 2;
        root.position.set(cfg.x, LEDGE_TOP_Y - feetY, LEDGE_CENTER_Z + LEDGE_DEPTH / 2 - 0.15 - centerZOffset);
        root.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });
        scene.add(root);
        const entry = { name: cfg.url.split('/').pop().replace('.gltf', ''), root };
        mascots.push(entry);
        return entry;
      })
    )
  );

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
    for (const target of targetsWorld) {
      const mat = new THREE.MeshBasicMaterial({
        color: famEntry ? 0xffffff : new THREE.Color(colorHex),
        map: famEntry ? famEntry.mat.map : null,
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

  function resize(width, height) {
    const aspect = width / Math.max(1, height);
    const halfExtent = (BOARD_SIZE / 2 + 0.5) * FRUSTUM_MARGIN;
    camera.left = -halfExtent * aspect;
    camera.right = halfExtent * aspect;
    camera.top = halfExtent;
    camera.bottom = -halfExtent;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
    updateGoldFlash(now);
    updateZoomAndShake(now);
    updateCubeVisuals(now);
    if (isDeathFreezeActive(now)) return; // GDD 12.8 freeze-frame: skip this render call entirely, same as main.js's draw()-skip
    renderer.render(scene, camera);
  }

  function dispose() {
    cubeGeo.dispose();
    placeholderMat.dispose();
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
    mascots,
    mascotsLoaded,
    keyLight,
    hemi,
    resize,
    render,
    dispose,
    setBoardState,
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
    // verification-only getters (window.__threeDebug wires these up):
    landingAnimCount: () => landingAnims.size,
    shardArcCount: () => shardArcs.length,
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
