import {
  Cohort,
  DEFAULT_SPEC,
  type FitnessSpec,
  type LifeStats,
  N_SCALARS,
  describeSpec,
  scalarsOf,
} from './fitness'
import { N_BRAIN_IN, N_BRAIN_OUT, N_WLIMB } from './neurons'
import { Rng } from './rng'

/**
 * Learning, as a seam rather than a law.
 *
 * Three things this file is careful about, all of them consequences of what the project is for:
 *
 * 1. **A learner is an initial condition, not a law.** `none` is a real option and the default, and
 *    with it the world is bit-identical to one built before this file existed. Nothing here can
 *    touch physics, chemistry, energy or death; a learner may only choose the weights a *new*
 *    organism is born with, and watch what happened to the ones that died.
 * 2. **The learner draws from its own random stream.** Turning a learner on must not change where
 *    food falls or which particle lands where, or paired runs — the only honest way to measure a
 *    learner in a world this noisy — would be comparing two different worlds.
 * 3. **Fitness is a stated choice, not a measurement.** The default is offspring count, which is
 *    the one number the world already keeps for its own reasons. Every other scalar is an
 *    invention, and the UI and the run record say which one was used.
 *
 * Budding is left exactly as it was. It is already selection plus mutation, it is part of the
 * world rather than part of an algorithm, and a learner that also governed reproduction could not
 * be switched off cleanly.
 */

export const N_GENE_BRAIN = N_BRAIN_IN * N_BRAIN_OUT
export const N_GENE = N_GENE_BRAIN + N_WLIMB

export type LearnAlgo = 'none' | 'random' | 'ga' | 'es' | 'cem'

export const LEARNERS: { key: LearnAlgo; name: string; blurb: string }[] = [
  { key: 'none', name: 'None', blurb: 'every new organism gets random weights — the control, and what the world did before' },
  { key: 'random', name: 'Random search', blurb: 'still random, but the best genome ever seen is kept and reported: the yardstick any learner has to beat' },
  { key: 'ga', name: 'Steady-state GA', blurb: 'a pool of the best dead organisms; new ones are a tournament winner, crossed and mutated' },
  { key: 'es', name: 'Evolution strategy', blurb: 'one mean genome, nudged toward whatever did better than average; mirrored sampling' },
  { key: 'cem', name: 'Cross-entropy', blurb: 'refits a mean and a spread per weight from the best of each batch; narrows as it converges' },
]

export { FITNESS, type FitnessKey, type LifeStats, fitnessOf, scalarsOf } from './fitness'
export { COMBINERS, type Combiner, type FitnessSpec, describeSpec, keysOf, specFromKeys } from './fitness'

/** One organism's weights, flattened. Brain first, then limb. */
export interface Genome {
  wBrain: Float64Array
  wLimb: Float64Array
  /** Set by the learner so it can recognise its own sample when that sample dies. */
  id: number
}

export interface LifeRecord {
  /** The learner's tag for this organism, or 0 if it was not one of its samples. */
  id: number
  wBrain: Float64Array
  wLimb: Float64Array
  stats: LifeStats
  diedAt: number
}

/** How many progress samples a learner keeps for the graph in the world screen. */
const HISTORY = 96

export interface LearnConfig {
  algo: LearnAlgo
  /** Which measures count, and how they are combined. */
  fitness: FitnessSpec
  /** Learn nothing before this tick, so startup transients do not poison the first updates. */
  warmup: number
  /** Share of new organisms whose weights come from the learner rather than from chance. */
  share: number
  /** Mutation σ (GA), exploration σ (ES, CEM). */
  sigma: number
  /** Deaths between batch updates (ES, CEM). */
  batch: number
  /** Pool size (GA), elite count is a fraction of the batch (CEM). */
  pool: number
  tournament: number
  crossover: number
  /** Step size (ES). */
  lr: number
  /** Pool entries older than this many ticks are dropped: fitness from a past regime misleads. */
  maxAge: number
}

