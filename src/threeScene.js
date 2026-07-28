// Cube Blast — Three.js scene/camera/lighting infrastructure (workstream:
// threejs-scene-camera-setup). Per GDD section 4A, this is a FOUNDATIONAL
// pass only: fixed orthographic camera, an 8x8 grid of naive BoxGeometry
// cubes, and real directional/hemisphere lighting that replaces the old
// Canvas 2D bevel trick as the depth cue. Explicitly NOT in scope here
// (left for later workstreams, see progress.md sequencing):
//   - texture-to-material-mapping: cubes use one flat placeholder
//     MeshStandardMaterial color, not assets/blocks/*.png yet.
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
import { BOARD_SIZE } from './pieces.js';

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
  // backdrop wall behind the board plane, facing the camera, same stub
  // color; real backdrop art explicitly deferred) --------------------------
  const backdropGeo = new THREE.PlaneGeometry(BOARD_SIZE * 3, BOARD_SIZE * 3);
  const backdropMat = new THREE.MeshStandardMaterial({ color: 0x101114 }); // GDD sec 4 gutter-shadow color, stub only
  const ground = new THREE.Mesh(backdropGeo, backdropMat);
  // Upright, facing +Z (toward the camera), sitting behind the board plane.
  ground.position.z = -BACKDROP_DEPTH;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- 8x8 grid of naive BoxGeometry cubes -------------------------------
  // Deliberately one Mesh per cell (64 meshes), NOT InstancedMesh, per GDD
  // 4A explicit scope cut ("build naive first; only reach for InstancedMesh
  // if profiling shows it's actually needed"). Cubes sit in the vertical XY
  // plane facing the camera: X = column, Y = row going up, Z = depth
  // (thickness) toward the camera — not a horizontal XZ ground layout.
  const cubeGeo = new THREE.BoxGeometry(CUBE_FOOTPRINT, CUBE_FOOTPRINT, CUBE_HEIGHT);
  // Flat placeholder material — texture-to-material-mapping (a separate,
  // later workstream per GDD 4A) owns swapping this for assets/blocks/*.png.
  const cubeMat = new THREE.MeshStandardMaterial({ color: 0x8fa3b8, roughness: 0.85, metalness: 0.05 });
  const cubes = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cube = new THREE.Mesh(cubeGeo, cubeMat);
      // Row 0 is the top of the board on screen, so row increases downward
      // in board-space but Y increases upward in world-space — flip r here.
      cube.position.set((c - BOARD_HALF) * CELL_STRIDE, (BOARD_HALF - r) * CELL_STRIDE, CUBE_HEIGHT / 2);
      cube.castShadow = true;
      cube.receiveShadow = true;
      scene.add(cube);
      cubes.push({ r, c, mesh: cube });
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
    renderer.render(scene, camera);
  }

  function dispose() {
    cubeGeo.dispose();
    cubeMat.dispose();
    backdropGeo.dispose();
    backdropMat.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  return { scene, camera, renderer, cubes, ground, keyLight, hemi, resize, render, dispose };
}
