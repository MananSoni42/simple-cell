import { describe, expect, it } from 'vitest'
import { type WorldSpec, specInit } from '../src/core/catalog'
import { massTotals } from '../src/core/metrics'
import { FOOD_ROW, N_MATRIX } from '../src/core/types'
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
    const mass0 = massTotals(w)
    for (let t = 0; t < 3000; t++) w.step()
    expect(w.nTemplated).toBe(0)
    /*
     * **Every particle's row equals its own kind's ancestral row, exactly.**
     *
     * Stronger than the mean row this replaced, and the replacement was necessary rather than a
     * tidy-up: a particle returning to the loose pool has its kind drawn again, which resets its
     * row to the *new* kind's. So the mean row across the population moves as the composition
     * moves, while no individual row has mutated at all — the old assertion failed on a world
     * doing precisely nothing.
     *
     * Checking it per particle says what the test means: with templating off, a row is a property
     * of a kind and nothing ever edits one.
     */
    const canon = new Map<number, number[]>()
    for (let i = 0; i < w.nMatter; i++) {
      if (!w.alive[i]) continue
      const t = w.type[i]
      const row = Array.from(w.rows.subarray(i * N_MATRIX, (i + 1) * N_MATRIX))
      const seen = canon.get(t)
      if (!seen) canon.set(t, row)
      // compared against another live particle of the same kind rather than against the matrix,
      // because the matrix is pre-scaled for the food column and a row is not
      else expect(row, `particle ${i} of kind ${t} differs from its kind`).toEqual(seen)
    }
    expect(massTotals(w)).toEqual(mass0) // matter is still conserved, as a total rather than kind by kind
  })

  it('replicates, drifts, and stays quantized', () => {
    const w = world({ templating: true, decayScale: 0.004 })
    const before = meanRow(w)
    for (let t = 0; t < 6000; t++) w.step()
    expect(w.nTemplated).toBeGreaterThan(100)
    const after = meanRow(w)
    expect(after.some((v, k) => Math.abs(v - before[k]) > 0.05)).toBe(true)
    /*
     * The matter and brain columns stay on the quantized lattice; the **food column does not**, and
     * that asymmetry is the rule rather than an oversight. R1.4a keeps the food row continuous —
     * `applyQuantization` touches only the 4×4 matter block — and `food_coupling` caps every food
     * entry at 0.5 because `A` is pre-scaled by it.
     *
     * Mutating all six alike broke both: it quantized a continuous row, and the lattice reaches ±1,
     * so replication walked food affinity through its ceiling. Measured: the largest food entry went
     * from 0.500, exactly the legal maximum, to 1.000.
     */
    for (let i = 0; i < w.nIntr; i++) {
      if (!w.alive[i]) continue
      for (let k = 0; k < N_MATRIX; k++) {
        const v = w.rows[i * N_MATRIX + k]
        if (k === FOOD_ROW) expect(Math.abs(v)).toBeLessThanOrEqual(w.L.food_coupling + 1e-12)
        else expect(QUANTA as readonly number[]).toContain(v)
      }
    }
  })

  it('does not show selection on food affinity — a retraction', () => {
    /*
     * **This test used to assert the opposite, and the earlier claim was an artefact of a bug.**
     *
     * It reported "affinity to Food rose by 0.140 ± 0.043 (t 3.2) against the pull of mutation" and
     * called the rise the finding. The rise was replication walking food entries through their
     * ceiling: all six row entries were mutated alike and snapped onto the matter lattice, which
     * reaches ±1, while a food entry's legal maximum is `food_coupling` = 0.5. Measured, the largest
     * food entry went 0.500 → 1.000.
     *
     * With the cap enforced the same eight seeds give food **−0.091 ± 0.018** — it falls. And pure
     * mutation with no selection at all, simulated on the same operator for the same number of
     * generations, gives −0.10 to −0.18. The world's food drift is therefore **indistinguishable
     * from doing nothing**.
     *
     * So this asserts the honest negative: food affinity does not rise. If a future change makes it
     * rise, this test fails and the claim can be made again — properly, with a null.
     */
    const w = world({ templating: true, decayScale: 0.004 })
    const before = meanRow(w)
    for (let t = 0; t < 8000; t++) w.step()
    const after = meanRow(w)
    expect(w.nTemplated).toBeGreaterThan(100)
    expect(after[FOOD_ROW] - before[FOOD_ROW]).toBeLessThan(0.02)
  })

  it('shows matter affinity falling far below what mutation alone gives', () => {
    /*
     * The one candidate for selection that survives, and it points the **opposite way to the
     * obvious prediction**.
     *
     * Only a bonded particle can replicate, and bonding needs a coupling of at least `A_form`, so
     * the naive expectation is that affinity to matter should *rise*. It falls hard: **−0.173 ±
     * 0.020** across eight seeds, where the same mutation operator with no selection, run for the
     * same number of generations, gives **+0.03 to +0.09**. That is a gap of about 0.2 in the
     * opposite direction from the null.
     *
     * A coherent reading, not yet tested: selection favours *just enough* affinity to hold one
     * bond, not maximal affinity — a particle buried in a clump pays `E_bond` repeatedly and sits
     * where food cannot reach it, so it never accumulates the reserve a copy costs.
     *
     * The null is a crude simulation of the operator (`/tmp` script, population-replacement model,
     * generation count estimated from copies per particle), so this asserts a direction and a
     * rough magnitude, not a precise effect.
     */
    const w = world({ templating: true, decayScale: 0.004 })
    const before = meanRow(w)
    for (let t = 0; t < 8000; t++) w.step()
    const after = meanRow(w)
    const matterDrift = [0, 1, 2, 3].reduce((a, k) => a + (after[k] - before[k]), 0) / 4
    expect(matterDrift).toBeLessThan(-0.05)
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
    const tot = massTotals(w)
    expect(tot.matter + tot.brains).toBeLessThanOrEqual(w.nMatter)
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