export const LEARN_DEFAULTS: LearnConfig = {
  algo: 'none',
  fitness: DEFAULT_SPEC(),
  warmup: 500,
  share: 1,
  sigma: 0.15,
  batch: 16,
  pool: 24,
  tournament: 3,
  crossover: 0.5,
  lr: 0.2,
  maxAge: 60000,
}

export interface LearnerStatus {
  algo: LearnAlgo
  name: string
  /** Lives scored so far. */
  seen: number
  /** Batch updates applied, or pool inserts for the GA. */
  updates: number
  best: number
  /** Mean score of the most recent window of deaths, so progress is visible. */
  recent: number
  /** How many genomes the learner currently has to draw from. */
  held: number
  /** What is being optimised, and in words. */
  spec: FitnessSpec
  fitness: string
  /** Raw mean of every scalar over the cohort, so a reward hack is visible. */
  means: number[]
  /** How many deaths the percentiles are measured against. */
  cohort: number
  /** Progress: the mean and the best score, sampled as lives are scored. */
  history: { recent: number[]; best: number[]; tick: number[] }
}

/**
 * A learner sees two events and answers one question. That is deliberately the whole interface:
 * every algorithm in LEARNING.md fits it, and `none` is one of them, so the control is the same
 * code path as the experiment.
 */
export abstract class Learner {
  protected rng: Rng
  protected seen = 0
  protected updates = 0
  protected best = -Infinity
  /** A short window of recent scores, so "is it improving" can be answered without the archive. */
  private readonly window = new Float64Array(32)
  private windowN = 0
  protected tick = 0
  private nextId = 1
  /** The recent dead as raw scalar vectors; percentiles and re-scoring both come from here. */
  protected cohort: Cohort
  /** Progress, sampled every few lives, bounded: it is for a graph, not for an archive. */
  private readonly hRecent = new Float64Array(HISTORY)
  private readonly hBest = new Float64Array(HISTORY)
  private readonly hTick = new Float64Array(HISTORY)
  private hN = 0
  private readonly scratch = new Float64Array(N_SCALARS)

  constructor(
    readonly cfg: LearnConfig,
    seed: number,
  ) {
    // its own stream, so switching a learner on cannot move a single food particle
    this.rng = new Rng((seed ^ 0x51ed270b) | 0)
    this.cohort = new Cohort(cfg.fitness.window)
  }

  /**
   * Point the learner at a different measure, mid-run if need be.
   *
   * Nothing is thrown away: the cohort and every stored genome hold *raw* scalar vectors, so the
   * pool and any in-flight batch are simply re-scored under the new preference. The distribution
   * learners' means still encode the old one, which is real rather than a bug — a mean that was
   * moved toward offspring does not forget that because the question changed.
   */
  retarget(spec: FitnessSpec): void {
    this.cfg.fitness = spec
    this.best = -Infinity
    this.windowN = 0
    this.window.fill(0)
    this.rescore()
  }

  /**
   * Re-derive every stored score from the raw scalars, against the cohort as it now stands.
   *
   * Called before any decision, not just on a change of measure, and that matters more than it
   * looks: a percentile is taken against the cohort at the moment of death, so two samples in one
   * batch that died minutes apart were ranked against different populations. Re-scoring together
   * puts them on one footing — which is what makes a single measure behave exactly as it did
   * before percentiles existed, since every algorithm here is ordinal (a tournament, a
   * rank-weighted sum, a top fraction) and a percentile is a monotone transform of the raw value.
   */
  protected rescore(): void {}

  abstract readonly algo: LearnAlgo

  /** Weights for an organism about to be born, or null to let chance decide. */
  genomeForSpawn(tick: number): Genome | null {
    this.tick = tick
    if (tick < this.cfg.warmup) return null
    if (this.cfg.share < 1 && this.rng.next() > this.cfg.share) return null
    return this.sample()
  }

  protected abstract sample(): Genome | null

