import { computeForcesRange } from './forcekernel'
import type { World } from './world'

/**
 * Where the pair forces are computed. Everything else in a tick is cheap (linear in
 * particles or organisms) and stays on the main thread; forces dominate large worlds.
 * `compute` may return a promise, in which case the world must be advanced with stepAsync().
 */
export interface ForceBackend {
  readonly name: string
  compute(w: World): void | Promise<void>
  dispose?(): void
}

export const serialBackend: ForceBackend = {
  name: 'serial',
  compute(w) {
    computeForcesRange(0, w.grid.count, w.kernelArrays, w.kernelParams)
  },
}
