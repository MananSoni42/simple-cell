import { describe, expect, it } from 'vitest'
import { LEVELS } from '../src/core/ladder'
import { N_TRI, TRI, type WorldSpec, best, matrixOf, parseCatalog, rank, specId, specInit, triOf } from '../src/core/catalog'
import { evaluate, evaluateSeeds } from '../src/core/evaluate'
import { chemistryShape, summarise } from '../src/core/analyse'
import { QUANTA } from '../src/core/params'
import { BRAIN_ROW, FOOD_ROW, N_MATRIX } from '../src/core/types'

const spec = (over: Partial<WorldSpec> = {}): WorldSpec => ({
  seed: 42,
  // padded to the matrix's current width, so this fixture does not have to be rewritten every
  // time the chemistry gains a row. The first fourteen are a real spec from the catalog.
  A: [...[0.5, -0.5, 0.5, 0, 0.25, -1, 1, 0, 0.5, -0.25, 0.5, 1, 0, 0.5], ...new Array(Math.max(0, N_TRI - 14)).fill(0.25)],
  slots: 24,
  matter: 120,
  metabolism: 0.5,
  bondFlow: 0.05,
  T: 2,
  foodMode: 'patchy',
  foodLevel: 'average',
  foodRegime: 'steady',
  patches: 2,
  radius: 50,
  foodLife: 250,
  fission: true,
  scale: 1,
  ...over,
})

describe('a world spec', () => {
  it('covers the whole matrix except the one entry that is always zero', () => {
    // every pair once, lower triangle, minus Food x Food. 20 with Brain in the matrix, 14 without
    expect(TRI).toHaveLength((N_MATRIX * (N_MATRIX + 1)) / 2 - 1)
    expect(N_TRI).toBe(TRI.length)
    const seen = new Set(TRI.map(([i, j]) => `${i},${j}`))
    expect(seen.size).toBe(TRI.length)
    expect(seen.has(`${FOOD_ROW},${FOOD_ROW}`)).toBe(false)
    expect(seen.has(`${BRAIN_ROW},${BRAIN_ROW}`)).toBe(true) // brain-to-brain chemistry is allowed
  })

  it('keeps the first fourteen entries where they have always been', () => {
    /*
     * The compatibility guarantee, as an assertion. Brain is appended at the end of the matrix
     * rather than slotted in at its type index, so the lower triangle's first fourteen entries are
     * still the P1..P4 and Food block in the same order. Every spec in the catalog, every preset
     * and every saved config therefore keeps its meaning, and a 14-entry matrix leaves the six
     * Brain couplings at zero — which is exactly the physics those worlds were measured under.
     */
    const old14 = [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5]
    const A = matrixOf(old14)
    expect(triOf(A).slice(0, 14)).toEqual(old14)
    expect(triOf(A).slice(14).every((v) => v === 0)).toBe(true)
    for (const [i, j] of TRI.slice(0, 14)) expect(Math.max(i, j)).toBeLessThan(BRAIN_ROW)
  })

  it('round-trips through a matrix, staying symmetric and quantized', () => {
    const A = matrixOf(spec().A)
    expect(A[FOOD_ROW][FOOD_ROW]).toBe(0)
    for (let i = 0; i < N_MATRIX; i++) {
      for (let j = 0; j < N_MATRIX; j++) {
        expect(A[i][j]).toBe(A[j][i])
        expect(QUANTA as readonly number[]).toContain(A[i][j])
      }
    }
    expect(triOf(A)).toEqual(spec().A.map((v) => v))
  })

  it('builds the same world every time, and a different one for any change', () => {
    const a = specInit(spec())
    const b = specInit(spec())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(specInit(spec({ metabolism: 0.25 })))).not.toBe(JSON.stringify(a))
  })

  it('gives a stable id that changes with any field', () => {
    const base = specId(spec())
    expect(specId(spec())).toBe(base)
    expect(base.length).toBeGreaterThan(8)
    const changed: Partial<WorldSpec>[] = [
      { seed: 43 },
      { slots: 25 },
      { metabolism: 0.51 },
      { bondFlow: 0 },
      { foodMode: 'spring' },
      { fission: false },
      { A: [...spec().A.slice(0, 13), 0.25] },
    ]
    const ids = new Set(changed.map((c) => specId(spec(c))))
    expect(ids.has(base)).toBe(false)
    expect(ids.size).toBe(changed.length)
  })
})

