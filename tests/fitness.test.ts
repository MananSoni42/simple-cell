import { describe, expect, it } from 'vitest'
import {
  COMBINERS,
  Cohort,
  FITNESS,
  type FitnessKey,
  type LifeStats,
  N_SCALARS,
  describeSpec,
  isImplicitOnly,
  keysOf,
  normalised,
  scalarsOf,
  specFromKeys,
} from '../src/core/fitness'
import { LEARN_DEFAULTS, makeLearner } from '../src/core/learning'
import { N_WLIMB } from '../src/core/neurons'
import { Rng } from '../src/core/rng'

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

const vec = (over: Partial<LifeStats> = {}): Float64Array => scalarsOf(stats(over))

describe('one number from several measures', () => {
  it('turns wildly different scales into comparable percentiles', () => {
    const c = new Cohort(64)
    // lifespan in the thousands, offspring in single figures: raw values are incomparable
    for (let i = 0; i < 40; i++) c.push(vec({ age: i * 100, children: i % 5 }))
    const low = c.percentile(FITNESS.findIndex((f) => f.key === 'lifespan'), 0)
    const high = c.percentile(FITNESS.findIndex((f) => f.key === 'lifespan'), 1e9)
    expect(low).toBeGreaterThan(0)
    expect(low).toBeLessThan(0.1)
    expect(high).toBeGreaterThan(0.9)
    expect(high).toBeLessThan(1)
  })

  it('never returns exactly zero, which would annihilate a geometric mean', () => {
    const c = new Cohort(32)
    for (let i = 0; i < 32; i++) c.push(vec({ children: 5 }))
    const i = FITNESS.findIndex((f) => f.key === 'offspring')
    expect(c.percentile(i, -1e9)).toBeGreaterThan(0)
    expect(c.percentile(i, 1e9)).toBeLessThan(1)
  })

  it('gives tied lives the same percentile, by midrank', () => {
    const c = new Cohort(64)
    // the common case: seven in ten organisms leave no children at all
    for (let i = 0; i < 70; i++) c.push(vec({ children: 0 }))
    for (let i = 0; i < 30; i++) c.push(vec({ children: 3 }))
    const i = FITNESS.findIndex((f) => f.key === 'offspring')
    const a = c.percentile(i, 0)
    const b = c.percentile(i, 0)
    expect(a).toBe(b)
    expect(c.percentile(i, 3)).toBeGreaterThan(a)
  })

  it('is unmoved by an outlier that would wreck a z-score', () => {
    const fair = new Cohort(64)
    const skewed = new Cohort(64)
    for (let i = 0; i < 40; i++) {
      const v = vec({ harvested: 10 + i, moved: 100 })
      fair.push(v)
      skewed.push(v)
    }
    // one organism that barely moved: efficiency = harvested / moved explodes
    skewed.push(vec({ harvested: 400, moved: 1 }))
    const i = FITNESS.findIndex((f) => f.key === 'efficiency')
    const probe = 30 / 100
    expect(Math.abs(fair.percentile(i, probe) - skewed.percentile(i, probe))).toBeLessThan
      (0.05)
  })

  it('handles negative net energy without a special case', () => {
    const c = new Cohort(32)
    for (let i = 0; i < 20; i++) c.push(vec({ harvested: 10, spent: i * 5 })) // net from +10 to -85
    const i = FITNESS.findIndex((f) => f.key === 'net')
    expect(c.percentile(i, -200)).toBeLessThan(0.1)
    expect(c.percentile(i, 100)).toBeGreaterThan(0.9)
  })

  it('combines many measures, and each combiner means what it says', () => {
    const c = new Cohort(64)
    const keys: FitnessKey[] = ['offspring', 'together']
    // a population where some are good at one thing and some at the other
    for (let i = 0; i < 30; i++) c.push(vec({ children: i % 6, orderTicks: (29 - i) * 10 }))

    const lopsided = vec({ children: 5, orderTicks: 0 }) // excellent at one, worst at the other
    const even = vec({ children: 2, orderTicks: 150 }) // middling at both

    const sum = specFromKeys(keys, 'sum')
    const geo = specFromKeys(keys, 'geometric')
    const cheb = specFromKeys(keys, 'chebyshev')

    // a sum lets a strong measure pay for a weak one; the other two do not
    expect(c.score(lopsided, sum)).toBeGreaterThan(c.score(lopsided, geo))
    expect(c.score(even, geo)).toBeGreaterThan(c.score(lopsided, geo))
    expect(c.score(even, cheb)).toBeGreaterThan(c.score(lopsided, cheb))
    for (const spec of [sum, geo, cheb]) {
      for (const v of [lopsided, even]) {
        const s = c.score(v, spec)
        expect(Number.isFinite(s)).toBe(true)
        expect(s).toBeGreaterThan(0)
      }
    }
  })

  it('reduces to a single measure exactly when only one is selected', () => {
    const c = new Cohort(64)
    for (let i = 0; i < 30; i++) c.push(vec({ children: i % 7 }))
    const one = vec({ children: 4 })
    const i = FITNESS.findIndex((f) => f.key === 'offspring')
    const p = c.percentile(i, one[i])
    for (const combine of COMBINERS.map((x) => x.key)) {
      expect(c.score(one, specFromKeys(['offspring'], combine))).toBeCloseTo(p, 9)
    }
  })

  it('keeps weights normalised and describes itself in words', () => {
    const spec = specFromKeys(['offspring', 'lifespan', 'together'], 'geometric')
    expect(keysOf(spec)).toEqual(['offspring', 'lifespan', 'together'])
    expect(normalised(spec).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    expect(describeSpec(spec)).toBe('offspring + lifespan + togetherness (all of them)')
    expect(isImplicitOnly(spec)).toBe(false)
    expect(isImplicitOnly(specFromKeys(['offspring']))).toBe(true)
  })

  it('round-trips a cohort through a snapshot', () => {
    const a = new Cohort(32)
    const rng = new Rng(5)
    for (let i = 0; i < 50; i++) a.push(vec({ children: rng.int(6), age: rng.int(900) }))
    const buf = new Float64Array(a.saveSize())
    a.saveInto(buf, 0)
    const b = new Cohort(32)
    b.loadFrom(buf, 0)
    expect(b.size).toBe(a.size)
    const probe = vec({ children: 3, age: 400 })
    for (let i = 0; i < N_SCALARS; i++) expect(b.percentile(i, probe[i])).toBe(a.percentile(i, probe[i]))
  })
})

describe('changing what counts, mid-run', () => {
  const life = (rng: Rng, id: number, over: Partial<LifeStats>) => ({
    id,
    wBrain: Float64Array.from({ length: 290 }, () => rng.gauss()),
    wLimb: Float64Array.from({ length: N_WLIMB }, () => rng.gauss()),
    stats: stats(over),
    diedAt: 1000,
  })

  it('re-scores a GA pool instead of discarding it', () => {
    const ga = makeLearner({ ...LEARN_DEFAULTS, algo: 'ga', warmup: 0, pool: 8, fitness: specFromKeys(['offspring']) }, 3)
    const rng = new Rng(9)
    // lives that are good at offspring and bad at togetherness, and the reverse
    for (let i = 0; i < 20; i++) ga.observe(life(rng, 0, { children: i % 6, orderTicks: (19 - i) * 7 }), 1000)
    const held = ga.status().held
    expect(held).toBe(8)

    ga.retarget(specFromKeys(['together']))
    const after = ga.status()
    expect(after.held).toBe(held) // the pool survived
    expect(keysOf(after.spec)).toEqual(['together'])
    expect(after.fitness).toBe('togetherness')
    // and it can still breed from it
    expect(ga.genomeForSpawn(1000)).not.toBeNull()
  })

  it('re-scores an in-flight ES batch rather than wasting it', () => {
    const es = makeLearner({ ...LEARN_DEFAULTS, algo: 'es', warmup: 0, batch: 6, fitness: specFromKeys(['offspring']) }, 11)
    const rng = new Rng(13)
    const ids = Array.from({ length: 3 }, () => es.genomeForSpawn(10)!.id)
    for (const [k, id] of ids.entries()) es.observe(life(rng, id, { children: k }), 20)
    expect(es.status().updates).toBe(0) // batch half full

    es.retarget(specFromKeys(['lifespan', 'together'], 'sum'))
    // the remaining three complete the batch under the new measure, and it still updates
    const more = Array.from({ length: 3 }, () => es.genomeForSpawn(30)!.id)
    for (const [k, id] of more.entries()) es.observe(life(rng, id, { age: 100 + k * 50, orderTicks: k * 20 }), 40)
    expect(es.status().updates).toBe(1)
  })

  it('reports every scalar, not just the ones being optimised', () => {
    const l = makeLearner({ ...LEARN_DEFAULTS, algo: 'ga', warmup: 0, fitness: specFromKeys(['offspring']) }, 17)
    const rng = new Rng(19)
    for (let i = 0; i < 12; i++) l.observe(life(rng, 0, { children: 2, orderTicks: 40, meals: 9 }), 100)
    const st = l.status()
    expect(st.means.length).toBe(N_SCALARS)
    expect(st.means[FITNESS.findIndex((f) => f.key === 'together')]).toBeCloseTo(40, 6)
    expect(st.means[FITNESS.findIndex((f) => f.key === 'meals')]).toBeCloseTo(9, 6)
    expect(st.cohort).toBe(12)
  })

  it('keeps a bounded progress history for the graph', () => {
    const l = makeLearner({ ...LEARN_DEFAULTS, algo: 'cem', warmup: 0, batch: 4 }, 23)
    const rng = new Rng(29)
    for (let i = 0; i < 2000; i++) {
      const g = l.genomeForSpawn(i)
      l.observe(life(rng, g?.id ?? 0, { children: i % 5 }), i)
    }
    const h = l.status().history
    expect(h.recent.length).toBeGreaterThan(10)
    expect(h.recent.length).toBeLessThanOrEqual(96)
    expect(h.best.length).toBe(h.recent.length)
    expect(h.tick.length).toBe(h.recent.length)
    // oldest first, so a graph can be drawn straight from it
    expect(h.tick[0]).toBeLessThan(h.tick[h.tick.length - 1])
    expect(h.recent.every((v) => v >= 0 && v <= 1)).toBe(true)
  })
})
