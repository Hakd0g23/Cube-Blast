// Fracture — offline "mineral chip" sprite renderer for Style C.
// Bake-time only (runs inside tools/sprite-bake/bake.html via Playwright,
// never shipped to the runtime bundle). Deliberately heavier than the
// runtime-procedural Style A fill it supersedes (src/main.js's old
// drawShardChip) -- noise-texture grain, per-facet gradients, a blurred
// ambient-occlusion edge pass, and a branching crack network -- because none
// of that cost is paid at play time; it's paid once, offline, and the
// result is rasterized into a small PNG atlas.
//
// Silhouette lineage: keeps B's core idea (an irregular angular polygon
// inscribed around the cell center, so the OUTLINE alone -- not just color
// or a text label -- reads as a distinct fragment vs. a regular piece's
// rounded-rect fill) but evolves the geometry: more vertices (9, not 6),
// independently jittered radius AND angle per vertex (not just radius off
// even spokes), for a more organic mineral-fragment silhouette instead of a
// clean jittered hexagon. This is a deliberate, documented choice (see
// docs/art-direction.md Style C entry), not an accidental drift from B/A.

function hash(seed, salt) {
  // Same small deterministic integer-hash shape as main.js's hash2, reused
  // here for lineage/consistency even though this runs at bake time against
  // a variant index (0..ATLAS_VARIANTS-1), not a live per-cell seed.
  let h = (seed * 374761393 + salt * 668265263) ^ (seed << 13);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967295;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const mix = amt < 0 ? 0 : 255;
  const k = Math.abs(amt);
  r = Math.round(r + (mix - r) * k);
  g = Math.round(g + (mix - g) * k);
  b = Math.round(b + (mix - b) * k);
  return `rgb(${r},${g},${b})`;
}

