import { describe, expect, it } from 'vitest'
import { ladder } from '../src/core/ladder'
import { keysOf } from '../src/core/fitness'
import { bestWorld } from '../src/ui/recipes'
import { World } from '../src/core/world'

describe('the ladder', () => {
  it('is only as high as its lowest gap', () => {
    const w = new World(bestWorld(31, 1))
    const l = ladder(w)
    // reached is the last rung with nothing unmet below it, so everything below it must be met
    for (let i = 0; i <= l.reached; i++) expect(l.rungs[i].met, l.rungs[i].name).toBe(true)
    if (l.next) expect(l.next.met).toBe(false)
    expect(l.rungs.map((r) => r.n)).toEqual(l.rungs.map((_, i) => i))
  })

  it('starts at the bottom and climbs as the world runs', () => {
    const w = new World(bestWorld(31, 1))
    const first = ladder(w).reached
    for (let t = 0; t < 4000; t++) w.step()
    const later = ladder(w)
    expect(later.reached).toBeGreaterThanOrEqual(first)
    // the measured-best world should at least be alive, feeding itself and keeping its limbs
    expect(later.rungs[0].met).toBe(true)
    expect(later.reached).toBeGreaterThanOrEqual(0)
    // every rung says where the world stands, met or not, so the stat is never blank
    for (const r of later.rungs) expect(r.at.length).toBeGreaterThan(0)
  })

  it('reports nothing reached in an empty world', () => {
    const w = new World({ ...bestWorld(5, 1), n_start: 0, T_spawn: 1e9, n_food0: 0 })
    const l = ladder(w)
    expect(l.reached).toBe(-1)
    expect(l.next?.name).toBe('Persists')
  })
})

describe('the best known world', () => {
  it('carries every measured setting and the only learner that worked', () => {
    const init = bestWorld(77, 1)
    expect(init.metabolism).toBe(0.5)
    expect(init.bond_flow).toBeGreaterThan(0)
    expect(init.n_brain).toBe(40)
    expect(init.foodMode).toBe('patchy')
    expect(init.foodLevel).toBe('abundant')
    expect(init.bonds).toBe(true)
    expect(init.learn.algo).toBe('cem')
    expect(keysOf(init.learn.fitness)).toEqual(['offspring', 'together'])
    expect(init.learn.fitness.combine).toBe('geometric')
  })

  it('scales without losing its character', () => {
    const big = bestWorld(77, 2)
    expect(big.size).toBe(600)
    expect(big.n_brain).toBe(160)
    expect(big.metabolism).toBe(0.5)
  })

  it('actually runs, and keeps its books', () => {
    const w = new World(bestWorld(9, 1))
    for (let t = 0; t < 3000; t++) w.step()
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 4)
    let alive = 0
    for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) alive++
    expect(alive).toBeGreaterThan(0)
  })
})
