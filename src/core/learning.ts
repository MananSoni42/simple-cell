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

export type LearnAlgo = 'none' | 'random' | 'ga' | 'es' | 'cem' | 'elites' | 'td' | 'hebb'

export const LEARNERS: { key: LearnAlgo; name: string; blurb: string }[] = [
  { key: 'none', name: 'None', blurb: 'every new organism gets random weights — the control, and what the world did before' },
  { key: 'random', name: 'Random search', blurb: 'still random, but the best genome ever seen is kept and reported: the yardstick any learner has to beat' },
  { key: 'ga', name: 'Steady-state GA', blurb: 'a pool of the best dead organisms; new ones are a tournament winner, crossed and mutated' },
  { key: 'es', name: 'Evolution strategy', blurb: 'one mean genome, nudged toward whatever did better than average; mirrored sampling' },
  { key: 'cem', name: 'Cross-entropy', blurb: 'refits a mean and a spread per weight from the best of each batch; narrows as it converges' },
  {
    key: 'elites',
    name: 'MAP-Elites',
    blurb: 'keeps the best genome for each *kind* of behaviour rather than the best overall, so a slow-breeding wanderer is not thrown away for losing to a fast-breeding clump',
  },
  {
    key: 'td',
    name: 'TD(λ) actor–critic',
    blurb: 'learns *within* a life: a value estimate, eligibility traces, and a policy nudged by its own prediction error. The only learner here that does not need something to die first',
  },
  {
    key: 'hebb',
    name: 'Reward-modulated Hebbian',
    blurb: 'three-factor plasticity — input × output × reward, entirely local. The cheap control against TD(λ): if it does as well, the value function is not earning its keep',
  },
]

/** Which learners rewire a living organism rather than only seeding new ones. */
export const ONLINE_ALGOS: LearnAlgo[] = ['td', 'hebb']

export { FITNESS, type FitnessKey, type LifeStats, fitnessOf, scalarsOf } from './fitness'
export { COMBINERS, type Combiner, type FitnessSpec, describeSpec, keysOf, specFromKeys } from './fitness'

/**
 * What an online learner is told about one organism on one tick.
 *
 * Deliberately the raw arrays rather than copies: this runs once per organism per tick, inside the
 * hot loop, and a learner that allocated here would cost more than the simulation it is learning
 * about.
 */
