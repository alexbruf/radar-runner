# Radar Runner

Web component game (`<radar-runner>`) — browser and terminal versions sharing the same Planck.js physics.

## Structure

### Web component (npm package)
- `src/main.ts` — library entry, exports `RadarRunnerShell`
- `src/radar-runner-shell.ts` — thin web component shell (loading screen, theming, sizing, collapsed mode, slots)
- `src/radar-runner-game.ts` — heavy game module: Planck.js physics, terrain generation, Canvas 2D rendering (lazy-loaded)
- `src/react.ts` — React wrapper component
- `src/preact.ts` — Preact wrapper component
- `src/vue.ts` — Vue wrapper component
- `src/demo.ts` — demo site entry point (side-effectful import)

### TUI version
- `tui.ts` — standalone terminal game using Planck.js + braille rendering

### Build configs
- `vite.config.ts` — library build (multi-entry: main + react + preact + vue → `dist/`)
- `vite.config.demo.ts` — demo site build (HTML + assets → `demo-dist/`)
- `tsconfig.json` — base TypeScript config
- `tsconfig.build.json` — declaration generation for npm types

### CI/CD
- `.github/workflows/npm-publish.yml` — publishes to npm on `v*` tag
- `.github/workflows/pages.yml` — deploys demo site to GitHub Pages on push to main
- `.github/workflows/release.yml` — builds cross-platform TUI binaries on `v*` tag

## Commands

- `bun dev` — demo site (Vite dev server)
- `bun run build` — library build → `dist/` (for npm)
- `bun run build:demo` — demo site → `demo-dist/` (for GitHub Pages)
- `bun run typecheck` — type checking
- `bun run tui` — TUI version
- `bun run build:tui` — compile TUI to standalone binary

## Key details

- Web component: `<radar-runner>` with shadow DOM, lazy-loaded game chunk
- Two build outputs: library (`dist/`) and demo site (`demo-dist/`)
- Shell is ~3KB gzip, game chunk is ~55KB gzip (includes Planck.js)
- Game chunk only loads when component is visible (or on first expand in collapsed mode)
- Framework wrappers (react/preact/vue) are thin createElement wrappers, <1KB each
- Theme follows `prefers-color-scheme` by default, overridable via `color-mode` attribute
- Sizing: `width`/`height` attrs or auto-fill container (8:5 aspect ratio)
- Collapsed mode uses named slots (`open`/`close`) for custom button content
- `::part(toggle)` and CSS custom properties for button styling

## Releasing

```
npm version patch   # bumps version in package.json
git push && git push --tags
```

This triggers:
- npm publish via `npm-publish.yml`
- TUI binary builds via `release.yml`
- Demo deploy happens on push to main via `pages.yml`
