import { Rng } from './rng'

/**
 * What an organism does with what it knows.
 *
 * This module exists because the ladder's job changed. It used to measure levels of biological
 * *organisation* — heredity, association, collective structure — and a bacterial mat has all three
 * and no intelligence. The rungs here measure something narrower and harder: **behaviour that
 * exploits a particular kind of information, in a way a null that destroys exactly that
 * information does not reproduce.**
 *
 * Three rules run through every measurement, and each of them comes from a specific trivial
 * organism that defeated an earlier version:
 *
 * 1. **Commanded motion, never realised motion.** A crowded food patch physically jostles whatever
 *    is in it, and a well-fed organism can afford to move more. Both would show up as "behaviour
 *    correlated with food" in realised movement. The brain's *command* cannot be jostled and does
 *    not depend on what it can afford.
 *
 * 2. **Time-shuffled conditioners, never rotation.** Rotating the food direction by 90° looks like
 *    a perfect null — same magnitudes, no information — and it is defeated by "always swim north"
 *    in a world whose food is to the north. That organism scores a huge aligned-minus-rotated
 *    difference with no information use whatever. Pairing this tick's command with a food gradient
 *    *the same organism saw at a random earlier tick* fixes it: a genuine gradient-follower does
 *    worse on the shuffle, and a fixed-heading swimmer scores exactly the same, because its
 *    performance never depended on the pairing.
 *
 * 3. **Efficiency, never throughput.** An organism that merely *grows* gains limbs, so its harvest
 *    rate rises over its life with nothing learned; one that drifts into a patch and stays improves
 *    by location. Both give more *encounters*. Only skill gives better *conversion* of encounters
 *    into meals, so every learning rung is measured as meals per unit of food exposure.
 *
 * Nothing here can change the world: it reads, it accumulates, and it draws its shuffles from its
 * own random stream, so switching the measurements on moves nothing.
 */

/**
 * How many past conditioners each organism keeps, to draw its own shuffled null from.
 *
 * Held as a **reservoir sample of the whole life**, not as a ring of the most recent ticks, and the
 * difference is the difference between the null working and the null being useless. A ring of the
 * last 16 ticks draws a "random earlier tick" that is 16 ticks ago at most — and every conditioner
 * here is autocorrelated over far longer than that: a food gradient turns on a scale of tens of
 * ticks, a patch is hundreds across. So the shuffled gradient was nearly the *same* gradient, the
 * null scored almost as well as the real pairing, and a synthetic organism that followed the
 * gradient perfectly scored 0.155 where it should have scored near 1.
 *
 * A null that fails to destroy the information it is supposed to destroy does not make a rung
 * lenient, it makes it unreachable — which is the opposite failure to the one this ladder was
 * redesigned to fix, and just as fatal.
 */
const RING = 16

/** Timescale of the trailing efficiency average, and how long the early window lasts. */
const EARLY_TICKS = 1000
const EMA_TAU = 1000

/** A paired difference across organisms: the effect, its spread, and how many contributed. */
export interface Paired {
  /** Mean of (real − null) across organisms. */
  effect: number
  /** Standard error of that mean. */
  se: number
  /** How many organisms contributed. */
  n: number
  /** effect / se, or 0 when it cannot be formed. */
  z: number
}

export interface CognitionStats {
  /** Tier 1: commanded heading against the food gradient, minus the time-shuffled pairing. */
  taxis: Paired
  /** Tier 2: commanded turning rate correlated with the food count, minus the shuffled pairing. */
  search: Paired
  /** Tier 5: as taxis, but the part of the signal gradient orthogonal to the food gradient. */
  social: Paired
  /**
   * Tier 3: did organisms convert encounters into meals better late in life than early?
   *
   * A paired statistic over **log** ratios, like every other rung here, and it started life as a
   * sign test on "ratio > 1". That was degenerate: an organism whose conversion rate is exactly
   * flat — which is precisely what *growth* produces, since more limbs raise meals and exposure
   * together — has a ratio of exactly 1, and whether `> 1` fires is then decided by floating-point
   * noise. It counted all four synthetic growers as improving.
   *
   * A log ratio is 0 under no change, so the effect is signed, the spread across organisms is
   * real, and the claim needs both significance and a size like everything else.
   */
  improves: Paired
  /**
   * Tier 4: among organisms alive at the **same moment**, does a higher generation mean better
   * conversion? Contemporaries only, because generation number otherwise just counts elapsed time
   * and any world-wide improving trend would pass.
   */
  lineage: { r: number; n: number; z: number }
}

