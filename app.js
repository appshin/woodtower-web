/* WoodTower — web test build.
 * The game rules, stability model and friction model are a 1:1 port of the
 * Android sources, so numbers tuned here transfer straight into Kotlin.
 * Deliberate differences are marked WEB-ONLY.
 */
'use strict';

// ---------------------------------------------------------------- utilities
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Deterministic PRNG. Host ships the seed so every screen collapses alike. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randSeed = () => (Math.random() * 0x7fffffff) | 0;

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('on'));
  $(id).classList.add('on');
}

// ------------------------------------------------------------- tower model
const BASE_LEVELS = 18;
const SLOTS = 3;

const axisOf = (level) => (level % 2 === 0 ? 'X' : 'Z');

function freshTower() {
  const blocks = [];
  let id = 0;
  for (let l = 0; l < BASE_LEVELS; l++)
    for (let s = 0; s < SLOTS; s++) blocks.push({ id: id++, level: l, slot: s });
  return { blocks, nextId: id };
}

const topLevel = (t) => t.blocks.reduce((m, b) => Math.max(m, b.level), 0);
const levelBlocks = (t, l) => t.blocks.filter((b) => b.level === l);

/** No block from the top level, nor from the one below while the top is short. */
function forbiddenLevels(t) {
  const top = topLevel(t);
  return levelBlocks(t, top).length === SLOTS ? new Set([top]) : new Set([top, top - 1]);
}
const canRemove = (t, b) => !forbiddenLevels(t).has(b.level);

function removeBlock(t, b) {
  return { blocks: t.blocks.filter((x) => x.id !== b.id), nextId: t.nextId };
}

/** The pulled block goes back on top, exactly like the real game. */
function placeOnTop(t) {
  const top = topLevel(t);
  const used = new Set(levelBlocks(t, top).map((b) => b.slot));
  const free = [1, 0, 2].find((s) => !used.has(s));   // players fill the centre first
  const level = free === undefined ? top + 1 : top;
  const slot = free === undefined ? 1 : free;
  return { blocks: t.blocks.concat([{ id: t.nextId, level, slot }]), nextId: t.nextId + 1 };
}

// ----------------------------------------------------------------- physics
const HALF_LEN = 1.5, HALF_W = 0.5;
const slotOffset = (s) => s - 1;

/**
 * For every level, take everything resting above it, find the combined centre
 * of mass, and check it still sits inside the convex hull of what is left on
 * that level. The tightest level sets the tower's margin.
 */
function analyze(t) {
  let worst = 1, leanX = 0, leanZ = 0;
  const top = topLevel(t);
  for (let j = 0; j < top; j++) {
    const above = t.blocks.filter((b) => b.level > j);
    if (!above.length) continue;
    let sx = 0, sz = 0;
    for (const b of above) {
      if (axisOf(b.level) === 'X') sz += slotOffset(b.slot);
      else sx += slotOffset(b.slot);
    }
    const comX = sx / above.length, comZ = sz / above.length;
    const lvl = levelBlocks(t, j);
    if (!lvl.length) return { stable: false, margin: -1, leanX: comX, leanZ: comZ };

    const offs = lvl.map((b) => slotOffset(b.slot));
    const lo = Math.min(...offs) - HALF_W, hi = Math.max(...offs) + HALF_W;
    let minX, maxX, minZ, maxZ;
    if (axisOf(j) === 'X') { minX = -HALF_LEN; maxX = HALF_LEN; minZ = lo; maxZ = hi; }
    else { minX = lo; maxX = hi; minZ = -HALF_LEN; maxZ = HALF_LEN; }

    const mx = Math.min(comX - minX, maxX - comX) / HALF_LEN;
    const mz = Math.min(comZ - minZ, maxZ - comZ) / HALF_LEN;
    const m = Math.min(mx, mz);
    if (m < worst) worst = m;
    if (Math.abs(comX) > Math.abs(leanX)) leanX = comX;
    if (Math.abs(comZ) > Math.abs(leanZ)) leanZ = comZ;
  }
  return { stable: worst > 0, margin: worst, leanX, leanZ };
}

/** Fraction of the tower that has been pulled out and re-stacked on top. */
function fatigueOf(t) {
  return t.blocks.filter((b) => b.level >= BASE_LEVELS).length / Math.max(1, t.blocks.length);
}

/**
 * Tuned against 2500 simulated games with a human-like policy (never leave a
 * lone outer block, prefer centres): mean 22 pulls, median 25, 1.5% first-move
 * collapses. A linear map off `margin` was far too punishing -- a single outer
 * pull from a full level drops margin to 0.333, which is perfectly safe in the
 * real game, so the curve has to stay flat above ~0.30 and then bite hard.
 */
function collapseChance(a, jerk, fatigue) {
  if (!a.stable) return 1;
  const u = clamp((0.30 - a.margin) / 0.30, 0, 1);
  const structural = Math.pow(u, 1.7);
  return clamp(structural * 0.80 + jerk * structural * 0.35 + jerk * 0.03 + 0.06 * (fatigue || 0), 0, 0.97);
}

// ---------------------------------------------------------------- friction
/** Weight above is the normal force; side neighbours add stiction. */
function tightnessOf(t, b) {
  const total = Math.max(1, t.blocks.length);
  const above = t.blocks.filter((x) => x.level > b.level).length / total;
  const neighbours = (levelBlocks(t, b.level).length - 1) / 2;
  return clamp(0.18 + 0.52 * above + 0.30 * neighbours, 0, 1);
}
/** Tight wood stores more elastic energy, so it lets go in fewer, bigger jerks. */
const slipDistance = (tight, density) => density * (0.45 + 1.55 * tight);
const slipLengthPx = (tight, levelH) => slipDistance(tight, levelH * 0.16);

// ------------------------------------------------------------------- audio
class Sound {
  constructor() { this.ctx = null; this.enabled = true; this.frictionNode = null; }

