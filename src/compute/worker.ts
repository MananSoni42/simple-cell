import { type KernelArrays, type KernelParams, computeForcesRange } from '../core/forcekernel'

let arrays: KernelArrays
let params: KernelParams

self.onmessage = (e: MessageEvent) => {
  const m = e.data
  if (m.kind === 'init') {
    arrays = m.arrays
    params = m.params
  } else {
    computeForcesRange(m.lo, m.hi, arrays, params)
    self.postMessage(0)
  }
}
