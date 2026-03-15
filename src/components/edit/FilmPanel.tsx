import { useCallback, useEffect, useRef } from 'react'
import { useEditStore } from '../../stores/editStore'
import { FILM_PRESETS } from '../../lib/constants'
import type { WebGLRenderer } from '../../renderer/WebGLRenderer'
import type { FilmPreset } from '../../types'
import './FilmPanel.css'

interface FilmPanelProps {
  rendererRef: React.MutableRefObject<WebGLRenderer | null>
}

export function FilmPanel({ rendererRef }: FilmPanelProps) {
  const film = useEditStore((s) => s.params.film)
  const setParam = useEditStore((s) => s.setParam)
  const commitSnapshot = useEditStore((s) => s.commitSnapshot)
  const loadingRef = useRef<string | null>(null)

  const activePresetId = film?.presetId ?? null
  const strength = film?.strength ?? 100

  // Load LUT texture when preset changes
  useEffect(() => {
    if (!rendererRef.current) return
    if (!activePresetId) {
      rendererRef.current.clearLut()
      return
    }
    const preset = FILM_PRESETS.find((p) => p.id === activePresetId)
    if (!preset) return
    if (loadingRef.current === activePresetId) return
    loadingRef.current = activePresetId
    rendererRef.current.loadLut(preset.id, preset.lutUrl).then(() => {
      loadingRef.current = null
    })
  }, [activePresetId, rendererRef])

  const selectPreset = useCallback((preset: FilmPreset) => {
    setParam('film', { presetId: preset.id, strength })
    commitSnapshot()
  }, [setParam, commitSnapshot, strength])

  const clearPreset = useCallback(() => {
    setParam('film', { presetId: null, strength: 100 })
    commitSnapshot()
  }, [setParam, commitSnapshot])

  // Group presets by category
  const categories = new Map<string, FilmPreset[]>()
  for (const preset of FILM_PRESETS) {
    if (!categories.has(preset.category)) {
      categories.set(preset.category, [])
    }
    categories.get(preset.category)!.push(preset)
  }

  return (
    <div className="film-panel">
      <div className="panel-section">
        <h3 className="panel-section__title">Film Simulation</h3>

        <button
          className={`film-panel__preset ${!activePresetId ? 'film-panel__preset--active' : ''}`}
          onClick={clearPreset}
        >
          None
        </button>

        {Array.from(categories.entries()).map(([category, presets]) => (
          <div key={category} className="film-panel__category">
            <div className="film-panel__category-name">{category}</div>
            {presets.map((preset) => (
              <button
                key={preset.id}
                className={`film-panel__preset ${activePresetId === preset.id ? 'film-panel__preset--active' : ''}`}
                onClick={() => selectPreset(preset)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        ))}
      </div>

      {activePresetId && (
        <div className="panel-section">
          <div className="slider">
            <div className="slider__header">
              <label className="slider__label">Strength</label>
              <div className="slider__header-right">
                <span className="slider__value">{Math.round(strength)}%</span>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={strength}
              onInput={(e) => {
                const v = parseInt((e.target as HTMLInputElement).value)
                setParam('film', { presetId: activePresetId, strength: v })
              }}
              onPointerUp={commitSnapshot}
              onDoubleClick={() => {
                setParam('film', { presetId: activePresetId, strength: 100 })
                commitSnapshot()
              }}
              aria-label="Film strength"
            />
          </div>
        </div>
      )}
    </div>
  )
}