  /** Browsers need a user gesture before audio can start. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    this.ctx = new C();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.buf = {
      pop: this._knock(0.16, [[1180, 1, 34], [2270, .55, 46], [3410, .28, 62], [620, .35, 26]], 0.42, 1400),
      place: this._knock(0.24, [[520, 1, 20], [1010, .6, 28], [1830, .3, 40], [2900, .12, 55]], 0.30, 1000),
      tick: this._knock(0.055, [[1620, 1, 95], [2840, .5, 130], [4100, .2, 170]], 0.55, 2600),
      friction: this._friction(),
    };
  }

  /** Wooden block = a few sharp resonant modes + a very short contact transient. */
  _knock(dur, modes, noiseAmp, noiseDecay) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let y = 0;
      for (const [f, a, dec] of modes) y += a * Math.sin(2 * Math.PI * f * t) * Math.exp(-dec * t);
      const nz = (Math.random() * 2 - 1) * Math.exp(-noiseDecay * t) * noiseAmp;
      lp += 0.35 * (nz - lp);
      d[i] = y + lp;
    }
    for (let i = 0; i < 12; i++) d[i] *= i / 12;       // no click at sample 0
    let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < n; i++) d[i] /= peak || 1;
    return buf;
  }

  /** Band-limited noise with a stick-slip envelope, crossfaded so it loops. */
  _friction() {
    const sr = this.ctx.sampleRate, n = sr;   // exactly one second
    const buf = this.ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    const env = new Float32Array(n).fill(0.16);
    for (let g = 0; g < 120; g++) {
      const start = (Math.random() * n) | 0;
      const len = (sr * (0.004 + Math.random() * 0.012)) | 0;
      for (let k = 0; k < len * 6 && k < n; k++) {
        env[(start + k) % n] += (0.5 + Math.random() * 0.5) * Math.exp(-k / len);
      }
    }
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * env[i];
    const fade = 512;                          // hide the loop seam
    for (let i = 0; i < fade; i++) {
      const w = i / fade;
      d[i] = d[i] * w + d[n - fade + i] * (1 - w);
    }
    let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < n; i++) d[i] /= peak || 1;
    return buf;
  }

  _play(buf, vol, rate) {
    if (!this.ctx || !this.enabled) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.playbackRate.value = clamp(rate, 0.5, 2);
    const g = this.ctx.createGain(); g.gain.value = vol;
    s.connect(g); g.connect(this.master); s.start();
  }

  startFriction(tight) {
    if (!this.ctx || !this.enabled || this.frictionNode) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buf.friction; s.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.6;
    const g = this.ctx.createGain(); g.gain.value = 0;
    s.connect(bp); bp.connect(g); g.connect(this.master); s.start();
    this.frictionNode = { s, g };
    this.updateFriction(0, tight);
  }

  /** @param speed px/s. Below ~40 the block is stuck, not sliding: stay silent. */
  updateFriction(speed, tight) {
    if (!this.frictionNode) return;
    const v = clamp((Math.abs(speed) - 40) / 700, 0, 1) * (0.25 + 0.75 * tight);
    const now = this.ctx.currentTime;
    this.frictionNode.g.gain.setTargetAtTime(v * 0.5, now, 0.02);
    this.frictionNode.s.playbackRate.setTargetAtTime(clamp(0.72 + Math.abs(speed) / 1800, 0.5, 2), now, 0.03);
  }

  stopFriction() {
    if (!this.frictionNode) return;
    try { this.frictionNode.s.stop(); } catch (e) { /* already stopped */ }
    this.frictionNode = null;
  }

  slip(tight, rate) { this._play(this.buf.tick, clamp(0.18 + 0.62 * tight, 0, 1), rate); }
  pop(tight) { this._play(this.buf.pop, clamp(0.35 + 0.55 * tight, 0, 1), 0.92 + tight * 0.2); }
  place() { this._play(this.buf.place, 0.75, 0.96 + Math.random() * 0.1); }

  /** WEB-ONLY: the Android build plays one baked 1.9 s clatter; here we scatter knocks live. */
  collapse(seed) {
    if (!this.ctx || !this.enabled) return;
    const rnd = mulberry32(seed);
    const t0 = this.ctx.currentTime;
    for (let i = 0; i < 34; i++) {
      const at = t0 + Math.pow(rnd(), 0.7) * 1.6;
      const s = this.ctx.createBufferSource();
      s.buffer = this.buf.place;
      s.playbackRate.value = 0.75 + rnd() * 0.7;
      const g = this.ctx.createGain(); g.gain.value = 0.25 + rnd() * 0.55;
      s.connect(g); g.connect(this.master); s.start(at);
    }
    const thud = this.ctx.createOscillator(), tg = this.ctx.createGain();
    thud.frequency.value = 68; thud.type = 'sine';
    tg.gain.setValueAtTime(0.5, t0); tg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
    thud.connect(tg); tg.connect(this.master); thud.start(t0); thud.stop(t0 + 0.8);
  }
}

// ----------------------------------------------------------------- haptics
class Haptics {
  constructor() {
    this.enabled = true;
    // WEB-ONLY: no amplitude control anywhere, and iOS Safari has no vibrate at all.
    this.supported = typeof navigator.vibrate === 'function';
  }
  _v(ms) { if (this.enabled && this.supported) navigator.vibrate(ms); }
  grab() { this._v(10); }
  slip(t) { this._v(Math.round(6 + 12 * t)); }   // length stands in for intensity
  pop(t) { this._v(Math.round(18 + 20 * t)); }
  place() { this._v(14); }
  cancel() { this._v(8); }
  collapse() { this._v([0, 30, 20, 45, 25, 60, 30, 70, 40, 90, 45, 120, 60, 160, 80, 220]); }
}

/**
 * Turns a drag into sound + vibration. The whole illusion is one idea:
 * the block does not slide, it *slips*. We integrate travel and fire a paired
 * haptic pulse and audio grain every time it crosses one slip length.
 */
class Feel {
  constructor(sound, haptics) {
    this.sound = sound; this.haptics = haptics;
    this.travel = 0; this.last = 0; this.tight = 0.5; this.slipLen = 10;
  }
  grab(tight, slipLen, ts) {
    this.tight = tight; this.slipLen = Math.max(3, slipLen);
    this.travel = 0; this.last = ts;
    this.haptics.grab(); this.sound.startFriction(tight);
  }
  slide(dy, ts) {
    const dt = Math.max(1, ts - this.last); this.last = ts;
    const speed = (Math.abs(dy) / dt) * 1000;
    this.sound.updateFriction(speed, this.tight);
    this.travel += Math.abs(dy);
    let guard = 0;
    while (this.travel >= this.slipLen && guard++ < 4) {
      this.travel -= this.slipLen;
      this.haptics.slip(this.tight);
      this.sound.slip(this.tight, 0.85 + speed / 2200 + (Math.random() - 0.5) * 0.12);
    }
  }
  release(extracted) {
    this.sound.stopFriction();
    if (extracted) { this.haptics.pop(this.tight); this.sound.pop(this.tight); }
    else this.haptics.cancel();
  }
  placed() { this.haptics.place(); this.sound.place(); }
  collapse(seed) { this.sound.stopFriction(); this.haptics.collapse(); this.sound.collapse(seed); }
}

const sound = new Sound();
const haptics = new Haptics();
const feel = new Feel(sound, haptics);

