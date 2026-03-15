#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════
// Radar Runner — Terminal Edition
// Same Planck.js (Box2D) physics as the browser version,
// rendered with Unicode half-blocks in the terminal.
// Run:  bun tui.ts
// ═══════════════════════════════════════════════════════════
import planck from 'planck';

// ═══════════════════════════════════════════
// RAW TERMINAL — replaces terminal-kit (zero deps, compiles clean)
// ═══════════════════════════════════════════
const write = (s: string) => process.stdout.write(s);
const termW = () => process.stdout.columns || 80;
const termH = () => process.stdout.rows || 24;

function termSetup() {
  write('\x1b[?1049h');        // alternate screen
  write('\x1b[?25l');          // hide cursor
  write('\x1b[?1000h');        // enable mouse button tracking (X10)
  write('\x1b[?1006h');        // SGR mouse mode (for press/release)
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
}

function termCleanup() {
  write('\x1b[?1006l');        // disable SGR mouse
  write('\x1b[?1000l');        // disable mouse tracking
  write('\x1b[?25h');          // show cursor
  write('\x1b[0m');            // reset styles
  write('\x1b[?1049l');        // leave alternate screen
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

type InputHandler = (type: 'key' | 'mouse', name: string) => void;

function termOnInput(handler: InputHandler) {
  process.stdin.on('data', (data: string) => {
    // SGR mouse: \x1b[<btn;x;yM (press) or \x1b[<btn;x;ym (release)
    const mouseMatch = data.match(/\x1b\[<(\d+);\d+;\d+([Mm])/);
    if (mouseMatch) {
      const btn = parseInt(mouseMatch[1], 10);
      const pressed = mouseMatch[2] === 'M';
      if (btn === 0 || btn === 2) { // left or right button
        handler('mouse', pressed ? 'PRESS' : 'RELEASE');
      }
      return;
    }

    // Key sequences
    if (data === '\x03') { handler('key', 'CTRL_C'); return; }
    if (data === '\x1b' || data === '\x1b\x1b') { handler('key', 'ESCAPE'); return; }
    if (data === '\x1b[A') { handler('key', 'UP'); return; }
    if (data === '\x1b[B') { handler('key', 'DOWN'); return; }
    if (data === ' ') { handler('key', 'SPACE'); return; }
    if (data.length === 1) { handler('key', data); return; }
  });
}

// ═══════════════════════════════════════════
// CONSTANTS — identical to RadarRunner.tsx
// ═══════════════════════════════════════════
const H = 800;
const PTM = 100;
const PLAYER_R = 21;
const BIRD_RADIUS_M = 0.21;

const PLANCK_GRAVITY = 3.5;
const HEAVY_MULT = 7.0;
const START_VX_MS = 2.0;
const START_VY_MS = 4.0;
const MIN_VX_MS = 1.0;
const MAX_VX_MS = 15.0;
const HEIGHT_DRAG_K = 0.007;
const BIRD_FRICTION = 0.0;
const BIRD_RESTITUTION = 0.0;
const TERRAIN_FRICTION = 0.0;

const FEVER_COMBO = 5;
const FEVER_DURATION = 180;
const FEVER_LAUNCH_VY = 5.0;       // m/s upward (Planck y-up)
const FEVER_BOOST_VX = 8.0;        // m/s
const FEVER_GRAVITY_SCALE = 0.5;

const NIGHT_SPEED = 1400 / 60;     // px/frame (at 60Hz)
const NIGHT_START_GAP = 90000;
const NIGHT_GAMEOVER_DIST = 2500;
const NIGHT_GRACE_FRAMES = 60;

const VALLEY_COUNT = 303;
const VALLEY_RESOLUTION = 20;
const TERRAIN_START_X = -300;
const TERRAIN_BASE_Y_UP = 200;
const ISLAND_LENGTH = 9000;

// Display-space (px/frame for HUD speed bar)
const MAX_VX = MAX_VX_MS * PTM / 60;

const COL_PX = 10;                   // base world px per terminal col (before zoom)
const HALF_ROW_PX = 10;              // base world px per half-block row (before zoom)
const RENDER_FPS = 30;

// Camera zoom — same formula as browser version
const ZOOM_MAX = 1.3;
const ZOOM_MIN = 0.15;
const TOP_SCREEN_BUFFER = 50;

// Input: Mouse click gives real press/release (like the browser version).
// Keyboard fallback: SPACE/DOWN = dive, UP = explicit release.
const KEY_COMMIT_MS = 450;
const KEY_REPEAT_TIMEOUT_MS = 100;

// Braille dot bit values — each cell is a 2×4 dot grid
// Layout:  dot1(0x01) dot4(0x08)
//          dot2(0x02) dot5(0x10)
//          dot3(0x04) dot6(0x20)
//          dot7(0x40) dot8(0x80)
const BRAILLE_L = [0x01, 0x02, 0x04, 0x40]; // left col, rows 0-3
const BRAILLE_R = [0x08, 0x10, 0x20, 0x80]; // right col, rows 0-3

// ═══════════════════════════════════════════
// ANSI HELPERS
// ═══════════════════════════════════════════
const CSI = '\x1b[';
const HOME = `${CSI}H`;

function fgA(r: number, g: number, b: number) { return `${CSI}38;2;${r};${g};${b}m`; }
function bgA(r: number, g: number, b: number) { return `${CSI}48;2;${r};${g};${b}m`; }

// ═══════════════════════════════════════════
// SEEDED RNG (exact port from original)
// ═══════════════════════════════════════════
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════
// TERRAIN GENERATION (exact port from original)
// ═══════════════════════════════════════════
interface Valley {
  startX: number; width: number; depth: number;
  baseY: number; endHeight: number;
}

let cachedValleys: Valley[] | null = null;
let cachedSeed = 0;

function generateValleys(seed: number): Valley[] {
  const rng = mulberry32(seed);
  const valleys: Valley[] = [];
  let x = TERRAIN_START_X;
  let y = TERRAIN_BASE_Y_UP;

  for (let i = 0; i < VALLEY_COUNT; i++) {
    let width: number, depth: number, endheight: number;

    if (i < 2) {
      width = 600;
      depth = i === 0 ? -100 : 150;
      endheight = 0;
    } else {
      const j = i - 2;
      if (j <= 30) {
        width = 500 + Math.floor(rng() * 301);
        endheight = Math.floor(rng() * 21) - 10;
        depth = width / 4.0;
      } else if (j < 80) {
        width = 500 + Math.floor(rng() * 301);
        endheight = Math.floor(rng() * 41) - 20;
        depth = width / (3 + Math.floor(rng() * 2));
      } else if (j < 160) {
        width = 450 + Math.floor(rng() * 251);
        endheight = Math.floor(rng() * 51) - 25;
        depth = width / (3 + Math.floor(rng() * 3));
      } else {
        width = 400 + Math.floor(rng() * 301);
        const range = 24 + j / 10;
        endheight = Math.floor(rng() * (range * 2 + 1)) - Math.floor(range);
        depth = width / (3 + Math.floor(rng() * 3));
      }
    }

    if (i >= 2) {
      if (y < -depth + 50) endheight = 0;
      if (y - depth < 30) { depth = y - 30; endheight = 50; }
      if (y > 300) endheight = -(10 + Math.floor(rng() * 41));
    }

    valleys.push({ startX: x, width, depth, baseY: y, endHeight: endheight });
    x += width;
    y += endheight;
  }
  return valleys;
}

function getValleys(seed: number): Valley[] {
  if (!cachedValleys || cachedSeed !== seed) {
    cachedValleys = generateValleys(seed);
    cachedSeed = seed;
  }
  return cachedValleys;
}

/** Returns terrain surface Y in screen coords (y-down, pixels) */
function getTerrainY(worldX: number, seed: number): number {
  const valleys = getValleys(seed);
  if (worldX < valleys[0].startX) return H - valleys[0].baseY;

  let lo = 0, hi = valleys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (valleys[mid].startX <= worldX) lo = mid;
    else hi = mid - 1;
  }

  const v = valleys[lo];
  const localX = worldX - v.startX;
  const t = Math.min(Math.max(localX / v.width, 0), 0.9999);
  const cosVal = Math.cos(t * Math.PI * 2.0);
  const segI = t * VALLEY_RESOLUTION;

  let yUp: number;
  if (segI < VALLEY_RESOLUTION / 2) {
    yUp = v.baseY + (cosVal * 0.5 - 0.5) * v.depth;
  } else {
    yUp = (v.baseY + v.endHeight) + (cosVal * 0.5 - 0.5) * (v.depth + v.endHeight);
  }
  return H - yUp;
}

/** Generate chain vertices for Planck terrain body (exact port) */
function generateChainVertices(seed: number): planck.Vec2Value[] {
  const valleys = getValleys(seed);
  const verts: planck.Vec2Value[] = [];

  for (const v of valleys) {
    const segWidth = v.width / VALLEY_RESOLUTION;
    for (let i = 0; i < VALLEY_RESOLUTION; i++) {
      const px = v.startX + i * segWidth;
      const screenY = getTerrainY(px, seed);
      verts.push(planck.Vec2(px / PTM, -screenY / PTM));
    }
  }
  const lastV = valleys[valleys.length - 1];
  const endX = lastV.startX + lastV.width;
  verts.push(planck.Vec2(endX / PTM, -getTerrainY(endX, seed) / PTM));
  verts.reverse();
  return verts;
}

// ═══════════════════════════════════════════
// PLANCK.JS PHYSICS WORLD
// ═══════════════════════════════════════════
let world: planck.World | null = null;
let bird: planck.Body | null = null;

function createPhysicsWorld(seed: number) {
  world = planck.World({ gravity: planck.Vec2(0, -PLANCK_GRAVITY) });

  const chainVerts = generateChainVertices(seed);
  const ground = world.createBody();
  ground.createFixture(planck.Chain(chainVerts, false), {
    friction: TERRAIN_FRICTION,
    restitution: 0.0,
  });

  const startScreenY = getTerrainY(0, seed) - PLAYER_R;
  bird = world.createDynamicBody({
    position: planck.Vec2(0, -startScreenY / PTM),
    bullet: true,
  });
  bird.createFixture(planck.Circle(BIRD_RADIUS_M), {
    density: 1.0,
    friction: BIRD_FRICTION,
    restitution: BIRD_RESTITUTION,
  });
  bird.setLinearVelocity(planck.Vec2(START_VX_MS, START_VY_MS));
}

// ═══════════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════════
type Phase = 'idle' | 'playing' | 'dead' | 'paused';

interface TrailPt { wx: number; wy: number; age: number; bright: boolean; }

const S = {
  phase: 'idle' as Phase,
  seed: 42,
  frame: 0,
  score: 0,
  best: 0,
  px: 0, py: 0,       // world pixels, y-down
  vx: 0, vy: 0,       // px/frame (display-space, matching original)
  nightX: 0,
  nightChasing: false,
  combo: 0,
  comboTimer: 0,
  perfectLandings: 0,
  fever: false,
  feverPending: false,
  feverTimer: 0,
  feverFlash: 0,
  wasOnGround: true,
  island: 0,
  zoom: 1.0,
  trail: [] as TrailPt[],
  smoothTerrY: 500,       // smoothed terrain height for stable camera
};

// Fixed star positions (generated once)
const STARS = Array.from({ length: 20 }, (_, i) => ({
  sx: (i * 137 + 43) % 100 / 100,   // fractional screen x [0,1]
  sy: (i * 89 + 17) % 60 / 100,     // fractional screen y [0,0.6]
  tw: i * 0.7,                       // twinkle offset
}));

let holding = false;
let lastKeyTime = 0;
let holdStartTime = 0;   // when current hold began (for commit window)

function resetGame() {
  S.seed = Math.floor(Math.random() * 99999) + 1;
  cachedValleys = null;
  createPhysicsWorld(S.seed);

  const startScreenY = getTerrainY(0, S.seed) - PLAYER_R;
  S.px = 0;
  S.py = startScreenY;
  S.vx = START_VX_MS * PTM / 60;
  S.vy = -START_VY_MS * PTM / 60;
  S.nightX = -NIGHT_START_GAP;
  S.nightChasing = false;
  S.frame = 0;
  S.score = 0;
  S.phase = 'playing';
  S.island = 0;
  S.combo = 0;
  S.comboTimer = 0;
  S.perfectLandings = 0;
  S.fever = false;
  S.feverPending = false;
  S.feverTimer = 0;
  S.feverFlash = 0;
  S.wasOnGround = true;
  S.zoom = 1.0;
  S.smoothTerrY = getTerrainY(0, S.seed);
  S.trail = [];
  holding = false;
}

// ═══════════════════════════════════════════
// PHYSICS TICK — exact port of RadarRunner.tsx game loop
// Called at 60Hz (2× per 30fps render frame)
// ═══════════════════════════════════════════
function physicsTick() {
  if (S.phase !== 'playing' || !world || !bird) return;
  S.frame++;

  // ── Fever mode ──
  if (S.fever) {
    S.feverTimer--;
    if (S.feverTimer <= 0) {
      S.fever = false;
      bird.setGravityScale(1.0);
    } else {
      bird.setGravityScale(FEVER_GRAVITY_SCALE);
      const vel = bird.getLinearVelocity();
      if (vel.x < FEVER_BOOST_VX) {
        bird.setLinearVelocity(planck.Vec2(FEVER_BOOST_VX, vel.y));
      }
      world.step(1 / 60, 6, 2);
      const pos = bird.getPosition();
      const newVel = bird.getLinearVelocity();
      S.px = pos.x * PTM;
      S.py = -pos.y * PTM;
      S.vx = newVel.x * PTM / 60;
      S.vy = -newVel.y * PTM / 60;
    }
  }
  // ── Normal physics ──
  else {
    // 1. Gravity scale
    bird.setGravityScale(holding ? HEAVY_MULT : 1.0);

    // 2. Step
    world.step(1 / 60, 6, 2);

    // 3. Read position & velocity
    const pos = bird.getPosition();
    const newVel = bird.getLinearVelocity();
    S.px = pos.x * PTM;
    S.py = -pos.y * PTM;
    S.vx = newVel.x * PTM / 60;
    S.vy = -newVel.y * PTM / 60;

    // 3b. Fever pending — activate on upswing
    if (S.feverPending && newVel.y > 0.5) {
      S.feverPending = false;
      S.fever = true;
      S.feverTimer = FEVER_DURATION;
      bird.setLinearVelocity(planck.Vec2(
        Math.max(newVel.x, FEVER_BOOST_VX),
        FEVER_LAUNCH_VY,
      ));
    }

    // 4. Min velocity clamp
    const vel = bird.getLinearVelocity();
    if (vel.x < MIN_VX_MS) {
      bird.setLinearVelocity(planck.Vec2(MIN_VX_MS, vel.y));
    }

    // 5. Height drag
    if (vel.y > 0) {
      const origPosY = pos.y + H / PTM;
      if (origPosY > 0) {
        const downForce = origPosY * origPosY * HEIGHT_DRAG_K;
        bird.applyForceToCenter(planck.Vec2(0, -downForce), true);
      }
    }

    // 6. Landing detection
    const terrainY = getTerrainY(S.px, S.seed);
    const surfaceY = terrainY - PLAYER_R;
    const onGround = S.py >= surfaceY - 8;
    const wasAbove = S.wasOnGround === false;

    if (onGround && wasAbove) {
      const slope = getTerrainY(S.px + 2, S.seed) - getTerrainY(S.px - 2, S.seed);
      if (slope > 0.2 && holding && S.vx > 6) {
        S.combo++;
        S.comboTimer = 90;
        S.perfectLandings++;
        if (S.combo >= FEVER_COMBO && !S.fever && !S.feverPending) {
          S.feverPending = true;
        }
      } else {
        S.combo = 0;
      }
    }
    S.wasOnGround = onGround;
  }

  // ── Night chaser ──
  if (!S.nightChasing && S.frame >= NIGHT_GRACE_FRAMES) S.nightChasing = true;
  if (S.nightChasing && S.nightX < S.px) S.nightX += NIGHT_SPEED;

  if (S.nightChasing && S.px - S.nightX <= NIGHT_GAMEOVER_DIST) {
    S.phase = 'dead';
    if (S.score > S.best) S.best = S.score;
    if (bird) {
      const v = bird.getLinearVelocity();
      bird.setLinearVelocity(planck.Vec2(0, v.y > 0 ? -5.0 : v.y));
    }
  }

  S.score = Math.floor(S.px / 10) * 10;
  S.island = Math.floor(S.px / ISLAND_LENGTH);
  if (S.comboTimer > 0) S.comboTimer--;
  if (S.feverFlash > 0) S.feverFlash--;

  // Camera zoom — pure altitude-based (stable, no terrain oscillation).
  // Higher bird = lower zoom = more world visible.
  const playerYUp = H - S.py;
  const yPos = Math.max(1, playerYUp + TOP_SCREEN_BUFFER);
  const targetZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, 480 / yPos));
  S.zoom += (targetZoom - S.zoom) * 0.06;

  // Smooth terrain reference — tracks slowly so camera doesn't jitter over hills
  const rawTerrY = getTerrainY(S.px, S.seed);
  S.smoothTerrY += (rawTerrY - S.smoothTerrY) * 0.03;

  // Trail
  if (S.frame % 2 === 0) {
    S.trail.push({ wx: S.px, wy: S.py, age: 0, bright: S.fever });
  }
  for (let i = S.trail.length - 1; i >= 0; i--) {
    S.trail[i].age++;
    if (S.trail[i].age > 35) S.trail.splice(i, 1);
  }

  // Fever flash trigger
  if (S.feverPending && !S.fever) S.feverFlash = Math.max(S.feverFlash, 30);
}