export interface OnlineStep {
  /** Which organism, used as the key for per-organism state. */
  b: number
  wBrain: Float64Array
  wLimb: Float64Array
  /** The inputs as read this tick. */
  xin: Float64Array
  /** The pre-activation outputs. Writable: see `Learner.act`. */
  yout: Float64Array
  /**
   * The reward for this tick.
   *
   * **Energy harvested, not energy gained.** Net gain would reward sitting still, which is the
   * exact failure this project keeps running into — the only strategy any learner has ever found
   * is to spend less. Making the reward purely what it *ate* leaves the cost of moving as a
   * constraint the organism has to survive rather than a penalty inside its objective.
   */
  reward: number
  tick: number
}

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
  /**
   * Pull toward zero on each update (ES). Without it a gradient estimated from a few dozen noisy
   * samples wanders off and the weights grow until every output saturates — which is the standard
   * failure of this method and the reason the published versions all carry a decay term.
   */
  decay: number
  /**
   * Exploration noise added to an online learner's actions.
   *
   * A policy gradient needs a *stochastic* policy to have a gradient at all; ours is a
   * deterministic tanh. So an online learner perturbs its own organisms' actions and treats the
   * perturbation as the exploration it is learning from — which is exactly the Gaussian-policy
   * form of REINFORCE, where `∇log π = noise / σ²`. Only that learner's organisms are affected.
   */
  explore: number
  /** Learning rates for an online learner: the policy and the value estimate. */
  actorLr: number
  criticLr: number
  /** Discount and trace decay for TD(λ). */
  gamma: number
  lambda: number
  /**
   * How many lives a genome must be observed over before it is trusted to displace another.
   *
   * **The only lever that attacks the evaluation-noise wall directly.** One life is an enormously
   * noisy estimate of a genome — per-life fitness runs at CV 1.07 on the best objective and 4.22 on
   * the one every learner used — so a pool that inserts on a single observation fills with whichever
   * genome got lucky, destroys the diversity random initialisation supplied, and measures *worse
   * than no learner at all*. Averaging over `reeval` lives cuts the standard error by its square
   * root, which is the only thing available short of more lives.
   *
   * A genome is recognised across lives by its `learnId`, which a budded child inherits from its
   * parent — so a genome accumulates evidence from its whole lineage rather than from one organism.
   */
  reeval: number
  /**
   * Whether a child inherits what its parent *learned* or what it was *born with*.
   *
   * A real and well-studied distinction, not an implementation detail: Lamarckian inheritance is
   * substantially faster and is known to generalise worse, because it lets a lineage bank
   * adaptations to a particular situation. It has to be a dial, because leaving it implicit means
   * picking one by accident — and the accident would have been Lamarckian, since the world
   * reproduces from live weights.
   */
  inherit: 'learned' | 'birth'
  /** Behaviour grid resolution per axis (MAP-Elites). */
  cells: number
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
  // 0.02, not the 0.2 this was before Adam: see the table in `Es`. Ten times too large made the
  // mean move away from a target it was supposed to find.
  lr: 0.02,
  maxAge: 60000,
  decay: 0.002,
  explore: 0.1,
  // small, and measured: see `TdLambda`. Reward is in meals, so these are "fraction of a weight
  // per meal of surprise" and the actor has 410 weights all moving at once.
  actorLr: 0.001,
  criticLr: 0.01,
  /*
   * **The credit-assignment window has to be longer than the gap between rewards.** Both of these
   * were far shorter, and it is a complete explanation for TD measuring *worse than no learner at
   * all* (paired t = -1.8 over six seeds, a full ladder level lower).
   *
   * Measured in a live world: a life lasts 755 ticks on average and takes 25.4 meals, so a reward
   * arrives about every **30 ticks**. The old `gamma: 0.95` gives a value horizon of
   * `1/(1-gamma)` = 20 ticks and the old `lambda: 0.8` an eligibility trace of 5 — so the trace had
   * decayed six times over before the meal it was supposed to explain ever arrived. TD could not
   * connect an action to its consequence in principle, never mind in practice.
   *
   * 0.99 gives a 100-tick horizon, comfortably past the 30-tick reward interval and still well
   * inside a typical life. Note this world is really a *continuing* task rather than an episodic
   * one, so discounting is the wrong formalism in the first place and an average-reward
   * formulation would remove `gamma` as a thing to get wrong. Recorded in the plan.
   */
  gamma: 0.99,
  lambda: 0.97,
  // four lives halves the standard error of a genome's estimate; eight would quarter it, at the
  // cost of a pool that turns over four times more slowly
  reeval: 4,
  inherit: 'learned',
  cells: 6,
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
 * every algorithm in docs/LEARNING.md fits it, and `none` is one of them, so the control is the same
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
    /**
     * Where the brain slots start and how many there are.
     *
     * Only the online learners need these, and they need them badly: their state is **per living
     * organism**, so it has to be a flat array sized at construction rather than a `Map`. A Map
     * cannot go in a fixed-size snapshot, and an online learner's per-organism state is not
     * incidental — it *is* the learning, so losing it across a rewind means a restored world
     * diverges from the one it was copied from. It also removes a Map lookup from a loop that runs
     * once per organism per tick.
     */
    protected readonly brainOffset = 0,
    protected readonly brainCount = 0,
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

  // ---- the online seam ------------------------------------------------------
  /*
   * A second seam, and it needs one.
   *
   * Every learner above acts at a *spawn* and is scored at a *death*, and that interface has a
   * measured ceiling: a spawn needs a free brain slot, a healthy population has none, and the
   * learner was observed handing out 800 samples of which 788 could never be scored — 431 lives
   * seen, **zero** updates. The better the world, the more inert the learner.
   *
   * An online learner does not wait for anything to die. It is called once per organism per tick
   * with what that organism just saw, what it decided, and what it got for it, and it rewrites
   * that organism's own weights. Mortality stops being the rate limit.
   */

  /** True when this learner rewires living organisms rather than only seeding new ones. */
  readonly online: boolean = false

  /**
   * One organism, one tick. May modify `wBrain`, `wLimb` and `yout` in place.
   *
   * `yout` is writable on purpose: a policy gradient needs a stochastic policy to have a gradient,
   * and ours is a deterministic tanh, so an online learner adds its own exploration noise here
   * and learns from the perturbation it chose. Only its own organisms are affected.
   */
  act(_s: OnlineStep): void {}

  /** An organism of this learner's has died; drop whatever per-organism state it held. */
  forget(_b: number): void {}

  /**
   * What this learner currently believes, as a genome: the distribution's mean, the best elite, or
   * null for a learner that holds no single answer.
   *
   * Exists because the alternative was to read it by *drawing a sample*, which is how a test of
   * ES came to be unable to see ES working: a draw is `mean + σ·ε`, the noise is as large as the
   * quantity being measured, and each draw also consumed a slot in the mirrored-sampling pairing
   * and so doubled the variance of the very gradient under test. Measuring a thing should not
   * perturb it.
   */
  center(): Float64Array | null {
    return null
  }

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
  /*
   * A learner is state like any other, so rewinding has to put it back.
   *
   * The in-flight samples of a batch algorithm are *not* saved, and the note here used to say that
   * "a rewind that loses them costs one partial update rather than correctness". **That is wrong,
   * and measured: a CEM world is not bit-identical after a restore.** Losing the pending ε vectors
   * changes which genome the learner hands out next, which changes the world.
   *
   * It is a real gap in the determinism invariant, not a free simplification, and it is the only
   * one left — every other learner and every world feature now restores bit-identically. Fixing it
   * means serialising `pending` and `batch`, both bounded (`capPending` is `max(8, batch·4)`), so
   * it is a bounded amount of work rather than an impossibility. Recorded rather than claimed
   * harmless.

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
  /** The genome tag each slot holds, so another life of the same genome is recognised. */
  private gid: Float64Array
  /** How many lives each slot's estimate is averaged over. Below `reeval` it is provisional. */
  private seenN: Float64Array
  private n = 0

  constructor(cfg: LearnConfig, seed: number) {
    super(cfg, seed)
    const cap = Math.max(2, Math.round(cfg.pool))
    this.genes = new Float64Array(cap * N_GENE)
    this.fit = new Float64Array(cap).fill(-Infinity)
    this.born = new Float64Array(cap)
    this.gid = new Float64Array(cap)
    this.seenN = new Float64Array(cap)
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
    /*
     * **Re-evaluation: another life of a genome already held updates its estimate rather than
     * competing with it.**
     *
     * A genome is recognised by its `learnId`, which a budded child inherits — so a genome
     * accumulates evidence from its whole lineage. The scalars are kept as a running mean, so an
     * entry's fitness is the mean over every life that carried it rather than whatever one life
     * happened to do.
     *
     * Without this a pool inserts on a single observation at CV 1.07 (or 4.22 on `offspring`), so
     * it fills with whichever genome got lucky and destroys the diversity random initialisation
     * supplied — measured *worse than no learner at all* for every algorithm tried.
     */
    if (r.id > 0) {
      for (let i = 0; i < this.n; i++) {
        if (this.gid[i] !== r.id) continue
        const k = ++this.seenN[i]
        const o = i * N_SCALARS
        for (let j = 0; j < N_SCALARS; j++) this.raw[o + j] += (scalars[j] - this.raw[o + j]) / k
        this.rescore()
        this.updates++
        return
      }
    }
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
      /*
       * **A provisional entry is displaced before an established one.** An entry seen fewer than
       * `reeval` times is an estimate from too few lives to trust, so it gives way first regardless
       * of the number against its name — otherwise a lucky single observation sits in the pool
       * holding a high fitness it has not earned, and the pool converges on noise.
       */
      let worst = 0
      const rank = (i: number): number => (this.seenN[i] >= this.cfg.reeval ? 1 : 0)
      for (let i = 1; i < this.n; i++) {
        if (rank(i) < rank(worst) || (rank(i) === rank(worst) && this.fit[i] < this.fit[worst])) worst = i
      }
      // a new single observation may only take a provisional slot, never an established one
      if (rank(worst) === 0 || fitness > this.fit[worst]) slot = worst
    }
    if (slot < 0) return
    this.genes.set(join(r.wBrain, r.wLimb), slot * N_GENE)
    this.raw.set(scalars.subarray(0, N_SCALARS), slot * N_SCALARS)
    this.fit[slot] = fitness
    this.born[slot] = this.tick
    this.gid[slot] = r.id
    this.seenN[slot] = 1
    this.updates++
  }

  saveSize(): number {
    // +2 per slot for `gid` and `seenN`: the accumulated evidence *is* the learning, so a rewind
    // that dropped it would restore a world whose pool had never been re-evaluated
    return super.saveSize() + 1 + this.cap * (N_GENE + 4 + N_SCALARS)
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    let o = off + super.saveSize()
    a[o++] = this.n
    for (const arr of [this.genes, this.fit, this.born, this.raw, this.gid, this.seenN]) {
      a.set(arr, o)
      o += arr.length
    }
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    let o = off + super.saveSize()
    this.n = a[o++]
    for (const arr of [this.genes, this.fit, this.born, this.raw, this.gid, this.seenN]) {
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

  center(): Float64Array {
    return Float64Array.from(this.mean)
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

/**
 * Evolution strategy (A2): one mean genome, moved along a rank-weighted sum of its own samples.
 *
 * Three things were missing against the published form of this method, and all three are the
 * difference between it working and it merely running:
 *
 * - **Adam** on the estimated gradient, so one step size is usable across 418 weights of wildly
 *   uneven gradient scale.
 * - **Weight decay**, against the mean drifting outward under its own noise until every output
 *   saturates — a saturated policy cannot be selected on, which is the old oversized-init failure
 *   reached from a different direction.
 * - **Rank shaping that is actually centred**, which it already was: linear ranks in [-0.5, 0.5].
 *   Kept, and noted here so it is not "fixed" again later.
 *
 * Mirrored sampling was already in `Distribution` and is the other half of why this works.
 *
 * **Adam needed the learning rate cut by ten, and finding out why is the useful part.** With the
 * inherited `lr` of 0.2 the mean moved *away* from a known target — distance 0.40 → 1.08 over 80
 * updates, while CEM on the same problem went 0.40 → 0.34. Adam normalises away gradient
 * magnitude, which is exactly the information that says "this estimate is noise": at a batch of
 * ten samples over 418 dimensions the estimate is almost pure noise, and Adam then walks it at the
 * full learning rate. The published versions of this method use populations in the hundreds or
 * thousands, where the estimate is genuinely informative; our batch is bounded by how many
 * organisms die.
 *
 * Measured on that target (start 0.400, lower is better, 1,200 lives):
 *
 * | lr | batch 10 | batch 32 |
 * |---|---|---|
 * | 0.002 | 0.376 | 0.385 |
 * | 0.01 | 0.296 | 0.330 |
 * | **0.02** | **0.233** | 0.274 |
 * | 0.05 | 0.247 | 0.204 |
 * | 0.2 (old) | 1.083 | 0.656 |
 *
 * The decay term is *not* justified by that test — with no decay the same setting gives 0.287
 * against 0.296, a difference inside one seed's noise, and the synthetic target sits away from the
 * origin so decay is mildly harmful there by construction. It is kept for the saturation argument,
 * which that test cannot see.
 */
class Es extends Distribution {
  readonly algo = 'es' as const
  /** Adam's first and second moment estimates, per weight. */
  private m = new Float64Array(N_GENE)
  private v = new Float64Array(N_GENE)
  private steps = 0

  protected sigmaAt(): number {
    return this.cfg.sigma
  }

  protected update(): void {
    const u = this.ranks()
    const n = u.length
    const scale = 1 / (n * Math.max(1e-9, this.cfg.sigma))
    const b1 = 0.9
    const b2 = 0.999
    const eps = 1e-8
    this.steps++
    // bias correction, so the first few updates are not damped to nothing by zero-initialised moments
    const c1 = 1 - b1 ** this.steps
    const c2 = 1 - b2 ** this.steps
    for (let i = 0; i < N_GENE; i++) {
      let g = 0
      for (let k = 0; k < n; k++) g += u[k] * this.batch[k].eps[i]
      g *= scale
      this.m[i] = b1 * this.m[i] + (1 - b1) * g
      this.v[i] = b2 * this.v[i] + (1 - b2) * g * g
      const step = (this.cfg.lr * (this.m[i] / c1)) / (Math.sqrt(this.v[i] / c2) + eps)
      this.mean[i] += step - this.cfg.decay * this.mean[i]
    }
  }

  saveSize(): number {
    return super.saveSize() + 2 * N_GENE + 1
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    const o = off + super.saveSize()
    a.set(this.m, o)
    a.set(this.v, o + N_GENE)
    a[o + 2 * N_GENE] = this.steps
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    const o = off + super.saveSize()
    this.m.set(a.subarray(o, o + N_GENE))
    this.v.set(a.subarray(o + N_GENE, o + 2 * N_GENE))
    this.steps = a[o + 2 * N_GENE]
  }
}

/**
 * MAP-Elites (quality–diversity): the best genome for each *kind* of behaviour.
 *
 * Every other learner here keeps the best genome by one number, and that is the wrong objective
 * for this project. The goal is organisms that *slowly become more complex*, and a scalar optimum
 * discards the slow wanderer that would have become something for losing, today, to a fast-
 * breeding clump. MAP-Elites keeps both, because they are in different cells.
 *
 * The machinery is also already here in hand-rolled form: the search stratifies its promotion
 * instead of taking a top-N, and the Discoveries page picks worlds along several axes rather than
 * by rank. Both are this idea, applied one level up. This is the standard version of it.
 *
 * The behaviour space is three of the fitness scalars, each bucketed by its percentile within the
 * cohort rather than by raw value — percentiles because the raw scales are incomparable (offspring
 * counts of 0–3 against energy in the thousands) and because the grid then populates itself
 * evenly whatever the world's absolute numbers turn out to be.
 */
class MapElites extends Learner {
  readonly algo = 'elites' as const
  /** cell key -> the genome that holds it, with the raw scalars it was scored on. */
  private archive = new Map<number, { g: Float64Array; raw: Float64Array }>()
  /** Live samples: a genome handed out, waiting for its organism to die. */
  private pending = new Map<number, Float64Array>()

  /** Which three scalars span the behaviour space, by index into the fitness scalars. */
  private static readonly AXES = 3

  private cellOf(raw: Float64Array): number {
    const n = Math.max(2, Math.round(this.cfg.cells))
    let key = 0
    for (let a = 0; a < MapElites.AXES; a++) {
      const p = this.cohort.percentile(a, raw[a])
      key = key * n + Math.min(n - 1, Math.max(0, Math.floor(p * n)))
    }
    return key
  }

  protected sample(): Genome | null {
    /*
     * Draw an elite at random and mutate it — *uniformly* over occupied cells, not by score.
     * Biasing the draw toward high-scoring cells would turn this back into a scalar optimiser
     * wearing a grid, which is the thing it exists not to be.
     */
    if (this.archive.size === 0) return null
    const keys = [...this.archive.keys()]
    const pick = this.archive.get(keys[this.rng.int(keys.length)])!
    const child = Float64Array.from(pick.g, (w) => w + this.cfg.sigma * this.rng.gauss())
    const g = this.genome(...split(child))
    this.pending.set(g.id, child)
    if (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value as number)
    return g
  }

  protected score(r: LifeRecord, scalars: Float64Array, fitness: number): void {
    const raw = Float64Array.from(scalars.subarray(0, N_SCALARS))
    const gene = this.pending.get(r.id) ?? join(r.wBrain, r.wLimb)
    this.pending.delete(r.id)
    const key = this.cellOf(raw)
    const held = this.archive.get(key)
    // a cell is won on the chosen measure, but only against whatever else is in *that* cell
    if (!held || this.cohort.score(held.raw, this.cfg.fitness) < fitness) {
      this.archive.set(key, { g: gene, raw })
      this.updates++
    }
  }

  protected held(): number {
    return this.archive.size
  }

  /** The best cell, for display. The archive's point is the whole set, but a graph needs one. */
  center(): Float64Array | null {
    let best: Float64Array | null = null
    let bestF = -Infinity
    for (const e of this.archive.values()) {
      const f = this.cohort.score(e.raw, this.cfg.fitness)
      if (f > bestF) {
        bestF = f
        best = e.g
      }
    }
    return best ? Float64Array.from(best) : null
  }

  // The archive is a map of unbounded size, so it is not written into the fixed-size snapshot
  // ring. A rewind therefore keeps the learner's *progress figures* and loses its archive, which
  // is the same trade the batch learners already make with their in-flight samples.
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

/**
 * Base for the two within-life learners. Both keep state per organism and both need to clear it
 * when that organism dies, which is the whole of what they share.
 */
abstract class Online extends Learner {
  readonly online = true

  /** Nothing to hand out at a spawn: an online learner shapes a life, it does not seed one. */
  protected sample(): Genome | null {
    return null
  }

  /** Online learners are still *scored* at death, so the progress graph and the cohort work. */
  protected score(): void {}
}

/**
 * TD(λ) actor–critic: the one learner here that improves an organism inside its own lifetime.
 *
 * The textbook method for a *continuing* task with linear function approximation and no episode
 * boundary, which is exactly this world — organisms do not have episodes, they have lives, and a
 * life can run for a hundred thousand ticks. A value head `V(x) = v·x` predicts future reward, the
 * prediction error `δ = r + γV(x') − V(x)` says whether things went better or worse than expected,
 * and eligibility traces carry that error back to the inputs and actions that led there, which is
 * the credit-assignment problem solved properly rather than by a heuristic.
 *
 * **The critic is shared across the learner's organisms; the actor is not.** The critic answers
 * "how good is this situation", and the situation is the same world for everybody, so sharing it
 * multiplies the data behind it. The actor is the organism's own brain weights, modified in place,
 * because an organism learning within its life is precisely a change to its own policy. (This is
 * the shape of A3C and of every shared-critic method: one world model, many bodies.)
 *
 * Exploration is Gaussian noise on the action, and the actor update is `δ · noise · x`, which is
 * the Gaussian-policy form of the policy gradient — `∇log π = noise / σ²`, with the `1/σ²` folded
 * into the learning rate. Nothing here is novel; that is the point of choosing it.
 */
/** How far δ may run before it is clipped. See `TdLambda.act` for why this is not optional. */
const DELTA_CLIP = 2

class TdLambda extends Online {
  readonly algo = 'td' as const
  /** The shared value head, one weight per brain input. */
  private v = new Float64Array(N_BRAIN_IN)
  /** Per-organism eligibility traces, flat and indexed by `b - brainOffset`. See the constructor. */
  private eV: Float64Array
  private eA: Float64Array
  private prevV: Float64Array
  private started: Uint8Array
  private deltaSum = 0
  private deltaN = 0

  constructor(cfg: LearnConfig, seed: number, brainOffset = 0, brainCount = 0) {
    super(cfg, seed, brainOffset, brainCount)
    const n = Math.max(1, brainCount)
    this.eV = new Float64Array(n * N_BRAIN_IN)
    this.eA = new Float64Array(n * N_GENE_BRAIN)
    this.prevV = new Float64Array(n)
    this.started = new Uint8Array(n)
  }

  /** Slot for organism `b`, or -1 when it falls outside the range this learner was sized for. */
  private slot(b: number): number {
    const k = b - this.brainOffset
    return k >= 0 && k < this.brainCount ? k : -1
  }

  forget(b: number): void {
    const k = this.slot(b)
    if (k < 0) return
    this.eV.fill(0, k * N_BRAIN_IN, (k + 1) * N_BRAIN_IN)
    this.eA.fill(0, k * N_GENE_BRAIN, (k + 1) * N_GENE_BRAIN)
    this.prevV[k] = 0
    this.started[k] = 0
  }

  act(s: OnlineStep): void {
    const { cfg } = this
    const k = this.slot(s.b)
    if (k < 0) return
    const eVo = k * N_BRAIN_IN
    const eAo = k * N_GENE_BRAIN
    let value = 0
    for (let i = 0; i < N_BRAIN_IN; i++) value += this.v[i] * s.xin[i]

    if (this.started[k]) {
      /*
       * δ against *last* tick's prediction. The traces already hold last tick's inputs and action
       * noise, so the error lands on what actually caused it — which is the entire reason to use
       * traces rather than updating on the current step.
       *
       * Clipped, because an unclipped δ is how this method destroys itself: the first run drove
       * the whole population extinct inside 500 ticks — 89,500 updates, zero completed lives —
       * as a large δ blew up the actor weights, the policy saturated, and movement cost at
       * `c_mv·μ·F²` finished the job. Clipping is the standard guard and it is load-bearing here.
       */
      const delta = Math.max(-DELTA_CLIP, Math.min(DELTA_CLIP, s.reward + cfg.gamma * value - this.prevV[k]))
      this.deltaSum += Math.abs(delta)
      this.deltaN++
      for (let i = 0; i < N_BRAIN_IN; i++) this.v[i] += cfg.criticLr * delta * this.eV[eVo + i]
      /*
       * Decay is scaled by the learning rate, which it was not.
       *
       * Written as `+= actorLr * delta * trace - decay * w`, the decay term is **independent of the
       * learning rate** — so with `actorLr = 0` the gradient term vanishes and the decay keeps
       * shrinking every weight toward zero, tick after tick. "Learning switched off" still rewrote
       * the policy, and the only reason that was ever visible is a test asserting weights do not
       * move when the rates are zero.
       *
       * Weight decay is part of the update, so it belongs inside the step size. This is also the
       * standard form: decoupled weight decay scales with the learning rate precisely so that
       * turning learning down turns regularisation down with it.
       */
      for (let q = 0; q < N_GENE_BRAIN; q++) {
        s.wBrain[q] += cfg.actorLr * (delta * this.eA[eAo + q] - cfg.decay * s.wBrain[q])
      }
      this.updates++
    }

    /*
     * **Replacing traces**, not accumulating ones.
     *
     * An accumulating trace for a feature that is on every tick — the bias input is exactly 1
     * forever — grows to `1/(1 − γλ)`, which is 4.2 at the defaults and unbounded as λ → 1. Every
     * update then multiplies δ by that, and a method whose step size depends on how long the
     * episode has been running is a method that diverges. Replacing traces are the textbook
     * answer and bound the trace by the feature itself.
     */
    const decay = cfg.gamma * cfg.lambda
    for (let i = 0; i < N_BRAIN_IN; i++) {
      const d = decay * this.eV[eVo + i]
      this.eV[eVo + i] = Math.abs(s.xin[i]) > Math.abs(d) ? s.xin[i] : d
    }
    if (cfg.explore > 0) {
      for (let o = 0; o < N_BRAIN_OUT; o++) {
        const noise = cfg.explore * this.rng.gauss()
        s.yout[o] += noise
        const row = eAo + o * N_BRAIN_IN
        for (let i = 0; i < N_BRAIN_IN; i++) {
          const e = noise * s.xin[i]
          const d = decay * this.eA[row + i]
          this.eA[row + i] = Math.abs(e) > Math.abs(d) ? e : d
        }
      }
    } else {
      for (let q = 0; q < N_GENE_BRAIN; q++) this.eA[eAo + q] *= decay
    }
    this.prevV[k] = value
    this.started[k] = 1
  }

  protected held(): number {
    let n = 0
    for (let k = 0; k < this.brainCount; k++) if (this.started[k]) n++
    return n
  }

  // ---- state, so a rewind restores the learning rather than losing it --------
  saveSize(): number {
    return super.saveSize() + N_BRAIN_IN + this.eV.length + this.eA.length + this.prevV.length + this.started.length + 2
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    let o = off + super.saveSize()
    a.set(this.v, o)
    o += N_BRAIN_IN
    a.set(this.eV, o)
    o += this.eV.length
    a.set(this.eA, o)
    o += this.eA.length
    a.set(this.prevV, o)
    o += this.prevV.length
    for (let k = 0; k < this.started.length; k++) a[o + k] = this.started[k]
    o += this.started.length
    a[o] = this.deltaSum
    a[o + 1] = this.deltaN
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    let o = off + super.saveSize()
    this.v.set(a.subarray(o, o + N_BRAIN_IN))
    o += N_BRAIN_IN
    this.eV.set(a.subarray(o, o + this.eV.length))
    o += this.eV.length
    this.eA.set(a.subarray(o, o + this.eA.length))
    o += this.eA.length
    this.prevV.set(a.subarray(o, o + this.prevV.length))
    o += this.prevV.length
    for (let k = 0; k < this.started.length; k++) this.started[k] = a[o + k] ? 1 : 0
    o += this.started.length
    this.deltaSum = a[o]
    this.deltaN = a[o + 1]
  }

  /** Mean |δ|, which is the honest "is it learning" figure for a critic: it should fall. */
  meanError(): number {
    return this.deltaN > 0 ? this.deltaSum / this.deltaN : 0
  }
}

/**
 * Reward-modulated Hebbian plasticity: `Δw = η · (r − r̄) · x · y`.
 *
 * Three factors — input, output, and reward relative to this organism's own recent average. It is
 * entirely local, needs no value function and no traces, and it is the **control against TD(λ)**:
 * if a rule this simple does as well, then the value head is not earning its complexity, and that
 * is worth knowing before any of it goes into a search.
 *
 * The baseline subtraction is not optional. With raw reward the rule only ever strengthens
 * whatever an organism was doing when it happened to eat, including the parts that had nothing to
 * do with eating, and the weights grow without bound. Against its own running mean the update has
 * a sign, and doing *worse* than usual weakens the association that led there.
 */
class Hebbian extends Online {
  readonly algo = 'hebb' as const
  /** Each organism's own running reward baseline, flat so it survives a snapshot. */
  private base: Float64Array
  private seenN: Float64Array

  constructor(cfg: LearnConfig, seed: number, brainOffset = 0, brainCount = 0) {
    super(cfg, seed, brainOffset, brainCount)
    this.base = new Float64Array(Math.max(1, brainCount))
    this.seenN = new Float64Array(Math.max(1, brainCount))
  }

  private slot(b: number): number {
    const k = b - this.brainOffset
    return k >= 0 && k < this.brainCount ? k : -1
  }

  forget(b: number): void {
    const k = this.slot(b)
    if (k >= 0) {
      this.base[k] = 0
      this.seenN[k] = 0
    }
  }

  act(s: OnlineStep): void {
    const { cfg } = this
    const k = this.slot(s.b)
    if (k < 0) return
    if (cfg.explore > 0) for (let o = 0; o < N_BRAIN_OUT; o++) s.yout[o] += cfg.explore * this.rng.gauss()
    const adv = s.reward - this.base[k]
    // the baseline tracks this organism's own recent reward, so "better than usual" is personal
    this.base[k] += 0.01 * adv
    this.seenN[k]++
    if (adv === 0) return
    for (let o = 0; o < N_BRAIN_OUT; o++) {
      const post = Math.tanh(s.yout[o])
      const row = o * N_BRAIN_IN
      const g = cfg.actorLr * adv * post
      for (let i = 0; i < N_BRAIN_IN; i++) {
        const w = row + i
        // decay inside the step size, for the same reason as TD above: an unscaled decay term means
        // "learning switched off" still shrinks every weight toward zero on every tick
        s.wBrain[w] += g * s.xin[i] - cfg.actorLr * cfg.decay * s.wBrain[w]
      }
    }
    this.updates++
  }

  protected held(): number {
    let n = 0
    for (let q = 0; q < this.brainCount; q++) if (this.seenN[q] > 0) n++
    return n
  }

  saveSize(): number {
    return super.saveSize() + this.base.length + this.seenN.length
  }

  saveInto(a: Float64Array, off: number): void {
    super.saveInto(a, off)
    const o = off + super.saveSize()
    a.set(this.base, o)
    a.set(this.seenN, o + this.base.length)
  }

  loadFrom(a: Float64Array, off: number): void {
    super.loadFrom(a, off)
    const o = off + super.saveSize()
    this.base.set(a.subarray(o, o + this.base.length))
    this.seenN.set(a.subarray(o + this.base.length, o + this.base.length + this.seenN.length))
  }
}

export function makeLearner(cfg: LearnConfig, seed: number, brainOffset = 0, brainCount = 0): Learner {
  switch (cfg.algo) {
    case 'random':
      return new RandomSearch(cfg, seed)
    case 'ga':
      return new Ga(cfg, seed)
    case 'es':
      return new Es(cfg, seed)
    case 'cem':
      return new Cem(cfg, seed)
    case 'elites':
      return new MapElites(cfg, seed)
    // the online learners keep state per living organism, so they need to know how many there can be
    case 'td':
      return new TdLambda(cfg, seed, brainOffset, brainCount)
    case 'hebb':
      return new Hebbian(cfg, seed, brainOffset, brainCount)
    default:
      return new NoLearner(cfg, seed)
  }
}
