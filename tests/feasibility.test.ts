import { describe, expect, it } from 'vitest'
import { HAND_BUILT, HAND_BUILT_NAMES, socketDirection } from '../src/core/handbuilt'
import { type WorldSpec, specInit } from '../src/core/catalog'
import { ladder } from '../src/core/ladder'
import { BRAIN_IN, BRAIN_OUT, N_BRAIN_IN } from '../src/core/neurons'
import { World } from '../src/core/world'

/**
 * Is the ladder climbable?
 *
 * It was deliberately made hard and nothing passes any rung above the viability tier, in any of
 * four conditions from blind-and-unlearning up to an online learner. That is the intended state,
 * and it leaves three situations looking identical from a run that scores zero:
 *
 * - the rung is hard but reachable — proceed
 * - the threshold is too strict — recalibrate it
 * - **the instrument cannot see the behaviour** — fix the instrument; searching against it is waste
 *
 * So each rung gets a brain built to pass it. A deliberately-constructed solver that fails tells
 * us the problem is the rung or the world rather than the organisms — and that is a conclusion
 * available no other way.
 *
 * Two of the six intelligence rungs are **not testable this way, by construction**: `Improves` and
 * `Lineage improves` ask for change within a life and across lives, and a fixed brain cannot
 * improve at anything. They are tests of the learners, not of the ladder.
 */

/** A world that lives, with no learner, so only the hand-built policy is acting. */
const BASE: WorldSpec = {
  seed: 4242,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 60, matter: 300, metabolism: 0.5, bondFlow: 0.05, T: 2,
  foodMode: 'patchy', foodLevel: 'abundant', foodRegime: 'steady',
  patches: 3, radius: 60, foodLife: 400, fission: false, scale: 1,
}

/**
 * Runs a hand-built world and returns the ladder, read as it goes because rungs are windowed.
 *
 * Memoised by its arguments. Several tests ask different questions of the same world, and running
 * it once each took five minutes off the suite — these are slow by nature, since a rung needs
 * thousands of ticks and completed lives before it reports anything at all.
 */
const cache = new Map<string, { w: World; l: ReturnType<typeof ladder> }>()
function run(handBuilt: string, over: Partial<WorldSpec> = {}, ticks = 9000) {
  const key = `${handBuilt}|${ticks}|${JSON.stringify(over)}`
  const hit = cache.get(key)
  if (hit) return hit
  const w = new World(specInit({ ...BASE, ...over, handBuilt }), {})
  for (let t = 0; t < ticks; t++) {
    w.step()
    if (t % 500 === 0) ladder(w)
  }
  const out = { w, l: ladder(w) }
  cache.set(key, out)
  return out
}

const ratio = (l: ReturnType<typeof ladder>, name: string): number => l.rungs.find((r) => r.name === name)?.ratio ?? 0
const met = (l: ReturnType<typeof ladder>, name: string): boolean => l.rungs.find((r) => r.name === name)?.met ?? false

describe('the policies are what they claim to be', () => {
  it('writes into the output rows the brain actually reads', () => {
    // a weight in the wrong row is a policy that silently does nothing, which is the failure mode
    // these tests exist to avoid being fooled by
    for (const n of HAND_BUILT_NAMES) {
      const m = HAND_BUILT[n].brain()
      expect(m.length, n).toBe(10 * N_BRAIN_IN)
      if (n === 'thrifty') expect(m.every((v) => v === 0)).toBe(true)
      else expect(m.some((v) => v !== 0), n).toBe(true)
    }
  })

  it('points each socket into the middle of its own quadrant', () => {
    // `followsSignal` reconstructs a gradient from four socket signals weighted by direction, so
    // it is wrong by exactly a rotation if these are wrong
    for (let s = 0; s < 4; s++) {
      const a = socketDirection(s)
      expect(a).toBeGreaterThan((s * Math.PI) / 2)
      expect(a).toBeLessThan(((s + 1) * Math.PI) / 2)
    }
  })

  it('leaves taxis reading only the food gradient', () => {
    const m = HAND_BUILT.taxis.brain()
    expect(m[BRAIN_OUT.FX * N_BRAIN_IN + BRAIN_IN.FOOD_X]).toBeGreaterThan(0)
    expect(m[BRAIN_OUT.FY * N_BRAIN_IN + BRAIN_IN.FOOD_Y]).toBeGreaterThan(0)
    expect(m[BRAIN_OUT.FX * N_BRAIN_IN + BRAIN_IN.BIAS]).toBe(0)
  })
})

