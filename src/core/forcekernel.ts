import { BRAIN, FOOD, MATRIX_INDEX, N_MATRIX, WALL } from './types'

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
  /** The part of the force that came from food, so a brain can be told which way food lies. */
  ffx: Float64Array
  ffy: Float64Array
  A: Float64Array
  /**
   * Each particle's **own** affinity row, `rows[i * N_MATRIX + m]`, indexed by real particle index.
   *
   * This replaces the single shared matrix as the thing the force consults. Two particles of the
   * same type are no longer interchangeable: each has its own opinion of everything else, and the
   * coupling between a pair is the **symmetric mean** of their two opinions. Symmetric is not a
   * stylistic choice — an asymmetric coupling has no potential-energy function, and `potentialEnergy`
   * and the energy ledger would both stop meaning anything.
   */
  rows: Float64Array
}

export interface KernelParams {
  SIZE: number
  r_c: number
  K_core: number
  /**
   * Exclusion radius for an ordinary pair, used only when no per-type radii are supplied.
   *
   * With `radius` present the exclusion becomes the **sum of the two particles' radii**, which is
   * what makes size a real property rather than a per-pair fudge: a big particle holds a small one
   * off at the distance their surfaces meet. The default radii are `r_0 / 2`, so the uniform case
   * reproduces this number exactly.
   */
  r_0: number
  r_brain_core: number // ... when one of the pair is a brain
  r_brain: number // ... when both are
  K_brain: number
  A_brain: number
  r_brain_push: number
  r_wall: number
  K_wall: number
  nc: number
  /** Skip food as a target: its force is never used while food is static. */
  skipFood: boolean
  /** Per-type hard-core radii, indexed by particle type. */
  radius: Float64Array
  /**
   * True when every particle's row is still identical to its type's row in `A`.
   *
   * Then `0.5·(rows[i·N+mj] + rows[j·N+mi])` is exactly `A[mi·N+mj]`, because `A` is symmetric and
   * both rows were seeded from it — so the kernel can read a 36-element matrix that stays in L1
   * instead of two per-particle rows of six doubles each.
   *
   * Measured, the per-particle read costs **7–9% of the force pass** (1.416 → 1.545 ms at one
   * scale, 5.330 → 5.798 at another), which is 3–6% of a whole tick since forces are 42–63% of
   * one. Packing the rows into the grid's packed arrays was measured and is a *net loss* — the
   * cost is the seven-wide working set, not the indirection, and packing copies it rather than
   * removing it, at roughly forty times what it saves.
   *
   * Static, decided at construction: only `templateParticles` ever writes a row, so a world with
   * templating off can never diverge. `seedRows` and `resetRow` both copy from `A`. That covers
   * about half the sampled space and every world catalogued to date.
   */
  uniformRows: boolean
}

const MIDX = Int8Array.from(MATRIX_INDEX)

/**
 * Net pair force on the packed particles in slots [lo, hi). Each particle sums over all
 * of its neighbours (no Newton's-third-law shortcut), so ranges are independent and can
 * run on different threads without write conflicts. Slots are dense (live particles only),
 * so equal-sized ranges carry equal work.
 */
export function computeForcesRange(lo: number, hi: number, a: KernelArrays, p: KernelParams): void {
  const { px, py, ptype, powner, pcell, items, cellStart, fx, fy, foodNear, ffx, ffy, rows, A } = a
  const { SIZE: S, r_c: rc, K_core: K, r_brain_core, r_brain, K_brain, A_brain, r_brain_push, r_wall, K_wall, nc, skipFood, radius, uniformRows } = p
  const rc2 = rc * rc
  const half = S / 2
  for (let k0 = lo; k0 < hi; k0++) {
    const ti = ptype[k0]
    if (ti === WALL) continue // terrain feels nothing; it only excludes
    if (skipFood && ti === FOOD) continue
    const xi = px[k0]
    const yi = py[k0]
    const mi = MIDX[ti]
    const oi = powner[k0]
    const iAmBrain = ti === BRAIN
    const myRow = items[k0] * N_MATRIX
    const c = pcell[k0]
    const cx = c % nc
    const cy = (c - cx) / nc
    let sx = 0
    let sy = 0
    let near = 0
    let gx = 0
    let gy = 0
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
          // the pair's exclusion distance: their two radii added, so size means size. Brains and
          // walls keep their own fixed radii, which are about bodies rather than about chemistry
          let core = radius[ti] + radius[tj]
          let kcore = K
          if (tj === WALL) {
            core = r_wall
            kcore = K_wall
          } else if (iAmBrain || jIsBrain) {
            core = iAmBrain && jIsBrain ? r_brain : r_brain_core
            kcore = K_brain
          }
          let f: number
          if (r < core) f = kcore * (1 - core / Math.max(r, core * 1e-3))
          else {
            const mj = MIDX[tj]
            const beta = core / rc
            const u = r / rc
            // the pair's coupling: the mean of what each one thinks of the other's kind. One extra
            // indirection per pair — `items` maps a packed slot back to its particle — against
            // which `myRow` is hoisted out of the loop because it never changes.
            const a =
              mi >= 0 && mj >= 0
                ? uniformRows
                  ? A[mi * N_MATRIX + mj]
                  : 0.5 * (rows[myRow + mj] + rows[items[k] * N_MATRIX + mi])
                : 0
            f = a * (1 - Math.abs(2 * u - 1 - beta) / (1 - beta))
            /*
             * A brain now has chemistry *and* its body radius.
             *
             * This branch used to *replace* chemistry with a bare push, because a brain had no
             * matrix row to consult — which is what made an organism a template held together by
             * rods rather than an assembly held together by what it is made of. The push is now an
             * additional term rather than a substitute, and `A_brain` is a dial whose range
             * includes zero, so a search can discover whether a brain wants to hold its
             * surroundings clear at all.
             *
             * With the Brain row at zero — which is what every world measured so far ran with —
             * this is bit-identical to the old behaviour.
             */
            if (iAmBrain || jIsBrain) f += r < r_brain_push ? -A_brain * (1 - (r - core) / (r_brain_push - core)) : 0
          }
          f /= r
          sx += f * ddx
          sy += f * ddy
          if (tj === FOOD) {
            near++
            gx += f * ddx
            gy += f * ddy
          }
        }
      }
    }
    const i = items[k0]
    fx[i] = sx
    fy[i] = sy
    foodNear[i] = near
    ffx[i] = gx
    ffy[i] = gy
  }
}