  observe(r: LifeRecord, tick: number): void {
    this.tick = tick
    if (tick < this.cfg.warmup) return
    const scalars = scalarsOf(r.stats, this.scratch)
    // the life joins the cohort before it is scored against it, so a percentile always includes
    // the thing being measured and the first death is not a divide-by-nothing
    this.cohort.push(scalars)
    const f = this.cohort.score(scalars, this.cfg.fitness)
    this.seen++
    this.best = Math.max(this.best, f)
    this.window[this.windowN % this.window.length] = f
    this.windowN++
    this.score(r, scalars, f)
    if (this.seen % 4 === 0) this.remember()
  }

  private remember(): void {
    const i = this.hN % HISTORY
    this.hRecent[i] = this.recentMean()
    this.hBest[i] = this.best === -Infinity ? 0 : this.best
    this.hTick[i] = this.tick
    this.hN++
  }

  private recentMean(): number {
    const n = Math.min(this.windowN, this.window.length)
    if (n === 0) return 0
    let sum = 0
    for (let i = 0; i < n; i++) sum += this.window[i]
    return sum / n
  }

  /** Oldest first, so a graph can be drawn straight from it. */
  private series(): { recent: number[]; best: number[]; tick: number[] } {
    const n = Math.min(this.hN, HISTORY)
    const start = this.hN > HISTORY ? this.hN % HISTORY : 0
    const recent: number[] = []
    const best: number[] = []
    const tick: number[] = []
    for (let k = 0; k < n; k++) {
      const i = (start + k) % HISTORY
      recent.push(this.hRecent[i])
      best.push(this.hBest[i])
      tick.push(this.hTick[i])
    }
    return { recent, best, tick }
  }

  protected abstract score(r: LifeRecord, scalars: Float64Array, fitness: number): void

  /** Periodic hook; only the batch algorithms use it, and only to age things out. */
  review(_tick: number): void {}

  status(): LearnerStatus {
    return {
      algo: this.algo,
      name: LEARNERS.find((l) => l.key === this.algo)?.name ?? this.algo,
      seen: this.seen,
      updates: this.updates,
      best: this.best === -Infinity ? 0 : this.best,
      recent: this.recentMean(),
      held: this.held(),
      spec: this.cfg.fitness,
      fitness: describeSpec(this.cfg.fitness),
      means: Array.from(this.cohort.means()),
      cohort: this.cohort.size,
      history: this.series(),
    }
  }

  protected held(): number {
    return 0
  }

  protected takeId(): number {
    return this.nextId++
  }

  protected genome(brain: Float64Array, limb: Float64Array): Genome {
    return { wBrain: brain, wLimb: limb, id: this.takeId() }
  }

  // ---- state, for snapshots -------------------------------------------------
  // A learner is state like any other, so rewinding has to put it back. The in-flight samples of
  // a batch algorithm are *not* saved: there are only ever a few, and a rewind that loses them
  // costs one partial update rather than correctness.

  /** Fixed, so a snapshot ring can be allocated once. */
  saveSize(): number {
    return 9 + this.window.length + 3 * HISTORY + this.cohort.saveSize()
  }

  saveInto(a: Float64Array, off: number): void {
    a[off] = this.seen
    a[off + 1] = this.updates
    a[off + 2] = this.best
    a[off + 3] = this.windowN
    a[off + 4] = this.nextId
    const [s, spare] = this.rng.state()
    a[off + 5] = s
    a[off + 6] = spare === null ? 0 : spare
    a[off + 7] = spare === null ? 0 : 1
    a[off + 8] = this.hN
    let o = off + 9
    for (const arr of [this.window, this.hRecent, this.hBest, this.hTick]) {
      a.set(arr, o)
      o += arr.length
    }
    this.cohort.saveInto(a, o)
  }

  loadFrom(a: Float64Array, off: number): void {
    this.seen = a[off]
    this.updates = a[off + 1]
    this.best = a[off + 2]
    this.windowN = a[off + 3]
    this.nextId = a[off + 4]
    this.rng.setState([a[off + 5], a[off + 7] ? a[off + 6] : null])
    this.hN = a[off + 8]
    let o = off + 9
    for (const arr of [this.window, this.hRecent, this.hBest, this.hTick]) {
      arr.set(a.subarray(o, o + arr.length))
      o += arr.length
    }
    this.cohort.loadFrom(a, o)
  }
}

