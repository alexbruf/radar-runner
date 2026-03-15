# Radar Runner

Standalone game — browser (React + Canvas 2D) and terminal (TUI) versions sharing the same Planck.js physics.

## Structure

### Browser version
- `src/components/RadarRunner.tsx` — full game in one component (physics, rendering, input, UI)
- `src/App.tsx` — wrapper with dark/light theme toggle
- `src/main.tsx` — React entry point

### TUI version
- `tui.ts` — standalone terminal game using terminal-kit + Planck.js + braille rendering

### CI/CD
- `.github/workflows/release.yml` — builds cross-platform binaries on tag push

## Commands

- `bun run dev` — browser version (Vite dev server)
- `bun run tui` — TUI version (runs directly)
- `bun run build:tui` — compile TUI to standalone binary (`radar-runner`)
- `bun run build` — build browser version (Vite)

## Key details

- Same Planck.js (Box2D) physics in both versions — identical terrain, gravity, fever, night chaser
- Terrain is procedurally generated from a seeded RNG (mulberry32)
- No game assets — everything drawn via Canvas 2D (browser) or Unicode braille chars (TUI)
- TUI uses braille characters (U+2800-U+28FF) for 4× vertical resolution terrain rendering
- Camera zoom scales pixels-per-cell dynamically based on altitude
- Dark/light theme auto-detected from terminal, toggled with `T` key

## Releasing

Push a version tag to trigger CI/CD:
```
git tag v1.0.0
git push origin v1.0.0
```
GitHub Actions builds binaries for Linux x64/ARM64 and macOS x64/ARM64, attaches them to a GitHub Release.
