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
let viewAngle = 0;                  // 0 = odd (Z) levels face us, 1 = even (X)
let reconnecting = false;
const myPid = store.pid();

const selectableAxis = () => (viewAngle === 0 ? 'Z' : 'X');
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
  viewAngle = 0;
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
  viewAngle = 0;
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

// --------------------------------------------------------------- rendering
const canvas = $('tower');
const ctx2d = canvas.getContext('2d');
const imgEnd = new Image(); imgEnd.src = 'block_end.png';
const imgSide = new Image(); imgSide.src = 'block_side.png';

let cells = [];        // {block, level, x,y,w,h, isEnd, forbidden}
let levelH = 0;
let selected = null, dragY = 0, jerk = 0, curTight = 0.5, lastPointerY = 0;
let debris = null, collapseStart = 0;

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { fitCanvas(); layout(); render(); });

function layout() {
  cells = [];
  if (!S) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  const t = S.tower, top = topLevel(t), levels = top + 1;
  const marginBottom = H * 0.06;

  let towerW = W * 0.60;
  levelH = (towerW / 3) * 0.60;                 // real block is 75 x 25 x 15
  const usable = H - marginBottom - H * 0.10;
  const needed = levels * levelH;
  if (needed > usable) { const k = usable / needed; levelH *= k; towerW *= k; }

  const blockW = towerW / 3, cx = W / 2, baseY = H - marginBottom;
  const forb = forbiddenLevels(t);
  const sel = selectableAxis();

  for (let l = 0; l <= top; l++) {
    const bs = levelBlocks(t, l);
    if (!bs.length) continue;
    const yTop = baseY - (l + 1) * levelH;
    if (axisOf(l) === sel) {
      // Facing us end-on: three separate, grabbable end faces.
      for (const b of bs) {
        cells.push({
          block: b, level: l, x: cx + (b.slot - 1) * blockW - blockW / 2, y: yTop,
          w: blockW, h: levelH, isEnd: true, forbidden: forb.has(l),
        });
      }
    } else {
      // Side-on: one long face, nothing to grab from this angle.
      cells.push({
        block: null, level: l, x: cx - towerW / 2, y: yTop,
        w: towerW, h: levelH, isEnd: false, forbidden: forb.has(l),
      });
    }
  }
}

function drawCell(c, dy, highlight) {
  const img = c.isEnd ? imgEnd : imgSide;
  const y = c.y + (dy || 0);
  ctx2d.fillStyle = 'rgba(0,0,0,.20)';
  ctx2d.fillRect(c.x + 3, y + 3, c.w, c.h);
  if (img.complete) ctx2d.drawImage(img, c.x, y, c.w, c.h);
  if (c.forbidden && c.block) { ctx2d.fillStyle = 'rgba(40,20,10,.30)'; ctx2d.fillRect(c.x, y, c.w, c.h); }
  if (highlight) { ctx2d.fillStyle = 'rgba(255,226,168,.28)'; ctx2d.fillRect(c.x, y, c.w, c.h); }
}

function render() {
  if (!S) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx2d.clearRect(0, 0, W, H);

  if (debris) { debris.forEach(drawDebris); return; }

  const lean = viewAngle === 0 ? S.leanX : S.leanZ;
  const deg = clamp(lean * 4.2, -9, 9);
  ctx2d.save();
  ctx2d.translate(W / 2, H * 0.94);
  ctx2d.rotate((deg * Math.PI) / 180);
  ctx2d.translate(-W / 2, -H * 0.94);
  const pullLimit = levelH * 1.8;
  for (const c of cells) {
    const isSel = c.block && selected && c.block.id === selected.id;
    drawCell(c, isSel ? dragY : 0, isSel && dragY >= pullLimit);
  }
  ctx2d.restore();
}

