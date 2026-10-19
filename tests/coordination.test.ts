import { describe, expect, it } from 'vitest'
import { agreement } from '../src/core/orders'

/**
 * The travel rung's statistic, on its own.
 *
 * `Moves together` asks whether a structure goes further than its members would alone. Four
 * population baselines were tried for that and every one failed, each in a way that looked like the
 * rung working:
 *
 * 1. **organisms that never joined** — sticky for life, so in a world that bonds well the baseline
 *    empties and the rung silently reports zero. A structure of order 41 travelling at 0.77 scored 0.
 * 2. **organisms holding no bond** — fine only while bodies arrived pre-assembled. Once a brain
 *    builds its body out of loose matter it nearly always holds a bond, so the baseline collapsed to
 *    brains sitting in empty space, and an unaided world read **3.81x**.
 * 3. **not in a compound, matched on body size** — fixed a real confound (13 of 27 compound members
 *    had four limbs against a solo spread of 4/2/3/4) and still read **2.77x**, because a solo brain
 *    typically drags inert matter while a compound member's partners push. Anchoring, not coordination.
 * 4. **the members' own speed before they joined** — the strongest null available in principle, and
 *    unavailable in practice: median join age is **19 ticks**, 93% join before age 100, and zero of
 *    60 organisms in the world built to pass this rung had a usable pre-join baseline. A
 *    within-organism null needs a solitary phase, and this world does not have one.
 *
 * So the baseline is computed from the physics instead. This world is overdamped — velocity is
 * force over drag — so N bodies moving independently each go at `|F_i| / g`, while bonded into one
 * structure of N times the drag they go at `|ΣF_i| / (N g)`. The ratio is exactly `|ΣF_i| / Σ|F_i|`,
 * the alignment of their commands, with no population anywhere in it.
 *
 * These tests pin the two properties the rung depends on: that the statistic is 1.0 under chance,
 * so the threshold at 1 means something; and that it rises above 1 under coordination, so the rung
 * is passable rather than merely unfailable.
 */

/** The model's own statistic, so the test cannot drift away from what the rung computes. */
const aligned = (v: [number, number][]): number => {
  let sx = 0
  let sy = 0
  let mag = 0
  for (const [x, y] of v) {
    sx += x
    sy += y
    mag += Math.hypot(x, y)
  }
  return agreement(sx, sy, mag, v.length)
}

/** A deterministic normal, so these assertions do not depend on the platform's RNG. */
function gauss(seed: number): () => number {
  let s = seed >>> 0
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  return () => {
    const u = Math.max(1e-12, next())
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next())
  }
}

describe('the travel rung as a coordination statistic', () => {
  it('reads the chance level 1/sqrt(n) for independent commands, at every group size', () => {
    /*
     * The property the threshold rests on. If independent commands scored above 1 the rung would be
     * passed by any group that exists, and if they scored below it the rung would be unpassable —
     * which is exactly the pair of failures the population baselines produced.
     */
    const g = gauss(12345)
    for (const n of [3, 5, 10, 40]) {
      let sum = 0
      const trials = 4000
      for (let t = 0; t < trials; t++) {
        const v: [number, number][] = Array.from({ length: n }, () => [g(), g()])
        sum += aligned(v)
      }
      const mean = sum / trials
      /*
       * `1 / sqrt(n)`, which is the whole difficulty with this statistic in one line: **its null
       * depends sharply on the group size.** 0.58 at three members, 0.16 at forty. Two attempts to
       * correct for that — rescaling the span to [0,1], then standardising against a Monte-Carlo
       * null per size — each removed one bias and introduced its mirror. The rung therefore
       * compares against a group of *the same size*, where the correction is unnecessary.
       */
      expect(mean, `n=${n} independent`).toBeCloseTo(1 / Math.sqrt(n), 1)
    }
  })

  it('rises toward 1 as commands agree, and reaches 1 when they agree perfectly', () => {
    // So the rung is passable, and by the thing it claims to measure. Perfect agreement is the
    // ceiling: N bodies pulling exactly together go N times as far as the vector sum of N random
    // ones, which is √n once normalised.
    const n = 9
    expect(aligned(Array.from({ length: n }, () => [1, 0]))).toBeCloseTo(1, 9)

    // and it is monotone in how much they agree: a common drift added to independent commands
    const g = gauss(777)
    let last = 0
    for (const drift of [0, 0.5, 1, 2, 4]) {
      let sum = 0
      const trials = 2000
      for (let t = 0; t < trials; t++) {
        sum += aligned(Array.from({ length: n }, () => [g() + drift, g()] as [number, number]))
      }
      const mean = sum / trials
      expect(mean, `drift ${drift}`).toBeGreaterThan(last)
      last = mean
    }
    expect(last).toBeGreaterThan(0.5) // well clear of chance, so the rung can be met
  })

  it('cancels a common current when the comparison group is the same size', () => {
    /*
     * Why the rung's control is size-matched. Here every organism shares a drift, including the
     * structure's members, so the ratio must come back to about 1: the members agree, but no more
     * than their neighbours do.
     *
     * Comparing against the *whole population* instead is what failed in practice — a six-member
     * structure against a forty-member world is measuring size as much as agreement, and it tripped
     * the null on 8 of 30 unaided worlds.
     */
    const g = gauss(2024)
    let sum = 0
    const trials = 2000
    for (let t = 0; t < trials; t++) {
      const drift = 1.5
      const struct: [number, number][] = Array.from({ length: 6 }, () => [g() + drift, g()])
      const rivals: [number, number][] = Array.from({ length: 6 }, () => [g() + drift, g()])
      sum += aligned(struct) / aligned(rivals)
    }
    const mean = sum / trials
    expect(mean).toBeGreaterThan(0.85)
    expect(mean).toBeLessThan(1.2)
  })

  it('exceeds 1 when a group agrees more than a same-sized group beside it', () => {
    // The case the rung is for, with size held fixed so only agreement can move the number.
    const g = gauss(99)
    let sum = 0
    const trials = 2000
    for (let t = 0; t < trials; t++) {
      const struct: [number, number][] = Array.from({ length: 6 }, () => [g() * 0.04 + 3, g() * 0.04])
      const rivals: [number, number][] = Array.from({ length: 6 }, () => [g() + 0.3, g()])
      sum += aligned(struct) / aligned(rivals)
    }
    expect(sum / trials).toBeGreaterThan(1.5)
  })
})
