// Fracture — procedural sound effects via the Web Audio API.
//
// No third-party asset licensing (same "no external asset pipeline" pattern
// as the Style C sprite bake in main.js): every sound here is synthesized at
// runtime from oscillators/noise, nothing is loaded from a file.
//
// Palette brief (game-asset-director): glassy/crystalline -- bright,
// short-decay, slightly inharmonic bell/FM tones matching the shard/fracture
// visual theme. Explicitly NOT wood/thud. Achieved by:
//   - inharmonic partials (frequency ratios that are NOT small integers, e.g.
//     1x/2.4x/3.8x instead of a harmonic 1x/2x/3x stack) -- this is what
//     makes FM/additive bells sound metallic/glassy rather than
//     woodwind/string-like.
//   - fast exponential decay envelopes (short sustain, no long resonant
//     tail) for the "short-decay" brief.
//   - triangle/sine oscillators (no sawtooth/square, which read as
//     buzzy/electronic rather than bell-like).
//
// Autoplay-policy aware: browsers block AudioContext until a user gesture.
// This module lazily creates/resumes the context on first call from an
// input handler (pointerdown already exists in main.js), never at module
// load time.

let ctx = null;
let sfxGain = null;
let bgmGain = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null; // unsupported browser -- fail silent, never crash the game over audio
    ctx = new AC();
    // Two independent volume buses so sfx/bgm sliders don't fight each
    // other -- both feed ctx.destination, nothing bypasses them.
    sfxGain = ctx.createGain();
    sfxGain.gain.value = sfxVolume;
    sfxGain.connect(ctx.destination);
    bgmGain = ctx.createGain();
    bgmGain.gain.value = bgmVolume;
    bgmGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

let muted = false;
export function setMuted(v) { muted = v; }
export function isMuted() { return muted; }

// ---- volume buses -----------------------------------------------------
// Persisted separately from `muted` (a full mute toggle, if the game ever
// grows one) so a volume of 0 and "muted" are distinct concepts, matching
// how the settings panel presents them as two independent sliders.
const LS_KEY_SFX_VOLUME = 'fracture.sfxVolume';
const LS_KEY_BGM_VOLUME = 'fracture.bgmVolume';

function loadVolume(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
  } catch { return fallback; }
}

let sfxVolume = loadVolume(LS_KEY_SFX_VOLUME, 0.8);
let bgmVolume = loadVolume(LS_KEY_BGM_VOLUME, 0.5);

export function setSfxVolume(v) {
  sfxVolume = Math.max(0, Math.min(1, v));
  if (sfxGain) sfxGain.gain.value = sfxVolume;
  try { localStorage.setItem(LS_KEY_SFX_VOLUME, String(sfxVolume)); } catch { /* ignore (private mode, etc.) */ }
}
export function getSfxVolume() { return sfxVolume; }

export function setBgmVolume(v) {
  bgmVolume = Math.max(0, Math.min(1, v));
  if (bgmGain) bgmGain.gain.value = bgmVolume;
  try { localStorage.setItem(LS_KEY_BGM_VOLUME, String(bgmVolume)); } catch { /* ignore (private mode, etc.) */ }
}
export function getBgmVolume() { return bgmVolume; }

// ---- endless-mode wave sound packs -----------------------------------------
// Same escalation as the wave color palettes in index.html: each tier detunes
// the bell partials a little further from the clean glassy default and drops
// the base pitch, so waves read as progressively heavier/grittier without
// leaving the "glassy, not thud" brief (no ratio ever collapses to a small
// integer, which would read as harmonic/wood instead of inharmonic/glass).
const WAVE_SOUND_PACKS = [
  { partialRatios: [1.0, 2.41, 3.83], pitchMult: 1.0 },   // tier 0: default
  { partialRatios: [1.0, 2.32, 3.71], pitchMult: 0.97 },  // tier 1
  { partialRatios: [1.0, 2.19, 3.52], pitchMult: 0.94 },  // tier 2
  { partialRatios: [1.0, 2.05, 3.28], pitchMult: 0.9 },   // tier 3
  { partialRatios: [1.0, 1.87, 2.96], pitchMult: 0.85 },  // tier 4
];

let waveTier = 0;
export function setWaveTier(tier) {
  waveTier = Math.max(0, Math.min(tier, WAVE_SOUND_PACKS.length - 1));
}
function soundPack() { return WAVE_SOUND_PACKS[waveTier]; }

