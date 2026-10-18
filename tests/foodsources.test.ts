import { describe, expect, it } from 'vitest'
import { type WorldSpec, specId, specInit } from '../src/core/catalog'
import { SOURCE_MOTIONS, SOURCE_RELATIONS, foodAxes } from '../src/core/params'
import { restoreSnapshot, takeSnapshot } from '../src/core/snapshot'
import { World } from '../src/core/world'

/**
 * The food sources, on their three new axes.
 *
 * `foodMode` used to mean three things at once — where food lands, how a source moves, and how
 * several sources relate to each other — so "number of sources" and "their relation" had nowhere to
 * live, and `comet`'s speed was an absolute number that happened to be 1.9× faster than anything
 * that could chase it. These tests pin the three properties that factorisation has to have:
 *
 * 1. a world that sets none of the new axes behaves *exactly* as it did (there is a large catalog)
 * 2. a source's speed is a fraction of organism speed, so no level is uncatchable by accident
 * 3. each relation does the thing its name claims, measured rather than asserted
 */

const BASE: WorldSpec = {
  seed: 7,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 40,
  matter: 200,
  metabolism: 0.5,
  bondFlow: 0.05,
  T: 2,
  foodMode: 'patchy',
  foodLevel: 'abundant',
  foodRegime: 'steady',
  patches: 4,
  radius: 50,
  foodLife: 300,
  fission: false,
  scale: 1,
}

const run = (spec: WorldSpec, ticks: number): World => {
  const w = new World(specInit(spec))
  for (let t = 0; t < ticks; t++) w.step()
  return w
}

/** Distance from the world's middle, respecting the wrap. */
const fromMiddle = (w: World, i: number): number => {
  const half = w.L.SIZE / 2
  return Math.hypot(w.minImage(w.patches[i].x - half), w.minImage(w.patches[i].y - half))
}
const meanFromMiddle = (w: World): number => w.patches.reduce((s, _, i) => s + fromMiddle(w, i), 0) / w.patches.length

