import { describe, expect, it } from 'vitest'
import { initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'
import { allocFrame, frameState, layoutOf, worldState, writeFrame } from '../src/sim/frames'

describe('published frames', () => {
  it('reproduce what the renderer reads from a live world', () => {
    const w = new World({ ...initFromSeed(3, 2), inflow: true })
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