// Dead state: keep bird falling
function deadTick() {
  if (S.phase !== 'dead' || !world || !bird) return;
  const vel = bird.getLinearVelocity();
  bird.setLinearVelocity(planck.Vec2(0, vel.y > 0 ? -5.0 : vel.y));
  bird.setGravityScale(1.0);
  world.step(1 / 60, 6, 2);
  const pos = bird.getPosition();
  S.py = -pos.y * PTM;
}

// ═══════════════════════════════════════════
// THEME — dark/light mode with auto-detection
// ═══════════════════════════════════════════
type RGB = [number, number, number];

// Auto-detect: COLORFGBG env var (set by many terminals), or $TERM_PROGRAM hints
function detectDarkMode(): boolean {
  const fgbg = process.env.COLORFGBG;
  if (fgbg) {
    const bg = parseInt(fgbg.split(';').pop() || '0', 10);
    return bg < 8;  // dark background colors are 0-7
  }
  // macOS Terminal.app defaults to light; iTerm2/kitty/alacritty default to dark
  const tp = process.env.TERM_PROGRAM || '';
  if (/terminal/i.test(tp)) return false;
  return true; // default dark
}

let isDark = detectDarkMode();

interface Theme {
  sky: RGB; terrFill: RGB; terrDeep: RGB; hudBg: RGB;
  text: RGB; textBright: RGB;
  palettes: RGB[];
}

