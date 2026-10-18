import { census } from './metrics'
import type { Paired } from './cognition'
import type { World } from './world'

/**
 * How far a world has got, as a ladder of **intelligence**.
 *
 * The axis changed, and that is the most important thing about this file. It used to measure levels
 * of biological *organisation* — matter, metabolism, agency, heredity, association, collective —
 * and most of those are not intelligence at all: a bacterial mat has heredity, association and
 * collective structure, and knows nothing. Measured, a **blind** world whose organisms had random
 * weights and no learner met **nine of thirteen** rungs, including "a held structure travelling
 * three times what drift gives". The ladder was describing the world rather than the organisms in
 * it.
 *
 * So the rungs now ask one question in seven increasingly demanding forms: **does behaviour exploit
 * a particular kind of information, in a way that a null destroying exactly that information does
 * not reproduce?** Current input, then context-dependence, then adaptation within a life, then
 * accumulation across lives, then other organisms' information, then acting as a collective. Each
 * tier needs strictly more than the one below it.
 *
 * Three rules keep the rungs honest, and every one of them comes from a trivial organism that
 * defeated an earlier version. They are stated in full in `cognition.ts`; in short:
 *
 * 1. **Commanded motion, never realised motion**, because a crowded patch jostles whatever is in
 *    it and a well-fed organism can afford to move more.
 * 2. **Time-shuffled conditioners, never rotation.** Rotating the food direction is defeated by
 *    "always swim north" in a world whose food is north — that organism scores a large
 *    aligned-minus-rotated difference while using no information whatever.
 * 3. **Efficiency, never throughput.** An organism that merely *grows* harvests more because it has
 *    more limbs; one that drifts into a patch harvests more because of where it is. Both get more
 *    *encounters*. Only skill improves the *conversion* of encounters into meals.
 *
 * Two further rules carried over from the previous design and still earning their place:
 *
 * - **Every statistic is windowed** — completed lives over a ring of the recent dead, presence over
 *   a ring of recent samples. A rung describes a sustained condition, never one lucky tick.
 * - **Hysteresis**: a rung turns on at its threshold and off only below 70% of it, so a live
 *   readout cannot flicker while a statistic sits on the line.
 *
 * And **every claim needs both significance and an effect size.** The first version of the seeking
 * rung reported *z = 133* for an alignment of about 0.3: pooled over hundreds of lives, any
 * consistent bias clears a z-test, which says the effect is not zero and nothing about whether it
 * matters. Each rung below takes the minimum of the two.
 *
 * The ladder also yields a **continuous score** — each rung's progress toward its threshold, capped
 * at one and summed — because a search needs a gradient and a rung number is a cliff.
 */

/**
 * The tiers, by what an organism has to be able to do.
 *
 * `Viable` is not intelligence and is not pretending to be: it is the precondition, because
 * nothing that cannot stay alive and feed itself can demonstrate anything else. Everything above
 * it is a claim about information.
 */
export const LEVELS = ['Viable', 'Reactive', 'Discriminative', 'Adaptive', 'Cumulative', 'Social', 'Collective'] as const

/**
 * How much better than its world a structure's members must agree, to count as moving together.
 *
 * **1.0 is the null itself**, which is the cleanest calibration available and is why this is not a
 * tuned number. The statistic is the structure's command agreement above chance divided by the same
 * figure over every organism alive, so it is 1.0 exactly when a structure agrees no better than the
 * world it sits in — whether that world is incoherent or swept by a common current.
 *
 * The previous value, 0.8, became actively wrong when the statistic changed: dividing by it meant
 * passing structures that agreed *less* than their world. It dated from a measure of centroid speed
 * against a solitary baseline, and all four versions of that baseline failed — see `agreement` in
 * orders.ts and tests/coordination.test.ts for which, and what each one read.
 *
 * Measured margins either side: an unaided world reads 0.37, and a synthetic structure agreeing
 * genuinely better than its world reads 1.2 under a strong global current and above 3 under a weak
 * one. The gap is real in both directions.
 */
const AGREE_OVER_WORLD = 1.0

/** A structure has to be this big, and this old in ticks, before either collective rung reports. */
const STRUCT_MIN_ORDER = 3
const STRUCT_MIN_AGE = 500


