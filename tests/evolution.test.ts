import { describe, expect, it } from 'vitest'
import { type WorldSpec, specInit } from '../src/core/catalog'
import { massByType } from '../src/core/metrics'
import { N_MATRIX } from '../src/core/types'
import { QUANTA } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * The chemistry evolving, which is what the affinity rows are for.
 *
 * Non-brain particles previously had nothing to evolve. `A` was one table shared by every particle
 * of a type, so every P1 was identical to every other P1 forever: no variation, no heredity, and no
 * sense in which one particle was the offspring of another. Giving each particle its own row — six
 * numbers saying what it sticks to — supplies all three in the one property a particle actually has.
 *
 * The brain's genome is 418 numbers saying what to *do*. A particle's is six saying what to *stick
 * to*. Both heritable, both mutable, neither is the other.
 */
const VIABLE: WorldSpec = {
  seed: 4242,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 40, matter: 200, metabolism: 0.5, bondFlow: 0.05, T: 2,
  foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady',
  patches: 2, radius: 50, foodLife: 250, fission: false, scale: 1,
}

function world(over: Partial<WorldSpec> = {}): World {
  return new World(specInit({ ...VIABLE, ...over }), {})
}

/** The population's mean affinity row over living matter. */
function meanRow(w: World): number[] {
  const sum = new Array(N_MATRIX).fill(0)
  let n = 0
  for (let i = 0; i < w.nIntr; i++) {
    if (!w.alive[i]) continue
    n++
    for (let k = 0; k < N_MATRIX; k++) sum[k] += w.rows[i * N_MATRIX + k]
  }
  return sum.map((v) => (n ? v / n : 0))
}

describe('a particle has its own chemistry', () => {
  it('starts every particle on its type’s ancestral row, so tick zero is the old world', () => {
    const w = world()
    const rowOf = (i: number): number[] => Array.from(w.rows.subarray(i * N_MATRIX, (i + 1) * N_MATRIX))
    const byType = new Map<number, number[]>()
    for (let i = 0; i < w.nIntr; i++) {
      const prev = byType.get(w.type[i])
      if (prev) expect(rowOf(i)).toEqual(prev)
      else byType.set(w.type[i], rowOf(i))
    }
    expect(byType.size).toBeGreaterThan(1)
  })

  it('asks the same question of a pair that the force does', () => {
    // the coupling is the symmetric mean of the two particles' opinions. Symmetric is not a
    // stylistic choice: an asymmetric coupling has no potential-energy function, so
    // `potentialEnergy` and the energy ledger would both stop meaning anything
    const w = world()
    for (let i = 0; i < 20; i++) {
      for (let j = i + 1; j < 20; j++) expect(w.coupling(i, j)).toBeCloseTo(w.coupling(j, i), 12)
    }
  })

  it('makes editing the live matrix a no-op, and setChemistry the way to do it', () => {
    const w = world()
    const before = meanRow(w)
    w.A[0] = 1 // writing the ancestral matrix changes nothing that is already alive
    expect(meanRow(w)).toEqual(before)
    w.setChemistry(Array.from({ length: 5 }, () => new Array(5).fill(0)))
    expect(meanRow(w).every((v) => v === 0)).toBe(true)
  })
})