describe('a hand-built brain beats doing nothing', () => {
  /*
   * `reproMut: 0` is load-bearing, and finding that out was the first result.
   *
   * `bud` inherits weights with Gaussian mutation, so over twelve thousand ticks the descendants of
   * a hand-built brain drift into something else entirely. With the default 0.05 the descendants of
   * a brain whose every weight is **zero** reached a commanded force of 0.77 and went on to *pass*
   * a rung. Every number in the first run of this suite was measuring drift, not policy.
   */
  const CLEAN: Partial<WorldSpec> = { reproMut: 0 }

  it('seeks food where the thrifty control does not, by a wide margin', () => {
    /*
     * The headline feasibility result: **Taxis is reachable, at 8.5× its threshold.** A brain wired
     * straight to the food gradient also drags `Feeds` to 4.05 and `Lasts` to 3.07 behind it, which
     * is the first time anything in this project has eaten deliberately.
     *
     * `thrifty` — every weight zero, living off its endowment, the strategy every learner here has
     * actually found — scores 0.00 on it. If the threshold errs, it errs lenient.
     */
    const control = run('thrifty', CLEAN)
    const taxis = run('taxis', CLEAN)
    expect(ratio(control.l, 'Taxis')).toBeLessThan(0.1)
    expect(ratio(taxis.l, 'Taxis')).toBeGreaterThan(3)
    expect(met(taxis.l, 'Taxis')).toBe(true)
  })

  it('reads the signal gradient off its own body — but only if it shouts first', () => {
    /*
     * Two findings here, and the second is about the world.
     *
     * The brain's own field input is a **scalar at its own position**; there is no gradient input.
     * The four limbs each report the field where they stand, in known quadrants, so a gradient is a
     * weighted sum of the four socket signals — the body as a sensor array. That part works, and
     * the rung reaches 1.80.
     *
     * It only works because the policy **shouts first**. A limb deposits into the field only when
     * its own neuron fires, and a limb neuron's largest input is what the brain told it — so with
     * every brain silent the field stays at zero, nothing has anything to report, and there is no
     * gradient: no signal, no field, no signal. The first version of this policy read the socket
     * signals, commanded nothing, and scored **identically to the do-nothing control to every
     * decimal place**. Adding a bias on the outbound signal outputs took it from 0.00 to 1.80.
     *
     * That is almost certainly why `Follows signal` measured 0.01 in every condition ever run.
     * Nothing was signalling, so there was nothing to follow.
     */
    expect(met(run('followsSignal', CLEAN).l, 'Follows signal')).toBe(true)
    expect(ratio(run('thrifty', CLEAN).l, 'Follows signal')).toBeLessThan(0.1)
  })
})