const EMPTY_PAIRED: Paired = { effect: 0, se: 0, n: 0, z: 0 }

/** One organism's view, handed in once per tick from `think`. */
export interface CogStep {
  b: number
  /** The commanded force — what the brain asked for, before the world had its say. */
  mx: number
  my: number
  /** The food gradient on the whole body, and the count of food within reach. */
  gx: number
  gy: number
  food: number
  /** The signal field's gradient at the brain. */
  sx: number
  sy: number
  /** Age in ticks, meals taken so far, and food exposure so far. */
  age: number
  meals: number
}

export class Cognition {
  private readonly rng: Rng
  /** Past conditioners per organism: [b*RING*5 + k*5] = gx, gy, food, sx, sy. */
  private readonly ring: Float64Array
  private readonly ringN: Int32Array

  // directional rungs: per-organism sums of real and shuffled alignment
  private readonly taxR: Float64Array
  private readonly taxS: Float64Array
  private readonly taxN: Float64Array
  private readonly socR: Float64Array
  private readonly socS: Float64Array
  private readonly socN: Float64Array

  // search: per-organism sums for a correlation between turning and the food count
  private readonly sT: Float64Array
  private readonly sF: Float64Array
  private readonly sFs: Float64Array
  private readonly sTF: Float64Array
  private readonly sTFs: Float64Array
  private readonly sT2: Float64Array
  private readonly sF2: Float64Array
  private readonly sFs2: Float64Array
  private readonly sN: Float64Array

  private readonly prevMx: Float64Array
  private readonly prevMy: Float64Array
  private readonly hasPrev: Uint8Array

  // efficiency: an early window frozen after EARLY_TICKS, and a trailing average
  private readonly earlyMeals: Float64Array
  private readonly earlyExp: Float64Array
  private readonly emaMeals: Float64Array
  private readonly emaExp: Float64Array
  private readonly lastMeals: Float64Array

  constructor(cap: number, seed: number) {
    // its own stream: a measurement that consumed the world's randomness would change the thing
    // it was measuring, which is the one thing an instrument may not do
    this.rng = new Rng((seed ^ 0x3c6ef372) | 0)
    this.ring = new Float64Array(cap * RING * 5)
    this.ringN = new Int32Array(cap)
    const f = (): Float64Array => new Float64Array(cap)
    this.taxR = f()
    this.taxS = f()
    this.taxN = f()
    this.socR = f()
    this.socS = f()
    this.socN = f()
    this.sT = f()
    this.sF = f()
    this.sFs = f()
    this.sTF = f()
    this.sTFs = f()
    this.sT2 = f()
    this.sF2 = f()
    this.sFs2 = f()
    this.sN = f()
    this.prevMx = f()
    this.prevMy = f()
    this.hasPrev = new Uint8Array(cap)
    this.earlyMeals = f()
    this.earlyExp = f()
    this.emaMeals = f()
    this.emaExp = f()
    this.lastMeals = f()
  }

  /** A new life in this slot: everything the previous occupant accumulated must go. */
  reset(b: number): void {
    this.ringN[b] = 0
    for (const a of [
      this.taxR, this.taxS, this.taxN, this.socR, this.socS, this.socN,
      this.sT, this.sF, this.sFs, this.sTF, this.sTFs, this.sT2, this.sF2, this.sFs2, this.sN,
      this.prevMx, this.prevMy, this.earlyMeals, this.earlyExp, this.emaMeals, this.emaExp, this.lastMeals,
    ]) {
      a[b] = 0
    }
    this.hasPrev[b] = 0
  }

