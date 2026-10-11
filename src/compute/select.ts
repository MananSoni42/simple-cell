import { type ForceBackend, serialBackend } from '../core/backend'
import type { World } from '../core/world'
import { GpuBackend, gpuAvailable } from './gpu'
import { ParallelBackend } from './parallel'

export interface Perf {
  threads: number
  gpu: boolean
}

export const MAX_THREADS = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1
export const canShare = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
export { gpuAvailable }

/** Picks the requested backend, falling back to serial (with a reason) when it can't be had. */
export async function makeBackend(w: World, perf: Perf): Promise<{ backend: ForceBackend; note: string }> {
  if (perf.gpu) {
    try {
      return { backend: await GpuBackend.create(w), note: '' }
    } catch (e) {
      return { backend: serialBackend, note: `GPU unavailable (${(e as Error).message}); running serial` }
    }
  }
  if (perf.threads > 1) {
    try {
      return { backend: new ParallelBackend(w, perf.threads), note: '' }
    } catch (e) {
      return { backend: serialBackend, note: `threads unavailable (${(e as Error).message}); running serial` }
    }
  }
  return { backend: serialBackend, note: '' }
}
