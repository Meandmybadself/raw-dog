import { useState, useCallback } from 'react'
import { saveAs } from 'file-saver'
import { useEditStore } from '../../stores/editStore'
import { useFileStore } from '../../stores/fileStore'
import { useUIStore } from '../../stores/uiStore'
import type { WebGLRenderer } from '../../renderer/WebGLRenderer'
import './ExportPanel.css'

interface ExportPanelProps {
  rendererRef: React.MutableRefObject<WebGLRenderer | null>
}

export function ExportPanel({ rendererRef }: ExportPanelProps) {
  const isOpen = useUIStore((s) => s.isExportPanelOpen)
  const toggleExportPanel = useUIStore((s) => s.toggleExportPanel)
  const exportProgress = useUIStore((s) => s.exportProgress)
  const setExportProgress = useUIStore((s) => s.setExportProgress)
  const setError = useUIStore((s) => s.setError)
  const params = useEditStore((s) => s.params)
  const currentFileId = useFileStore((s) => s.currentFileId)
  const catalog = useFileStore((s) => s.catalog)

  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [quality, setQuality] = useState(92)

  const currentEntry = currentFileId ? catalog[currentFileId] : null
  const baseName = currentEntry?.originalName.replace(/\.[^.]+$/, '') ?? 'export'

  const handleExport = useCallback(async () => {
    if (!rendererRef.current) return

    if (!currentEntry?.width || !currentEntry?.height) {
      setError('Image dimensions not available yet. Please wait for decoding to complete.')
      return
    }

    let encodeWorker: Worker | null = null
    try {
      setExportProgress({ phase: 'Rendering full resolution...', percent: 20 })

      const { pixels, width: exportW, height: exportH } = rendererRef.current.exportFullRes(params)

      setExportProgress({ phase: 'Encoding...', percent: 60 })

      encodeWorker = new Worker(
        new URL('../../workers/encode.worker.ts', import.meta.url),
        { type: 'module' },
      )

      const id = `export_${Date.now()}`
      const transferBuffer = pixels.buffer.slice(0)

      const blob = await new Promise<Blob>((resolve, reject) => {
        encodeWorker!.onmessage = (e) => {
          const msg = e.data
          if (msg.id !== id) return
          if (msg.type === 'ENCODE_SUCCESS') {
            resolve(msg.blob)
          } else if (msg.type === 'ENCODE_ERROR') {
            reject(new Error(msg.message))
          } else if (msg.type === 'ENCODE_PROGRESS') {
            setExportProgress({ phase: msg.phase, percent: 60 + msg.percent * 0.4 })
          }
        }

        encodeWorker!.postMessage({
          type: 'ENCODE',
          id,
          pixels: transferBuffer,
          width: exportW,
          height: exportH,
          format,
          quality: quality / 100,
        }, [transferBuffer])
      })

      setExportProgress(null)

      const ext = format === 'jpeg' ? 'jpg' : 'png'
      saveAs(blob, `${baseName}.${ext}`)
    } catch (err) {
      setError(`Export failed: ${err instanceof Error ? err.message : 'Unknown'}`)
      setExportProgress(null)
    } finally {
      encodeWorker?.terminate()
    }
  }, [rendererRef, params, format, quality, currentEntry, baseName, setExportProgress, setError])

  return (
    <>
      <button className="export-trigger" onClick={toggleExportPanel}>
        Export
      </button>

      {isOpen && (
        <div className="export-panel">
          <div className="export-panel__backdrop" onClick={toggleExportPanel} />
          <div className="export-panel__content">
            <h3 className="export-panel__title">Export Image</h3>

            <div className="export-panel__field">
              <label>Format</label>
              <div className="export-panel__format-btns">
                <button
                  className={`format-btn ${format === 'jpeg' ? 'format-btn--active' : ''}`}
                  onClick={() => setFormat('jpeg')}
                >
                  JPEG
                </button>
                <button
                  className={`format-btn ${format === 'png' ? 'format-btn--active' : ''}`}
                  onClick={() => setFormat('png')}
                >
                  PNG
                </button>
              </div>
            </div>

            {format === 'jpeg' && (
              <div className="export-panel__field">
                <label>Quality: {quality}%</label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={quality}
                  onInput={(e) => setQuality(parseInt((e.target as HTMLInputElement).value))}
                />
              </div>
            )}

            <div className="export-panel__actions">
              <button
                className="export-panel__btn export-panel__btn--cancel"
                onClick={toggleExportPanel}
                disabled={!!exportProgress}
              >
                Cancel
              </button>
              <button
                className="export-panel__btn"
                onClick={handleExport}
                disabled={!!exportProgress}
              >
                {exportProgress ? `${exportProgress.phase} ${Math.round(exportProgress.percent)}%` : 'Export'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
