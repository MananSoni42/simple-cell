import { describe, expect, it } from 'vitest'
import { MAX_ORDER, OrderTracker } from '../src/core/orders'
import { type Init, initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'

/** Two organisms whose limbs are bonded, plus a third standing alone. */
function joined(over: Partial<Init> = {}): { w: World; a: number; b: number; c: number } {
  const init: Init = {
    ...initFromSeed(17),
    T: 0, n_intrinsic: 6, n_brain: 3, n_start: 0, n_food0: 0,
    T_food: 1e9, T_spawn: 1e9, repro: false, decay_free: 0, food_life: 0, bonds: true,
    ...over,
  }
  init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
  init.A[0][0] = 1
  // releaseFrac 0 so the brains do not hand their whole reserve to their limbs and starve
  const w = new World(init, { laws: { SIZE: 400, releaseFrac: 0 }, autoSpawn: false })
  for (let i = 0; i < 6; i++) w.type[i] = 0
  const [a, b, c] = [w.nIntr, w.nIntr + 1, w.nIntr + 2]
  // limbs pointing at each other, tips a bond-length apart
  w.placeOrganism({ brain: a, x: 180, y: 200, limbs: [{ idx: 0, quad: 0, angle: 0.08 }] })
  w.placeOrganism({ brain: b, x: 180 + 2 * 16 + 9, y: 200, limbs: [{ idx: 1, quad: 2, angle: Math.PI + 0.08 }] })
  w.placeOrganism({ brain: c, x: 60, y: 60, limbs: [{ idx: 2, quad: 0, angle: 0.4 }] })
  // Silence the brains. With random weights they wander off and tear their own bonds apart
  // within ~120 ticks, which is true of the real world but not what these tests are about.
  for (const brain of [a, b, c]) w.wBrain[brain]!.fill(0)
  return { w, a, b, c }
}

describe('n-order survival', () => {
  it('counts each order, and only calls one survived once it has held long enough', () => {
    const { w } = joined()
    const t = new OrderTracker(1000, 0.2, 1) // hold for 200 ticks to count
    w.step()
    expect(w.bonds.count).toBe(1) // the two limbs have latched
    t.observe(w)
    let s = t.stats(w)
    expect(s.live[0]).toBe(1) // the lone organism
    expect(s.live[1]).toBe(1) // and one pair
    expect(s.surviving[1]).toBe(0) // too soon to count

    for (let k = 0; k < 260; k++) {
      w.step()
      t.observe(w)
    }
    s = t.stats(w)
    expect(s.live[1]).toBe(1)
    expect(s.surviving[1]).toBe(1) // held for a fifth of the window
    expect(s.bestOrder).toBe(2)
    expect(s.bestAge).toBeGreaterThanOrEqual(200)
  })

  it('restarts the clock when a compound comes apart and re-forms', () => {
    const { w, b } = joined()
    const t = new OrderTracker(1000, 0.2, 1)
    for (let k = 0; k < 100; k++) {
      w.step()
      t.observe(w)
    }
    expect(t.stats(w).live[1]).toBe(1)

    // haul the second organism far away, rod and all: the bond must snap
    w.x[b] = 350
    w.y[b] = 350
    w.x[1] = 350 + w.L.L_rod * Math.cos(w.theta[1])
    w.y[1] = 350 + w.L.L_rod * Math.sin(w.theta[1])
    w.step()
    t.observe(w)
    expect(w.bonds.count).toBe(0)
    const apart = t.stats(w)
    expect(apart.live[1]).toBe(0)
    expect(apart.live[0]).toBe(3) // three separate organisms
    expect(apart.surviving[1]).toBe(0)
  })

  it('reports nothing above order 1 in a world with no bonding', () => {
    const { w } = joined({ bonds: false })
    const t = new OrderTracker(1000, 0.2, 1)
    for (let k = 0; k < 200; k++) {
      w.step()
      t.observe(w)
    }
    const s = t.stats(w)
    expect(s.live[0]).toBe(3)
    for (let n = 2; n <= MAX_ORDER; n++) expect(s.live[n - 1]).toBe(0)
    expect(s.bestOrder).toBe(0)
  })

  it('survives a long live world and never reports more objects than organisms', () => {
    const w = new World({ ...initFromSeed(3, 2), n_start: 6, T_spawn: 40 })
    for (let t = 0; t < 2000; t++) w.step()
    const s = w.orders.stats(w)
    let objects = 0
    let members = 0
    for (let n = 1; n <= MAX_ORDER; n++) {
      objects += s.live[n - 1]
      members += n * s.live[n - 1]
      expect(s.surviving[n - 1]).toBeLessThanOrEqual(s.live[n - 1])
    }
    expect(objects).toBeGreaterThan(0)
    expect(members).toBeLessThanOrEqual(w.init.n_brain * 3)
  })
})