function drawDebris(d) {
  const img = d.isEnd ? imgEnd : imgSide;
  ctx2d.save();
  ctx2d.translate(d.x + d.w / 2, d.y + d.h / 2);
  ctx2d.rotate((d.rot * Math.PI) / 180);
  if (img.complete) ctx2d.drawImage(img, -d.w / 2, -d.h / 2, d.w, d.h);
  ctx2d.restore();
}

function startCollapse() {
  const rnd = mulberry32(S.seed);
  const lean = viewAngle === 0 ? S.leanX : S.leanZ;
  debris = cells.map((c) => ({
    x: c.x, y: c.y, w: c.w, h: c.h, isEnd: c.isEnd,
    vx: (rnd() - 0.5) * 900 + lean * 700, vy: -rnd() * 250,
    rot: 0, vr: (rnd() - 0.5) * 540,
  }));
  collapseStart = performance.now();
  feel.collapse(S.seed);
  requestAnimationFrame(stepCollapse);
}

function stepCollapse(now) {
  if (!debris) return;
  const dt = Math.min(0.033, (now - (stepCollapse.last || now)) / 1000);
  stepCollapse.last = now;
  const floorY = canvas.clientHeight * 0.94;
  for (const d of debris) {
    d.vy += 2600 * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt;
    if (d.y + d.h > floorY) { d.y = floorY - d.h; d.vy = -d.vy * 0.28; d.vx *= 0.62; d.vr *= 0.5; }
  }
  render();
  if (now - collapseStart < 1900) requestAnimationFrame(stepCollapse);
  else { debris = null; stepCollapse.last = 0; render(); onCollapseFinished(); }
}

// ------------------------------------------------------------------- input
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const inputEnabled = () => S && S.phase === 'PLAYING' && isMyTurn() && S.waitingFor < 0 && !debris;

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  if (!inputEnabled()) return;
  const p = canvasPoint(e);
  const hit = cells.find((c) => c.block && !c.forbidden &&
    p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h);
  if (!hit) return;
  canvas.setPointerCapture(e.pointerId);
  selected = hit.block; dragY = 0; jerk = 0; lastPointerY = e.clientY;
  curTight = tightnessOf(S.tower, selected);
  feel.grab(curTight, slipLengthPx(curTight, levelH), e.timeStamp);
  render();
});

canvas.addEventListener('pointermove', (e) => {
  if (!selected) return;
  // movementX/Y is unreliable for touch pointers, so track clientY ourselves.
  const dy = e.clientY - lastPointerY;
  lastPointerY = e.clientY;
  const prev = dragY;
  dragY = Math.max(0, dragY + dy);
  jerk = Math.max(jerk, clamp(Math.abs(dy) / 40, 0, 1));
  feel.slide(dragY - prev, e.timeStamp);
  render();
});

function endDrag() {
  if (!selected) return;
  const extracted = dragY >= levelH * 1.8;
  feel.release(extracted);
  const b = selected;
  selected = null; dragY = 0;
  if (extracted) { const before = S.pulls.reduce((a, c) => a + c, 0); pull(b, jerk); afterPull(before); }
  jerk = 0;
  render();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

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
    : `블록을 아래로 끌어당겨 빼세요 · 현재 시점: ${viewAngle === 0 ? '정면' : '측면'}`;

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
      render(); syncHud();
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
      if (S.round !== prevRound && S.phase === 'PLAYING') viewAngle = 0;
      if ($('gameScreen').classList.contains('on')) { layout(); }
      else enterGame();
      if (S.phase === 'COLLAPSING' && prevPhase !== 'COLLAPSING') { layout(); startCollapse(); }
      else if (S.phase === 'PLAYING' && S.pulls.reduce((a, c) => a + c, 0) > prevPulls) feel.placed();
      if (S.phase === 'ROUND_OVER' || S.phase === 'GAME_OVER') showResult();
      else $('resultOverlay').classList.add('hidden');
      render(); syncHud();
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
$('btnRotate').onclick = () => { viewAngle = 1 - viewAngle; layout(); render(); syncHud(); };
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
