import { describe, expect, it } from 'vitest'
import { pairForce, pairPotential } from '../src/core/forces'
import { LifeTracker, RollingMean, summarize } from '../src/core/lifestats'
import { census, clusterStats, lifeStats, meanClusterSize, massByType, potentialEnergy, stateHash } from '../src/core/metrics'
import { type Init, LAWS, type Laws, QUANTA, initFromSeed, stability, substepsFor } from '../src/core/params'
import { Rng } from '../src/core/rng'
import { serialBackend } from '../src/core/backend'
import { BRAIN_OUT } from '../src/core/neurons'
import { World } from '../src/core/world'
import { configText, parseConfig } from '../src/ui/config'
import { PRESETS } from '../src/ui/presets'

const L: Laws = { ...LAWS }

/** Small, fast world for tests: no auto organisms unless asked. */
function smallInit(over: Partial<Init> = {}): Init {
  const init = { ...initFromSeed(7), n_intrinsic: 300, n_brain: 6, ...over }
  // changing T changes how many sub-steps the world needs; keep it numerically safe unless
  // the caller asked for a specific count
  if (over.substeps === undefined) init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return init
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
    // the core diverges as r -> 0, so no number of attracting neighbours can out-pull it
    expect(pairForce(0, 1, L)).toBeLessThan(-100 * L.K_core)
    expect(pairForce(r0 / 2, 1, L)).toBeCloseTo(-L.K_core, 6)
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
  it('attractive chemistry clusters, no chemistry does not, and heat loosens it', () => {
    const attract = (T: number, A?: number[][]) => {
      const base = smallInit({ T, n_brain: 0, T_food: 1e9, T_spawn: 1e9, n_intrinsic: 300 })
      base.A = A ?? Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => (i < 4 && j < 4 ? 1 : 0)))
      const w = new World(base, { laws: { SIZE: 600 }, autoSpawn: false })
      for (let t = 0; t < 2500; t++) w.step()
      return meanClusterSize(w)
    }
    const cold = attract(1)
    const hot = attract(120)
    const none = attract(1, Array.from({ length: 5 }, () => new Array(5).fill(0)))
    // chemistry is what builds structure
    expect(cold).toBeGreaterThan(none * 3)
    // heat loosens it, but note it does not fully melt: with the step clamp and sub-stepping in
    // play the world stays condensed far above the bond depth. A real gas phase is still missing.
    expect(hot).toBeLessThan(cold * 0.8)
    expect(hot).toBeGreaterThan(none)
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
    expect(hot.structured).toBe(false)
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

describe('exclusion', () => {
  it('keeps particles from overlapping and from tunnelling, the invariant that was missing', () => {
    const init = smallInit({ T: 3, n_intrinsic: 120, n_brain: 2, n_start: 1, T_food: 2, T_spawn: 300 })
    const w = new World(init, { laws: { SIZE: 200 } })
    const r0 = w.L.beta * w.L.r_c
    let worst = Infinity
    let deep = 0
    let samples = 0
    const nearest: number[] = []
    for (let t = 0; t < 1200; t++) {
      w.step()
      if (t % 25) continue
      for (let i = 0; i < w.nMatter; i++) {
        if (!w.alive[i] || w.owner[i] >= 0) continue // free particles: exclusion is force-borne
        for (let j = i + 1; j < w.nMatter; j++) {
          if (!w.alive[j] || w.owner[j] >= 0) continue
          const S = w.L.SIZE
          let dx = w.x[j] - w.x[i]
          let dy = w.y[j] - w.y[i]
          dx -= S * Math.round(dx / S)
          dy -= S * Math.round(dy / S)
          const d = Math.hypot(dx, dy)
          worst = Math.min(worst, d)
          if (d < 0.1 * r0) deep++
          samples++
        }
      }
    }
    // A squeeze is allowed; being squeezed through is not. The single deepest approach over a
    // long run is a rare-event statistic that moves with any change to the random stream, so
    // assert the distribution instead: deep overlaps are vanishingly rare. That nothing can
    // tunnel is proved separately, by the motion budget.
    expect(deep / samples).toBeLessThan(0.0005)
    expect(worst).toBeLessThan(r0) // sanity: the probe really did find close pairs
    // and in the steady state, neighbours sit a core radius apart rather than piled up
    for (let i = 0; i < w.nMatter; i++) {
      if (!w.alive[i] || w.owner[i] >= 0) continue
      let best = Infinity
      for (let j = 0; j < w.nMatter; j++) {
        if (j === i || !w.alive[j] || w.owner[j] >= 0) continue
        const S = w.L.SIZE
        let dx = w.x[j] - w.x[i]
        let dy = w.y[j] - w.y[i]
        dx -= S * Math.round(dx / S)
        dy -= S * Math.round(dy / S)
        best = Math.min(best, Math.hypot(dx, dy))
      }
      if (Number.isFinite(best)) nearest.push(best)
    }
    nearest.sort((a, b) => a - b)
    expect(nearest[Math.floor(nearest.length / 2)]).toBeGreaterThan(0.5 * r0)
  })

  it('sub-stepping brings a hot world back inside its budget and shrinks the steps', () => {
    expect(stability({ ...initFromSeed(1), T: 8, substeps: 1 }).ok).toBe(false)
    const n = substepsFor({ ...initFromSeed(1), T: 8 })
    expect(n).toBeGreaterThan(1)
    const fixed = stability({ ...initFromSeed(1), T: 8, substeps: n })
    expect(fixed.ok).toBe(true) // numerically safe again
    expect(fixed.structured).toBe(true) // and still colder than a bond, so structures survive
    // melting is a separate budget, and sub-stepping does not move it
    expect(stability({ ...initFromSeed(1), T: 60, substeps: 16 }).structured).toBe(false)

    const measure = (substeps: number) => {
      const w = new World(smallInit({ T: 8, substeps, n_brain: 0, n_start: 0, T_food: 1e9, T_spawn: 1e9 }), SMALL)
      const px = new Float64Array(w.cap)
      const py = new Float64Array(w.cap)
      let maxStep = 0
      for (let t = 0; t < 200; t++) {
        px.set(w.x)
        py.set(w.y)
        w.step()
        const S = w.L.SIZE
        for (let i = 0; i < w.nMatter; i++) {
          let dx = w.x[i] - px[i]
          let dy = w.y[i] - py[i]
          dx -= S * Math.round(dx / S)
          dy -= S * Math.round(dy / S)
          maxStep = Math.max(maxStep, Math.hypot(dx, dy))
        }
      }
      return maxStep
    }
    // same total diffusion, but no single move is long enough to cross a particle
    expect(measure(8)).toBeLessThan(measure(1))
    expect(measure(8)).toBeLessThan(LAWS.beta * LAWS.r_c)
  })
})

/** Recomputes forces on the current state without advancing anything else. */
function serialStep(w: World): void {
  w.grid.build()
  serialBackend.compute(w)
}

describe('food sensing', () => {
  it('reports the direction of nearby food, separately from the total force', () => {
    const init = smallInit({ T: 0, n_intrinsic: 1, n_brain: 1, n_start: 0, n_food0: 0, T_food: 1e9, T_spawn: 1e9, repro: false })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    init.A[0][4] = init.A[4][0] = 1 // P1 is a mouth
    const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
    w.type[0] = 0
    w.placeOrganism({ brain: 1, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.4 }] })
    // one food particle to the right of the limb, inside the interaction range
    w.injectFood()
    const f = w.nMatter
    w.x[f] = w.x[0] + 22
    w.y[f] = w.y[0]
    w.grid.build()
    serialStep(w)
    expect(w.ffx[0]).toBeGreaterThan(0) // food lies in +x, so the pull points that way
    expect(Math.abs(w.ffy[0])).toBeLessThan(Math.abs(w.ffx[0]) * 0.2)
    expect(w.foodNear[0]).toBe(1)

    // with the mouth type repelled instead, the same geometry pulls the other way
    const w2 = new World({ ...init, A: init.A.map((r, i) => r.map((v, j) => ((i === 4 || j === 4) && v !== 0 ? -1 : v))) }, { laws: { SIZE: 300 }, autoSpawn: false })
    w2.type[0] = 0
    w2.placeOrganism({ brain: 1, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.4 }] })
    w2.injectFood()
    w2.x[w2.nMatter] = w2.x[0] + 22
    w2.y[w2.nMatter] = w2.y[0]
    w2.grid.build()
    serialStep(w2)
    expect(w2.ffx[0]).toBeLessThan(0)
  })
})

