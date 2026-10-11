import { describe, expect, it } from 'vitest'
import { pairForce, pairPotential } from '../src/core/forces'
import { census, clusterStats, meanClusterSize, massByType, potentialEnergy, stateHash } from '../src/core/metrics'
import { type Init, LAWS, type Laws, initFromSeed } from '../src/core/params'
import { Rng } from '../src/core/rng'
import { World } from '../src/core/world'

const L: Laws = { ...LAWS }

/** Small, fast world for tests: no auto organisms unless asked. */
function smallInit(over: Partial<Init> = {}): Init {
  return { ...initFromSeed(7), n_intrinsic: 300, n_brain: 6, ...over }
}
const SMALL = { laws: { SIZE: 300 } }

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = new Rng(5), b = new Rng(5), c = new Rng(6)
    const xs = [a.next(), a.next(), a.next()]
    expect([b.next(), b.next(), b.next()]).toEqual(xs)
    expect(c.next()).not.toBe(xs[0])
  })
})

describe('init', () => {
  it('is a pure function of the seed, with a symmetric matrix and no Food-Food entry', () => {
    const a = initFromSeed(42)
    expect(initFromSeed(42)).toEqual(a)
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) expect(a.A[i][j]).toBe(a.A[j][i])
    expect(a.A[4][4]).toBe(0)
  })
})

describe('force law', () => {
  it('matches hand-computed values', () => {
    const r0 = L.beta * L.r_c
    const peak = ((1 + L.beta) / 2) * L.r_c
    expect(pairForce(0, 1, L)).toBeCloseTo(-L.K_core)
    expect(pairForce(r0, 1, L)).toBeCloseTo(0)
    expect(pairForce(peak, 0.7, L)).toBeCloseTo(0.7)
    expect(pairForce(peak, -0.7, L)).toBeCloseTo(-0.7)
    expect(pairForce(L.r_c, 1, L)).toBe(0)
    expect(pairForce(L.r_c * 1.5, 1, L)).toBe(0)
  })
  it('is repulsive below the core for every matrix value', () => {
    for (const a of [-1, 0, 1]) for (let r = 0.1; r < L.beta * L.r_c; r += 0.1) expect(pairForce(r, a, L)).toBeLessThan(0)
  })
  it('equals the negative derivative of the potential', () => {
    for (const a of [-1, 0.6, 1]) {
      for (let r = 0.5; r < L.r_c - 0.5; r += 0.37) {
        const h = 1e-4
        const dU = (pairPotential(r + h, a, L) - pairPotential(r - h, a, L)) / (2 * h)
        expect(dU).toBeCloseTo(pairForce(r, a, L), 3)
      }
    }
  })
})

describe('invariants', () => {
  it('is deterministic', () => {
    const run = () => {
      const w = new World(smallInit(), SMALL)
      for (let i = 0; i < 300; i++) w.step()
      return stateHash(w)
    }
    expect(run()).toBe(run())
  })

  it('conserves matter, closes the energy ledger, and keeps rods geometric', () => {
    const init = smallInit({ T_spawn: 20, T_food: 1, T: 1 })
    const w = new World(init, SMALL)
    const mass0 = massByType(w)
    for (let t = 0; t < 1500; t++) {
      w.step()
      if (t % 50 === 0) {
        expect(massByType(w)).toEqual(mass0)
        expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
        for (let i = 0; i < w.cap; i++) {
          if (!w.alive[i]) continue
          expect(Number.isFinite(w.x[i]) && Number.isFinite(w.energy[i])).toBe(true)
          expect(w.x[i]).toBeGreaterThanOrEqual(0)
          expect(w.x[i]).toBeLessThan(w.L.SIZE)
          expect(w.energy[i]).toBeGreaterThanOrEqual(0)
          expect(w.energy[i]).toBeLessThanOrEqual(w.L.E_cap + 1e-9)
        }
        for (let b = w.nIntr; b < w.nMatter; b++) {
          if (!w.isBrain(b)) continue
          for (let s = 0; s < 4; s++) {
            const l = w.limbs[b * 4 + s]
            if (l < 0) continue
            expect(w.theta[l]).toBeGreaterThanOrEqual(w.quadLo(s) - 1e-12)
            expect(w.theta[l]).toBeLessThanOrEqual(w.quadHi(s) + 1e-12)
            const dx = w.x[l] - w.x[b]
            const dy = w.y[l] - w.y[b]
            const d = Math.hypot(dx - w.L.SIZE * Math.round(dx / w.L.SIZE), dy - w.L.SIZE * Math.round(dy / w.L.SIZE))
            expect(d).toBeCloseTo(w.L.L_rod, 6)
          }
        }
      }
    }
  })

  it('never raises potential energy at T=0 with no food or organisms (symmetry + integrator check)', () => {
    const init = smallInit({ T: 0, n_brain: 0, T_food: 1e9, T_spawn: 1e9, n_intrinsic: 100 })
    const w = new World(init, { laws: { SIZE: 200, mu: 0.1 }, autoSpawn: false })
    let prev = potentialEnergy(w)
    for (let t = 0; t < 400; t++) {
      w.step()
      const U = potentialEnergy(w)
      expect(U).toBeLessThanOrEqual(prev + 1e-9)
      prev = U
    }
  })
})

