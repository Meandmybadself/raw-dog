import { useEffect, useRef, useCallback, useState } from 'react'
import { WebGLRenderer } from '../../renderer/WebGLRenderer'
import { useEditStore } from '../../stores/editStore'
import { useFileStore } from '../../stores/fileStore'
import { useUIStore } from '../../stores/uiStore'
import { opfsManager } from '../../lib/opfs/OPFSManager'
import { decodePool } from '../../workers/WorkerPool'
import { DEFAULT_EDIT_PARAMS } from '../../types'
import './CanvasViewport.css'

interface CanvasViewportProps {
  rendererRef: React.MutableRefObject<WebGLRenderer | null>
}

export function CanvasViewport({ rendererRef }: CanvasViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const currentFileId = useFileStore((s) => s.currentFileId)
  const updateEntry = useFileStore((s) => s.updateEntry)
  const params = useEditStore((s) => s.params)
  const showOriginal = useEditStore((s) => s.showOriginal)
  const activeTool = useUIStore((s) => s.activeTool)
  const setDecodeProgress = useUIStore((s) => s.setDecodeProgress)
  const setError = useUIStore((s) => s.setError)

  // Track image dimensions for aspect ratio
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null)

  // Initialize renderer
  useEffect(() => {
    if (!canvasRef.current) return
    try {
      const renderer = new WebGLRenderer(canvasRef.current)
      rendererRef.current = renderer
      return () => {
        renderer.dispose()
        rendererRef.current = null
      }
    } catch (err) {
      setError(`WebGL2 init failed: ${err instanceof Error ? err.message : 'Unknown'}`)
    }
  }, [rendererRef, setError])

  // Load image when file changes
  useEffect(() => {
    if (!currentFileId || !rendererRef.current) return

    let cancelled = false
    const loadImage = async () => {
      try {
        setDecodeProgress({ phase: 'Reading file...', percent: 5 })
        const rawBuffer = await opfsManager.readRaw(currentFileId)

        setDecodeProgress({ phase: 'Decoding RAW...', percent: 15 })
        const result = await decodePool.decode(
          rawBuffer,
          false,
          (phase, percent) => {
            if (phase !== 'done') setDecodeProgress({ phase, percent })
          },
        )

        if (cancelled) return

        setDecodeProgress(null)
        const pixels = new Float32Array(result.pixels)
        rendererRef.current?.loadImage(pixels, result.width, result.height)
        updateEntry(currentFileId, { width: result.width, height: result.height })
        setImageDims({ w: result.width, h: result.height })
      } catch (err) {
        if (!cancelled) {
          setError(`Decode failed: ${err instanceof Error ? err.message : 'Unknown'}`)
          setDecodeProgress(null)
        }
      }
    }

    loadImage()
    return () => { cancelled = true }
  }, [currentFileId, rendererRef, setDecodeProgress, setError, updateEntry])

  // Update renderer when params change
  useEffect(() => {
    if (!rendererRef.current) return
    rendererRef.current.setParams(showOriginal ? { ...DEFAULT_EDIT_PARAMS } : params)
  }, [params, showOriginal, rendererRef])

  // Sync crop mode — show full image when crop tool is active
  useEffect(() => {
    if (!rendererRef.current) return
    rendererRef.current.cropMode = activeTool === 'crop'
  }, [activeTool, rendererRef])

  // Fit canvas to container while preserving aspect ratio
  const fitCanvas = useCallback(() => {
    if (!containerRef.current || !canvasRef.current || !rendererRef.current || !imageDims) return

    const container = containerRef.current.getBoundingClientRect()
    const imgAspect = imageDims.w / imageDims.h
    const containerAspect = container.width / container.height

    let displayW: number
    let displayH: number

    if (imgAspect > containerAspect) {
      // Image is wider than container — fit to width
      displayW = container.width
      displayH = container.width / imgAspect
    } else {
      // Image is taller than container — fit to height
      displayH = container.height
      displayW = container.height * imgAspect
    }

    const dpr = Math.min(window.devicePixelRatio, 2)
    canvasRef.current.style.width = `${Math.round(displayW)}px`
    canvasRef.current.style.height = `${Math.round(displayH)}px`
    rendererRef.current.resize(Math.round(displayW * dpr), Math.round(displayH * dpr))
  }, [rendererRef, imageDims])

  // Re-fit on container resize or when image dimensions change
  useEffect(() => {
    fitCanvas()
    if (!containerRef.current) return
    const observer = new ResizeObserver(fitCanvas)
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [fitCanvas])

  const decodeProgress = useUIStore((s) => s.decodeProgress)
  const isLoading = decodeProgress !== null

  return (
    <div className="canvas-viewport" ref={containerRef}>
      <canvas ref={canvasRef} className="canvas-viewport__canvas" />
      {isLoading && (
        <div className="canvas-viewport__loader">
          <div className="canvas-viewport__spinner" />
          <span className="canvas-viewport__loader-text">{decodeProgress.phase}</span>
        </div>
      )}
      {showOriginal && <div className="canvas-viewport__badge">Original</div>}
    </div>
  )
}