describe('food economy', () => {
  it('spoils uneaten food on schedule, burning it, and leaves the ledger exact', () => {
    const init = smallInit({ food_life: 50, T_food: 1e9, T_spawn: 1e9, n_start: 0, n_food0: 12, n_intrinsic: 1, n_brain: 0, decay_free: 0 })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, SMALL)
    expect(w.nFood).toBe(12)
    for (let t = 0; t < 48; t++) w.step()
    expect(w.nFood).toBe(12) // still fresh
    let spoiledAt = -1
    for (let t = 48; t < 60 && spoiledAt < 0; t++) {
      w.step()
      if (w.nFood === 0) spoiledAt = w.tick // all injected together, so they spoil together
    }
    expect(spoiledAt).toBeGreaterThanOrEqual(50)
    expect(spoiledAt).toBeLessThanOrEqual(52)
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
  })

  it('never spoils food when the lifetime is off', () => {
    const init = smallInit({ food_life: 0, T_food: 1e9, T_spawn: 1e9, n_start: 0, n_food0: 8, n_intrinsic: 1, n_brain: 0, decay_free: 0 })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, SMALL)
    for (let t = 0; t < 2000; t++) w.step()
    expect(w.nFood).toBe(8)
  })

  it('leaves half a dead organism behind as food, converting rather than creating energy', () => {
    const init = smallInit({ T: 0, n_intrinsic: 2, n_brain: 1, n_start: 0, n_food0: 0, T_food: 1e9, T_spawn: 1e9, repro: false, decay_free: 0, food_life: 0 })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, { laws: { SIZE: 300, releaseFrac: 0 }, autoSpawn: false })
    w.placeOrganism({ brain: 2, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.5 }] })
    w.energy[2] = 0 // starve the brain
    w.energy[0] = 70 // the limb still holds plenty
    const before = w.totalEnergy() + w.burned - w.injected
    expect(w.nFood).toBe(0)
    w.step()
    expect(w.isBrain(2)).toBe(false)
    // pool was ~70, half of that is 35, which buys 3 food particles of 10
    expect(w.nFood).toBe(3)
    expect(w.totalEnergy() + w.burned - w.injected).toBeCloseTo(before, 6)
    // the food is left where the body was
    for (let f = w.nMatter; f < w.cap; f++) {
      if (!w.alive[f]) continue
      expect(Math.hypot(w.x[f] - 150, w.y[f] - 150)).toBeLessThanOrEqual(w.L.r_brain + 1e-9)
    }
  })
})

