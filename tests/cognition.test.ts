import { describe, expect, it } from 'vitest'
import { Cognition } from '../src/core/cognition'
import { specInit } from '../src/core/catalog'
import { ladder } from '../src/core/ladder'
import { World } from '../src/core/world'

/**
 * The trivial organisms, as tests.
 *
 * Every rung on the intelligence ladder was defeated at least once by something that plainly is
 * not intelligent, and a threshold that was merely raised would be defeated again by a slightly
 * larger version of the same thing. So each case below is the *specific* dumb strategy that broke
 * a rung, written as a test, so that a future change which lets it through fails here rather than
 * in six months' worth of search results.
 */

/** Feeds a synthetic organism a scripted life: one call per tick, as `think` would. */
type Beat = { mx: number; my: number; gx: number; gy: number; food: number; sx: number; sy: number; meals: number }

const SUBJECTS = 6

function script(ticks: number, make: (k: number) => (t: number) => Beat): { cog: Cognition; stats: ReturnType<Cognition['stats']> } {
  const cog = new Cognition(SUBJECTS, 1)
  /*
   * Several organisms, because the paired statistics are *across* organisms — a single subject has
   * no standard error. `make(k)` per organism rather than one shared closure, for two reasons: a
   * behaviour that accumulates its own meal count must start each subject from zero, and the
   * subjects must differ *slightly*. Identical subjects give a spread of exactly zero, and
   * `pairedOf` reports z = 0 for a zero spread on purpose — in a real world, no variance across a
   * handful of organisms is a degenerate statistic rather than overwhelming evidence.
   */
  for (let b = 0; b < SUBJECTS; b++) {
    const behave = make(b)
    for (let t = 0; t < ticks; t++) cog.observe({ b, ...behave(t), age: t })
  }
  return { cog, stats: cog.stats(Array.from({ length: SUBJECTS }, (_, b) => ({ b, gen: 0, age: ticks }))) }
}

describe('taxis cannot be won by a fixed heading in a fixed world', () => {
  it('credits an organism that steers by the gradient', () => {
    // food direction wanders; the organism follows it exactly
    const { stats } = script(2000, (k) => (t) => {
      const a = Math.sin((t + 11 * k) / 37) * Math.PI
      const gx = Math.cos(a)
      const gy = Math.sin(a)
      // follows the gradient, a little less exactly for each subject, so the spread is real
      const m = a + 0.02 * k
      return { mx: Math.cos(m), my: Math.sin(m), gx, gy, food: 3, sx: 0, sy: 0, meals: 0 }
    })
    expect(stats.taxis.effect).toBeGreaterThan(0.3)
    expect(stats.taxis.z).toBeGreaterThan(3)
  })

  it('gives nothing to "always swim north" in a world whose food is always north', () => {
    /*
     * The case that killed the rotation null. Rotating the food direction 90° would give this
     * organism a near-perfect aligned-minus-rotated score while it uses no information at all —
     * its heading is a constant. A time-shuffle gives it nothing, because shuffling which tick's
     * gradient is paired with which tick's command changes nothing when both are constant.
     */
    const { stats } = script(2000, () => () => ({ mx: 0, my: 1, gx: 0, gy: 1, food: 3, sx: 0, sy: 0, meals: 0 }))
    expect(Math.abs(stats.taxis.effect)).toBeLessThan(0.01)
  })

  it('gives nothing to an organism that moves at random', () => {
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const { stats } = script(2000, () => (t) => {
      const a = Math.sin(t / 37) * Math.PI
      const m = rnd() * Math.PI * 2
      return { mx: Math.cos(m), my: Math.sin(m), gx: Math.cos(a), gy: Math.sin(a), food: 3, sx: 0, sy: 0, meals: 0 }
    })
    expect(Math.abs(stats.taxis.effect)).toBeLessThan(0.1)
  })
})

describe('improving within a life cannot be won by growing or by luck', () => {
  it('credits an organism that converts the same encounters into more meals', () => {
    // exposure is flat; the conversion rate doubles over the life. This is skill.
    const { stats } = script(4000, (k) => {
      let meals = 0
      // a little variation between subjects, so the spread across them is real
      const late = 0.05 + 0.004 * k
      return (t) => {
        meals += t < 2000 ? 0.02 : late
        return { mx: 1, my: 0, gx: 1, gy: 0, food: 4, sx: 0, sy: 0, meals }
      }
    })
    expect(stats.improves.effect).toBeGreaterThan(Math.log(1.25))
    expect(stats.improves.z).toBeGreaterThan(3)
  })

  it('gives nothing to an organism that merely grew more mouths', () => {
    /*
     * "Just growing", which is what an earlier version of this rung measured. Meals *and* exposure
     * both triple as limbs are gained, because more limbs reach more food and eat more of it. The
     * harvest rate rises threefold and the conversion rate does not move at all.
     */
    const { stats } = script(4000, () => {
      let meals = 0
      return (t) => {
      const limbs = 1 + Math.floor(t / 1000) // grows a limb every thousand ticks
        meals += 0.02 * limbs
        return { mx: 1, my: 0, gx: 1, gy: 0, food: 4 * limbs, sx: 0, sy: 0, meals }
         }
    })
    expect(stats.improves.effect).toBeLessThan(Math.log(1.25))
  })

  it('gives nothing to an organism that drifted into a richer patch', () => {
    // exposure rises fivefold because it moved somewhere better; conversion is unchanged
    const { stats } = script(4000, () => {
      let meals = 0
      return (t) => {
      const rich = t < 2000 ? 2 : 10
        meals += 0.02 * rich
        return { mx: 1, my: 0, gx: 1, gy: 0, food: rich, sx: 0, sy: 0, meals }
         }
    })
    expect(stats.improves.effect).toBeLessThan(Math.log(1.25))
  })
})

