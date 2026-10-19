import { describe, expect, it } from 'vitest'
import { applyFoodLevel, initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'
import { allocFrame, frameState, layoutOf, worldState, writeFrame } from '../src/sim/frames'

describe('published frames', () => {
  it('reproduce what the renderer reads from a live world', () => {
    /*
     * `n_start` seeds the population outright. This is a test of frame fidelity — that what the
     * renderer reads matches the live world — so it needs a populated world, not a world that
     * proves it can populate itself. A body now has to eat its way over an activation barrier, so
     * 300 ticks of a fresh world yields about four organisms where this once assumed a dozen.
     */
    const w = new World(applyFoodLevel({ ...initFromSeed(3, 2), inflow: true, n_start: 24, n_brain: 40, foodLevel: 'abundant' }))
    for (let t = 0; t < 300; t++) w.step()
    const layout = layoutOf(w)
    const f = allocFrame(layout)
    writeFrame(w, f)
    const live = worldState(w)
    const copy = frameState(layout, f)

    let organisms = 0
    for (let i = 0; i < w.cap; i++) {
      expect(copy.alive[i]).toBe(live.alive[i])
      if (!live.alive[i]) continue
      expect(copy.x[i]).toBeCloseTo(live.x[i], 3)
      expect(copy.y[i]).toBeCloseTo(live.y[i], 3)
      expect(copy.energy[i]).toBeCloseTo(live.energy[i], 3)
      expect(copy.type[i]).toBe(live.type[i])
      expect(copy.owner[i]).toBe(live.owner[i])
    }
    for (let b = w.nIntr; b < w.nMatter; b++) {
      expect(copy.isBrain(b)).toBe(live.isBrain(b))
      if (!live.isBrain(b)) continue
      organisms++
      for (let s = 0; s < 4; s++) {
        const l = live.limbOf(b, s)
        expect(copy.limbOf(b, s)).toBe(l)
        if (l >= 0) expect(copy.theta[l]).toBeCloseTo(live.theta[l], 4)
      }
    }
    expect(organisms).toBeGreaterThan(0)
    for (let i = 0; i < copy.field.length; i++) expect(copy.field[i]).toBeCloseTo(live.field[i], 4)
  })
})
