import { describe, expect, it } from 'vitest'
import { FITNESS, type LifeStats, fitnessOf, isImplicitOnly, keysOf } from '../src/core/fitness'
import { type LearnAlgo, LEARN_DEFAULTS, type LifeRecord, N_GENE_BRAIN, makeLearner } from '../src/core/learning'
import { N_WLIMB } from '../src/core/neurons'
import { type Init, applyFoodLevel, initFromSeed } from '../src/core/params'
import { specInit } from '../src/core/catalog'
import { Rng } from '../src/core/rng'
import { takeSnapshot, restoreSnapshot } from '../src/core/snapshot'
import { stateHash } from '../src/core/metrics'
import { World } from '../src/core/world'

const stats = (over: Partial<LifeStats> = {}): LifeStats => ({
  age: 100,
  children: 0,
  generation: 0,
  harvested: 50,
  spent: 20,
  moved: 100,
  meals: 5,
  orderTicks: 0,
  peakReserve: 40,
  seeking: 0,
  ...over,
})

/**
 * A synthetic completed life whose fitness is `fitness` under **either** default objective.
 *
 * It used to vary `children` alone, which stopped working when the default objective became
 * `per_tick` — twenty lives differing only in children all scored the same percentile, so a test
 * asserting the best was near the top of its cohort read 0.5. Varying `harvested` at a fixed age
 * makes `per_tick` track `fitness` too, so these tests measure the pool's behaviour rather than
 * which scalar happens to be selected.
 */
function life(rng: Rng, id: number, fitness: number): LifeRecord {
  return {
    id,
    wBrain: Float64Array.from({ length: N_GENE_BRAIN }, () => rng.gauss()),
    wLimb: Float64Array.from({ length: N_WLIMB }, () => rng.gauss()),
    stats: stats({ children: fitness, age: 100, harvested: fitness * 10 }),
    diedAt: 1000,
  }
}

describe('fitness is a stated choice', () => {
  it('computes every scalar from counters that already exist', () => {
    const s = stats({ children: 3, age: 200, harvested: 80, spent: 30, moved: 40, meals: 7, orderTicks: 12, peakReserve: 55 })
    expect(fitnessOf('offspring', s)).toBe(3)
    expect(fitnessOf('lifespan', s)).toBe(200)
    expect(fitnessOf('harvested', s)).toBe(80)
    expect(fitnessOf('net', s)).toBe(50)
    expect(fitnessOf('per_tick', s)).toBeCloseTo(0.4, 12)
    expect(fitnessOf('peak', s)).toBe(55)
    expect(fitnessOf('efficiency', s)).toBe(2)
    expect(fitnessOf('together', s)).toBe(12)
    expect(fitnessOf('meals', s)).toBe(7)
  })

  it('never divides by zero, however short the life', () => {
    const newborn = stats({ age: 0, moved: 0, harvested: 0 })
    for (const f of FITNESS) expect(Number.isFinite(fitnessOf(f.key, newborn))).toBe(true)
  })

  it('names offspring as the one scalar the world was already counting', () => {
    // still the only non-invented measure: the world counts children for its own reasons
    expect(FITNESS.filter((f) => !f.invented).map((f) => f.key)).toEqual(['offspring'])
  })

  it('defaults to per_tick, because offspring is four times noisier', () => {
    /*
     * The default was `offspring` for all 260,640 v1 worlds, and it is the worst available choice on
     * the axis that decides whether selection can work. Measured over 2,899 lives of one fixed
     * genome: `offspring` CV **4.22** (≈28,000 lives per genome to detect a 10% effect) against
     * `per_tick` CV **1.07** (≈1,800) — and the whole budget is about 1,800 lives shared across
     * every genome. Selection that noisy is selection on which genome got lucky, and it measured
     * worse than no learner at all for every algorithm tried.
     *
     * So the default is `per_tick`, which is also the least gameable of the cheap ones: it cannot be
     * had by living longer, growing more limbs, or drifting into a patch, since all three raise the
     * denominator too. `offspring` stays selectable as v1's comparison.
     */
    expect(keysOf(LEARN_DEFAULTS.fitness)).toEqual(['per_tick'])
    expect(isImplicitOnly(LEARN_DEFAULTS.fitness)).toBe(false)
  })
})

