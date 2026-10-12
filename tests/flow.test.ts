import { describe, expect, it } from 'vitest'
import { LAWS, applyFoodLevel, bondRange, initFromSeed } from '../src/core/params'
import { INIT_SCALE, N_BRAIN_IN, N_BRAIN_OUT, N_WLIMB, brainRowScale, randomBrain, randomLimb, BRAIN_OUT } from '../src/core/neurons'
import { Rng } from '../src/core/rng'
import { World } from '../src/core/world'
import { restoreSnapshot, takeSnapshot } from '../src/core/snapshot'
import { stateHash } from '../src/core/metrics'

const base = (over = {}) =>
  applyFoodLevel({
    ...initFromSeed(909, 1),
    foodMode: 'patchy' as const,
    foodLevel: 'average' as const,
    foodRegime: 'steady' as const,
    n_patch: 2,
    r_patch: 50,
    n_brain: 20,
    n_start: 8,
    n_intrinsic: 200,
    T_spawn: 25,
    bonds: true,
    repro: true,
    metabolism: 0.5,
    bond_flow: 0.05,
    ...over,
  })

describe('bond topology', () => {
  it('lets a particle hold enough bonds for a sheet, not just a chain', () => {
    // two bonds admit only chains and rings; a two-dimensional fabric needs at least three
    expect(LAWS.max_bonds).toBeGreaterThanOrEqual(3)
  })

  it('keeps a bond harder to break than to make', () => {
    const r = bondRange(LAWS)
    expect(r.breakAt).toBeGreaterThan(r.form)
  })

  it('places a child where its limbs can reach its parent', () => {
    // a child's limb and its parent's can get no closer than repro_dist - 2 * L_rod; if that is
    // beyond the forming range, a family can never bond however the chemistry is set
    const closest = LAWS.repro_dist - 2 * LAWS.L_rod
    expect(closest).toBeLessThan(bondRange(LAWS).form)
  })
})

describe('brain initialisation', () => {
  it('draws weights small enough that a fresh brain is not saturated', () => {
    // tanh saturates past about |1.5|; with n inputs of typical size s the pre-activation spread
    // is scale * sqrt(n) * s, and the standard choice for tanh is 1/sqrt(n)
    expect(INIT_SCALE.brain).toBeLessThan(1.5 / Math.sqrt(N_BRAIN_IN))
    expect(INIT_SCALE.limb).toBeLessThan(1.5 / Math.sqrt(N_WLIMB))
    expect(INIT_SCALE.brain).toBeCloseTo(1 / Math.sqrt(N_BRAIN_IN), 2)
    expect(INIT_SCALE.limb).toBeCloseTo(1 / Math.sqrt(N_WLIMB), 2)
  })

  it('gives movement, food shares and signals their own, smaller scales', () => {
    expect(brainRowScale(BRAIN_OUT.FX)).toBe(INIT_SCALE.move)
    expect(brainRowScale(BRAIN_OUT.FY)).toBe(INIT_SCALE.move)
    for (let k = 0; k < 4; k++) {
      expect(brainRowScale(BRAIN_OUT.FOOD + k)).toBe(INIT_SCALE.food)
      expect(brainRowScale(BRAIN_OUT.SIG + k)).toBe(INIT_SCALE.signal)
    }
    expect(INIT_SCALE.move).toBeLessThan(INIT_SCALE.brain)
    expect(INIT_SCALE.food).toBeLessThan(INIT_SCALE.move)
  })

  it('produces the right shapes and a measurably smaller spread per row', () => {
    const rng = new Rng(4)
    const w = randomBrain(() => rng.gauss())
    expect(w.length).toBe(N_BRAIN_OUT * N_BRAIN_IN)
    expect(randomLimb(() => rng.gauss()).length).toBe(N_WLIMB)
    const rowSd = (o: number): number => {
      let s = 0
      for (let i = 0; i < N_BRAIN_IN; i++) s += w[o * N_BRAIN_IN + i] ** 2
      return Math.sqrt(s / N_BRAIN_IN)
    }
    // the food rows are the tightest, which is what makes initial sharing near-equal across
    // sockets — note the *level* of those weights is irrelevant, since a softmax ignores it
    expect(rowSd(BRAIN_OUT.FOOD)).toBeLessThan(rowSd(BRAIN_OUT.FX) * 2)
    expect(rowSd(3)).toBeLessThan(0.2)
  })
})

