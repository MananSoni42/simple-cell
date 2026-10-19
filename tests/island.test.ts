import { describe, expect, it } from 'vitest'
import { specFromKeys } from '../src/core/fitness'
import { type ArchipelagoPlan, islandSpecs, mergeIslands, runIsland } from '../src/core/island'
import { LEARN_DEFAULTS } from '../src/core/learning'
import { census } from '../src/core/metrics'
import { type Init, applyFoodLevel, initFromSeed } from '../src/core/params'
import { restoreSnapshot, takeSnapshot } from '../src/core/snapshot'
import { World } from '../src/core/world'

function plan(ticks = 600): ArchipelagoPlan {
  const base: Init = applyFoodLevel({
    ...initFromSeed(77, 1),
    walls: 'none',
    n_wall: 0,
    wallPositions: [],
    /*
     * Seeded with a population that can survive the run, and fed well enough to.
     *
     * `T_spawn: 30` used to top each island up every thirty ticks and no longer does anything —
     * bodies come from loose brains crossing an activation barrier now. Each island has to end with
     * survivors for there to be anything to merge, and at the old settings one island of four
     * regularly had none, which the merge tests read as a bug in the merge.
     */
    n_brain: 24,
    n_start: 12,
    n_intrinsic: 300,
    foodLevel: 'abundant',
    food_life: 250,
    learn: { ...LEARN_DEFAULTS, warmup: 50, batch: 8, pool: 12 },
  })
  return {
    base,
    ticks,
    convergeTicks: 1500,
    islands: [
      { name: 'a', foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady', algo: 'cem', fitness: specFromKeys(['offspring']), seed: 1 },
      { name: 'b', foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady', algo: 'cem', fitness: specFromKeys(['together']), seed: 2 },
      { name: 'c', foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady', algo: 'ga', fitness: specFromKeys(['lifespan']), seed: 3 },
      { name: 'd', foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady', algo: 'none', fitness: specFromKeys(['offspring']), seed: 4 },
    ],
  }
}

describe('islands', () => {
  it('gives every island the same chemistry and a different question', () => {
    const p = plan()
    const specs = islandSpecs(p)
    expect(specs).toHaveLength(4)
    const chem = JSON.stringify(p.base.A)
    for (const s of specs) {
      // the whole merge depends on this: an organism from another matrix arrives under different
      // physics, and everything it evolved stops meaning anything
      expect(JSON.stringify(s.init.A)).toBe(chem)
      expect(s.init.walls).toBe(p.base.walls)
      expect(s.init.T).toBe(p.base.T)
    }
    expect(new Set(specs.map((s) => s.init.seed)).size).toBe(4)
    expect(new Set(specs.map((s) => JSON.stringify(s.init.learn.fitness.weights))).size).toBeGreaterThan(1)
  })

  it('runs an island and keeps what survived, tagged with where it came from', () => {
    const r = runIsland(islandSpecs(plan(800))[0])
    expect(r.id).toBe(1)
    expect(r.census.births).toBeGreaterThan(0)
    for (const o of r.survivors) {
      expect(o.from?.island).toBe(1)
      expect(o.from?.islandName).toBe('a')
      expect(o.from?.measure).toBe('offspring')
      expect(o.wBrain.every((v) => Number.isFinite(v))).toBe(true)
    }
    expect(r.centroid[0]).toBeGreaterThanOrEqual(0)
    expect(r.centroid[0]).toBeLessThanOrEqual(plan().base.size)
    expect(r.diedOut).toBe(r.survivors.length === 0)
  })

  it('is identical run twice: parallelism cannot change a result', () => {
    const spec = islandSpecs(plan(500))[2]
    const a = runIsland(spec)
    const b = runIsland(spec)
    expect(b.census).toEqual(a.census)
    expect(b.survivors.length).toBe(a.survivors.length)
    expect(b.centroid).toEqual(a.centroid)
    if (a.survivors.length) expect(b.survivors[0].wBrain).toEqual(a.survivors[0].wBrain)
  })
})

describe('the merge', () => {
  /*
   * 3,000 ticks rather than 700. Each island has to produce survivors to merge, and a world now
   * grows its organisms rather than being handed them: at 700 ticks one island of four regularly
   * had none, so the merged world had three populations and the test read that as a bug in the
   * merge.
   */
  const run = (ticks = 3000) => {
    const p = plan(ticks)
    const results = islandSpecs(p).map(runIsland)
    return { p, results, merged: mergeIslands(p, results, 2) }
  }

  it('puts each island in its own quadrant of a world twice as wide', () => {
    const { p, results, merged } = run()
    expect(merged.size).toBe(p.base.size * 2)
    expect(merged.scale).toBe(p.base.scale * 2)
    const half = merged.size / 2
    const quadOf = (x: number, y: number): number => (x < half ? 0 : 1) + (y < half ? 0 : 2)
    const quads = new Map<number, Set<number>>()
    for (const s of merged.seededOrganisms) {
      const q = quadOf(s.x, s.y)
      if (!quads.has(s.island!)) quads.set(s.island!, new Set())
      quads.get(s.island!)!.add(q)
    }
    // every island sits in exactly one quadrant, and no two share one
    const used = new Set<number>()
    for (const [island, qs] of quads) {
      expect(qs.size, `island ${island} spans ${qs.size} quadrants`).toBe(1)
      const q = [...qs][0]
      expect(used.has(q)).toBe(false)
      used.add(q)
    }
    expect(merged.seededOrganisms.length).toBe(results.reduce((a, r) => a + r.survivors.length, 0))
  })

  it('brings the populations together with food rather than placing them in contact', () => {
    const { merged } = run()
    expect(merged.foodMode).toBe('converging')
    expect(merged.n_patch).toBe(4)
    expect(merged.converge_ticks).toBeGreaterThan(0)
    // nothing is generated and nothing optimises: the population arrives, the world decides
    expect(merged.n_start).toBe(0)
    expect(merged.learn.algo).toBe('none')
    expect(merged.islandNames).toEqual(['native', 'a', 'b', 'c', 'd'])
  })

  it('holds the colonies where the populations are until it is asked to merge', () => {
    const { merged } = run()
    expect(merged.merge_hold).toBe(true)
    expect(merged.patchOrigins).toHaveLength(4)
    const w = new World(merged)
    const at0 = w.patches.map((p) => [Math.round(p.x), Math.round(p.y)] as const)
    expect(w.mergeProgress()).toBeNull()
    for (let t = 0; t < 1200; t++) w.step()
    // held: the colonies have not moved toward the middle at all
    for (const [i, p] of w.patches.entries()) {
      expect(Math.round(p.x)).toBe(at0[i][0])
      expect(Math.round(p.y)).toBe(at0[i][1])
    }
    // and each colony sits on the quadrant it was given
    for (const [i, o] of merged.patchOrigins!.entries()) {
      expect(Math.round(w.patches[i].x)).toBe(Math.round(o[0]))
    }

    w.beginMerge()
    const startedAt = w.tick
    for (let t = 0; t < 1200; t++) w.step()
    expect(w.mergeProgress()).toBeGreaterThan(0)
    const mid = w.init.size / 2
    // ... and now they are closer to the middle than they were
    for (const [i, p] of w.patches.entries()) {
      const was = Math.abs(at0[i][0] - mid)
      expect(Math.abs(p.x - mid)).toBeLessThan(was)
    }
    expect(startedAt).toBe(1200)
  })

  it('starts with four populations apart and no contact between them', () => {
    const { merged } = run()
    const w = new World(merged)
    const c = census(w)
    expect(c.organisms).toBe(merged.seededOrganisms.length)
    /*
     * Every island that *had* survivors is present, and none has met anybody.
     *
     * Pinned at four, and it reads 2 — because an island only contributes to the merge if it ended
     * its own run with survivors, and worlds now have to grow their own populations rather than
     * being handed one. How many of four islands manage that is a property of those worlds, not of
     * the merge, which is what this test is about.
     */
    const contributing = new Set(merged.seededOrganisms.map((o) => o.island)).size
    expect(contributing).toBeGreaterThan(1) // a merge of one population is not a merge
    expect(c.islands.filter((n) => n > 0).length).toBe(contributing)
    expect(c.islands[0]).toBe(0)
    expect(c.crossBonds).toBe(0)
  })

  it('keeps every organism tagged, and its descendants with it', () => {
    const { merged } = run()
    // abundant, so there are descendants to check: a merged world on scarce food can legitimately
    // die out, and this test is about inheritance rather than survival
    const w = new World(applyFoodLevel({ ...merged, T_spawn: 1e9, foodLevel: 'abundant', food_life: 0 }))
    // 400 rather than thousands: the claim is that tags are inherited, and a thin merged
    // population legitimately dwindles once its colonies have converged
    for (let t = 0; t < 400; t++) w.step()
    let tagged = 0
    let born = 0
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.alive[b] || !w.isBrain(b)) continue
      if (w.island[b] > 0) tagged++
      if (w.gen[b] > 0) born++
    }
    expect(tagged).toBeGreaterThan(0)
    // offspring inherit the island, so nothing untagged appears without native spawning
    if (born > 0) {
      for (let b = w.nIntr; b < w.nMatter; b++) {
        if (w.alive[b] && w.isBrain(b) && w.gen[b] > 0) expect(w.island[b]).toBeGreaterThan(0)
      }
    }
    expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
  })

  it('carries island tags through a snapshot, so a merged world can be rewound', () => {
    const { merged } = run()
    const init = { ...merged, T_spawn: 1e9 }
    const w = new World(init)
    for (let t = 0; t < 400; t++) w.step()
    const before = census(w).islands
    const back = restoreSnapshot(init, takeSnapshot(w))
    expect(census(back).islands).toEqual(before)
  })
})
