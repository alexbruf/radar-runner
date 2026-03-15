import React, { useRef, useEffect, useCallback, useState } from 'react';
import planck from 'planck';

// ════════════════════════════════════════════════════════
// NATIVE RESOLUTION — matches original Defold game exactly
// Canvas renders at 1280×800, displayed at 640×400 via CSS
// ════════════════════════════════════════════════════════
const W = 1280;
const H = 800;
const DISPLAY_W = 640;
const DISPLAY_H = 400;
const PLAYER_R = 21;             // original visual radius (21px)
const BIRD_RADIUS_M = 0.21;     // physics radius = 21 / PTM(100) = 0.21m

// Planck / Box2D physics — ALL values from Defold editor properties
const PTM = 100;                   // pixels-to-meters — original ptm_ratio
// Gravity is -3.5 (Defold editor property on HillsController), NOT the -10 from game.project.
// The script overrides: world:SetGravity(vmath.vector3(0, self.Gravity, 0))
// Heavy = 7.0 × 3.5 = 24.5 m/s² — aggressive dive vs floaty 3.5 m/s² flight
const PLANCK_GRAVITY = 3.5;
const HEAVY_MULT = 7.0;            // gravityScale when holding (editor: HeavyGravityMultiplier = 7.0)
const START_VX_MS = 2.0;           // m/s forward — original startGameJump
const START_VY_MS = 4.0;           // m/s upward — original startGameJump
const MIN_VX_MS = 1.0;             // m/s minimum forward speed (editor: MinVelocity = 1.0)
const MAX_VX_MS = 15.0;            // m/s reference for HUD speedometer (display only)
const HEIGHT_DRAG_K = 0.007;       // original: applyForce(0, -posY² × 0.007) when ascending
// NOTE: Original Lua never explicitly sets friction on either fixture.
// Defold's Box2D shorthand CreateFixture(shape, density) likely defaults to 0,
// not the C++ b2FixtureDef default of 0.2. With friction=0.2 the bird loses
// significant energy to rolling/sliding friction, preventing the 15+ m/s speeds
// needed for dramatic soaring. Setting to 0 matches the frictionless sliding
// behavior of the original game.
const BIRD_FRICTION = 0.0;
const BIRD_RESTITUTION = 0.0;
const TERRAIN_FRICTION = 0.0;

// Display-space constants (px/frame for HUD)
const MIN_VX = MIN_VX_MS * PTM / 60;
const MAX_VX = MAX_VX_MS * PTM / 60;

// Fever — launches bird into the sky with physics, not scripted movement
const FEVER_COMBO = 5;
const FEVER_DURATION = 180;
const FEVER_LAUNCH_VY = 5.0;      // m/s upward — noticeable but not orbital (reduced from 10)
const FEVER_BOOST_VX = 8.0;       // m/s minimum forward speed during fever
const FEVER_GRAVITY_SCALE = 0.5;  // half gravity during fever — floaty but comes back down

// Night chaser — actual Defold editor values:
// startNigthSpeed = 2000.0 px/s, start position = (-90000, 0) px
// Original game over triggers when night is within 2500px of player (not at 0 gap).
// Reduced speed from 2000 to 1400: our bird dynamics differ slightly from original
// (terrain chain offset, height drag mapping, etc.), making speed-building slower.
// At 1400 px/s, escape velocity = 14 m/s instead of 20 — more achievable.
const NIGHT_SPEED = 1400 / 60;    // 1400 px/s → 23.33 px/frame (tuned from original 2000)
const NIGHT_START_GAP = 90000;     // night starts 90000px behind player (editor: x = -90000)
const NIGHT_GAMEOVER_DIST = 2500;  // original: game over when night within 2500px of player
const NIGHT_GRACE_FRAMES = 60;

// Terrain generation — original values (Y-up coordinate system)
const VALLEY_COUNT = 303;          // 2 intro + 301 procedural
const VALLEY_RESOLUTION = 20;      // segments per valley (original: valleyResolution = 20)
const TERRAIN_START_X = -300;       // original: x = -300
const TERRAIN_BASE_Y_UP = 200;     // original: y = 200 (Y-up)
const ISLAND_LENGTH = 9000;

// Camera — actual Defold editor values
const ZOOM_MAX = 1.3;
// NOTE: Original Lua has NO lower zoom clamp — only `if zoom > 1.3 then zoom = 1.3 end`.
// This lets the camera zoom way out at altitude (0.5, 0.3, etc.) for dramatic flight visuals.
const ZOOM_MIN = 0.15;            // effectively no floor (original has none)
const TOP_SCREEN_BUFFER = 50;      // editor: topScreenBuffer = 50.0

// Player screen X — derived from original camera:
// offsetX = 300 / (h/w) = 300/0.625 = 480
// Bird screenX = viewWidth/2 - offsetX = 640 - 480 = 160
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
// TERRAIN — Original Defold values, Y-UP coordinate system
// Stored in Y-up; getTerrainY converts to screen Y-down
// ════════════════════════════════════════════════════════
interface Valley {
  startX: number;
  width: number;
  depth: number;     // Y-up: positive = valley dips DOWN (lower y_up)
  baseY: number;     // Y-up baseline
  endHeight: number;  // Y-up: positive = next valley starts HIGHER
}

let cachedValleys: Valley[] | null = null;
let cachedSeed = 0;

