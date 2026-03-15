# Film Simulation (3D LUT) Design

## Overview

Add film stock emulation to the RAW editor using 3D LUT textures loaded from HaldCLUT PNG images. A new "Film" tool panel lets users select from bundled and lazy-loaded presets with adjustable strength. Non-destructive — the LUT is a separate render pass independent of adjustment parameters.

## Data Model

### EditParams Extension

Add optional `film` field to `EditParams` in `src/types/index.ts`:

```typescript
film?: {
  presetId: string | null  // null = no preset
  strength: number          // 0-100, default 100
}
```

Default: `{ presetId: null, strength: 100 }`. When `presetId` is null, the LUT pass is skipped entirely.

### FilmPreset Type

```typescript
interface FilmPreset {
  id: string            // e.g. 'kodak-portra-400'
  name: string          // e.g. 'Portra 400'
  category: string      // e.g. 'Kodak', 'Fuji', 'B&W'
  bundled: boolean      // true = shipped with app, false = lazy-loaded
  lutUrl: string        // path or URL to the HaldCLUT PNG
}
```

A preset registry array in a constants file lists all available presets.

### ActiveTool Extension

Extend `ActiveTool` type: `'adjust' | 'crop' | 'film'`

## Rendering Pipeline

Current: Geometry → Adjustments → Blit to canvas

New: Geometry → Adjustments → **LUT pass** → Blit to canvas

### LUT Pass

- Reads from adjustment FBO texture
- Samples a `TEXTURE_3D` (the loaded LUT) using the pixel's RGB as 3D coordinates
- Mixes original and LUT-mapped color by strength: `mix(original, lutColor, u_strength)`
- Writes to a new `lutFBO`
- Blit reads from `lutFBO` (or `adjustmentFBO` when no preset is active)

When no preset is active (`presetId === null`), the LUT pass is skipped — blit reads directly from `adjustmentFBO`. Zero overhead when not in use.

### LUT Fragment Shader

Vertex shader: reuses `ADJUSTMENT_VERT` (passthrough).

```glsl
#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform sampler3D u_lut;
uniform float u_strength;

void main() {
  vec3 color = texture(u_texture, v_uv).rgb;
  vec3 graded = texture(u_lut, color).rgb;
  fragColor = vec4(mix(color, graded, u_strength), 1.0);
}
```

## HaldCLUT Loading

### Decoding Pipeline

1. Load PNG via `new Image()` + `onload`
2. Draw to offscreen `<canvas>`, call `getImageData()` for RGBA pixels
3. Determine LUT size from image dimensions: 512×512 HaldCLUT = 64³ entries (cube root of total pixels)
4. Rearrange pixel data from 2D Hald layout into linear 3D array
5. Upload via `gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 64, 64, 64, 0, gl.RGB, gl.UNSIGNED_BYTE, data)`
6. Set `LINEAR` filtering + `CLAMP_TO_EDGE` wrapping for smooth interpolation

### Caching

`Map<string, WebGLTexture>` on the renderer, keyed by preset ID. Once loaded, stays in GPU memory until renderer disposal. Switching between previously-used presets is instant.

### Bundled vs Lazy-Loaded

- **Bundled** (~5-6 presets, ~3-4MB): PNGs in `public/luts/`, fetched as relative URLs. Available offline.
- **Lazy-loaded**: Fetched from CDN URL in preset registry. "More..." button triggers fetch of extended collection.

## UI: Film Tool Panel

New "Film" button in the sidebar tool tabs (alongside Adjust and Crop).

```
[Adjust] [Crop] [Film]

Film Simulation

[None]

  Kodak
  ├ Portra 160
  ├ Portra 400
  ├ Ektar 100
  ├ Gold 200

  Fuji
  ├ Superia 400
  ├ Pro 400H
  ├ Velvia 50

  B&W
  ├ Tri-X 400
  ├ HP5 Plus
  ├ Delta 3200

  [More...]

Strength
[——slider——] [100%]
```

- Presets grouped by category
- Active preset highlighted
- "None" clears the preset
- Strength slider (0-100%) visible only when a preset is active
- "More..." button lazy-loads extended collection with loading spinner

## Persistence & Undo

- **OPFS**: `film` is part of `EditParams`, auto-saved via existing `params.json`. Only `presetId` and `strength` saved, not LUT data.
- **Undo/redo**: Automatic — snapshot system captures full `EditParams` including `film`.
- **Export**: `exportFullRes` runs the full pipeline including LUT pass, so exports include the film preset.
- **Backward compat**: `film` is optional on `EditParams`. Old saved params without it load fine — no preset applied.

## Files to Create/Modify

### Create
- `src/renderer/shaders/lut.ts` — LUT fragment shader
- `src/renderer/lutLoader.ts` — HaldCLUT PNG → 3D texture decoder + cache
- `src/components/edit/FilmPanel.tsx` — Film preset selection UI
- `src/components/edit/FilmPanel.css` — Film panel styles
- `public/luts/` — Bundled HaldCLUT PNG files

### Modify
- `src/types/index.ts` — Add `film` to `EditParams`, `FilmPreset` type, extend `ActiveTool`
- `src/lib/constants.ts` — Film preset registry array
- `src/renderer/WebGLRenderer.ts` — LUT pass, lutFBO, 3D texture management, cache
- `src/components/edit/AdjustmentPanel.tsx` — Add "Film" tool tab button
- `src/components/edit/EditView.tsx` — Render FilmPanel conditionally
- `src/stores/editStore.ts` — Default film params