describe('evaluating a candidate', () => {
  it('scores a world and reports why it stopped', () => {
    const r = evaluate(spec(), { ticks: 1200, maxExtend: 1, plateauFrac: 0 })
    expect(r.ticks).toBeLessThanOrEqual(1200)
    // one ratio per rung. The count is not pinned to a number here on purpose: the ladder went
    // from 13 rungs to 9 when it moved from measuring organisation to measuring intelligence, and
    // a test that fails on *that* is a test of a magic number rather than of the evaluator.
    expect(r.ratios.length).toBeGreaterThanOrEqual(LEVELS.length)
    expect(r.ratios.every((x) => Number.isFinite(x) && x >= 0)).toBe(true)
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(['done', 'extinct', 'plateau', 'extended']).toContain(r.stop)
  })

  it('stops early on a world that cannot sustain anything', () => {
    // no food at all, and nothing new arriving: it can only die
    const dead = evaluate(spec({ foodLevel: 'scarce', foodMode: 'spring', radius: 10, metabolism: 4 }), {
      ticks: 20000,
      maxExtend: 1,
      plateauFrac: 0.25,
      every: 100,
    })
    expect(dead.ticks).toBeLessThan(20000)
    expect(['extinct', 'plateau']).toContain(dead.stop)
  })

  it('may run past its horizon when a world is still climbing', () => {
    const r = evaluate(spec(), { ticks: 600, maxExtend: 3, plateauFrac: 0, every: 100 })
    expect(r.ticks).toBeGreaterThanOrEqual(600)
    expect(r.ticks).toBeLessThanOrEqual(1800)
    if (r.ticks > 600) expect(r.stop).toBe('extended')
  })

  it('is reproducible, and medians over seeds', () => {
    const a = evaluate(spec(), { ticks: 800, maxExtend: 1, plateauFrac: 0 })
    const b = evaluate(spec(), { ticks: 800, maxExtend: 1, plateauFrac: 0 })
    expect(b.score).toBe(a.score)
    const many = evaluateSeeds(spec(), { ticks: 800, maxExtend: 1, plateauFrac: 0 }, 3)
    expect(many.seeds).toBe(3)
    expect(many.ratios).toHaveLength(a.ratios.length)
  })
})

describe('the catalog', () => {
  const row = (id: string, phase: number, score: number, level: number) =>
    ({ id, spec: spec(), phase, ms: 1, ticks: 100, stop: 'done', level, score, ratios: [1], seeds: 1, at: 0, stats: {} } as never)

  it('keeps the latest phase for a world, whatever it scored', () => {
    const rows = [row('a', 1, 9, 3), row('a', 3, 4, 1), row('b', 1, 5, 2)]
    const got = best(rows)
    expect(got).toHaveLength(2)
    // phase 3 ran longer with more seeds, so it wins even though it scored lower
    expect(got.find((e) => e.id === 'a')!.phase).toBe(3)
  })

  it('ranks by level first, then score', () => {
    const got = rank([row('a', 1, 9, 1), row('b', 1, 2, 4), row('c', 1, 5, 4)])
    expect(got.map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('survives a half-written final line, which is what an interrupted run leaves', () => {
    const good = JSON.stringify({ id: 'x', spec: spec(), phase: 1, level: 0, score: 1, ratios: [], stop: 'done', ms: 1, ticks: 1, seeds: 1, at: 0, stats: {} })
    const text = `{"kind":"simplecell-catalog","version":1,"startedAt":0,"note":"t"}\n${good}\n{"id":"y","spec`
    const { header, entries } = parseCatalog(text)
    expect(header?.kind).toBe('simplecell-catalog')
    expect(entries).toHaveLength(1)
  })
})

describe('analysis', () => {
  it('describes the shape of a chemistry', () => {
    const s = chemistryShape(spec())
    expect(s.nonzero).toBeGreaterThan(0)
    expect(s.meanAbs).toBeGreaterThan(0)
    expect(s.foodSpread).toBeGreaterThanOrEqual(0)
  })

  it('refuses to report a factor from too few worlds', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `i${i}`, spec: spec({ seed: i }), phase: 1, ms: 1, ticks: 10, stop: 'done', level: 0,
      score: i, ratios: [], seeds: 1, at: 0, stats: {},
    })) as never[]
    const s = summarise(rows)
    expect(s.worlds).toBe(10)
    // every cell here has ten worlds or fewer, which is below the floor, so nothing is claimed
    for (const f of [...s.factors.dials, ...s.factors.couplings, ...s.factors.shapes]) {
      expect(f.cells.every((c) => c.n >= 30)).toBe(true)
    }
  })
})
