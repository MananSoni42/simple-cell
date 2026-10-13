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
 * How much faster than a lone organism a structure has to travel to count as moving together.
 *
 * Above 1 by a clear margin, because equalling a solitary organism only shows that joining did not
 * *cost* mobility. Carrying a whole structure somewhere faster than its parts could go alone is
 * the claim worth a rung at the top level.
 */
const TRAVEL_OVER_SOLO = 1.5

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
  /** When each still-living lineage was first seen, so "outlives its members" is measurable. */
  private founded = new Map<number, number>()
  private met: boolean[] = []

  reset(): void {
    this.lives = []
    this.livesAt = 0
    this.sAlive = []
    this.sJoined = []
    this.sLimbs = []
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

    // metabolism: lives against their own endowment, so no dial can buy these rungs
    const fedMedian = quantile(lives.map((l) => l.fed), 0.5)
    const coastsP90 = quantile(lives.map((l) => l.coasts), 0.9)

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
    let travelRatio = 0
    /*
     * `null` where there is nothing solitary to compare against, rather than a number.
     *
     * The ratio already guarded this and reported 0, but the *readout* divided by a 1e-9 floor and
     * printed "2° at 141957922.73× solo" next to a rung showing 0% — a screen contradicting
     * itself, which is worse than a blank. If every organism has joined something there is no
     * baseline, and the honest display says so.
     */
    let soloMultiple: number | null = null
    if (struct && struct.age > 0) {
      const solo = w.soloSpeed()
      if (solo > 1e-9) {
        soloMultiple = struct.travel / struct.age / solo
        travelRatio = soloMultiple / TRAVEL_OVER_SOLO
      }
    }

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
    const lifeP90 = quantile(lives.map((l) => l.age), 0.9)
    add(
      0,
      'Lasts',
      'long lives: 2,000 ticks, and twice what coasting on the endowment allows',
      Math.min(coastsP90 / 2, lifeP90 / 2000),
      `p90 ${Math.round(lifeP90)}t, ${coastsP90.toFixed(2)} coasts`,
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
      `a held structure of order 3+ covering ground ${TRAVEL_OVER_SOLO}× faster than a solitary organism manages`,
      struct && struct.order >= 3 ? Math.min(struct.heldFrac / 0.25, travelRatio) : 0,
      !struct ? 'none' : soloMultiple === null ? `${struct.order}°, nothing solitary to compare` : `${struct.order}° at ${soloMultiple.toFixed(2)}× solo`,
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
