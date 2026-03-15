import type { DecodeRequest, DecodeSuccessResponse, DecodeWorkerMessage } from '../types'

export class DecodePoolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'DecodePoolError'
  }
}

interface PendingDecode {
  resolve: (result: DecodeSuccessResponse) => void
  reject: (error: DecodePoolError) => void
  onProgress?: (phase: string, percent: number) => void
}

interface PoolWorker {
  worker: Worker
  busy: boolean
}

interface QueuedTask {
  request: DecodeRequest
  buffer: ArrayBuffer
  pending: PendingDecode
}

export class WorkerPool {
  private workers: PoolWorker[]
  private pending = new Map<string, PendingDecode>()
  private queue: QueuedTask[] = []
  private idCounter = 0

  constructor(concurrency?: number) {
    const cap = Math.min(concurrency ?? (navigator.hardwareConcurrency ?? 4), 8)
    this.workers = Array.from({ length: cap }, () => ({
      worker: this.createWorker(),
      busy: false,
    }))
  }

  private createWorker(): Worker {
    const worker = new Worker(
      new URL('./decode.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e) => this.handleMessage(e)
    return worker
  }

  decode(
    buffer: ArrayBuffer,
    halfSize = false,
    onProgress?: (phase: string, percent: number) => void,
  ): Promise<DecodeSuccessResponse> {
    const id = `decode_${++this.idCounter}_${Date.now()}`
    const request: DecodeRequest = { type: 'DECODE', id, buffer, halfSize }

    return new Promise((resolve, reject) => {
      const pending: PendingDecode = { resolve, reject, onProgress }
      this.pending.set(id, pending)

      const free = this.workers.find((w) => !w.busy)
      if (free) {
        free.busy = true
        free.worker.postMessage(request, [buffer])
      } else {
        this.queue.push({ request, buffer, pending })
      }
    })
  }

  private handleMessage(event: MessageEvent<DecodeWorkerMessage>): void {
    const msg = event.data
    const pending = this.pending.get(msg.id)
    if (!pending) return

    if (msg.type === 'DECODE_PROGRESS') {
      pending.onProgress?.(msg.phase, msg.percent)
      return
    }

    this.pending.delete(msg.id)
    this.markFree(event.target as Worker)

    if (msg.type === 'DECODE_SUCCESS') {
      pending.resolve(msg)
    } else {
      pending.reject(new DecodePoolError(msg.code, msg.message))
    }

    this.drainQueue()
  }

  private markFree(worker: Worker): void {
    const pw = this.workers.find((w) => w.worker === worker)
    if (pw) pw.busy = false
  }

  private drainQueue(): void {
    if (this.queue.length === 0) return
    const free = this.workers.find((w) => !w.busy)
    if (!free) return
    const task = this.queue.shift()!
    free.busy = true
    free.worker.postMessage(task.request, [task.buffer])
  }

  terminate(): void {
    for (const { worker } of this.workers) worker.terminate()
    this.pending.clear()
    this.queue.length = 0
  }
}

export const decodePool = new WorkerPool()