// ----------------------------------------------------------------- storage
const store = {
  pid() {
    let p = localStorage.getItem('wt_pid');
    if (!p) { p = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); localStorage.setItem('wt_pid', p); }
    return p;
  },
  stats() { try { return JSON.parse(localStorage.getItem('wt_stats') || '[]'); } catch (e) { return []; } },
  merge(names, fails, pulls) {
    const map = new Map(this.stats().map((r) => [r.n, r]));
    names.forEach((n, i) => {
      const o = map.get(n) || { n, g: 0, f: 0, p: 0 };
      map.set(n, { n, g: o.g + 1, f: o.f + fails[i], p: o.p + pulls[i] });
    });
    localStorage.setItem('wt_stats', JSON.stringify([...map.values()]));
  },
  clear() { localStorage.removeItem('wt_stats'); },
  flag(k, def) { const v = localStorage.getItem(k); return v === null ? def : v === '1'; },
  setFlag(k, v) { localStorage.setItem(k, v ? '1' : '0'); },
};

sound.enabled = store.flag('wt_sound', true);
haptics.enabled = store.flag('wt_haptic', true);

// ------------------------------------------------------------------- state
const REJOIN_GRACE_SECONDS = 30;

let S = null;                       // authoritative GameState (host) / replica (guest)
let role = 'SOLO';                  // SOLO | HOST | GUEST
let myIndex = 0;
let reconnecting = false;
const myPid = store.pid();

const isOnline = (i) => (S.online ? S.online[i] !== false : true);
const isMyTurn = () => (role === 'SOLO' ? true : S && S.current === myIndex && !reconnecting);
const canControlFlow = () => role !== 'GUEST';

function newGame(players, rounds) {
  S = {
    players, online: players.map(() => true),
    totalRounds: rounds, round: 1, current: 0,
    tower: freshTower(), fails: players.map(() => 0), pulls: players.map(() => 0),
    phase: 'PLAYING', lastMargin: 1, leanX: 0, leanZ: 0, loser: -1,
    seed: randSeed(), waitingFor: -1, waitSeconds: 0,
  };
  resetView();
}

function nextOnlineAfter(from) {
  const n = S.players.length;
  for (let k = 1; k <= n; k++) { const i = (from + k) % n; if (isOnline(i)) return i; }
  return from;
}

function applyPull(block, jerk) {
  const stacked = placeOnTop(removeBlock(S.tower, block));
  const a = analyze(stacked);
  const collapsed = Math.random() < collapseChance(a, jerk, fatigueOf(stacked));
  S.tower = stacked;
  S.lastMargin = a.margin; S.leanX = a.leanX; S.leanZ = a.leanZ;
  if (collapsed) {
    S.fails[S.current]++;
    S.phase = 'COLLAPSING';
    S.loser = S.current;
    S.seed = randSeed();
  } else {
    S.pulls[S.current]++;
    S.current = nextOnlineAfter(S.current);
  }
  return collapsed;
}

function pull(block, jerk) {
  if (!isMyTurn() || S.phase !== 'PLAYING' || !canRemove(S.tower, block)) return;
  if (role === 'GUEST') { net.send({ t: 'PULL', id: block.id, j: jerk }); return; }
  applyPull(block, jerk);
  if (role === 'HOST') net.broadcast(stateMsg());
  layout();
  render();
  syncHud();
}

function onCollapseFinished() {
  if (role === 'GUEST' || S.phase !== 'COLLAPSING') return;
  const over = S.round >= S.totalRounds;
  S.phase = over ? 'GAME_OVER' : 'ROUND_OVER';
  if (over) store.merge(S.players, S.fails, S.pulls);
  if (role === 'HOST') net.broadcast(stateMsg());
  showResult();
}

function nextRound() {
  if (role === 'GUEST') return;
  cancelGrace();
  const starter = S.loser >= 0 && isOnline(S.loser) ? S.loser : nextOnlineAfter(Math.max(0, S.loser));
  Object.assign(S, {
    round: S.round + 1, tower: freshTower(), current: starter, phase: 'PLAYING',
    loser: -1, lastMargin: 1, leanX: 0, leanZ: 0, seed: randSeed(),
    waitingFor: -1, waitSeconds: 0,
  });
  resetView();
  if (role === 'HOST') net.broadcast(stateMsg());
  $('resultOverlay').classList.add('hidden');
  render(); syncHud();
}

function standings() {
  const rows = S.players.map((n, i) => ({ n, f: S.fails[i], p: S.pulls[i], i }));
  rows.sort((a, b) => a.f - b.f || b.p - a.p);
  let rank = 0, prev = null;
  return rows.map((r, i) => {
    const key = r.f + ':' + r.p;
    if (key !== prev) { rank = i + 1; prev = key; }
    return { ...r, rank };
  });
}

const stateMsg = () => ({ t: 'STATE', s: S });

// --------------------------------------------------------- 3D projection
/*
 * Orthographic camera. The tower lives in world space with +Y up, and a block
 * is 3 x 0.6 x 1 units (the real 75 x 15 x 25 mm, scaled). We yaw around Y and
 * pitch down, so every face stays a parallelogram on screen — which means a
 * plain 2D affine transform maps the wood texture onto it exactly.
 */
const BLOCK_LEN = 3, BLOCK_H = 0.6, BLOCK_W = 1;
const PITCH_MIN = 0.05, PITCH_MAX = 0.95;

let yaw = 0.55, pitch = 0.30, yawVel = 0;
let scale = 40, originX = 0, originY = 0;

const canvas = $('tower');
const ctx2d = canvas.getContext('2d');
const imgEnd = new Image(); imgEnd.src = 'block_end.png';
const imgSide = new Image(); imgSide.src = 'block_side.png';
const imgTop = new Image(); imgTop.src = 'block_top.png';

function resetView() { yaw = 0.55; pitch = 0.30; yawVel = 0; }

/** Small-angle lean of the whole tower about its base, driven by the physics. */
function leanAngles() {
  return S ? { a: S.leanX * 0.08, b: S.leanZ * 0.08 } : { a: 0, b: 0 };
}

function project(p, lean) {
  let { x, y, z } = p;
  const ca = Math.cos(lean.a), sa = Math.sin(lean.a);
  const cb = Math.cos(lean.b), sb = Math.sin(lean.b);
  let x1 = x * ca + y * sa, y1 = -x * sa + y * ca;       // tilt toward +X
  let z1 = z * cb + y1 * sb; y1 = -z * sb + y1 * cb;     // tilt toward +Z

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x2 = x1 * cy + z1 * sy;
  const z2 = -x1 * sy + z1 * cy;

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y3 = y1 * cp - z2 * sp;
  const z3 = y1 * sp + z2 * cp;                          // depth: bigger = nearer

  return { x: originX + x2 * scale, y: originY - y3 * scale, d: z3 };
}

