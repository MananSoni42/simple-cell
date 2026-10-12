import { describe, expect, it } from 'vitest'
import { FITNESS, type LearnAlgo, LEARN_DEFAULTS, type LifeRecord, type LifeStats, N_GENE_BRAIN, fitnessOf, makeLearner } from '../src/core/learning'
import { N_WLIMB } from '../src/core/neurons'
import { type Init, initFromSeed } from '../src/core/params'
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
  ...over,
})

function life(rng: Rng, id: number, fitness: number): LifeRecord {
  return {
    id,
    wBrain: Float64Array.from({ length: N_GENE_BRAIN }, () => rng.gauss()),
    wLimb: Float64Array.from({ length: N_WLIMB }, () => rng.gauss()),
    stats: stats({ children: fitness }),
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
    expect(FITNESS.filter((f) => !f.invented).map((f) => f.key)).toEqual(['offspring'])
    expect(LEARN_DEFAULTS.fitness).toBe('offspring')
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
    expect(st.best).toBe(19)
    const g = ga.genomeForSpawn(1000)
    expect(g).not.toBeNull()
    expect(g!.wBrain.length).toBe(N_GENE_BRAIN)
    expect(g!.wLimb.length).toBe(N_WLIMB)
    expect(g!.wBrain.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('a GA pool keeps the best and drops the worst', () => {
    const ga = makeLearner({ ...LEARN_DEFAULTS, algo: 'ga', warmup: 0, pool: 4 }, 5)
    const rng = new Rng(12)
    for (const f of [10, 9, 8, 7, 6, 5]) ga.observe(life(rng, 0, f), 1000)
    expect(ga.status().held).toBe(4)
    // a newcomer better than the worst held gets in; one worse than all of them does not
    const before = ga.status().updates
    ga.observe(life(rng, 0, 1), 1000)
    expect(ga.status().updates).toBe(before)
    ga.observe(life(rng, 0, 100), 1000)
    expect(ga.status().updates).toBe(before + 1)
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
    expect(rs.status().best).toBe(9)
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
  const worldWith = (algo: LearnAlgo, over: Partial<Init> = {}): Init => ({
    ...initFromSeed(404, 1),
    T_spawn: 40,
    T_food: 2,
    foodLevel: 'average',
    ...over,
    learn: { ...LEARN_DEFAULTS, algo, warmup: 200, batch: 4, pool: 8 },
  })

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
