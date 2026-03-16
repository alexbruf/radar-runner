// Heavy game module — lazy-loaded by the shell.
// Contains planck.js physics and all game logic.
import planck from 'planck';

// ════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════
const W = 1280;
const H = 800;
const PLAYER_R = 21;
const BIRD_RADIUS_M = 0.21;

const PTM = 100;
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

const MIN_VX = MIN_VX_MS * PTM / 60;
const MAX_VX = MAX_VX_MS * PTM / 60;

const FEVER_COMBO = 5;
const FEVER_DURATION = 180;
const FEVER_LAUNCH_VY = 5.0;
const FEVER_BOOST_VX = 8.0;
const FEVER_GRAVITY_SCALE = 0.5;

const NIGHT_SPEED = 1400 / 60;
const NIGHT_START_GAP = 90000;
const NIGHT_GAMEOVER_DIST = 2500;
const NIGHT_GRACE_FRAMES = 60;

const VALLEY_COUNT = 303;
const VALLEY_RESOLUTION = 20;
const TERRAIN_START_X = -300;
const TERRAIN_BASE_Y_UP = 200;
const ISLAND_LENGTH = 9000;

const ZOOM_MAX = 1.3;
const ZOOM_MIN = 0.15;
const TOP_SCREEN_BUFFER = 50;
const PLAYER_SCREEN_X = 160;

type GameState = 'idle' | 'playing' | 'dead' | 'paused';

