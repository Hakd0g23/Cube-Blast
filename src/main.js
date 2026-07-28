// Fracture — canvas renderer + input layer. Thin shell over src/core.js;
// contains no gameplay rules of its own (those all live in core.js so they
// stay unit-testable headlessly). Uses Pointer Events so mouse (desktop) and
// touch (mobile/tablet browsers) share one code path instead of two.

import { createGame, placePiece, canPlaceAt, mulberry32, QUEUE_CAP, TRAY_BASE_SIZE, WAVE_MAX_TIER, waveCalloutText } from './core.js';
import { BOARD_SIZE, COLORS } from './pieces.js';
import { BLOCK_MAP_PATH } from './blockTextureConfig.js';
import { playLineClear, playShardScatter, playGameOver, playComboVoice, playPerfectClearVoice, unlockAudio, setWaveTier, startBgm, setSfxVolume, getSfxVolume, setBgmVolume, getBgmVolume } from './audio.js';
import { fetchTopScores, submitScore } from './leaderboard.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const scoreVal = document.getElementById('scoreVal');
const bestVal = document.getElementById('bestVal');
const waveLine = document.getElementById('waveLine');
const waveVal = document.getElementById('waveVal');
const logEl = document.getElementById('log');
const overlay = document.getElementById('overlay');
const finalScoreEl = document.getElementById('finalScore');
const bestDeltaEl = document.getElementById('bestDelta');
const newGameBtn = document.getElementById('newGameBtn');
const quitBtn = document.getElementById('quitBtn');
const restartBtn = document.getElementById('restartBtn');
const nameInput = document.getElementById('nameInput');
const submitScoreBtn = document.getElementById('submitScoreBtn');
const submitStatusEl = document.getElementById('submitStatus');
const leaderboardListEl = document.getElementById('leaderboardList');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const bgmVolumeSlider = document.getElementById('bgmVolumeSlider');
const sfxVolumeSlider = document.getElementById('sfxVolumeSlider');
const LS_KEY_PLAYER_NAME = 'fracture.playerName';

// ---- light/dark theme -------------------------------------------------
// index.html defines the actual colors as CSS custom properties (light
// block under @media prefers-color-scheme, both explicit under
// [data-theme="light"|"dark"]); this just decides which one wins and
// persists an explicit user choice. The canvas renderer isn't CSS, so
// theme() below re-reads the resolved custom properties every draw() call
// instead of hardcoding hex values that would go stale on toggle.
const LS_KEY_THEME = 'fracture.theme';

function effectiveTheme() {
  const stored = (() => { try { return localStorage.getItem(LS_KEY_THEME); } catch { return null; } })();
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggleBtn.textContent = theme === 'light' ? '☀️' : '🌙';
}

applyTheme(effectiveTheme());
themeToggleBtn.addEventListener('click', () => {
  const next = effectiveTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(LS_KEY_THEME, next); } catch { /* ignore (private mode, etc.) */ }
  applyTheme(next);
  draw();
});

// ---- settings panel (bgm/sfx volume) -----------------------------------
// Sliders reflect audio.js's persisted volumes on load; audio.js owns the
// localStorage keys and clamping, this just mirrors state into the DOM.
bgmVolumeSlider.value = String(Math.round(getBgmVolume() * 100));
sfxVolumeSlider.value = String(Math.round(getSfxVolume() * 100));

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('show');
});
bgmVolumeSlider.addEventListener('input', () => {
  setBgmVolume(Number(bgmVolumeSlider.value) / 100);
});
sfxVolumeSlider.addEventListener('input', () => {
  setSfxVolume(Number(sfxVolumeSlider.value) / 100);
});

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    muted: v('--muted'), fg: v('--fg'), border: v('--border'), borderDim: v('--border-dim'),
    emptyCell: v('--empty-cell'), gridLine: v('--grid-line'), accent: v('--accent'),
    calloutBg: v('--callout-bg'), calloutText: v('--callout-text'),
  };
}

// ---- dev-only debug log panel ----------------------------------------------
// The raw engine event log (state.log) is a debugging aid, not a shipped
// player-facing feature -- gated behind an explicit ?debug=1 query flag so
// playtesters never see it by default, but it stays reachable for real
// debugging without a code change (just add the query param).
const DEBUG_LOG_PANEL = new URLSearchParams(location.search).has('debug');
if (DEBUG_LOG_PANEL && logEl) logEl.classList.add('show');

// ---- dev-only wave tier shortcut --------------------------------------
// Wave tiers (see WAVE_MAX_TIER in core.js) only actually change every
// WAVE_INTERVAL_CLEARS=18 clears, far too slow to eyeball the per-wave
// palette/sound pack (index.html [data-wave-tier], audio.js
// WAVE_SOUND_PACKS) against both themes. Reuses the same ?debug=1 gate as
// the log panel above; press W to cycle tiers 0..WAVE_MAX_TIER and hear/see
// the change immediately, combine with the theme toggle button to check
// both light and dark without reloading.
if (DEBUG_LOG_PANEL) {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'w' && e.key !== 'W') return;
    if (!state.onboarding) return;
    state.onboarding.waveTier = (state.onboarding.waveTier + 1) % (WAVE_MAX_TIER + 1);
    if (state.onboarding.waveTier > 0) {
      state.pendingCallouts.push({
        type: 'wave',
        tier: state.onboarding.waveTier,
        text: waveCalloutText(state.onboarding.waveTier),
      });
    }
    refreshChrome();
    draw();
  });
}

// ---- Section 5b: persisted onboarding flags --------------------------------
// core.js is DOM-free and can't read/write localStorage itself, so main.js
// owns persistence: read on load, pass in as createGame opts, write back
// whenever core.js reports a change (see persistOnboardingFlags below).
const LS_KEY_EXPOSURE = 'fracture.firstExposureComplete';
const LS_KEY_SHARD_CALLOUT = 'fracture.firstShardCalloutShown';
const LS_KEY_BEST_SCORE = 'fracture.bestScore';

