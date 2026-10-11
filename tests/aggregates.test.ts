import { describe, expect, it } from 'vitest'
import { AggregateTracker } from '../src/core/aggregates'
import { initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'

/** Two organisms placed so one limb from each is touching, and a third far away. */
function pair(gap: number) {
  const init = { ...initFromSeed(11), T: 0, n_intrinsic: 6, n_brain: 3, n_start: 0, n_food0: 0, T_food: 1e9, T_spawn: 1e9, repro: false, decay_free: 0 }
  init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
  const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
  const [a, b, c] = [w.nIntr, w.nIntr + 1, w.nIntr + 2]
  // limbs point at each other along x, brains `gap` apart
  w.placeOrganism({ brain: a, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.13 }] })
  w.placeOrganism({ brain: b, x: 150 + gap, y: 150, limbs: [{ idx: 1, quad: 2, angle: Math.PI + 0.13 }] })
  w.placeOrganism({ brain: c, x: 40, y: 40, limbs: [{ idx: 2, quad: 0, angle: 0.3 }] })
  w.grid.build()
  return { w, a, b, c }
}

describe('organism aggregates', () => {
  it('sees a contact only when limbs actually touch', () => {
    const near = pair(2 * 16 + 4) // rod tips nearly meeting
    const t1 = new AggregateTracker(1, 10)
    t1.observe(near.w)
    expect(t1.stats(near.w).groups).toBe(1)
    expect(t1.stats(near.w).largest).toBe(2)
    expect(t1.stats(near.w).inGroups).toBe(2) // the distant third organism is not counted

    const far = pair(120)
    const t2 = new AggregateTracker(1, 10)
    t2.observe(far.w)
    expect(t2.stats(far.w).groups).toBe(0)
    expect(t2.stats(far.w).bonds).toBe(0)
  })

  it('ages a bond, promotes it to stable, and forgets it when contact breaks', () => {
    const { w } = pair(2 * 16 + 4)
    const t = new AggregateTracker(1, 20)
    for (let k = 0; k < 25; k++) {
      t.observe(w)
      w.tick++ // hold the geometry still and let time pass
    }
    const held = t.stats(w)
    expect(held.bonds).toBe(1)
    expect(held.oldestBond).toBeGreaterThanOrEqual(20)
    expect(held.stableBonds).toBe(1)
    expect(held.stableGroups).toBe(1)
    expect(held.stableLargest).toBe(2)

    // break contact: the bond is dropped, and a fresh one would start counting from zero
    const b = w.nIntr + 1
    w.x[b] = 20
    w.y[b] = 250
    w.x[1] = 20 + w.L.L_rod * Math.cos(w.theta[1]) // the rod has to come with it
    w.y[1] = 250 + w.L.L_rod * Math.sin(w.theta[1])
    w.grid.build()
    w.tick++ // the tracker samples on a schedule, so let it come round again
    t.observe(w)
    expect(t.stats(w).bonds).toBe(0)
    expect(t.stats(w).stableBonds).toBe(0)
  })

  it('drops bonds whose organisms have died, and survives a long live run', () => {
    const { w, b } = pair(2 * 16 + 4)
    const t = new AggregateTracker(1, 5)
    t.observe(w)
    expect(t.stats(w).bonds).toBe(1)
    w.energy[b] = 0 // starve the second brain
    w.step()
    expect(w.isBrain(b)).toBe(false)
    expect(t.stats(w).bonds).toBe(0)

    const live = new World({ ...initFromSeed(3, 2), n_start: 6, T_spawn: 40 })
    for (let i = 0; i < 1500; i++) live.step()
    const s = live.aggregates.stats(live)
    expect(s.largest).toBeLessThanOrEqual(Math.max(1, s.inGroups))
    expect(s.stableBonds).toBeLessThanOrEqual(s.bonds)
    expect(s.meanSize === 0 || s.meanSize >= 2).toBe(true)
  })
})
