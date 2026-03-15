# Rotation & Straighten Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 90° rotation buttons, enhanced fine-rotation slider with numeric input, and a draw-a-line straighten tool to the crop panel.

**Architecture:** Extend `CropRect` with `quarterTurns` (0-3). The geometry vertex shader combines `quarterTurns * 90° + angle` into a single rotation matrix. A new `StraightenOverlay` component renders an SVG line over the canvas and computes the correction angle. The renderer swaps effective width/height when `quarterTurns` is odd.

**Tech Stack:** React, TypeScript, WebGL2 (GLSL 300 es), Zustand

---

## Chunk 1: Data Model & Shader

### Task 1: Add `quarterTurns` to CropRect type and defaults

**Files:**
- Modify: `src/types/index.ts:18-24` (CropRect interface)
- Modify: `src/types/index.ts:38` (DEFAULT_EDIT_PARAMS crop default)

- [ ] **Step 1: Add `quarterTurns` to `CropRect` interface**

In `src/types/index.ts`, add `quarterTurns` to the `CropRect` interface:

```typescript
export interface CropRect {
  x: number       // normalized [0, 1]
  y: number
  width: number
  height: number
  angle: number   // degrees, -45 to +45
  quarterTurns?: number  // 0-3, each representing 90° CW rotation (optional for backward compat with saved params)
}
```

- [ ] **Step 2: Update `DEFAULT_EDIT_PARAMS` crop default**

In `src/types/index.ts`, update the crop default:

```typescript
crop: { x: 0, y: 0, width: 1, height: 1, angle: 0, quarterTurns: 0 },
```

- [ ] **Step 3: No special backward-compat code needed**

Since `quarterTurns` is typed as optional (`quarterTurns?: number`), existing saved params without it load fine. All code that reads `quarterTurns` uses `?? 0` (e.g., `(crop.quarterTurns ?? 0) + 1`). No changes needed to `editStore.loadParams()`.

- [ ] **Step 4: Update `resetToDefaults` and `CropControls` reset to include `quarterTurns`**

In `src/components/edit/AdjustmentPanel.tsx`, the "Reset Crop" button currently sets:
```typescript
setParam('crop', { x: 0, y: 0, width: 1, height: 1, angle: 0 })
```
Update to:
```typescript
setParam('crop', { x: 0, y: 0, width: 1, height: 1, angle: 0, quarterTurns: 0 })
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc -b`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/stores/editStore.ts src/components/edit/AdjustmentPanel.tsx
git commit -m "feat: add quarterTurns to CropRect type and defaults"
```

---

### Task 2: Update geometry shader to support `quarterTurns`

**Files:**
- Modify: `src/renderer/shaders/geometry.ts:1-37` (vertex shader)
- Modify: `src/renderer/WebGLRenderer.ts:77` (uniform list)
- Modify: `src/renderer/WebGLRenderer.ts:236-247` (geometry pass uniforms)

- [ ] **Step 1: Add `u_quarterTurns` uniform to geometry vertex shader**

Replace the entire `GEOMETRY_VERT` export in `src/renderer/shaders/geometry.ts`:

```glsl
export const GEOMETRY_VERT = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;

out vec2 v_uv;

uniform vec4 u_cropRect;   // x, y, width, height in [0,1]
uniform float u_rotation;  // fine rotation in radians
uniform vec2 u_flip;       // x=flipH, y=flipV (0 or 1)
uniform int u_quarterTurns; // 0-3: number of 90° CW rotations
uniform vec2 u_srcAspect;  // x=srcW/srcH, y=srcH/srcW (for aspect correction)