function readBoolFlag(key) {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
function writeBoolFlag(key, value) {
  try { localStorage.setItem(key, value ? 'true' : 'false'); } catch { /* ignore (private mode, etc.) */ }
}

function readBestScore() {
  try {
    const raw = localStorage.getItem(LS_KEY_BEST_SCORE);
    const n = raw == null ? 0 : parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}
function writeBestScore(v) {
  try { localStorage.setItem(LS_KEY_BEST_SCORE, String(v)); } catch { /* ignore (private mode, etc.) */ }
}

function readPlayerName() {
  try { return localStorage.getItem(LS_KEY_PLAYER_NAME) || ''; } catch { return ''; }
}
function writePlayerName(name) {
  try { localStorage.setItem(LS_KEY_PLAYER_NAME, name); } catch { /* ignore (private mode, etc.) */ }
}

let bestScore = readBestScore();
// True only for the single game in which the best score was actually beaten
// -- drives the game-over overlay's "New Best!" vs "X short of best" text
// (task 5), reset every newGame().
let beatBestThisGame = false;
// GDD 12.8: guards triggerDeathSequence against firing more than once per
// game (see refreshChrome); reset per newGame() below.
let deathSequenceStarted = false;

function newGameState() {
  return createGame(undefined, {
    firstExposureComplete: readBoolFlag(LS_KEY_EXPOSURE),
    firstShardCalloutShown: readBoolFlag(LS_KEY_SHARD_CALLOUT),
  });
}

function persistOnboardingFlags(s) {
  writeBoolFlag(LS_KEY_EXPOSURE, s.firstExposureComplete);
  writeBoolFlag(LS_KEY_SHARD_CALLOUT, s.onboarding.firstShardCalloutFired);
}

// ---- resume-on-reload: persist the in-progress run so closing the tab/
// browser mid-game doesn't lose it -----------------------------------------
// Only the JSON-serializable fields are saved -- state.rng is a mulberry32
// closure over internal state that isn't exposed for serialization, so a
// resumed game gets a freshly seeded rng rather than continuing the exact
// same random sequence. That only affects which piece/shard shows up next,
// never anything already on the board, and is not worth core.js exposing
// its PRNG internals for.
const LS_KEY_GAME_STATE = 'fracture.gameState';

function saveGameState(s) {
  try {
    const { board, tray, shardQueue, score, comboStreak, gameOver, log, turn, firstExposureComplete, pendingCallouts, onboarding } = s;
    localStorage.setItem(LS_KEY_GAME_STATE, JSON.stringify({
      board, tray, shardQueue, score, comboStreak, gameOver, log, turn, firstExposureComplete, pendingCallouts, onboarding,
    }));
  } catch { /* ignore (private mode, etc.) */ }
}

function clearSavedGameState() {
  try { localStorage.removeItem(LS_KEY_GAME_STATE); } catch { /* ignore */ }
}

function tryLoadGameState() {
  try {
    const raw = localStorage.getItem(LS_KEY_GAME_STATE);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return null;
    if (!Array.isArray(saved.board) || !Array.isArray(saved.tray) || !Array.isArray(saved.shardQueue)) return null;
    if (typeof saved.score !== 'number' || typeof saved.gameOver !== 'boolean') return null;
    if (saved.gameOver) return null; // a finished run isn't resumable
    if (typeof saved.comboStreak !== 'number') saved.comboStreak = 0; // older saves predate combos
    saved.rng = mulberry32(Date.now());
    return saved;
  } catch {
    return null;
  }
}

let state = tryLoadGameState() ?? newGameState();
saveGameState(state);
let lastLogLen = 0;

// ---- GDD 10/11: pause/resume (P or Escape) ---------------------------------
// A virtual clock: every animation timestamp in this file (startedAt/
// expiresAt fields, and every elapsed-time read) is taken from vnow()
// instead of raw performance.now(). While paused, vnow() is pinned to the
// instant pause began, so every in-flight animation's elapsed-time math
// freezes exactly where it was; on resume, vnow() picks back up from that
// same frozen value (offset by the accumulated paused duration relative to
// real time), so nothing time-jumps. This is a single choke point rather
// than needing to shift startedAt/expiresAt on every individual animation
// data structure (boardFlashes, shardArcs, landingAnims, etc.) by hand.
const pauseOverlay = document.getElementById('pauseOverlay');
let isPaused = false;
let pauseStartedAt = null; // real performance.now() at the moment pause began, else null
let pauseAccumMs = 0; // total real time spent paused so far, subtracted out of vnow()

function vnow() {
  return (pauseStartedAt !== null ? pauseStartedAt : performance.now()) - pauseAccumMs;
}

function setPaused(next) {
  if (next === isPaused) return;
  // GDD section 10: pause is only a valid input while Playing -- a finished
  // run has its own overlay/state already and isn't "Playing".
  if (next && state.gameOver) return;
  isPaused = next;
  if (next) {
    pauseStartedAt = performance.now();
    // Mid-drag pause (P/Escape pressed while holding a piece): drop the held
    // piece back to the tray rather than leaving it stuck mid-air frozen in
    // an ambiguous state -- matches "input on pieces frozen", not "input
    // silently continues once resumed from wherever the pointer drifted to".
    drag = null;
    if (pauseOverlay) pauseOverlay.classList.add('show');
  } else {
    pauseAccumMs += performance.now() - pauseStartedAt;
    pauseStartedAt = null;
    if (pauseOverlay) pauseOverlay.classList.remove('show');
    draw();
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'p' && e.key !== 'P' && e.key !== 'Escape') return;
  if (state.gameOver) return; // matches setPaused's own guard; avoids swallowing Escape elsewhere post-game
  e.preventDefault();
  setPaused(!isPaused);
});

// ---- Section 5b: non-blocking pulse callouts --------------------------------
// Drawn directly on canvas (no new DOM/CSS chrome) so they stay inert to
// pointer input by construction and anchor exactly to the layout-computed
// coordinates of the existing shard-queue row / overflow tray slot.
const CALLOUT_DURATION_MS = 3200;
let activeCallouts = []; // { type, text, expiresAt }
let calloutTickerRunning = false;

function ingestPendingCallouts(s) {
  if (!s.pendingCallouts.length) return;
  const now = vnow();
  for (const c of s.pendingCallouts) activeCallouts.push({ ...c, expiresAt: now + CALLOUT_DURATION_MS });
  s.pendingCallouts.length = 0;
  startCalloutTicker();
}

function startCalloutTicker() {
  if (calloutTickerRunning) return;
  calloutTickerRunning = true;
  const tick = () => {
    const before = activeCallouts.length;
    activeCallouts = activeCallouts.filter((c) => c.expiresAt > vnow());
    if (before !== activeCallouts.length || activeCallouts.length > 0) draw();
    if (activeCallouts.length > 0) {
      requestAnimationFrame(tick);
    } else {
      calloutTickerRunning = false;
    }
  };
  requestAnimationFrame(tick);
}

// ---- clear-moment juice (flash/pulse + screen shake) -----------------------
// Pure canvas-transform code, no asset pipeline: ctx.translate jitter for
// shake, globalCompositeOperation:'lighter' for flash/pulse. Flash tint
// reuses the existing colorblind-audited COLORS palette (pieces.js) rather
// than raw white/yellow.
const FLASH_DURATION_MS = 320;
const LAND_FLASH_DURATION_MS = 180;
const SHAKE_DURATION_MS = 260;
let boardFlashes = []; // { r, c, color, expiresAt, startedAt, kind: 'clear'|'land' }
let shake = null; // { startedAt, duration, magnitude }
let effectsTickerRunning = false;

function startEffectsTicker() {
  if (effectsTickerRunning) return;
  effectsTickerRunning = true;
  const tick = () => {
    const now = vnow();
    boardFlashes = boardFlashes.filter((f) => f.expiresAt > now);
    if (shake && now > shake.startedAt + shake.duration) shake = null;
    draw();
    if (boardFlashes.length > 0 || shake) {
      requestAnimationFrame(tick);
    } else {
      effectsTickerRunning = false;
    }
  };
  requestAnimationFrame(tick);
}

function triggerClearFlash(rows, cols, color) {
  const now = vnow();
  const expiresAt = now + FLASH_DURATION_MS;
  for (const r of rows) for (let c = 0; c < BOARD_SIZE; c++) boardFlashes.push({ r, c, color, expiresAt, startedAt: now, kind: 'clear' });
  for (const c of cols) for (let r = 0; r < BOARD_SIZE; r++) boardFlashes.push({ r, c, color, expiresAt, startedAt: now, kind: 'clear' });
  startEffectsTicker();
}

// ---- GDD 12.1/12.2: placement drop-in + squash-and-settle ------------------
// Per-cell animation keyed to board (r,c): a 10px drop-in ease-out over 90ms,
// immediately followed by a 1.0->0.94->1.0 squash-and-settle over 120ms
// (total ~210ms). Purely a draw()-time transform on top of the already-
// mutated board data -- core.js's placePiece already committed the cell by
// the time this fires, so this never touches placement/scoring logic.
const DROP_IN_MS = 90;
const SQUASH_MS = 120;
const DROP_IN_PX = 10;
let landingAnims = new Map(); // key `${r},${c}` -> { startedAt }
let landingTickerRunning = false;

function triggerLandingAnim(cells, r0, c0) {
  const now = vnow();
  for (const [dr, dc] of cells) landingAnims.set(`${r0 + dr},${c0 + dc}`, { startedAt: now });
  startLandingTicker();
}

function startLandingTicker() {
  if (landingTickerRunning) return;
  landingTickerRunning = true;
  const tick = () => {
    const now = vnow();
    for (const [key, a] of landingAnims) {
      if (now - a.startedAt > DROP_IN_MS + SQUASH_MS) landingAnims.delete(key);
    }
    draw();
    if (landingAnims.size > 0) {
      requestAnimationFrame(tick);
    } else {
      landingTickerRunning = false;
    }
  };
  requestAnimationFrame(tick);
}

// Returns { offsetY, scaleX, scaleY } for a board cell, or null if it has no
// active landing animation. offsetY is in the same px units as cellSize.
function landingTransformFor(r, c) {
  const a = landingAnims.get(`${r},${c}`);
  if (!a) return null;
  const elapsed = vnow() - a.startedAt;
  if (elapsed < DROP_IN_MS) {
    // ease-out (quadratic) from -DROP_IN_PX to 0
    const t = elapsed / DROP_IN_MS;
    const eased = 1 - (1 - t) * (1 - t);
    return { offsetY: -DROP_IN_PX * (1 - eased), scaleX: 1, scaleY: 1 };
  }
  const st = Math.min(1, (elapsed - DROP_IN_MS) / SQUASH_MS);
  // 1.0 -> 0.94 -> 1.0, ease-out down then bounce back up
  const dip = Math.sin(st * Math.PI) * 0.06;
  return { offsetY: 0, scaleX: 1 + dip * 0.5, scaleY: 1 - dip };
}

// ---- GDD 12.4: gold flash / zoom pulse for near-miss & big-clear rewards ---
const GOLD = '#F4C430';
const GOLD_FLASH_MS = 150;
const MILESTONE_FLASH_MS = 120;
const ZOOM_PULSE_MS = 220;
let goldFlash = null; // { startedAt, duration }
let zoomPulse = null; // { startedAt }

function triggerGoldFlash(duration = GOLD_FLASH_MS) {
  goldFlash = { startedAt: vnow(), duration };
  startEffectsTicker();
}

function triggerZoomPulse() {
  zoomPulse = { startedAt: vnow() };
  startEffectsTicker();
}

function currentZoomScale() {
  if (!zoomPulse) return 1;
  const t = (vnow() - zoomPulse.startedAt) / ZOOM_PULSE_MS;
  if (t >= 1) { zoomPulse = null; return 1; }
  // 1.0 -> 1.03 -> 1.0
  return 1 + Math.sin(t * Math.PI) * 0.03;
}

// ---- GDD 12.2/7: shard arc from cleared line to the shard-queue slot -------
// Cosmetic-only overlay: core.js has already inserted the real shard(s) into
// state.shardQueue by the time this fires, so this never affects queue/tray
// logic -- it just gives the already-committed shard a 220ms ease-in-out
// flight path + 100ms landing squash instead of popping in instantly.
const SHARD_ARC_MS = 220;
const SHARD_LAND_SQUASH_MS = 100;
let shardArcs = []; // { fromX, fromY, toX, toY, color, shapeId, startedAt, slowFactor }
let shardArcTickerRunning = false;

function triggerShardArcs(fromX, fromY, targets, color, bigClear) {
  const now = vnow();
  // GDD 12.4 "time dilation" on a big-clear shatter: rather than a global
  // clock rewrite (high regression risk against the existing flash/shake/
  // combo tickers), stretch just this new effect's own duration so a big
  // clear's shard flight visibly reads as slower -- same visual intent
  // (0.5x for the first part, ramping back) without touching shared timing.
  const slowFactor = bigClear ? 1.8 : 1;
  for (const target of targets) {
    shardArcs.push({ fromX, fromY, toX: target.x, toY: target.y, color, startedAt: now, slowFactor });
  }
  startShardArcTicker();
}

function startShardArcTicker() {
  if (shardArcTickerRunning) return;
  shardArcTickerRunning = true;
  const tick = () => {
    const now = vnow();
    shardArcs = shardArcs.filter((a) => now - a.startedAt < (SHARD_ARC_MS + SHARD_LAND_SQUASH_MS) * a.slowFactor);
    draw();
    if (shardArcs.length > 0) {
      requestAnimationFrame(tick);
    } else {
      shardArcTickerRunning = false;
    }
  };
  requestAnimationFrame(tick);
}

function drawShardArcs() {
  const now = vnow();
  for (const a of shardArcs) {
    const elapsed = now - a.startedAt;
    const arcDur = SHARD_ARC_MS * a.slowFactor;
    if (elapsed < arcDur) {
      const t = elapsed / arcDur;
      // ease-in-out
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = a.fromX + (a.toX - a.fromX) * eased;
      const y = a.fromY + (a.toY - a.fromY) * eased;
      // Parabolic arc height, peaking mid-flight.
      const arcHeight = 26;
      const y2 = y - Math.sin(eased * Math.PI) * arcHeight;
      drawShardChip(x, y2, 16, a.color);
    } else {
      // Landing squash: a brief radial pulse at the destination.
      const st = Math.min(1, (elapsed - arcDur) / (SHARD_LAND_SQUASH_MS * a.slowFactor));
      const scale = 1 + Math.sin(st * Math.PI) * 0.35;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - st);
      drawShardChip(a.toX, a.toY, 16 * scale, a.color);
      ctx.restore();
    }
  }
}

