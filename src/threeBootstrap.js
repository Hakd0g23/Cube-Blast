// Cube Blast — dev-gated entry point for the Three.js scene/camera/lighting
// infra (workstream: threejs-scene-camera-setup). Mirrors the existing
// ?debug=1 pattern (src/main.js DEBUG_LOG_PANEL) for an opt-in dev flag:
// completely inert unless ?three=1 is present in the URL, so the shipping
// Canvas 2D game (src/main.js) is untouched by default. This keeps the
// foundational scene buildable/verifiable now without forcing the
// texture-mapping/mascot/UI-integration workstreams to land first just to
// avoid regressing the live game.
import { createThreeScene } from './threeScene.js';

const THREE_PREVIEW = new URLSearchParams(location.search).has('three');
if (THREE_PREVIEW) {
  const stage2D = document.getElementById('stage');
  const wrap = document.getElementById('three-stage-wrap');
  if (wrap) {
    wrap.style.display = 'block';
    if (stage2D) stage2D.style.visibility = 'hidden';

    const handle = createThreeScene(wrap);

    function currentSize() {
      // Match the same responsive board footprint the 2D layout uses
      // (src/main.js computeLayout(): maxW = min(innerWidth-24, 480), square).
      const size = Math.min(window.innerWidth - 24, 480);
      return { width: size, height: size };
    }

    function resizeToViewport() {
      const { width, height } = currentSize();
      wrap.style.width = width + 'px';
      wrap.style.height = height + 'px';
      handle.resize(width, height);
    }
    resizeToViewport();
    window.addEventListener('resize', resizeToViewport);

    function loop() {
      handle.render();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // Verification/QA hook, matching the existing window.__fractureDebug
    // pattern (src/main.js) so headless/windowed Playwright scripts can
    // assert on scene contents without scraping internals ad hoc.
    window.__threeDebug = {
      cubeCount: () => handle.cubes.length,
      cubePositions: () => handle.cubes.map((c) => ({ r: c.r, c: c.c, x: c.mesh.position.x, y: c.mesh.position.y, z: c.mesh.position.z })),
      cameraType: () => handle.camera.type,
      cameraPosition: () => ({ x: handle.camera.position.x, y: handle.camera.position.y, z: handle.camera.position.z }),
      lightCount: () => handle.scene.children.filter((o) => o.isLight).length,
      canvas: () => handle.renderer.domElement,
      renderOnce: () => handle.render(),
      // mascot-prop-placement additions:
      ledgePosition: () => ({ x: handle.ledge.position.x, y: handle.ledge.position.y, z: handle.ledge.position.z }),
      mascotsReady: () => handle.mascotsLoaded.then(() => true),
      mascotCount: () => handle.mascots.length,
      mascotInfo: () =>
        handle.mascots.map((m) => ({
          name: m.name,
          x: m.root.position.x,
          y: m.root.position.y,
          z: m.root.position.z,
          scale: m.root.scale.x,
        })),
      // texture-to-material-mapping additions:
      materialsReady: () => handle.materialsReadyPromise,
      backdropTextureReady: () => handle.backdropTextureLoaded,
      materialsFailed: () => handle.isMaterialsFailed(),
      backdropTextureFailed: () => handle.isBackdropTextureFailed(),
      cubeFamilies: () => handle.cubes.map((c) => ({ r: c.r, c: c.c, family: c.family })),
      backdropHasMap: () => !!handle.ground.material.map,
    };
  }
}
