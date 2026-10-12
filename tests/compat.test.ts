import { describe, expect, it } from 'vitest'
import { BRAIN_SHAPE, IncompatibleOrganism, checkCompatibility, defaultName, exportOrganism, parseOrganism } from '../src/core/organism'
import { applyFoodLevel, initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'

/** Seed 101's own food level is scarce enough to empty the world; these tests need survivors. */
const living = (over = {}) =>
  applyFoodLevel({ ...initFromSeed(101), n_start: 6, n_intrinsic: 150, n_brain: 10, foodLevel: 'abundant' as const, ...over })

function saved(): string {
  const w = new World(living())
  for (let t = 0; t < 900; t++) w.step()
  const b = [...Array(w.nMatter).keys()].find((i) => i >= w.nIntr && w.alive[i] && w.isBrain(i))!
  return JSON.stringify(exportOrganism(w, b))
}

describe('brain-shape compatibility', () => {
  it('stamps the shape it was saved against, and loads its own files', () => {
    const o = parseOrganism(saved())
    expect(o.brain).toEqual(BRAIN_SHAPE)
    expect(o.wBrain.length).toBe(BRAIN_SHAPE.in * BRAIN_SHAPE.out)
    expect(o.wLimb.length).toBe(BRAIN_SHAPE.limb)
    expect(checkCompatibility(JSON.parse(saved())).ok).toBe(true)
  })

  it('refuses a file made for a different brain, instead of quietly padding it', () => {
    const o = JSON.parse(saved())
    o.brain = { in: 27, out: 6, limb: 8 } // an earlier shape this project really had
    o.wBrain = new Array(27 * 6).fill(0.1)
    const check = checkCompatibility(o)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('27→6')
    expect(check.reason).toContain(`${BRAIN_SHAPE.in}→${BRAIN_SHAPE.out}`)
    expect(() => parseOrganism(JSON.stringify(o))).toThrow(IncompatibleOrganism)
  })

  it('refuses a file saved before shapes were recorded at all', () => {
    const o = JSON.parse(saved())
    delete o.brain
    o.version = 1
    const check = checkCompatibility(o)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('brain shape')
    expect(() => parseOrganism(JSON.stringify(o))).toThrow(IncompatibleOrganism)
  })

  it('refuses a file whose weights disagree with its own stamp', () => {
    const o = JSON.parse(saved())
    o.wBrain = o.wBrain.slice(0, 10) // truncated in transit
    expect(checkCompatibility(o).ok).toBe(false)
    expect(checkCompatibility(o).reason).toContain('do not match its own stamp')
  })

  it('still repairs merely cosmetic damage', () => {
    const o = JSON.parse(saved())
    o.limbs = [{ quad: 9, type: 77 }, { quad: 9 }] // out of range, and a duplicate quadrant
    o.reserve = -5
    o.name = 'x'.repeat(500)
    const parsed = parseOrganism(JSON.stringify(o))
    expect(parsed.limbs.length).toBe(1)
    expect(parsed.limbs[0].quad).toBe(3)
    expect(parsed.reserve).toBeGreaterThanOrEqual(0)
    expect(parsed.name!.length).toBe(80)
  })

  it('names an organism after where it came from, deterministically', () => {
    const o = parseOrganism(saved())
    const a = defaultName(o, 'oldest')
    expect(a).toBe(defaultName(o, 'oldest'))
    expect(a).toContain(o.from!.foodMode)
    expect(a).toContain(`g${o.generation}`)
    expect(a).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('per-organism fitness', () => {
  it('records what an organism actually did, not just how long it lived', () => {
    const w = new World(living())
    for (let t = 0; t < 3000; t++) w.step()
    const brains = [...Array(w.nMatter).keys()].filter((i) => i >= w.nIntr && w.alive[i] && w.isBrain(i))
    expect(brains.length).toBeGreaterThan(0)
    let anyAte = false
    let anyMoved = false
    let anySpent = false
    for (const b of brains) {
      const o = exportOrganism(w, b)!
      const f = o.fitness!
      // true of every organism, including one born this very tick
      expect(f.harvested).toBeGreaterThanOrEqual(0)
      expect(f.spent).toBeGreaterThanOrEqual(0)
      expect(f.harvested).toBeCloseTo(f.meals * w.L.E_food, 6) // every meal is one food particle
      expect(f.peakReserve).toBeGreaterThanOrEqual(o.reserve)
      expect(f.moved).toBeGreaterThanOrEqual(0)
      expect(f.orderTicks).toBeGreaterThanOrEqual(0)
      if (f.meals > 0) anyAte = true
      if (f.moved > 0) anyMoved = true
      if (f.spent > 0) anySpent = true
    }
    // and true of the population, which a newborn alone would not satisfy
    expect(anyAte).toBe(true)
    expect(anyMoved).toBe(true)
    expect(anySpent).toBe(true)
  })

  it('starts a fresh body at zero, so counters belong to the organism and not the slot', () => {
    const w = new World(applyFoodLevel({ ...initFromSeed(7), n_start: 2, T_spawn: 30, n_brain: 6, foodLevel: 'abundant' as const }))
    for (let t = 0; t < 2000; t++) w.step()
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.alive[b] || !w.isBrain(b)) continue
      const age = w.tick - w.bornAt[b]
      // a counter can never imply more activity than the body has been alive for
      expect(w.meals[b]).toBeLessThanOrEqual(age + 1)
      expect(w.spent[b]).toBeLessThanOrEqual(age * w.L.E_cap)
    }
  })

  it('credits compound time only where compounds can form', () => {
    const total = (bonds: boolean): number => {
      const w = new World(living({ n_brain: 12, foodMode: 'spring' as const, bonds }))
      let most = 0
      for (let t = 0; t < 4000; t++) {
        w.step()
        if (t % 200) continue
        for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) most = Math.max(most, w.orderTicks[b])
      }
      return most
    }
    // compounds are built on bonds, so with bonding off nothing can ever earn compound time
    expect(total(false)).toBe(0)
    expect(total(true)).toBeGreaterThan(0)
  })

  it('weights a bigger compound superlinearly, not proportionally', () => {
    const w = new World(initFromSeed(3))
    const credit = (n: number): number => Math.pow(n - 1, w.L.order_alpha)
    // an order-5 is worth more than four times an order-2, which is the point of alpha > 1
    expect(credit(5)).toBeGreaterThan(4 * credit(2))
    expect(credit(1)).toBe(0) // alone is worth nothing
    expect(w.L.order_alpha).toBeGreaterThan(1)
  })
})