function triggerLandFlash(cells, r0, c0, color) {
  const now = vnow();
  const expiresAt = now + LAND_FLASH_DURATION_MS;
  for (const [dr, dc] of cells) boardFlashes.push({ r: r0 + dr, c: c0 + dc, color, expiresAt, startedAt: now, kind: 'land' });
  startEffectsTicker();
}

function triggerShake(magnitude) {
  shake = { startedAt: vnow(), duration: SHAKE_DURATION_MS, magnitude };
  startEffectsTicker();
}

function currentShakeOffset() {
  if (!shake) return { x: 0, y: 0 };
  const now = vnow();
  const t = (now - shake.startedAt) / shake.duration;
  if (t >= 1) return { x: 0, y: 0 };
  const falloff = 1 - t; // linear decay to 0
  const angle = Math.random() * Math.PI * 2;
  const r = shake.magnitude * falloff;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

// ---- combo / whole-field clear affirmations ---------------------------
// A big center-screen banner + confetti burst, distinct from the small
// corner pulse callouts above (those are informational, this is a reward
// moment). Festiveness (particle count, banner scale, color count) scales
// with combo streak so a 5-combo reads as more of an event than a 2-combo.
const COMBO_WORDS = ['Nice!', 'Sweet!', 'Great!', 'Awesome!', 'Amazing!', 'Incredible!', 'Unstoppable!'];
function comboAffirmationText(streak) {
  const idx = Math.min(streak - 2, COMBO_WORDS.length - 1); // streak 2 -> first word
  return `${COMBO_WORDS[Math.max(0, idx)]} x${streak} Combo`;
}

const CENTER_BURST_DURATION_MS = 950;
let centerBursts = []; // { text, kind: 'combo'|'perfect', level, startedAt, expiresAt }
let confetti = []; // { x, y, vx, vy, color, size, rotation, vr, expiresAt }
let burstTickerRunning = false;

function triggerCenterBurst(text, kind, level) {
  const now = vnow();
  centerBursts.push({ text, kind, level, startedAt: now, expiresAt: now + CENTER_BURST_DURATION_MS });

  const cx = layout.gridX + (BOARD_SIZE * cellSize) / 2;
  const cy = layout.gridY + (BOARD_SIZE * cellSize) / 2;
  const particleCount = kind === 'perfect' ? 60 : Math.min(12 + level * 8, 56);
  const palette = kind === 'perfect' ? [...COLORS, '#ffd54a'] : COLORS;
  for (let i = 0; i < particleCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * (kind === 'perfect' ? 220 : 140);
    confetti.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 40,
      color: palette[Math.floor(Math.random() * palette.length)],
      size: 3 + Math.random() * 4,
      rotation: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 10,
      startedAt: now,
      expiresAt: now + CENTER_BURST_DURATION_MS + Math.random() * 400,
    });
  }
  startBurstTicker();
}

function startBurstTicker() {
  if (burstTickerRunning) return;
  burstTickerRunning = true;
  const tick = () => {
    const now = vnow();
    centerBursts = centerBursts.filter((b) => b.expiresAt > now);
    confetti = confetti.filter((p) => p.expiresAt > now);
    draw();
    if (centerBursts.length > 0 || confetti.length > 0) {
      requestAnimationFrame(tick);
    } else {
      burstTickerRunning = false;
    }
  };
  requestAnimationFrame(tick);
}

function drawConfetti() {
  const now = vnow();
  const gravity = 260;
  for (const p of confetti) {
    const t = (now - p.startedAt) / 1000;
    const age = (now - p.startedAt) / (p.expiresAt - p.startedAt);
    const x = p.x + p.vx * t;
    const y = p.y + p.vy * t + 0.5 * gravity * t * t;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age);
    ctx.translate(x, y);
    ctx.rotate(p.rotation + p.vr * t);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.6);
    ctx.restore();
  }
}

