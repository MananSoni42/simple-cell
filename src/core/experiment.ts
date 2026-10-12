import { Cohort, type FitnessSpec, KEYS, N_SCALARS, describeSpec, keysOf, scalarsOf, specFromKeys } from './fitness'
import { LEARN_DEFAULTS, type LearnAlgo, type LearnConfig } from './learning'
import { type Init } from './params'
import { World } from './world'

/**
 * Paired experiments, because a single run proves nothing here.
 *
 * One subtlety is load-bearing, and it was found by this runner reporting *no* effect for a
 * learner that plainly had one. A percentile measured against the run's *own* recent dead is
 * zero-sum: lift the whole population and the cohort lifts with it, so the mean score stays at
 * 0.5 by construction. Percentiles are the right thing for *selection* — they make incommensurable
 * scalars combinable — and exactly the wrong thing for *progress*. So every variant is scored
 * against a **frozen reference cohort taken from the baseline run of the same seed**. A score of
 * 0.62 then means what it should: a typical life from this variant beat 62% of the lives the same
 * world produced with no learner at all.
 *
 * This world's variance is enormous: the same seed with a different food regime already swings
 * organism counts from 1 to 12. So every number a learner produces has to come from the *same
 * world* with the learner on and off, repeated over many seeds, reported as a median with spread.
 * That protocol is written down in LEARNING.md §7 and this file is its implementation — if it is
 * easier to run the paired comparison than to run one hopeful world, the honest thing is also the
 * convenient thing.
 */

export interface Outcome {
  seed: number
  variant: string
  ticks: number
  /** Population and lineage. */
  organisms: number
  peakOrganisms: number
  births: number
  budded: number
  deaths: number
  maxGen: number
  /** Lifespan of the longest-lived organism in the run. */
  recordAge: number
  meanAge: number
  /** The pre-registered measure, averaged over every life that ended in the second half. */
  fitness: number
  /**
   * The raw mean of *every* scalar over the same lives, whether or not it was optimised.
   *
   * This is not decoration. A learner that improves its own measure while the world empties out
   * has learned nothing worth having, and the only way to see that is to report what nobody asked
   * for alongside what they did.
   */
  scalars: Record<string, number>
  /** What was being optimised, so two outcomes can be checked for comparability. */
  measure: string
  /** What the learner itself thinks it achieved, for sanity against `fitness`. */
  learnerBest: number
  learnerSeen: number
  bestOrder: number
  energyBurned: number
}

export interface Variant {
  name: string
  learn: Partial<LearnConfig>
}

/** The controls LEARNING.md §7 insists on, plus whatever is being tested. */
export const CONTROLS: Variant[] = [
  { name: 'off', learn: { algo: 'none' } },
  { name: 'random-search', learn: { algo: 'random' } },
]

export interface ExperimentOptions {
  ticks: number
  seeds: number[]
  variants: Variant[]
  /** The measure to compare on. Pre-registered: chosen before the runs, not after. */
  fitness: FitnessSpec
  /** Built from a seed; the same world is handed to every variant. */
  world(seed: number): Init
  onProgress?(done: number, total: number, last: Outcome): void
}

/**
 * Mean fitness over the lives that ended in the back half of the run.
 *
 * The back half only, because the first lives in any world are born into transients — the starting
 * scatter, the first food, a learner still in its warmup — and including them flatters a learner
 * by comparing its later organisms against everyone's early ones.
 */
class Ended {
  private sum = 0
  private n = 0
  private ageSum = 0
  private readonly raw = new Float64Array(N_SCALARS)

  constructor(private readonly from: number) {}

  addScalars(scalars: Float64Array): void {
    for (let i = 0; i < N_SCALARS; i++) this.raw[i] += scalars[i]
  }

  /** Every scalar's raw mean over the scored lives. */
  get scalars(): Record<string, number> {
    const out: Record<string, number> = {}
    for (let i = 0; i < N_SCALARS; i++) out[KEYS[i]] = this.n === 0 ? 0 : this.raw[i] / this.n
    return out
  }

  add(f: number, age: number): void {
    this.sum += f
    this.n++
    this.ageSum += age
  }

  /**
   * NaN when no life ended in the window, which happens when a world dies out early. Reporting it
   * as zero would be a lie that drags a median down and makes a collapse look like a bad score
   * rather than no score.
   */
  get mean(): number {
    return this.n === 0 ? NaN : this.sum / this.n
  }
  get meanAge(): number {
    return this.n === 0 ? 0 : this.ageSum / this.n
  }
  get count(): number {
    return this.n
  }
  get since(): number {
    return this.from
  }
}

