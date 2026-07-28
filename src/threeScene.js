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

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BOARD_SIZE } from './pieces.js';
import { BLOCK_MAP_PATH } from './blockTextureConfig.js';

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
const MASCOTS = [
  { url: new URL('../assets/mascots/Chicken.gltf', import.meta.url).href, targetHeight: 0.85, x: -(LEDGE_WIDTH / 2 - 1.1) },
  { url: new URL('../assets/mascots/Zombie.gltf', import.meta.url).href, targetHeight: 1.35, x: (LEDGE_WIDTH / 2 - 1.1) },
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
  const cubes = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cube = new THREE.Mesh(cubeGeo, placeholderMat);
      // Row 0 is the top of the board on screen, so row increases downward
      // in board-space but Y increases upward in world-space — flip r here.
      cube.position.set((c - BOARD_HALF) * CELL_STRIDE, (BOARD_HALF - r) * CELL_STRIDE, CUBE_HEIGHT / 2);
      cube.castShadow = true;
      cube.receiveShadow = true;
      scene.add(cube);
      cubes.push({ r, c, mesh: cube, family: null });
    }
  }

  // ---- per-family block materials (texture-to-material-mapping) ---------
  // Reuses the SAME assets/blocks/block-map.json + assets/blocks/*.png the
  // 2D renderer's loadBlockTextures() already established as the single
  // source of truth for block art (GDD 4A: "reuse assets/blocks/*.png
  // as-is"). This scene isn't wired to live gameplay state yet (that's
  // ui-overlay-integration's job), so there's no real per-cell color to
  // read — cubes are assigned one family each, cycling deterministically by
  // (r + c), purely so all 7 families are demonstrably rendering as real,
  // distinct textures rather than one placeholder color repeated 64 times.
  const familyMaterials = [];
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
                familyMaterials.push({ name, mat: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.05 }) });
                resolve(true);
              },
              undefined,
              () => {
                // Per-family fallback: flat fill using the family's own hex
                // (still distinct per family, closer to render-swap's own
                // per-color flat fallback than falling all the way back to
                // one shared placeholder color would be).
                familyMaterials.push({
                  name,
                  mat: new THREE.MeshStandardMaterial({ color: new THREE.Color(family.hex), roughness: 0.85, metalness: 0.05 }),
                });
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
    cubes.forEach((entry, i) => {
      const chosen = familyMaterials[(entry.r + entry.c) % familyMaterials.length];
      entry.mesh.material = chosen.mat;
      entry.family = chosen.name;
    });
    return true;
  })();

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
    renderer.render(scene, camera);
  }

  function dispose() {
    cubeGeo.dispose();
    placeholderMat.dispose();
    familyMaterials.forEach(({ mat }) => {
      if (mat.map) mat.map.dispose();
      mat.dispose();
    });
    if (backdropMat.map) backdropMat.map.dispose();
    backdropGeo.dispose();
    backdropMat.dispose();
    ledgeGeo.dispose();
    ledgeMat.dispose();
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
    materialsReadyPromise,
    backdropTextureLoaded,
    isMaterialsFailed: () => materialsFailed,
    isBackdropTextureFailed: () => backdropTextureFailed,
  };
}