void main() {
  // Flip Y to convert from WebGL (Y-up) to image (Y-down) coordinates
  vec2 uv = vec2(a_uv.x, 1.0 - a_uv.y);

  if (u_flip.x > 0.5) uv.x = 1.0 - uv.x;
  if (u_flip.y > 0.5) uv.y = 1.0 - uv.y;

  // Apply 90° CW rotations around image center (0.5, 0.5)
  // Each 90° CW visual rotation = (x,y) -> (1-y, x) in UV space
  for (int i = 0; i < 4; i++) {
    if (i >= u_quarterTurns) break;
    uv = vec2(1.0 - uv.y, uv.x);
  }

  // When quarterTurns is odd, the source texture aspect differs from the output.
  // The UV [0,1]x[0,1] maps to the output canvas which has swapped aspect.
  // We need to stretch UVs to sample the correct region of the source texture.
  if (u_quarterTurns == 1 || u_quarterTurns == 3) {
    // Scale UV around center to correct aspect ratio
    uv = vec2(
      0.5 + (uv.x - 0.5) * u_srcAspect.x,
      0.5 + (uv.y - 0.5) * u_srcAspect.y
    );
  }

  // Apply crop
  uv = u_cropRect.xy + uv * u_cropRect.zw;

  // Apply fine rotation around crop center
  if (abs(u_rotation) > 0.0001) {
    vec2 center = u_cropRect.xy + u_cropRect.zw * 0.5;
    vec2 offset = uv - center;
    float cosR = cos(-u_rotation);
    float sinR = sin(-u_rotation);
    offset = vec2(
      offset.x * cosR - offset.y * sinR,
      offset.x * sinR + offset.y * cosR
    );
    uv = center + offset;
  }

  v_uv = uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`
```

Key changes:
- The 90° rotation formula is `vec2(1.0 - uv.y, uv.x)` — this produces a **visually CW** rotation (verified: UV (0,0) top-left maps to sample (1,0) top-right of source, which is correct CW).
- When `quarterTurns` is odd, the UV coordinates are scaled around center using `u_srcAspect` to compensate for the aspect ratio difference between source texture and output canvas. Without this, the image would appear stretched.
- The crop rect is applied after rotation, so the user thinks in terms of the rotated image.

- [ ] **Step 2: Register `u_quarterTurns` uniform in WebGLRenderer**

In `src/renderer/WebGLRenderer.ts`, update the geometry uniforms list (line 77):

```typescript
const geometryUniforms = ['u_texture', 'u_cropRect', 'u_rotation', 'u_flip', 'u_quarterTurns', 'u_srcAspect']
```

- [ ] **Step 3: Pass `u_quarterTurns` uniform in `renderPipeline`**

In `src/renderer/WebGLRenderer.ts`, in the `renderPipeline` method, make these changes to the geometry pass uniform block:

**a) Always pass rotation and quarterTurns** (remove `applyCrop` gating so rotation is visible in crop mode):

```typescript
gl.uniform1f(
  this.geometryProgram.uniforms.get('u_rotation')!,
  params.crop.angle * Math.PI / 180,
)
gl.uniform1i(
  this.geometryProgram.uniforms.get('u_quarterTurns')!,
  params.crop.quarterTurns ?? 0,
)
```

**b) Pass aspect ratio for aspect correction:**

```typescript
const aspect = this.fullWidth / this.fullHeight
gl.uniform2f(
  this.geometryProgram.uniforms.get('u_srcAspect')!,
  aspect,       // srcW/srcH
  1.0 / aspect, // srcH/srcW
)
```

**c) Keep the crop rect gated on `applyCrop`** (existing behavior — full image in crop mode, cropped otherwise). No change needed there.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc -b`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/shaders/geometry.ts src/renderer/WebGLRenderer.ts
git commit -m "feat: add quarterTurns support to geometry shader"
```

---

### Task 3: Handle aspect ratio swap for odd `quarterTurns`

When `quarterTurns` is 1 or 3, the displayed image has swapped width/height. The canvas sizing and FBO allocation need to reflect this.

**Files:**
- Modify: `src/renderer/WebGLRenderer.ts` (add `getEffectiveDims` method, update FBO sizing)
- Modify: `src/components/edit/CanvasViewport.tsx:95-119` (use effective dims for aspect ratio)

- [ ] **Step 1: Add `getEffectiveDims()` to `WebGLRenderer`**

