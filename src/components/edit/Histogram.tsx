import { useEffect, useRef, useState } from 'react'
import type { WebGLRenderer, HistogramData } from '../../renderer/WebGLRenderer'
import { useEditStore } from '../../stores/editStore'
import { useUIStore } from '../../stores/uiStore'
import './Histogram.css'

interface HistogramProps {
  rendererRef: React.MutableRefObject<WebGLRenderer | null>
}

export function Histogram({ rendererRef }: HistogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isVisible = useUIStore((s) => s.isHistogramVisible)
  const toggleHistogram = useUIStore((s) => s.toggleHistogram)
  const [data, setData] = useState<HistogramData | null>(null)
  const params = useEditStore((s) => s.params)

  // Update histogram after params change (debounced)
  useEffect(() => {
    if (!isVisible || !rendererRef.current) return
    const timer = setTimeout(() => {
      const hist = rendererRef.current?.getHistogram()
      if (hist) setData(hist)
    }, 100)
    return () => clearTimeout(timer)
  }, [params, isVisible, rendererRef])

  // Draw histogram
  useEffect(() => {
    if (!data || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')!
    const w = canvas.width
    const h = canvas.height

    ctx.clearRect(0, 0, w, h)

    const maxVal = Math.max(
      ...Array.from(data.r).slice(1, -1),
      ...Array.from(data.g).slice(1, -1),
      ...Array.from(data.b).slice(1, -1),
      1,
    )

    const drawChannel = (bins: Uint32Array, color: string) => {
      ctx.beginPath()
      ctx.moveTo(0, h)
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * w
        const y = h - (bins[i] / maxVal) * h
        ctx.lineTo(x, y)
      }
      ctx.lineTo(w, h)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }

    ctx.globalCompositeOperation = 'screen'
    drawChannel(data.r, 'rgba(255, 80, 80, 0.5)')
    drawChannel(data.g, 'rgba(80, 255, 80, 0.5)')
    drawChannel(data.b, 'rgba(80, 80, 255, 0.5)')
    ctx.globalCompositeOperation = 'source-over'
  }, [data])

  if (!isVisible) {
    return (
      <button className="histogram-toggle" onClick={toggleHistogram}>
        Show Histogram
      </button>
    )
  }

  return (
    <div className="histogram" onClick={toggleHistogram}>
      <canvas ref={canvasRef} width={256} height={80} className="histogram__canvas" />
    </div>
  )
}
