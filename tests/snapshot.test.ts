import { describe, expect, it } from 'vitest'
import { stateHash } from '../src/core/metrics'
import { initFromSeed } from '../src/core/params'
import { allocSnapshot, restoreSnapshot, takeSnapshot, writeSnapshot } from '../src/core/snapshot'
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

  /**
   * What undo in the builder relies on: a snapshot taken before a hand edit restores the world
   * exactly, including the energy ledger. Placing things injects and burns energy, so a restore
   * that only moved particles back would leave the books wrong and the run's totals would lie.
   */
  it('takes back anything placed by hand, ledger included', () => {
    const init = { ...initFromSeed(63, 1), T_spawn: 1e9, T_food: 1e9, inflow: false }
    const w = new World(init)
    for (let t = 0; t < 120; t++) w.step()

    const before = takeSnapshot(w)
    const hash = stateHash(w)
    const injected = w.injected
    const burned = w.burned

    for (let k = 0; k < 20; k++) w.feedAt(80, 80, 20)
    w.spawnRandom([150, 150])
    w.addWall(200, 200)
    expect(stateHash(w)).not.toBe(hash)

    const undone = restoreSnapshot(init, before)
    expect(stateHash(undone)).toBe(hash)
    expect(undone.injected).toBe(injected)
    expect(undone.burned).toBe(burned)
    expect(undone.totalEnergy() + undone.burned).toBeCloseTo(undone.initialEnergy + undone.injected, 6)
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

describe('snapshot ring', () => {
  it('refills a preallocated snapshot without allocating, and restores identically', () => {
    const init = { ...initFromSeed(31), T_spawn: 50, T_food: 2 }
    const a = new World(init)
    for (let t = 0; t < 300; t++) a.step()

    const slot = allocSnapshot(a)
    expect(slot.valid).toBe(false)
    writeSnapshot(a, slot)
    expect(slot.valid).toBe(true)
    const bytes = slot.bytes
    const field = slot.field

    for (let t = 0; t < 100; t++) a.step()
    writeSnapshot(a, slot) // reuse: the same buffers must be written in place
    expect(slot.bytes).toBe(bytes)
    expect(slot.field).toBe(field)
    expect(slot.tick).toBe(a.tick)

    const b = restoreSnapshot(init, slot)
    expect(stateHash(b)).toBe(stateHash(a))
    for (let t = 0; t < 200; t++) {
      a.step()
      b.step()
    }
    expect(stateHash(b)).toBe(stateHash(a))
  })

  it('does not allocate per snapshot once the ring exists', () => {
    const w = new World(initFromSeed(5, 2))
    for (let t = 0; t < 100; t++) w.step()
    const slots = Array.from({ length: 8 }, () => allocSnapshot(w))
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < 400; i++) {
      w.step()
      writeSnapshot(w, slots[i % slots.length])
    }
    const grown = process.memoryUsage().heapUsed - before
    // 400 fresh snapshots of this world would be ~100 MB; reuse should stay far below that
    expect(grown).toBeLessThan(20 << 20)
  })
})
