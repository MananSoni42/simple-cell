import type { LearnerStatus } from './learning'
import { census } from './metrics'
import { MAX_ORDER } from './orders'
import type { World } from './world'

/**
 * Records a run so it can be summarised afterwards. Reads world state and never touches it.
 *
 * Memory is bounded whatever the run length: samples land in a fixed number of buckets, and when
 * the buckets fill, adjacent pairs are merged and the sampling interval doubles. So a 200-tick
 * run and a 20-million-tick run both cost the same, and both cover the whole run evenly.
 */
export const BUCKETS = 240

export const METRICS = [
  'organisms',
  'food',
  'freeMatter',
  'eOrganisms',
  'eFree',
  'eFood',
  'burned',
  'bonds',
  'lifeParticles',
  'lifeOrganisms',
  'compounds',
  'maxOrder',
  'lineages',
  'maxGen',
] as const
export type Metric = (typeof METRICS)[number]

export interface Peak {
  value: number
  tick: number
}

export interface RunRecord {
  ticks: number
  bucketTicks: number
  /** Number of buckets actually filled. */
  n: number
  /** Representative tick of each bucket. */
  x: Float64Array
  series: Record<Metric, Float64Array>
  peaks: Record<Metric, Peak>
  /** End-of-run totals. */
  final: {
    tick: number
    /** Energy present at tick 0; the ledger is energy + burned = initial + injected. */
    initialEnergy: number
    /** Highest generation reached at any point, not just among survivors. */
    peakGen: number
    organisms: number
    births: number
    budded: number
    deaths: number
    injected: number
    burned: number
    energy: number
    bonds: number
    lineages: number
    biggestLineage: number
    maxGen: number
    maxChildren: number
    bestOrder: number
    bestOrderAge: number
    ordersLive: number[]
    ordersHeld: number[]
    lifeParticles: number
    lifeOrganisms: number
    recordAge: number
    clampedPct: number
    /** How the run learned, if it did. A run has to record this or its numbers mean nothing. */
    learner?: LearnerStatus
  }
}

export class Recorder {
  private sums: Record<Metric, Float64Array>
  private counts: Int32Array
  private xs: Float64Array
  readonly peaks: Record<Metric, Peak>
  private bucketTicks = 1
  private filled = 0
  private lastTick = -1

  constructor(readonly sampleEvery = 1) {
    this.sums = Object.fromEntries(METRICS.map((m) => [m, new Float64Array(BUCKETS)])) as Record<Metric, Float64Array>
    this.counts = new Int32Array(BUCKETS)
    this.xs = new Float64Array(BUCKETS)
    this.peaks = Object.fromEntries(METRICS.map((m) => [m, { value: 0, tick: 0 }])) as Record<Metric, Peak>
  }

  /** Halves the resolution so the buckets can cover twice as long a run. */
  private compact(): void {
    for (const m of METRICS) {
      const s = this.sums[m]
      for (let i = 0; i < BUCKETS / 2; i++) s[i] = s[2 * i] + s[2 * i + 1]
      s.fill(0, BUCKETS / 2)
    }
    for (let i = 0; i < BUCKETS / 2; i++) {
      this.counts[i] = this.counts[2 * i] + this.counts[2 * i + 1]
      this.xs[i] = this.xs[2 * i + 1] || this.xs[2 * i]
    }
    this.counts.fill(0, BUCKETS / 2)
    this.xs.fill(0, BUCKETS / 2)
    this.filled = BUCKETS / 2
    this.bucketTicks *= 2
  }

  observe(w: World): void {
    if (this.lastTick >= 0 && w.tick - this.lastTick < this.sampleEvery) return
    this.lastTick = w.tick
    let idx = Math.floor(w.tick / this.bucketTicks)
    while (idx >= BUCKETS) {
      this.compact()
      idx = Math.floor(w.tick / this.bucketTicks)
    }

    const c = census(w)
    const life = w.lifeParticlesWindow.mean(w.tick)
    const lifeOrg = w.lifeOrganismsWindow.mean(w.tick)
    const o = w.orders.stats(w)
    let compounds = 0
    let maxOrder = 0
    for (let k = 2; k <= MAX_ORDER; k++) {
      compounds += o.live[k - 1]
      if (o.live[k - 1] > 0) maxOrder = k
    }
    const sample: Record<Metric, number> = {
      organisms: c.organisms,
      food: c.food,
      freeMatter: c.freeMatter,
      eOrganisms: c.eOrganisms,
      eFree: c.eFree,
      eFood: c.eFood,
      burned: w.burned,
      bonds: w.bonds.count,
      lifeParticles: Number.isFinite(life) ? life : 0,
      lifeOrganisms: Number.isFinite(lifeOrg) ? lifeOrg : 0,
      compounds,
      maxOrder,
      lineages: c.lineages,
      maxGen: c.maxGen,
    }
    for (const m of METRICS) {
      this.sums[m][idx] += sample[m]
      if (sample[m] > this.peaks[m].value) {
        this.peaks[m].value = sample[m]
        this.peaks[m].tick = w.tick
      }
    }
    this.counts[idx]++
    this.xs[idx] = w.tick
    this.filled = Math.max(this.filled, idx + 1)
  }

  /** Bucket means, plus the end-of-run totals. */
  finish(w: World): RunRecord {
    const n = this.filled
    const x = new Float64Array(n)
    const series = Object.fromEntries(METRICS.map((m) => [m, new Float64Array(n)])) as Record<Metric, Float64Array>
    for (let i = 0; i < n; i++) {
      x[i] = this.xs[i]
      const k = this.counts[i]
      for (const m of METRICS) series[m][i] = k > 0 ? this.sums[m][i] / k : NaN
    }
    const c = census(w)
    const o = w.orders.stats(w)
    return {
      ticks: w.tick,
      bucketTicks: this.bucketTicks,
      n,
      x,
      series,
      peaks: this.peaks,
      final: {
        tick: w.tick,
        initialEnergy: w.initialEnergy,
        peakGen: Math.max(this.peaks.maxGen.value, c.maxGen),
        organisms: c.organisms,
        births: w.nBirths,
        budded: w.nBudded,
        deaths: w.nDeaths,
        injected: w.injected,
        burned: w.burned,
        energy: w.totalEnergy(),
        bonds: w.bonds.count,
        lineages: c.lineages,
        biggestLineage: c.biggestLineage,
        maxGen: c.maxGen,
        maxChildren: c.maxChildren,
        bestOrder: o.bestOrder,
        bestOrderAge: o.bestAge,
        ordersLive: o.live.slice(),
        ordersHeld: o.surviving.slice(),
        lifeParticles: w.lifeParticles.summary().mean,
        lifeOrganisms: w.lifeOrganisms.summary().mean,
        recordAge: Math.max(w.recordAge, c.oldest),
        clampedPct: w.nSteps > 0 ? (100 * w.nClamped) / w.nSteps : 0,
        learner: w.init.learn.algo === 'none' ? undefined : w.learner.status(),
      },
    }
  }
}