/** Same rotations, no translation — for normals and direction vectors. */
function rotateDir(v) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x2 = v.x * cy + v.z * sy;
  const z2 = -v.x * sy + v.z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return { x: x2, y: v.y * cp - z2 * sp, z: v.y * sp + z2 * cp };
}

// ------------------------------------------------------------------- boxes
/** Where a block sits, and how it is oriented. */
function blockGeom(b) {
  const alongX = axisOf(b.level) === 'X';
  const off = slotOffset(b.slot);
  return {
    alongX,
    c: alongX ? { x: 0, y: b.level * BLOCK_H + BLOCK_H / 2, z: off * BLOCK_W }
              : { x: off * BLOCK_W, y: b.level * BLOCK_H + BLOCK_H / 2, z: 0 },
    h: alongX ? { x: BLOCK_LEN / 2, y: BLOCK_H / 2, z: BLOCK_W / 2 }
              : { x: BLOCK_W / 2, y: BLOCK_H / 2, z: BLOCK_LEN / 2 },
  };
}

/** The axis a block would slide out along. */
const pullAxis = (g) => (g.alongX ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 });

/**
 * Faces as [origin, uCorner, vCorner] in local units, plus which texture they
 * take and their outward normal. The bottom face is never visible, so it is
 * left out. `swap` flips the top texture 90 degrees for Z-oriented blocks so
 * the grain always runs along the block.
 */
function facesOf(g) {
  const { x: hx, y: hy, z: hz } = g.h;
  const side = g.alongX ? imgSide : imgEnd;   // the +-Z pair
  const flank = g.alongX ? imgEnd : imgSide;  // the +-X pair
  return [
    { n: { x: 0, y: 0, z: 1 }, img: side,
      p: [[-hx, hy, hz], [hx, hy, hz], [-hx, -hy, hz]] },
    { n: { x: 0, y: 0, z: -1 }, img: side,
      p: [[hx, hy, -hz], [-hx, hy, -hz], [hx, -hy, -hz]] },
    { n: { x: 1, y: 0, z: 0 }, img: flank,
      p: [[hx, hy, hz], [hx, hy, -hz], [hx, -hy, hz]] },
    { n: { x: -1, y: 0, z: 0 }, img: flank,
      p: [[-hx, hy, -hz], [-hx, hy, hz], [-hx, -hy, -hz]] },
    { n: { x: 0, y: 1, z: 0 }, img: imgTop,
      p: g.alongX ? [[-hx, hy, -hz], [hx, hy, -hz], [-hx, hy, hz]]
                  : [[-hx, hy, hz], [-hx, hy, -hz], [hx, hy, hz]] },
  ];
}

const LIGHT = (() => { const l = { x: -0.42, y: 0.80, z: 0.43 };
  const m = Math.hypot(l.x, l.y, l.z); return { x: l.x / m, y: l.y / m, z: l.z / m }; })();

// ---------------------------------------------------------------- the frame
let frame = [];          // per-block picking data, nearest last
let debris = null, collapseStart = 0;
let selected = null, pullDist = 0, jerk = 0, curTight = 0.5;
let pullOutDir = null;   // world unit vector the selected block slides along
let pullScreen = null;   // that direction, projected, in px per world unit

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.imageSmoothingQuality = 'low';
}
window.addEventListener('resize', () => { fitCanvas(); layout(); render(); });

function layout() {
  if (!S) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  const levels = topLevel(S.tower) + 1;
  const towerH = levels * BLOCK_H;
  // The footprint spans 3 units; at 45 degrees its projected width is 3 * sqrt(2).
  const sByW = (W * 0.86) / (BLOCK_LEN * 1.42);
  const sByH = (H * 0.86) / (towerH * Math.cos(PITCH_MIN) + BLOCK_LEN * 1.42 * Math.sin(PITCH_MAX));
  scale = Math.min(sByW, sByH);
  originX = W / 2;
  originY = H * 0.90;
}

/** px of screen travel that counts as one full extraction. */
const pullLimitWorld = () => BLOCK_LEN * 0.62;

function buildFrame() {
  const lean = leanAngles();
  frame = [];
  const quads = [];

  for (const b of S.tower.blocks) {
    const g = blockGeom(b);
    let cx = g.c.x, cy = g.c.y, cz = g.c.z;
    let spin = null;

    if (debris) {
      const d = debris.get(b.id);
      if (!d) continue;
      cx += d.dx; cy += d.dy; cz += d.dz; spin = d;
    } else if (selected && selected.id === b.id && pullDist > 0) {
      cx += pullOutDir.x * pullDist; cy += pullOutDir.y * pullDist; cz += pullOutDir.z * pullDist;
    }

    const isSel = selected && selected.id === b.id;
    const forb = !debris && forbiddenLevels(S.tower).has(b.level);
    const polys = [];

    for (const f of facesOf(g)) {
      let n = f.n;
      if (spin) n = spinVec(n, spin);
      const nv = rotateDir(n);
      if (nv.z <= 0.02) continue;                       // back-facing

      const pts = f.p.map((q) => {
        let v = { x: q[0], y: q[1], z: q[2] };
        if (spin) v = spinVec(v, spin);
        return project({ x: cx + v.x, y: cy + v.y, z: cz + v.z }, lean);
      });
      // fourth corner of the parallelogram: p1 + p3 - p0
      const p4 = { x: pts[1].x + pts[2].x - pts[0].x, y: pts[1].y + pts[2].y - pts[0].y };

      const shade = 0.52 + 0.48 * Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
      const depth = (pts[0].d + pts[1].d + pts[2].d) / 3;
      const poly = [pts[0], pts[1], p4, pts[2]];
      polys.push(poly);
      quads.push({ depth, pts, img: f.img, shade, isSel, forb });
    }
    if (!polys.length) continue;

    // Can we actually reach it from here? A block whose axis lies across the
    // camera shows only its long face — you would have to walk around the table.
    const ax = pullAxis(g);
    const va = rotateDir(ax);
    const towardCam = va.z >= 0 ? 1 : -1;
    const reach = Math.abs(va.z);
    const outDir = { x: ax.x * towardCam, y: 0, z: ax.z * towardCam };

    const o = project({ x: cx, y: cy, z: cz }, lean);
    const o2 = project({ x: cx + outDir.x, y: cy, z: cz + outDir.z }, lean);
    frame.push({
      block: b, polys, forb, depth: o.d, reach, outDir,
      outScreen: { x: o2.x - o.x, y: o2.y - o.y },
    });
  }

  quads.sort((a, b) => a.depth - b.depth);
  return quads;
}