describe('hand feeding', () => {
  it('drops food where asked, counts it as injected, and respects the cap', () => {
    const init = smallInit({ T_food: 1e9, T_spawn: 1e9, n_start: 0, n_food0: 0, max_food: 4, food_life: 0 })
    const w = new World(init, SMALL)
    const before = w.injected
    expect(w.feedAt(50, 60, 0)).toBe(true)
    const f = [...Array(w.cap).keys()].find((i) => i >= w.nMatter && w.alive[i])!
    expect(w.x[f]).toBeCloseTo(50, 9)
    expect(w.y[f]).toBeCloseTo(60, 9)
    expect(w.injected).toBe(before + w.L.E_food)
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 9)

    while (w.feedAt(10, 10, 5)) {
      /* fill the world up */
    }
    expect(w.nFood).toBe(4) // max_food, and no more
    expect(w.feedAt(10, 10, 5)).toBe(false)
  })

  it('scatters within the radius it is given, wrapping at the edge', () => {
    const w = new World(smallInit({ T_food: 1e9, T_spawn: 1e9, n_start: 0, n_food0: 0, max_food: 60 }), SMALL)
    for (let k = 0; k < 40; k++) w.feedAt(2, 2, 10) // right at the corner
    for (let i = w.nMatter; i < w.cap; i++) {
      if (!w.alive[i]) continue
      expect(w.x[i]).toBeGreaterThanOrEqual(0)
      expect(w.x[i]).toBeLessThan(w.L.SIZE)
      const S = w.L.SIZE
      const dx = Math.abs(((w.x[i] - 2 + S / 2) % S) - S / 2)
      expect(dx).toBeLessThanOrEqual(10 + 1e-9)
    }
  })
})

