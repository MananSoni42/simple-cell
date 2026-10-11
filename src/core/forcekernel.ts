import { BRAIN, FOOD, MATRIX_INDEX, N_MATRIX } from './types'

/**
 * Everything the pair-force kernel reads or writes. The `p*` arrays hold the live
 * particles packed in cell order (built by `Grid.build`), so the neighbour scan reads
 * memory sequentially. Plain typed arrays, so they can live in shared memory.
 */
export interface KernelArrays {
  px: Float64Array
  py: Float64Array
  ptype: Uint8Array
  powner: Int32Array
  pcell: Int32Array
  items: Int32Array // packed slot -> particle index
  cellStart: Int32Array
  fx: Float64Array // outputs, indexed by particle
  fy: Float64Array
  foodNear: Float32Array
  A: Float64Array
}

export interface KernelParams {
  SIZE: number
  r_c: number
  K_core: number
  r_0: number // exclusion radius for ordinary pairs
  r_brain_core: number // ... when one of the pair is a brain
  r_brain: number // ... when both are
  K_brain: number
  nc: number
  /** Skip food as a target: its force is never used while food is static. */
  skipFood: boolean
}

const MIDX = Int8Array.from(MATRIX_INDEX)

/**
 * Net pair force on the packed particles in slots [lo, hi). Each particle sums over all
 * of its neighbours (no Newton's-third-law shortcut), so ranges are independent and can
 * run on different threads without write conflicts. Slots are dense (live particles only),
 * so equal-sized ranges carry equal work.
 */
export function computeForcesRange(lo: number, hi: number, a: KernelArrays, p: KernelParams): void {
  const { px, py, ptype, powner, pcell, items, cellStart, fx, fy, foodNear, A } = a
  const { SIZE: S, r_c: rc, K_core: K, r_0, r_brain_core, r_brain, K_brain, nc, skipFood } = p
  const rc2 = rc * rc
  const half = S / 2
  for (let k0 = lo; k0 < hi; k0++) {
    const ti = ptype[k0]
    if (skipFood && ti === FOOD) continue
    const xi = px[k0]
    const yi = py[k0]
    const mi = MIDX[ti]
    const oi = powner[k0]
    const iAmBrain = ti === BRAIN
    const c = pcell[k0]
    const cx = c % nc
    const cy = (c - cx) / nc
    let sx = 0
    let sy = 0
    let near = 0
    for (let dy = -1; dy <= 1; dy++) {
      const row = ((cy + dy + nc) % nc) * nc
      for (let dx = -1; dx <= 1; dx++) {
        const cc = row + ((cx + dx + nc) % nc)
        for (let k = cellStart[cc], e = cellStart[cc + 1]; k < e; k++) {
          if (k === k0) continue
          const tj = ptype[k]
          const jIsBrain = tj === BRAIN
          if (oi >= 0 && oi === powner[k] && (iAmBrain || jIsBrain)) continue
          let ddx = px[k] - xi
          if (ddx >= half) ddx -= S
          else if (ddx < -half) ddx += S
          const ax = ddx * ddx
          if (ax >= rc2) continue
          let ddy = py[k] - yi
          if (ddy >= half) ddy -= S
          else if (ddy < -half) ddy += S
          const r2 = ax + ddy * ddy
          if (r2 >= rc2 || r2 < 1e-18) continue
          const r = Math.sqrt(r2)
          // brains carry a body radius, so organisms can only ever touch through their limbs
          let core = r_0
          let kcore = K
          if (iAmBrain || jIsBrain) {
            core = iAmBrain && jIsBrain ? r_brain : r_brain_core
            kcore = K_brain
          }
          let f: number
          if (r < core) f = kcore * (r / core - 1)
          else {
            const mj = MIDX[tj]
            const beta = core / rc
            const u = r / rc
            f = (mi >= 0 && mj >= 0 ? A[mi * N_MATRIX + mj] : 0) * (1 - Math.abs(2 * u - 1 - beta) / (1 - beta))
          }
          f /= r
          sx += f * ddx
          sy += f * ddy
          if (tj === FOOD) near++
        }
      }
    }
    const i = items[k0]
    fx[i] = sx
    fy[i] = sy
    foodNear[i] = near
  }
}