const DARK_THEME: Theme = {
  sky: [20, 22, 30], terrFill: [38, 40, 35], terrDeep: [28, 30, 26],
  hudBg: [12, 12, 16], text: [100, 100, 100], textBright: [220, 220, 220],
  palettes: [
    [253, 82, 0], [120, 190, 120], [90, 160, 220],
    [220, 170, 60], [180, 100, 220], [253, 120, 80],
  ],
};

const LIGHT_THEME: Theme = {
  sky: [235, 241, 229], terrFill: [210, 220, 200], terrDeep: [195, 205, 185],
  hudBg: [225, 230, 220], text: [100, 100, 100], textBright: [30, 30, 30],
  palettes: [
    [140, 175, 90], [200, 155, 70], [100, 160, 180],
    [190, 120, 80], [140, 130, 180], [170, 190, 100],
  ],
};

function T(): Theme { return isDark ? DARK_THEME : LIGHT_THEME; }

const ORANGE: RGB = [253, 82, 0];

function getPalette(worldX: number): RGB {
  const pals = T().palettes;
  const p = worldX / ISLAND_LENGTH;
  const i = Math.floor(Math.abs(p)) % pals.length;
  const j = (i + 1) % pals.length;
  const t = p - Math.floor(p);
  const s = t < 0.8 ? 0 : ((t - 0.8) / 0.2) ** 2 * (3 - 2 * ((t - 0.8) / 0.2));
  const a = pals[i], b = pals[j];
  return [
    Math.round(a[0] + (b[0] - a[0]) * s),
    Math.round(a[1] + (b[1] - a[1]) * s),
    Math.round(a[2] + (b[2] - a[2]) * s),
  ];
}