Add a public method to `WebGLRenderer`:

```typescript
getEffectiveDims(quarterTurns: number): { w: number; h: number } {
  if (quarterTurns % 2 === 1) {
    return { w: this.fullHeight, h: this.fullWidth }
  }
  return { w: this.fullWidth, h: this.fullHeight }
}
```

- [ ] **Step 2: Update `CanvasViewport` to use effective dimensions**

In `src/components/edit/CanvasViewport.tsx`, the `fitCanvas` callback needs to account for `quarterTurns`. Update to read `params.crop.quarterTurns` and compute effective aspect ratio:

```typescript
const fitCanvas = useCallback(() => {
  if (!containerRef.current || !canvasRef.current || !rendererRef.current || !imageDims) return

  const container = containerRef.current.getBoundingClientRect()
  const qt = params.crop.quarterTurns ?? 0
  const effectiveW = qt % 2 === 1 ? imageDims.h : imageDims.w
  const effectiveH = qt % 2 === 1 ? imageDims.w : imageDims.h
  const imgAspect = effectiveW / effectiveH
  const containerAspect = container.width / container.height

  let displayW: number
  let displayH: number

  if (imgAspect > containerAspect) {
    displayW = container.width
    displayH = container.width / imgAspect
  } else {
    displayH = container.height
    displayW = container.height * imgAspect
  }

  const dpr = Math.min(window.devicePixelRatio, 2)
  canvasRef.current.style.width = `${Math.round(displayW)}px`
  canvasRef.current.style.height = `${Math.round(displayH)}px`
  rendererRef.current.resize(Math.round(displayW * dpr), Math.round(displayH * dpr))
}, [rendererRef, imageDims, params.crop.quarterTurns])
```

Note the added dependency on `params.crop.quarterTurns` so the canvas re-fits when rotation changes.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc -b`
Expected: No errors.

- [ ] **Step 4: Manual test**

Open the app at `http://localhost:5173`, load a RAW image, switch to Crop tool. At this point you can't rotate yet (UI not added), but verify nothing is broken. We'll test the actual 90° rotation in Task 5 after the UI is built.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/WebGLRenderer.ts src/components/edit/CanvasViewport.tsx
git commit -m "feat: handle aspect ratio swap for odd quarterTurns"
```

---

## Chunk 2: Rotation UI Controls

### Task 4: Add 90° rotation buttons and enhanced rotation slider to CropControls

**Files:**
- Modify: `src/components/edit/AdjustmentPanel.tsx:102-145` (CropControls component)
- Modify: `src/components/edit/AdjustmentPanel.css` (new styles)

- [ ] **Step 1: Add `straightenActive` state to uiStore (must be done before CropControls rewrite)**

In `src/stores/uiStore.ts`, add to the interface and store:

```typescript
// Add to UIState interface:
straightenActive: boolean
setStraightenActive: (active: boolean) => void