function spinVec(v, d) {
  const cx = Math.cos(d.rx), sx = Math.sin(d.rx);
  const cy = Math.cos(d.ry), sy = Math.sin(d.ry);
  let y = v.y * cx - v.z * sx, z = v.y * sx + v.z * cx;
  let x = v.x * cy + z * sy; z = -v.x * sy + z * cy;
  return { x, y, z };
}

function drawQuad(q) {
  const [p0, p1, p3] = q.pts;
  const img = q.img;
  if (!img.complete || !img.naturalWidth) return;
  const w = img.naturalWidth, h = img.naturalHeight;
  ctx2d.save();
  ctx2d.transform((p1.x - p0.x) / w, (p1.y - p0.y) / w,
                  (p3.x - p0.x) / h, (p3.y - p0.y) / h, p0.x, p0.y);
  ctx2d.drawImage(img, 0, 0, w, h);
  const dark = 1 - q.shade;
  if (dark > 0.001) { ctx2d.fillStyle = `rgba(24,14,6,${dark.toFixed(3)})`; ctx2d.fillRect(0, 0, w, h); }
  if (q.forb) { ctx2d.fillStyle = 'rgba(60,26,12,.34)'; ctx2d.fillRect(0, 0, w, h); }
  if (q.isSel) { ctx2d.fillStyle = 'rgba(255,214,140,.30)'; ctx2d.fillRect(0, 0, w, h); }
  ctx2d.restore();
}

function render() {
  if (!S) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx2d.clearRect(0, 0, W, H);
  const quads = buildFrame();
  frame.sort((a, b) => a.depth - b.depth);   // picking wants nearest last
  for (const q of quads) drawQuad(q);
}

// -------------------------------------------------------------- collapse
function startCollapse() {
  const rnd = mulberry32(S.seed);
  debris = new Map();
  for (const b of S.tower.blocks) {
    debris.set(b.id, {
      dx: 0, dy: 0, dz: 0, rx: 0, ry: 0,
      vx: (rnd() - 0.5) * 9 + S.leanX * 7,
      vy: rnd() * 1.2,
      vz: (rnd() - 0.5) * 9 + S.leanZ * 7,
      wx: (rnd() - 0.5) * 9, wy: (rnd() - 0.5) * 9,
      base: b.level * BLOCK_H,
    });
  }
  collapseStart = performance.now();
  feel.collapse(S.seed);
}

function stepCollapse(dt) {
  for (const d of debris.values()) {
    d.vy -= 26 * dt;
    d.dx += d.vx * dt; d.dy += d.vy * dt; d.dz += d.vz * dt;
    d.rx += d.wx * dt; d.ry += d.wy * dt;
    const floor = -d.base;   // centre returns to BLOCK_H/2 above the table
    if (d.dy < floor) { d.dy = floor; d.vy = -d.vy * 0.26; d.vx *= 0.60; d.vz *= 0.60; d.wx *= 0.5; d.wy *= 0.5; }
  }
}

// ----------------------------------------------------------- render loop
let lastFrameTs = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.033, (ts - lastFrameTs) / 1000 || 0);
  lastFrameTs = ts;
  if (!S || !$('gameScreen').classList.contains('on')) return;

  if (debris) {
    stepCollapse(dt);
    if (ts - collapseStart > 2100) {
      // The host decides when the round ends; a guest just keeps the rubble up
      // until the next STATE arrives, so the tower never pops back together.
      if (role === 'GUEST') { if (S.phase !== 'COLLAPSING') debris = null; }
      else { debris = null; onCollapseFinished(); }
    }
  } else if (!selected && Math.abs(yawVel) > 0.0004) {
    yaw += yawVel * dt;                 // flick momentum
    yawVel *= Math.pow(0.06, dt);
  }
  render();
}
requestAnimationFrame(loop);

// ------------------------------------------------------------------- input
/*
 * One finger does two jobs, so we watch the first few pixels to decide:
 * a mostly-horizontal move orbits the camera, anything else on a reachable
 * block pulls it. Starting on empty space always orbits.
 */
const GESTURE_SLOP = 9;
let ptr = null;   // {id, x0, y0, lastX, lastY, mode, hit}

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Nearest block whose visible silhouette contains the point. */
function pick(pt) {
  for (let i = frame.length - 1; i >= 0; i--) {
    const f = frame[i];
    if (f.polys.some((p) => pointInPoly(pt, p))) return f;
  }
  return null;
}

const inputEnabled = () => S && S.phase === 'PLAYING' && isMyTurn() && S.waitingFor < 0 && !debris;

/** Screen direction the block travels as it comes out, and px per world unit. */
function pullVectors(f) {
  const L = Math.hypot(f.outScreen.x, f.outScreen.y);
  // Nearly end-on: the block barely moves on screen, so drag downward instead.
  if (L < 0.30 * scale) return { unit: { x: 0, y: 1 }, pxPerUnit: 0.62 * scale };
  return { unit: { x: f.outScreen.x / L, y: f.outScreen.y / L }, pxPerUnit: L };
}

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  if (ptr) return;
  const p = canvasPoint(e);
  canvas.setPointerCapture(e.pointerId);
  const hit = inputEnabled() ? pick(p) : null;
  ptr = { id: e.pointerId, x0: p.x, y0: p.y, lastX: p.x, lastY: p.y, ts: e.timeStamp, mode: null, hit };
  // Nothing grabbable under the finger, or the block is out of reach: orbit.
  if (!hit || hit.forb || hit.reach < 0.26) ptr.mode = 'orbit';
  yawVel = 0;
});

canvas.addEventListener('pointermove', (e) => {
  if (!ptr || e.pointerId !== ptr.id) return;
  const p = canvasPoint(e);
  const dx = p.x - ptr.lastX, dy = p.y - ptr.lastY;
  ptr.lastX = p.x; ptr.lastY = p.y;

  if (!ptr.mode) {
    const tx = p.x - ptr.x0, ty = p.y - ptr.y0;
    if (Math.hypot(tx, ty) < GESTURE_SLOP) return;
    if (Math.abs(tx) > Math.abs(ty) * 1.15) { ptr.mode = 'orbit'; }
    else {
      ptr.mode = 'pull';
      selected = ptr.hit.block;
      pullOutDir = ptr.hit.outDir;
      pullScreen = pullVectors(ptr.hit);
      pullDist = 0; jerk = 0;
      curTight = tightnessOf(S.tower, selected);
      feel.grab(curTight, slipLengthPx(curTight, BLOCK_H * scale), e.timeStamp);
    }
  }

  if (ptr.mode === 'orbit') {
    yaw += dx * 0.0072;
    pitch = clamp(pitch - dy * 0.0045, PITCH_MIN, PITCH_MAX);
    const dt = Math.max(0.008, (e.timeStamp - ptr.ts) / 1000);
    yawVel = clamp((dx * 0.0072) / dt, -7, 7);
    ptr.ts = e.timeStamp;
    return;
  }

  if (ptr.mode === 'pull') {
    const along = (dx * pullScreen.unit.x + dy * pullScreen.unit.y) / pullScreen.pxPerUnit;
    const before = pullDist;
    pullDist = Math.max(0, pullDist + along);
    jerk = Math.max(jerk, clamp(Math.abs(along) * scale / 40, 0, 1));
    feel.slide((pullDist - before) * pullScreen.pxPerUnit, e.timeStamp);
  }
});