  observe(s: CogStep): void {
    const { b } = s
    const nRing = this.ringN[b]

    // ---- the shuffled conditioner: one of this organism's own past ticks, chosen at random ----
    let shufGx = 0
    let shufGy = 0
    let shufFood = 0
    let shufSx = 0
    let shufSy = 0
    let haveShuffle = false
    if (nRing > 0) {
      const k = this.rng.int(Math.min(nRing, RING))
      const o = (b * RING + k) * 5
      shufGx = this.ring[o]
      shufGy = this.ring[o + 1]
      shufFood = this.ring[o + 2]
      shufSx = this.ring[o + 3]
      shufSy = this.ring[o + 4]
      haveShuffle = true
    }

    const mMag = Math.hypot(s.mx, s.my)

    // ---- tier 1: taxis -------------------------------------------------------------------
    /*
     * Only ticks where there was *something to perceive* count, so an organism that never
     * encounters food neither gains nor loses — scoring it zero would say it had failed to
     * respond, when it had nothing to respond to.
     */
    if (haveShuffle && mMag > 1e-9) {
      const gMag = Math.hypot(s.gx, s.gy)
      const sMag = Math.hypot(shufGx, shufGy)
      if (gMag > 1e-9 && sMag > 1e-9) {
        this.taxR[b] += (s.mx * s.gx + s.my * s.gy) / (mMag * gMag)
        this.taxS[b] += (s.mx * shufGx + s.my * shufGy) / (mMag * sMag)
        this.taxN[b] += 1
      }

      // ---- tier 5: social ----------------------------------------------------------------
      /*
       * The signal field's gradient, with its projection on the food gradient removed.
       *
       * Organisms cluster where food is, and their limbs deposit the field, so the raw signal
       * gradient points roughly where the food gradient points — and "follows signal" would be
       * passed by anything that merely follows food. Only the orthogonal part can distinguish
       * them.
       */
      const [ox, oy] = orthogonal(s.sx, s.sy, s.gx, s.gy)
      const [px, py] = orthogonal(shufSx, shufSy, s.gx, s.gy)
      const oMag = Math.hypot(ox, oy)
      const pMag = Math.hypot(px, py)
      if (oMag > 1e-9 && pMag > 1e-9) {
        this.socR[b] += (s.mx * ox + s.my * oy) / (mMag * oMag)
        this.socS[b] += (s.mx * px + s.my * py) / (mMag * pMag)
        this.socN[b] += 1
      }
    }

    // ---- tier 2: area-restricted search -------------------------------------------------
    /*
     * Turning, not speed, and *commanded* turning at that.
     *
     * Speed conditioned on food fails twice over: a well-fed organism can afford more movement
     * (mechanical, and contemporaneous, so a lagged null will not catch it), and a dense patch
     * physically deflects whatever is inside it. Neither of those makes a brain *turn*, and a
     * command cannot be deflected — so the change in commanded heading is clean where speed is not.
     */
    if (haveShuffle && this.hasPrev[b] && mMag > 1e-9) {
      const pMag = Math.hypot(this.prevMx[b], this.prevMy[b])
      if (pMag > 1e-9) {
        const cos = (s.mx * this.prevMx[b] + s.my * this.prevMy[b]) / (mMag * pMag)
        const turn = Math.acos(Math.min(1, Math.max(-1, cos))) // 0 = straight on, π = reversed
        this.sT[b] += turn
        this.sT2[b] += turn * turn
        this.sF[b] += s.food
        this.sF2[b] += s.food * s.food
        this.sTF[b] += turn * s.food
        this.sFs[b] += shufFood
        this.sFs2[b] += shufFood * shufFood
        this.sTFs[b] += turn * shufFood
        this.sN[b] += 1
      }
    }
    if (mMag > 1e-9) {
      this.prevMx[b] = s.mx
      this.prevMy[b] = s.my
      this.hasPrev[b] = 1
    }

    // ---- tiers 3 and 4: conversion of encounters into meals ------------------------------
    /*
     * Exposure is the food an organism has been *within reach of*, which is what separates skill
     * from luck and from growth. More limbs or a richer patch both raise exposure; only getting
     * better at eating raises meals per unit of it.
     */
    const got = s.meals - this.lastMeals[b]
    this.lastMeals[b] = s.meals
    if (s.age <= EARLY_TICKS) {
      this.earlyMeals[b] += got
      this.earlyExp[b] += s.food
    }
    const decay = 1 - 1 / EMA_TAU
    this.emaMeals[b] = decay * this.emaMeals[b] + got
    this.emaExp[b] = decay * this.emaExp[b] + s.food

    // ---- remember this tick's conditioners, for a future tick's null ---------------------
    /*
     * Reservoir sampling (Vitter's R): after n ticks the RING slots hold a uniform sample of all
     * n of them. Fill while there is room, then replace a slot with probability RING/n — which is
     * exactly the rule that keeps the sample uniform over a history whose length is not known in
     * advance, and a life's length never is.
     */
    const seen = nRing + 1
    let slot = -1
    if (nRing < RING) slot = nRing
    else {
      const j = this.rng.int(seen)
      if (j < RING) slot = j
    }
    if (slot >= 0) {
      const o = (b * RING + slot) * 5
      this.ring[o] = s.gx
      this.ring[o + 1] = s.gy
      this.ring[o + 2] = s.food
      this.ring[o + 3] = s.sx
      this.ring[o + 4] = s.sy
    }
    this.ringN[b] = seen
  }