// One inharmonic bell/FM "chip" voice: a carrier tone plus a couple of
// non-integer-ratio partials, each with its own fast decay, mixed to a
// shared gain node with a short master envelope. `baseFreq` in Hz,
// `duration` in seconds, `gain` peak linear gain (kept low -- several of
// these can stack in a fast combo).
function playBell(baseFreq, duration, gain, when = 0, bus = null) {
  const ac = getCtx();
  if (!ac || muted) return;
  const outBus = bus || sfxGain;
  const t0 = ac.currentTime + when;
  const master = ac.createGain();
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(gain, t0 + 0.006);
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  master.connect(outBus);

  // Inharmonic partial ratios -- deliberately not 1/2/3 (that would sound
  // like a harmonic/organ tone) so this reads as glass/metal, not wood/string.
  // Ratios and base-pitch multiplier come from the current wave sound pack
  // (see WAVE_SOUND_PACKS above) so effects grow heavier as waves escalate.
  const pack = soundPack();
  const mixes = [1.0, 0.5, 0.28];
  const partials = pack.partialRatios.map((ratio, i) => ({ ratio, mix: mixes[i] }));
  const pitchedFreq = baseFreq * pack.pitchMult;
  for (const p of partials) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitchedFreq * p.ratio, t0);
    const partialGain = ac.createGain();
    partialGain.gain.setValueAtTime(p.mix, t0);
    // Each partial decays slightly faster than the last (higher partials die
    // first) -- a classic bell-synthesis trick, gives the short-decay,
    // "chime" character instead of one flat mono-decay tone.
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration * (1 - p.ratio * 0.08));
    osc.connect(partialGain);
    partialGain.connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }
}

// Short filtered-noise "scatter" tick -- a burst of white noise through a
// bandpass filter reads as a glassy/granular tick rather than a thud (which
// would instead use a lowpass-swept noise burst with a much longer tail).
function playNoiseTick(freq, duration, gain, when = 0) {
  const ac = getCtx();
  if (!ac || muted) return;
  const t0 = ac.currentTime + when;
  const bufSize = Math.ceil(ac.sampleRate * duration);
  const buf = ac.createBuffer(1, bufSize, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(freq, t0);
  filter.Q.value = 6;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter);
  filter.connect(g);
  g.connect(sfxGain);
  src.start(t0);
  src.stop(t0 + duration + 0.02);
}

// ---- public effect API ------------------------------------------------------

// Line clear: pitch rises with combo size (1..4+ lines) so bigger clears
// read as more rewarding, capped so it never scrapes crazy-high with
// extreme combos. `lineCount` from placePiece's additive return field.
export function playLineClear(lineCount) {
  const n = Math.max(1, Math.min(lineCount, 4));
  const baseFreq = 660 * Math.pow(1.19, n - 1); // ~major-third-ish step per extra line
  playBell(baseFreq, 0.55, 0.22);
  if (n >= 3) {
    // Extra shimmering high partial stacked on top for 3+ line combos --
    // the "juice" cue for a big clear, still bell-timbred (not a separate
    // sound family).
    playBell(baseFreq * 2.0, 0.4, 0.12, 0.05);
  }
}

// Shard scatter: one bright noise tick per shard cell landing, staggered a
// few ms apart so multiple shards read as a granular "scatter" rather than
// one simultaneous blob.
export function playShardScatter(shardCount) {
  const count = Math.max(1, shardCount);
  for (let i = 0; i < count; i++) {
    playNoiseTick(2400 + i * 260, 0.12, 0.16, i * 0.045);
    playBell(1400 + i * 180, 0.18, 0.08, i * 0.045);
  }
}

// Game-over stinger: a short descending inharmonic bell figure -- still
// glassy (never a low wood/thud "game over" cliche).
export function playGameOver() {
  playBell(520, 0.5, 0.22, 0);
  playBell(390, 0.6, 0.2, 0.14);
  playBell(260, 0.9, 0.22, 0.3);
}

// Combo/perfect-clear "voice": since we can't use recorded VO without
// breaking the no-external-asset-files rule (see file header), the "Nice!
// x2 Combo" / "PERFECT CLEAR!" banners get an excited procedural stand-in
// instead of silence -- a short rising arpeggio, same bell voice as
// playLineClear, that adds more notes and climbs higher/faster as the
// streak grows so a big combo *sounds* like a bigger deal, not just looks
// like one.
const COMBO_ARP_RATIOS = [1.0, 1.26, 1.5, 1.89, 2.0]; // major-ish steps, capped at an octave
export function playComboVoice(streak) {
  const notes = Math.max(1, Math.min(streak - 1, COMBO_ARP_RATIOS.length));
  const baseFreq = 520 * (1 + Math.min(streak, 6) * 0.03); // pitches up slightly with streak too
  const gap = Math.max(0.045, 0.09 - streak * 0.006); // notes rattle off faster on bigger combos
  for (let i = 0; i < notes; i++) {
    playBell(baseFreq * COMBO_ARP_RATIOS[i], 0.32, 0.16, i * gap);
    // Sparkle layer: a quiet high-octave bell + a bright noise tick riding
    // just behind each arpeggio note -- this is what reads as "festive"
    // (glitter/chime) rather than a plain single-voice arpeggio. Scales up
    // with streak so a bigger combo gets noticeably more sparkle, not just
    // a higher pitch.
    const sparkleAmount = Math.min(streak, 6) / 6;
    playBell(baseFreq * COMBO_ARP_RATIOS[i] * 4.0, 0.18, 0.05 + 0.05 * sparkleAmount, i * gap + 0.02);
    playNoiseTick(5200 + i * 340, 0.07, 0.05 + 0.05 * sparkleAmount, i * gap + 0.015);
  }
  // Big combos (4+) get a final "ta-da" shimmer flourish -- a quick upward
  // flurry of high sparkle ticks after the arpeggio finishes, distinct from
  // the per-note sparkle above so a big streak has a clear capstone moment.
  if (streak >= 4) {
    const flourishStart = notes * gap + 0.1;
    for (let i = 0; i < 5; i++) {
      playNoiseTick(6000 + i * 500, 0.09, 0.09, flourishStart + i * 0.03);
      playBell(baseFreq * (3.0 + i * 0.5), 0.22, 0.07, flourishStart + i * 0.03);
    }
  }
}