function endPointer(e) {
  if (!ptr || (e && e.pointerId !== ptr.id)) return;
  if (ptr.mode === 'pull' && selected) {
    const extracted = pullDist >= pullLimitWorld();
    feel.release(extracted);
    const b = selected;
    selected = null; pullDist = 0;
    if (extracted) { const before = S.pulls.reduce((a, c) => a + c, 0); pull(b, jerk); afterPull(before); }
    jerk = 0;
  }
  ptr = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

/** Local echo for the block landing on top; guests get it from the STATE diff. */
function afterPull(pullsBefore) {
  if (role === 'GUEST') return;
  if (S.phase === 'COLLAPSING') startCollapse();
  else if (S.pulls.reduce((a, c) => a + c, 0) > pullsBefore) feel.placed();
}

// --------------------------------------------------------------------- HUD
function syncHud() {
  if (!S) return;
  $('turnName').textContent = isMyTurn() && role !== 'SOLO' ? '내 차례!' : `${S.players[S.current]} 차례`;
  $('roundText').textContent = `${S.round} / ${S.totalRounds} 라운드`;
  const m = clamp(S.lastMargin, 0, 1);
  $('meter').style.width = `${m * 100}%`;
  $('meter').style.background = m > 0.5 ? 'var(--safe)' : m > 0.25 ? 'var(--amber)' : 'var(--danger)';
  $('meterText').textContent = `안정도 ${Math.round(m * 100)}%`;
  $('hint').textContent = !isMyTurn()
    ? `${S.players[S.current]} 님의 차례를 기다리는 중…`
    : '좌우로 밀면 타워가 돌아갑니다 · 블록을 잡아 바깥으로 당겨 빼세요';

  const wb = $('waitBanner');
  if (S.waitingFor >= 0) {
    wb.classList.remove('hidden');
    $('waitText').textContent = `${S.players[S.waitingFor]} 님 재접속 대기 중… ${S.waitSeconds}초`;
    $('btnSkip').classList.toggle('hidden', !canControlFlow());
  } else wb.classList.add('hidden');

  $('reconnectOverlay').classList.toggle('hidden', !reconnecting);
  $('btnSound').classList.toggle('off', !sound.enabled);
  $('btnHaptic').classList.toggle('off', !haptics.enabled);
}

function showResult() {
  const over = S.phase === 'GAME_OVER';
  $('resultTitle').textContent = over ? '게임 종료' : '라운드 종료';
  $('resultWho').textContent = S.loser >= 0 ? `${S.players[S.loser]} 님이 무너뜨렸습니다` : '';
  $('standings').innerHTML = standings().map((r) => `
    <li class="${isOnline(r.i) ? '' : 'offline'}">
      <span class="rank">${r.rank}</span>
      <span class="grow">${escapeHtml(r.n)}${isOnline(r.i) ? '' : ' (접속 끊김)'}</span>
      <span class="stat">실패 ${r.f} · 성공 ${r.p}</span>
    </li>`).join('');
  $('btnNextRound').classList.toggle('hidden', over || !canControlFlow());
  $('waitHostText').classList.toggle('hidden', over || canControlFlow());
  $('btnSeeRank').classList.toggle('hidden', !over);
  $('btnResultHome').classList.toggle('hidden', !over);
  $('resultOverlay').classList.remove('hidden');
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function enterGame() {
  showScreen('gameScreen');
  $('resultOverlay').classList.add('hidden');
  requestAnimationFrame(() => { fitCanvas(); layout(); render(); syncHud(); });
}

// ------------------------------------------------------------ networking
/**
 * PeerJS = WebRTC data channels with a public signalling broker.
 * WEB-ONLY: Android uses Nearby Connections (no internet). The message shapes,
 * the seat model and the reconnect flow are identical on purpose.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
const peerIdFor = (code) => 'woodtower-v1-' + code;

const net = {
  peer: null, conns: new Map(),   // host: pid -> DataConnection
  hostConn: null, hostCode: '',
  seats: [],                      // [{pid, name, conn, connected}]
  gameStarted: false, rounds: 3, myName: '',
  graceTimer: null, retryTimer: null,

  available() {
    if (typeof Peer === 'undefined') { netError('PeerJS를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.'); return false; }
    return true;
  },

  // ---- host ----------------------------------------------------------
  host(name, rounds) {
    if (!this.available()) return;
    role = 'HOST'; myIndex = 0; this.myName = name; this.rounds = rounds;
    this.gameStarted = false;
    this.seats = [{ pid: myPid, name, conn: null, connected: true }];
    this._openHostPeer(0);
  },

  _openHostPeer(attempt) {
    if (attempt > 6) { netError('방 코드를 만들지 못했습니다. 다시 시도해주세요.'); return; }
    const code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join('');
    const peer = new Peer(peerIdFor(code));
    peer.on('open', () => {
      this.peer = peer; this.hostCode = code;
      $('roomCode').textContent = code;
      $('roomCodeWrap').classList.remove('hidden');
      $('lobbyTitle').textContent = '대기실 (방장)';
      $('lobbyHint').textContent = '친구가 코드를 입력하면 여기에 나타납니다.';
      $('btnStartNet').classList.remove('hidden');
      $('lobbyWait').classList.add('hidden');
      showScreen('lobbyScreen');
      renderLobby();
    });
    peer.on('connection', (conn) => this._onGuestConn(conn));
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { peer.destroy(); this._openHostPeer(attempt + 1); }
      else netError('연결 오류: ' + err.type);
    });
  },

  _onGuestConn(conn) {
    conn.on('data', (msg) => this._hostMessage(conn, msg));
    conn.on('close', () => this._hostDisconnect(conn));
    conn.on('error', () => this._hostDisconnect(conn));
  },

  _hostMessage(conn, msg) {
    if (msg.t === 'HELLO') return this._onHello(conn, msg);
    if (msg.t === 'PULL') {
      const i = this.seats.findIndex((s) => s.conn === conn);
      if (i !== S.current || S.phase !== 'PLAYING') return;
      const b = S.tower.blocks.find((x) => x.id === msg.id);
      if (!b) return;
      const before = S.pulls.reduce((a, c) => a + c, 0);
      applyPull(b, msg.j);
      this.broadcast(stateMsg());
      layout();
      if (S.phase === 'COLLAPSING') startCollapse();
      else if (S.pulls.reduce((a, c) => a + c, 0) > before) feel.placed();
      syncHud();
    }
  },

  /** Seats are keyed on a stable playerId, so a returning guest lands in their own chair. */
  _onHello(conn, msg) {
    const i = this.seats.findIndex((s) => s.pid === msg.pid);
    if (i >= 0) {
      const seat = this.seats[i];
      seat.conn = conn; seat.connected = true; seat.name = msg.n;
      conn.send({ t: 'WELCOME', i, hn: this.myName });
      if (this.gameStarted) {
        if (S.waitingFor === i) this.cancelGrace();
        this.syncOnline();
        this.broadcast(stateMsg());
        toast(`${msg.n} 님이 다시 참가했습니다.`);
        syncHud();
      } else renderLobby();
      return;
    }
    if (this.gameStarted) { conn.send({ t: 'REJECT' }); return; }   // no seat for strangers
    this.seats.push({ pid: msg.pid, name: msg.n, conn, connected: true });
    conn.send({ t: 'WELCOME', i: this.seats.length - 1, hn: this.myName });
    renderLobby();
  },

  _hostDisconnect(conn) {
    const i = this.seats.findIndex((s) => s.conn === conn);
    if (i < 0) return;
    const seat = this.seats[i];
    seat.connected = false; seat.conn = null;
    if (!this.gameStarted) {
      this.seats.splice(i, 1);
      // Indices shifted; tell everyone their new seat number.
      this.seats.forEach((s2, k) => { if (s2.conn) try { s2.conn.send({ t: 'WELCOME', i: k, hn: this.myName }); } catch (e) {} });
      renderLobby();
      return;
    }
    this.syncOnline();
    toast(`${seat.name} 님의 연결이 끊겼습니다.`);
    if (S.phase === 'PLAYING' && S.current === i) this.startGrace(i);
    else { this.broadcast(stateMsg()); syncHud(); }
  },

  startNetGame() {
    if (this.seats.length < 2) { netError('최소 2명이 필요합니다.'); return; }
    this.gameStarted = true;
    newGame(this.seats.map((s) => s.name), this.rounds);
    this.syncOnline();
    this.broadcast(stateMsg());
    enterGame();
  },

  syncOnline() { if (S) S.online = this.seats.map((s) => s.connected); },

  startGrace(index) {
    this.cancelGrace();
    let left = REJOIN_GRACE_SECONDS;
    S.waitingFor = index; S.waitSeconds = left;
    this.broadcast(stateMsg()); syncHud();
    this.graceTimer = setInterval(() => {
      if (S.waitingFor !== index) { this.cancelGrace(); return; }   // they came back
      left -= 1;
      if (left <= 0) { this.cancelGrace(); skipTurn(); return; }
      S.waitSeconds = left;
      this.broadcast(stateMsg()); syncHud();
    }, 1000);
  },

  cancelGrace() {
    if (this.graceTimer) clearInterval(this.graceTimer);
    this.graceTimer = null;
    if (S) { S.waitingFor = -1; S.waitSeconds = 0; }
  },

  broadcast(msg) { this.seats.forEach((s) => { if (s.conn && s.connected) try { s.conn.send(msg); } catch (e) {} }); },

  // ---- guest ---------------------------------------------------------
  join(name, code) {
    if (!this.available()) return;
    role = 'GUEST'; this.myName = name; this.hostCode = code; this.gameStarted = false;
    this.peer = new Peer();
    this.peer.on('open', () => this._connectToHost());
    this.peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (reconnecting) return;                       // retry loop will keep trying
        netError('그 코드의 방을 찾을 수 없습니다.');
      } else netError('연결 오류: ' + err.type);
    });
  },

  _connectToHost() {
    const conn = this.peer.connect(peerIdFor(this.hostCode), { reliable: true });
    conn.on('open', () => {
      this.hostConn = conn;
      if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
      conn.send({ t: 'HELLO', n: this.myName, pid: myPid });
    });
    conn.on('data', (msg) => this._guestMessage(msg));
    conn.on('close', () => this._guestLostHost());
  },

  _guestMessage(msg) {
    if (msg.t === 'WELCOME') {
      myIndex = msg.i; this.gameStarted = true;
      if (reconnecting) { reconnecting = false; toast('다시 연결되었습니다.'); }
      $('lobbyTitle').textContent = '대기실';
      $('lobbyHint').textContent = '방장이 시작하기를 기다리는 중…';
      $('lobbyWait').classList.remove('hidden');
      if (!S) showScreen('lobbyScreen');
      syncHud();
      return;
    }
    if (msg.t === 'STATE') {
      const prevPhase = S && S.phase;
      const prevPulls = S ? S.pulls.reduce((a, c) => a + c, 0) : 0;
      const prevRound = S ? S.round : 0;
      S = msg.s;
      if (S.round !== prevRound && S.phase === 'PLAYING') resetView();
      if ($('gameScreen').classList.contains('on')) layout();
      else enterGame();
      if (S.phase === 'COLLAPSING' && prevPhase !== 'COLLAPSING') startCollapse();
      else if (S.phase === 'PLAYING' && S.pulls.reduce((a, c) => a + c, 0) > prevPulls) feel.placed();
      if (S.phase === 'ROUND_OVER' || S.phase === 'GAME_OVER') showResult();
      else $('resultOverlay').classList.add('hidden');
      syncHud();
      return;
    }
    if (msg.t === 'REJECT') { toast('이미 시작된 게임입니다.'); leaveNet(); return; }
    if (msg.t === 'ABORT') { toast('방장이 게임을 종료했습니다.'); leaveNet(); }
  },

  _guestLostHost() {
    this.hostConn = null;
    if (!this.gameStarted) { toast('방장이 게임을 종료했습니다.'); leaveNet(); return; }
    // Keep the board on screen and go hunting for the host again.
    reconnecting = true;
    syncHud();
    if (!this.retryTimer) this.retryTimer = setInterval(() => this._connectToHost(), 2500);
  },

  shutdown() {
    if (this.graceTimer) clearInterval(this.graceTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.graceTimer = this.retryTimer = null;
    if (role === 'HOST') this.broadcast({ t: 'ABORT' });
    try { this.peer && this.peer.destroy(); } catch (e) {}
    this.peer = null; this.hostConn = null; this.seats = []; this.gameStarted = false;
  },
};