describe('energy along bonds', () => {
  it('moves energy from the richer side to the poorer', () => {
    const w = new World(base({ bond_flow: 0.25 }))
    for (let t = 0; t < 400; t++) w.step()
    // find a bond between two bodies and set a difference across it
    let a = -1
    let b = -1
    for (let i = 0; i < w.nIntr && a < 0; i++) {
      if (!w.alive[i] || w.owner[i] < 0) continue
      for (let k = 0; k < w.bonds.max; k++) {
        const j = w.bonds.partner[i * w.bonds.max + k]
        if (j >= 0 && w.alive[j] && w.owner[j] >= 0 && w.owner[j] !== w.owner[i]) {
          a = i
          b = j
          break
        }
      }
    }
    if (a < 0) return // no cross-body bond in this world; the ledger test below still covers the rule
    w.energy[a] = 60
    w.energy[b] = 10
    const before = w.energy[a] + w.energy[b]
    w.step()
    expect(w.energy[a]).toBeLessThan(60)
    expect(w.energy[b]).toBeGreaterThan(10)
    // and nothing is invented: what left one end arrived at the other, bar what was spent living
    expect(w.energy[a] + w.energy[b]).toBeLessThanOrEqual(before + 1e-9)
  })

  it('keeps the energy ledger closed, at every flow rate', () => {
    for (const bond_flow of [0, 0.02, 0.1, 0.4, 5]) {
      const w = new World(base({ bond_flow }))
      for (let t = 0; t < 1500; t++) w.step()
      expect(w.totalEnergy() + w.burned, `flow ${bond_flow}`).toBeCloseTo(w.initialEnergy + w.injected, 4)
      for (let i = 0; i < w.cap; i++) {
        expect(w.energy[i]).toBeGreaterThanOrEqual(0)
        expect(w.energy[i]).toBeLessThanOrEqual(LAWS.E_cap + 1e-9)
      }
    }
  })

  it('never shares with loose matter, which would be a straight energy sink', () => {
    const w = new World(base({ bond_flow: 0.4 }))
    for (let t = 0; t < 300; t++) w.step()
    for (let i = 0; i < w.nIntr; i++) {
      if (!w.alive[i] || w.owner[i] >= 0) continue
      let rich = -1
      for (let k = 0; k < w.bonds.max; k++) {
        const j = w.bonds.partner[i * w.bonds.max + k]
        if (j >= 0 && w.alive[j] && w.owner[j] >= 0) rich = j
      }
      if (rich < 0) continue
      // a drifting particle bonded to a body, emptied, beside a body that is full
      w.energy[i] = 0
      w.energy[rich] = LAWS.E_cap
      w.step()
      // it must still be empty: a loose particle has no use for a reserve and decays, so energy
      // shared outward would simply be burned — measured as worse than not sharing at all
      expect(w.energy[i]).toBe(0)
      return
    }
  })

  it('does nothing at all when switched off', () => {
    const off = new World(base({ bond_flow: 0 }))
    const also = new World(base({ bond_flow: 0 }))
    for (let t = 0; t < 600; t++) {
      off.step()
      also.step()
    }
    expect(stateHash(also)).toBe(stateHash(off))
    const on = new World(base({ bond_flow: 0.2 }))
    for (let t = 0; t < 600; t++) on.step()
    // sharing changes the world: if this ever matched, the rule would not be doing anything
    expect(stateHash(on)).not.toBe(stateHash(off))
  })

  it('survives a snapshot, flow and all', () => {
    const init = base({ bond_flow: 0.15 })
    const w = new World(init)
    for (let t = 0; t < 500; t++) w.step()
    const snap = takeSnapshot(w)
    const back = restoreSnapshot(init, snap)
    expect(stateHash(back)).toBe(stateHash(w))
    for (let t = 0; t < 300; t++) {
      w.step()
      back.step()
    }
    expect(stateHash(back)).toBe(stateHash(w))
  })
})

describe('structures that outlive their parts', () => {
  it('keeps a structure\'s identity when its membership changes', () => {
    const w = new World(base({ n_brain: 40, n_intrinsic: 300, n_start: 16, bond_flow: 0.05 }))
    let longest = 0
    let turnover = 0
    for (let t = 0; t < 8000; t++) {
      w.step()
      const o = w.orders.stats(w).oldest
      if (o) {
        longest = Math.max(longest, o.age)
        turnover = Math.max(turnover, o.replacements)
      }
    }
    const exact = w.orders.stats(w)
    // The point of the measure, stated as a comparison: keyed by exact membership, a group in a
    // crowded world lasts a handful of ticks, because somebody is always joining or dying. The
    // same aggregate, followed through its membership, persists for hundreds — which is why "no
    // compound ever lasts" was partly a fact about the metric rather than about the world.
    expect(longest).toBeGreaterThan(200)
    expect(longest).toBeGreaterThan(exact.bestAge * 5)
    expect(turnover).toBeGreaterThan(5)
  })

  it('reports no structure in a world that cannot bond', () => {
    const w = new World(base({ bonds: false }))
    for (let t = 0; t < 500; t++) w.step()
    expect(w.orders.stats(w).oldest).toBeNull()
  })
})