/** One world, one variant, run to `ticks`. */
export function runOne(
  init: Init,
  variant: Variant,
  ticks: number,
  fitness: FitnessSpec,
  /** Score against these lives rather than this run's own: see the note at the top of the file. */
  reference?: Cohort,
): Outcome & { cohort: Cohort } {
  const cfg: LearnConfig = { ...LEARN_DEFAULTS, ...init.learn, ...variant.learn, fitness }
  const w = new World({ ...init, learn: cfg })
  const ended = new Ended(Math.floor(ticks / 2))
  // its own cohort is still accumulated — it becomes the reference for the other variants when
  // this is the baseline run — but scoring goes against `reference` whenever there is one
  const cohort = new Cohort(fitness.window)
  const against = reference ?? cohort
  const scratch = new Float64Array(N_SCALARS)

  let peak = 0
  let maxGen = 0
  let ageSum = 0
  let ageN = 0
  // a death clears an organism's weights, so a life has to be noticed as it ends rather than
  // reconstructed afterwards; one byte per slot is cheaper than rebuilding a list every tick
  const wasAlive = new Uint8Array(w.cap)
  const brainOf = (b: number): boolean => w.alive[b] === 1 && w.isBrain(b)
  for (let b = w.nIntr; b < w.nMatter; b++) if (brainOf(b)) wasAlive[b] = 1

  for (let t = 0; t < ticks; t++) {
    w.step()
    let live = 0
    for (let b = w.nIntr; b < w.nMatter; b++) {
      const now = brainOf(b)
      if (now) {
        live++
        maxGen = Math.max(maxGen, w.gen[b])
      } else if (wasAlive[b]) {
        const s = w.lifeStatsOf(b)
        ageN++
        ageSum += s.age
        const scalars = scalarsOf(s, scratch)
        if (w.tick >= ended.since) cohort.push(scalars)
        if (w.tick >= ended.since) {
          ended.add(against.score(scalars, fitness), s.age)
          ended.addScalars(scalars)
        }
      }
      wasAlive[b] = now ? 1 : 0
    }
    peak = Math.max(peak, live)
  }

  const alive = aliveBrains(w)
  const st = w.learner.status()
  return {
    seed: init.seed,
    variant: variant.name,
    ticks,
    organisms: alive.length,
    peakOrganisms: peak,
    births: w.nBirths,
    budded: w.nBudded,
    deaths: w.nDeaths,
    maxGen,
    recordAge: w.recordAge,
    meanAge: ageN === 0 ? 0 : ageSum / ageN,
    fitness: ended.mean,
    scalars: ended.scalars,
    measure: describeSpec(fitness),
    learnerBest: st.best,
    learnerSeen: st.seen,
    bestOrder: w.orders.stats(w).bestOrder,
    energyBurned: w.burned,
    cohort,
  }
}

function aliveBrains(w: World): number[] {
  const out: number[] = []
  for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) out.push(b)
  return out
}

export interface Comparison {
  variant: string
  /** Runs that produced a score at all. */
  n: number
  /** Runs where nothing died in the measured window — the world had already emptied out. */
  empty: number
  median: number
  mean: number
  /** Inter-quartile range, as the spread that survives outliers. */
  iqr: [number, number]
  /** Paired difference against the first variant: median of (this − baseline) per seed. */
  medianPaired: number
  /** How many seeds this variant beat the baseline on, out of the pairs that could be compared. */
  wins: number
  pairs: number
  /**
   * Paired median difference in **raw units** for each selected scalar, and the seeds it won on.
   *
   * This is the headline, not the percentile column, and the reason is measurable: random search
   * cannot affect the world at all — its runs are bit-identical to the baseline — yet it scored
   * +0.0025 with 7 of 12 "wins" on the percentile statistic. That is the noise floor, and it is
   * the same size as the effects being looked for. Percentiles compress a heavily-tied
   * distribution (most organisms leave no children, so they all share a rank), which is harmless
   * for selection and fatal for measurement. Raw units do not compress.
   */
  raw: Record<string, { median: number; paired: number; wins: number }>
}

export interface ExperimentResult {
  fitness: FitnessSpec
  ticks: number
  seeds: number[]
  outcomes: Outcome[]
  comparisons: Comparison[]
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const a = [...xs].sort((p, q) => p - q)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0
  const a = [...xs].sort((p, q2) => p - q2)
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]
}

