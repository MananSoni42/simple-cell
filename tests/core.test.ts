import { describe, expect, it } from 'vitest'
import { pairForce, pairPotential } from '../src/core/forces'
import { LifeTracker, RollingMean, summarize } from '../src/core/lifestats'
import { census, clusterStats, lifeStats, meanClusterSize, massByType, potentialEnergy, stateHash } from '../src/core/metrics'
import { type Init, LAWS, type Laws, QUANTA, initFromSeed, stability } from '../src/core/params'
import { Rng } from '../src/core/rng'
import { World } from '../src/core/world'
import { configText, parseConfig } from '../src/ui/config'

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
    // attracting tips come to rest a core radius apart: separation ~ r_0 / L_rod
    const touching = (LAWS.beta * LAWS.r_c) / LAWS.L_rod
    expect(rest(+1)).toBeLessThan(touching * 1.3)
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

  it('can afford a child in a continuous-inflow world, where every child particle is new', () => {
    const w = rich({ inflow: true, n_start: 1 })
    const b = [...Array(w.nMatter).keys()].find((i) => w.isBrain(i))!
    w.energy[b] = w.L.E_cap
    w.repCool[b] = 0
    w.step()
    expect(w.nBudded).toBe(1)
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

describe('life statistics', () => {
  it('summarises values and keeps exact count/min/max across ring wrap-around', () => {
    const s = summarize([1, 2, 3, 4, 100])
    expect(s).toMatchObject({ n: 5, min: 1, max: 100, median: 3, mean: 22 })
    const t = new LifeTracker(4)
    for (const v of [10, 20, 30, 40, 50, 60]) t.record(v)
    const r = t.summary()
    expect(r).toMatchObject({ n: 6, min: 10, max: 60, mean: 35 })
    expect(r.median).toBe(45) // median of the most recent four: 30 40 50 60
  })
})

describe('free particle decay', () => {
  const lone = (decay: number) => {
    const init = smallInit({ T: 0, n_brain: 0, n_intrinsic: 1, n_start: 0, n_food0: 0, T_food: 1e9, T_spawn: 1e9, decay_free: decay })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    return new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
  }

  it('drains a free particle exponentially, burns exactly what it loses, and records its lifespan', () => {
    const k = 0.01
    const w = lone(k)
    for (let t = 1; t <= 100; t++) {
      w.step()
      expect(w.energy[0]).toBeCloseTo(30 * Math.pow(1 - k, t), 9)
    }
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy, 9)
    const expectedLife = Math.ceil(Math.log(0.01 / 30) / Math.log(1 - k))
    for (let t = 0; t < 1200; t++) w.step()
    expect(w.energy[0]).toBe(0)
    expect(w.lifeParticles.summary().n).toBe(1)
    expect(Math.abs(w.lifeParticles.summary().max - expectedLife)).toBeLessThanOrEqual(2)
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy, 9)
  })

  it('does nothing when off, and never touches bound particles', () => {
    const off = lone(0)
    for (let t = 0; t < 200; t++) off.step()
    expect(off.energy[0]).toBe(30)

    const init = smallInit({ T: 0, n_brain: 1, n_intrinsic: 2, n_start: 0, n_food0: 0, T_food: 1e9, T_spawn: 1e9, decay_free: 0.5, repro: false })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, { laws: { SIZE: 300, releaseFrac: 0 }, autoSpawn: false })
    w.placeOrganism({ brain: 2, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.5 }] })
    for (let t = 0; t < 10; t++) w.step()
    expect(w.energy[0]).toBeGreaterThan(29) // only upkeep and signalling, no 50% decay
    expect(w.energy[1]).toBeLessThan(0.1) // the free particle has been drained
  })

  it('reports live ages for particles and organisms', () => {
    const w = new World(smallInit({ T_spawn: 15 }), SMALL)
    for (let t = 0; t < 400; t++) w.step()
    const s = lifeStats(w)
    expect(s.particlesNow.n).toBeGreaterThan(0)
    expect(s.particlesNow.max).toBeLessThanOrEqual(w.tick)
    expect(s.particlesNow.min).toBeLessThanOrEqual(s.particlesNow.median)
    expect(s.particlesNow.median).toBeLessThanOrEqual(s.particlesNow.max)
    expect(s.organismsNow.n).toBe(census(w).organisms)
  })
})