function drawCenterBursts() {
  const now = vnow();
  const cx = layout.gridX + (BOARD_SIZE * cellSize) / 2;
  const cy = layout.gridY + (BOARD_SIZE * cellSize) / 2;
  for (const b of centerBursts) {
    const t = (now - b.startedAt) / (b.expiresAt - b.startedAt);
    // Pop in (first 20%), hold, fade out (last 30%).
    const scale = t < 0.2 ? 0.6 + 0.4 * (t / 0.2) : 1;
    const alpha = t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
    const isPerfect = b.kind === 'perfect';
    let baseSize = isPerfect ? 44 : Math.min(22 + b.level * 5, 56);

    // Longer/bigger strings can outgrow the board at high combo levels, so
    // measure at the target size and shrink to fit rather than clipping.
    ctx.font = `${baseSize}px "Bangers", -apple-system, sans-serif`;
    const maxWidth = BOARD_SIZE * cellSize * 0.92;
    const measured = ctx.measureText(b.text).width;
    if (measured > maxWidth) {
      baseSize *= maxWidth / measured;
      ctx.font = `${baseSize}px "Bangers", -apple-system, sans-serif`;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${baseSize}px "Bangers", -apple-system, sans-serif`;
    // Anime SFX look: heavy white outline first, then a thin dark inline for
    // contrast, so the text pops against both light and dark board tiles.
    ctx.lineJoin = 'round';
    ctx.lineWidth = baseSize * 0.22;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(b.text, 0, 0);
    ctx.lineWidth = baseSize * 0.06;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(b.text, 0, 0);
    const hue = isPerfect ? '#ffd54a' : COLORS[(b.level - 2) % COLORS.length];
    ctx.fillStyle = hue;
    ctx.fillText(b.text, 0, 0);
    ctx.restore();
  }
}

// ---- GDD 12.6: idle life (shimmer + tray bob) ------------------------------
// A low-cost continuous RAF loop, only running while there's something to
// animate (Playing, not game-over -- there is no pause state in this build
// yet, see qa-verification note in progress.md) so idle players still see
// placed cubes shimmer and tray pieces bob without needing any interaction
// to keep re-triggering draw(). Throttled to ~20fps (idle ambience doesn't
// need 60fps) to keep this cheap to leave running indefinitely.
const IDLE_FRAME_INTERVAL_MS = 1000 / 20;
const SHIMMER_PERIOD_MS = 3000;
const TRAY_BOB_PERIOD_MS = 1800;
const TRAY_BOB_PX = 2;
let idleTickerRunning = false;
let lastIdleFrameAt = 0;

function shimmerAlphaFor(r, c) {
  // Per-cell phase offset (not a uniform pulse across the whole board) so it
  // reads as organic ambient life rather than a single synchronized blink.
  const phase = (r * 7 + c * 13) % 1000;
  const t = ((vnow() + phase) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
  return Math.sin(t * Math.PI * 2) * 0.02; // +-2% brightness
}

function trayBobOffsetFor(i) {
  const phase = i * 260; // stagger per tray slot
  const t = ((vnow() + phase) % TRAY_BOB_PERIOD_MS) / TRAY_BOB_PERIOD_MS;
  return Math.sin(t * Math.PI * 2) * TRAY_BOB_PX;
}

function startIdleTicker() {
  if (idleTickerRunning) return;
  idleTickerRunning = true;
  const tick = () => {
    if (state.gameOver) { idleTickerRunning = false; return; }
    const now = vnow();
    if (now - lastIdleFrameAt >= IDLE_FRAME_INTERVAL_MS) {
      lastIdleFrameAt = now;
      draw();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- GDD 12.7: milestone celebrations every 500 points ---------------------
const MILESTONE_INTERVAL = 500;
let lastMilestoneReached = 0; // tracks Math.floor(score / MILESTONE_INTERVAL)

function checkMilestone(prevScore, newScore) {
  const prevTier = Math.floor(prevScore / MILESTONE_INTERVAL);
  const newTier = Math.floor(newScore / MILESTONE_INTERVAL);
  if (newTier > prevTier && newTier > lastMilestoneReached) {
    lastMilestoneReached = newTier;
    scoreVal.classList.remove('milestone-pop');
    // Force reflow so re-adding the class restarts the CSS animation even if
    // two milestones fire in quick succession.
    void scoreVal.offsetWidth;
    scoreVal.classList.add('milestone-pop');
    triggerGoldFlash(MILESTONE_FLASH_MS);
  }
}

// ---- GDD 12.8: death sequence ----------------------------------------------
// Desaturate placed cubes (300ms) -> single 6px board shake -> 120ms
// freeze-frame -> dim overlay fades in with the Game Over panel, ~600ms
// total before the panel is interactive. Runs entirely on the canvas side;
// the actual DOM overlay.classList.add('show') is deferred until this
// sequence completes (see refreshChrome), so the panel can't be clicked
// mid-sequence.
const DEATH_DESATURATE_MS = 300;
const DEATH_FREEZE_MS = 120;
const DEATH_SHAKE_MS = 300; // GDD 12.4: game-over shake, 6px amplitude, 300ms decay
let deathSeq = null; // { startedAt }
let deathTickerRunning = false;

function triggerDeathSequence(onComplete) {
  deathSeq = { startedAt: vnow() };
  startDeathTicker(onComplete);
}

function deathDesaturateAmount() {
  if (!deathSeq) return 0;
  const elapsed = vnow() - deathSeq.startedAt;
  return Math.max(0, Math.min(1, elapsed / DEATH_DESATURATE_MS));
}

function startDeathTicker(onComplete) {
  if (deathTickerRunning) return;
  deathTickerRunning = true;
  const tick = () => {
    const elapsed = vnow() - deathSeq.startedAt;
    if (elapsed < DEATH_DESATURATE_MS) {
      draw();
      requestAnimationFrame(tick);
      return;
    }
    if (elapsed < DEATH_DESATURATE_MS + 1) {
      // Fire the single shake exactly once, right as desaturation completes.
      triggerShake(6);
    }
    if (elapsed < DEATH_DESATURATE_MS + DEATH_SHAKE_MS) {
      draw();
      requestAnimationFrame(tick);
      return;
    }
    if (elapsed < DEATH_DESATURATE_MS + DEATH_SHAKE_MS + DEATH_FREEZE_MS) {
      // Freeze-frame: intentionally skip draw() for this window so the last
      // rendered frame holds still before the overlay fades in on top of it.
      requestAnimationFrame(tick);
      return;
    }
    deathTickerRunning = false;
    deathSeq = null;
    draw();
    onComplete();
  };
  requestAnimationFrame(tick);
}

function drawCallout(text, anchorX, anchorY, align = 'left') {
  ctx.save();
  ctx.font = '12px -apple-system, sans-serif';
  const paddingX = 8, paddingY = 6;
  const w = ctx.measureText(text).width + paddingX * 2;
  const h = 22;
  let x = anchorX;
  if (align === 'center') x = anchorX - w / 2;
  if (align === 'right') x = anchorX - w;
  x = Math.max(GAP, Math.min(x, layout.width - w - GAP));
  const y = anchorY;
  const t = theme();
  ctx.fillStyle = t.calloutBg;
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 1.5;
  roundRect(x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = t.calloutText;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + paddingX, y + h / 2 + 1);
  ctx.restore();
}

// ---- layout ----
let cellSize = 40;
const GAP = 10;
const QUEUE_SLOT = 46;
const TRAY_SLOT_W = 96;
const TRAY_SLOT_H = 86;

let layout = null;

function computeLayout() {
  const maxW = Math.min(window.innerWidth - 24, 480);
  cellSize = Math.floor(Math.max(30, Math.min(48, maxW / BOARD_SIZE)));
  const gridW = cellSize * BOARD_SIZE;
  const gridH = cellSize * BOARD_SIZE;

  const queueRowH = QUEUE_SLOT + 18;
  const trayRowH = TRAY_SLOT_H + 18;
  const trayCount = Math.max(TRAY_BASE_SIZE, state.tray.length);
  const trayRowW = trayCount * TRAY_SLOT_W + (trayCount - 1) * 8;

  const width = Math.max(gridW, QUEUE_CAP * (QUEUE_SLOT + 8), trayRowW) + GAP * 2;
  const queueY = GAP + 14;
  const gridX = (width - gridW) / 2;
  const gridY = queueY + QUEUE_SLOT + 16;
  const trayY = gridY + gridH + 16 + 14;
  const height = trayY + TRAY_SLOT_H + GAP;

  layout = { width, height, gridX, gridY, gridW, gridH, queueY, trayY, trayCount, trayRowW };

  // devicePixelRatio-aware backing store (see Style C comment above for why
  // this codebase needed it added now, not before): CSS/layout size stays
  // in logical pixels (canvas.style.width/height, and every draw() call
  // below), but the actual pixel buffer is sized up by dpr and the context
  // transform compensates, so raster sprites (and everything else) render
  // at native device resolution instead of being upscaled blurry.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  // Setting canvas.width/height resets all context state (transform,
  // smoothing, etc.), so both must be reapplied every time this runs.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

// ---- drag state ----
let drag = null; // { trayIndex, piece, x, y, pointerType }

// How far (in logical px) to lift the dragged piece's VISUAL rendering above
// the actual pointer position, so a touch-dragged piece isn't hidden behind
// the player's finger/thumb (reported occlusion bug). Only applied for
// touch input -- mouse/pen already has the cursor tip itself as a visible
// reference point, so lifting it there would just look wrong/disconnected.
// Hit-testing (dragTargetCell) uses this same lift so placement is resolved
// against the visible piece the player is aiming with, not the finger
// hidden underneath it -- avoids the piece landing somewhere other than
// where it visibly appeared to be.
const TOUCH_VISUAL_LIFT = 90;

function dragVisualLift() {
  return drag && drag.pointerType === 'touch' ? TOUCH_VISUAL_LIFT : 0;
}

function shapeExtent(cells) {
  let maxR = 0, maxC = 0;
  for (const [r, c] of cells) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
  return { rows: maxR + 1, cols: maxC + 1 };
}

// ---- Shard cells: textured voxel chips (GDD section 7) ---------------------
// Shard cells used to blit a separate pre-baked hex/chip raster sprite
// (Style C, tools/sprite-bake/*, assets/sprites/shard-atlas.png) that
// pre-dated the Cube World render-swap and was never migrated, so shards
// kept rendering as flat-color hexagon chips after every other cell type
// (board cells, tray/held pieces) switched to textured voxel blocks. Per
// GDD section 7 ("shards are small textured mini-cubes... matching the
// block family/color of the piece that triggered the clear"), shards are
// now drawn with the same drawBlockCell() texture renderer as everything
// else, via the drawShardChip() wrapper below -- see that function for how
// the "distinct fragments, not a solid piece" silhouette (small chip size +
// gap between adjacent cells) is preserved even though the per-cell fill is
// now a texture instead of a flat color. The old hex-chip sprite atlas
// machinery (shardAtlas image, COLOR_INDEX, ATLAS_TILE/ATLAS_VARIANTS/
// ATLAS_PATH, tools/sprite-bake/, assets/sprites/shard-atlas.png, the
// `bake-sprites` npm script) is now fully unused and has been removed.
//
// devicePixelRatio: this codebase had ZERO devicePixelRatio handling before
// this pass (checked directly -- canvas.width was always set equal to CSS
// layout pixels, so the backing store was upscaled by the browser
// compositor on any non-1x display). That was survivable for flat vector
// fills but would visibly blur raster sprites, so computeLayout() below now
// sizes the canvas backing store to `layout.width * devicePixelRatio` and
// applies a matching ctx.setTransform so every existing draw call (all
// written in CSS-pixel/logical coordinates) keeps working unchanged.
// pointFromEvent() was updated to scale by `layout.width / rect.width`
// instead of `canvas.width / rect.width`, since canvas.width is now a
// physical-pixel quantity that no longer matches the logical coordinate
// space the rest of the input/drag code operates in.

// ---- render-swap: Cube World block textures (GDD sections 4, 8) ----------
// Maps each of the 7 colorblind-audited palette colors (pieces.js COLORS) to
// one of the 8 baked block-texture families in assets/blocks/block-map.json,
// per the GDD section 8 family mapping. GDD explicitly names 6 mappings
// (teal/cyan->diamond, yellow/gold->gold, red->brick, green->grass,
// orange->planks, purple->amethyst); the palette's 7th color (#4529ff, a
// blue distinct from the teal/cyan entry already spoken for) has no named
// GDD mapping, so it's assigned to the neutral stone_gray family. dirt_brown
// is intentionally unused by this mapping (no palette color reads as
// "brown") -- still a valid baked family, just not needed for the 7-color
// piece palette; nothing in the GDD requires all 8 families to be in use.
const FAMILY_BY_COLOR = {
  '#ae133a': 'brick_red',
  '#4529ff': 'stone_gray',
  '#45eda7': 'grass_green',
  '#f1c40f': 'gold_yellow',
  '#ac5ae2': 'amethyst_purple',
  '#e07c52': 'planks_tan',
  '#1c899c': 'diamond_cyan',
};

const blockAtlasImg = new Image();
let blockMapData = null;
let blocksReady = false;
let blocksFailed = false;

async function loadBlockTextures() {
  try {
    const res = await fetch(BLOCK_MAP_PATH);
    if (!res.ok) throw new Error(`block-map.json fetch failed: HTTP ${res.status}`);
    blockMapData = await res.json();
    await new Promise((resolve, reject) => {
      blockAtlasImg.onload = () => resolve();
      blockAtlasImg.onerror = () => reject(new Error('block texture atlas image failed to load'));
      blockAtlasImg.src = blockMapData.atlasPath;
    });
    blocksReady = true;
  } catch (e) {
    // Per GDD section 8/13: a missing/failed block texture must never block
    // play -- drawBlockCell below falls back to the original flat piece
    // color (still beveled) whenever blocksReady is false, so the game stays
    // fully playable with zero texture assets present.
    console.error('Cube Blast: block textures failed to load, falling back to flat colors:', e);
    blocksFailed = true;
  }
  draw();
}
loadBlockTextures();

// Draws one occupied cell (board cell or piece/tray cell) as a textured
// voxel block: the block-family texture tile scaled to the cell rect, then a
// top-edge highlight + bottom/right-edge shadow overlay (GDD section 8: white
// 12% alpha ~8px top band, black 18% alpha ~6px bottom/right band, scaled
// from the 56px reference tile to whatever `size` this cell actually is).
// Falls back to a flat color fill (still overlaid with the same bevel) if
// the texture atlas never became ready or has no entry for this color.
function drawBlockCell(x, y, size, color) {
  const family = FAMILY_BY_COLOR[color];
  const familyData = blocksReady && blockMapData ? blockMapData.families[family] : null;
  if (familyData) {
    const a = familyData.atlas;
    ctx.drawImage(blockAtlasImg, a.x, a.y, a.w, a.h, x, y, size, size);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, size, size);
  }
  const topH = Math.max(1, Math.round(size * (8 / 56)));
  const edgeW = Math.max(1, Math.round(size * (6 / 56)));
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x, y, size, topH);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x, y + size - edgeW, size, edgeW);
  ctx.fillRect(x + size - edgeW, y, edgeW, size);
}

// Draws one shard chip (a small gapped cell within the shard queue/tray, or
// the mid-air arc animation) with the SAME textured-voxel look as a regular
// board/piece cell -- drawBlockCell already handles the texture-atlas draw,
// the flat-color fallback, and the bevel overlay, so this is just a
// center-to-top-left coordinate conversion (drawBlockCell takes x/y for its
// top-left corner + a size, drawShardChip's callers all work in
// cell-center coordinates). The chip's small size + the gap the caller
// already leaves between adjacent cells (see drawPieceGrid below) is what
// keeps a shard reading as "distinct fragments, not a solid piece" now that
// the fill itself is a texture rather than a flat hexagon color -- no
// separate hex/angular silhouette is needed for that anymore.
function drawShardChip(cx, cy, size, color) {
  ctx.save();
  roundRect(cx - size / 2, cy - size / 2, size, size, Math.max(1, size * 0.12));
  ctx.clip();
  drawBlockCell(cx - size / 2, cy - size / 2, size, color);
  ctx.restore();
}

function shadeColor(hex, amt) {
  // amt in [-1,1]; negative darkens toward black, positive lightens toward
  // white. Used for flat two-tone facets and a subtle top-edge highlight --
  // still flat colors, no gradients.
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const mix = amt < 0 ? 0 : 255;
  const k = Math.abs(amt);
  r = Math.round(r + (mix - r) * k);
  g = Math.round(g + (mix - g) * k);
  b = Math.round(b + (mix - b) * k);
  return `rgb(${r},${g},${b})`;
}

function drawPieceGrid(cells, color, ox, oy, subcell, isShard, shapeId) {
  for (const [r, c] of cells) {
    const x = ox + c * subcell;
    const y = oy + r * subcell;
    if (isShard) {
      // Gap between adjacent shard cells (even within one shard's own
      // footprint) so a domino shard never reads as a solid contiguous
      // block the way a regular domino piece does.
      const gap = Math.max(3, subcell * 0.22);
      const chipSize = Math.max(4, subcell - gap);
      drawShardChip(x + subcell / 2, y + subcell / 2, chipSize, color);
    } else {
      // render-swap: textured voxel block per GDD section 8, clipped to the
      // existing rounded-rect cell silhouette (tray/held pieces keep their
      // rounded look; drawBlockCell itself draws the flat-fallback + bevel
      // if textures aren't ready/failed, so this stays fully playable with
      // no texture assets present).
      const cx = x + 1, cy = y + 1, cw = subcell - 2, ch = subcell - 2;
      ctx.save();
      roundRect(cx, cy, cw, ch, 4);
      ctx.clip();
      drawBlockCell(cx, cy, Math.max(cw, ch), color);
      ctx.restore();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      roundRect(cx, cy, cw, ch, 4);
      ctx.stroke();
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  ctx.save();
  const t = theme();
  ctx.clearRect(0, 0, layout.width, layout.height);
  // Screen shake: jitter the whole draw via ctx.translate, applied only to
  // the board/piece drawing below (restored before UI chrome would matter --
  // in practice the whole draw() call is small enough that shaking
  // everything, including the queue/tray rows, reads fine and is simplest).
  const shakeOffset = currentShakeOffset();
  ctx.translate(shakeOffset.x, shakeOffset.y);

  // GDD 12.4: zoom pulse on a 3+ line simultaneous clear -- board scales
  // 1.0->1.03->1.0 around the board's own center, restored below with the
  // rest of the shake/zoom transform via ctx.restore() at the end of draw().
  const zoomScale = currentZoomScale();
  if (zoomScale !== 1) {
    const bcx = layout.gridX + (BOARD_SIZE * cellSize) / 2;
    const bcy = layout.gridY + (BOARD_SIZE * cellSize) / 2;
    ctx.translate(bcx, bcy);
    ctx.scale(zoomScale, zoomScale);
    ctx.translate(-bcx, -bcy);
  }

  // --- block texture loading state (GDD sections 2/13) -----------------
  // Non-blocking: cells already render via drawBlockCell's flat-color
  // fallback while this is showing, so the game is playable immediately --
  // this is purely a transient status label, not a gate on input/draw.
  if (!blocksReady && !blocksFailed) {
    ctx.fillStyle = t.muted;
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Loading blocks…', GAP, 4);
  }

  // --- shard queue row ---
  ctx.fillStyle = t.muted;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Shard Queue (${state.shardQueue.length}/${QUEUE_CAP})`, GAP, layout.queueY - 4);
  for (let i = 0; i < QUEUE_CAP; i++) {
    const x = GAP + i * (QUEUE_SLOT + 8);
    const y = layout.queueY;
    ctx.strokeStyle = i < state.shardQueue.length ? t.border : t.borderDim;
    ctx.setLineDash(state.shardQueue[i] ? [] : [4, 3]);
    roundRect(x, y, QUEUE_SLOT, QUEUE_SLOT, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    const shard = state.shardQueue[i];
    if (shard) {
      const ext = shapeExtent(shard.shape);
      const sub = Math.floor((QUEUE_SLOT - 10) / Math.max(ext.rows, ext.cols, 1));
      const ox = x + (QUEUE_SLOT - ext.cols * sub) / 2;
      const oy = y + (QUEUE_SLOT - ext.rows * sub) / 2;
      drawPieceGrid(shard.shape, shard.color, ox, oy, sub, true, shard.shapeId);
    }
  }

  // --- grid ---
  const desaturateAmt = deathDesaturateAmount(); // GDD 12.8: 0..1 over 300ms
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const x = layout.gridX + c * cellSize;
      const y = layout.gridY + r * cellSize;
      const cell = state.board[r][c];
      if (cell) {
        // GDD 12.1/12.2: drop-in + squash-and-settle on a just-placed cell.
        const landing = landingTransformFor(r, c);
        if (landing) {
          const cx = x + cellSize / 2, cy = y + cellSize / 2;
          ctx.save();
          ctx.translate(cx, cy + landing.offsetY);
          ctx.scale(landing.scaleX, landing.scaleY);
          ctx.translate(-cx, -cy);
          drawBlockCell(x, y, cellSize, cell.color);
          ctx.restore();
        } else {
          drawBlockCell(x, y, cellSize, cell.color);
        }
        // GDD 12.6: idle shimmer on placed cubes, +-2% brightness ~3s period.
        const shimmer = shimmerAlphaFor(r, c);
        if (shimmer !== 0) {
          ctx.fillStyle = shimmer > 0 ? `rgba(255,255,255,${shimmer})` : `rgba(0,0,0,${-shimmer})`;
          ctx.fillRect(x, y, cellSize, cellSize);
        }
        // GDD 12.8: death-sequence desaturation, gray wash ramping to full
        // strength over 300ms (drawn as a flat gray overlay rather than a
        // canvas filter -- filter:grayscale on the whole canvas would also
        // desaturate the drop-preview/UI text drawn later in this same
        // draw() call, which the GDD only calls out for "placed cubes").
        if (desaturateAmt > 0) {
          ctx.fillStyle = `rgba(128,128,128,${desaturateAmt * 0.6})`;
          ctx.fillRect(x, y, cellSize, cellSize);
        }
      } else {
        ctx.fillStyle = t.emptyCell;
        ctx.fillRect(x, y, cellSize, cellSize);
      }
      ctx.strokeStyle = t.gridLine;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, cellSize, cellSize);
    }
  }

  // --- clear-moment juice: flash/pulse on cleared row/column and shard
  // landing cells (task 4). 'lighter' composite blends an additive glow of
  // the palette-tinted color on top, fading out over the flash's lifetime --
  // never a raw white/yellow, always the COLORS-palette hue passed in.
  if (boardFlashes.length > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const now = vnow();
    for (const f of boardFlashes) {
      const life = (f.expiresAt - now) / (f.expiresAt - f.startedAt);
      if (life <= 0) continue;
      const x = layout.gridX + f.c * cellSize;
      const y = layout.gridY + f.r * cellSize;
      ctx.globalAlpha = Math.max(0, Math.min(1, life)) * (f.kind === 'clear' ? 0.75 : 0.55);
      ctx.fillStyle = f.color;
      ctx.fillRect(x, y, cellSize, cellSize);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // GDD 12.3/12.4: board-wide gold flash for near-miss/big-clear rewards and
  // milestone celebrations -- #F4C430 at up to 25% alpha, distinct from the
  // per-color clear flash above (that one tints with the clearing piece's
  // own color; this one is always literal gold, the "reward" signal).
  if (goldFlash) {
    const life = 1 - (vnow() - goldFlash.startedAt) / goldFlash.duration;
    if (life <= 0) {
      goldFlash = null;
    } else {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, life)) * 0.25;
      ctx.fillStyle = GOLD;
      ctx.fillRect(layout.gridX, layout.gridY, BOARD_SIZE * cellSize, BOARD_SIZE * cellSize);
      ctx.restore();
    }
  }

  // GDD 12.2/7: shards arcing from the cleared line to their shard-queue slot.
  if (shardArcs.length > 0) drawShardArcs();

  // --- drop preview ---
  if (drag) {
    const { rows, cols } = shapeExtent(drag.piece.shape);
    const target = dragTargetCell();
    if (target) {
      const ok = canPlaceAt(state.board, drag.piece.shape, target.r, target.c);
      ctx.fillStyle = ok ? 'rgba(46,204,113,0.35)' : 'rgba(231,76,60,0.35)';
      ctx.strokeStyle = ok ? '#2ecc71' : '#e74c3c';
      ctx.lineWidth = 2;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let anyOnBoard = false;
      for (const [dr, dc] of drag.piece.shape) {
        const rr = target.r + dr, cc = target.c + dc;
        if (rr < 0 || rr >= BOARD_SIZE || cc < 0 || cc >= BOARD_SIZE) continue;
        const x = layout.gridX + cc * cellSize;
        const y = layout.gridY + rr * cellSize;
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.strokeRect(x, y, cellSize, cellSize);
        anyOnBoard = true;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + cellSize); maxY = Math.max(maxY, y + cellSize);
      }
      // Non-color valid/invalid cue, extending the SAME pattern already used
      // for the overflow tray slot (border color + a non-color glyph) rather
      // than inventing a new one -- a checkmark/X shape reads as valid vs
      // invalid regardless of whether the green/red border hues themselves
      // are distinguishable to the viewer.
      if (anyOnBoard) {
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        ctx.fillStyle = ok ? '#2ecc71' : '#e74c3c';
        ctx.font = `bold ${Math.round(Math.min(cellSize * 0.9, 28))}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ok ? '✓' : '✕', cx, cy + 1);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '11px -apple-system, sans-serif';
      }
    }
  }

  // --- tray row ---
  ctx.fillStyle = t.muted;
  ctx.fillText('Tray', GAP, layout.trayY - 4);
  const trayStartX = (layout.width - layout.trayRowW) / 2;
  let overflowCalloutAnchor = null;
  for (let i = 0; i < state.tray.length; i++) {
    const x = trayStartX + i * (TRAY_SLOT_W + 8);
    const y = layout.trayY;
    const isDragged = drag && drag.trayIndex === i;
    const piece = state.tray[i];
    // Overflow slot highlighted: either a temporary extra slot beyond base
    // size 3, or a regular slot currently holding a shard that force-landed
    // there via overflow escalation (the common case -- see core.js
    // insertShard's arrivedViaOverflow tag).
    const isOverflowSlot = i >= TRAY_BASE_SIZE || (piece && piece.arrivedViaOverflow);
    if (isOverflowSlot) overflowCalloutAnchor = { x, y };
    ctx.strokeStyle = isOverflowSlot ? t.accent : t.border;
    ctx.setLineDash(state.tray[i] ? [] : [4, 3]);
    roundRect(x, y, TRAY_SLOT_W, TRAY_SLOT_H, 8);
    ctx.stroke();
    ctx.setLineDash([]);
    if (isOverflowSlot) {
      // Non-color cue alongside the yellow border, for colorblind
      // accessibility (flagged as optional-but-cheap in the design doc).
      ctx.fillStyle = t.accent;
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('⚠', x + TRAY_SLOT_W - 16, y + 3); // warning triangle glyph
    }
    if (piece && !isDragged) {
      const ext = shapeExtent(piece.shape);
      const sub = Math.floor((TRAY_SLOT_W - 16) / Math.max(ext.cols, 1));
      const subH = Math.floor((TRAY_SLOT_H - 16) / Math.max(ext.rows, 1));
      const s = Math.min(sub, subH, 18);
      const ox = x + (TRAY_SLOT_W - ext.cols * s) / 2;
      // GDD 12.6: gentle 2px vertical bob, staggered per tray slot, while a
      // piece awaits placement -- applied to the piece art only, not the
      // slot outline, so the fixed slot border stays a stable drop target.
      const oy = y + (TRAY_SLOT_H - ext.rows * s) / 2 + trayBobOffsetFor(i);
      // No text label here anymore -- the shard's chip silhouette (see
      // drawPieceGrid) is the actual legibility signal now, not a fallback
      // "shard" caption. Keeping the label would have masked whether the
      // silhouette alone actually reads as a fragment.
      drawPieceGrid(piece.shape, piece.color, ox, oy, s, piece.isShard, piece.shapeId);
    }
  }

  // --- dragged piece follows pointer, drawn on top ---
  if (drag) {
    const ext = shapeExtent(drag.piece.shape);
    const s = cellSize;
    const ox = drag.x - (ext.cols * s) / 2;
    const oy = drag.y - (ext.rows * s) / 2 - dragVisualLift(); // lifted above finger on touch
    ctx.globalAlpha = 0.95;
    drawPieceGrid(drag.piece.shape, drag.piece.color, ox, oy, s, drag.piece.isShard, drag.piece.shapeId);
    ctx.globalAlpha = 1;
  }

  // --- Section 5b: non-blocking pulse callouts, drawn last (on top) -------
  // Never intercepts pointer input (pure canvas drawing, no hit-testing
  // added anywhere) and auto-dismisses after CALLOUT_DURATION_MS.
  for (const callout of activeCallouts) {
    if (callout.type === 'first-shard') {
      // Anchored to the existing shard-queue row.
      drawCallout(callout.text, GAP, layout.queueY + QUEUE_SLOT + 4);
    } else if (callout.type === 'first-overflow') {
      // Anchored to the existing yellow-highlighted overflow tray slot; if
      // that slot has already cycled out of the tray by render time, fall
      // back to the tray row itself so the callout never silently vanishes.
      const anchor = overflowCalloutAnchor || { x: trayStartX, y: layout.trayY };
      drawCallout(callout.text, anchor.x, anchor.y - 28);
    } else if (callout.type === 'wave') {
      // Endless-mode difficulty wave telegraph — anchored above the board
      // grid, centered, same non-blocking pulse pattern as the onboarding
      // callouts above.
      drawCallout(callout.text, layout.gridX + (BOARD_SIZE * cellSize) / 2, layout.gridY - 12, 'center');
    }
  }
  // --- combo / whole-field affirmation banner + confetti, drawn last of all
  drawConfetti();
  drawCenterBursts();

  ctx.restore(); // pairs with the ctx.save()/translate(shake) at the top of draw()
}

function dragTargetCell() {
  if (!drag) return null;
  const ext = shapeExtent(drag.piece.shape);
  const s = cellSize;
  // Keyed to the same lifted position the piece is rendered at (see
  // dragVisualLift/TOUCH_VISUAL_LIFT) so placement matches what the player
  // sees, not the finger underneath it -- players aim by the visible piece.
  const ox = drag.x - (ext.cols * s) / 2;
  const oy = drag.y - (ext.rows * s) / 2 - dragVisualLift();
  const c = Math.round((ox - layout.gridX) / s);
  const r = Math.round((oy - layout.gridY) / s);
  return { r, c };
}

function pointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  // Scale by the LOGICAL layout size, not canvas.width/height -- those are
  // now physical-pixel (devicePixelRatio-scaled) quantities, while every
  // other coordinate in this file (layout.gridX, drag.x, etc.) is in the
  // same logical/CSS-pixel space as layout.width. Using canvas.width here
  // would silently multiply every pointer coordinate by dpr again.
  const scaleX = layout.width / rect.width;
  const scaleY = layout.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function trayIndexAt(x, y) {
  const trayStartX = (layout.width - layout.trayRowW) / 2;
  if (y < layout.trayY || y > layout.trayY + TRAY_SLOT_H) return -1;
  for (let i = 0; i < state.tray.length; i++) {
    const sx = trayStartX + i * (TRAY_SLOT_W + 8);
    if (x >= sx && x <= sx + TRAY_SLOT_W) return i;
  }
  return -1;
}

canvas.addEventListener('pointerdown', (e) => {
  unlockAudio(); // must run from a real user-gesture handler; safe to call every time
  startBgm(); // no-ops if already running
  if (state.gameOver) return;
  if (isPaused) return; // GDD 11: "all animations, shard motion, and input on pieces frozen" while paused
  const p = pointFromEvent(e);
  const idx = trayIndexAt(p.x, p.y);
  if (idx >= 0 && state.tray[idx]) {
    drag = { trayIndex: idx, piece: state.tray[idx], x: p.x, y: p.y, pointerType: e.pointerType };
    canvas.setPointerCapture(e.pointerId);
    draw();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = pointFromEvent(e);
  drag.x = p.x;
  drag.y = p.y;
  draw();
});

// Shared by real pointer input (endDrag below) AND the __fractureDebug QA
// hook, so an automated test driving placement through the debug hook
// exercises the exact same juice/effects path a real drag-drop does instead
// of silently bypassing it (a real gap this pass found: the debug hook used
// to call core.js's placePiece directly and skip every trigger* call below).
function performPlacement(trayIndex, targetR, targetC) {
  const piece = state.tray[trayIndex];
  const scoreBefore = state.score;
  const queueLenBefore = state.shardQueue.length;
  const res = placePiece(state, trayIndex, targetR, targetC);
  if (res.ok) {
      // GDD 12.1/12.2: drop-in + squash-and-settle for the just-landed cells.
      triggerLandingAnim(piece.shape, targetR, targetC);
      // Landing flash for the piece that just landed on the board -- do this
      // BEFORE refreshChrome/clear-line flash so a placement that both lands
      // and immediately clears shows both effects, land first.
      triggerLandFlash(piece.shape, targetR, targetC, piece.color);
      if (res.lineCount > 0) {
        // GDD 12.3: "big-clear" reward = clears >=3 lines at once OR leaves
        // the board nearly empty (<=2 occupied cells after the clear).
        let occupiedAfter = 0;
        for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) if (state.board[r][c]) occupiedAfter++;
        const bigClear = res.lineCount >= 3 || occupiedAfter <= 2;

        triggerClearFlash(res.rows, res.cols, piece.color);
        playLineClear(res.lineCount);

        // GDD 12.2/7: arc the newly-generated shards from the cleared line
        // out to their shard-queue slot. Only covers shards that actually
        // landed in the visible queue (queueLenBefore..now) -- an overflow
        // shard force-inserted straight into the tray has no queue slot to
        // arc into, so it's skipped here (core.js's own tray-insert already
        // handles that path; this is cosmetic-only and never re-derives
        // queue/tray placement).
        const newlyQueued = Math.max(0, state.shardQueue.length - queueLenBefore);
        if (newlyQueued > 0) {
          const bx = layout.gridX, by = layout.gridY;
          const points = [];
          for (const r of res.rows) points.push({ x: bx + (BOARD_SIZE * cellSize) / 2, y: by + r * cellSize + cellSize / 2 });
          for (const c of res.cols) points.push({ x: bx + c * cellSize + cellSize / 2, y: by + (BOARD_SIZE * cellSize) / 2 });
          const srcX = points.reduce((s, p) => s + p.x, 0) / points.length;
          const srcY = points.reduce((s, p) => s + p.y, 0) / points.length;
          const targets = [];
          for (let i = 0; i < newlyQueued; i++) {
            const qi = queueLenBefore + i;
            targets.push({ x: GAP + qi * (QUEUE_SLOT + 8) + QUEUE_SLOT / 2, y: layout.queueY + QUEUE_SLOT / 2 });
          }
          triggerShardArcs(srcX, srcY, targets, piece.color, bigClear);
        }
        if (res.shardCount > 0) playShardScatter(res.shardCount);

        if (bigClear) {
          // GDD 12.3/12.4: gold flash + zoom pulse (3+ lines) as the reward
          // signal for a big/near-empty clear; the game-over shake stays
          // reserved for death (GDD 12.4's table pairs shake with game-over
          // specifically, not clears -- see triggerDeathSequence).
          triggerGoldFlash();
          if (res.lineCount >= 3) triggerZoomPulse();
        }
        if (res.wholeFieldClear) {
          triggerCenterBurst('PERFECT CLEAR!', 'perfect', res.comboStreak);
          playPerfectClearVoice();
        } else if (res.comboStreak >= 2) {
          triggerCenterBurst(comboAffirmationText(res.comboStreak), 'combo', res.comboStreak);
          playComboVoice(res.comboStreak);
        }
      }
      checkMilestone(scoreBefore, state.score); // GDD 12.7
      refreshChrome();
  }
  return res;
}

function endDrag(e) {
  if (!drag) return;
  // Re-sample the pointer position from the pointerup event itself rather
  // than trusting drag.x/y left over from the last pointermove. If a
  // resize/orientation-change fires between the last move and this release
  // with no intervening pointer movement, layout/rect/DPR may have changed
  // and the stale coordinates would compute a drop cell against the old
  // geometry. See issue #1.
  if (e && typeof e.clientX === 'number') {
    const p = pointFromEvent(e);
    drag.x = p.x;
    drag.y = p.y;
  }
  const target = dragTargetCell();
  const trayIndex = drag.trayIndex;
  drag = null;
  if (target) performPlacement(trayIndex, target.r, target.c);
  draw();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { drag = null; draw(); });

function refreshChrome() {
  scoreVal.textContent = state.score;
  const waveTier = state.onboarding ? state.onboarding.waveTier : 0;
  if (waveTier > 0) {
    waveVal.textContent = waveTier;
    waveLine.classList.add('show');
  } else {
    waveLine.classList.remove('show');
  }
  // Wave color palette (index.html [data-wave-tier] blocks) + sound pack
  // (audio.js WAVE_SOUND_PACKS) both key off the same tier, so a single
  // assignment here keeps them in lockstep -- cheap to set every refresh
  // since both are no-ops when the tier hasn't actually changed.
  document.documentElement.dataset.waveTier = String(waveTier);
  setWaveTier(waveTier);
  // append only new log lines (only bother touching the DOM panel if it's
  // actually visible -- dev-only, see DEBUG_LOG_PANEL above)
  if (DEBUG_LOG_PANEL) {
    for (; lastLogLen < state.log.length; lastLogLen++) {
      const line = state.log[lastLogLen];
      const div = document.createElement('div');
      if (line.startsWith('OVERFLOW')) div.className = 'warn';
      if (line.startsWith('GAME OVER')) div.className = 'over';
      div.textContent = line;
      logEl.appendChild(div);
    }
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    lastLogLen = state.log.length;
  }
  // Best-score persistence (task 3): update as soon as the running score
  // beats it, not only at game-over, so "Best: X" in the header stays live
  // during play too, matching how "Score: X" already updates live.
  if (state.score > bestScore) {
    bestScore = state.score;
    writeBestScore(bestScore);
    beatBestThisGame = true;
  }
  bestVal.textContent = bestScore;
  if (state.gameOver) {
    finalScoreEl.textContent = `Final score: ${state.score}`;
    if (beatBestThisGame) {
      bestDeltaEl.textContent = 'New Best!';
      bestDeltaEl.classList.add('new-best');
    } else {
      const short = bestScore - state.score;
      bestDeltaEl.textContent = short > 0 ? `${short} short of best (${bestScore})` : `Best: ${bestScore}`;
      bestDeltaEl.classList.remove('new-best');
    }
    // GDD 12.8: desaturate -> shake -> freeze-frame (~600ms total) BEFORE the
    // Game Over panel becomes interactive/visible -- guarded so a second
    // refreshChrome() call while already game-over (e.g. quitGame() ->
    // refreshChrome(), or a resumed already-over save) can't restart or
    // double-fire the sequence.
    if (!deathSequenceStarted) {
      deathSequenceStarted = true;
      playGameOver();
      triggerDeathSequence(() => {
        overlay.classList.add('show');
      });
    }
  }
  ingestPendingCallouts(state);
  persistOnboardingFlags(state);
  // A finished run (game-over or an explicit quit, which sets the same
  // flag) is no longer resumable, so drop the save; otherwise keep it fresh
  // so closing the tab mid-game doesn't lose progress.
  if (state.gameOver) clearSavedGameState();
  else saveGameState(state);
  computeLayout(); // tray length can grow via overflow escalation
}

function quitGame() {
  if (state.gameOver) return;
  if (!confirm('Quit this game? Your current run will end and show the Game Over screen.')) return;
  state.gameOver = true;
  refreshChrome();
  draw();
}

function newGame() {
  state = newGameState();
  activeCallouts = [];
  boardFlashes = [];
  shake = null;
  landingAnims = new Map();
  shardArcs = [];
  goldFlash = null;
  zoomPulse = null;
  deathSeq = null;
  deathTickerRunning = false;
  deathSequenceStarted = false;
  lastMilestoneReached = 0;
  beatBestThisGame = false;
  lastLogLen = 0;
  logEl.replaceChildren();
  overlay.classList.remove('show');
  bestDeltaEl.classList.remove('new-best');
  scoreVal.classList.remove('milestone-pop');
  scoreVal.textContent = '0';
  bestVal.textContent = bestScore;
  waveLine.classList.remove('show');
  submitStatusEl.textContent = '';
  submitScoreBtn.disabled = false;
  saveGameState(state);
  computeLayout();
  startIdleTicker();
  draw();
}

newGameBtn.addEventListener('click', newGame);
restartBtn.addEventListener('click', newGame);
quitBtn.addEventListener('click', quitGame);
window.addEventListener('resize', () => { computeLayout(); draw(); });

// ---- online leaderboard (Supabase) ------------------------------------
// leaderboard.js is DOM-free and network-agnostic; all UI/state wiring
// lives here, matching the persistence-ownership split main.js already
// uses for onboarding flags and bestScore.
nameInput.value = readPlayerName();

async function renderLeaderboard() {
  leaderboardListEl.replaceChildren();
  const rows = await fetchTopScores(10);
  if (!rows) {
    const li = document.createElement('li');
    li.textContent = 'Leaderboard unavailable';
    leaderboardListEl.appendChild(li);
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    if (i < 3) li.classList.add(`rank-${i + 1}`);
    const icon = document.createElement('span');
    icon.className = 'rank-icon';
    icon.textContent = i < 3 ? medals[i] : String(i + 1);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.name;
    const score = document.createElement('span');
    score.textContent = row.score;
    li.append(icon, name, score);
    leaderboardListEl.appendChild(li);
  });
}

renderLeaderboard(); // sidebar is always visible, so populate it on load

submitScoreBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) {
    submitStatusEl.textContent = 'Enter a name first.';
    return;
  }
  writePlayerName(name);
  submitScoreBtn.disabled = true;
  submitStatusEl.textContent = 'Submitting…';
  const ok = await submitScore(name, state.score);
  submitStatusEl.textContent = ok ? 'Submitted!' : 'Could not submit score.';
  if (!ok) submitScoreBtn.disabled = false;
  else renderLeaderboard(); // reflect the new score immediately
});

// QA/automation hook only -- inert for normal play, lets an external test
// script (e.g. Playwright) reach past RNG to drive specific scenarios
// (shard queue fill, overflow escalation, game-over) through the exact same
// placePiece/refreshChrome/draw code path real play uses.
window.__fractureDebug = {
  getState: () => state,
  // Routes through the SAME performPlacement() real drag-drop uses (not a
  // bare core.js placePiece() call) so an automated test driving placement
  // via this hook exercises the real juice/effects path (squash-settle,
  // clear flash, shard arcs, milestone pop, etc.), not just the underlying
  // game-state mutation.
  placePiece: (idx, r, c) => { const res = performPlacement(idx, r, c); draw(); return res; },
  redraw: () => draw(),
  // GDD 10/11 pause/resume test hook -- lets an automated test toggle pause
  // deterministically instead of dispatching synthetic keydown events.
  setPaused: (v) => setPaused(v),
  isPaused: () => isPaused,
  triggerCenterBurst: (text, kind, level) => triggerCenterBurst(text, kind, level),
  // exact canvas-space geometry, so an external test driver doesn't have to
  // guess proportional coordinates for real pointer-drag simulation.
  geometry: () => {
    const trayStartX = (layout.width - layout.trayRowW) / 2;
    return {
      canvasWidth: layout.width,
      canvasHeight: layout.height,
      traySlotCenter: (i) => ({ x: trayStartX + i * (TRAY_SLOT_W + 8) + TRAY_SLOT_W / 2, y: layout.trayY + TRAY_SLOT_H / 2 }),
      gridCellCenter: (r, c) => ({ x: layout.gridX + c * cellSize + cellSize / 2, y: layout.gridY + r * cellSize + cellSize / 2 }),
    };
  },
};

// Reflect a resumed in-progress run's score immediately (a fresh game is
// already 0, so this is a no-op in that case).
scoreVal.textContent = state.score;
bestVal.textContent = bestScore;
lastMilestoneReached = Math.floor(state.score / MILESTONE_INTERVAL); // resumed run: don't re-celebrate milestones already passed
computeLayout();
draw();
if (!state.gameOver) startIdleTicker(); // GDD 12.6: idle shimmer + tray bob