describe('phenomenology', () => {
  it('attractive chemistry condenses below a critical temperature and melts above it; zero chemistry never clusters', () => {
    const attract = (T: number, A?: number[][]) => {
      const base = smallInit({ T, n_brain: 0, T_food: 1e9, T_spawn: 1e9, n_intrinsic: 300 })
      base.A = A ?? Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => (i < 4 && j < 4 ? 1 : 0)))
      const w = new World(base, { laws: { SIZE: 600 }, autoSpawn: false })
      for (let t = 0; t < 2500; t++) w.step()
      return meanClusterSize(w)
    }
    const cold = attract(30)
    const hot = attract(300)
    const none = attract(30, Array.from({ length: 5 }, () => new Array(5).fill(0)))
    expect(cold).toBeGreaterThan(hot * 2)
    expect(cold).toBeGreaterThan(none * 2)
  })

  it('body shape follows chemistry: attracting limbs rest close, repelling limbs rest splayed', () => {
    const rest = (a: number) => {
      const init = smallInit({ T: 0, n_brain: 1, n_intrinsic: 2, T_food: 1e9, T_spawn: 1e9 })
      init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
      init.A[0][0] = a
      const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
      w.type[0] = 0
      w.type[1] = 0
      w.placeOrganism({
        brain: 2,
        x: 150,
        y: 150,
        limbs: [
          { idx: 0, quad: 0, angle: 0.8 },
          { idx: 1, quad: 1, angle: 2.3 },
        ],
      })
      for (let t = 0; t < 600; t++) w.step()
      return w.theta[1] - w.theta[0]
    }
    expect(rest(+1)).toBeLessThan(0.6)
    expect(rest(-1)).toBeGreaterThan(2.5)
  })

  it('a starved limb unbinds and an empty socket recaptures a free particle (regeneration)', () => {
    const init = smallInit({ T: 0, n_brain: 1, n_intrinsic: 3, T_food: 1e9, T_spawn: 1e9 })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, { laws: { SIZE: 300, releaseFrac: 0 }, autoSpawn: false })
    w.placeOrganism({ brain: 3, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.3 }] })
    // free particle sitting on the quadrant-0 rod circle, away from the existing tip
    w.x[1] = 150 + w.L.L_rod * Math.cos(1.2)
    w.y[1] = 150 + w.L.L_rod * Math.sin(1.2)
    w.energy[0] = 0
    w.step()
    expect(w.owner[0]).toBe(-1)
    for (let t = 0; t < 5; t++) w.step()
    expect(w.owner[1]).toBe(3)
    expect(w.socket[1]).toBe(0)
  })
})

describe('stats', () => {
  it('counts an organism as one connected cluster through its rods, and nothing else', () => {
    const init = smallInit({ T: 0, n_brain: 1, n_intrinsic: 4, T_food: 1e9, T_spawn: 1e9 })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
    // three free particles far apart, one organism with two limbs
    w.x[0] = 20; w.y[0] = 20
    w.x[1] = 250; w.y[1] = 60
    w.placeOrganism({
      brain: 4, x: 150, y: 150,
      limbs: [{ idx: 2, quad: 0, angle: 0.6 }, { idx: 3, quad: 2, angle: 4.0 }],
    })
    const c = clusterStats(w)
    expect(c.max).toBe(3)
    expect(c.count).toBe(3)
  })

  it('census splits energy cleanly and births/deaths add up to the organisms alive', () => {
    const w = new World(smallInit({ T_spawn: 15, T_food: 2 }), SMALL)
    for (let t = 0; t < 1500; t++) w.step()
    const c = census(w)
    expect(c.eOrganisms + c.eFree + c.eFood).toBeCloseTo(w.totalEnergy(), 6)
    expect(w.nBirths - w.nDeaths).toBe(c.organisms)
    expect(c.organisms).toBeLessThanOrEqual(w.init.n_brain)
  })
})