export function runExperiment(opts: ExperimentOptions): ExperimentResult {
  const outcomes: Outcome[] = []
  // A run whose objective moved cannot be paired against a baseline, so the runner fixes the
  // measure for every variant and refuses anything that arrives with its own.
  for (const v of opts.variants) {
    if (v.learn.fitness) throw new Error(`variant "${v.name}" carries its own measure; the experiment fixes one for all variants`)
  }
  const total = opts.seeds.length * opts.variants.length
  for (const seed of opts.seeds) {
    const init = opts.world(seed)
    // the first variant is the baseline by definition, and runs first so its lives can be the
    // common yardstick every other variant on this seed is measured against
    let reference: Cohort | undefined
    for (const v of opts.variants) {
      const o = runOne(init, v, opts.ticks, opts.fitness, reference)
      if (!reference) reference = o.cohort.copy()
      outcomes.push(o)
      opts.onProgress?.(outcomes.length, total, o)
    }
  }

  const baseline = opts.variants[0].name
  const by = (name: string): Outcome[] => outcomes.filter((o) => o.variant === name)
  const comparisons = opts.variants.map((v) => {
    const mine = by(v.name)
    const vals = mine.map((o) => o.fitness).filter((x) => Number.isFinite(x))
    const paired = mine
      .map((o) => {
        const base = by(baseline).find((b) => b.seed === o.seed)
        return o.fitness - (base?.fitness ?? NaN)
      })
      .filter((x) => Number.isFinite(x))
    const raw: Comparison['raw'] = {}
    for (const key of keysOf(opts.fitness)) {
      const vs = mine.map((o) => o.scalars[key] ?? NaN).filter((x) => Number.isFinite(x))
      const pd = mine
        .map((o) => (o.scalars[key] ?? NaN) - (by(baseline).find((b) => b.seed === o.seed)?.scalars[key] ?? NaN))
        .filter((x) => Number.isFinite(x))
      raw[key] = { median: median(vs), paired: median(pd), wins: pd.filter((d) => d > 0).length }
    }
    return {
      variant: v.name,
      n: vals.length,
      empty: mine.length - vals.length,
      raw,
      median: median(vals),
      mean: vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length),
      iqr: [quantile(vals, 0.25), quantile(vals, 0.75)] as [number, number],
      medianPaired: median(paired),
      wins: paired.filter((d) => d > 0).length,
      pairs: paired.length,
    }
  })
  return { fitness: opts.fitness, ticks: opts.ticks, seeds: opts.seeds, outcomes, comparisons }
}

/** A plain-text table, because a result nobody can read does not get believed. */
export function formatComparison(r: ExperimentResult): string {
  const keys = keysOf(r.fitness)
  const head =
    `${r.seeds.length} seeds × ${r.ticks} ticks · measure: ${describeSpec(r.fitness)} ` +
    `(percentile against the same world's lives with no learner, mean over the second half; 0.5 = no difference)`
  const rows = r.comparisons.map((c) => {
    const pad = (s: string, n: number): string => s.padEnd(n)
    return [
      pad(c.variant, 14),
      pad(c.median.toFixed(3), 10),
      pad(`${c.iqr[0].toFixed(3)}–${c.iqr[1].toFixed(3)}`, 18),
      pad(c.medianPaired >= 0 ? `+${c.medianPaired.toFixed(3)}` : c.medianPaired.toFixed(3), 11),
      pad(`${c.wins}/${c.pairs}`, 8),
      c.empty > 0 ? `${c.empty} died out` : '',
    ].join(' ')
  })
  const header = ['variant'.padEnd(14), 'median'.padEnd(10), 'IQR'.padEnd(18), 'vs base'.padEnd(11), 'wins'.padEnd(8), 'notes'].join(' ')
  // raw units first, because that is the statistic to believe; the percentile column is what the
  // learner optimised, and random search calibrates how little it can detect
  const rawHead = ['measure'.padEnd(14), 'variant'.padEnd(14), 'median'.padEnd(12), 'vs base'.padEnd(12), 'wins'].join(' ')
  const rawRows: string[] = []
  for (const key of keys) {
    for (const c of r.comparisons) {
      const x = c.raw[key]
      if (!x) continue
      rawRows.push(
        [
          key.padEnd(14),
          c.variant.padEnd(14),
          x.median.toFixed(3).padEnd(12),
          (x.paired >= 0 ? `+${x.paired.toFixed(3)}` : x.paired.toFixed(3)).padEnd(12),
          `${x.wins}/${c.pairs}`,
        ].join(' '),
      )
    }
    rawRows.push('')
  }
  return [
    head,
    '',
    'RAW UNITS — the statistic to believe',
    rawHead,
    '-'.repeat(rawHead.length),
    ...rawRows,
    'PERCENTILE — what the learner optimised; compare against random search for the noise floor',
    header,
    '-'.repeat(header.length),
    ...rows,
  ].join('\n')
}

export const ALGOS: LearnAlgo[] = ['none', 'random', 'ga', 'es', 'cem']

/** Convenience for scripts: a measure from scalar names. */
export const measure = specFromKeys