const split = (v: Float64Array): [Float64Array, Float64Array] => [v.slice(0, N_GENE_BRAIN), v.slice(N_GENE_BRAIN)]

function join(wBrain: Float64Array, wLimb: Float64Array): Float64Array {
  const v = new Float64Array(N_GENE)
  v.set(wBrain, 0)
  v.set(wLimb, N_GENE_BRAIN)
  return v
}

/** The control: weights stay random, and the learner only watches. */
class NoLearner extends Learner {
  readonly algo = 'none' as const
  protected sample(): null {
    return null
  }
  protected score(): void {}
  observe(): void {}
}

/**
 * Random search (E1). Spawns stay random, but the best genome ever seen is kept, so there is a
 * number to beat. Without this control, a GA that merely keeps up with luck looks like progress.
 */
class RandomSearch extends Learner {
  readonly algo = 'random' as const
  private bestGenome: Float64Array | null = null

  protected sample(): null {
    return null
  }

  protected score(r: LifeRecord, _scalars: Float64Array, fitness: number): void {
    if (fitness >= this.best) {
      this.bestGenome = join(r.wBrain, r.wLimb)
      this.updates++
    }
  }

  protected held(): number {
    return this.bestGenome ? 1 : 0
  }

  saveSize(): number {
    return super.saveSize() + 1 + N_GENE
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    const o = off + super.saveSize()
    a[o] = this.bestGenome ? 1 : 0
    if (this.bestGenome) a.set(this.bestGenome, o + 1)
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    const o = off + super.saveSize()
    this.bestGenome = a[o] ? a.slice(o + 1, o + 1 + N_GENE) : null
  }
}

/**
 * Steady-state GA (A1). A pool of the best lives seen; a new organism is a tournament winner,
 * optionally crossed with a second winner, plus Gaussian noise.
 *
 * Steady-state rather than generational because this world has no episodes: organisms are born and
 * die whenever they do, and waiting for a generation boundary would mean inventing one.
 */
class Ga extends Learner {
  readonly algo = 'ga' as const
  private genes: Float64Array
  private fit: Float64Array
  private born: Float64Array
  /** Raw scalars per pool entry, so changing what counts re-scores the pool instead of voiding it. */
  private raw: Float64Array
  private n = 0

  constructor(cfg: LearnConfig, seed: number) {
    super(cfg, seed)
    const cap = Math.max(2, Math.round(cfg.pool))
    this.genes = new Float64Array(cap * N_GENE)
    this.fit = new Float64Array(cap).fill(-Infinity)
    this.born = new Float64Array(cap)
    this.raw = new Float64Array(cap * N_SCALARS)
  }

  protected rescore(): void {
    for (let i = 0; i < this.n; i++) {
      this.fit[i] = this.cohort.score(this.raw.subarray(i * N_SCALARS, (i + 1) * N_SCALARS), this.cfg.fitness)
    }
  }

  private get cap(): number {
    return this.fit.length
  }

  protected held(): number {
    return this.n
  }

  private pick(): number {
    let best = -1
    for (let t = 0; t < Math.max(1, Math.round(this.cfg.tournament)); t++) {
      const i = this.rng.int(this.n)
      if (best < 0 || this.fit[i] > this.fit[best]) best = i
    }
    return best
  }

  protected sample(): Genome | null {
    if (this.n < 2) return null
    const a = this.pick()
    const v = this.genes.slice(a * N_GENE, (a + 1) * N_GENE)
    if (this.rng.next() < this.cfg.crossover) {
      const b = this.pick()
      // uniform crossover: no gene order is meaningful here, so one-point would be arbitrary
      for (let i = 0; i < N_GENE; i++) if (this.rng.next() < 0.5) v[i] = this.genes[b * N_GENE + i]
    }
    const s = this.cfg.sigma
    for (let i = 0; i < N_GENE; i++) v[i] += s * this.rng.gauss()
    const [wBrain, wLimb] = split(v)
    return this.genome(wBrain, wLimb)
  }