function skipTurn() {
  if (role === 'GUEST') return;
  net.cancelGrace();
  S.current = nextOnlineAfter(S.current);
  if (role === 'HOST') net.broadcast(stateMsg());
  syncHud();
}

function leaveNet() {
  net.shutdown();
  role = 'SOLO'; reconnecting = false; S = null; myIndex = 0;
  showScreen('homeScreen');
}

function renderLobby() {
  const list = $('lobbyList');
  const rows = role === 'HOST' ? net.seats : [];
  list.innerHTML = rows.map((s, i) => `
    <li class="${s.connected ? '' : 'offline'}">
      <span class="rank">${i + 1}</span>
      <span class="grow">${escapeHtml(s.name)}${i === 0 ? ' (방장)' : ''}</span>
      <span class="stat">${s.connected ? '연결됨' : '끊김'}</span>
    </li>`).join('');
  $('btnStartNet').disabled = net.seats.length < 2;
}

// -------------------------------------------------------------- toasts/UI
let toastTimer = null;
function toast(text) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:absolute;left:16px;right:16px;bottom:24px;background:rgba(51,37,26,.97);' +
      'padding:12px 14px;border-radius:12px;font-size:14px;text-align:center;z-index:99';
    $('app').appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = 'none'), 2600);
}
const netError = (m) => { const e = $('netErr'); e.textContent = m; e.classList.remove('hidden'); };