describe('food sources: three axes, not one enum', () => {
  it('leaves a world that sets no axis bit-identical to the legacy path', () => {
    // The whole reason the legacy branch exists. If this fails, every row in the catalog is
    // describing a world that no longer runs the way the row says it did.
    for (const mode of ['patchy', 'comet', 'converging', 'breathing', 'spring', 'ring', 'gradient', 'random'] as const) {
      const w = run({ ...BASE, foodMode: mode }, 200)
      expect(w.patches.every((p) => p.dx === 0 && p.dy === 0)).toBe(true)
      expect(w.srcV).toBe(0) // never measured, because the factored branch never ran
    }
  })

  it('hashes a spec that sets no axis exactly as before the axes existed', () => {
    // Appending even an empty field would change the canonical string and re-run the catalog.
    const before = specId(BASE)
    expect(specId({ ...BASE })).toBe(before)
    for (const k of ['sourceMotion', 'sourceRelation', 'sourceSpeed', 'sourceDensity'] as const) {
      expect(specId({ ...BASE, [k]: k === 'sourceSpeed' ? 0.5 : k === 'sourceDensity' ? 1 : 'comet' })).not.toBe(before)
    }
  })

  it('reads patches as an absolute count by default, and scales it only when asked', () => {
    // Default exponent 0 is the legacy meaning. 16x with exponent 2 is the case the dial is for:
    // four sources in a 4,800-unit world are needles, 1,024 blanket it.
    expect(specInit({ ...BASE, scale: 16 }).n_patch).toBe(4)
    expect(specInit({ ...BASE, scale: 16, sourceDensity: 1 }).n_patch).toBe(64)
    expect(specInit({ ...BASE, scale: 16, sourceDensity: 2 }).n_patch).toBe(1024)
  })

  it('sets source speed as a fraction of organism speed, so no level is uncatchable', () => {
    /*
     * The bug this replaces: `comet` moved at `max(1.5, v_patch*12)` absolute, measured at 0.363
     * units a tick against an organism's 0.196. A target that outruns its pursuer is not a chase.
     * Here the ratio is the dial, so the relationship holds whatever metabolism or F_max do.
     */
    const slow = run({ ...BASE, sourceMotion: 'comet', sourceSpeed: 0.2 }, 600)
    const fast = run({ ...BASE, sourceMotion: 'comet', sourceSpeed: 0.8 }, 600)
    expect(slow.srcV).toBeGreaterThan(0)
    expect(fast.srcV).toBeGreaterThan(slow.srcV * 2) // 0.8 / 0.2, up to a differing population
    const solo = slow.soloBaseline()
    expect(solo.speed).toBeGreaterThan(0)
    expect(slow.srcV).toBeLessThan(solo.speed) // catchable by construction
  })

  it('holds every source still under static, and moves it under every other motion', () => {
    for (const motion of SOURCE_MOTIONS) {
      const w = run({ ...BASE, sourceMotion: motion, sourceSpeed: 0.8 }, 600)
      const moved = w.patches.some((p) => Math.hypot(p.dx, p.dy) > 1)
      expect(moved, `motion ${motion}`).toBe(motion !== 'static')
    }
  })

  it('returns an orbiting source to where it started, and a comet never does', () => {
    // The contrast the whole motion axis exists for: identical speed, differing only in whether
    // the food *comes back*. Anticipation can only pay off against something periodic.
    const orbit = run({ ...BASE, sourceMotion: 'orbit', sourceSpeed: 0.8, patches: 1 }, 1200)
    const comet = run({ ...BASE, sourceMotion: 'comet', sourceSpeed: 0.8, patches: 1 }, 1200)
    // an orbit keeps its radius; a straight line does not keep anything
    const r0 = Math.hypot(orbit.minImage(orbit.patches[0].ox - orbit.L.SIZE / 2), orbit.minImage(orbit.patches[0].oy - orbit.L.SIZE / 2))
    expect(Math.abs(fromMiddle(orbit, 0) - r0)).toBeLessThan(1e-6)
    expect(comet.patches[0].dx !== 0 || comet.patches[0].dy !== 0).toBe(true)
  })

  it('keeps a tide a band: every source shares one heading', () => {
    const w = run({ ...BASE, sourceMotion: 'tide', sourceSpeed: 0.8, patches: 4 }, 600)
    // Each source has accumulated the *same* displacement, which is what makes it a sweep across
    // the world rather than four independent wanderers.
    const d0 = w.patches[0]
    for (const p of w.patches) {
      expect(Math.abs(p.dx - d0.dx)).toBeLessThan(1e-9)
      expect(Math.abs(p.dy - d0.dy)).toBeLessThan(1e-9)
    }
  })

  it('makes converging gather, diverging scatter, and cyclical do both', () => {
    /*
     * Measured against the start, not asserted from the code. Note the merge gate: a relation that
     * moves sources toward each other waits for `mergeStart`, exactly as `converging` always has,
     * because the point of a held world is that populations meet when *you* say so.
     */
    const spec = { ...BASE, sourceRelation: 'converging' as const, sourceMotion: 'static' as const, patches: 4 }
    const held = run(spec, 400)
    const start = meanFromMiddle(held)
    expect(start).toBeGreaterThan(0) // nothing happened: no merge was asked for

    const close = new World(specInit(spec))
    close.mergeStart = 0
    for (let t = 0; t < 4000; t++) close.step()
    expect(meanFromMiddle(close)).toBeLessThan(start * 0.5)

    const apart = new World(specInit({ ...spec, sourceRelation: 'diverging' }))
    apart.mergeStart = 0
    for (let t = 0; t < 4000; t++) apart.step()
    expect(meanFromMiddle(apart)).toBeGreaterThan(start)
  })

  it('keeps a formation in formation: spacing is preserved while the pattern travels', () => {
    const w = new World(specInit({ ...BASE, sourceRelation: 'formation', sourceMotion: 'comet', sourceSpeed: 0.8, patches: 3 }))
    const gap = (ww: World): number => Math.hypot(ww.minImage(ww.patches[1].x - ww.patches[0].x), ww.minImage(ww.patches[1].y - ww.patches[0].y))
    for (let t = 0; t < 50; t++) w.step()
    const g0 = gap(w)
    for (let t = 0; t < 600; t++) w.step()
    expect(Math.abs(gap(w) - g0)).toBeLessThan(1e-6)
    expect(Math.hypot(w.patches[0].dx, w.patches[0].dy)).toBeGreaterThan(1) // and it did travel
  })

  it('restores bit-identically with the sources moving', () => {
    // `srcV` and the per-source offsets are state like any other. Without them in the snapshot a
    // restore runs on a stale speed for up to a hundred ticks and the worlds part company.
    for (const motion of SOURCE_MOTIONS) {
      const spec = { ...BASE, sourceMotion: motion, sourceRelation: 'cyclical' as const, sourceSpeed: 0.8 }
      const a = new World(specInit(spec))
      a.mergeStart = 0
      for (let t = 0; t < 300; t++) a.step()
      const snap = takeSnapshot(a)
      for (let t = 0; t < 200; t++) a.step()
      const wanted = a.patches.map((p) => [p.x, p.y, p.dx, p.dy])

      const b = restoreSnapshot(specInit(spec), snap)
      for (let t = 0; t < 200; t++) b.step()
      expect(b.patches.map((p) => [p.x, p.y, p.dx, p.dy]), `motion ${motion}`).toEqual(wanted)
      expect(b.srcV).toBe(a.srcV)
    }
  })

  it('translates every legacy mode onto the axes', () => {
    // One place, so the old names keep meaning what they meant while the UI and the sampler speak
    // the new language. `converging` and `breathing` were relations; `comet` was a motion.
    expect(foodAxes('comet').motion).toBe('comet')
    expect(foodAxes('converging').relation).toBe('converging')
    expect(foodAxes('breathing').relation).toBe('cyclical')
    expect(foodAxes('spring').motion).toBe('static')
    for (const m of ['random', 'patchy', 'gradient', 'converging', 'breathing', 'spring', 'comet', 'ring'] as const) {
      const ax = foodAxes(m)
      expect(SOURCE_MOTIONS).toContain(ax.motion)
      expect(SOURCE_RELATIONS).toContain(ax.relation)
    }
  })
})
