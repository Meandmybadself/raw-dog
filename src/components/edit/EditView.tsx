import { useRef } from 'react'
import { useFileStore } from '../../stores/fileStore'
import { useUIStore } from '../../stores/uiStore'
import type { WebGLRenderer } from '../../renderer/WebGLRenderer'
import { CanvasViewport } from './CanvasViewport'
import { AdjustmentPanel } from './AdjustmentPanel'
import { Histogram } from './Histogram'
import { ExportPanel } from './ExportPanel'
import { CropOverlay } from './CropOverlay'
import { StraightenOverlay } from './StraightenOverlay'
import './EditView.css'

export function EditView() {
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const currentFileId = useFileStore((s) => s.currentFileId)
  const catalog = useFileStore((s) => s.catalog)
  const currentEntry = currentFileId ? catalog[currentFileId] : null
  const isProcessing = useUIStore((s) => s.decodeProgress) !== null || useUIStore((s) => s.exportProgress) !== null

  return (
    <div className={`edit-view ${isProcessing ? 'edit-view--processing' : ''}`}>
      <div className="edit-view__topbar">
        <span className="edit-view__filename">{currentEntry?.originalName ?? ''}</span>
        <ExportPanel rendererRef={rendererRef} />
      </div>
      <div className="edit-view__main">
        <div className="edit-view__canvas-area">
          <CanvasViewport rendererRef={rendererRef} />
          <CropOverlay />
          <StraightenOverlay />
        </div>
        <div className="edit-view__sidebar">
          <Histogram rendererRef={rendererRef} />
          <AdjustmentPanel rendererRef={rendererRef} />
        </div>
      </div>
    </div>
  )
}