describe('continuous inflow', () => {
  it('keeps spawning past the brain count, closes the ledger, and never exceeds capacity', () => {
    const init = smallInit({ inflow: true, n_brain: 3, T_spawn: 25, T_food: 2, T: 3 })
    const w = new World(init, SMALL)
    let maxOrgs = 0
    for (let t = 0; t < 3000; t++) {
      w.step()
      if (t % 25 === 0) {
        expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
        maxOrgs = Math.max(maxOrgs, census(w).organisms)
      }
    }
    expect(w.nBirths).toBeGreaterThan(init.n_brain * 3)
    expect(maxOrgs).toBeLessThanOrEqual(init.n_brain * 3)
    expect(w.nBirths - w.nDeaths).toBe(census(w).organisms)
    for (let i = 0; i < w.cap; i++) if (!w.alive[i]) expect(w.energy[i]).toBe(0)
  })
})

describe('static food', () => {
  it('stays put until eaten when foodMoves is off, and drifts when it is on', () => {
    const run = (foodMoves: boolean) => {
      const w = new World(smallInit({ foodMoves, T: 20, n_intrinsic: 4, n_brain: 1, n_food0: 20, T_food: 1e9, T_spawn: 1e9, n_start: 0 }), SMALL)
      const start = new Map<number, [number, number]>()
      for (let i = w.nMatter; i < w.cap; i++) if (w.alive[i]) start.set(i, [w.x[i], w.y[i]])
      for (let t = 0; t < 50; t++) w.step()
      let moved = 0
      for (const [i, [x, y]] of start) if (w.alive[i] && (w.x[i] !== x || w.y[i] !== y)) moved++
      return moved
    }
    expect(run(false)).toBe(0)
    expect(run(true)).toBeGreaterThan(0)
  })
})

describe('budding reproduction', () => {
  const rich = (over: Partial<Init> = {}) => {
    const init = smallInit({ repro: true, n_brain: 4, T_spawn: 1e9, T_food: 1, n_start: 1, T: 2, ...over })
    const w = new World(init, SMALL)
    return w
  }

  it('moves energy from parent to child without creating any, and records lineage', () => {
    const w = rich()
    const b = [...Array(w.nMatter - w.nIntr).keys()].map((k) => k + w.nIntr).find((i) => w.isBrain(i))!
    w.energy[b] = 90
    w.repCool[b] = 0
    const births = w.nBirths
    const e0 = w.totalEnergy() + w.burned - w.injected
    w.step()
    expect(w.nBirths).toBeGreaterThan(births)
    expect(w.nBudded).toBeGreaterThan(0)
    expect(w.totalEnergy() + w.burned - w.injected).toBeCloseTo(e0, 6)
    const child = [...Array(w.nMatter).keys()].find((i) => w.isBrain(i) && w.parent[i] === b)!
    expect(w.gen[child]).toBe(1)
    expect(w.energy[b]).toBeGreaterThanOrEqual(w.L.E_hold - 1e-9)
  })

  it('with zero mutation the child inherits the parent weights exactly', () => {
    const w = rich({ repro_mut: 0 })
    const b = [...Array(w.nMatter).keys()].find((i) => w.isBrain(i))!
    w.energy[b] = 90
    w.repCool[b] = 0
    w.step()
    const child = [...Array(w.nMatter).keys()].find((i) => w.isBrain(i) && w.parent[i] === b)!
    expect(Array.from(w.wBrain[child]!)).toEqual(Array.from(w.wBrain[b]!))
    expect(Array.from(w.wLimb[child]!)).toEqual(Array.from(w.wLimb[b]!))
  })

  it('never buds when switched off, and keeps the ledger closed over a long run when on', () => {
    const off = rich({ repro: false })
    for (let t = 0; t < 500; t++) off.step()
    expect(off.nBudded).toBe(0)

    const on = rich({ inflow: true, n_start: 2, T_food: 1 })
    for (let t = 0; t < 2000; t++) {
      on.step()
      if (t % 100 === 0) expect(on.totalEnergy() + on.burned).toBeCloseTo(on.initialEnergy + on.injected, 6)
    }
    expect(on.nBirths - on.nDeaths).toBe(census(on).organisms)
  })
})