function dim(c: RGB, f: number): RGB {
  return [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];
}

function sunSky(sunH: number): RGB {
  const f = isDark ? (0.4 + sunH * 0.6) : (0.85 + sunH * 0.15);
  return dim(T().sky, f);
}

// ═══════════════════════════════════════════
// RENDERER — builds ANSI frame string
// ═══════════════════════════════════════════
function render() {
  const cols = Math.max(40, Math.min(300, termW()));
  const rows = Math.max(12, Math.min(100, termH()));
  const gameRows = rows - 2;
  const birdCol = Math.max(8, Math.floor(cols * 0.15));

  const isPlaying = S.phase === 'playing' || S.phase === 'paused';
  const sunH = S.phase === 'idle' ? 1 : Math.max(0, Math.min(1, (S.px - S.nightX) / NIGHT_START_GAP));
  const sky = sunSky(sunH);
  const seed = S.phase === 'idle' ? 42 : S.seed;
  const lineClr = S.phase === 'idle' ? ORANGE : getPalette(S.px);

  // Zoom: scale pixels-per-cell dynamically (zoomed out = more world per cell)
  const zoom = S.phase === 'idle' ? 1.0 : S.zoom;
  const cpx = COL_PX / zoom;         // effective world px per column
  const hpx = HALF_ROW_PX / zoom;    // effective world px per half-row
  const birdTargetRow = Math.floor(gameRows * (zoom > 0.8 ? 0.4 : 0.3));

  // Camera
  let camX: number, camTopY: number, birdPy: number;
  if (S.phase === 'idle') {
    camX = -birdCol * cpx + 160;
    birdPy = getTerrainY(0, 42) - PLAYER_R + Math.sin(Date.now() / 400) * 16;
    camTopY = birdPy - birdTargetRow * hpx * 2;
  } else {
    camX = S.px - birdCol * cpx;
    birdPy = S.py;
    camTopY = birdPy - birdTargetRow * hpx * 2;
  }

  // Clamp camera: keep terrain visible using smoothed reference (no hill jitter)
  const viewBottom = camTopY + gameRows * hpx * 2;
  const stableTerrY = S.phase === 'idle' ? getTerrainY(0, 42) : S.smoothTerrY;
  if (viewBottom < stableTerrY + 20) {
    camTopY = stableTerrY + 20 - gameRows * hpx * 2;
  }

  // Bird position in terminal cells
  const birdHalfRow = Math.round((birdPy - camTopY) / hpx);
  const birdRow = Math.floor(birdHalfRow / 2);

  const nightCol = S.nightChasing && S.phase !== 'idle'
    ? Math.floor((S.nightX - camX) / cpx) : -999;

  // Pre-compute trail cell map: key = "row,col" → brightness
  const trailMap = new Map<string, { alpha: number; bright: boolean }>();
  for (const t of S.trail) {
    const tc = Math.floor((t.wx - camX) / cpx);
    const thr = Math.round((t.wy - camTopY) / hpx);
    const tr = Math.floor(thr / 2);
    if (tr >= 0 && tr < gameRows && tc >= 0 && tc < cols) {
      const alpha = Math.max(0, 1 - t.age / 35);
      const key = `${tr},${tc}`;
      const existing = trailMap.get(key);
      if (!existing || alpha > existing.alpha) {
        trailMap.set(key, { alpha, bright: t.bright });
      }
    }
  }

  // ── Build frame ──
  const out: string[] = [HOME];
  let pf: RGB = [-1, -1, -1];
  let pb: RGB = [-1, -1, -1];

  function setF(c: RGB) {
    if (c[0] !== pf[0] || c[1] !== pf[1] || c[2] !== pf[2]) {
      out.push(fgA(c[0], c[1], c[2]));
      pf = c;
    }
  }
  function setB(c: RGB) {
    if (c[0] !== pb[0] || c[1] !== pb[1] || c[2] !== pb[2]) {
      out.push(bgA(c[0], c[1], c[2]));
      pb = c;
    }
  }

  // ── HUD top row ──
  setB(T().hudBg);
  setF(T().text);
  if (isPlaying || S.phase === 'dead') {
    const pct = Math.min(1, Math.max(0, S.vx / MAX_VX));
    const filled = Math.round(pct * 20);
    const comboStr = S.fever ? ' FEVER!' : S.combo > 0 ? ` x${S.combo}` : '';
    const left = ` SPD `;
    const zone = `  ${comboStr}  ZONE ${S.island + 1}`;
    const zStr = zoom < 1.2 ? ` Z:${zoom.toFixed(1)}` : '';
    const right = `${zStr}  HI ${String(S.best).padStart(5, '0')}  ${String(S.score).padStart(5, '0')} `;
    const midLen = Math.max(0, cols - left.length - 20 - right.length);
    const mid = zone.padEnd(midLen).slice(0, midLen);

    out.push(left);
    setF(S.fever ? [255, 140, 0] as RGB : ORANGE);
    out.push('\u2588'.repeat(filled));
    setF([50, 50, 50]);
    out.push('\u2591'.repeat(20 - filled));
    setF(S.combo > 0 || S.fever ? ORANGE : T().text);
    out.push(mid);
    setF([253, 200, 100]);
    out.push(right);
  } else {
    out.push(' RADAR RUNNER'.padEnd(cols).slice(0, cols));
  }
  out.push('\r\n');

  // ── Game area ──
  for (let r = 0; r < gameRows; r++) {
    for (let c = 0; c < cols; c++) {
      const worldX = camX + c * cpx;
      const terrY = getTerrainY(worldX, seed);

      const topStart = camTopY + r * hpx * 2;
      const topEnd = topStart + hpx;
      const botEnd = topEnd + hpx;

      // Night dimming
      let nd = 1.0;
      if (c < nightCol) nd = 0.08;
      else if (c < nightCol + 25) nd = 0.08 + (c - nightCol) / 25 * 0.92;

      // Fever screen tint
      if (S.fever) nd *= 0.92 + Math.sin(S.frame * 0.1) * 0.08;

      const depthBelow = topStart - terrY;

      let ch: string;
      let fgC: RGB;
      let bgC: RGB;

      const surfClr: RGB = S.fever
        ? [253, Math.round(82 + Math.sin(S.frame * 0.2) * 80), 0]
        : lineClr;
      const fillClr = depthBelow > 60 ? T().terrDeep : T().terrFill;

      // Compute parallax-tinted sky FIRST (used by both sky and surface cells)
      let skyHere: RGB = dim(sky, nd);
      if (terrY > topStart) { // only for cells with any sky
        const pxPos = S.phase === 'idle' ? 160 : S.px;
        for (const pl of [
          { speed: 0.08, frac: 0.55, amp: 0.08, freq: 0.001, off: 0,
            clr: (isDark ? [255, 255, 255] : [60, 100, 40]) as RGB, a: isDark ? 0.04 : 0.06 },
          { speed: 0.15, frac: 0.62, amp: 0.10, freq: 0.00175, off: 500,
            clr: (isDark ? [255, 255, 255] : [60, 100, 40]) as RGB, a: isDark ? 0.06 : 0.08 },
        ]) {
          const pScrollX = pxPos * pl.speed;
          const pInputX = pScrollX + c * cpx + pl.off;
          const hillFrac = pl.frac + Math.sin(pInputX * pl.freq) * pl.amp
                         + Math.sin(pInputX * pl.freq * 2.3 + 1.7) * pl.amp * 0.4;
          if (r >= Math.floor(hillFrac * gameRows)) {
            skyHere = [
              Math.min(255, Math.round(skyHere[0] + pl.clr[0] * pl.a * nd)),
              Math.min(255, Math.round(skyHere[1] + pl.clr[1] * pl.a * nd)),
              Math.min(255, Math.round(skyHere[2] + pl.clr[2] * pl.a * nd)),
            ];
          }
        }
      }

      if (terrY <= topStart) {
        // Fully underground
        ch = ' ';
        bgC = dim(fillClr, nd); fgC = bgC;
      } else if (terrY <= botEnd) {
        // Surface — braille for 4× vertical resolution
        let code = 0;
        const subH = hpx / 2;
        for (let sx = 0; sx < 2; sx++) {
          const subX = worldX + sx * cpx / 2;
          const subTerrY = getTerrainY(subX, seed);
          for (let sy = 0; sy < 4; sy++) {
            if (subTerrY <= topStart + sy * subH) {
              code |= (sx === 0 ? BRAILLE_L : BRAILLE_R)[sy];
            }
          }
        }
        ch = String.fromCharCode(0x2800 + code);
        fgC = dim(surfClr, nd);
        bgC = skyHere;  // parallax-aware sky background
      } else {
        // Fully sky
        ch = ' ';
        bgC = skyHere; fgC = skyHere;

        // Sun
        const sunCol = Math.floor(cols * 0.55);
        const sunRow = Math.floor(1 + (1 - sunH) * gameRows * 0.45);
        if (r === sunRow && c === sunCol) {
          const sr = Math.round(253 + (200 - 253) * (1 - sunH));
          const sg = Math.round(200 - 140 * (1 - sunH));
          const sb = Math.round(80 - 80 * (1 - sunH));
          const sa = 0.5 + sunH * 0.4;
          fgC = [Math.round(sr * sa * nd), Math.round(sg * sa * nd), Math.round(sb * sa * nd)];
          ch = '\u25cf'; // ● sun
        } else if (Math.abs(r - sunRow) <= 1 && Math.abs(c - sunCol) <= 1 && sunH > 0.3) {
          const ga = 0.15 * sunH * nd;
          bgC = [
            Math.min(255, Math.round(bgC[0] + 253 * ga)),
            Math.min(255, Math.round(bgC[1] + 180 * ga)),
            Math.min(255, Math.round(bgC[2] + 80 * ga)),
          ];
          fgC = bgC;
        }

        // Stars
        if (sunH < 0.5) {
          for (const star of STARS) {
            if (c === Math.floor(star.sx * cols) && r === Math.floor(star.sy * gameRows)) {
              const twinkle = Math.sin(S.frame * 0.05 + star.tw) * 0.3 + 0.7;
              const sa = ((0.5 - sunH) / 0.5) * twinkle * 0.7;
              fgC = [Math.round(200 * sa * nd), Math.round(200 * sa * nd), Math.round(230 * sa * nd)];
              ch = '\u00b7';
            }
          }
        }
      }

      // Trail overlay
      const trailInfo = trailMap.get(`${r},${c}`);
      if (trailInfo && !(r === birdRow && c === birdCol)) {
        const ta = trailInfo.alpha * 0.6 * nd;
        if (trailInfo.bright) {
          fgC = [Math.round(253 * ta), Math.round(82 * ta), 0];
        } else {
          fgC = [Math.round(200 * ta), Math.round(60 * ta), 0];
        }
        ch = '\u2022'; // bullet dot
      }

      // Bird overlay — full cell when flying, smaller when diving, color shifts
      if (r === birdRow && c === birdCol) {
        const dive = holding ? 1 : 0;
        // Color: orange → yellow-white when diving (matches browser)
        const br = Math.round(253 + (255 - 253) * dive);
        const bg_ = Math.round(82 + (170 - 82) * dive);
        let bClr: RGB = [br, bg_, 0];
        if (S.fever) bClr = [255, Math.round(140 + Math.sin(S.frame * 0.15) * 80), 0];

        if (dive) {
          // Diving: smaller bird (center 4 dots) — shows the "squish"
          const birdLocalY = (birdPy - topStart) / (hpx / 2);
          const bsr = Math.round(Math.max(1, Math.min(2, birdLocalY)));
          const bCode = BRAILLE_L[bsr - 1] | BRAILLE_R[bsr - 1]
                      | BRAILLE_L[bsr] | BRAILLE_R[bsr];
          ch = String.fromCharCode(0x2800 + bCode);
        } else {
          // Flying: full cell (all 8 dots)
          ch = String.fromCharCode(0x2800 + 0xFF);
        }
        fgC = dim(bClr, nd);
        bgC = terrY <= topStart ? dim(T().terrFill, nd) : skyHere;
      }

      // Fever flash overlay
      if (S.feverFlash > 0) {
        const ff = (S.feverFlash / 30) * 0.4;
        fgC = [Math.min(255, fgC[0] + Math.round(253 * ff)),
               Math.min(255, fgC[1] + Math.round(82 * ff)),
               Math.min(255, fgC[2])];
      }

      setF(fgC);
      setB(bgC);
      out.push(ch);
    }
    if (r < gameRows - 1) out.push('\r\n');
  }

  // ── Combo text in game area ──
  if (isPlaying && S.comboTimer > 0 && S.combo >= 1) {
    const comboAlpha = Math.min(1, S.comboTimer / 30);
    const comboText = S.feverPending ? 'FEVER READY!'
      : S.combo >= FEVER_COMBO ? `FEVER x${S.combo}!`
      : S.combo > 1 ? `x${S.combo} Perfect!` : 'Perfect!';
    const comboRow = Math.max(2, birdRow - 2 + 2); // above bird, +2 for HUD offset
    const comboCx = Math.max(1, Math.floor((cols - comboText.length) / 2) + 1);
    if (comboRow >= 2 && comboRow <= gameRows) {
      out.push(`${CSI}${comboRow};${comboCx}H`);
      const ci = Math.round(253 * comboAlpha);
      setF([ci, Math.round(82 * comboAlpha), 0]);
      out.push(comboText);
    }
  }

  // ── Bottom HUD row ──
  out.push(`${CSI}${rows};1H`);
  setB(T().hudBg);
  setF(T().text);
  let botLine: string;
  const themeLabel = isDark ? 'dark' : 'light';
  if (S.phase === 'idle') {
    botLine = ` Click/SPACE: start \u00b7 T: theme(${themeLabel}) \u00b7 Q: quit`;
    if (S.best > 0) botLine += `  \u00b7  Best: ${S.best}`;
  } else if (S.phase === 'dead') {
    botLine = ` Night fell! Distance: ${S.score}`;
    if (S.perfectLandings > 0)
      botLine += ` \u00b7 ${S.perfectLandings} perfect slide${S.perfectLandings !== 1 ? 's' : ''}`;
    botLine += ' \u00b7 SPACE: retry \u00b7 R: menu';
  } else if (S.phase === 'paused') {
    botLine = ` PAUSED \u00b7 P/ESC: resume \u00b7 R: reset \u00b7 T: theme(${themeLabel}) \u00b7 Q: quit`;
  } else {
    botLine = holding
      ? ` \u25bc DIVING \u00b7 P: pause \u00b7 R: reset \u00b7 T: theme(${themeLabel})`
      : ` \u25b2 flying \u00b7 P: pause \u00b7 R: reset \u00b7 T: theme(${themeLabel})`;
  }
  out.push(botLine.padEnd(cols).slice(0, cols));

  // ── Centered overlays ──
  if (S.phase === 'idle') {
    const cr = Math.floor(gameRows * 0.3) + 2;
    const lines: [string, RGB][] = [
      ['RADAR RUNNER', ORANGE],
      ['', T().text],
      ['Click to dive \u00b7 Release to fly', T().textBright],
      ['', T().text],
      ['[ Click or SPACE to start ]', T().text],
    ];
    if (S.best > 0) lines.push(['', T().text], [`Best: ${S.best}`, ORANGE]);
    for (let i = 0; i < lines.length; i++) {
      const [text, clr] = lines[i];
      if (!text) continue;
      const cx = Math.max(1, Math.floor((cols - text.length) / 2) + 1);
      out.push(`${CSI}${cr + i};${cx}H`);
      setF(clr); setB(sky);
      out.push(text);
    }
  }

  if (S.phase === 'dead') {
    const cr = Math.floor(gameRows * 0.35) + 2;
    const overlay: RGB = isDark ? [8, 6, 14] : [240, 240, 235];
    for (let dr = -2; dr <= 5; dr++) {
      const row = cr + dr;
      if (row < 2 || row > gameRows + 1) continue;
      out.push(`${CSI}${row};1H`);
      setB(overlay); setF(overlay);
      out.push(' '.repeat(cols));
    }
    const dlines: [string, RGB, number][] = [
      ['NIGHT FELL', ORANGE, 0],
      [`Distance: ${S.score}`, T().textBright, 2],
    ];
    if (S.perfectLandings > 0) {
      dlines.push([
        `${S.perfectLandings} perfect slide${S.perfectLandings !== 1 ? 's' : ''} \u00b7 Zone ${S.island + 1}`,
        [140, 140, 140], 3,
      ]);
    }
    dlines.push(['[ Press SPACE to retry ]', [180, 180, 180], 5]);
    for (const [text, clr, dr] of dlines) {
      const cx = Math.max(1, Math.floor((cols - text.length) / 2) + 1);
      out.push(`${CSI}${cr + dr};${cx}H`);
      setF(clr); setB(overlay);
      out.push(text);
    }
  }

  if (S.phase === 'paused') {
    const cr = Math.floor(gameRows * 0.4) + 2;
    const overlay: RGB = isDark ? [8, 8, 12] : [240, 240, 235];
    for (let dr = -1; dr <= 2; dr++) {
      const row = cr + dr;
      if (row < 2 || row > gameRows + 1) continue;
      out.push(`${CSI}${row};1H`);
      setB(overlay); setF(overlay);
      out.push(' '.repeat(cols));
    }
    const pauseText = 'PAUSED';
    const resumeText = 'Press ESC to resume';
    out.push(`${CSI}${cr};${Math.floor((cols - pauseText.length) / 2) + 1}H`);
    setF(T().textBright); setB(overlay);
    out.push(pauseText);
    out.push(`${CSI}${cr + 1};${Math.floor((cols - resumeText.length) / 2) + 1}H`);
    setF(T().text);
    out.push(resumeText);
  }

  process.stdout.write(out.join(''));
}