// ════════════════════════════════════════════════════════
// SEEDED RNG
// ════════════════════════════════════════════════════════
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ════════════════════════════════════════════════════════
// TERRAIN
// ════════════════════════════════════════════════════════
interface Valley {
  startX: number;
  width: number;
  depth: number;
  baseY: number;
  endHeight: number;
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

// ════════════════════════════════════════════════════════
// ISLAND PALETTES
// ════════════════════════════════════════════════════════
const DARK_PALETTES = [
  { layers: ['rgba(253,82,0,0.10)', 'rgba(253,82,0,0.06)', 'rgba(253,82,0,0.03)'], line: 'rgba(253,82,0,0.25)' },
  { layers: ['rgba(120,190,120,0.10)', 'rgba(120,190,120,0.06)', 'rgba(120,190,120,0.03)'], line: 'rgba(120,190,120,0.22)' },
  { layers: ['rgba(90,160,220,0.10)', 'rgba(90,160,220,0.06)', 'rgba(90,160,220,0.03)'], line: 'rgba(90,160,220,0.22)' },
  { layers: ['rgba(220,170,60,0.10)', 'rgba(220,170,60,0.06)', 'rgba(220,170,60,0.03)'], line: 'rgba(220,170,60,0.22)' },
  { layers: ['rgba(180,100,220,0.08)', 'rgba(180,100,220,0.05)', 'rgba(180,100,220,0.03)'], line: 'rgba(180,100,220,0.20)' },
  { layers: ['rgba(253,120,80,0.10)', 'rgba(253,120,80,0.06)', 'rgba(253,120,80,0.03)'], line: 'rgba(253,120,80,0.25)' },
];

const LIGHT_PALETTES = [
  { layers: ['rgba(140,175,90,0.18)', 'rgba(140,175,90,0.10)', 'rgba(140,175,90,0.05)'], line: 'rgba(80,120,50,0.20)' },
  { layers: ['rgba(200,155,70,0.16)', 'rgba(200,155,70,0.10)', 'rgba(200,155,70,0.05)'], line: 'rgba(160,120,40,0.18)' },
  { layers: ['rgba(100,160,180,0.16)', 'rgba(100,160,180,0.10)', 'rgba(100,160,180,0.05)'], line: 'rgba(60,120,140,0.18)' },
  { layers: ['rgba(190,120,80,0.16)', 'rgba(190,120,80,0.10)', 'rgba(190,120,80,0.05)'], line: 'rgba(160,90,50,0.18)' },
  { layers: ['rgba(140,130,180,0.14)', 'rgba(140,130,180,0.08)', 'rgba(140,130,180,0.04)'], line: 'rgba(100,90,150,0.16)' },
  { layers: ['rgba(170,190,100,0.18)', 'rgba(170,190,100,0.10)', 'rgba(170,190,100,0.05)'], line: 'rgba(120,150,60,0.20)' },
];

function lerpColor(a: string, b: string, t: number): string {
  const parse = (s: string) => {
    const m = s.match(/[\d.]+/g);
    return m ? m.map(Number) : [0, 0, 0, 0];
  };
  const ca = parse(a);
  const cb = parse(b);
  return `rgba(${Math.round(ca[0] + (cb[0] - ca[0]) * t)},${Math.round(ca[1] + (cb[1] - ca[1]) * t)},${Math.round(ca[2] + (cb[2] - ca[2]) * t)},${(ca[3] + (cb[3] - ca[3]) * t).toFixed(3)})`;
}

// ════════════════════════════════════════════════════════
// GAME FACTORY
// ════════════════════════════════════════════════════════
export function createGame(container: HTMLElement, initialDark: boolean, uiOverlay?: HTMLElement) {
  let isDark = initialDark;
  let holding = false;
  let showHelp = false;
  let raf = 0;
  let world: planck.World | null = null;
  let bird: planck.Body | null = null;

  const state = {
    px: 0, py: 0, vx: 0, vy: 0,
    nightX: 0, nightChasing: false, sunHeight: 1,
    seed: 42, frame: 0, score: 0, best: 0,
    gameState: 'idle' as GameState,
    island: 0,
    trail: [] as { x: number; y: number; age: number; bright?: boolean }[],
    particles: [] as { x: number; y: number; vx: number; vy: number; life: number; maxLife: number }[],
    combo: 0, comboTimer: 0, perfectLandings: 0,
    fever: false, feverPending: false, feverTimer: 0, feverFlash: 0,
    diveVisual: 0, angle: 0, zoom: 1.0, wasOnGround: true,
  };

  // ── DOM ──
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = 'border-radius:2px;cursor:pointer;outline:none;user-select:none;-webkit-user-select:none;touch-action:none;width:100%;height:100%;';
  const ctx = canvas.getContext('2d')!;

  canvas.addEventListener('mousedown', () => { if (!showHelp && state.gameState !== 'paused') handleDown(); });
  canvas.addEventListener('mouseup', () => handleUp());
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); if (!showHelp && state.gameState !== 'paused') handleDown(); }, { passive: false });
  canvas.addEventListener('touchend', (e) => { e.preventDefault(); handleUp(); }, { passive: false });

  container.appendChild(canvas);

  // Buttons
  const btnBar = document.createElement('div');
  btnBar.style.cssText = 'position:absolute;bottom:var(--rr-btn-bottom,6px);right:var(--rr-btn-right,6px);display:flex;gap:var(--rr-btn-gap,6px);pointer-events:auto;';

  const iconSize = 'var(--rr-btn-icon-size,18)';
  const svgAttrs = `width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" aria-hidden="true"`;

  const mkBtn = (svg: string, partName: string, label: string) => {
    const b = document.createElement('button');
    b.innerHTML = svg;
    b.setAttribute('part', partName);
    b.setAttribute('aria-label', label);
    b.setAttribute('title', label);
    b.style.cssText = `padding:var(--rr-btn-padding,6px);border-radius:var(--rr-btn-radius,6px);cursor:pointer;transition:opacity 0.15s;display:inline-flex;align-items:center;justify-content:center;line-height:0;`;
    return b;
  };

  const iconHelp = `<svg ${svgAttrs}><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.5c0 1.5-2.4 2-2.4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="currentColor" stroke-width="1"/></svg>`;
  const iconPause = `<svg ${svgAttrs}><rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor"/></svg>`;
  const iconPlay = `<svg ${svgAttrs}><path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor"/></svg>`;
  const iconReset = `<svg ${svgAttrs}><path d="M4 12a8 8 0 0 1 14.5-4.5M20 12a8 8 0 0 1-14.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18.5 3v4.5H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 21v-4.5H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const btnHelp = mkBtn(iconHelp, 'btn-help', 'Help');
  btnHelp.addEventListener('click', (e) => { e.stopPropagation(); toggleHelpUI(true); });

  const btnPause = mkBtn(iconPause, 'btn-pause', 'Pause');
  btnPause.style.display = 'none';
  btnPause.addEventListener('click', (e) => { e.stopPropagation(); togglePause(); });

  const btnReset = mkBtn(iconReset, 'btn-reset', 'Reset');
  btnReset.style.display = 'none';
  btnReset.addEventListener('click', (e) => { e.stopPropagation(); handleReset(); });

  btnBar.appendChild(btnHelp);
  btnBar.appendChild(btnPause);
  btnBar.appendChild(btnReset);
  const uiTarget = uiOverlay || container;
  uiTarget.appendChild(btnBar);

  // Help overlay
  const helpOverlay = document.createElement('div');
  helpOverlay.style.cssText = `position:absolute;inset:0;display:none;align-items:center;justify-content:center;border-radius:2px;z-index:10;font-family:"Noto Sans",ui-sans-serif,system-ui,sans-serif;`;
  helpOverlay.addEventListener('click', () => toggleHelpUI(false));

  const helpContent = document.createElement('div');
  helpContent.style.cssText = 'max-width:420px;padding:20px 24px;text-align:center;';
  helpContent.addEventListener('click', (e) => e.stopPropagation());
  helpContent.innerHTML = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:600" class="hh2">How to Play</h2>
    <div style="text-align:left;font-size:13px;line-height:1.5;margin-bottom:16px" class="hbody">
      <p style="margin:0 0 10px">You're a bird rolling over hills. Fly as far as you can before <span class="accent" style="color:#fd5200">nightfall catches you</span>.</p>
      <p style="margin:0 0 10px"><span class="bright">Hold</span> (click, tap, or Space) to dive heavy into slopes. <span class="bright">Release</span> to float light and soar off hilltops.</p>
      <p style="margin:0 0 10px">The trick: hold while going <span class="bright">downhill</span> to build speed, then let go at the bottom to launch into the air. Good timing = big air.</p>
      <p style="margin:0 0 10px">Land 5 perfect dives in a row to trigger <span class="accent" style="color:#fd5200">Fever Mode</span> &mdash; a huge speed boost that rockets you into the sky.</p>
      <p style="margin:0;opacity:0.7">Press <span class="bright">Esc</span> to pause anytime.</p>
    </div>
  `;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Got it';
  closeBtn.style.cssText = 'padding:6px 16px;border-radius:4px;font-size:13px;cursor:pointer;background:#fd5200;color:#fff;border:none;font-family:"Noto Sans",ui-sans-serif,system-ui,sans-serif;';
  closeBtn.addEventListener('click', () => toggleHelpUI(false));
  helpContent.appendChild(closeBtn);
  helpOverlay.appendChild(helpContent);
  uiTarget.appendChild(helpOverlay);

  // ── THEME ──
  function getBaseColors() {
    return isDark
      ? { bg: '#292929', text: 'rgba(255,255,255,0.5)', textBright: 'rgba(255,255,255,0.87)', gridLine: 'rgba(255,255,255,0.025)', trailColor: 'rgba(253,82,0,0.4)', perfectColor: '#fd5200' }
      : { bg: '#ebf1e5', text: 'rgba(0,0,0,0.4)', textBright: 'rgba(0,0,0,0.8)', gridLine: 'rgba(0,0,0,0.03)', trailColor: 'rgba(253,82,0,0.3)', perfectColor: '#fd5200' };
  }

  function getPalettes() { return isDark ? DARK_PALETTES : LIGHT_PALETTES; }

  function applyTheme() {
    const btnBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
    const btnColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)';
    const btnBorder = `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`;
    for (const b of [btnHelp, btnPause, btnReset]) {
      b.style.background = btnBg; b.style.color = btnColor; b.style.border = btnBorder;
    }
    helpOverlay.style.background = isDark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)';
    const h2 = helpOverlay.querySelector('.hh2') as HTMLElement;
    if (h2) h2.style.color = isDark ? 'rgba(255,255,255,0.87)' : 'rgba(0,0,0,0.8)';
    const body = helpOverlay.querySelector('.hbody') as HTMLElement;
    if (body) body.style.color = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';
    for (const el of helpOverlay.querySelectorAll<HTMLElement>('.bright')) {
      el.style.color = isDark ? 'rgba(255,255,255,0.87)' : 'rgba(0,0,0,0.8)';
    }
  }
  applyTheme();

  // ── INPUT ──
  function handleDown() {
    if (state.gameState === 'idle' || state.gameState === 'dead') resetGame();
    holding = true;
  }

  function handleUp() { holding = false; }

  function togglePause() {
    if (state.gameState === 'playing') { state.gameState = 'paused'; holding = false; }
    else if (state.gameState === 'paused') { state.gameState = 'playing'; }
    updateButtons();
  }

  function handleReset() {
    state.gameState = 'idle';
    holding = false;
    updateButtons();
  }

  function toggleHelpUI(show: boolean) {
    showHelp = show;
    helpOverlay.style.display = show ? 'flex' : 'none';
    if (show && state.gameState === 'playing') togglePause();
  }

  function updateButtons() {
    const isActive = state.gameState === 'playing' || state.gameState === 'paused';
    btnPause.style.display = isActive ? '' : 'none';
    btnPause.innerHTML = state.gameState === 'paused' ? iconPlay : iconPause;
    btnPause.setAttribute('aria-label', state.gameState === 'paused' ? 'Resume' : 'Pause');
    btnPause.setAttribute('title', state.gameState === 'paused' ? 'Resume' : 'Pause');
    btnReset.style.display = (isActive || state.gameState === 'dead') ? '' : 'none';
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (showHelp) { toggleHelpUI(false); return; }
      togglePause();
      return;
    }
    if (showHelp) return;
    if (e.code === 'Space' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (state.gameState === 'paused') return;
      handleDown();
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space' || e.code === 'ArrowDown') handleUp();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ── PHYSICS ──
  function createPhysicsWorld(seed: number) {
    const w = planck.World({ gravity: planck.Vec2(0, -PLANCK_GRAVITY) });
    const chainVerts = generateChainVertices(seed);
    const ground = w.createBody();
    ground.createFixture(planck.Chain(chainVerts, false), { friction: TERRAIN_FRICTION, restitution: 0.0 });

    const startScreenY = getTerrainY(0, seed) - PLAYER_R;
    const b = w.createDynamicBody({ position: planck.Vec2(0, -startScreenY / PTM), bullet: true });
    b.createFixture(planck.Circle(BIRD_RADIUS_M), { density: 1.0, friction: BIRD_FRICTION, restitution: BIRD_RESTITUTION });
    b.setLinearVelocity(planck.Vec2(START_VX_MS, START_VY_MS));

    world = w;
    bird = b;
  }

  function resetGame() {
    const s = state;
    s.seed = Math.floor(Math.random() * 99999) + 1;
    cachedValleys = null;
    createPhysicsWorld(s.seed);

    const startScreenY = getTerrainY(0, s.seed) - PLAYER_R;
    s.px = 0; s.py = startScreenY;
    s.vx = START_VX_MS * PTM / 60; s.vy = -START_VY_MS * PTM / 60;
    s.nightX = -NIGHT_START_GAP; s.nightChasing = false; s.sunHeight = 1;
    s.frame = 0; s.score = 0; s.gameState = 'playing';
    s.island = 0; s.trail = []; s.particles = [];
    s.combo = 0; s.comboTimer = 0; s.perfectLandings = 0;
    s.fever = false; s.feverPending = false; s.feverTimer = 0; s.feverFlash = 0;
    s.diveVisual = 0; s.angle = 0; s.zoom = 1.0; s.wasOnGround = true;
    holding = false;
    updateButtons();
  }

  // ── PALETTE ──
  function getPalette(worldX: number) {
    const p = getPalettes();
    const progress = worldX / ISLAND_LENGTH;
    const idx = Math.floor(progress) % p.length;
    const nextIdx = (idx + 1) % p.length;
    const t = progress - Math.floor(progress);
    const blendT = t < 0.8 ? 0 : (t - 0.8) / 0.2;
    const smoothT = blendT * blendT * (3 - 2 * blendT);
    const curr = p[idx];
    const next = p[nextIdx];
    return {
      layers: curr.layers.map((c, i) => lerpColor(c, next.layers[i], smoothT)),
      line: lerpColor(curr.line, next.line, smoothT),
    };
  }

  // ── PARTICLES ──
  function spawnParticles(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      state.particles.push({ x, y, vx: (Math.random() - 0.5) * 12 - 4, vy: (Math.random() - 0.8) * 12, life: 0, maxLife: 15 + Math.random() * 20 });
    }
  }

  // ════════════════════════════════════════════════════════
  // DRAWING
  // ════════════════════════════════════════════════════════
  function drawGrid() {
    const bc = getBaseColors();
    ctx.strokeStyle = bc.gridLine;
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 160) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 160) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  }

  function drawCelestial() {
    const s = state;
    const h = s.sunHeight;
    const cx = W * 0.55;
    const cy = 56 + (1 - h) * (H * 0.45);
    const r = 36;
    ctx.save();

    const sunR = Math.round(253 + (200 - 253) * (1 - h));
    const sunG = Math.round(200 - (200 - 60) * (1 - h));
    const sunB = Math.round(80 - 80 * (1 - h));
    const sunA = 0.4 + h * 0.5;

    if (h < 0.5) {
      const warmth = (0.5 - h) / 0.5;
      const grad = ctx.createLinearGradient(0, H * 0.3, 0, H);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, `rgba(253,${Math.round(100 + 80 * h)},50,${warmth * (isDark ? 0.06 : 0.08)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.shadowColor = `rgba(${sunR},${sunG},${sunB},${0.4 + h * 0.3})`;
    ctx.shadowBlur = 48 + h * 40;
    ctx.fillStyle = `rgba(${sunR},${sunG},${sunB},${sunA})`;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = `rgba(255,${Math.round(240 * h + 180 * (1 - h))},${Math.round(200 * h + 100 * (1 - h))},${sunA * 0.6})`;
    ctx.beginPath(); ctx.arc(cx - 6, cy - 6, r * 0.45, 0, Math.PI * 2); ctx.fill();

    if (h > 0.2) {
      const rayA = sunA * 0.2 * ((h - 0.2) / 0.8);
      ctx.strokeStyle = `rgba(${sunR},${sunG},${sunB},${rayA})`;
      ctx.lineWidth = 3;
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2 + s.frame * 0.005;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * (r + 12), cy + Math.sin(angle) * (r + 12));
        ctx.lineTo(cx + Math.cos(angle) * (r + 24 + Math.sin(s.frame * 0.03 + i) * 8), cy + Math.sin(angle) * (r + 24 + Math.sin(s.frame * 0.03 + i) * 8));
        ctx.stroke();
      }
    }

    if (h < 0.4) {
      const sa = ((0.4 - h) / 0.4) * (isDark ? 0.4 : 0.25);
      const stars = [[120, 60], [320, 100], [600, 48], [800, 120], [1040, 72], [180, 160], [480, 140], [720, 180], [960, 88], [1200, 140]];
      for (const [sx, sy] of stars) {
        const tw = Math.sin(s.frame * 0.05 + sx) * 0.3 + 0.7;
        ctx.globalAlpha = sa * tw;
        ctx.fillStyle = `rgba(255,255,255,${sa})`;
        ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function drawParallaxBG(camOffY: number) {
    const s = state;
    const zoomExtend = Math.max(1, 1 / s.zoom);
    const drawLeft = Math.floor(-PLAYER_SCREEN_X * zoomExtend - 50);
    const drawRight = Math.ceil((W + PLAYER_SCREEN_X) * zoomExtend + 50);
    const drawStep = Math.max(12, Math.floor(12 * zoomExtend));
    const layers = [
      { speed: 0.08, baseY: H * 0.58, amp: 72, freq: 0.001, alpha: isDark ? 0.02 : 0.04, off: 0 },
      { speed: 0.15, baseY: H * 0.63, amp: 88, freq: 0.00175, alpha: isDark ? 0.03 : 0.06, off: 500 },
    ];
    for (const l of layers) {
      const scrollX = s.px * l.speed;
      ctx.beginPath();
      ctx.moveTo(drawLeft, H * 2);
      for (let sx = drawLeft; sx <= drawRight; sx += drawStep) {
        const wx = scrollX + sx + l.off;
        const hillY = l.baseY + Math.sin(wx * l.freq) * l.amp + Math.sin(wx * l.freq * 2.3 + 1.7) * (l.amp * 0.4) + camOffY * l.speed;
        ctx.lineTo(sx, hillY);
      }
      ctx.lineTo(drawRight, H * 2);
      ctx.closePath();
      ctx.fillStyle = isDark ? `rgba(255,255,255,${l.alpha})` : `rgba(60,100,40,${l.alpha})`;
      ctx.fill();
    }
  }

  function drawTerrain(camOffY: number) {
    const s = state;
    const camWorldX = s.px - PLAYER_SCREEN_X;
    const palette = getPalette(s.px);
    const layerOffsets = [0, 50, 110];
    const zoomExtend = Math.max(1, 1 / s.zoom);
    const drawLeft = Math.floor(-150 * zoomExtend);
    const drawRight = Math.ceil((W + 450) * zoomExtend);
    const drawStep = Math.max(8, Math.floor(8 * zoomExtend));

    for (let layer = layerOffsets.length - 1; layer >= 0; layer--) {
      const off = layerOffsets[layer];
      ctx.beginPath();
      ctx.moveTo(drawLeft, H * 2);
      for (let sx = drawLeft; sx <= drawRight; sx += drawStep) {
        const wy = getTerrainY(camWorldX + sx, s.seed);
        ctx.lineTo(sx, wy + off + camOffY);
      }
      ctx.lineTo(drawRight, H * 2);
      ctx.closePath();
      ctx.fillStyle = palette.layers[layer];
      ctx.fill();
    }

    ctx.beginPath();
    for (let sx = drawLeft; sx <= drawRight; sx += drawStep) {
      const wy = getTerrainY(camWorldX + sx, s.seed);
      const sy = wy + camOffY;
      if (sx === drawLeft) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = s.fever ? `rgba(253,82,0,${0.5 + Math.sin(s.frame * 0.2) * 0.2})` : palette.line;
    ctx.lineWidth = s.fever ? 4 : 3;
    ctx.stroke();
  }

  function drawNightChaser() {
    const s = state;
    const nightScreenX = PLAYER_SCREEN_X - (s.px - s.nightX);
    if (nightScreenX > -W) {
      const edgeX = Math.min(W, Math.max(0, nightScreenX));
      if (edgeX > 0) {
        ctx.fillStyle = isDark ? 'rgba(0,0,10,0.7)' : 'rgba(20,10,40,0.5)';
        ctx.fillRect(0, 0, edgeX, H);
      }
      const fringeWidth = 240;
      const grad = ctx.createLinearGradient(edgeX, 0, edgeX + fringeWidth, 0);
      grad.addColorStop(0, isDark ? 'rgba(0,0,10,0.5)' : 'rgba(20,10,40,0.35)');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(edgeX, 0, fringeWidth, H);
    }
  }

  function drawNightOverlay() {
    if (state.sunHeight > 0.7) return;
    const dim = (0.7 - state.sunHeight) / 0.7;
    ctx.fillStyle = `rgba(0,0,0,${dim * (isDark ? 0.3 : 0.18)})`;
    ctx.fillRect(0, 0, W, H);
  }

  function drawTrail(camOffY: number) {
    const bc = getBaseColors();
    for (const t of state.trail) {
      const alpha = Math.max(0, 1 - t.age / 35);
      ctx.globalAlpha = alpha * (t.bright ? 0.8 : 0.5);
      ctx.fillStyle = t.bright ? '#fd5200' : bc.trailColor;
      ctx.beginPath();
      ctx.arc(t.x, t.y + camOffY, Math.max(2, PLAYER_R * (1 - t.age / 35) * (t.bright ? 0.7 : 0.5)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles(camOffY: number) {
    for (const p of state.particles) {
      const alpha = Math.max(0, 1 - p.life / p.maxLife);
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = '#fd5200';
      ctx.beginPath();
      ctx.arc(p.x, p.y + camOffY, 6 * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer(screenX: number, screenY: number) {
    const s = state;
    ctx.save();
    ctx.translate(screenX, screenY);

    const dive = s.diveVisual;
    const speedPct = Math.min(1, (s.vx - MIN_VX) / (MAX_VX - MIN_VX));
    ctx.rotate(s.angle);

    const scale = 1 - dive * 0.25;
    const drawR = PLAYER_R * scale;

    const r = Math.round(253 + (255 - 253) * dive);
    const g = Math.round(82 + (170 - 82) * dive);
    const bodyColor = `rgb(${r},${g},0)`;
    const glowColor = `rgba(${r},${g},0,0.6)`;

    const terrainHere = getTerrainY(s.px, s.seed);
    const distToGround = terrainHere - PLAYER_R - screenY;
    if (distToGround > 8 && distToGround < 300) {
      const sc = 1 - distToGround / 300;
      ctx.fillStyle = isDark ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.06)';
      ctx.beginPath();
      ctx.ellipse(0, distToGround + PLAYER_R, PLAYER_R * sc * 1.2, 8 * sc, -s.angle, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.fever) {
      const pulse = 0.7 + Math.sin(s.frame * 0.15) * 0.3;
      ctx.shadowColor = '#fd5200';
      ctx.shadowBlur = 80 * pulse;
      ctx.strokeStyle = `rgba(253,82,0,${0.4 * pulse})`;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, PLAYER_R + 20, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.shadowColor = glowColor;
    ctx.shadowBlur = s.fever ? 72 : 32 + speedPct * 56;
    ctx.fillStyle = bodyColor;
    ctx.beginPath(); ctx.arc(0, 0, drawR, 0, Math.PI * 2); ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(255,255,255,${0.3 + speedPct * 0.15})`;
    ctx.beginPath(); ctx.arc(-6 * scale, -8 * scale, drawR * 0.35, 0, Math.PI * 2); ctx.fill();

    if (dive < 0.6) {
      const arcAlpha = (0.25 + speedPct * 0.35) * (1 - dive * 1.6);
      ctx.strokeStyle = `rgba(255,123,57,${arcAlpha})`;
      ctx.lineWidth = 3;
      const arcCount = s.fever ? 4 : s.vx > 14 ? 3 : 2;
      for (let i = 1; i <= arcCount; i++) {
        ctx.beginPath(); ctx.arc(-8, 0, PLAYER_R + i * 20, -0.5, 0.5); ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ════════════════════════════════════════════════════════
  // GAME LOOP
  // ════════════════════════════════════════════════════════
  function tick() {
    const s = state;
    const bc = getBaseColors();

    ctx.fillStyle = bc.bg;
    ctx.fillRect(0, 0, W, H);
    drawGrid();

    const diveTarget = holding ? 1 : 0;
    s.diveVisual += (diveTarget - s.diveVisual) * 0.18;

    // ── IDLE ──
    if (s.gameState === 'idle') {
      const idleSeed = 42;
      const terrY = getTerrainY(0, idleSeed);
      const tempSeed = s.seed;
      s.seed = idleSeed;
      s.px = PLAYER_SCREEN_X;
      drawTerrain(0);
      s.seed = tempSeed;
      s.px = 0;

      const idleY = terrY - PLAYER_R + Math.sin(Date.now() / 400) * 16;
      drawPlayer(PLAYER_SCREEN_X, idleY);

      ctx.fillStyle = bc.textBright;
      ctx.font = '500 36px "Noto Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Hold to dive \u00b7 Release to fly', W / 2, 112);
      ctx.fillStyle = bc.text;
      ctx.font = '400 28px "Noto Sans", sans-serif';
      ctx.fillText('Tap or hold Space to start', W / 2, 170);
      if (s.best > 0) {
        ctx.fillStyle = bc.perfectColor;
        ctx.font = '500 28px "Noto Sans", sans-serif';
        ctx.fillText(`Best: ${s.best}`, W / 2, 230);
      }
      updateButtons();
      return;
    }

    // ── PLAYING ──
    if (s.gameState === 'playing') {
      s.frame++;
      s.island = Math.floor(s.px / ISLAND_LENGTH);

      if (s.fever) {
        s.feverTimer--;
        if (s.feverTimer <= 0) {
          s.fever = false;
          if (bird) bird.setGravityScale(1.0);
        } else if (world && bird) {
          bird.setGravityScale(FEVER_GRAVITY_SCALE);
          const vel = bird.getLinearVelocity();
          if (vel.x < FEVER_BOOST_VX) bird.setLinearVelocity(planck.Vec2(FEVER_BOOST_VX, vel.y));
          world.step(1 / 60, 6, 2);
          const pos = bird.getPosition();
          const newVel = bird.getLinearVelocity();
          s.px = pos.x * PTM; s.py = -pos.y * PTM;
          s.vx = newVel.x * PTM / 60; s.vy = -newVel.y * PTM / 60;
          if (s.frame % 2 === 0) s.trail.push({ x: PLAYER_SCREEN_X, y: s.py, age: 0, bright: true });
          if (s.frame % 3 === 0) spawnParticles(PLAYER_SCREEN_X, s.py, 2);
        }
      } else if (world && bird) {
        bird.setGravityScale(holding ? HEAVY_MULT : 1.0);
        world.step(1 / 60, 6, 2);
        const pos = bird.getPosition();
        const newVel = bird.getLinearVelocity();
        s.px = pos.x * PTM; s.py = -pos.y * PTM;
        s.vx = newVel.x * PTM / 60; s.vy = -newVel.y * PTM / 60;

        if (s.feverPending && newVel.y > 0.5) {
          s.feverPending = false; s.fever = true; s.feverTimer = FEVER_DURATION;
          spawnParticles(PLAYER_SCREEN_X, s.py, 15);
          bird.setLinearVelocity(planck.Vec2(Math.max(newVel.x, FEVER_BOOST_VX), FEVER_LAUNCH_VY));
        }

        const vel = bird.getLinearVelocity();
        if (vel.x < MIN_VX_MS) bird.setLinearVelocity(planck.Vec2(MIN_VX_MS, vel.y));

        if (vel.y > 0) {
          const origPosY = pos.y + H / PTM;
          if (origPosY > 0) {
            const downForce = origPosY * origPosY * HEIGHT_DRAG_K;
            bird.applyForceToCenter(planck.Vec2(0, -downForce), true);
          }
        }

        const terrainY = getTerrainY(s.px, s.seed);
        const surfaceY = terrainY - PLAYER_R;
        const onGround = s.py >= surfaceY - 8;
        const wasAbove = s.wasOnGround === false;

        if (onGround && wasAbove) {
          const dy = getTerrainY(s.px + 2, s.seed) - getTerrainY(s.px - 2, s.seed);
          if (dy > 0.2 && holding && s.vx > 6) {
            s.combo++; s.comboTimer = 90; s.perfectLandings++;
            spawnParticles(PLAYER_SCREEN_X, s.py, 6);
            if (s.combo >= FEVER_COMBO && !s.fever && !s.feverPending) {
              s.feverPending = true; s.feverFlash = 30;
              spawnParticles(PLAYER_SCREEN_X, s.py, 15);
            }
          } else {
            s.combo = 0;
          }
        }
        s.wasOnGround = onGround;
      }

      if (s.vx * 60 / PTM < 1.0) {
        s.angle += (0 - s.angle) * 0.15;
      } else {
        let targetAngle = Math.atan2(s.vy, s.vx);
        if (targetAngle > 0.8) targetAngle = 0.8;
        if (targetAngle < -1.0) targetAngle = -1.0;
        s.angle += (targetAngle - s.angle) * 0.15;
      }

      const playerYUp = H - s.py;
      const yPos = Math.max(1, playerYUp + TOP_SCREEN_BUFFER);
      s.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, 640 / yPos));

      if (!s.nightChasing && s.frame >= NIGHT_GRACE_FRAMES) s.nightChasing = true;
      if (s.nightChasing && s.nightX < s.px) s.nightX += NIGHT_SPEED;
      const nightGap = s.px - s.nightX;
      if (nightGap <= NIGHT_GAMEOVER_DIST && s.nightChasing) {
        s.gameState = 'dead';
        if (s.score > s.best) s.best = s.score;
        if (bird) {
          const v = bird.getLinearVelocity();
          bird.setLinearVelocity(planck.Vec2(0, v.y > 0 ? -5.0 : v.y));
        }
        updateButtons();
      }
      s.sunHeight = Math.max(0, Math.min(1, nightGap / NIGHT_START_GAP));

      if (s.frame % 2 === 0) s.trail.push({ x: PLAYER_SCREEN_X, y: s.py, age: 0, bright: s.fever });
      for (let i = s.trail.length - 1; i >= 0; i--) {
        s.trail[i].age++; s.trail[i].x -= s.vx * 0.7;
        if (s.trail[i].age > 35 || s.trail[i].x < -40) s.trail.splice(i, 1);
      }

      for (let i = s.particles.length - 1; i >= 0; i--) {
        const p = s.particles[i];
        p.x += p.vx - s.vx * 0.5; p.y += p.vy; p.vy += 0.2; p.life++;
        if (p.life >= p.maxLife || p.x < -40) s.particles.splice(i, 1);
      }

      if (s.comboTimer > 0) s.comboTimer--;
      if (s.feverFlash > 0) s.feverFlash--;
      s.score = Math.floor(s.px / 10) * 10;
    }

    if (s.gameState === 'dead' && world && bird) {
      const vel = bird.getLinearVelocity();
      bird.setLinearVelocity(planck.Vec2(0, vel.y > 0 ? -5.0 : vel.y));
      bird.setGravityScale(1.0);
      world.step(1 / 60, 6, 2);
      s.py = -bird.getPosition().y * PTM;
    }

    // ── CAMERA ──
    const playerYUpCam = H - s.py;
    const yPosCam = Math.max(1, playerYUpCam + TOP_SCREEN_BUFFER);
    const camYOrig = Math.max(yPosCam / 2, 246);
    const birdScreenFromTop = (camYOrig + 400 / s.zoom - playerYUpCam) * s.zoom;
    const playerDrawY = Math.max(birdScreenFromTop, 30);
    const camOffY = playerDrawY - s.py;

    // ── DRAW ──
    drawCelestial();

    ctx.save();
    ctx.translate(PLAYER_SCREEN_X, playerDrawY);
    ctx.scale(s.zoom, s.zoom);
    ctx.translate(-PLAYER_SCREEN_X, -playerDrawY);

    drawParallaxBG(camOffY);
    drawTerrain(camOffY);
    drawTrail(camOffY);
    drawParticles(camOffY);

    if (s.gameState === 'playing' || s.gameState === 'paused') {
      drawPlayer(PLAYER_SCREEN_X, playerDrawY);
      if (s.comboTimer > 0 && s.combo >= 1 && s.gameState === 'playing') {
        ctx.globalAlpha = Math.min(1, s.comboTimer / 30);
        ctx.fillStyle = bc.perfectColor;
        ctx.font = '600 40px "Noto Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(
          s.feverPending ? 'FEVER READY!' : s.combo >= FEVER_COMBO ? `FEVER x${s.combo}!` : s.combo > 1 ? `x${s.combo} Perfect!` : 'Perfect!',
          PLAYER_SCREEN_X, playerDrawY - 80,
        );
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();

    if (s.gameState === 'playing') {
      drawNightChaser();
      drawNightOverlay();
      if (s.feverFlash > 0) {
        ctx.globalAlpha = (s.feverFlash / 30) * 0.3;
        ctx.fillStyle = '#fd5200'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      }
      if (s.fever) {
        ctx.globalAlpha = (0.5 + Math.sin(s.frame * 0.1) * 0.3) * 0.1;
        ctx.fillStyle = '#fd5200'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      }
    }

    // HUD
    if (s.gameState === 'playing') {
      const speedPct = Math.min(1, (s.vx - MIN_VX) / (MAX_VX - MIN_VX));
      ctx.fillStyle = bc.text; ctx.font = '400 24px "Noto Sans", sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('SPD', 40, 56);
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
      ctx.fillRect(110, 42, 200, 14);
      ctx.fillStyle = s.fever ? `rgba(253,82,0,${0.7 + Math.sin(s.frame * 0.2) * 0.3})` : `rgba(253,82,0,${0.4 + speedPct * 0.5})`;
      ctx.fillRect(110, 42, 200 * speedPct, 14);

      if (s.combo > 0) {
        ctx.fillStyle = bc.perfectColor; ctx.font = '500 24px "Noto Sans", sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`x${s.combo}`, 40, 90);
      }

      ctx.fillStyle = bc.text; ctx.font = '400 22px "Noto Sans", sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`ZONE ${s.island + 1}`, 40, H - 30);

      const terrY = getTerrainY(s.px, s.seed);
      const altAboveTerrain = Math.round(terrY - PLAYER_R - s.py);
      const birdVelMs = (s.vx * 60 / PTM).toFixed(1);
      const birdVelYMs = (-s.vy * 60 / PTM).toFixed(1);
      ctx.fillStyle = bc.text; ctx.font = '400 20px monospace'; ctx.textAlign = 'left';
      ctx.fillText(`ALT: ${altAboveTerrain}px  VX: ${birdVelMs}m/s  VY: ${birdVelYMs}m/s  Z: ${s.zoom.toFixed(2)}`, 40, H - 60);
    }

    if (s.gameState === 'playing' || s.gameState === 'dead' || s.gameState === 'paused') {
      ctx.fillStyle = bc.text; ctx.font = '400 28px "Noto Sans", sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(`HI ${String(s.best).padStart(4, '0')}`, W - 48, 56);
      ctx.fillStyle = bc.textBright; ctx.font = '600 48px "Noto Sans", sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(String(s.score).padStart(4, '0'), W - 48, 110);
    }

    if (s.gameState === 'dead') {
      ctx.fillStyle = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
      ctx.fillRect(0, 0, W, H);
      drawPlayer(PLAYER_SCREEN_X, playerDrawY);
      ctx.fillStyle = bc.textBright; ctx.font = '600 48px "Noto Sans", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Night fell', W / 2, H / 2 - 100);
      ctx.fillStyle = '#fd5200'; ctx.font = '500 40px "Noto Sans", sans-serif';
      ctx.fillText(`Distance: ${s.score}`, W / 2, H / 2 - 30);
      if (s.perfectLandings > 0) {
        ctx.fillStyle = bc.text; ctx.font = '400 28px "Noto Sans", sans-serif';
        ctx.fillText(`${s.perfectLandings} perfect slide${s.perfectLandings !== 1 ? 's' : ''} \u00b7 Zone ${s.island + 1}`, W / 2, H / 2 + 30);
      }
      ctx.fillStyle = bc.textBright; ctx.font = '400 32px "Noto Sans", sans-serif';
      ctx.fillText('Tap to retry', W / 2, H / 2 + 110);
    }

    if (s.gameState === 'paused') {
      ctx.fillStyle = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = bc.textBright; ctx.font = '600 52px "Noto Sans", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Paused', W / 2, H / 2 - 20);
      ctx.fillStyle = bc.text; ctx.font = '400 28px "Noto Sans", sans-serif';
      ctx.fillText('Press Esc to resume', W / 2, H / 2 + 30);
      ctx.fillStyle = bc.textBright; ctx.font = '600 48px "Noto Sans", sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(String(s.score).padStart(4, '0'), W - 48, 110);
    }
  }

  // ── START ──
  function loop() {
    tick();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  // ── PUBLIC API ──
  return {
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
    setDark(dark: boolean) {
      isDark = dark;
      applyTheme();
    },
  };
}
