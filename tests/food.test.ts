import { describe, expect, it } from 'vitest'
import { census } from '../src/core/metrics'
import {
  FOOD_REGIMES,
  type FoodLevel,
  type FoodRegime,
  LEVEL_MULTIPLIER,
  applyFoodLevel,
  baseFoodRate,
  initFromSeed,
  regimeMultiplier,
  sustenanceRate,
} from '../src/core/params'
import { World } from '../src/core/world'

const world = (over: Partial<ReturnType<typeof initFromSeed>> = {}) => ({
  ...initFromSeed(7),
  n_start: 6,
  n_intrinsic: 150,
  n_brain: 10,
  foodMode: 'patchy' as const,
  foodRegime: 'steady' as const,
  ...over,
})

describe('food level', () => {
  it('means the same multiple of what a world spends, at any size', () => {
    for (const level of ['scarce', 'average', 'abundant'] as FoodLevel[]) {
      for (const scale of [1, 4]) {
        const init = applyFoodLevel({ ...initFromSeed(11, scale), foodLevel: level })
        const ratio = baseFoodRate(init) / sustenanceRate(init)
        expect(ratio, `${level} at ${scale}x`).toBeGreaterThan(LEVEL_MULTIPLIER[level] * 0.5)
        expect(ratio, `${level} at ${scale}x`).toBeLessThan(LEVEL_MULTIPLIER[level] * 1.6)
      }
    }
  })

  it('actually produces scarcity, sufficiency and glut', () => {
    const standing = (level: FoodLevel): number => {
      const w = new World(applyFoodLevel(world({ foodLevel: level })))
      let sum = 0
      let n = 0
      for (let t = 0; t < 4000; t++) {
        w.step()
        if (t > 1000 && t % 100 === 0) {
          sum += census(w).food
          n++
        }
      }
      return sum / n
    }
    const scarce = standing('scarce')
    const average = standing('average')
    const abundant = standing('abundant')
    expect(scarce).toBeLessThan(average)
    expect(average).toBeLessThan(abundant)
    expect(abundant).toBeGreaterThan(world().max_food * 0.75) // a glut really does pile up
    expect(scarce).toBeLessThan(world().max_food * 0.4)
  })
})

describe('food regime', () => {
  it('is a pure function of the tick: deterministic, finite and never negative', () => {
    for (const regime of FOOD_REGIMES) {
      const init = world({ foodRegime: regime, regime_period: 1000 })
      for (const t of [0, 1, 250, 999, 1000, 5000]) {
        const a = regimeMultiplier(init, t)
        expect(a, `${regime}@${t}`).toBe(regimeMultiplier(init, t))
        expect(a, `${regime}@${t}`).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(a)).toBe(true)
      }
    }
    // The multiplier draws no randomness itself. It does still move the random stream
    // indirectly, because a different amount of food means a different number of placements —
    // that is the regime doing its job, not leaking.
    const before = new World(world({ foodRegime: 'noisy' })).rng.state()[0]
    expect(new World(world({ foodRegime: 'steady' })).rng.state()[0]).toBe(before)
  })

  it('has the shape each name promises', () => {
    const init = world({ regime_period: 1000 })
    const at = (regime: FoodRegime, t: number): number => regimeMultiplier({ ...init, foodRegime: regime }, t)

    // cycle: a trough at the start of the period and a peak in the middle
    expect(at('cycle', 0)).toBeLessThan(0.3)
    expect(at('cycle', 500)).toBeGreaterThan(2)
    expect(at('cycle', 1000)).toBeCloseTo(at('cycle', 0), 6) // and it repeats

    // bloom: brief and enormous, otherwise famine
    expect(at('bloom', 10)).toBeGreaterThan(5)
    expect(at('bloom', 500)).toBeLessThan(0.2)

    // decline and rising are monotone across the period
    for (let t = 0; t < 1000; t += 100) {
      expect(at('decline', t + 100)).toBeLessThanOrEqual(at('decline', t) + 1e-9)
      expect(at('rising', t + 100)).toBeGreaterThanOrEqual(at('rising', t) - 1e-9)
    }
    expect(at('decline', 1000)).toBe(0)

    expect(at('steady', 7)).toBe(1)
  })

  it('a declining world really does run out', () => {
    const w = new World(applyFoodLevel(world({ foodLevel: 'abundant', foodRegime: 'decline', regime_period: 2500 })))
    for (let t = 0; t < 1200; t++) w.step()
    const early = census(w).food
    for (let t = 0; t < 2600; t++) w.step()
    expect(census(w).food).toBeLessThan(early * 0.5)
    expect(w.foodRateNow()).toBe(0)
  })
})

describe('the sun', () => {
  it('delivers a fractional rate accurately, not in lumps', () => {
    const init = world({ foodLevel: 'scarce', foodRegime: 'steady', n_food0: 0, max_food: 100000, food_life: 0, n_start: 0, T_spawn: 1e9 })
    init.food_batch = 1
    init.T_food = 7 // one particle every seven ticks
    const w = new World(init)
    for (let t = 0; t < 700; t++) w.step()
    // count what the sun delivered rather than what is lying about, since particles eat it
    const delivered = w.injected / w.L.E_food
    expect(delivered).toBeGreaterThanOrEqual(99) // 700 ticks at one per seven
    expect(delivered).toBeLessThanOrEqual(101)
  })

  it('wastes nothing and invents nothing: the ledger still closes', () => {
    for (const regime of FOOD_REGIMES) {
      const w = new World(applyFoodLevel(world({ foodRegime: regime, regime_period: 800 })))
      for (let t = 0; t < 2500; t++) w.step()
      expect(w.totalEnergy() + w.burned, regime).toBeCloseTo(w.initialEnergy + w.injected, 6)
    }
  })
})