// ═══════════════════════════════════════════
// TERMINAL SETUP (raw ANSI — zero dependencies)
// ═══════════════════════════════════════════
function cleanup() {
  termCleanup();
  setTimeout(() => process.exit(0), 100);
}

termSetup();

let mouseHeld = false;

termOnInput((type, name) => {
  // ── Mouse ──
  if (type === 'mouse') {
    if (name === 'PRESS') {
      if (S.phase === 'idle' || S.phase === 'dead') resetGame();
      mouseHeld = true;
      holding = true;
    } else if (name === 'RELEASE') {
      mouseHeld = false;
      holding = false;
    }
    return;
  }

  // ── Keys ──
  if (name === 'CTRL_C' || name === 'q') { cleanup(); return; }

  if (name === 'SPACE' || name === 'DOWN') {
    if (S.phase === 'paused') { S.phase = 'playing'; return; }
    if (S.phase === 'idle' || S.phase === 'dead') resetGame();
    const now = Date.now();
    if (!holding) holdStartTime = now;
    holding = true;
    lastKeyTime = now;
    return;
  }

  if (name === 'UP') {
    holding = false;
    holdStartTime = 0;
    lastKeyTime = 0;
    return;
  }

  if (name === 'ESCAPE' || name === 'p') {
    if (S.phase === 'playing') { S.phase = 'paused'; holding = false; }
    else if (S.phase === 'paused') { S.phase = 'playing'; }
    return;
  }

  if (name === 'r') { S.phase = 'idle'; holding = false; return; }
  if (name === 't') { isDark = !isDark; }
});

// ═══════════════════════════════════════════
// GAME LOOP — physics at 60Hz, render at 30fps
// ═══════════════════════════════════════════
let frameParity = 0;

setInterval(() => {
  const now = Date.now();

  // Key release detection (keyboard only — mouse has real release events).
  // Don't override if mouse button is physically held down.
  if (holding && !mouseHeld && lastKeyTime > 0) {
    const sinceStart = now - holdStartTime;
    const sinceLast = now - lastKeyTime;
    if (sinceStart >= KEY_COMMIT_MS && sinceLast > KEY_REPEAT_TIMEOUT_MS) {
      holding = false;
    }
  }

  // Physics at 60Hz (every tick) — skip when paused
  if (S.phase === 'playing') physicsTick();
  else if (S.phase === 'dead') deadTick();

  // Render at 30fps (every other tick)
  frameParity++;
  if (frameParity % 2 === 0) render();
}, Math.floor(1000 / 60));
