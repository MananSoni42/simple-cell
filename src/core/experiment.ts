import { type LearnAlgo, type LearnConfig, LEARN_DEFAULTS, type FitnessKey, fitnessOf } from './learning'
import { type Init } from './params'
import { World } from './world'

/**
 * Paired experiments, because a single run proves nothing here.
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
  fitness: FitnessKey
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

  constructor(private readonly from: number) {}

  add(f: number, age: number): void {
    this.sum += f
    this.n++
    this.ageSum += age
  }

  get mean(): number {
    return this.n === 0 ? 0 : this.sum / this.n
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
export function runOne(init: Init, variant: Variant, ticks: number, fitness: FitnessKey): Outcome {
  const cfg: LearnConfig = { ...LEARN_DEFAULTS, ...init.learn, ...variant.learn, fitness }
  const w = new World({ ...init, learn: cfg })
  const ended = new Ended(Math.floor(ticks / 2))

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
        if (w.tick >= ended.since) ended.add(fitnessOf(fitness, s), s.age)
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
    learnerBest: st.best,
    learnerSeen: st.seen,
    bestOrder: w.orders.stats(w).bestOrder,
    energyBurned: w.burned,
  }
}

function aliveBrains(w: World): number[] {
  const out: number[] = []
  for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) out.push(b)
  return out
}

export interface Comparison {
  variant: string
  n: number
  median: number
  mean: number
  /** Inter-quartile range, as the spread that survives outliers. */
  iqr: [number, number]
  /** Paired difference against the first variant: median of (this − baseline) per seed. */
  medianPaired: number
  /** How many seeds this variant beat the baseline on. */
  wins: number
}

export interface ExperimentResult {
  fitness: FitnessKey
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
  const total = opts.seeds.length * opts.variants.length
  for (const seed of opts.seeds) {
    const init = opts.world(seed)
    for (const v of opts.variants) {
      const o = runOne(init, v, opts.ticks, opts.fitness)
      outcomes.push(o)
      opts.onProgress?.(outcomes.length, total, o)
    }
  }

  const baseline = opts.variants[0].name
  const by = (name: string): Outcome[] => outcomes.filter((o) => o.variant === name)
  const comparisons = opts.variants.map((v) => {
    const mine = by(v.name)
    const vals = mine.map((o) => o.fitness)
    const paired = mine.map((o) => {
      const base = by(baseline).find((b) => b.seed === o.seed)
      return o.fitness - (base?.fitness ?? 0)
    })
    return {
      variant: v.name,
      n: mine.length,
      median: median(vals),
      mean: vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length),
      iqr: [quantile(vals, 0.25), quantile(vals, 0.75)] as [number, number],
      medianPaired: median(paired),
      wins: paired.filter((d) => d > 0).length,
    }
  })
  return { fitness: opts.fitness, ticks: opts.ticks, seeds: opts.seeds, outcomes, comparisons }
}

/** A plain-text table, because a result nobody can read does not get believed. */
export function formatComparison(r: ExperimentResult): string {
  const head = `${r.seeds.length} seeds × ${r.ticks} ticks · fitness: ${r.fitness} (mean over lives ending in the second half)`
  const rows = r.comparisons.map((c) => {
    const pad = (s: string, n: number): string => s.padEnd(n)
    return [
      pad(c.variant, 14),
      pad(c.median.toFixed(3), 10),
      pad(`${c.iqr[0].toFixed(3)}–${c.iqr[1].toFixed(3)}`, 18),
      pad(c.medianPaired >= 0 ? `+${c.medianPaired.toFixed(3)}` : c.medianPaired.toFixed(3), 11),
      `${c.wins}/${c.n}`,
    ].join(' ')
  })
  const header = ['variant'.padEnd(14), 'median'.padEnd(10), 'IQR'.padEnd(18), 'vs base'.padEnd(11), 'wins'].join(' ')
  return [head, '', header, '-'.repeat(header.length), ...rows].join('\n')
}

export const ALGOS: LearnAlgo[] = ['none', 'random', 'ga', 'es', 'cem']