// Add to the store's initial state:
straightenActive: false,
setStraightenActive: (straightenActive) => set({ straightenActive }),
```

Note: `straightenActive` is intentionally NOT added to `partialize` — it should not persist across sessions.

- [ ] **Step 2: Rewrite CropControls with rotation buttons, slider, and numeric input**

Replace the `CropControls` function in `src/components/edit/AdjustmentPanel.tsx`:

```tsx
function CropControls() {
  const crop = useEditStore((s) => s.params.crop)
  const setParam = useEditStore((s) => s.setParam)
  const commitSnapshot = useEditStore((s) => s.commitSnapshot)
  const setActiveTool = useUIStore((s) => s.setActiveTool)
  const straightenActive = useUIStore((s) => s.straightenActive)
  const setStraightenActive = useUIStore((s) => s.setStraightenActive)

  const rotateCW = () => {
    setParam('crop', {
      ...crop,
      quarterTurns: ((crop.quarterTurns ?? 0) + 1) % 4,
      // Reset crop region on 90° rotation since frame of reference changes
      x: 0, y: 0, width: 1, height: 1,
    })
    commitSnapshot()
  }

  const rotateCCW = () => {
    setParam('crop', {
      ...crop,
      quarterTurns: ((crop.quarterTurns ?? 0) + 3) % 4,
      x: 0, y: 0, width: 1, height: 1,
    })
    commitSnapshot()
  }

  return (
    <div className="panel-section">
      <h3 className="panel-section__title">Crop & Rotate</h3>
      <button
        className="done-btn"
        onClick={() => {
          setStraightenActive(false)
          setActiveTool('adjust')
        }}
      >
        Done
      </button>

      <div className="rotation-controls">
        <div className="rotation-controls__row">
          <button
            className="rotation-controls__btn"
            onClick={rotateCCW}
            title="Rotate 90° counter-clockwise"
            aria-label="Rotate 90° counter-clockwise"
          >
            ↶
          </button>
          <div className="rotation-controls__slider-group">
            <input
              type="range"
              className="rotation-controls__slider"
              min={-45}
              max={45}
              step={0.1}
              value={crop.angle}
              onInput={(e) => setParam('crop', { ...crop, angle: parseFloat((e.target as HTMLInputElement).value) })}
              onPointerUp={commitSnapshot}
              onDoubleClick={() => { setParam('crop', { ...crop, angle: 0 }); commitSnapshot() }}
              aria-label="Fine rotation"
            />
            <input
              type="number"
              className="rotation-controls__input"
              min={-45}
              max={45}
              step={0.1}
              value={parseFloat(crop.angle.toFixed(1))}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (!isNaN(v)) {
                  setParam('crop', { ...crop, angle: Math.max(-45, Math.min(45, v)) })
                }
              }}
              onBlur={commitSnapshot}
              aria-label="Rotation degrees"
            />
          </div>
          <button
            className="rotation-controls__btn"
            onClick={rotateCW}
            title="Rotate 90° clockwise"
            aria-label="Rotate 90° clockwise"
          >
            ↷
          </button>
        </div>
        <button
          className={`straighten-btn ${straightenActive ? 'straighten-btn--active' : ''}`}
          onClick={() => setStraightenActive(!straightenActive)}
        >
          Straighten
        </button>
      </div>

      <button
        className="reset-btn"
        onClick={() => {
          setParam('crop', { x: 0, y: 0, width: 1, height: 1, angle: 0, quarterTurns: 0 })
          commitSnapshot()
        }}
      >
        Reset Crop
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Add CSS for rotation controls**

Append to `src/components/edit/AdjustmentPanel.css`:

```css
.rotation-controls {
  margin-bottom: var(--spacing-sm);
}

.rotation-controls__row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-sm);
}

.rotation-controls__btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  flex-shrink: 0;
  transition: all var(--transition-fast);
}

.rotation-controls__btn:hover {
  background: var(--color-accent);
  color: white;
  border-color: var(--color-accent);
}

.rotation-controls__slider-group {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
}

.rotation-controls__slider {
  flex: 1;
  min-width: 0;
}

.rotation-controls__input {
  width: 52px;
  padding: 2px 4px;
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  text-align: right;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  flex-shrink: 0;
}

.rotation-controls__input:focus {
  border-color: var(--color-border-focus);
  outline: none;
}

/* Hide number input spinners */
.rotation-controls__input::-webkit-outer-spin-button,
.rotation-controls__input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.straighten-btn {
  width: 100%;
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-sm);
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  transition: all var(--transition-fast);
}

.straighten-btn:hover {
  color: var(--color-text-primary);
  border-color: var(--color-text-secondary);
}

.straighten-btn--active {
  background: var(--color-accent);
  color: white;
  border-color: var(--color-accent);
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc -b`
Expected: No errors.

- [ ] **Step 6: Manual test — rotation UI**