describe('where food lands', () => {
  const spread = (w: World): { spread: number; cx: number; cy: number } => {
    let n = 0
    let cx = 0
    let cy = 0
    for (let i = w.foodStart; i < w.cap; i++) {
      if (!w.alive[i]) continue
      n++
      cx += w.x[i]
      cy += w.y[i]
    }
    cx /= Math.max(1, n)
    cy /= Math.max(1, n)
    let s = 0
    for (let i = w.foodStart; i < w.cap; i++) if (w.alive[i]) s += Math.hypot(w.x[i] - cx, w.y[i] - cy)
    return { spread: s / Math.max(1, n), cx, cy }
  }

  it('puts a spring in one tight spot and uniform food everywhere', () => {
    const run = (mode: 'spring' | 'random'): number => {
      const w = new World(applyFoodLevel(world({ foodMode: mode, foodLevel: 'abundant', n_start: 0, T_spawn: 1e9 })))
      for (let t = 0; t < 2000; t++) w.step()
      return spread(w).spread
    }
    expect(run('spring')).toBeLessThan(run('random') * 0.5)
  })

  it('keeps ring food in a band away from the middle', () => {
    const w = new World(applyFoodLevel(world({ foodMode: 'ring', foodLevel: 'abundant', n_start: 0, T_spawn: 1e9 })))
    for (let t = 0; t < 2000; t++) w.step()
    const mid = w.L.SIZE / 2
    let inside = 0
    let total = 0
    for (let i = w.foodStart; i < w.cap; i++) {
      if (!w.alive[i]) continue
      total++
      if (Math.hypot(w.x[i] - mid, w.y[i] - mid) < w.L.SIZE * 0.2) inside++
    }
    expect(total).toBeGreaterThan(20)
    expect(inside / total).toBeLessThan(0.05) // the middle stays empty
  })

  it('starts colonies apart and ends with them merged', () => {
    const init = applyFoodLevel(world({ foodMode: 'converging', foodLevel: 'abundant', n_patch: 3, converge_ticks: 3000, n_start: 0, T_spawn: 1e9 }))
    const w = new World(init)
    const gap = (): number => {
      let worst = 0
      for (const a of w.patches) for (const b of w.patches) worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y))
      return worst
    }
    expect(w.patches.length).toBe(3)
    const apart = gap()
    expect(apart).toBeGreaterThan(w.L.SIZE * 0.3)
    for (let t = 0; t < 3200; t++) w.step()
    expect(gap()).toBeLessThan(1) // all three have met in the middle
    expect(spread(w).spread).toBeLessThan(apart)
  })

  it('moves a comet far enough to have to be chased', () => {
    const w = new World(applyFoodLevel(world({ foodMode: 'comet', foodLevel: 'abundant', n_start: 0, T_spawn: 1e9 })))
    const start = { x: w.patches[0].x, y: w.patches[0].y }
    let travelled = 0
    let prev = { ...start }
    for (let t = 0; t < 300; t++) {
      w.step()
      const p = w.patches[0]
      const S = w.L.SIZE
      let dx = p.x - prev.x
      let dy = p.y - prev.y
      dx -= S * Math.round(dx / S)
      dy -= S * Math.round(dy / S)
      travelled += Math.hypot(dx, dy)
      prev = { x: p.x, y: p.y }
    }
    expect(travelled).toBeGreaterThan(w.L.SIZE) // crosses the world within a few hundred ticks
  })
})

describe('breathing colonies', () => {
  it('merges and parts again, for ever', () => {
    const period = 2000
    const init = applyFoodLevel(
      world({ foodMode: 'breathing', foodLevel: 'abundant', n_patch: 3, converge_ticks: period, n_start: 0, T_spawn: 1e9 }),
    )
    const w = new World(init)
    const gap = (): number => {
      let worst = 0
      for (const a of w.patches) for (const b of w.patches) worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y))
      return worst
    }
    expect(w.patches.length).toBe(3)
    const apart = gap()
    expect(apart).toBeGreaterThan(w.L.SIZE * 0.3)

    const run = (ticks: number): void => {
      for (let t = 0; t < ticks; t++) w.step()
    }
    run(period / 2) // halfway through a breath: merged
    expect(gap()).toBeLessThan(1)
    run(period / 2) // and back out again
    expect(gap()).toBeGreaterThan(apart * 0.95)
    run(period / 2) // for ever, not once
    expect(gap()).toBeLessThan(1)
  })

  it('converging stays merged where breathing does not', () => {
    const period = 1500
    const make = (mode: 'converging' | 'breathing'): World =>
      new World(applyFoodLevel(world({ foodMode: mode, foodLevel: 'abundant', n_patch: 2, converge_ticks: period, n_start: 0, T_spawn: 1e9 })))
    const gap = (w: World): number => Math.hypot(w.patches[0].x - w.patches[1].x, w.patches[0].y - w.patches[1].y)
    const a = make('converging')
    const b = make('breathing')
    for (let t = 0; t < period * 2; t++) {
      a.step()
      b.step()
    }
    expect(gap(a)).toBeLessThan(1) // converging arrived and stayed
    expect(gap(b)).toBeGreaterThan(a.L.SIZE * 0.3) // breathing came back apart
  })
})