  /** Conversion of encounters into meals, late in life against early. 0 when not yet comparable. */
  improvement(b: number): number {
    const early = this.earlyExp[b] > 1e-9 ? this.earlyMeals[b] / this.earlyExp[b] : 0
    const late = this.emaExp[b] > 1e-9 ? this.emaMeals[b] / this.emaExp[b] : 0
    if (early <= 1e-12) return 0
    return late / early
  }

  /** Efficiency as it stands now, for the lineage comparison. */
  efficiency(b: number): number {
    return this.emaExp[b] > 1e-9 ? this.emaMeals[b] / this.emaExp[b] : 0
  }

  /**
   * The rungs, over whichever organisms are currently alive.
   *
   * `members` is the list of living brain indices with their generations, passed in rather than
   * discovered, so this module never has to know what a world is.
   */
  stats(members: { b: number; gen: number; age: number }[]): CognitionStats {
    const paired = (real: Float64Array, shuf: Float64Array, n: Float64Array, minTicks: number): Paired => {
      const ds: number[] = []
      for (const { b } of members) {
        if (n[b] < minTicks) continue
        ds.push((real[b] - shuf[b]) / n[b])
      }
      return pairedOf(ds)
    }

    // search: a per-organism correlation difference, which is the same paired shape
    const corrDs: number[] = []
    for (const { b } of members) {
      const n = this.sN[b]
      if (n < 200) continue
      const r = corr(n, this.sT[b], this.sF[b], this.sTF[b], this.sT2[b], this.sF2[b])
      const rs = corr(n, this.sT[b], this.sFs[b], this.sTFs[b], this.sT2[b], this.sFs2[b])
      if (Number.isFinite(r) && Number.isFinite(rs)) corrDs.push(r - rs)
    }

    // improves: log ratios over organisms old enough for the comparison to mean anything
    const logs: number[] = []
    for (const { b, age } of members) {
      if (age < 2 * EARLY_TICKS) continue
      const ratio = this.improvement(b)
      if (ratio > 0) logs.push(Math.log(ratio))
    }

    // lineage: generation against efficiency, among organisms alive right now
    const gens: number[] = []
    const effs: number[] = []
    for (const { b, gen, age } of members) {
      if (age < EARLY_TICKS) continue
      const e = this.efficiency(b)
      if (e <= 0) continue
      gens.push(gen)
      effs.push(e)
    }
    const r = pearson(gens, effs)
    // Fisher's z for a correlation, which is what makes a small sample's r honest
    const lineageZ = gens.length >= 8 && Number.isFinite(r) ? Math.atanh(Math.min(0.999, Math.max(-0.999, r))) * Math.sqrt(gens.length - 3) : 0

    return {
      taxis: paired(this.taxR, this.taxS, this.taxN, 200),
      social: paired(this.socR, this.socS, this.socN, 200),
      search: pairedOf(corrDs),
      improves: pairedOf(logs),
      lineage: { r: Number.isFinite(r) ? r : 0, n: gens.length, z: lineageZ },
    }
  }
}

/** The component of (ax, ay) perpendicular to (bx, by). */
function orthogonal(ax: number, ay: number, bx: number, by: number): [number, number] {
  const b2 = bx * bx + by * by
  if (b2 < 1e-18) return [ax, ay]
  const k = (ax * bx + ay * by) / b2
  return [ax - k * bx, ay - k * by]
}

function pairedOf(ds: number[]): Paired {
  const n = ds.length
  if (n < 4) return { ...EMPTY_PAIRED, n }
  const m = ds.reduce((a, x) => a + x, 0) / n
  const v = ds.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)
  const se = Math.sqrt(v / n)
  return { effect: m, se, n, z: se > 1e-12 ? m / se : 0 }
}

function corr(n: number, sx: number, sy: number, sxy: number, sx2: number, sy2: number): number {
  const cov = sxy / n - (sx / n) * (sy / n)
  const vx = sx2 / n - (sx / n) ** 2
  const vy = sy2 / n - (sy / n) ** 2
  if (vx <= 1e-18 || vy <= 1e-18) return Number.NaN
  return cov / Math.sqrt(vx * vy)
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 3) return Number.NaN
  let sx = 0
  let sy = 0
  let sxy = 0
  let sx2 = 0
  let sy2 = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
    sxy += xs[i] * ys[i]
    sx2 += xs[i] * xs[i]
    sy2 += ys[i] * ys[i]
  }
  return corr(n, sx, sy, sxy, sx2, sy2)
}
