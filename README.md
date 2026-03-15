# Radar Runner

A gravity-based flight game built with React, Canvas 2D, and Planck.js (Box2D physics). Originally a Defold engine game, faithfully recreated in the browser.

## Play

```bash
bun install
bun dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## How to Play

You're a bird rolling over procedurally generated hills. Fly as far as you can before nightfall catches you.

- **Hold** (click, tap, or Space) to dive heavy into slopes
- **Release** to float light and soar off hilltops
- **Esc** to pause

The trick: hold while going **downhill** to build speed, then release at the bottom to launch into the air. Good timing = big air.

Land 5 perfect dives in a row to trigger **Fever Mode** — a huge speed boost that rockets you into the sky.

## Build

```bash
bun run build    # outputs to dist/
bun run preview  # preview the build
```

## Tech

- **React 19** — component wrapper and UI
- **Canvas 2D** — all game rendering (no sprites, fully procedural)
- **Planck.js** — Box2D physics engine for realistic rolling/flying
- **Vite** — dev server and bundler
- **Tailwind CSS** — minimal UI styling

## Controls

| Input | Action |
|-------|--------|
| Click / Tap / Space / ArrowDown | Hold to dive, release to soar |
| Esc | Pause / Resume |

## Game Mechanics

- **Procedural terrain** — seeded RNG generates 303 valleys with increasing difficulty
- **Night chaser** — darkness approaches from behind at 1400 px/s; outrun it or die
- **Combo system** — land on downhill slopes while holding to build combos
- **Fever mode** — 5 perfect landings triggers low-gravity speed boost
- **Dynamic camera** — zooms out at altitude for dramatic flight visuals
- **6 color palettes** — cycle as you progress through zones