/**
 * How fast the solitary population must itself be moving for a comparison against it to mean
 * anything.
 *
 * Without this floor the rung is passed by a world where **nothing moves at all**. The do-nothing
 * control scored **17.36** on it: its organisms only drift, so the baseline was near zero, and a
 * structure drifting slightly faster than a near-zero denominator gives an enormous ratio. You
 * cannot measure "keeps up with a solitary organism" against a population that is standing still.
 */

/** Coasting times a structure must outlast to count as holding together. */
const HOLD_COASTS = 3

/**
 * Completed lives needed before the tier-0 rungs report anything.
 *
 * Ten, because a p90 over fewer is just the second-largest value. In a real run `Lasts` first
 * latched at exactly 10 lives and `Feeds` at 17, so this costs almost nothing and removes the
 * single-death false positive entirely.
 */
const MIN_LIVES = 10

export interface Rung {
  n: number
  /** Which level of organisation this rung belongs to, as an index into LEVELS. */
  level: number
  name: string
  /** What it takes, in words. */
  needs: string
  met: boolean
  /** Where this world currently stands against it. */
  at: string
  /** Progress toward the threshold; 1 means met. Floored at zero, not capped. */
  ratio: number
}

export interface Ladder {
  /** The highest rung index with no gaps below it. */
  reached: number
  top: number
  /** The highest *level* at which every rung at and below it holds, or -1. */
  level: number
  levelName: string
  /** Sum over rungs of min(1, ratio): the search gradient. */
  score: number
  /**
   * How many rungs are met in total, gaps and all.
   *
   * `level` and `reached` both stop at the first gap, which is right — self-sufficiency really
   * does come before structure. But measured across two hundred thousand worlds the lower rungs
   * are the walls: 0.2% have organisms that out-earn their birth endowment, while 81% get them
   * bonding and 37% hold a structure together. Reporting only the gapped figure would say "level 0"
   * about a world that passes nine rungs of thirteen, which is true and useless.
   */
  passed: number
  rungs: Rung[]
  /** The first unmet rung, which is the thing to work on. */
  next: Rung | null
}

/** One finished life, as the ladder needs it. Everything here is known exactly at death. */
interface Life {
  /** Lifespan in units of this organism's own coasting time. */
  coasts: number
  /** Harvested over endowment: above one it lived on what it ate, not on what it was given. */
  fed: number
  /** Raw seeking sums, so a pooled z-score can be formed across many lives. */
  seekSum: number
  seekN: number
  parentJoined: boolean
  joined: boolean
  age: number
}

const RING = 256
const SAMPLES = 64
/** A rung that is on stays on until its statistic falls below this fraction of the threshold. */
const HYSTERESIS = 0.7

export class LadderTracker {
  private lives: Life[] = []
  private livesAt = 0
  /** Recent samples: was anything alive, was anything joined, and limbs per organism. */
  private sAlive: number[] = []
  private sJoined: number[] = []
  private sLimbs: number[] = []
  /**
   * The collective rungs, sampled as the **best seen in the window** rather than whatever existed
   * at the instant of asking.
   *
   * Every other sampled quantity here is a *presence* fraction, and a mean is right for those. A
   * structure is different: it comes and goes, so reading the one that happens to exist when the
   * ladder is consulted makes the rung flicker with membership churn. Measured on a bonding world:
   * the travel multiple reached 2.206 — nearly three times its threshold — while the rung reported
   * 0.00 at the end of the run, because the structure alive at that moment was 460 ticks old and
   * the guard wants 500. The capability was demonstrated and then forgotten.
   */
  private sTravel: number[] = []
  private sHold: number[] = []
  /** When each still-living lineage was first seen, so "outlives its members" is measurable. */
  private founded = new Map<number, number>()
  private met: boolean[] = []

  reset(): void {
    this.lives = []
    this.livesAt = 0
    this.sAlive = []
    this.sJoined = []
    this.sLimbs = []
    this.sTravel = []
    this.sHold = []
    this.founded.clear()
    this.met = []
  }

  /** Called by the world as a life ends, while its counters are still readable. */
  observeDeath(w: World, b: number, age: number): void {
    const life: Life = {
      coasts: age / Math.max(1, w.coastT[b]),
      fed: w.harvested[b] / Math.max(1e-9, w.endowment[b]),
      seekSum: w.seeking[b],
      seekN: w.seekTicks[b],
      parentJoined: w.parentJoined[b] > 0,
      joined: w.hasJoined[b] > 0,
      age,
    }
    if (this.lives.length < RING) this.lives.push(life)
    else this.lives[this.livesAt % RING] = life
    this.livesAt++
  }

