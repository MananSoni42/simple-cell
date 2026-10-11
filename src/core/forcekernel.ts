import { BRAIN, FOOD, MATRIX_INDEX, N_MATRIX } from './types'

/** Everything the pair-force kernel reads or writes. Plain typed arrays, so they can live in shared memory. */
export interface KernelArrays {
  x: Float64Array
  y: Float64Array
  fx: Float64Array
  fy: Float64Array
  type: Uint8Array
  owner: Int32Array
  alive: Uint8Array
  foodNear: Float32Array
  cellStart: Int32Array
  cellItems: Int32Array
  cellOf: Int32Array
  A: Float64Array
}

export interface KernelParams {
  SIZE: number
  r_c: number
  beta: number
  K_core: number
  nc: number
}

/**
 * Net pair force on every particle in [lo, hi). Each particle sums over all of its
 * neighbours (no Newton's-third-law shortcut), so ranges are independent and can run
 * on different threads, or be ported to a GPU, without any write conflicts.
 */
export function computeForcesRange(lo: number, hi: number, a: KernelArrays, p: KernelParams): void {
  const { x, y, fx, fy, type, owner, alive, foodNear, cellStart, cellItems, cellOf, A } = a
  const { SIZE: S, r_c: rc, beta, K_core: K, nc } = p
  const rc2 = rc * rc
  for (let i = lo; i < hi; i++) {
    fx[i] = 0
    fy[i] = 0
    foodNear[i] = 0
    if (!alive[i]) continue
    const xi = x[i]
    const yi = y[i]
    const ti = type[i]
    const mi = MATRIX_INDEX[ti]
    const oi = owner[i]
    const c = cellOf[i]
    const cx = c % nc
    const cy = (c - cx) / nc
    let sx = 0
    let sy = 0
    let near = 0
    for (let dy = -1; dy <= 1; dy++) {
      const row = ((cy + dy + nc) % nc) * nc
      for (let dx = -1; dx <= 1; dx++) {
        const cc = row + ((cx + dx + nc) % nc)
        for (let k = cellStart[cc]; k < cellStart[cc + 1]; k++) {
          const j = cellItems[k]
          if (j === i) continue
          const tj = type[j]
          if (oi >= 0 && oi === owner[j] && (ti === BRAIN || tj === BRAIN)) continue
          let ddx = x[j] - xi
          let ddy = y[j] - yi
          ddx -= S * Math.round(ddx / S)
          ddy -= S * Math.round(ddy / S)
          const r2 = ddx * ddx + ddy * ddy
          if (r2 >= rc2 || r2 < 1e-18) continue
          const r = Math.sqrt(r2)
          const mj = MATRIX_INDEX[tj]
          const u = r / rc
          let f: number
          if (u < beta) f = K * (u / beta - 1)
          else f = (mi >= 0 && mj >= 0 ? A[mi * N_MATRIX + mj] : 0) * (1 - Math.abs(2 * u - 1 - beta) / (1 - beta))
          f /= r
          sx += f * ddx
          sy += f * ddy
          if (tj === FOOD) near++
        }
      }
    }
    fx[i] = sx
    fy[i] = sy
    foodNear[i] = near
  }
}
