import { describe, expect, it } from 'vitest'
import { stateHash } from '../src/core/metrics'
import { initFromSeed } from '../src/core/params'
import { restoreSnapshot, takeSnapshot } from '../src/core/snapshot'
import { World } from '../src/core/world'

describe('snapshots', () => {
  it('restores a world that then runs identically to the original', () => {
    const init = { ...initFromSeed(21, 2), T_spawn: 60, T_food: 2, inflow: false }
    const a = new World(init)
    for (let t = 0; t < 600; t++) a.step()

    const snap = takeSnapshot(a)
    const b = restoreSnapshot(init, snap)
    expect(b.tick).toBe(a.tick)
    expect(stateHash(b)).toBe(stateHash(a))
    expect(b.burned).toBe(a.burned)
    expect(b.nBirths).toBe(a.nBirths)
    expect(b.totalEnergy()).toBeCloseTo(a.totalEnergy(), 9)

    // the real test: identical futures, which needs the RNG, weights and free-lists all restored
    for (let t = 0; t < 400; t++) {
      a.step()
      b.step()
    }
    expect(stateHash(b)).toBe(stateHash(a))
    expect(b.nBirths).toBe(a.nBirths)
    expect(b.nDeaths).toBe(a.nDeaths)
    expect(b.burned).toBeCloseTo(a.burned, 9)
    expect(b.totalEnergy() + b.burned).toBeCloseTo(b.initialEnergy + b.injected, 6)
  })

  it('rewinds: an older snapshot replays to the same place it first reached', () => {
    const init = { ...initFromSeed(9), T_spawn: 50, T_food: 2 }
    const w = new World(init)
    for (let t = 0; t < 200; t++) w.step()
    const early = takeSnapshot(w)
    for (let t = 0; t < 300; t++) w.step()
    const later = stateHash(w)

    const rewound = restoreSnapshot(init, early)
    expect(rewound.tick).toBe(200)
    for (let t = 0; t < 300; t++) rewound.step()
    expect(stateHash(rewound)).toBe(later)
  })

  it('round-trips a continuous-inflow world, where slots die and are reused', () => {
    const init = { ...initFromSeed(4), inflow: true, T_spawn: 40, T_food: 1, decay_free: 0.01 }
    const a = new World(init)
    for (let t = 0; t < 800; t++) a.step()
    const b = restoreSnapshot(init, takeSnapshot(a))
    for (let t = 0; t < 300; t++) {
      a.step()
      b.step()
    }
    expect(stateHash(b)).toBe(stateHash(a))
    expect(b.nFood).toBe(a.nFood)
  })
})