Open `http://localhost:5173`, load a RAW image, switch to Crop tool.
- Verify 90° CW/CCW buttons rotate the image (canvas should resize for portrait/landscape swap).
- Verify the fine rotation slider works and the number input stays synced.
- Verify double-clicking the slider resets to 0.
- Verify "Reset Crop" resets both angle and quarterTurns.
- Verify undo/redo works after rotating.

- [ ] **Step 7: Commit**

```bash
git add src/components/edit/AdjustmentPanel.tsx src/components/edit/AdjustmentPanel.css src/stores/uiStore.ts
git commit -m "feat: add 90° rotation buttons and enhanced rotation slider UI"
```

---

## Chunk 3: Straighten Tool

### Task 5: Create StraightenOverlay component

**Files:**
- Create: `src/components/edit/StraightenOverlay.tsx`
- Create: `src/components/edit/StraightenOverlay.css`
- Modify: `src/components/edit/EditView.tsx` (add StraightenOverlay)

- [ ] **Step 1: Create `StraightenOverlay.tsx`**

Create `src/components/edit/StraightenOverlay.tsx`:

```tsx
import { useRef, useState, useCallback } from 'react'
import { useEditStore } from '../../stores/editStore'
import { useUIStore } from '../../stores/uiStore'
import './StraightenOverlay.css'

interface LinePoints {
  x1: number
  y1: number
  x2: number
  y2: number
}

function computeCorrection(line: LinePoints): number {
  const dx = line.x2 - line.x1
  const dy = -(line.y2 - line.y1) // negate for screen-space Y-down → math Y-up
  const lineAngle = Math.atan2(dy, dx) * (180 / Math.PI) // degrees

  let correction: number
  if (Math.abs(lineAngle) <= 45) {
    // More horizontal → rotate to make horizontal
    correction = -lineAngle
  } else {
    // More vertical → rotate to make vertical
    correction = -(lineAngle - Math.sign(lineAngle) * 90)
  }

  // Clamp to ±45°
  return Math.max(-45, Math.min(45, correction))
}

export function StraightenOverlay() {
  const straightenActive = useUIStore((s) => s.straightenActive)
  if (!straightenActive) return null
  return <StraightenOverlayInner />
}

function StraightenOverlayInner() {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [line, setLine] = useState<LinePoints | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [correction, setCorrection] = useState<number | null>(null)

  const crop = useEditStore((s) => s.params.crop)
  const setParam = useEditStore((s) => s.setParam)
  const commitSnapshot = useEditStore((s) => s.commitSnapshot)
  const setStraightenActive = useUIStore((s) => s.setStraightenActive)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (correction !== null) return // Already have a line, waiting for apply/cancel
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const rect = overlayRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setLine({ x1: x, y1: y, x2: x, y2: y })
    setDrawing(true)
    setCorrection(null)
  }, [correction])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!drawing || !overlayRef.current) return
    const rect = overlayRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setLine((prev) => prev ? { ...prev, x2: x, y2: y } : null)
  }, [drawing])

  const handlePointerUp = useCallback(() => {
    if (!drawing || !line) return
    setDrawing(false)
    // Only show apply/cancel if line is long enough (at least 20px)
    const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1)
    if (len < 20) {
      setLine(null)
      return
    }
    setCorrection(computeCorrection(line))
  }, [drawing, line])

  const handleApply = useCallback(() => {
    if (correction === null) return
    const newAngle = Math.max(-45, Math.min(45, crop.angle + correction))
    setParam('crop', { ...crop, angle: newAngle })
    commitSnapshot()
    setLine(null)
    setCorrection(null)
    setStraightenActive(false)
  }, [correction, crop, setParam, commitSnapshot, setStraightenActive])

  const handleCancel = useCallback(() => {
    setLine(null)
    setCorrection(null)
    setStraightenActive(false)
  }, [setStraightenActive])

  return (
    <div
      className="straighten-overlay"
      ref={overlayRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {line && (
        <svg className="straighten-overlay__svg">
          <line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="#ff6b35"
            strokeWidth={2}
            strokeDasharray="6 3"
          />
          {/* End markers */}
          <circle cx={line.x1} cy={line.y1} r={4} fill="#ff6b35" />
          <circle cx={line.x2} cy={line.y2} r={4} fill="#ff6b35" />
        </svg>
      )}
      {correction !== null && (
        <div className="straighten-overlay__actions">
          <span className="straighten-overlay__label">
            {correction >= 0 ? '+' : ''}{correction.toFixed(1)}°
          </span>
          <button className="straighten-overlay__btn straighten-overlay__btn--apply" onClick={handleApply}>
            Apply
          </button>
          <button className="straighten-overlay__btn straighten-overlay__btn--cancel" onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create `StraightenOverlay.css`**

Create `src/components/edit/StraightenOverlay.css`:

```css
.straighten-overlay {
  position: absolute;
  inset: 0;
  z-index: var(--z-crop-overlay);
  cursor: crosshair;
}