  /** Called on the order tracker's cadence: presence measures and lineage founding dates. */
  /** Median coasting time over recent lives: a yardstick no dial and no death toll moves. */
  private medianCoast(): number {
    const xs = this.lives.filter((l) => l.coasts > 1e-9).map((l) => l.age / l.coasts)
    if (xs.length === 0) return 0
    const a = [...xs].sort((p, q) => p - q)
    return a[a.length >> 1]
  }

  observe(w: World): void {
    let alive = 0
    let limbs = 0
    const living = new Set<number>()
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.alive[b] || !w.isBrain(b)) continue
      alive++
      living.add(w.lineage[b])
      for (let s = 0; s < 4; s++) if (w.limbs[b * 4 + s] >= 0) limbs++
    }
    for (const l of living) if (!this.founded.has(l)) this.founded.set(l, w.tick)
    for (const l of [...this.founded.keys()]) if (!living.has(l)) this.founded.delete(l)

    const o = w.orders.stats(w)
    const push = (a: number[], v: number): void => {
      a.push(v)
      if (a.length > SAMPLES) a.shift()
    }
    push(this.sAlive, alive > 0 ? 1 : 0)
    push(this.sJoined, o.live.slice(1).some((n) => n > 0) ? 1 : 0)
    push(this.sLimbs, alive > 0 ? limbs / alive : 0)
    // the two collective quantities, recorded every sample so the window keeps the best
    const st = o.oldest
    let travelMult = 0
    let holdCoasts = 0
    if (st && st.order >= STRUCT_MIN_ORDER) {
      /*
       * **The structure's own members, before they joined.** A within-organism null, because every
       * between-group baseline tried here failed for a different reason and each failure looked
       * like the rung working — see `preJoinSpeed` in world.ts for the three and what each read.
       *
       * Size, anchoring and whereabouts are all held constant by construction, because it is the
       * same organism on both sides of the comparison. The floors are unchanged in spirit: enough
       * members contributing a baseline, and a baseline that is actually moving, since a ratio
       * against something stationary is a division by noise.
       */
      /*
       * Against chance, not against other organisms. `align` is how well the members' commanded
       * forces point the same way, and random commands align at `1 / sqrt(N)` — so the ratio below
       * is 1.0 for a structure whose members are pulling no better than at random, and above 1 only
       * if something is coordinating them. See `align` in orders.ts for why no population baseline
       * can do this job in a world that bonds this readily.
       */
      if (st.age >= STRUCT_MIN_AGE && st.alignN >= STRUCT_MIN_ORDER && st.alignPop > 1e-6) {
        // the structure's agreement above chance, against the world's: 1.0 when they agree alike
        travelMult = st.align / st.alignPop
      }
      const coast = this.medianCoast()
      if (coast > 1e-9) holdCoasts = st.age / coast
    }
    push(this.sTravel, travelMult)
    push(this.sHold, holdCoasts)
  }

  /**
   * The ladder as it stands.
   *
   * Note that this **advances the hysteresis state** — a rung's on/off memory updates on each
   * call — so it is meant to be called on a regular cadence (the sim worker does, four times a
   * second) rather than opportunistically. Calling it in a tight loop makes the hysteresis window
   * shorter in wall-clock terms; calling it once at the end of a run is fine, since every rung
   * then simply compares against its threshold.
   */
  stats(w: World): Ladder {
    const c = census(w)
    const struct = w.orders.stats(w).oldest
    const lives = this.lives

    const frac = (a: number[]): number => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0)
    const quantile = (xs: number[], q: number): number => {
      if (!xs.length) return 0
      const a = [...xs].sort((p, r) => p - r)
      return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]
    }

    /*
     * Tier 0 needs **enough completed lives to have a median**, and it had no floor at all.
     *
     * `quantile` returns the single element when handed one, so `Feeds` ("the *typical* life ate
     * more than it was given") and `Lasts` ("p90 lifespan") both fired off **n = 1**. Verified: one
     * recorded death that ate 3× its endowment and lasted 4 coasts met both rungs outright. And
     * tier 0 is the conjunction that gates `level` for the whole ladder, so one lucky early death
     * opened every rung above it.
     *
     * Every other rung here already has a floor — `SOLO_MIN_N` 5, `sN >= 60`, `minTicks` 200,
     * `gens.length >= 8`. These two were the omission. A p90 over fewer than ten values is the
     * second-largest of them, which is not a p90.
     */
    const enoughLives = lives.length >= MIN_LIVES
    const fedMedian = enoughLives ? quantile(lives.map((l) => l.fed), 0.5) : 0
    const coastsP90 = enoughLives ? quantile(lives.map((l) => l.coasts), 0.9) : 0

    /*
     * What was here, and why it is gone.
     *
     * A pooled z-score of movement–food alignment against a random-walk null, the oldest-lineage
     * age, and a transmission ratio for whether children of joiners join more. All three were
     * measurements of organisation rather than of intelligence, and two of them were defeated by
     * trivial organisms: the alignment z reported 133 for an effect of 0.3 because pooling over
     * hundreds of lives makes any consistent bias significant, and the geometry of `r_eat` moved
     * it with no learner present at all. Their replacements live in `cognition.ts`, where the null
     * is a time-shuffle of the organism's own conditioners rather than a theoretical distribution.
     */

    /*
     * Collective: did the structure go further than its members would have gone alone?
     *
     * This was measured against **thermal diffusion** — `sqrt(2·μ·T·age/k)`, the drift of a
     * passive clump of k particles — and that is the wrong null in kind, not merely too low. A
     * random brain is a *constant* policy: `tanh` of a fixed linear combination is a fixed force,
     * so a random organism swims persistently in one direction and its net displacement grows far
     * faster than the square root of time. Measured directly: a **solitary** organism with random
     * weights and no senses reached 0.76 to 2.27× the "three times drift" bar by itself, which is
     * why a blind world with no learner was passing this rung.
     *
     * The null is now what a solitary organism in *this* world achieves (`w.soloSpeed()`), so the
     * rung asks what its name says. Two further consequences worth having: it cancels every dial,
     * since temperature and mobility and brain force all apply equally to both sides; and a fast
     * centroid *implies* coherence, because a structure whose members mill about independently has
     * a centroid that hardly moves however much its parts do.
     */
    /*
     * Collective: did the structure go further than its members would have gone alone?
     *
     * Three guards, each from a measured failure of an earlier version:
     *
     * - the null is what a **currently unbonded** organism in this world achieves, not thermal
     *   diffusion. A random brain is a constant policy, so a random organism swims persistently and
     *   its displacement grows far faster than the square root of time: a *solitary* organism with
     *   random weights reached 0.76–2.27× the old "three times drift" bar on its own.
     * - the baseline needs **enough organisms to be a baseline**. It once excluded anything that had
     *   *ever* joined, and `hasJoined` is sticky for life, so in a world that bonds well every
     *   organism was excluded and the rung silently reported zero — a structure of order 41 moving
     *   at 0.767 scored nothing. Asking who is currently unbonded fixes that, and then a baseline
     *   drawn from one or two stragglers let an unaided world through. Both are ruled out by
     *   requiring a sample.
     * - the structure must be **old enough in absolute ticks** for its displacement to mean
     *   anything, which replaces the horizon-sensitive fraction this rung used to multiply in.
     */
    /*
     * Both collective rungs read the **best sample in the window**, recorded by `observe`.
     *
     * See `sTravel` for why: a structure is intermittent, so asking about whichever one exists at
     * this instant made the rung forget a capability it had already demonstrated.
     */
    /**
     * The **median** of the samples that qualified, not the maximum.
     *
     * A maximum over a *ratio* seeks out the noisiest sample in the window — the one where the
     * denominator happened to be smallest — which is how the do-nothing control came to score
     * 17.36 on a rung about moving. The median of qualifying samples asks the honest question:
     * when there was a structure worth measuring, did it typically keep up?
     */
    const medianOfQualifying = (a: number[]): number => {
      const xs = a.filter((v) => v > 0).sort((p, q) => p - q)
      return xs.length === 0 ? 0 : xs[xs.length >> 1]
    }
    const soloMultiple = medianOfQualifying(this.sTravel)
    const travelRatio = soloMultiple / AGREE_OVER_WORLD
    /*
     * Hold keeps the **maximum**, and the asymmetry is deliberate: its denominator is a coasting
     * time, which is stable and positive, so there is no small-denominator hazard — and "a
     * structure once lasted this long" is the claim the rung is actually making.
     */
    const heldCoasts = this.sHold.reduce((m, v) => (v > m ? v : m), 0)

    const rungs: Rung[] = []
    const add = (level: number, name: string, needs: string, ratio: number, at: string): void => {
      const r = Number.isFinite(ratio) ? Math.max(0, ratio) : 0
      const i = rungs.length
      // hysteresis: on at the threshold, off only well below it
      const met = (this.met[i] ?? false) ? r >= HYSTERESIS : r >= 1
      this.met[i] = met
      rungs.push({ n: i, level, name, needs, met, at, ratio: r })
    }

    /*
     * The cognition instrument, over the organisms alive right now.
     *
     * Living organisms rather than the recent dead, because every tier above `Viable` is a claim
     * about *behaviour*, and behaviour is a property of something doing it. A dead organism's
     * accumulated record is still in there, but its slot has been reset for the next occupant.
     */
    const members: { b: number; gen: number; age: number }[] = []
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (w.isBrain(b) && w.alive[b]) members.push({ b, gen: w.gen[b], age: w.tick - w.bornAt[b] })
    }
    const cog = w.cognition.stats(members)

    /**
     * Both halves of a claim, or neither.
     *
     * Significance without an effect size is how the old seeking rung came to report *z = 133* for
     * an alignment of 0.3: pooled over hundreds of lives any consistent bias clears a z-test,
     * which establishes that the effect is not exactly zero and says nothing about whether it is
     * worth having. The minimum of the two is the only honest summary.
     */
    const both = (p: Paired, minEffect: number): number => Math.min(p.z / 3, p.effect / minEffect)

    // ---- tier 0: viable. Not intelligence — the precondition for showing any ----------------
    add(0, 'Persists', 'anything alive, and staying that way', c.organisms > 0 ? frac(this.sAlive) : 0, `${c.organisms} alive`)
    add(0, 'Feeds', 'the typical life ate more than it was given', fedMedian, `ate ${fedMedian.toFixed(2)}× its endowment`)
    /*
     * Two conditions, because either alone is buyable by the metabolism dial.
     *
     * Coasting time alone rewarded *expensive* living: the yardstick shrinks with upkeep faster
     * than lifespan does, so the shortest-lived organisms scored highest. An absolute floor alone
     * rewards *cheap* living, where everything merely happens more slowly. Requiring both — a life
     * long in ticks, and longer than a free ride on the endowment gives — is the only version
     * neither direction of the dial can game.
     */
    const lifeP90 = enoughLives ? quantile(lives.map((l) => l.age), 0.9) : 0
    add(
      0,
      'Lasts',
      'long lives: 2,000 ticks, and twice what coasting on the endowment allows',
      Math.min(coastsP90 / 2, lifeP90 / 2000),
      enoughLives ? `p90 ${Math.round(lifeP90)}t, ${coastsP90.toFixed(2)} coasts` : `only ${lives.length} lives so far`,
    )

    // ---- tier 1: reactive. Acts on what it senses now ---------------------------------------
    add(
      1,
      'Taxis',
      'steers toward food, beyond the same gradients shuffled in time',
      both(cog.taxis, 0.1),
      `${cog.taxis.effect.toFixed(3)} over shuffled, z ${cog.taxis.z.toFixed(1)}`,
    )

    // ---- tier 2: discriminative. Behaves differently in different situations ------------------
    /*
     * Area-restricted search: turn more where food is dense, press on where it is not. The
     * classic foraging behaviour, and the cheapest possible evidence of context-dependence.
     *
     * Measured on **commanded turning**, and that choice is doing the work. Speed conditioned on
     * food fails twice: a well-fed organism can afford more movement, and a dense patch physically
     * deflects whatever is inside it. Neither makes a brain *turn*, and a command cannot be
     * deflected. The sign matters too — turning *up* where food is dense is the behaviour; the
     * reverse is a different strategy and not this rung.
     */
    add(
      2,
      // "Lingers" rather than "Area-restricted search": the same behaviour, in a name that fits
      // the rail and says what it looks like from outside
      'Lingers',
      'turns more where food is dense, beyond the same counts shuffled in time',
      both(cog.search, 0.05),
      `${cog.search.effect.toFixed(3)} over shuffled, z ${cog.search.z.toFixed(1)}`,
    )

    // ---- tier 3: adaptive. Gets better within one life ---------------------------------------
    /*
     * Conversion, not harvest. An organism that merely grows has more limbs and so more mouths; one
     * that drifts into a patch and stays has more food around it. Both raise the harvest rate over
     * a life with nothing learned, and both were passing an earlier version of this rung. Meals per
     * unit of food *exposure* separates skill from growth and from luck, because growth and luck
     * buy encounters and only skill improves what is done with them.
     *
     * A sign test over organisms, because the ratio is heavy-tailed at small counts and one lucky
     * streak would otherwise carry the statistic. Under the null — the organism's own time order
     * carrying no trend — improving is a coin flip.
     */
    add(
      3,
      'Improves',
      'organisms convert encounters into meals a quarter better late in life than early',
      both(cog.improves, Math.log(1.25)),
      cog.improves.n > 0 ? `${Math.round(100 * (Math.exp(cog.improves.effect) - 1))}% better late, z ${cog.improves.z.toFixed(1)}` : 'none old enough',
    )

    // ---- tier 4: cumulative. Later lives are better than earlier ones ------------------------
    /*
     * Among **contemporaries**, not in sequence. Generation number otherwise counts elapsed time,
     * so any world-wide improving trend — food accumulating, a population settling — would pass
     * this rung without a single thing being inherited. Comparing organisms alive at the same
     * moment holds the world fixed and leaves only what descent contributed.
     */
    add(
      4,
      'Lineage improves',
      'among organisms alive together, later generations forage better',
      Math.min(cog.lineage.z / 3, cog.lineage.r / 0.2),
      cog.lineage.n > 0 ? `r ${cog.lineage.r.toFixed(2)} with gen, z ${cog.lineage.z.toFixed(1)}` : 'too few',
    )

    // ---- tier 5: social. Uses information that came from another organism --------------------
    /*
     * Only the part of the signal gradient **orthogonal to the food gradient** counts. Organisms
     * cluster where food is and their limbs deposit the field, so the raw signal gradient points
     * roughly where food does — and this rung would be passed by anything that merely follows
     * food, which is tier 1. The orthogonal component is the only part that carries information
     * the food gradient did not already have.
     */
    add(
      5,
      'Follows signal',
      "steers by other organisms' signals, beyond what the food gradient already says",
      both(cog.social, 0.1),
      `${cog.social.effect.toFixed(3)} over shuffled, z ${cog.social.z.toFixed(1)}`,
    )

    // ---- tier 6: collective. The structure, not the organism, is the thing acting ------------
    add(
      6,
      'Moves together',
      `a structure of order ${STRUCT_MIN_ORDER}+ whose members pull together better than the world does`,
      travelRatio,
      soloMultiple > 0
        ? `${soloMultiple.toFixed(2)}× the world's own agreement`
        : !struct
          ? 'none'
          : struct.order < STRUCT_MIN_ORDER
            ? `only order ${struct.order}`
            : `order ${struct.order}, none held long enough to tell`,
    )
    add(
      6,
      'Holds together',
      `a structure of order ${STRUCT_MIN_ORDER}+ lasting ${HOLD_COASTS} coasting times`,
      heldCoasts / HOLD_COASTS,
      struct ? `${struct.order}° for ${heldCoasts.toFixed(2)} coasts` : 'none',
    )

    let reached = -1
    for (const r of rungs) {
      if (!r.met) break
      reached = r.n
    }
    let level = -1
    for (let L = 0; L < LEVELS.length; L++) {
      if (rungs.filter((r) => r.level <= L).every((r) => r.met)) level = L
      else break
    }
    return {
      reached,
      top: rungs.length - 1,
      level,
      levelName: level >= 0 ? LEVELS[level] : 'nothing yet',
      score: rungs.reduce((a, r) => a + Math.min(1, r.ratio), 0),
      passed: rungs.filter((r) => r.met).length,
      rungs,
      next: rungs.find((r) => !r.met) ?? null,
    }
  }
}

/** One-shot evaluation. The tracker lives on the world, since it has to watch deaths as they happen. */
export function ladder(w: World): Ladder {
  return w.ladderT.stats(w)
}
