import { describe, expect, it } from 'vitest'
import { Bonds, bondForce } from '../src/core/bonds'
import { type Init, LAWS, bondRange, initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'

function pairWorld(over: Partial<Init> = {}): World {
  const init: Init = {
    ...initFromSeed(13),
    T: 0, n_intrinsic: 4, n_brain: 1, n_start: 0, n_food0: 0,
    T_food: 1e9, T_spawn: 1e9, repro: false, decay_free: 0, food_life: 0, bonds: true,
    ...over,
  }
  init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
  init.A[0][0] = 1 // P1 likes P1, so a pair of them may bond
  const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
  for (let i = 0; i < 4; i++) w.type[i] = 0
  return w
}

/** Puts two particles a given distance apart on an otherwise empty world. */
function place(w: World, gap: number): void {
  w.x[0] = 150
  w.y[0] = 150
  w.x[1] = 150 + gap
  w.y[1] = 150
  for (let i = 2; i < 4; i++) {
    w.x[i] = 20 + i * 40 // out of the way
    w.y[i] = 20
  }
}

describe('bond table', () => {
  it('adds, finds and removes bonds symmetrically, and respects the slot limit', () => {
    const b = new Bonds(10, 2)
    expect(b.add(1, 2)).toBe(true)
    expect(b.has(1, 2) && b.has(2, 1)).toBe(true)
    expect(b.slots(1)).toBe(1)
    expect(b.add(1, 3)).toBe(true)
    expect(b.add(1, 4)).toBe(false) // out of slots
    expect(b.count).toBe(2)
    b.remove(1, 2)
    expect(b.has(1, 2) || b.has(2, 1)).toBe(false)
    b.clear(1)
    expect(b.count).toBe(0)
    expect(b.has(1, 3)).toBe(false)
    const seen: [number, number][] = []
    b.add(5, 7)
    b.forEach((i, j) => seen.push([i, j]), 10)
    expect(seen).toEqual([[5, 7]]) // each bond once, low index first
  })
})

describe('bond hysteresis', () => {
  it('forms only within the forming range', () => {
    const r = bondRange(LAWS)
    expect(r.form).toBeCloseTo(12, 6)
    expect(r.breakAt).toBeGreaterThan(r.form * 1.3) // the gap is the activation energy

    const close = pairWorld()
    place(close, r.form - 1)
    close.step()
    expect(close.bonds.has(0, 1)).toBe(true)

    const far = pairWorld()
    place(far, r.form + 2) // inside the break range, but too slack to ever form
    far.step()
    expect(far.bonds.has(0, 1)).toBe(false)
  })

  it('survives being stretched past the forming range, and snaps past the breaking one', () => {
    const w = pairWorld()
    place(w, 10)
    w.step()
    expect(w.bonds.has(0, 1)).toBe(true)
    const r = bondRange(LAWS)

    // haul them apart to a distance a bond could never have been made at
    w.x[1] = w.x[0] + (r.form + r.breakAt) / 2
    w.step()
    expect(w.bonds.has(0, 1)).toBe(true) // still held: this is the hysteresis

    w.x[1] = w.x[0] + r.breakAt + 2
    w.step()
    expect(w.bonds.has(0, 1)).toBe(false)
    expect(w.bondCool[0]).toBeGreaterThan(0) // and it cannot immediately re-form
  })

  it('pulls a stretched pair back together and pushes a squeezed one apart', () => {
    expect(bondForce(12, LAWS)).toBeGreaterThan(0) // stretched: pulls in
    expect(bondForce(8, LAWS)).toBeLessThan(0) // squeezed: pushes out
    expect(bondForce(LAWS.r_bond, LAWS)).toBeCloseTo(0, 9)

    const w = pairWorld()
    place(w, 13.5)
    w.step()
    const before = Math.abs(w.x[1] - w.x[0])
    for (let t = 0; t < 40; t++) w.step()
    expect(Math.abs(w.x[1] - w.x[0])).toBeLessThan(before)
  })

  it('refuses to bond when chemistry is indifferent, and charges both particles when it does', () => {
    const cold = pairWorld()
    cold.A[0] = 0 // P1 x P1 no longer attractive
    place(cold, 11)
    cold.step()
    expect(cold.bonds.count).toBe(0)

    const w = pairWorld()
    place(w, 11)
    const e0 = w.energy[0]
    w.step()
    expect(w.bonds.count).toBe(1)
    expect(e0 - w.energy[0]).toBeGreaterThanOrEqual(w.L.E_bond)
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
  })

  it('does nothing at all when bonding is switched off', () => {
    const w = pairWorld({ bonds: false })
    place(w, 10)
    for (let t = 0; t < 50; t++) w.step()
    expect(w.bonds.count).toBe(0)
  })

  it('never bonds two limbs of the same organism, which rods already hold', () => {
    const w = pairWorld()
    w.placeOrganism({ brain: 4, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.4 }, { idx: 1, quad: 1, angle: 1.3 }] })
    for (let t = 0; t < 30; t++) w.step()
    expect(w.bonds.has(0, 1)).toBe(false)
  })
})
