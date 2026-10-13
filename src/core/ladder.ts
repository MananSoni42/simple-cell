import { census } from './metrics'
import type { World } from './world'

/**
 * How far a world has got, as a ladder of milestones in six levels of organisation.
 *
 * The levels follow the shape of the major transitions: matter persists → it feeds itself → it
 * behaves → it breeds true → organisms become parts of structures → a structure becomes an
 * individual in its own right. Each level's units are the next level's *parts*, which is what
 * makes this a hierarchy of complexity rather than a list sorted by difficulty. A level is reached
 * only when every rung at and below it holds, so the ladder is only ever as high as its lowest gap.
 *
 * Three rules keep the rungs honest, and they are the point of this file:
 *
 * 1. **Every threshold is a comparison against a null, in the world's own units.** Lifespan is
 *    measured in *coasting times* — how long a newborn survives doing nothing — so slowing the
 *    metabolism cannot buy the rung, which the old absolute "1,000 ticks" quietly did. Seeking is
 *    a z-score against a random walk. A structure's age is a fraction of its members' lifespan,
 *    and its travel is measured against the diffusion of a clump its size. No dial changes what a
 *    rung means, which also means a search cannot game one.
 * 2. **Every statistic is windowed**: completed lives over a ring of the recent dead, presence
 *    measures over a ring of recent samples. A rung describes a sustained condition, never one
 *    lucky tick.
 * 3. **Hysteresis**: a rung turns on at its threshold and off only below 70% of it, so a live
 *    readout cannot flicker while a statistic sits on the line.
 *
 * The ladder also yields a **continuous score** — each rung's progress toward its threshold,
 * capped at one and summed — because a search needs a gradient and a rung number is a cliff. Two
 * worlds stuck at the same level still rank by how close the next rung is.
 */