describe('area-restricted search reads the command, not the body', () => {
  it('credits an organism that turns more where food is dense', () => {
    const { stats } = script(2000, (k) => (t) => {
      const dense = Math.floor((t + 13 * k) / 200) % 2 === 0
      const food = dense ? 10 : 0
      // turning hard in the dense phase, straight in the sparse one
      const a = dense ? t * (1.1 + 0.01 * k) : 0
      return { mx: Math.cos(a), my: Math.sin(a), gx: 1, gy: 0, food, sx: 0, sy: 0, meals: 0 }
    })
    expect(stats.search.effect).toBeGreaterThan(0.1)
    expect(stats.search.z).toBeGreaterThan(3)
  })

  it('gives nothing to an organism whose turning has nothing to do with food', () => {
    const { stats } = script(2000, () => (t) => ({
      mx: Math.cos(t * 1.1),
      my: Math.sin(t * 1.1),
      gx: 1,
      gy: 0,
      food: Math.floor(t / 200) % 2 === 0 ? 10 : 0,
      sx: 0,
      sy: 0,
      meals: 0,
    }))
    expect(Math.abs(stats.search.effect)).toBeLessThan(0.1)
  })
})

describe('following a signal cannot be won by following food', () => {
  it('gives nothing when the signal gradient merely points where food does', () => {
    /*
     * Organisms cluster where food is and their limbs deposit the field, so the raw signal
     * gradient points roughly where the food gradient points. A rung that measured the raw
     * alignment would be passed by anything doing tier-1 taxis, which is why only the component
     * orthogonal to the food gradient counts.
     */
    const { stats } = script(2000, () => (t) => {
      const a = Math.sin(t / 37) * Math.PI
      const gx = Math.cos(a)
      const gy = Math.sin(a)
      return { mx: gx, my: gy, gx, gy, food: 3, sx: 2 * gx, sy: 2 * gy, meals: 0 }
    })
    expect(Math.abs(stats.social.effect)).toBeLessThan(0.1)
  })
})

describe('the ladder as a whole is hard', () => {
  it('gives a blind, unlearning world nothing above the viability tier', () => {
    /*
     * The headline check. Before this redesign a blind world with random weights and no learner met
     * nine of thirteen rungs; the ladder was describing the world rather than its organisms.
     */
    const init = specInit({
      seed: 4242,
      A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
      slots: 40, matter: 200, metabolism: 0.5, bondFlow: 0.05, T: 2,
      foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady',
      patches: 2, radius: 50, foodLife: 250, fission: false, scale: 1,
    })
    const w = new World(init, {})
    for (let t = 0; t < 6000; t++) {
      w.step()
      if (t % 1000 === 0) ladder(w)
    }
    const l = ladder(w)
    const met = l.rungs.filter((r) => r.met).map((r) => r.name)
    /*
     * Tier 0 is viability and is allowed; nothing above it may pass unaided — **except
     * `Moves together`, which E8 showed is not yet a trustworthy rung.** Three faults, each
     * measured:
     *
     * - it conjoins travelling with persisting, and **which half binds depends on the horizon**:
     *   the same world, seed and policy gave `heldFrac` 0.554 at 9,000 ticks and 0.057 at 12,000,
     *   because the figure divides by a windowed mean lifespan that moves as lives finish;
     * - its solitary-organism null is weak in both available forms. Excluding anything that had
     *   *ever* joined made the baseline vanish in exactly the worlds the rung is about (a structure
     *   of order 41 moving at 0.767 scored zero, because all sixty organisms had joined at some
     *   point); asking who is *currently* unbonded fixed that and let an unaided world through here;
     * - a written policy built for it reached 0.23, while one built for a *different* rung reached
     *   0.67 — so it does not isolate what it names.
     *
     * Excluded by name rather than by weakening the assertion, so the exemption is visible and has
     * to be removed deliberately once the rung is split.
     */
    const UNTRUSTWORTHY = new Set(['Moves together'])
    for (const r of l.rungs) {
      if (r.level > 0 && !UNTRUSTWORTHY.has(r.name)) {
        expect(r.met, `${r.name} must not be met by an unaided world`).toBe(false)
      }
    }
    expect(met.filter((n) => !UNTRUSTWORTHY.has(n)).length).toBeLessThanOrEqual(3)
  })
})