// ------------------------------------------------------------ hot-seat UI
let localPlayers = ['Player 1', 'Player 2'];

function renderPlayers() {
  $('playerCount').textContent = `플레이어 (${localPlayers.length}명)`;
  $('playerList').innerHTML = localPlayers.map((n, i) => `
    <li>
      <span class="rank">${i + 1}</span>
      <input type="text" maxlength="12" data-i="${i}" value="${escapeHtml(n)}">
      ${localPlayers.length > 2 ? `<button class="icon-btn btn-sm" data-del="${i}">✕</button>` : ''}
    </li>`).join('');
  $('playerList').querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('input', (e) => { localPlayers[+e.target.dataset.i] = e.target.value; validateSetup(); }));
  $('playerList').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => { localPlayers.splice(+b.dataset.del, 1); renderPlayers(); }));
  $('btnAddPlayer').classList.toggle('hidden', localPlayers.length >= 8);
  validateSetup();
}

function validateSetup() {
  const names = localPlayers.map((n) => n.trim());
  const ok = names.every((n) => n) && new Set(names).size === names.length;
  $('btnStartLocal').disabled = !ok;
  $('setupErr').classList.toggle('hidden', ok);
  return ok;
}

// ------------------------------------------------------------------- wiring
$('btnLocal').onclick = () => { sound.unlock(); renderPlayers(); showScreen('setupScreen'); };
$('btnOnline').onclick = () => { sound.unlock(); $('netErr').classList.add('hidden'); showScreen('onlineScreen'); };
$('btnRank').onclick = () => { showRanking(); showScreen('rankScreen'); };
document.querySelectorAll('[data-home]').forEach((b) => (b.onclick = () => showScreen('homeScreen')));
document.querySelectorAll('[data-leave]').forEach((b) => (b.onclick = () => leaveNet()));
document.querySelectorAll('[data-exit]').forEach((b) => (b.onclick = () => (role === 'SOLO' ? showScreen('homeScreen') : leaveNet())));

$('rounds').oninput = (e) => ($('roundsLabel').textContent = `게임 횟수: ${e.target.value}판`);
$('netRounds').oninput = (e) => ($('netRoundsLabel').textContent = `게임 횟수: ${e.target.value}판`);
$('btnAddPlayer').onclick = () => { localPlayers.push(`Player ${localPlayers.length + 1}`); renderPlayers(); };

$('btnStartLocal').onclick = () => {
  if (!validateSetup()) return;
  role = 'SOLO'; myIndex = 0;
  newGame(localPlayers.map((n) => n.trim()), +$('rounds').value);
  enterGame();
};

$('btnHost').onclick = () => {
  const n = $('nick').value.trim();
  if (!n) return netError('닉네임을 입력해주세요.');
  net.host(n, +$('netRounds').value);
};
$('btnJoin').onclick = () => {
  const n = $('nick').value.trim();
  const code = $('joinCode').value.trim().toUpperCase();
  if (!n) return netError('닉네임을 입력해주세요.');
  if (code.length !== 4) return netError('방 코드 4자리를 입력해주세요.');
  $('roomCodeWrap').classList.add('hidden');
  $('btnStartNet').classList.add('hidden');
  $('lobbyTitle').textContent = '연결 중…';
  $('lobbyHint').textContent = `방 ${code} 에 접속하고 있습니다.`;
  showScreen('lobbyScreen');
  net.join(n, code);
};
$('btnStartNet').onclick = () => net.startNetGame();
$('btnSkip').onclick = () => skipTurn();
$('btnNextRound').onclick = () => nextRound();
$('btnSeeRank').onclick = () => { showRanking(); showScreen('rankScreen'); };
$('btnResultHome').onclick = () => (role === 'SOLO' ? showScreen('homeScreen') : leaveNet());
$('btnRotate').onclick = () => { resetView(); render(); };
$('btnSound').onclick = () => { sound.enabled = !sound.enabled; store.setFlag('wt_sound', sound.enabled); if (!sound.enabled) sound.stopFriction(); syncHud(); };
$('btnHaptic').onclick = () => { haptics.enabled = !haptics.enabled; store.setFlag('wt_haptic', haptics.enabled); syncHud(); };
$('btnClearRank').onclick = () => { if (confirm('모든 누적 기록을 삭제할까요?')) { store.clear(); showRanking(); } };

function showRanking() {
  const hasSession = S && S.players.length;
  $('sessionLabel').classList.toggle('hidden', !hasSession);
  $('sessionRank').innerHTML = hasSession ? standings().map((r) => `
    <li><span class="rank">${r.rank}</span><span class="grow">${escapeHtml(r.n)}</span>
    <span class="stat">실패 ${r.f} · 성공 ${r.p}</span></li>`).join('') : '';

  const rows = store.stats().sort((a, b) => a.f - b.f || b.p - a.p);
  $('rankEmpty').classList.toggle('hidden', rows.length > 0);
  $('lifetimeRank').innerHTML = rows.map((r, i) => `
    <li><span class="rank">${i + 1}</span><span class="grow">${escapeHtml(r.n)}</span>
    <span class="stat">${r.g}게임 · 실패 ${r.f} · 성공 ${r.p}</span></li>`).join('');
}

window.addEventListener('beforeunload', () => net.shutdown());
