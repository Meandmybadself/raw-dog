import { useRef, useCallback, useState, useEffect } from 'react'
import { useEditStore } from '../../stores/editStore'
import { useUIStore } from '../../stores/uiStore'
import type { CropRect } from '../../types'
import './CropOverlay.css'

type Handle = 'tl' | 'tr' | 'bl' | 'br' | 'move' | null

export function CropOverlay() {
  const activeTool = useUIStore((s) => s.activeTool)
  if (activeTool !== 'crop') return null
  return <CropOverlayInner />
}

function CropOverlayInner() {
  const crop = useEditStore((s) => s.params.crop)
  const setParam = useEditStore((s) => s.setParam)
  const commitSnapshot = useEditStore((s) => s.commitSnapshot)
  const setActiveTool = useUIStore((s) => s.setActiveTool)
  const setStraightenActive = useUIStore((s) => s.setStraightenActive)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [activeHandle, setActiveHandle] = useState<Handle>(null)
  const startPos = useRef({ x: 0, y: 0 })
  const startCrop = useRef<CropRect>(crop)

  // Enter key applies crop (switches to adjust mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        setStraightenActive(false)
        setActiveTool('adjust')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setActiveTool, setStraightenActive])

  const handlePointerDown = useCallback((e: React.PointerEvent, handle: Handle) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setActiveHandle(handle)
    startPos.current = { x: e.clientX, y: e.clientY }
    startCrop.current = { ...crop }
  }, [crop])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!activeHandle || !overlayRef.current) return
    const rect = overlayRef.current.getBoundingClientRect()
    const dx = (e.clientX - startPos.current.x) / rect.width
    const dy = (e.clientY - startPos.current.y) / rect.height
    const sc = startCrop.current

    const newCrop = { ...sc }

    if (activeHandle === 'move') {
      newCrop.x = Math.max(0, Math.min(1 - sc.width, sc.x + dx))
      newCrop.y = Math.max(0, Math.min(1 - sc.height, sc.y + dy))
    } else {
      if (activeHandle.includes('l')) {
        const newX = Math.max(0, Math.min(sc.x + sc.width - 0.05, sc.x + dx))
        newCrop.width = sc.width - (newX - sc.x)
        newCrop.x = newX
      }
      if (activeHandle.includes('r')) {
        newCrop.width = Math.max(0.05, Math.min(1 - sc.x, sc.width + dx))
      }
      if (activeHandle.includes('t')) {
        const newY = Math.max(0, Math.min(sc.y + sc.height - 0.05, sc.y + dy))
        newCrop.height = sc.height - (newY - sc.y)
        newCrop.y = newY
      }
      if (activeHandle.includes('b')) {
        newCrop.height = Math.max(0.05, Math.min(1 - sc.y, sc.height + dy))
      }
    }

    setParam('crop', { ...crop, ...newCrop })
  }, [activeHandle, crop, setParam])

  const handlePointerUp = useCallback(() => {
    if (activeHandle) {
      setActiveHandle(null)
      commitSnapshot()
    }
  }, [activeHandle, commitSnapshot])

  const style = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`,
  }

  return (
    <div
      className="crop-overlay"
      ref={overlayRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="crop-overlay__mask" />
      <div className="crop-overlay__region" style={style}>
        <div
          className="crop-overlay__move"
          onPointerDown={(e) => handlePointerDown(e, 'move')}
        />
        <div className="crop-overlay__grid">
          <div className="crop-overlay__grid-line crop-overlay__grid-line--h1" />
          <div className="crop-overlay__grid-line crop-overlay__grid-line--h2" />
          <div className="crop-overlay__grid-line crop-overlay__grid-line--v1" />
          <div className="crop-overlay__grid-line crop-overlay__grid-line--v2" />
        </div>
        {(['tl', 'tr', 'bl', 'br'] as const).map((h) => (
          <div
            key={h}
            className={`crop-overlay__handle crop-overlay__handle--${h}`}
            onPointerDown={(e) => handlePointerDown(e, h)}
          />
        ))}
      </div>
    </div>
  )
}
