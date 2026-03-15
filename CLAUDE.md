# Radar Runner

Standalone browser game — React + Canvas 2D + Planck.js physics.

## Structure

- `src/components/RadarRunner.tsx` — the entire game (physics, rendering, input, UI) in one component
- `src/App.tsx` — wrapper with dark/light theme toggle
- `src/main.tsx` — React entry point

## Key details

- Canvas renders at 1280x800 internally, displayed at 640x400 via CSS scaling
- All physics values match the original Defold game editor properties
- Terrain is procedurally generated from a seed (seeded RNG)
- No game assets — everything is drawn via Canvas 2D API
- Uses Planck.js (Box2D) for physics simulation at 60fps