describe('discrete-time guardrails', () => {
  it('never moves a particle further than d_max, nor swings a rod past dth_max', () => {
    const w = new World(smallInit({ T: 200, T_spawn: 40, T_food: 1 }), SMALL) // absurd temperature on purpose
    const px = new Float64Array(w.cap)
    const py = new Float64Array(w.cap)
    const pth = new Float64Array(w.cap)
    for (let t = 0; t < 400; t++) {
      px.set(w.x)
      py.set(w.y)
      pth.set(w.theta)
      const owner = Int32Array.from(w.owner)
      const births = w.nBirths
      w.step()
      if (w.nBirths !== births) continue // a spawn places particles outright
      const S = w.L.SIZE
      for (let i = 0; i < w.nMatter; i++) {
        if (owner[i] !== w.owner[i]) continue
        let dx = w.x[i] - px[i]
        let dy = w.y[i] - py[i]
        dx -= S * Math.round(dx / S)
        dy -= S * Math.round(dy / S)
        // Motion budget: forces and noise move anything at most d_max. A brain may then be
        // pushed apart by up to d_max more to keep organisms separated, and a limb additionally
        // swings with its rod. Only the integrated movers (free particles) must beat the core
        // radius to rule out tunnelling, and they do.
        const d = Math.hypot(dx, dy)
        const isBrain = w.owner[i] === i
        const isLimb = w.owner[i] >= 0 && !isBrain
        const budget = isLimb ? 2 * w.L.d_max + w.L.L_rod * w.L.dth_max : isBrain ? 2 * w.L.d_max : w.L.d_max
        expect(d).toBeLessThanOrEqual(budget + 1e-9)
        if (isLimb) expect(Math.abs(w.theta[i] - pth[i])).toBeLessThanOrEqual(w.L.dth_max + 1e-9)
        if (!isLimb && !isBrain) expect(d).toBeLessThan(w.L.beta * w.L.r_c) // cannot tunnel
      }
    }
    expect(w.nClamped).toBeGreaterThan(0) // at T=200 the guardrail must actually be biting
  })

  it('keeps brains apart so organisms can only touch through their limbs', () => {
    const w = new World(smallInit({ T: 4, n_brain: 6, n_start: 4, T_spawn: 50 }), SMALL)
    let closest = Infinity
    for (let t = 0; t < 2000; t++) {
      w.step()
      if (t % 10) continue
      for (let a = w.nIntr; a < w.nMatter; a++) {
        if (!w.alive[a] || !w.isBrain(a)) continue
        for (let b = a + 1; b < w.nMatter; b++) {
          if (!w.alive[b] || !w.isBrain(b)) continue
          const S = w.L.SIZE
          let dx = w.x[b] - w.x[a]
          let dy = w.y[b] - w.y[a]
          dx -= S * Math.round(dx / S)
          dy -= S * Math.round(dy / S)
          closest = Math.min(closest, Math.hypot(dx, dy))
        }
      }
    }
    expect(closest).toBeGreaterThan(w.L.r_brain * 0.5)
  })

  it('reports whether a world is inside its stability budget', () => {
    expect(stability({ ...initFromSeed(1), T: 1 }).ok).toBe(true)
    const hot = stability({ ...initFromSeed(1), T: 100 })
    expect(hot.ok).toBe(false)
    expect(hot.sigmaRatio).toBeGreaterThan(0.2)
    // every seed-chosen world must be inside the budget
    for (let seed = 1; seed < 40; seed++) expect(stability(initFromSeed(seed)).ok).toBe(true)
  })
})

describe('chemistry', () => {
  it('quantizes the 4x4 but leaves the food row continuous, and halves food coupling', () => {
    const init = initFromSeed(12345)
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) expect(QUANTA).toContain(init.A[i][j])
    init.A[0][4] = init.A[4][0] = 0.8
    init.A[0][1] = init.A[1][0] = 0.5
    const w = new World(init, { autoSpawn: false })
    expect(w.A[0 * 5 + 4]).toBeCloseTo(0.8 * LAWS.food_coupling, 9)
    expect(w.A[0 * 5 + 1]).toBeCloseTo(0.5, 9)
  })

  it('keeps the matrix symmetric and in range through a config round-trip', () => {
    const init = initFromSeed(777, 2)
    init.A[1][3] = 0.5
    init.A[3][1] = 0.5
    const text = configText(init, { threads: 3, gpu: false })
    const back = parseConfig(text)
    expect(back.init.A).toEqual(init.A)
    expect(back.init.seed).toBe(init.seed)
    expect(back.init.scale).toBe(2)
    expect(back.perf).toEqual({ threads: 3, gpu: false })

    const hostile = parseConfig(JSON.stringify({ init: { seed: 5, A: [[9, -9]], T: 'x', n_brain: -3 } }))
    expect(hostile.init.A[0][0]).toBe(1)
    expect(hostile.init.A[0][1]).toBe(-1)
    expect(hostile.init.A[1][0]).toBe(-1) // symmetry repaired
    expect(hostile.init.T).toBe(initFromSeed(5).T)
    expect(hostile.init.n_brain).toBeGreaterThanOrEqual(1)
  })
})

describe('lineage', () => {
  it('gives each spawned organism its own lineage and passes it to descendants', () => {
    const w = new World(smallInit({ repro: true, n_brain: 6, n_start: 1, T_spawn: 1e9, T_food: 1 }), SMALL)
    const b = [...Array(w.nMatter).keys()].find((i) => w.isBrain(i))!
    w.energy[b] = 95
    w.repCool[b] = 0
    w.step()
    const child = [...Array(w.nMatter).keys()].find((i) => w.isBrain(i) && w.parent[i] === b)!
    expect(w.lineage[child]).toBe(w.lineage[b])
    expect(w.children[b]).toBe(1)
    expect(w.children[child]).toBe(0)
    const c = census(w)
    expect(c.lineages).toBe(1)
    expect(c.biggestLineage).toBe(2)
    expect(c.maxChildren).toBe(1)
  })
})

describe('rolling mean', () => {
  it('averages only the trailing window and leaves gaps where nothing was recorded', () => {
    const r = new RollingMean(1000, 10) // 10 buckets of 100 ticks
    r.record(50, 10)
    r.record(150, 20)
    expect(r.mean(150)).toBe(15)
    const s = r.series(150)
    expect(s[s.length - 1]).toBe(20)
    expect(s[s.length - 2]).toBe(10)
    expect(Number.isNaN(s[0])).toBe(true)
    r.record(5000, 99) // far beyond the window: the old values must fall out
    expect(r.mean(5000)).toBe(99)
  })
})
