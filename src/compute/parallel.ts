import type { ForceBackend } from '../core/backend'
import { computeForcesRange } from '../core/forcekernel'
import type { World } from '../core/world'

/**
 * Splits the particle range across Web Workers that share the world's memory.
 * The main thread computes one slice itself while the workers do the rest.
 * Needs a world built with `shared: true` and a cross-origin-isolated page.
 */
export class ParallelBackend implements ForceBackend {
  readonly name: string
  private workers: Worker[] = []

  constructor(w: World, threads: number) {
    if (!(w.x.buffer instanceof SharedArrayBuffer)) throw new Error('world memory is not shared')
    this.name = `${threads} threads`
    for (let t = 0; t < threads - 1; t++) {
      const wk = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      wk.postMessage({ kind: 'init', arrays: w.kernelArrays, params: w.kernelParams })
      this.workers.push(wk)
    }
  }

  compute(w: World): Promise<void> {
    const parts = this.workers.length + 1
    const n = w.grid.count
    const chunk = Math.ceil(n / parts)
    const pending = this.workers.map(
      (wk, t) =>
        new Promise<void>((resolve) => {
          wk.onmessage = () => resolve()
          wk.postMessage({ kind: 'run', lo: (t + 1) * chunk, hi: Math.min(n, (t + 2) * chunk) })
        }),
    )
    computeForcesRange(0, Math.min(n, chunk), w.kernelArrays, w.kernelParams)
    return Promise.all(pending).then(() => undefined)
  }

  dispose(): void {
    for (const wk of this.workers) wk.terminate()
    this.workers = []
  }
}
