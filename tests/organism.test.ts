import { describe, expect, it } from 'vitest'
import { IncompatibleOrganism, exportOrganism, parseOrganism } from '../src/core/organism'
import { applyWallStamp, initFromSeed } from '../src/core/params'
import { WALL } from '../src/core/types'
import { World } from '../src/core/world'

describe('organism export and import', () => {
  it('round-trips an organism, weights intact, and places a working copy', () => {
    const w = new World(initFromSeed(5))
    for (let t = 0; t < 600; t++) w.step()
    const b = [...Array(w.nMatter).keys()].find((i) => i >= w.nIntr && w.alive[i] && w.isBrain(i))!
    const file = exportOrganism(w, b)!
    expect(file.limbs.length).toBeGreaterThan(0)
    expect(file.wBrain.length).toBe(w.brainWeightCount)

    const back = parseOrganism(JSON.stringify(file))
    expect(back.wBrain).toEqual(file.wBrain)
    expect(back.wLimb).toEqual(file.wLimb)
    expect(back.limbs.map((l) => l.quad)).toEqual(file.limbs.map((l) => l.quad))

    const placed = w.placeSaved(back)
    expect(placed).toBeGreaterThanOrEqual(0)
    expect(w.isBrain(placed)).toBe(true)
    expect(Array.from(w.wBrain[placed]!)).toEqual(file.wBrain)
    for (let t = 0; t < 50; t++) w.step()
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
  })

  it('refuses a file with no brain stamp rather than padding it into something else', () => {
    // This used to pad and repair. It must not: a padded brain is a different organism, and the
    // brain's shape has already changed twice in this project's life.
    expect(() => parseOrganism(JSON.stringify({ limbs: [{ quad: 9, type: 77 }], reserve: -5, wBrain: [1, 2] }))).toThrow(
      IncompatibleOrganism,
    )
    expect(() => parseOrganism('{}')).toThrow(IncompatibleOrganism)
  })

  it('picks the organism nearest a point, and nothing when the point is empty', () => {
    const w = new World(initFromSeed(7))
    for (let t = 0; t < 300; t++) w.step()
    const b = [...Array(w.nMatter).keys()].find((i) => i >= w.nIntr && w.alive[i] && w.isBrain(i))!
    expect(w.pickOrganism(w.x[b], w.y[b])).toBe(b)
    // a point a long way from any body picks nothing, however generous the radius is not
    const far = w.pickOrganism(w.x[b] + w.L.SIZE / 2, w.y[b] + w.L.SIZE / 2, 5)
    expect(far === -1 || far !== b).toBe(true)
    expect(w.pickOrganism(w.x[b] + 1000 * w.L.SIZE, w.y[b], 0)).toBe(-1)
  })
})

describe('terrain', () => {
  it('never moves, and leaves the ledger and the economy intact', () => {
    for (const walls of ['pillars', 'maze', 'ring'] as const) {
      const w = new World(applyWallStamp({ ...initFromSeed(3), walls, n_wall: 40 }))
      const at: number[] = []
      for (let i = 0; i < w.cap; i++) if (w.alive[i] && w.type[i] === WALL) at.push(w.x[i], w.y[i])
      expect(at.length / 2, walls).toBe(40)
      expect(w.wallCount, walls).toBe(40)
      for (let t = 0; t < 800; t++) w.step()
      let k = 0
      for (let i = 0; i < w.cap; i++) {
        if (!w.alive[i] || w.type[i] !== WALL) continue
        expect(w.x[i], walls).toBe(at[k])
        expect(w.y[i], walls).toBe(at[k + 1])
        expect(w.energy[i]).toBe(0) // terrain holds no energy
        k += 2
      }
      expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
      expect(w.nFood).toBeGreaterThan(0) // food still works around the walls
    }
  })

  it('keeps particles out: nothing settles inside a wall', () => {
    const w = new World(applyWallStamp({ ...initFromSeed(11), walls: 'pillars', n_wall: 36, T: 2 }))
    for (let t = 0; t < 1200; t++) w.step()
    let inside = 0
    let checks = 0
    for (let i = 0; i < w.nMatter; i++) {
      if (!w.alive[i]) continue
      for (let j = w.nMatter; j < w.foodStart; j++) {
        if (!w.alive[j]) continue
        const S = w.L.SIZE
        let dx = w.x[j] - w.x[i]
        let dy = w.y[j] - w.y[i]
        dx -= S * Math.round(dx / S)
        dy -= S * Math.round(dy / S)
        if (Math.hypot(dx, dy) < 0.4 * w.L.r_wall) inside++
        checks++
      }
    }
    expect(checks).toBeGreaterThan(0)
    expect(inside / checks).toBeLessThan(0.0005)
  })

  it('adds no walls when the layout is none', () => {
    const w = new World({ ...initFromSeed(3), walls: 'none', n_wall: 500, wallPositions: [] })
    expect(w.wallCount).toBe(0)
    for (let i = 0; i < w.cap; i++) if (w.alive[i]) expect(w.type[i]).not.toBe(WALL)
  })
})