// Shared grain texture: generated once per bake process (not once per tile)
// and stamped at a per-variant offset, so 56 tiles don't each pay for their
// own from-scratch per-pixel noise generation.
export function makeGrainTile(size, seed) {
  // Low-res noise, generated small and then upscaled+blurred -- keeps the
  // "mineral grain" visual character (soft low-frequency mottling, not
  // per-pixel static) while staying PNG-compression-friendly: raw
  // per-pixel white noise is the single biggest driver of atlas file size
  // (high-entropy data barely compresses), so this trades a bit of grain
  // crispness for a dramatically leaner atlas -- the right trade given the
  // mobile-bundle-size constraint on this pass.
  const genSize = Math.max(8, Math.round(size / 6));
  const gen = document.createElement('canvas');
  gen.width = genSize; gen.height = genSize;
  const gg = gen.getContext('2d');
  const img = gg.createImageData(genSize, genSize);
  for (let y = 0; y < genSize; y++) {
    for (let x = 0; x < genSize; x++) {
      const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.1) * 43758.5453;
      const v = (s - Math.floor(s)) * 255;
      const i = (y * genSize + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  gg.putImageData(img, 0, 0);

  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.filter = `blur(${Math.max(1, size * 0.02)}px)`;
  g.imageSmoothingEnabled = true;
  g.drawImage(gen, 0, 0, size, size);
  return c;
}

// Renders one chip tile into `ctx` centered at (cx, cy) with radius R,
// tinted to `color` (a palette hex), using `seed` (the variant index) as
// the sole source of deterministic jitter, plus a shared `grainTile` for
// mineral-grain texture.
export function renderChip(ctx, cx, cy, R, color, seed, grainTile) {
  const N = 9;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const baseAngle = (Math.PI * 2 * i) / N - Math.PI / 2;
    const angleJitter = (hash(seed, i + 200) - 0.5) * 0.34; // +/- ~0.17 rad
    const radiusJitter = 0.55 + hash(seed, i) * 0.5; // 0.55..1.05 of R
    const a = baseAngle + angleJitter;
    pts.push([cx + Math.cos(a) * R * radiusJitter, cy + Math.sin(a) * R * radiusJitter]);
  }
  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };

  ctx.save();
  tracePath();
  ctx.clip();

  // 1. Base glass/mineral gradient (depth cue), same spirit as Style A.
  const lightX = cx - R * 0.35, lightY = cy - R * 0.45;
  const baseGrad = ctx.createRadialGradient(lightX, lightY, Math.max(0.5, R * 0.05), cx, cy, R * 1.5);
  baseGrad.addColorStop(0, shade(color, 0.5));
  baseGrad.addColorStop(0.45, color);
  baseGrad.addColorStop(1, shade(color, -0.45));
  ctx.fillStyle = baseGrad;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // 2. Per-facet shading: each outline edge becomes its own triangular
  // facet (center -> vertex i -> vertex i+1), independently shaded, so the
  // chip reads as a multi-faced cut gem rather than one smooth blob -- the
  // single biggest richness delta over Style A's one wedge, affordable here
  // because it's paid once at bake time, not once per frame.
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    const facetShade = (hash(seed, 100 + i) - 0.5) * 0.85; // -0.42..0.42
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.closePath();
    ctx.fillStyle = shade(color, facetShade);
    ctx.globalAlpha = 0.4;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 3. Mineral grain texture: stamp the shared noise tile at a per-variant
  // offset, blended with 'overlay' at low opacity for rock/gem grain.
  if (grainTile) {
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.16;
    const off = seed * 37 % grainTile.width;
    ctx.drawImage(grainTile, -off, -off);
    ctx.drawImage(grainTile, grainTile.width - off, -off);
    ctx.drawImage(grainTile, -off, grainTile.height - off);
    ctx.drawImage(grainTile, grainTile.width - off, grainTile.height - off);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // 4. Ambient-occlusion edge: a soft blurred dark stroke just inside the
  // silhouette, multiplied in -- cheap to blur here (one-time bake), too
  // costly to do live every frame at runtime.
  ctx.save();
  ctx.filter = `blur(${Math.max(1, R * 0.05)}px)`;
  ctx.globalCompositeOperation = 'multiply';
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = R * 0.22;
  tracePath();
  ctx.stroke();
  ctx.restore();

  // 5. Specular glints: primary + smaller secondary, for a crystal-catch-
  // light look richer than Style A's single blob.
  for (const [gx, gy, gr, alpha] of [
    [cx - R * 0.3, cy - R * 0.35, R * 0.34, 0.55],
    [cx + R * 0.25, cy + R * 0.15, R * 0.14, 0.32],
  ]) {
    const glintGrad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    glintGrad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    glintGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glintGrad;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  // 6. Branching crack network: a primary two-segment crack plus a shorter
  // secondary branch off its midpoint, each with a light+dark paired stroke
  // (glass edge catching light on one side, shadow on the other).
  const iA = 0, iB = Math.floor(N / 2);
  const midX = cx + (hash(seed, 50) - 0.5) * R * 0.6;
  const midY = cy + (hash(seed, 51) - 0.5) * R * 0.6;
  const drawCrack = (x0, y0, x1, y1, x2, y2) => {
    ctx.lineWidth = Math.max(0.75, R * 0.028);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.lineWidth = Math.max(0.5, R * 0.016);
    ctx.strokeStyle = 'rgba(0,0,0,0.24)';
    ctx.beginPath();
    ctx.moveTo(x0 + 1, y0 + 1); ctx.lineTo(x1 + 1, y1 + 1); ctx.lineTo(x2 + 1, y2 + 1);
    ctx.stroke();
  };
  drawCrack(pts[iA][0], pts[iA][1], midX, midY, pts[iB][0], pts[iB][1]);
  const branchX = midX + (hash(seed, 60) - 0.5) * R * 0.5;
  const branchY = midY + (hash(seed, 61) - 0.5) * R * 0.5;
  drawCrack(midX, midY, (midX + branchX) / 2, (midY + branchY) / 2, branchX, branchY);

  ctx.restore(); // remove clip

  // 7. Outer contact stroke + rim highlight, same convention as B/A.
  tracePath();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(1, R * 0.02);
  ctx.stroke();
  tracePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(0.6, R * 0.012);
  ctx.stroke();
}