describe('what E8 found wrong with the ladder itself', () => {
  const CLEAN: Partial<WorldSpec> = { reproMut: 0 }

  it('cannot condition turning on food with a single linear layer', () => {
    /*
     * A turn is a rotation of the current heading, so conditioning its *rate* on the food count
     * wants `VEL_Y × FOOD_NEAR` — a **product of two inputs**, which one linear layer cannot
     * compute. The best linear attempt reaches 0.86, just short, which is worth knowing: the rung
     * is nearly reachable even without multiplication.
     *
     * The conclusion is about the world. Area-restricted search proper needs a hidden layer or a
     * multiplicative input. The one nonlinearity that exists is the `tanh` at each limb, reachable
     * through the socket signals — which is how `followsSignal` works, and the direction a serious
     * attempt should take.
     */
    expect(HAND_BUILT.lingers.representable).toBe(false)
    expect(ratio(run('lingers', CLEAN).l, 'Lingers')).toBeLessThan(1)
  })

  it('no longer lets plain chemotaxis pass Lingers', () => {
    /*
     * Fixed, and the fix was to change *when* the rung looks rather than what it measures.
     *
     * A gradient-follower turns whenever the gradient turns, and a gradient turns most inside a
     * patch — exactly where the food count is high. So `taxis`, which only knows how to swim up a
     * gradient, scored **4.64** on a rung meant to isolate lingering. Counting only ticks where
     * the gradient direction barely moved removes the mechanism: it now scores **0.52**.
     */
    expect(met(run('taxis', CLEAN).l, 'Lingers')).toBe(false)
    expect(ratio(run('taxis', CLEAN).l, 'Lingers')).toBeLessThan(1)
  })

  it('does not let a world where nothing moves pass a rung about moving', () => {
    /*
     * Two bugs, both mine, both found by the control.
     *
     * The rung required a structure to travel **1.5× faster** than a solitary organism, which is
     * physically impossible: the dynamics are overdamped, velocity goes as force over drag, and in
     * a structure of N members both scale with N — so a perfectly coherent structure moves at
     * exactly solo speed and never faster. Nothing could ever have passed it. The claim worth
     * making is that a structure *keeps up* rather than cancelling itself out, so the threshold is
     * 0.8.
     *
     * Then, reading the best sample in the window instead of whatever structure existed at the
     * instant of asking, the **do-nothing control scored 17.36** — because a maximum over a
     * *ratio* seeks out the sample where the denominator was smallest, and in a world where nothing
     * moves the solitary baseline is near zero. Two guards: the baseline must itself be moving, and
     * the window is summarised by its **median** of qualifying samples rather than its maximum.
     */
    expect(met(run('thrifty', CLEAN).l, 'Moves together')).toBe(false)
    expect(ratio(run('thrifty', CLEAN).l, 'Moves together')).toBe(0)
  })

  it('splits travelling from persisting, and neither is demonstrated yet', () => {
    /*
     * The rung is `min(heldFrac / 0.25, travel / solo)`, and which half fails is **not a property
     * of the world** — it changes with the horizon.
     *
     * Measured on the same bonding chemistry, same seed, same policy:
     *
     * | ticks | order | heldFrac | which half binds |
     * |---|---|---|---|
     * | 9,000 | > 3 | **0.554** | travel |
     * | 12,000 | 41 | **0.057** | hold |
     *
     * A tenfold swing in `heldFrac` from run length alone, because it divides a structure's age by
     * the **windowed mean completed lifespan** — a denominator that moves as lives finish. The
     * docs already warned that the figure is unreliable on short runs; this shows it is unreliable
     * on long ones too, in the other direction.
     *
     * So `Moves together` is really two rungs wearing one threshold, and the composite is less
     * informative than either part. Travel against a solitary baseline is sound and reached about
     * **13×** at 12,000 ticks. Persistence is the hard thing nothing in this world can do yet, and
     * it deserves its own rung with a denominator that does not move.
     */
    const r = run('movesTogether', { ...CLEAN, A: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5] })
    const o = r.w.orders.stats(r.w).oldest
    /*
     * At least the rung's own minimum. It was `> 3` and reads exactly 3 now: worlds grow their own
     * populations rather than being handed one, so there are fewer organisms around to join a
     * structure and the ones that form are smaller. The claim this test needs is that structures
     * of a countable size exist at all, so that the two collective rungs failing below is about
     * the rungs rather than about there being nothing to measure.
     */
    expect(o?.order ?? 0).toBeGreaterThanOrEqual(3)
    // but neither collective rung is met: typically they neither keep up nor last
    expect(met(r.l, 'Moves together')).toBe(false)
    expect(met(r.l, 'Holds together')).toBe(false)
  })

  it('measures persistence against a yardstick no horizon can move', () => {
    /*
     * `Holds together` replaces the half of the old rung that divided a structure's age by the
     * **windowed mean completed lifespan** — a denominator that moves as lives finish. Same world,
     * same seed, same policy gave `heldFrac` 0.554 at 9,000 ticks and 0.057 at 12,000, so which
     * half of the conjoined rung bound depended on the horizon rather than on the world.
     *
     * Coasting time — endowment over the laws' upkeep rate — depends on neither the metabolism dial
     * nor on how many organisms have happened to die. It is the same yardstick `Lasts` uses.
     */
    const short = run('movesTogether', { ...CLEAN, A: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5] }, 6000)
    const long = run('movesTogether', { ...CLEAN, A: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5] }, 9000)
    // both far below threshold, and neither wildly different from the other: no horizon artefact
    expect(ratio(short.l, 'Holds together')).toBeLessThan(0.5)
    expect(ratio(long.l, 'Holds together')).toBeLessThan(0.5)
  })

  it('cannot be asked of a fixed brain whether it improves', () => {
    // `Improves` and `Lineage improves` ask for change within a life and across lives. A written
    // policy failing them is not evidence about the ladder, which is why they are excluded by
    // construction rather than merely absent.
    const r = run('taxis', CLEAN)
    expect(met(r.l, 'Improves')).toBe(false)
    expect(met(r.l, 'Lineage improves')).toBe(false)
  })
})