.straighten-overlay__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.straighten-overlay__actions {
  position: absolute;
  top: var(--spacing-md);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: rgba(0, 0, 0, 0.8);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-md);
  pointer-events: auto;
}

.straighten-overlay__label {
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  color: #ff6b35;
  min-width: 48px;
  text-align: center;
}

.straighten-overlay__btn {
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-sm);
  font-weight: 600;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.straighten-overlay__btn--apply {
  background: var(--color-accent);
  color: white;
}

.straighten-overlay__btn--apply:hover {
  background: var(--color-accent-hover);
}

.straighten-overlay__btn--cancel {
  background: var(--color-bg-input);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.straighten-overlay__btn--cancel:hover {
  color: var(--color-text-primary);
}
```

- [ ] **Step 3: Add StraightenOverlay to EditView**

In `src/components/edit/EditView.tsx`, import and render `StraightenOverlay` as a sibling to `CropOverlay`:

```tsx
import { StraightenOverlay } from './StraightenOverlay'
```

And in the JSX, after `<CropOverlay />`:

```tsx
<div className="edit-view__canvas-area">
  <CanvasViewport rendererRef={rendererRef} />
  <CropOverlay />
  <StraightenOverlay />
</div>
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc -b`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/edit/StraightenOverlay.tsx src/components/edit/StraightenOverlay.css src/components/edit/EditView.tsx
git commit -m "feat: add straighten tool overlay with line drawing and angle calculation"
```

---

### Task 6: Fix export dimensions for rotated images

When `quarterTurns` is odd, the exported image has swapped width/height. Both `exportFullRes` and `ExportPanel` need updating.

**Files:**
- Modify: `src/renderer/WebGLRenderer.ts` (`exportFullRes` method)
- Modify: `src/components/edit/ExportPanel.tsx:66-74` (encode worker dimensions)

- [ ] **Step 1: Update `exportFullRes` to use effective dimensions**

In `src/renderer/WebGLRenderer.ts`, update `exportFullRes`:

```typescript
exportFullRes(params: EditParams): { pixels: Float32Array; width: number; height: number } {
  const gl = this.gl
  if (!this.sourceTexture) throw new Error('No image loaded')

  const qt = params.crop.quarterTurns ?? 0
  const w = this.fullWidth
  const h = this.fullHeight
  // Output dimensions may be swapped for odd quarterTurns
  const outW = qt % 2 === 1 ? h : w
  const outH = qt % 2 === 1 ? w : h

  // Allocate full-res FBOs at output dimensions
  const geoFBO = createFramebuffer(gl, outW, outH)
  const adjFBO = createFramebuffer(gl, outW, outH)

  const prevGeo = this.geometryFBO
  const prevAdj = this.adjustmentFBO
  this.geometryFBO = geoFBO
  this.adjustmentFBO = adjFBO

  this.renderPipeline(this.sourceTexture, outW, outH, params)

  const pixels = new Float32Array(outW * outH * 4)
  gl.bindFramebuffer(gl.FRAMEBUFFER, adjFBO.fbo)
  gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.FLOAT, pixels)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  gl.deleteFramebuffer(geoFBO.fbo)
  gl.deleteTexture(geoFBO.texture)
  gl.deleteFramebuffer(adjFBO.fbo)
  gl.deleteTexture(adjFBO.texture)

  this.geometryFBO = prevGeo
  this.adjustmentFBO = prevAdj

  // Convert RGBA to RGB and flip vertically
  const rgb = new Float32Array(outW * outH * 3)
  for (let row = 0; row < outH; row++) {
    const srcRow = outH - 1 - row
    for (let col = 0; col < outW; col++) {
      const si = (srcRow * outW + col) * 4
      const di = (row * outW + col) * 3
      rgb[di] = pixels[si]
      rgb[di + 1] = pixels[si + 1]
      rgb[di + 2] = pixels[si + 2]
    }
  }

  return { pixels: rgb, width: outW, height: outH }
}
```

Note the return type change: now returns `{ pixels, width, height }` instead of just `Float32Array`, so the caller knows the actual output dimensions.

- [ ] **Step 2: Update `ExportPanel` to use returned dimensions**

In `src/components/edit/ExportPanel.tsx`, update the export handler to use the new return type:

```typescript
// Change this line:
const pixels = rendererRef.current.exportFullRes(params)

// To:
const { pixels, width: exportW, height: exportH } = rendererRef.current.exportFullRes(params)
```

And update the encode worker message to use the returned dimensions:

```typescript
encodeWorker!.postMessage({
  type: 'ENCODE',
  id,
  pixels: transferBuffer,
  width: exportW,
  height: exportH,
  format,
  quality: quality / 100,
}, [transferBuffer])
```

Also remove the early return check for `currentEntry.width/height` since we no longer rely on it for export dimensions (the renderer knows them).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc -b`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/WebGLRenderer.ts src/components/edit/ExportPanel.tsx
git commit -m "fix: use correct dimensions for rotated image export"
```

---

### Task 7: End-to-end manual test and fix crop mode rotation visibility

**Files:**
- Modify: `src/renderer/WebGLRenderer.ts:235-246` (if crop-mode rotation visibility needs fixing)

- [ ] **Step 1: Full manual test**

Open `http://localhost:5173`, load a RAW image, switch to Crop tool.

Test these scenarios:
1. **90° rotation**: Click ↷ button. Image should rotate CW 90° and canvas should resize (landscape→portrait or vice versa). Click again for 180°, 270°, 360° (back to original). Click ↶ for CCW.
2. **Fine rotation slider**: Drag slider. Image should rotate smoothly. Number input should update in sync. Type a number — slider should match.
3. **Slider double-click**: Double-click slider resets angle to 0.
4. **Straighten**: Click "Straighten" button (should highlight). Draw a line across something that should be level (e.g. a horizon). Release mouse. Apply/Cancel should appear with the computed angle. Click "Apply" — image should rotate to straighten the line.
5. **Straighten cancel**: Draw a line, click Cancel. No rotation should be applied.
6. **Reset crop**: Click "Reset Crop". All rotation (quarterTurns and angle) should reset.
7. **Undo/redo**: After any rotation, Cmd+Z should undo, Cmd+Shift+Z should redo.
8. **Export**: After rotating, export the image. The export should include the rotation.
9. **Persistence**: After rotating, navigate away and back. The rotation should be preserved.

- [ ] **Step 2: Fix any issues found during testing**

Address any bugs discovered. Common issues to watch for:
- Crop overlay position not matching after 90° rotation (crop resets to full image, so should be fine)
- Fine rotation not visible in crop mode (check `u_rotation` uniform is always passed, not gated on `applyCrop`)
- Canvas not resizing when `quarterTurns` changes (check `fitCanvas` dependency array)

- [ ] **Step 3: Verify TypeScript compiles cleanly**

Run: `npx tsc -b`
Expected: No errors.

- [ ] **Step 4: Final commit**

```bash
git add -u
git commit -m "fix: address issues from end-to-end rotation/straighten testing"
```

(Only if there are changes to commit from step 2.)