describe('the chemistry evolves, and only when asked to', () => {
  it('does nothing at all with templating off', () => {
    const w = world()
    const before = meanRow(w)
    const mass0 = massByType(w)
    for (let t = 0; t < 3000; t++) w.step()
    expect(w.nTemplated).toBe(0)
    expect(meanRow(w)).toEqual(before)
    expect(massByType(w)).toEqual(mass0) // matter is still immortal, and still type-by-type fixed
  })

  it('replicates, drifts, and stays quantized', () => {
    const w = world({ templating: true, decayScale: 0.004 })
    const before = meanRow(w)
    for (let t = 0; t < 6000; t++) w.step()
    expect(w.nTemplated).toBeGreaterThan(100)
    const after = meanRow(w)
    expect(after.some((v, k) => Math.abs(v - before[k]) > 0.05)).toBe(true)
    // every row stays on the quantized lattice, so the space the search explores stays countable
    for (let i = 0; i < w.nIntr; i++) {
      if (!w.alive[i]) continue
      for (let k = 0; k < N_MATRIX; k++) {
        expect(QUANTA as readonly number[]).toContain(w.rows[i * N_MATRIX + k])
      }
    }
  })

  it('selects for liking food, against the pull of mutation alone', () => {
    /*
     * The prediction behind the design, stated as the **contrast** rather than as a drift, because
     * a drift on its own proves nothing here.
     *
     * Mutation on a quantized lattice is a random walk that regresses toward the middle, and these
     * rows start net-positive — so *any* entry falling over time is what diffusion gives for free.
     * Measured over 8,000 ticks across eight seeds: affinity to matter fell by 0.135 ± 0.013
     * (t = −10.7) and affinity to Food **rose** by 0.140 ± 0.043 (t = 3.2). The fall is not
     * evidence of anything; the rise is, because it goes *against* the same regression that
     * produced the fall.
     *
     * Why food in particular: only a *bonded* particle with energy to spare can copy itself, so
     * what gets copied is the chemistry that got itself attached somewhere energy flows. Liking
     * food is selected; merely being sticky is not — which is what rules out the degenerate
     * attractor of immortal self-attracting clots.
     *
     * The contrast, not the food drift, is what is asserted: on one of those eight seeds food
     * drifted slightly *negative* while still beating matter by 0.118, so a single-seed test on
     * the drift alone would be flaky. The contrast held on all eight.
     *
     * An earlier version of this comment claimed +0.32, which was measured on code with the
     * stale-free-list bug below — replications overwriting live limbs is a different world.
     */
    const w = world({ templating: true, decayScale: 0.004 })
    const before = meanRow(w)
    for (let t = 0; t < 8000; t++) w.step()
    const after = meanRow(w)
    const FOODM = 4
    const foodDrift = after[FOODM] - before[FOODM]
    const matterDrift = [0, 1, 2, 3].reduce((a, k) => a + (after[k] - before[k]), 0) / 4
    expect(foodDrift - matterDrift).toBeGreaterThan(0.05)
  })

  it('keeps the energy ledger closed, which it did not at first', () => {
    /*
     * The bug this guards. The first version kept a *list* of matter slots emptied by decay, and
     * the list went stale: `bud` recruits free matter by testing `owner === -1` with no liveness
     * check — safe while matter was immortal and every slot was alive — so budding began
     * recruiting corpses as limbs, and a replication then overwrote a live limb and destroyed its
     * reserve. 361 of the list's entries were alive and 150 energy went missing.
     *
     * The fix was to stop keeping a list: an empty slot is *found by scanning*, which cannot go
     * stale. Note the leak needed templating **and** bond flow together — each alone was clean,
     * which is why a single-feature test would have missed it.
     */
    for (const bondFlow of [0, 0.05, 0.15]) {
      const w = world({ templating: true, decayScale: 0.004, bondFlow })
      for (let t = 0; t < 4000; t++) w.step()
      const total = w.initialEnergy + w.injected
      expect(Math.abs(w.totalEnergy() + w.burned - total) / total, `flow ${bondFlow}`).toBeLessThan(1e-9)
    }
  })

  it('conserves matter as slots, while letting the composition change', () => {
    // the invariant deliberately weakens: per-type counts were fixed, and now only the *total*
    // number of slots is, because a chemistry that works becoming more numerous is the whole point
    const w = world({ templating: true, decayScale: 0.006 })
    for (let t = 0; t < 6000; t++) w.step()
    let aliveMatter = 0
    for (let i = 0; i < w.nIntr; i++) if (w.alive[i]) aliveMatter++
    expect(aliveMatter).toBeLessThanOrEqual(w.nIntr)
    expect(massByType(w).reduce((a, x) => a + x, 0)).toBeLessThanOrEqual(w.nMatter)
  })

  it('never copies an unbonded particle, however rich it is', () => {
    // being part of a structure is the precondition for replicating, and it is what makes the
    // selection mean anything rather than rewarding whatever is stickiest
    const w = new World(specInit({ ...VIABLE, templating: true, decayScale: 0.004, A: new Array(14).fill(0) }), {})
    for (let t = 0; t < 2000; t++) {
      for (let i = 0; i < w.nIntr; i++) if (w.alive[i] && w.owner[i] === -1) w.energy[i] = 90
      w.step()
    }
    expect(w.bonds.count).toBe(0) // no chemistry, so nothing bonds
    expect(w.nTemplated).toBe(0)
  })
})