export const LEVELS = ['Matter', 'Metabolism', 'Agency', 'Heredity', 'Association', 'Collective'] as const

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
    const n = lives.length

    const frac = (a: number[]): number => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0)
    const quantile = (xs: number[], q: number): number => {
      if (!xs.length) return 0
      const a = [...xs].sort((p, r) => p - r)
      return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]
    }

    // metabolism: lives against their own endowment, so no dial can buy these rungs
    const fedMedian = quantile(lives.map((l) => l.fed), 0.5)
    const coastsP90 = quantile(lives.map((l) => l.coasts), 0.9)

    // agency: pooled z against the random-walk null. The cosine of a random heading has mean 0 and
    // variance 1/2, so a sum over N decided ticks has standard deviation sqrt(N/2)
    let seekSum = 0
    let seekN = 0
    for (const l of lives) {
      seekSum += l.seekSum
      seekN += l.seekN
    }
    const seekZ = seekN > 0 ? seekSum / Math.sqrt(seekN / 2) : 0
    /*
     * The mean alignment, and why significance alone will not do.
     *
     * Pooled over a few hundred lives the decided-tick count reaches six figures, and a z-score
     * grows with sqrt(N): an alignment of 0.01 — indistinguishable from a random walk to any eye —
     * clears z ≥ 3 easily, and the first run of this rung reported **z = 133**. The z-score is the
     * right guard against noise and the wrong statement of the claim. So the rung needs both: the
     * effect must be real (z) *and* worth having (mean), and the rung reports the mean, because
     * that is the number with a meaning — the cosine between where a body went and where food was.
     */
    const seekMean = seekN > 0 ? seekSum / seekN : 0

    // heredity: the lineage, rather than the organism, as the thing that persists
    const meanLife = n ? lives.reduce((a, l) => a + l.age, 0) / n : 0
    let oldestLineage = 0
    for (const [, t0] of this.founded) oldestLineage = Math.max(oldestLineage, w.tick - t0)

    // collective: did the structure go anywhere, against the drift of a clump its size? The
    // centroid of k particles diffuses with 1/k the variance of one particle
    let travelRatio = 0
    if (struct && struct.age > 0) {
      const particles = Math.max(2, struct.order * 5)
      const nullDrift = Math.sqrt((2 * w.L.mu * w.init.T * struct.age) / particles)
      travelRatio = struct.travel / Math.max(1e-9, 3 * nullDrift)
    }

    // transmission: do children of joiners join more? Laplace-smoothed, and silent below eight of
    // each, because a ratio of two small counts is noise with an opinion
    let transmit = 0
    let transmitAt = 'too few lives to tell'
    const pj = lives.filter((l) => l.parentJoined)
    const ps = lives.filter((l) => !l.parentJoined)
    if (pj.length >= 8 && ps.length >= 8) {
      const rJ = (pj.filter((l) => l.joined).length + 1) / (pj.length + 2)
      const rS = (ps.filter((l) => l.joined).length + 1) / (ps.length + 2)
      transmit = rJ / rS / 2 // met at twice the solitary rate
      transmitAt = `${(rJ / rS).toFixed(2)}× the solitary rate`
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

    add(0, 'Persists', 'anything alive, and staying that way', c.organisms > 0 ? frac(this.sAlive) : 0, `${c.organisms} alive`)
    add(1, 'Feeds', 'the typical life ate more than it was given', fedMedian, `ate ${fedMedian.toFixed(2)}× its endowment`)
    /*
     * Two conditions, because either alone is buyable by the metabolism dial.
     *
     * Coasting time alone rewarded *expensive* living: the yardstick shrinks with upkeep faster
     * than lifespan does, so the shortest-lived organisms scored the highest. An absolute floor
     * alone rewards *cheap* living, where everything simply happens more slowly. Requiring both —
     * a life long in ticks, and longer than a free ride on the endowment would give — is the only
     * version neither direction of the dial can game.
     */
    const lifeP90 = quantile(lives.map((l) => l.age), 0.9)
    add(
      1,
      'Lasts',
      'long lives: 2,000 ticks, and twice what coasting on the endowment allows',
      Math.min(coastsP90 / 2, lifeP90 / 2000),
      `p90 ${Math.round(lifeP90)}t, ${coastsP90.toFixed(2)} coasts`,
    )
    add(
      2,
      'Seeks',
      'movement aligned with food: real (z ≥ 3) and worth having (mean ≥ 0.25)',
      Math.min(seekZ / 3, seekMean / 0.25),
      `alignment ${seekMean.toFixed(3)} (z ${seekZ.toFixed(0)})`,
    )
    add(2, 'Keeps its body', 'three and a half limbs each, held', frac(this.sLimbs) / 3.5, `${frac(this.sLimbs).toFixed(2)} limbs`)
    add(3, 'Breeds true', 'grandchildren: generation three alive', c.maxGen / 3, `gen ${c.maxGen}`)
    add(
      3,
      'Lineage outlives',
      'a living lineage five lifetimes old',
      meanLife > 0 ? oldestLineage / (5 * meanLife) : 0,
      `${Math.round(oldestLineage)}t vs life ${Math.round(meanLife)}t`,
    )
    add(4, 'Joins', 'order-2 or more present half the time', frac(this.sJoined) / 0.5, `joined in ${Math.round(100 * frac(this.sJoined))}% of samples`)
    add(
      4,
      'Holds',
      'order 3+, holding half a lifetime',
      struct ? Math.min(struct.order / 3, struct.heldFrac / 0.5) : 0,
      struct ? `${struct.order}° at ${Math.round(100 * struct.heldFrac)}% of a life` : 'none',
    )
    add(
      4,
      'Renews',
      'held, with as many members replaced as it has',
      struct ? Math.min(struct.heldFrac / 0.5, struct.replacements / Math.max(1, struct.order)) : 0,
      struct ? `${struct.replacements} replaced of ${struct.order}` : 'none',
    )
    add(
      5,
      'Moves together',
      'a held structure travelling three times what drift gives',
      struct ? Math.min(struct.heldFrac / 0.25, travelRatio) : 0,
      struct ? `travelled ${Math.round(struct.travel)} against drift` : 'none',
    )
    add(5, 'Transmits joining', 'children of joiners join twice as often as others', transmit, transmitAt)
    add(
      5,
      'Grows from within',
      'a held structure with a birth inside it',
      struct && struct.births > 0 ? Math.min(1, struct.heldFrac / 0.5) : 0,
      struct ? `${struct.births} births inside` : 'none',
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