  protected score(r: LifeRecord, scalars: Float64Array, fitness: number): void {
    // every entry against the same cohort, so "better than the worst held" is a fair comparison
    this.rescore()
    // stale entries first: fitness earned under a food regime that has since changed misleads
    const cutoff = this.tick - this.cfg.maxAge
    for (let i = 0; i < this.n; i++) {
      if (this.born[i] < cutoff) {
        this.n--
        this.genes.copyWithin(i * N_GENE, this.n * N_GENE, (this.n + 1) * N_GENE)
        this.raw.copyWithin(i * N_SCALARS, this.n * N_SCALARS, (this.n + 1) * N_SCALARS)
        this.fit[i] = this.fit[this.n]
        this.born[i] = this.born[this.n]
        this.fit[this.n] = -Infinity
        i--
      }
    }
    let slot = -1
    if (this.n < this.cap) slot = this.n++
    else {
      let worst = 0
      for (let i = 1; i < this.n; i++) if (this.fit[i] < this.fit[worst]) worst = i
      if (fitness > this.fit[worst]) slot = worst
    }
    if (slot < 0) return
    this.genes.set(join(r.wBrain, r.wLimb), slot * N_GENE)
    this.raw.set(scalars.subarray(0, N_SCALARS), slot * N_SCALARS)
    this.fit[slot] = fitness
    this.born[slot] = this.tick
    this.updates++
  }

  saveSize(): number {
    return super.saveSize() + 1 + this.cap * (N_GENE + 2 + N_SCALARS)
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    let o = off + super.saveSize()
    a[o++] = this.n
    for (const arr of [this.genes, this.fit, this.born, this.raw]) {
      a.set(arr, o)
      o += arr.length
    }
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    let o = off + super.saveSize()
    this.n = a[o++]
    for (const arr of [this.genes, this.fit, this.born, this.raw]) {
      arr.set(a.subarray(o, o + arr.length))
      o += arr.length
    }
  }
}

/** A sample that has been handed out and is waiting for its organism to die. */
interface Pending {
  id: number
  eps: Float64Array
}

/** A sample whose organism has died, waiting for its batch to fill. */
interface Scored {
  eps: Float64Array
  /** Raw scalars, kept so a change of measure re-scores the batch rather than wasting it. */
  raw: Float64Array
}

/**
 * Base for the two distribution learners. Both hand out `mean + sigma · ε` and both need to match
 * a death back to the ε that produced it, which is why a genome carries an id and the world keeps
 * it on the organism: recovering ε from the weights would be wrong the moment the mean moves.
 */
abstract class Distribution extends Learner {
  protected mean = new Float64Array(N_GENE)
  protected pending: Pending[] = []
  protected batch: Scored[] = []
  protected batchFit: number[] = []

  protected rescore(): void {
    for (let i = 0; i < this.batch.length; i++) {
      this.batchFit[i] = this.cohort.score(this.batch[i].raw, this.cfg.fitness)
    }
  }

  protected abstract sigmaAt(i: number): number

  protected sample(): Genome {
    const eps = new Float64Array(N_GENE)
    const last = this.pending.length > 0 ? this.pending[this.pending.length - 1] : null
    // mirrored sampling: every sample is paired with its opposite, which halves the variance of
    // the gradient estimate for free
    if (last && last.eps.length === N_GENE && this.pending.length % 2 === 1) {
      for (let i = 0; i < N_GENE; i++) eps[i] = -last.eps[i]
    } else {
      for (let i = 0; i < N_GENE; i++) eps[i] = this.rng.gauss()
    }
    const v = new Float64Array(N_GENE)
    for (let i = 0; i < N_GENE; i++) v[i] = this.mean[i] + this.sigmaAt(i) * eps[i]
    const g = this.genome(...split(v))
    this.pending.push({ id: g.id, eps })
    // in flight at once is bounded by how many organisms can be alive; four batches is generous
    const capPending = Math.max(8, Math.round(this.cfg.batch) * 4)
    if (this.pending.length > capPending) this.pending.shift()
    return g
  }