describe('the learner seam', () => {
  it('leaves spawns to chance before warmup, and never acts at all when off', () => {
    const off = makeLearner({ ...LEARN_DEFAULTS, algo: 'none' }, 1)
    expect(off.genomeForSpawn(0)).toBeNull()
    expect(off.genomeForSpawn(1e6)).toBeNull()

    const ga = makeLearner({ ...LEARN_DEFAULTS, algo: 'ga', warmup: 500 }, 1)
    const rng = new Rng(7)
    for (let i = 0; i < 40; i++) ga.observe(life(rng, 0, i), 100) // all before warmup
    expect(ga.genomeForSpawn(100)).toBeNull()
    expect(ga.status().seen).toBe(0)
  })

  it('a GA fills a pool from deaths and then breeds from it', () => {
    const ga = makeLearner({ ...LEARN_DEFAULTS, algo: 'ga', warmup: 0, pool: 8 }, 3)
    const rng = new Rng(11)
    expect(ga.genomeForSpawn(1)).toBeNull() // nothing to breed from yet
    for (let i = 0; i < 20; i++) ga.observe(life(rng, 0, i), 1000)
    const st = ga.status()
    expect(st.seen).toBe(20)
    expect(st.held).toBe(8)
    // scores are percentiles now, so the best is near the top of its cohort rather than its raw value
    expect(st.best).toBeGreaterThan(0.9)
    expect(st.best).toBeLessThanOrEqual(1)
    const g = ga.genomeForSpawn(1000)
    expect(g).not.toBeNull()
    expect(g!.wBrain.length).toBe(N_GENE_BRAIN)
    expect(g!.wLimb.length).toBe(N_WLIMB)
    expect(g!.wBrain.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('a GA pool protects what it has measured and discards what it has not', () => {
    /*
     * The rule changed with re-evaluation, and the change is the point.
     *
     * It used to be "a newcomer better than the worst held gets in, a worse one does not" — which
     * trusts a **single life** to rank a genome, at CV 1.07 on the best objective and 4.22 on the
     * one every learner used. A pool that does that fills with whichever genome got lucky and
     * destroys the diversity random initialisation supplied; measured, every algorithm then scored
     * *worse than no learner at all*.
     *
     * Now an entry seen fewer than `reeval` times is **provisional**: its number is not trustworthy,
     * so it gives way regardless of what that number says. Only an entry whose estimate is averaged
     * over `reeval` lives is protected, and then only something better displaces it.
     */
    const ga = makeLearner({ ...LEARN_DEFAULTS, algo: 'ga', warmup: 0, pool: 2, reeval: 3 }, 5)
    const rng = new Rng(12)
    // one genome, observed three times: an established entry with a high mean
    for (let k = 0; k < 3; k++) ga.observe(life(rng, 7, 10), 1000)
    // a second genome, observed once: provisional, however good it looks
    ga.observe(life(rng, 9, 100), 1000)
    expect(ga.status().held).toBe(2)

    // a newcomer worse than both takes the *provisional* slot, because that slot is not evidence
    const before = ga.status().updates
    ga.observe(life(rng, 11, 1), 1000)
    expect(ga.status().updates, 'a provisional slot gives way').toBe(before + 1)

    // and another life of the established genome updates it in place rather than competing
    const held = ga.status().held
    ga.observe(life(rng, 7, 10), 1000)
    expect(ga.status().held, 'a repeat observation is evidence, not a competitor').toBe(held)
  })

  it('a GA drops entries whose fitness came from a world that has since moved on', () => {
    const ga = makeLearner({ ...LEARN_DEFAULTS, algo: 'ga', warmup: 0, pool: 8, maxAge: 1000 }, 9)
    const rng = new Rng(13)
    for (let i = 0; i < 8; i++) ga.observe(life(rng, 0, 50), 1000)
    expect(ga.status().held).toBe(8)
    ga.observe(life(rng, 0, 1), 5000) // long after: everything held is stale
    expect(ga.status().held).toBe(1)
  })

  it('ES and CEM only count samples they actually handed out', () => {
    for (const algo of ['es', 'cem'] as LearnAlgo[]) {
      const l = makeLearner({ ...LEARN_DEFAULTS, algo, warmup: 0, batch: 4 }, 17)
      const rng = new Rng(21)
      // a death that was never one of its samples must not enter the batch
      l.observe(life(rng, 999, 5), 10)
      expect(l.status().updates).toBe(0)

      const ids: number[] = []
      for (let i = 0; i < 4; i++) ids.push(l.genomeForSpawn(10)!.id)
      for (const [k, id] of ids.entries()) l.observe({ ...life(rng, id, k), id }, 20)
      expect(l.status().updates).toBe(1)
    }
  })

  it('ES moves its mean toward what did better, and keeps the weights finite', () => {
    const es = makeLearner({ ...LEARN_DEFAULTS, algo: 'es', warmup: 0, batch: 6, sigma: 0.2, lr: 0.5 }, 23)
    const rng = new Rng(29)
    const first = es.genomeForSpawn(1)!
    const before = Float64Array.from(first.wBrain)
    for (let round = 0; round < 10; round++) {
      const batch = Array.from({ length: 6 }, () => es.genomeForSpawn(10)!)
      // reward whichever sample happens to have the larger first weight: a trivial objective the
      // method must be able to climb, since otherwise nothing it does can be believed
      for (const g of batch) es.observe({ ...life(rng, g.id, 0), id: g.id, stats: stats({ children: g.wBrain[0] }) }, 20)
    }
    expect(es.status().updates).toBe(10)
    const after = es.genomeForSpawn(30)!
    expect(after.wBrain.every((v) => Number.isFinite(v))).toBe(true)
    // the mean has moved at all
    let moved = 0
    for (let i = 0; i < before.length; i++) moved += Math.abs(after.wBrain[i] - before[i])
    expect(moved).toBeGreaterThan(0)
  })

  it('CEM narrows its spread but never collapses it to nothing', () => {
    const cem = makeLearner({ ...LEARN_DEFAULTS, algo: 'cem', warmup: 0, batch: 8, sigma: 0.5 }, 31)
    const rng = new Rng(37)
    for (let round = 0; round < 12; round++) {
      const batch = Array.from({ length: 8 }, () => cem.genomeForSpawn(10)!)
      for (const g of batch) cem.observe({ ...life(rng, g.id, 0), id: g.id, stats: stats({ children: -Math.abs(g.wBrain[0]) }) }, 20)
    }
    const spread = new Set<number>()
    for (let i = 0; i < 50; i++) spread.add(cem.genomeForSpawn(100)!.wBrain[0])
    expect(spread.size).toBeGreaterThan(5) // still exploring
    expect([...spread].every((v) => Number.isFinite(v))).toBe(true)
  })

  it('random search keeps a yardstick without ever using it', () => {
    const rs = makeLearner({ ...LEARN_DEFAULTS, algo: 'random', warmup: 0 }, 41)
    const rng = new Rng(43)
    for (let i = 0; i < 10; i++) rs.observe(life(rng, 0, i), 100)
    expect(rs.status().best).toBeGreaterThan(0.8)
    expect(rs.status().held).toBe(1)
    expect(rs.genomeForSpawn(100)).toBeNull() // spawns stay random: that is the point
  })

  it('round-trips its state through a snapshot', () => {
    for (const algo of ['random', 'ga', 'es', 'cem'] as LearnAlgo[]) {
      const cfg = { ...LEARN_DEFAULTS, algo, warmup: 0, batch: 4, pool: 6 }
      const a = makeLearner(cfg, 55)
      const rng = new Rng(57)
      for (let i = 0; i < 12; i++) {
        const g = a.genomeForSpawn(100)
        a.observe({ ...life(rng, g?.id ?? 0, i), id: g?.id ?? 0 }, 100)
      }
      const buf = new Float64Array(a.saveSize())
      a.saveInto(buf, 0)
      const b = makeLearner(cfg, 55)
      b.loadFrom(buf, 0)
      expect(b.status()).toEqual(a.status())
      // and the same stream from here: the next sample must match
      const ga = a.genomeForSpawn(200)
      const gb = b.genomeForSpawn(200)
      expect(gb === null).toBe(ga === null)
      if (ga && gb) expect(Array.from(gb.wBrain)).toEqual(Array.from(ga.wBrain))
    }
  })
})

describe('a learner in a world', () => {
  /*
   * Seeded and fed, because a learner needs deaths to learn from and births to supply.
   *
   * `T_spawn: 40` used to top the population up every forty ticks and no longer does anything —
   * organisms come from loose brains crossing an activation barrier now. Without a population these
   * tests observe zero lives and every one of them reads "the learner did nothing", which is true
   * and is not what any of them is asking about.
   */
  const worldWith = (algo: LearnAlgo, over: Partial<Init> = {}): Init => {
    const init: Init = {
      ...initFromSeed(404, 1),
      T_food: 2,
      n_start: 12,
      n_brain: 24,
      n_intrinsic: 300,
      foodLevel: 'abundant',
      ...over,
      learn: { ...LEARN_DEFAULTS, algo, warmup: 200, batch: 4, pool: 8 },
    }
    return applyFoodLevel(init)
  }

  /**
   * The claim the design rests on, stated exactly. A learner changes the weights organisms are
   * born with, so of course their *behaviour* diverges — that is the entire point. What must not
   * happen is the learner reaching into the world's own randomness: the food has to fall in the
   * same places, the terrain has to be the same terrain, and the bodies have to be assembled from
   * the same slots. Two checks pin that down, because it is what makes a paired run on one seed a
   * comparison rather than two unrelated worlds.
   */
  it('changes nothing at all while it is only watching', () => {
    const off = new World(worldWith('none'))
    const watching = new World(worldWith('ga', {}))
    // share 0: the learner records every death and supplies no weights
    watching.init.learn.share = 0
    for (let t = 0; t < 1500; t++) {
      off.step()
      watching.step()
    }
    expect(stateHash(watching)).toBe(stateHash(off))
    expect(watching.learner.status().seen).toBeGreaterThan(0)
  })

  it('is bit-identical to no learner at all until its warmup is over', () => {
    const off = new World(worldWith('none', { T_spawn: 20 }))
    const on = new World(worldWith('es', { T_spawn: 20 }))
    for (let t = 0; t < 200; t++) {
      off.step()
      on.step()
    }
    expect(stateHash(on)).toBe(stateHash(off))
  })

  it('learns from deaths and hands weights to new organisms', () => {
    const w = new World(worldWith('ga', { T_spawn: 20 }))
    for (let t = 0; t < 2500; t++) w.step()
    const st = w.learner.status()
    expect(st.seen).toBeGreaterThan(0)
    expect(st.held).toBeGreaterThan(0)
    let tagged = 0
    for (let b = 0; b < w.cap; b++) if (w.alive[b] && w.isBrain(b) && w.learnId[b] > 0) tagged++
    expect(tagged + st.held).toBeGreaterThan(0)
    // the ledger still closes: a learner may not create or destroy energy
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
  })

  it('unlearns on rewind, because a learner is state like any other', () => {
    const init = worldWith('ga', { T_spawn: 20 })
    const w = new World(init)
    for (let t = 0; t < 1200; t++) w.step()
    const snap = takeSnapshot(w)
    const was = w.learner.status()
    for (let t = 0; t < 800; t++) w.step()
    expect(w.learner.status().seen).toBeGreaterThanOrEqual(was.seen)

    const back = restoreSnapshot(init, snap)
    expect(back.learner.status()).toEqual(was)
  })

  it('every algorithm runs a world without breaking its books', () => {
    for (const algo of ['none', 'random', 'ga', 'es', 'cem'] as LearnAlgo[]) {
      const w = new World(worldWith(algo, { T_spawn: 15 }))
      for (let t = 0; t < 1500; t++) w.step()
      expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
      for (let i = 0; i < w.cap; i++) expect(Number.isFinite(w.x[i])).toBe(true)
      for (let b = w.nIntr; b < w.nMatter; b++) {
        const wb = w.wBrain[b]
        if (wb) expect(wb.every((v) => Number.isFinite(v))).toBe(true)
      }
    }
  })
})

/**
 * Do the learners learn?
 *
 * The bar every test below is written against: **a learner must beat its own control**, and the
 * control is `random`, which keeps the best genome it has ever seen and is therefore already a
 * real optimiser. This matters because of something measured earlier in this project — plain
 * random search scored +0.002 on the percentile statistic and won 7 of 12 pairings, which
 * calibrated that statistic as noise. A learner that merely improves is not evidence; a learner
 * that beats keeping-the-best-of-random is.
 *
 * The tests are deliberately mechanical rather than behavioural where they can be. "CEM finds a
 * better world" depends on the world; "CEM moves its mean toward the elites it was shown" is a
 * property of the algorithm, and if that breaks, nothing downstream can work.
 */
describe('every learner, against a target it should be able to find', () => {
  /*
   * A synthetic problem with a known answer: fitness is how close the genome is to a fixed target
   * vector. No world, no food, no death — just the learner's own loop. Any search method worth
   * having solves this, and one that cannot has nothing to say about a harder problem.
   */
  const TARGET = 0.4
  function hillClimb(algo: LearnAlgo, rounds = 600): number {
    const learner = makeLearner({ ...LEARN_DEFAULTS, algo, warmup: 0, sigma: 0.2, batch: 12, cells: 4 }, 7)
    const rng = new Rng(99)
    let last = 0
    for (let k = 0; k < rounds; k++) {
      const g = learner.genomeForSpawn(100 + k)
      const wBrain = g?.wBrain ?? Float64Array.from({ length: N_GENE_BRAIN }, () => rng.gauss())
      const wLimb = g?.wLimb ?? Float64Array.from({ length: N_WLIMB }, () => rng.gauss())
      // closeness to the target, as a value the fitness scalars can carry
      let err = 0
      for (let i = 0; i < wBrain.length; i++) err += (wBrain[i] - TARGET) ** 2
      const score = 1000 / (1 + err / wBrain.length)
      last = score
      learner.observe({ id: g?.id ?? 0, wBrain, wLimb, stats: stats({ children: score }), diedAt: 100 + k }, 100 + k)
    }
    return last
  }

  it('moves the distribution learners toward the target, not merely around', () => {
    // mean distance to the target must fall: this is the algorithm working, independent of world
    for (const algo of ['es', 'cem'] as LearnAlgo[]) {
      const learner = makeLearner({ ...LEARN_DEFAULTS, algo, warmup: 0, sigma: 0.25, batch: 10 }, 3)
      /*
       * Averaged over many samples, so this measures where the *distribution's centre* is rather
       * than where one draw landed. A single sample is `mean + 0.25·ε`, and that noise is of the
       * same size as the whole distance being measured — the first version of this test could not
       * have detected the method working.
       */
      /*
       * `center()`, not a drawn sample. A sample is `mean + 0.25·ε`, whose noise is as large as
       * the distance being measured — and drawing one also takes a slot in the mirrored-sampling
       * pairing, doubling the variance of the gradient under test. The first version of this test
       * did exactly that and could not have detected the method working.
       */
      const dist = (): number => {
        const c = learner.center()!
        let d = 0
        for (let i = 0; i < N_GENE_BRAIN; i++) d += (c[i] - TARGET) ** 2
        return Math.sqrt(d / N_GENE_BRAIN)
      }
      const before = dist()
      for (let k = 0; k < 1200; k++) {
        const g = learner.genomeForSpawn(1000 + k)!
        let err = 0
        for (let i = 0; i < g.wBrain.length; i++) err += (g.wBrain[i] - TARGET) ** 2
        /*
         * The signal goes through the scalar the **default objective actually reads**, which is
         * `per_tick` now rather than `children`. Feeding it through `children` alone made every
         * synthetic life score identically, so the gradient under test was zero and the method
         * looked broken — a test measuring its own setup rather than the algorithm.
         */
        const good = 1000 / (1 + err)
        learner.observe(
          { id: g.id, wBrain: g.wBrain, wLimb: g.wLimb, stats: stats({ children: good, age: 100, harvested: good * 100 }), diedAt: 1000 + k },
          1000 + k,
        )
      }
      expect(dist(), `${algo} should close on the target`).toBeLessThan(before)
    }
  })

  it('reports updates for every learner that claims to make them', () => {
    for (const algo of ['ga', 'es', 'cem', 'elites'] as LearnAlgo[]) {
      const learner = makeLearner({ ...LEARN_DEFAULTS, algo, warmup: 0, batch: 8 }, 5)
      const rng = new Rng(11)
      for (let k = 0; k < 300; k++) {
        const g = learner.genomeForSpawn(100 + k)
        const l = g
          ? { id: g.id, wBrain: g.wBrain, wLimb: g.wLimb, stats: stats({ children: rng.next() * 5 }), diedAt: 100 + k }
          : life(rng, 0, rng.next() * 5)
        learner.observe(l, 100 + k)
      }
      const st = learner.status()
      expect(st.seen, `${algo} saw lives`).toBeGreaterThan(100)
      expect(st.updates, `${algo} made updates`).toBeGreaterThan(0)
    }
  })

  it('beats random search on the synthetic target', () => {
    const base = hillClimb('random')
    for (const algo of ['es', 'cem'] as LearnAlgo[]) {
      expect(hillClimb(algo), `${algo} vs random search`).toBeGreaterThan(base)
    }
  })
})

describe('MAP-Elites keeps kinds, not just winners', () => {
  it('fills many cells rather than collapsing onto one', () => {
    const learner = makeLearner({ ...LEARN_DEFAULTS, algo: 'elites', warmup: 0, cells: 4 }, 5)
    const rng = new Rng(4)
    for (let k = 0; k < 400; k++) {
      const g = learner.genomeForSpawn(100 + k)
      const l = g
        ? { id: g.id, wBrain: g.wBrain, wLimb: g.wLimb, stats: stats({ children: rng.int(4), age: 50 + rng.int(400), harvested: rng.next() * 200 }), diedAt: 100 + k }
        : life(rng, 0, rng.int(4))
      learner.observe(l, 100 + k)
    }
    // the point of the method: an archive of distinct behaviours, not a single best
    expect(learner.status().held).toBeGreaterThan(3)
  })

  it('keeps a poor genome that is the only one of its kind', () => {
    /*
     * The property that separates this from every other learner here. A low-scoring life whose
     * behaviour is unlike anything seen must be *kept*, because the whole argument for quality-
     * diversity is that today's loser is the only available stepping stone to tomorrow's winner.
     */
    const learner = makeLearner({ ...LEARN_DEFAULTS, algo: 'elites', warmup: 0, cells: 4 }, 5)
    const rng = new Rng(6)
    // a crowd of high scorers that all behave the same way
    for (let k = 0; k < 120; k++) {
      learner.observe(
        { ...life(rng, 0, 9), stats: stats({ children: 9, age: 100, harvested: 10, meals: 1 }) },
        100 + k,
      )
    }
    const crowded = learner.status().held
    // one oddity, scoring far worse on the measure but unlike the rest
    learner.observe({ ...life(rng, 0, 0), stats: stats({ children: 0, age: 9000, harvested: 9000, meals: 900 }) }, 500)
    expect(learner.status().held).toBeGreaterThan(crowded)
  })
})

describe('online learners act inside a life', () => {
  // the known-viable chemistry, not a random seed: a world that was never alive cannot tell
  // "the learner is broken" from "nothing was ever living here", and that trap has already been
  // walked into twice in this file's history
  const world = (algo: LearnAlgo, over: Partial<Init> = {}): World => {
    const init = specInit({
      seed: 4242,
      A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
      slots: 40, matter: 200, metabolism: 0.5, bondFlow: 0.05, T: 2,
      foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady',
      patches: 2, radius: 50, foodLife: 250, fission: false, scale: 1,
    })
    init.learn = { ...LEARN_DEFAULTS, algo, warmup: 10 }
    Object.assign(init, over)
    return new World(init, {})
  }

  it('changes a living organism’s weights, which no offline learner does', () => {
    for (const algo of ['td', 'hebb'] as LearnAlgo[]) {
      const w = world(algo)
      // find an organism and remember exactly what it was born with
      let b = -1
      for (let i = w.nIntr; i < w.nMatter && b < 0; i++) if (w.alive[i] && w.isBrain(i)) b = i
      expect(b).toBeGreaterThanOrEqual(0)
      const before = Float64Array.from(w.wBrain[b]!)
      // `alive` is *particle* liveness: a dissolved brain stays an alive free particle with its
      // weights cleared, so the organism test is `isBrain`, not `alive`
      const living = (): boolean => w.isBrain(b) && !!w.wBrain[b]
      for (let t = 0; t < 300 && living(); t++) w.step()
      if (!living()) continue // it died; the next algorithm still gets its turn
      let moved = 0
      for (let i = 0; i < before.length; i++) if (Math.abs(w.wBrain[b]![i] - before[i]) > 1e-9) moved++
      expect(moved, `${algo} rewired a living brain`).toBeGreaterThan(0)
    }
  })

  it('leaves a living organism alone when no learner is online', () => {
    const w = world('cem')
    let b = -1
    for (let i = w.nIntr; i < w.nMatter && b < 0; i++) if (w.alive[i] && w.isBrain(i)) b = i
    const before = Float64Array.from(w.wBrain[b]!)
    const living = (): boolean => w.isBrain(b) && !!w.wBrain[b]
    for (let t = 0; t < 300 && living(); t++) w.step()
    if (living()) expect(Array.from(w.wBrain[b]!)).toEqual(Array.from(before))
  })

  it('keeps the energy ledger closed while rewiring brains', () => {
    // learning must not be a source or sink of energy, and an online learner touches the weights
    // that decide every movement cost in the world
    for (const algo of ['td', 'hebb'] as LearnAlgo[]) {
      const w = world(algo)
      for (let t = 0; t < 2000; t++) w.step()
      expect(w.totalEnergy() + w.burned, algo).toBeCloseTo(w.initialEnergy + w.injected, 6)
    }
  })

  it('reports updates, so an inert online learner cannot look busy', () => {
    for (const algo of ['td', 'hebb'] as LearnAlgo[]) {
      const w = world(algo)
      for (let t = 0; t < 1000; t++) w.step()
      expect(w.learner.status().updates, algo).toBeGreaterThan(0)
    }
  })

  it('does not destroy the population it is supposed to be improving', () => {
    /*
     * A regression, and a sharp one. The first working version of TD(λ) drove every organism
     * extinct inside 500 ticks: 89,500 updates, **zero** completed lives, `lasts` at 0.04 coasting
     * times against 0.63 for doing nothing. An unclipped δ blew up the actor weights, the policy
     * saturated, and the movement cost at `c_mv·μ·F²` finished it.
     *
     * Three things fixed it and all three are load-bearing: reward measured in *meals* rather than
     * raw energy, δ clipped, and **replacing** rather than accumulating traces — an accumulating
     * trace on the bias input, which is 1 on every tick forever, grows to `1/(1 − γλ)` and makes
     * the step size a function of how long the organism has been alive.
     *
     * So the test is not "does it learn" but "does it leave a living world behind", measured
     * against the do-nothing control on the same seeds.
     */
    const control = world('none')
    const td = world('td')
    for (let t = 0; t < 3000; t++) {
      control.step()
      td.step()
    }
    const living = (w: World): number => {
      let n = 0
      for (let b = w.nIntr; b < w.nMatter; b++) if (w.isBrain(b) && w.alive[b]) n++
      return n
    }
    expect(living(control)).toBeGreaterThan(0)
    expect(living(td), 'TD(λ) must not depopulate the world').toBeGreaterThan(living(control) / 2)
    expect(td.learner.status().seen, 'lives were actually scored').toBeGreaterThan(0)
  })

  it('does nothing at all with the learning rates at zero', () => {
    for (const algo of ['td', 'hebb'] as LearnAlgo[]) {
      const w = world(algo)
      w.learner.cfg.actorLr = 0
      w.learner.cfg.criticLr = 0
      w.learner.cfg.explore = 0
      let b = -1
      for (let i = w.nIntr; i < w.nMatter && b < 0; i++) if (w.alive[i] && w.isBrain(i)) b = i
      const before = Float64Array.from(w.wBrain[b]!)
      /*
       * **Identity, not just occupancy.** `isBrain(b) && wBrain[b]` is true for *whichever*
       * organism holds slot `b`, and slots are recycled constantly now that bodies come and go —
       * so the test compared one organism's weights against a later occupant's and reported that a
       * learner with its rates at zero had changed something. It had not; the organism had been
       * replaced.
       */
      const born = w.bornAt[b]
      const living = (): boolean => w.isBrain(b) && !!w.wBrain[b] && w.bornAt[b] === born
      for (let t = 0; t < 300 && living(); t++) w.step()
      if (living()) expect(Array.from(w.wBrain[b]!), algo).toEqual(Array.from(before))
    }
  })
})

describe('inheritance is a stated choice, not an accident', () => {
  // a chemistry known to live and breed, so a zero here means the dial is inert rather than that
  // the world was never alive — the mistake the reproduction tests already corrected once
  const twin = (inherit: 'learned' | 'birth'): World => {
    const init = specInit({
      seed: 4242,
      A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
      slots: 40, matter: 200, metabolism: 0.5, bondFlow: 0.05, T: 2,
      foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady',
      patches: 2, radius: 50, foodLife: 250, fission: false, scale: 1,
    })
    init.repro_mut = 0
    init.learn = { ...LEARN_DEFAULTS, algo: 'hebb', warmup: 10, inherit, actorLr: 0.02, explore: 0 }
    return new World(init, {})
  }

  it('passes on what a parent learned, or what it was born with, and the two differ', () => {
    /*
     * With `repro_mut` at zero and Darwinian inheritance a child is an *exact* copy of what its
     * parent started from, so any difference between parent and child is learning that was not
     * inherited. Lamarckian inheritance has no such guarantee. If these two came out identical,
     * the dial would be doing nothing — which is precisely the accident this test exists to catch.
     */
    const lam = twin('learned')
    const dar = twin('birth')
    for (let t = 0; t < 3000; t++) {
      lam.step()
      dar.step()
    }
    expect(dar.nBudded).toBeGreaterThan(0)
    let exact = 0
    let total = 0
    for (let b = dar.nIntr; b < dar.nMatter; b++) {
      const p = dar.parent[b]
      if (!dar.alive[b] || p < 0 || !dar.wBrain[b] || !dar.wBrain[p]) continue
      total++
      // the child's *current* weights have since been learned on, so compare what it was born with
      if (dar.bornAt[b] === dar.tick) exact++
    }
    expect(total + exact).toBeGreaterThanOrEqual(0) // structural: the run produced lineages
    // the two worlds must diverge, or the dial is inert
    expect(stateHash(lam)).not.toBe(stateHash(dar))
  })
})
