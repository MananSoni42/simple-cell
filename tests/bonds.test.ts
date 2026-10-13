import { describe, expect, it } from 'vitest'
import { Bonds, bondForce } from '../src/core/bonds'
import { type Init, LAWS, bondRange, initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'
import { specInit } from '../src/core/catalog'
import { BRAIN, BRAIN_ROW, FOOD_ROW, MATRIX_INDEX } from '../src/core/types'

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
    // The gap is the activation energy, and it is deliberately narrower than it was: F_break used
    // to be 4, four times the largest force any chemistry can exert, which made a bond a weld
    // that only ever ended when a limb starved. At 2.5 the break distance is 14.2 against a
    // forming distance of 12, so chemistry plus motion can remodel a structure.
    expect(r.breakAt).toBeGreaterThan(r.form)
    expect(r.breakAt / r.form).toBeGreaterThan(1.15)

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

describe('bond length is bounded', () => {
  it('never leaves a bond stretched past breaking at the end of a tick', () => {
    const limit = bondRange(LAWS).breakAt
    for (const seed of [3, 101, 303]) {
      const w = new World({ ...initFromSeed(seed), n_start: 6, n_intrinsic: 150, n_brain: 10, bonds: true })
      let longest = 0
      for (let t = 0; t < 1500; t++) {
        w.step()
        w.bonds.forEach((i, j) => {
          const S = w.L.SIZE
          let dx = w.x[j] - w.x[i]
          let dy = w.y[j] - w.y[i]
          dx -= S * Math.round(dx / S)
          dy -= S * Math.round(dy / S)
          longest = Math.max(longest, Math.hypot(dx, dy))
        }, w.cap)
      }
      // Before the post-integration prune, a body teleported by a spawn dragged its partner's
      // bond across the whole world: measured 183 units against a 16.7 breaking point.
      expect(longest, `seed ${seed}`).toBeLessThanOrEqual(limit + 1e-6)
    }
  })

  it('cuts a bond when the body holding it is placed somewhere else', () => {
    const w = pairWorld({ n_intrinsic: 4, n_brain: 1 })
    place(w, 10)
    w.step()
    expect(w.bonds.has(0, 1)).toBe(true)
    // particle 0 is taken into a socket, and the body is placed across the world
    w.placeOrganism({ brain: 4, x: 20, y: 280, limbs: [{ idx: 0, quad: 0, angle: 0.4 }] })
    expect(w.bonds.has(0, 1)).toBe(false)
    expect(w.bonds.count).toBe(0)
  })
})

describe('brains are made of the same stuff as everything else', () => {
  /*
   * A brain used to map to matrix row -1: no chemistry, unable to bond, held apart from everything
   * by a hardcoded universal push. That is what made an organism a *template* held together by
   * rods rather than an assembly held together by what it is made of.
   *
   * Two exemptions had to go, and removing either alone achieves nothing: the brain needed a row
   * in the matrix, *and* `formBonds` needed to stop bounding its loop at `nIntr`, which is below
   * every brain's index.
   */
  const spec = (tail: number[]) => ({
    seed: 4242,
    A: [...[0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5], ...tail],
    slots: 40, matter: 200, metabolism: 0.5, bondFlow: 0.05, T: 2,
    foodMode: 'patchy' as const, foodLevel: 'average' as const, foodRegime: 'steady' as const,
    patches: 2, radius: 50, foodLife: 250, fission: false, scale: 1,
  })
  const run = (tail: number[]): { brainBonds: number; total: number; w: World } => {
    const w = new World(specInit(spec(tail)), {})
    for (let t = 0; t < 3000; t++) w.step()
    let brainBonds = 0
    w.bonds.forEach((i, j) => {
      if (w.type[i] === BRAIN || w.type[j] === BRAIN) brainBonds++
    }, w.cap)
    return { brainBonds, total: w.bonds.count, w }
  }

  it('has a row in the chemistry matrix', () => {
    expect(MATRIX_INDEX[BRAIN]).toBe(BRAIN_ROW)
    expect(BRAIN_ROW).toBeGreaterThan(FOOD_ROW) // appended, so the old 14 entries keep their places
  })

  it('bonds to matter when its chemistry says so, and not when it does not', () => {
    const off = run([0, 0, 0, 0, 0, 0])
    const on = run([1, 1, 1, 1, 0, 0])
    expect(off.brainBonds).toBe(0)
    expect(on.brainBonds).toBeGreaterThan(10)
  })

  it('keeps the energy ledger closed while bonded', () => {
    /*
     * This is the regression that matters. `flowBonds` snapshotted and looped over `nIntr`, and a
     * brain's index is *above* it — so `e[brain]` read a stale zero from outside the filled region,
     * the transfer was computed against a value that was never there, and the receiving end was
     * credited energy no end had been debited. It showed up as a reserve exceeding `E_cap` by 0.65:
     * energy created out of an array bound.
     */
    const { w } = run([1, 1, 1, 1, 0.5, 0])
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
    for (let i = 0; i < w.cap; i++) {
      expect(w.energy[i]).toBeGreaterThanOrEqual(0)
      expect(w.energy[i]).toBeLessThanOrEqual(LAWS.E_cap + 1e-9)
    }
  })

  it('still cannot bond to another brain, because the exclusion law outranks chemistry', () => {
    // `separateBrains` holds brains at least r_brain (16) apart and a bond needs about 12, so
    // multi-brain bodies remain out of reach until that exclusion becomes a dial. Stated as a test
    // so the limitation is recorded rather than assumed.
    const { w } = run([0, 0, 0, 0, 0, 1])
    let brainBrain = 0
    w.bonds.forEach((i, j) => {
      if (w.type[i] === BRAIN && w.type[j] === BRAIN) brainBrain++
    }, w.cap)
    expect(brainBrain).toBe(0)
    expect(LAWS.r_brain).toBeGreaterThan(bondRange(LAWS).form)
  })
})
