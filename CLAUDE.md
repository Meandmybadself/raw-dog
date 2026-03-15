# Raw Dog - Development Guide

## Build & Run

```bash
npm install --legacy-peer-deps   # Required due to vite-plugin-wasm peer dep
npm run dev                       # Dev server at localhost:5173
npm run build                     # Production build to dist/
```

## Architecture

Browser-based RAW photo editor. All processing happens client-side — no server.

- **Vite + React + TypeScript** — UI framework
- **WebGL2** — Two-pass rendering pipeline (geometry → adjustments) with RGBA32F textures
- **libraw-wasm** — RAW decoding in Web Workers (CR2, NEF, ARW, DNG, etc.)
- **Zustand** — State management with undo/redo
- **OPFS** — Origin Private File System for file/edit/thumbnail persistence

### Key Directories

- `src/renderer/` — WebGL renderer, GLSL shaders, Bradford white balance math
- `src/workers/` — Web Workers for decode (with pool) and encode
- `src/stores/` — Zustand stores: editStore (params + undo), fileStore (catalog), uiStore
- `src/components/` — React UI split by view (library/, edit/, common/, layout/)
- `src/lib/opfs/` — OPFS file persistence manager

### Rendering Pipeline

Input (sRGB 8-bit from libraw) → linearize → white balance → exposure → highlights/shadows/whites/blacks → contrast → clarity → saturation/vibrance → sRGB encode → canvas

### Important Patterns

- Shaders operate in **linear light** — sRGB decoded at start, re-encoded at end
- `adjustLuminance()` preserves color ratios when changing brightness
- Default temperature is **6504K** (D65) = identity matrix, since libraw already applies camera WB
- Worker pool caps at `min(navigator.hardwareConcurrency, 8)` workers
- `coi-serviceworker` provides COOP/COEP headers for GitHub Pages deployment
- libraw-wasm's `imageData()` returns plain Objects via structured clone — `extractPixelData()` handles this

## Lint / Type Check

```bash
npx tsc -b                       # Full type check (same as CI)
```

Note: `tsconfig.app.json` has `erasableSyntaxOnly: true` — don't use parameter properties in classes.

## Deployment

Push to `main` triggers GitHub Actions → builds → deploys to GitHub Pages at `rawdog.meandmybadself.com`.