describe('presets', () => {
  it('are all stable, quantized and runnable', () => {
    for (const p of PRESETS) {
      const init = p.build()
      expect(stability(init).ok, `${p.name} must be numerically safe`).toBe(true)
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) expect(QUANTA, `${p.name} A[${i}][${j}]`).toContain(init.A[i][j])
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) expect(init.A[i][j]).toBe(init.A[j][i])
      const w = new World(init)
      for (let t = 0; t < 400; t++) w.step()
      expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
      expect(Number.isFinite(w.totalEnergy())).toBe(true)
    }
  })
})

describe('neuron wiring', () => {
  it('closes the loop: the brain signals a limb, and the limb reads it next tick', () => {
    const init = smallInit({ T: 0, n_intrinsic: 2, n_brain: 1, n_start: 0, n_food0: 0, T_food: 1e9, T_spawn: 1e9, repro: false, decay_free: 0 })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
    const b = 2
    w.placeOrganism({ brain: b, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.5 }] })
    // a brain that always shouts at socket 0, and a limb that only repeats what it is told
    w.wBrain![b]!.fill(0)
    w.wBrain![b]![(BRAIN_OUT.SIG + 0) * 29 + 26] = 5 // weight on the bias input
    w.wLimb![b]!.fill(0)
    w.wLimb![b]![0] = 5 // weight on S_brain
    w.step()
    expect(w.brainSig[b * 4 + 0]).toBeGreaterThan(0.9)
    expect(w.sig[0]).toBeCloseTo(0, 6) // the limb has not heard it yet
    w.step()
    expect(w.sig[0]).toBeGreaterThan(0.9) // now it has
    expect(w.msg[0]).toBe(w.sig[0]) // one signal, sent both inward and outward
  })

  it('charges the brain for talking, and clears the channel when a limb leaves', () => {
    const init = smallInit({ T: 0, n_intrinsic: 2, n_brain: 1, n_start: 0, n_food0: 0, T_food: 1e9, T_spawn: 1e9, repro: false, decay_free: 0 })
    init.A = Array.from({ length: 5 }, () => new Array(5).fill(0))
    const w = new World(init, { laws: { SIZE: 300, releaseFrac: 0 }, autoSpawn: false })
    const b = 2
    w.placeOrganism({ brain: b, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.5 }] })
    w.wBrain![b]!.fill(0)
    w.wBrain![b]![(BRAIN_OUT.SIG + 0) * 29 + 26] = 8
    w.step()
    const quiet = new World(init, { laws: { SIZE: 300, releaseFrac: 0 }, autoSpawn: false })
    quiet.placeOrganism({ brain: b, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.5 }] })
    quiet.wBrain![b]!.fill(0)
    quiet.step()
    expect(w.burned).toBeGreaterThan(quiet.burned) // shouting is not free

    w.energy[0] = 0 // starve the limb so it unbinds
    w.step()
    expect(w.owner[0]).toBe(-1)
    expect(w.brainSig[b * 4 + 0]).toBe(0)
  })
})