function generateValleys(seed: number): Valley[] {
  const rng = mulberry32(seed);
  const valleys: Valley[] = [];
  let x = TERRAIN_START_X;
  let y = TERRAIN_BASE_Y_UP;  // Y-up

  for (let i = 0; i < VALLEY_COUNT; i++) {
    let width: number, depth: number, endheight: number;

    if (i < 2) {
      // Original intro valleys: generateValley(x, y, 600, -100, 0) then (x, y, 600, 150, 0)
      width = 600;
      depth = i === 0 ? -100 : 150;
      endheight = 0;
    } else {
      const j = i - 2;  // maps to original loop i=0..300

      if (j <= 30) {
        // Original: width 500-800, endheight ±10, depth=width/4
        width = 500 + Math.floor(rng() * 301);     // random(500,800)
        endheight = Math.floor(rng() * 21) - 10;   // random(-10,10)
        depth = width / 4.0;
      } else if (j < 80) {
        // Original: width 500-800, endheight ±20, depth=width/random(3.5,4.5)
        // In Lua 5.1/LuaJIT, math.random(3.5, 4.5) truncates to math.random(3, 4)
        // returning INTEGER 3 or 4. This gives 50% chance of very deep (width/3) valleys.
        width = 500 + Math.floor(rng() * 301);
        endheight = Math.floor(rng() * 41) - 20;
        depth = width / (3 + Math.floor(rng() * 2));  // 3 or 4
      } else if (j < 160) {
        // Original: width 450-700, endheight ±25, depth=width/random(3,5)
        // math.random(3,5) → integer 3, 4, or 5
        width = 450 + Math.floor(rng() * 251);
        endheight = Math.floor(rng() * 51) - 25;
        depth = width / (3 + Math.floor(rng() * 3));  // 3, 4, or 5
      } else {
        // Original: width 400-700, endheight ±(24+i/10), depth=width/random(3,5)
        width = 400 + Math.floor(rng() * 301);
        const range = 24 + j / 10;
        endheight = Math.floor(rng() * (range * 2 + 1)) - Math.floor(range);
        depth = width / (3 + Math.floor(rng() * 3));  // 3, 4, or 5
      }
    }

    // ── Safety clamps (original Lua, Y-up) ──
    if (i >= 2) {
      // Original: if y < -depth + 50 then endheight = 0 end
      if (y < -depth + 50) {
        endheight = 0;
      }
      // Original: if y - depth < 30 then depth = y - 30; endheight = 50 end
      if (y - depth < 30) {
        depth = y - 30;
        endheight = 50;
      }
      // Original: if y > 300 then endheight = random(-50,-10) end
      if (y > 300) {
        endheight = -(10 + Math.floor(rng() * 41));  // random(-50,-10)
      }
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

/**
 * Get terrain surface Y in SCREEN coords (Y-down) at a given world X.
 * Internally computes Y-up value using original formula, then converts.
 */
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

  // Original formula (Y-up):
  // segmentWidth = width / valleyResolution
  // i = floor(t * valleyResolution)
  // cosVal = cos(i/valleyResolution * pi * 2) — but we use continuous t for smooth terrain
  const cosVal = Math.cos(t * Math.PI * 2.0);
  const segI = t * VALLEY_RESOLUTION;

  let yUp: number;
  if (segI < VALLEY_RESOLUTION / 2) {
    // First half: y = yPos + (cos * 0.5 - 0.5) * depth
    yUp = v.baseY + (cosVal * 0.5 - 0.5) * v.depth;
  } else {
    // Second half: y = yPos + endheight + (cos * 0.5 - 0.5) * (depth + endheight)
    yUp = (v.baseY + v.endHeight) + (cosVal * 0.5 - 0.5) * (v.depth + v.endHeight);
  }

  // Convert Y-up to screen Y-down
  return H - yUp;
}

/**
 * Generate chain vertices for planck physics.
 * Original reverses vertex order (fills groundPoints with index = index - 1).
 */
function generateChainVertices(seed: number): planck.Vec2Value[] {
  const valleys = getValleys(seed);
  const verts: planck.Vec2Value[] = [];

  for (const v of valleys) {
    const segWidth = v.width / VALLEY_RESOLUTION;
    for (let i = 0; i < VALLEY_RESOLUTION; i++) {
      const px = v.startX + i * segWidth;
      const screenY = getTerrainY(px, seed);
      // Convert screen Y-down to planck Y-up: planckY = -screenY / PTM
      verts.push(planck.Vec2(px / PTM, -screenY / PTM));
    }
  }
  // Final vertex
  const lastV = valleys[valleys.length - 1];
  const endX = lastV.startX + lastV.width;
  verts.push(planck.Vec2(endX / PTM, -getTerrainY(endX, seed) / PTM));

  // Reverse to match original (groundPoints filled with decreasing index)
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
// COMPONENT
// ════════════════════════════════════════════════════════
export function RadarRunner({ isDark }: { isDark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holdingRef = useRef(false);

  const worldRef = useRef<planck.World | null>(null);
  const birdRef = useRef<planck.Body | null>(null);

  const stateRef = useRef({
    px: 0,     // world X (pixels, original scale)
    py: 0,     // screen Y (Y-down, pixels)
    vx: 0,     // px/frame (screen space)
    vy: 0,     // px/frame (screen space, Y-down)
    nightX: 0,
    nightChasing: false,
    sunHeight: 1,
    seed: 42,
    frame: 0,
    score: 0,
    best: 0,
    gameState: 'idle' as GameState,
    island: 0,
    trail: [] as { x: number; y: number; age: number; bright?: boolean }[],
    particles: [] as { x: number; y: number; vx: number; vy: number; life: number; maxLife: number }[],
    combo: 0,
    comboTimer: 0,
    perfectLandings: 0,
    fever: false,
    feverPending: false,
    feverTimer: 0,
    feverFlash: 0,
    diveVisual: 0,
    angle: 0,
    zoom: 1.0,
    wasOnGround: true,
  });
  const rafRef = useRef<number>(0);
  const [, forceRender] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const baseColors = isDark
    ? {
        bg: '#292929',
        text: 'rgba(255,255,255,0.5)',
        textBright: 'rgba(255,255,255,0.87)',
        gridLine: 'rgba(255,255,255,0.025)',
        trailColor: 'rgba(253,82,0,0.4)',
        perfectColor: '#fd5200',
      }
    : {
        bg: '#ebf1e5',
        text: 'rgba(0,0,0,0.4)',
        textBright: 'rgba(0,0,0,0.8)',
        gridLine: 'rgba(0,0,0,0.03)',
        trailColor: 'rgba(253,82,0,0.3)',
        perfectColor: '#fd5200',
      };

  const palettes = isDark ? DARK_PALETTES : LIGHT_PALETTES;

  const getPalette = useCallback((worldX: number) => {
    const progress = worldX / ISLAND_LENGTH;
    const idx = Math.floor(progress) % palettes.length;
    const nextIdx = (idx + 1) % palettes.length;
    const t = progress - Math.floor(progress);
    const blendT = t < 0.8 ? 0 : (t - 0.8) / 0.2;
    const smoothT = blendT * blendT * (3 - 2 * blendT);
    const curr = palettes[idx];
    const next = palettes[nextIdx];
    return {
      layers: curr.layers.map((c, i) => lerpColor(c, next.layers[i], smoothT)),
      line: lerpColor(curr.line, next.line, smoothT),
    };
  }, [palettes]);

  // ════════════════════════════════════════════════════════
  // CREATE PLANCK WORLD
  // ════════════════════════════════════════════════════════
  const createPhysicsWorld = useCallback((seed: number) => {
    const world = planck.World({
      gravity: planck.Vec2(0, -PLANCK_GRAVITY),
    });

    const chainVerts = generateChainVertices(seed);
    const ground = world.createBody();
    ground.createFixture(planck.Chain(chainVerts, false), {
      friction: TERRAIN_FRICTION,
      restitution: 0.0,
    });

    // Bird start position: on terrain at x=0
    const startScreenY = getTerrainY(0, seed) - PLAYER_R;
    const bird = world.createDynamicBody({
      position: planck.Vec2(0, -startScreenY / PTM),
      bullet: true,
    });
    bird.createFixture(planck.Circle(BIRD_RADIUS_M), {
      density: 1.0,
      friction: BIRD_FRICTION,
      restitution: BIRD_RESTITUTION,
    });

    bird.setLinearVelocity(planck.Vec2(START_VX_MS, START_VY_MS));

    worldRef.current = world;
    birdRef.current = bird;
    return { world, bird };
  }, []);

  const resetGame = useCallback(() => {
    const s = stateRef.current;
    s.seed = Math.floor(Math.random() * 99999) + 1;
    cachedValleys = null;
    createPhysicsWorld(s.seed);

    const startScreenY = getTerrainY(0, s.seed) - PLAYER_R;
    s.px = 0;
    s.py = startScreenY;
    s.vx = START_VX_MS * PTM / 60;
    s.vy = -START_VY_MS * PTM / 60;
    s.nightX = -NIGHT_START_GAP;
    s.nightChasing = false;
    s.sunHeight = 1;
    s.frame = 0;
    s.score = 0;
    s.gameState = 'playing';
    s.island = 0;
    s.trail = [];
    s.particles = [];
    s.combo = 0;
    s.comboTimer = 0;
    s.perfectLandings = 0;
    s.fever = false;
    s.feverPending = false;
    s.feverTimer = 0;
    s.feverFlash = 0;
    s.diveVisual = 0;
    s.angle = 0;
    s.zoom = 1.0;
    s.wasOnGround = true;
    holdingRef.current = false;
    forceRender((n) => n + 1);
  }, [createPhysicsWorld]);

  const handleDown = useCallback(() => {
    const s = stateRef.current;
    if (s.gameState === 'idle' || s.gameState === 'dead') {
      resetGame();
    }
    holdingRef.current = true;
  }, [resetGame]);

  const handleUp = useCallback(() => {
    holdingRef.current = false;
  }, []);

  const togglePause = useCallback(() => {
    const s = stateRef.current;
    if (s.gameState === 'playing') {
      s.gameState = 'paused';
      holdingRef.current = false;
      forceRender((n) => n + 1);
    } else if (s.gameState === 'paused') {
      s.gameState = 'playing';
      forceRender((n) => n + 1);
    }
  }, []);

  const handleReset = useCallback(() => {
    const s = stateRef.current;
    s.gameState = 'idle';
    s.best = stateRef.current.best; // preserve best score
    holdingRef.current = false;
    forceRender((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        if (showHelp) {
          setShowHelp(false);
        } else {
          togglePause();
        }
        return;
      }
      if (showHelp) return;
      if (e.code === 'Space' || e.code === 'ArrowDown') {
        e.preventDefault();
        if (stateRef.current.gameState === 'paused') return;
        handleDown();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowDown') handleUp();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleDown, handleUp, togglePause, showHelp]);

  // ════════════════════════════════════════════════════════
  // MAIN GAME LOOP
  // ════════════════════════════════════════════════════════
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const spawnParticles = (s: typeof stateRef.current, x: number, y: number, count: number) => {
      for (let i = 0; i < count; i++) {
        s.particles.push({
          x, y,
          vx: (Math.random() - 0.5) * 12 - 4,
          vy: (Math.random() - 0.8) * 12,
          life: 0,
          maxLife: 15 + Math.random() * 20,
        });
      }
    };

    // ── DRAWING HELPERS ──

    const drawGrid = () => {
      ctx.strokeStyle = baseColors.gridLine;
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 160) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let y = 0; y < H; y += 160) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    };

    const drawCelestial = (s: typeof stateRef.current) => {
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
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = `rgba(255,${Math.round(240 * h + 180 * (1 - h))},${Math.round(200 * h + 100 * (1 - h))},${sunA * 0.6})`;
      ctx.beginPath();
      ctx.arc(cx - 6, cy - 6, r * 0.45, 0, Math.PI * 2);
      ctx.fill();

      if (h > 0.2) {
        const rayA = sunA * 0.2 * ((h - 0.2) / 0.8);
        ctx.strokeStyle = `rgba(${sunR},${sunG},${sunB},${rayA})`;
        ctx.lineWidth = 3;
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2 + s.frame * 0.005;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * (r + 12), cy + Math.sin(angle) * (r + 12));
          ctx.lineTo(
            cx + Math.cos(angle) * (r + 24 + Math.sin(s.frame * 0.03 + i) * 8),
            cy + Math.sin(angle) * (r + 24 + Math.sin(s.frame * 0.03 + i) * 8)
          );
          ctx.stroke();
        }
      }

      if (h < 0.4) {
        const sa = ((0.4 - h) / 0.4) * (isDark ? 0.4 : 0.25);
        const stars = [
          [120, 60], [320, 100], [600, 48], [800, 120], [1040, 72],
          [180, 160], [480, 140], [720, 180], [960, 88], [1200, 140],
        ];
        for (const [sx, sy] of stars) {
          const tw = Math.sin(s.frame * 0.05 + sx) * 0.3 + 0.7;
          ctx.globalAlpha = sa * tw;
          ctx.fillStyle = `rgba(255,255,255,${sa})`;
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    };

    const drawParallaxBG = (s: typeof stateRef.current, camOffY: number) => {
      // Extend draw range based on zoom so parallax covers viewport when zoomed out
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
    };

    const drawTerrain = (s: typeof stateRef.current, camOffY: number) => {
      const camWorldX = s.px - PLAYER_SCREEN_X;
      const palette = getPalette(s.px);
      const layerOffsets = [0, 50, 110];
      // Extend draw range based on zoom to cover viewport when zoomed out
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
      ctx.strokeStyle = s.fever
        ? `rgba(253,82,0,${0.5 + Math.sin(s.frame * 0.2) * 0.2})`
        : palette.line;
      ctx.lineWidth = s.fever ? 4 : 3;
      ctx.stroke();
    };

    const drawNightChaser = (s: typeof stateRef.current) => {
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
    };

    const drawNightOverlay = (s: typeof stateRef.current) => {
      if (s.sunHeight > 0.7) return;
      const dim = (0.7 - s.sunHeight) / 0.7;
      ctx.fillStyle = `rgba(0,0,0,${dim * (isDark ? 0.3 : 0.18)})`;
      ctx.fillRect(0, 0, W, H);
    };

    const drawTrail = (s: typeof stateRef.current, camOffY: number) => {
      for (const t of s.trail) {
        const alpha = Math.max(0, 1 - t.age / 35);
        ctx.globalAlpha = alpha * (t.bright ? 0.8 : 0.5);
        ctx.fillStyle = t.bright ? '#fd5200' : baseColors.trailColor;
        ctx.beginPath();
        ctx.arc(t.x, t.y + camOffY, Math.max(2, PLAYER_R * (1 - t.age / 35) * (t.bright ? 0.7 : 0.5)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawParticles = (s: typeof stateRef.current, camOffY: number) => {
      for (const p of s.particles) {
        const alpha = Math.max(0, 1 - p.life / p.maxLife);
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillStyle = '#fd5200';
        ctx.beginPath();
        ctx.arc(p.x, p.y + camOffY, 6 * alpha, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawPlayer = (screenX: number, screenY: number, s: typeof stateRef.current) => {
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

      // Shadow on ground
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
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER_R + 20, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      ctx.shadowColor = glowColor;
      ctx.shadowBlur = s.fever ? 72 : 32 + speedPct * 56;

      ctx.fillStyle = bodyColor;
      ctx.beginPath();
      ctx.arc(0, 0, drawR, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(255,255,255,${0.3 + speedPct * 0.15})`;
      ctx.beginPath();
      ctx.arc(-6 * scale, -8 * scale, drawR * 0.35, 0, Math.PI * 2);
      ctx.fill();

      if (dive < 0.6) {
        const arcAlpha = (0.25 + speedPct * 0.35) * (1 - dive * 1.6);
        ctx.strokeStyle = `rgba(255,123,57,${arcAlpha})`;
        ctx.lineWidth = 3;
        const arcCount = s.fever ? 4 : s.vx > 14 ? 3 : 2;
        for (let i = 1; i <= arcCount; i++) {
          ctx.beginPath();
          ctx.arc(-8, 0, PLAYER_R + i * 20, -0.5, 0.5);
          ctx.stroke();
        }
      }

      ctx.restore();
    };

    // ════════════════════
    // FRAME LOOP
    // ════════════════════
    const loop = () => {
      const s = stateRef.current;

      ctx.fillStyle = baseColors.bg;
      ctx.fillRect(0, 0, W, H);
      drawGrid();

      const diveTarget = holdingRef.current ? 1 : 0;
      s.diveVisual += (diveTarget - s.diveVisual) * 0.18;

      // ════════════════════
      // IDLE
      // ════════════════════
      if (s.gameState === 'idle') {
        const idleSeed = 42;
        const terrY = getTerrainY(0, idleSeed);
        // Sun hidden on title screen — appears when the game starts
        const tempSeed = s.seed;
        s.seed = idleSeed;
        s.px = PLAYER_SCREEN_X;
        drawTerrain(s, 0);
        s.seed = tempSeed;
        s.px = 0;

        const idleY = terrY - PLAYER_R + Math.sin(Date.now() / 400) * 16;
        drawPlayer(PLAYER_SCREEN_X, idleY, s);

        ctx.fillStyle = baseColors.textBright;
        ctx.font = '500 36px "Noto Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Hold to dive \u00b7 Release to fly', W / 2, 112);
        ctx.fillStyle = baseColors.text;
        ctx.font = '400 28px "Noto Sans", sans-serif';
        ctx.fillText('Tap or hold Space to start', W / 2, 170);
        if (s.best > 0) {
          ctx.fillStyle = baseColors.perfectColor;
          ctx.font = '500 28px "Noto Sans", sans-serif';
          ctx.fillText(`Best: ${s.best}`, W / 2, 230);
        }
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      // ═════════════════���══
      // PLAYING
      // ════════════════════
      if (s.gameState === 'playing') {
        s.frame++;
        const holding = holdingRef.current;
        s.island = Math.floor(s.px / ISLAND_LENGTH);

        const world = worldRef.current;
        const bird = birdRef.current;

        // ── Fever mode ──
        if (s.fever) {
          s.feverTimer--;
          if (s.feverTimer <= 0) {
            // Fever ends — restore normal gravity, physics continues naturally
            s.fever = false;
            if (bird) {
              bird.setGravityScale(1.0);
            }
          } else if (world && bird) {
            // Physics-based fever: near-zero gravity + speed boost = insane soaring
            bird.setGravityScale(FEVER_GRAVITY_SCALE);

            // Boost forward speed if below fever minimum
            const vel = bird.getLinearVelocity();
            if (vel.x < FEVER_BOOST_VX) {
              bird.setLinearVelocity(planck.Vec2(FEVER_BOOST_VX, vel.y));
            }

            // Step physics normally (bird soars with near-zero gravity)
            world.step(1 / 60, 6, 2);

            // Read back position & velocity
            const pos = bird.getPosition();
            const newVel = bird.getLinearVelocity();
            s.px = pos.x * PTM;
            s.py = -pos.y * PTM;
            s.vx = newVel.x * PTM / 60;
            s.vy = -newVel.y * PTM / 60;

            // Trail & particles during fever
            if (s.frame % 2 === 0) s.trail.push({ x: PLAYER_SCREEN_X, y: s.py, age: 0, bright: true });
            if (s.frame % 3 === 0) spawnParticles(s, PLAYER_SCREEN_X, s.py, 2);
          }
        }
        // ── Normal physics (planck Box2D) ──
        else if (world && bird) {
          // 1. Gravity scale (set before step — matches original on_input before update)
          bird.setGravityScale(holding ? HEAVY_MULT : 1.0);

          // 2. Step FIRST (original: world:Step runs in update, fixedUpdate runs after via msg.post)
          world.step(1 / 60, 6, 2);

          // 3. Read position & velocity
          const pos = bird.getPosition();
          const newVel = bird.getLinearVelocity();
          s.px = pos.x * PTM;
          s.py = -pos.y * PTM;  // convert planck Y-up to screen Y-down
          s.vx = newVel.x * PTM / 60;
          s.vy = -newVel.y * PTM / 60;

          // 3b. Fever pending — activate on next upswing (bird going up in planck = vel.y > 0)
          if (s.feverPending && newVel.y > 0.5) {
            s.feverPending = false;
            s.fever = true;
            s.feverTimer = FEVER_DURATION;
            spawnParticles(s, PLAYER_SCREEN_X, s.py, 15);
            // LAUNCH: boost velocity on the upswing
            bird.setLinearVelocity(planck.Vec2(
              Math.max(newVel.x, FEVER_BOOST_VX),
              FEVER_LAUNCH_VY
            ));
          }

          // 4. Min velocity clamp (for NEXT step — matches original fixedUpdate timing)
          const vel = bird.getLinearVelocity();
          if (vel.x < MIN_VX_MS) {
            bird.setLinearVelocity(planck.Vec2(MIN_VX_MS, vel.y));
          }

          // 5. Height drag (for NEXT step)
          //    Original: position.y² × 0.007 where position.y is Box2D Y-up meters
          //    Our planck Y has offset: origPosY = pos.y + H/PTM = pos.y + 8.0
          if (vel.y > 0) {
            const origPosY = pos.y + H / PTM;  // map to original Box2D Y coordinate
            if (origPosY > 0) {
              const downForce = origPosY * origPosY * HEIGHT_DRAG_K;
              bird.applyForceToCenter(planck.Vec2(0, -downForce), true);
            }
          }

          // 6. Landing detection
          const terrainY = getTerrainY(s.px, s.seed);
          const surfaceY = terrainY - PLAYER_R;
          const onGround = s.py >= surfaceY - 8;
          const wasAbove = s.wasOnGround === false;

          if (onGround && wasAbove) {
            const dy = getTerrainY(s.px + 2, s.seed) - getTerrainY(s.px - 2, s.seed);
            const slope = dy;

            if (slope > 0.2 && holding && s.vx > 6) {
              s.combo++;
              s.comboTimer = 90;
              s.perfectLandings++;
              spawnParticles(s, PLAYER_SCREEN_X, s.py, 6);

              if (s.combo >= FEVER_COMBO && !s.fever && !s.feverPending) {
                // Don't launch yet — wait for the next upswing
                s.feverPending = true;
                s.feverFlash = 30;
                spawnParticles(s, PLAYER_SCREEN_X, s.py, 15);
              }
            } else {
              // No velocity penalty — original game has NONE.
              // Box2D physics naturally handles speed loss on upslopes.
              s.combo = 0;
            }
          }

          s.wasOnGround = onGround;
        }

        // ── Visual rotation (original angle clamping) ──
        if (s.vx * 60 / PTM < 1.0) {
          s.angle += (0 - s.angle) * 0.15;
        } else {
          let targetAngle = Math.atan2(s.vy, s.vx);
          if (targetAngle > 0.8) targetAngle = 0.8;
          if (targetAngle < -1.0) targetAngle = -1.0;
          s.angle += (targetAngle - s.angle) * 0.15;
        }

        // ── Camera zoom (original formula, NO lerp) ──
        // Original: zoom = 1.0 / (yPos / 640), clamped ≤ 1.3
        const playerYUp = H - s.py;  // bird Y in Y-up pixel space (native res!)
        const yPos = Math.max(1, playerYUp + TOP_SCREEN_BUFFER);
        const targetZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, 640 / yPos));
        s.zoom = targetZoom;  // DIRECT — no lerp

        // ── Night chaser ──
        if (!s.nightChasing && s.frame >= NIGHT_GRACE_FRAMES) {
          s.nightChasing = true;
        }
        if (s.nightChasing) {
          if (s.nightX < s.px) {
            s.nightX += NIGHT_SPEED;
          }
        }
        const nightGap = s.px - s.nightX;
        if (nightGap <= NIGHT_GAMEOVER_DIST && s.nightChasing) {
          s.gameState = 'dead';
          if (s.score > s.best) s.best = s.score;
          const bird = birdRef.current;
          if (bird) {
            const v = bird.getLinearVelocity();
            bird.setLinearVelocity(planck.Vec2(0, v.y > 0 ? -5.0 : v.y));
          }
          forceRender((n) => n + 1);
        }
        s.sunHeight = Math.max(0, Math.min(1, nightGap / NIGHT_START_GAP));

        // ── Trail ──
        if (s.frame % 2 === 0) {
          s.trail.push({ x: PLAYER_SCREEN_X, y: s.py, age: 0, bright: s.fever });
        }
        for (let i = s.trail.length - 1; i >= 0; i--) {
          s.trail[i].age++;
          s.trail[i].x -= s.vx * 0.7;
          if (s.trail[i].age > 35 || s.trail[i].x < -40) s.trail.splice(i, 1);
        }

        // ── Particles ──
        for (let i = s.particles.length - 1; i >= 0; i--) {
          const p = s.particles[i];
          p.x += p.vx - s.vx * 0.5;
          p.y += p.vy;
          p.vy += 0.2;
          p.life++;
          if (p.life >= p.maxLife || p.x < -40) s.particles.splice(i, 1);
        }

        if (s.comboTimer > 0) s.comboTimer--;
        if (s.feverFlash > 0) s.feverFlash--;

        s.score = Math.floor(s.px / 10) * 10;

        // Game over is now handled above in the night chaser section
      }

      // ── Game over physics continuation ──
      if (s.gameState === 'dead') {
        const world = worldRef.current;
        const bird = birdRef.current;
        if (world && bird) {
          const vel = bird.getLinearVelocity();
          bird.setLinearVelocity(planck.Vec2(0, vel.y > 0 ? -5.0 : vel.y));
          bird.setGravityScale(1.0);
          world.step(1 / 60, 6, 2);
          const pos = bird.getPosition();
          s.py = -pos.y * PTM;
        }
      }

      // ════════════════════
      // CAMERA (original Defold camera, native resolution)
      // ════════════════════
      // Original: cameraY = max(yPos/2, 246), direct assignment
      const playerYUpCam = H - s.py;
      const yPosCam = Math.max(1, playerYUpCam + TOP_SCREEN_BUFFER);
      const camYOrig = Math.max(yPosCam / 2, 246);

      // Bird screen Y from top:
      // viewport range in Y-up: [camY - 400/zoom, camY + 400/zoom]
      // birdScreenFromTop = (camY + 400/zoom - playerYUp) * zoom
      const birdScreenFromTop = (camYOrig + 400 / s.zoom - playerYUpCam) * s.zoom;
      const playerDrawY = Math.max(birdScreenFromTop, 30);

      // Camera offset for terrain alignment
      const camOffY = playerDrawY - s.py;

      // ════════════════════
      // DRAW
      // ════════════════════
      drawCelestial(s);

      // Zoom transform centered on bird
      ctx.save();
      ctx.translate(PLAYER_SCREEN_X, playerDrawY);
      ctx.scale(s.zoom, s.zoom);
      ctx.translate(-PLAYER_SCREEN_X, -playerDrawY);

      drawParallaxBG(s, camOffY);
      drawTerrain(s, camOffY);
      drawTrail(s, camOffY);
      drawParticles(s, camOffY);

      if (s.gameState === 'playing' || s.gameState === 'paused') {
        drawPlayer(PLAYER_SCREEN_X, playerDrawY, s);

        if (s.comboTimer > 0 && s.combo >= 1 && s.gameState === 'playing') {
          ctx.globalAlpha = Math.min(1, s.comboTimer / 30);
          ctx.fillStyle = baseColors.perfectColor;
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

      // ── Screen-space overlays (OUTSIDE zoom transform so they don't move with bird) ─
      if (s.gameState === 'playing') {
        drawNightChaser(s);
        drawNightOverlay(s);
        if (s.feverFlash > 0) {
          ctx.globalAlpha = (s.feverFlash / 30) * 0.3;
          ctx.fillStyle = '#fd5200';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
        }
        if (s.fever) {
          ctx.globalAlpha = (0.5 + Math.sin(s.frame * 0.1) * 0.3) * 0.1;
          ctx.fillStyle = '#fd5200';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
        }
      }

      // HUD (no zoom)
      if (s.gameState === 'playing') {
        const speedPct = Math.min(1, (s.vx - MIN_VX) / (MAX_VX - MIN_VX));
        ctx.fillStyle = baseColors.text;
        ctx.font = '400 24px "Noto Sans", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('SPD', 40, 56);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
        ctx.fillRect(110, 42, 200, 14);
        ctx.fillStyle = s.fever
          ? `rgba(253,82,0,${0.7 + Math.sin(s.frame * 0.2) * 0.3})`
          : `rgba(253,82,0,${0.4 + speedPct * 0.5})`;
        ctx.fillRect(110, 42, 200 * speedPct, 14);

        if (s.combo > 0) {
          ctx.fillStyle = baseColors.perfectColor;
          ctx.font = '500 24px "Noto Sans", sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`x${s.combo}`, 40, 90);
        }

        ctx.fillStyle = baseColors.text;
        ctx.font = '400 22px "Noto Sans", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`ZONE ${s.island + 1}`, 40, H - 30);

        // ── Debug altitude/velocity display ──
        const terrY = getTerrainY(s.px, s.seed);
        const altAboveTerrain = Math.round(terrY - PLAYER_R - s.py);
        const birdVelMs = (s.vx * 60 / PTM).toFixed(1);
        const birdVelYMs = (-s.vy * 60 / PTM).toFixed(1);
        ctx.fillStyle = baseColors.text;
        ctx.font = '400 20px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`ALT: ${altAboveTerrain}px  VX: ${birdVelMs}m/s  VY: ${birdVelYMs}m/s  Z: ${s.zoom.toFixed(2)}`, 40, H - 60);
      }

      if (s.gameState === 'playing' || s.gameState === 'dead' || s.gameState === 'paused') {
        ctx.fillStyle = baseColors.text;
        ctx.font = '400 28px "Noto Sans", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`HI ${String(s.best).padStart(4, '0')}`, W - 48, 56);
        ctx.fillStyle = baseColors.textBright;
        ctx.font = '600 48px "Noto Sans", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(String(s.score).padStart(4, '0'), W - 48, 110);
      }

      if (s.gameState === 'dead') {
        ctx.fillStyle = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
        ctx.fillRect(0, 0, W, H);
        drawPlayer(PLAYER_SCREEN_X, playerDrawY, s);

        ctx.fillStyle = baseColors.textBright;
        ctx.font = '600 48px "Noto Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Night fell', W / 2, H / 2 - 100);
        ctx.fillStyle = '#fd5200';
        ctx.font = '500 40px "Noto Sans", sans-serif';
        ctx.fillText(`Distance: ${s.score}`, W / 2, H / 2 - 30);
        if (s.perfectLandings > 0) {
          ctx.fillStyle = baseColors.text;
          ctx.font = '400 28px "Noto Sans", sans-serif';
          ctx.fillText(`${s.perfectLandings} perfect slide${s.perfectLandings !== 1 ? 's' : ''} \u00b7 Zone ${s.island + 1}`, W / 2, H / 2 + 30);
        }
        ctx.fillStyle = baseColors.textBright;
        ctx.font = '400 32px "Noto Sans", sans-serif';
        ctx.fillText('Tap to retry', W / 2, H / 2 + 110);
      }

      // ── Paused overlay (drawn on canvas) ──
      if (s.gameState === 'paused') {
        // Dim overlay
        ctx.fillStyle = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.55)';
        ctx.fillRect(0, 0, W, H);

        ctx.fillStyle = baseColors.textBright;
        ctx.font = '600 52px "Noto Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Paused', W / 2, H / 2 - 20);
        ctx.fillStyle = baseColors.text;
        ctx.font = '400 28px "Noto Sans", sans-serif';
        ctx.fillText('Press Esc to resume', W / 2, H / 2 + 30);

        // Still show score
        ctx.fillStyle = baseColors.textBright;
        ctx.font = '600 48px "Noto Sans", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(String(s.score).padStart(4, '0'), W - 48, 110);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isDark, baseColors, palettes, getPalette]);

  const gameState = stateRef.current.gameState;
  const isActive = gameState === 'playing' || gameState === 'paused';

  // Responsive scaling for small viewports — full width, no padding
  const [displayScale, setDisplayScale] = useState(1);
  useEffect(() => {
    const calcScale = () => {
      const scaleX = Math.min(1, window.innerWidth / DISPLAY_W);
      const scaleY = Math.min(1, (window.innerHeight - 64) / DISPLAY_H);
      setDisplayScale(Math.min(scaleX, scaleY));
    };
    calcScale();
    window.addEventListener('resize', calcScale);
    return () => window.removeEventListener('resize', calcScale);
  }, []);

  return (
    <div
      className="relative inline-block"
      style={{
        width: DISPLAY_W * displayScale,
        height: DISPLAY_H * displayScale,
      }}
    >
      <div
        className="relative"
        style={{
          width: DISPLAY_W,
          height: DISPLAY_H,
          transform: `scale(${displayScale})`,
          transformOrigin: 'top left',
        }}
      >
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        onMouseDown={() => { if (!showHelp && gameState !== 'paused') handleDown(); }}
        onMouseUp={handleUp}
        onTouchStart={(e) => { e.preventDefault(); if (!showHelp && gameState !== 'paused') handleDown(); }}
        onTouchEnd={(e) => { e.preventDefault(); handleUp(); }}
        className="rounded-sm cursor-pointer outline-none select-none"
        style={{ width: DISPLAY_W, height: DISPLAY_H, touchAction: 'none' }}
      />

      {/* ── Top-right button bar ── */}
      <div className="absolute bottom-1.5 right-1.5 flex gap-1.5" style={{ pointerEvents: 'auto' }}>
        <button
          onClick={(e) => { e.stopPropagation(); setShowHelp(true); if (gameState === 'playing') togglePause(); }}
          className="px-2 py-0.5 rounded text-[11px] cursor-pointer transition-opacity"
          style={{
            background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
            color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`,
          }}
        >
          ?
        </button>
        {isActive && (
          <button
            onClick={(e) => { e.stopPropagation(); togglePause(); }}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer transition-opacity"
            style={{
              background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
              color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
              border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`,
            }}
          >
            {gameState === 'paused' ? 'Resume' : 'Pause'}
          </button>
        )}
        {(isActive || gameState === 'dead') && (
          <button
            onClick={(e) => { e.stopPropagation(); handleReset(); }}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer transition-opacity"
            style={{
              background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
              color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
              border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`,
            }}
          >
            Reset
          </button>
        )}
      </div>

      {/* ── How to Play overlay ── */}
      {showHelp && (
        <div
          className="absolute inset-0 flex items-center justify-center rounded-sm"
          style={{
            background: isDark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)',
            zIndex: 10,
          }}
          onClick={() => setShowHelp(false)}
        >
          <div
            className="max-w-[420px] px-6 py-5 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              className="mb-3"
              style={{ color: isDark ? 'rgba(255,255,255,0.87)' : 'rgba(0,0,0,0.8)' }}
            >
              How to Play
            </h2>

            <div
              className="text-left space-y-2.5 mb-4 text-[13px]"
              style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', lineHeight: '1.5' }}
            >
              <p>
                You&apos;re a bird rolling over hills. Fly as far as you can before{' '}
                <span style={{ color: '#fd5200' }}>nightfall catches you</span>.
              </p>
              <p>
                <span style={{ color: isDark ? 'rgba(255,255,255,0.87)' : 'rgba(0,0,0,0.8)' }}>Hold</span>{' '}
                (click, tap, or Space) to dive heavy into slopes.{' '}
                <span style={{ color: isDark ? 'rgba(255,255,255,0.87)' : 'rgba(0,0,0,0.8)' }}>Release</span>{' '}
                to float light and soar off hilltops.
              </p>
              <p>
                The trick: hold while going{' '}
                <span style={{ color: isDark ? 'rgba(255,255,255,0.87)' : 'rgba(0,0,0,0.8)' }}>downhill</span>{' '}
                to build speed, then let go at the bottom to launch into the air. Good timing = big air.
              </p>
              <p>
                Land 5 perfect dives in a row to trigger{' '}
                <span style={{ color: '#fd5200' }}>Fever Mode</span> &mdash; a huge speed boost that rockets you into the sky.
              </p>
              <p style={{ opacity: 0.7 }}>
                Press{' '}
                <span style={{ color: isDark ? 'rgba(255,255,255,0.87)' : 'rgba(0,0,0,0.8)' }}>Esc</span>{' '}
                to pause anytime.
              </p>
            </div>

            <button
              onClick={() => setShowHelp(false)}
              className="px-4 py-1.5 rounded text-[13px] cursor-pointer"
              style={{
                background: '#fd5200',
                color: '#fff',
                border: 'none',
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}