// Perfect clear: the full arpeggio plus a shimmering high octave doubling,
// the "biggest reward" sound in the game.
export function playPerfectClearVoice() {
  playComboVoice(COMBO_ARP_RATIOS.length + 1);
  playBell(520 * 4, 0.5, 0.1, 0.25);
}

// ---- background music --------------------------------------------------
// A slow generative ambient loop, same synthesis toolkit (inharmonic sine
// partials) as the sfx bell voice but soft/long-decay instead of a short
// "chime" -- reads as a sustained glassy pad rather than another sfx hit.
// Notes are drawn from a pentatonic-ish scale (no dissonant clashes however
// they land) and scheduled ahead of `ac.currentTime` using a classic
// look-ahead scheduler so timing survives tab-throttled setTimeout jitter.
const BGM_SCALE = [261.63, 293.66, 329.63, 392.0, 440.0]; // C D E G A -- open, ambient, no leading tone
const BGM_NOTE_MIN_GAP = 2.2;
const BGM_NOTE_MAX_GAP = 4.2;
const BGM_LOOKAHEAD = 2.0; // seconds of schedule to keep queued

function playPad(freq, duration, gain, when, bus) {
  const ac = getCtx();
  if (!ac) return;
  const t0 = ac.currentTime + when;
  const master = ac.createGain();
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(gain, t0 + duration * 0.3);
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  master.connect(bus);
  const ratios = [1.0, 2.01, 3.0]; // near-harmonic -- softer/rounder than the sfx bell's inharmonic ratios
  for (const ratio of ratios) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * ratio, t0);
    const partialGain = ac.createGain();
    partialGain.gain.setValueAtTime(1 / ratios.length, t0);
    osc.connect(partialGain);
    partialGain.connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.1);
  }
}

let bgmTimer = null;
let bgmNextNoteAt = 0;

function scheduleBgmNotes() {
  const ac = getCtx();
  if (!ac || !bgmGain) return;
  while (bgmNextNoteAt < ac.currentTime + BGM_LOOKAHEAD) {
    const freq = BGM_SCALE[Math.floor(Math.random() * BGM_SCALE.length)] * (Math.random() < 0.5 ? 1 : 0.5);
    const duration = 2.6 + Math.random() * 1.4;
    playPad(freq, duration, 0.16, bgmNextNoteAt - ac.currentTime, bgmGain);
    bgmNextNoteAt += BGM_NOTE_MIN_GAP + Math.random() * (BGM_NOTE_MAX_GAP - BGM_NOTE_MIN_GAP);
  }
  bgmTimer = setTimeout(scheduleBgmNotes, 500);
}

// Starts the generative bgm loop. Safe to call repeatedly (no-ops if already
// running); must run after unlockAudio()/a user gesture like the sfx voices.
export function startBgm() {
  const ac = getCtx();
  if (!ac || bgmTimer) return;
  bgmNextNoteAt = ac.currentTime + 0.2;
  scheduleBgmNotes();
}

export function stopBgm() {
  if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null; }
}

// Called once from a real user-gesture handler (pointerdown) to unlock audio
// on browsers that block AudioContext until a gesture occurs. Safe to call
// repeatedly.
export function unlockAudio() {
  getCtx();
}

// ---- tab visibility recovery --------------------------------------------
// Browsers auto-suspend the AudioContext (and heavily throttle setTimeout)
// when a tab is backgrounded, to save power. getCtx() already resumes the
// context lazily on the next sfx call, so one-shot sfx recover on their own
// the moment the player interacts again. But bgm doesn't wait for a gesture:
// its own look-ahead scheduler (scheduleBgmNotes' setTimeout loop) stalls
// while hidden, and `bgmNextNoteAt` is left far in the past. Left alone,
// returning to the tab would either play nothing (context stuck suspended,
// nothing ever calls getCtx() again) or dump a stale backlog of notes all
// at once (bgmNextNoteAt catching up instantly). This listener explicitly
// resumes the context and re-anchors the schedule to "now" on return.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const ac = getCtx(); // resumes if suspended
    if (!ac) return;
    if (bgmTimer) {
      // Re-anchor instead of leaving stale timestamps -- otherwise the
      // lookahead loop in scheduleBgmNotes would see bgmNextNoteAt far in
      // the past and fire a burst of overdue notes back-to-back.
      bgmNextNoteAt = ac.currentTime + 0.2;
    }
  });
}