  protected score(r: LifeRecord, scalars: Float64Array, fitness: number): void {
    const k = this.pending.findIndex((p) => p.id === r.id)
    if (k < 0) return // not one of ours: a random spawn, or a sample lost to a rewind
    const [p] = this.pending.splice(k, 1)
    this.batch.push({ eps: p.eps, raw: Float64Array.from(scalars.subarray(0, N_SCALARS)) })
    this.batchFit.push(fitness)
    if (this.batchFit.length >= Math.max(2, Math.round(this.cfg.batch))) {
      this.rescore() // one cohort for the whole batch, not one per death
      this.update()
      this.batch = []
      this.batchFit = []
      this.updates++
    }
  }

  protected abstract update(): void

  protected held(): number {
    return this.updates > 0 ? 1 : 0
  }

  /**
   * Rank normalisation, centred and scaled to [-0.5, 0.5]. Fitness here can be anything from an
   * offspring count of 0 or 1 to tens of thousands of energy units, so using raw values would make
   * the step size meaningless across scalars.
   */
  protected ranks(): number[] {
    const n = this.batchFit.length
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.batchFit[a] - this.batchFit[b])
    const u = new Array<number>(n).fill(0)
    for (let r = 0; r < n; r++) u[order[r]] = r / Math.max(1, n - 1) - 0.5
    return u
  }

  saveSize(): number {
    return super.saveSize() + N_GENE
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    a.set(this.mean, off + super.saveSize())
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    const o = off + super.saveSize()
    this.mean.set(a.subarray(o, o + N_GENE))
    // whatever was in flight belonged to a future that no longer exists
    this.pending = []
    this.batch = []
    this.batchFit = []
  }
}

/** Evolution strategy (A2): one mean genome, moved along a rank-weighted sum of its own samples. */
class Es extends Distribution {
  readonly algo = 'es' as const

  protected sigmaAt(): number {
    return this.cfg.sigma
  }

  protected update(): void {
    const u = this.ranks()
    const n = u.length
    const scale = this.cfg.lr / (n * this.cfg.sigma)
    for (let i = 0; i < N_GENE; i++) {
      let g = 0
      for (let k = 0; k < n; k++) g += u[k] * this.batch[k].eps[i]
      this.mean[i] += scale * g
    }
  }
}

/** Cross-entropy method (A4): refit the mean and a per-weight spread from the best of each batch. */
class Cem extends Distribution {
  readonly algo = 'cem' as const
  private sigma = new Float64Array(N_GENE)

  constructor(cfg: LearnConfig, seed: number) {
    super(cfg, seed)
    this.sigma.fill(cfg.sigma)
  }

  protected sigmaAt(i: number): number {
    return this.sigma[i]
  }

  protected update(): void {
    const n = this.batchFit.length
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.batchFit[b] - this.batchFit[a])
    const elite = Math.max(2, Math.round(n * 0.25))
    const take = order.slice(0, Math.min(elite, n))
    const floor = this.cfg.sigma * 0.1
    for (let i = 0; i < N_GENE; i++) {
      let m = 0
      for (const k of take) m += this.mean[i] + this.sigma[i] * this.batch[k].eps[i]
      m /= take.length
      let v = 0
      for (const k of take) {
        const d = this.mean[i] + this.sigma[i] * this.batch[k].eps[i] - m
        v += d * d
      }
      this.mean[i] = m
      // a floor on the spread, or the method collapses onto its first lucky batch and stops
      this.sigma[i] = Math.max(floor, Math.sqrt(v / take.length))
    }
  }

  saveSize(): number {
    return super.saveSize() + N_GENE
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    a.set(this.sigma, off + super.saveSize())
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    const o = off + super.saveSize()
    this.sigma.set(a.subarray(o, o + N_GENE))
  }
}

export function makeLearner(cfg: LearnConfig, seed: number): Learner {
  switch (cfg.algo) {
    case 'random':
      return new RandomSearch(cfg, seed)
    case 'ga':
      return new Ga(cfg, seed)
    case 'es':
      return new Es(cfg, seed)
    case 'cem':
      return new Cem(cfg, seed)
    default:
      return new NoLearner(cfg, seed)
  }
}
