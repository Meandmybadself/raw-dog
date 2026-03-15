import { useEditStore } from '../../stores/editStore'
import { useUIStore } from '../../stores/uiStore'
import { EXPOSURE_SLIDERS, COLOR_SLIDERS, WB_PRESETS } from '../../lib/constants'
import { Slider } from '../common/Slider'
import type { SliderConfig } from '../../types'
import './AdjustmentPanel.css'

function SliderGroup({ sliders }: { sliders: SliderConfig[] }) {
  const params = useEditStore((s) => s.params)
  const setParam = useEditStore((s) => s.setParam)
  const commitSnapshot = useEditStore((s) => s.commitSnapshot)

  return (
    <>
      {sliders.map((config) => (
        <Slider
          key={config.key}
          config={config}
          value={params[config.key] as number}
          onChange={(v) => setParam(config.key, v)}
          onCommit={commitSnapshot}
        />
      ))}
    </>
  )
}

function WhiteBalancePresets() {
  const setParams = useEditStore((s) => s.setParams)
  const commitSnapshot = useEditStore((s) => s.commitSnapshot)

  return (
    <div className="wb-presets">
      {WB_PRESETS.map((preset) => (
        <button
          key={preset.label}
          className="wb-presets__btn"
          onClick={() => {
            setParams({ temperature: preset.temperature, tint: preset.tint })
            commitSnapshot()
          }}
        >
          {preset.label}
        </button>
      ))}
    </div>
  )
}

export function AdjustmentPanel() {
  const activeTool = useUIStore((s) => s.activeTool)
  const setActiveTool = useUIStore((s) => s.setActiveTool)
  const setStraightenActive = useUIStore((s) => s.setStraightenActive)
  const resetToDefaults = useEditStore((s) => s.resetToDefaults)

  return (
    <aside className="adjustment-panel">
      <div className="adjustment-panel__tools">
        <button
          className={`tool-btn ${activeTool === 'adjust' ? 'tool-btn--active' : ''}`}
          onClick={() => { setStraightenActive(false); setActiveTool('adjust') }}
        >
          Adjust
        </button>
        <button
          className={`tool-btn ${activeTool === 'crop' ? 'tool-btn--active' : ''}`}
          onClick={() => setActiveTool('crop')}
        >
          Crop
        </button>
      </div>

      {activeTool === 'adjust' && (
        <div className="adjustment-panel__sliders">
          <div className="panel-section">
            <h3 className="panel-section__title">Light</h3>
            <SliderGroup sliders={EXPOSURE_SLIDERS} />
          </div>

          <div className="panel-section">
            <h3 className="panel-section__title">Color</h3>
            <WhiteBalancePresets />
            <SliderGroup sliders={COLOR_SLIDERS} />
          </div>

          <div className="panel-section">
            <button className="reset-btn" onClick={resetToDefaults}>
              Reset All
            </button>
          </div>
        </div>
      )}

      {activeTool === 'crop' && (
        <div className="adjustment-panel__crop">
          <CropControls />
        </div>
      )}
    </aside>
  )
}

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
              onKeyDown={(e) => { if (e.key === 'Enter') { commitSnapshot(); (e.target as HTMLInputElement).blur() } }}
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
