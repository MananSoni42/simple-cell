/**
 * Several measures, one number.
 *
 * The nine scalars a finished life yields are not comparable: offspring is a zero-inflated integer
 * from 0 to about 12, lifespan is roughly exponential out to thousands, net energy can be
 * *negative*, and foraging efficiency is `harvested / moved`, so an organism that barely moved
 * produces an enormous outlier. Adding those together, or z-scoring them, lets one scalar's units
 * decide the whole result — a single efficiency outlier inflates σ and collapses everyone else.
 *
 * So every scalar is converted to its **percentile among recent deaths** before anything is
 * combined. That is the only transform immune to all of the above at once: free of units, bounded,
 * indifferent to heavy tails, and it handles negatives without a special case. What it costs is
 * magnitude — being ten times better and one percent better both just mean "ranked above" — and
 * stationarity: the same life scores differently depending on when it ended, because the cohort
 * moves. In a world with food regimes that is arguably the right statement ("better than your
 * contemporaries"), but it does mean the optimised number is useless as a progress metric. Raw
 * values are reported alongside, always, and that is how a reward hack gets noticed.
 */

export type FitnessKey =
  | 'offspring'
  | 'lifespan'
  | 'harvested'
  | 'net'
  | 'per_tick'
  | 'peak'
  | 'efficiency'
  | 'together'
  | 'meals'

/** What an organism's life came to, in numbers the world already keeps. */
export interface LifeStats {
  age: number
  children: number
  generation: number
  harvested: number
  spent: number
  moved: number
  meals: number
  orderTicks: number
  peakReserve: number
}

export const FITNESS: { key: FitnessKey; name: string; blurb: string; invented: boolean }[] = [
  { key: 'offspring', name: 'offspring', blurb: 'children left behind — the only one the world was already counting for its own reasons', invented: false },
  { key: 'lifespan', name: 'lifespan', blurb: 'ticks lived', invented: true },
  { key: 'harvested', name: 'energy taken', blurb: 'energy taken in from food over a whole life', invented: true },
  { key: 'net', name: 'net energy', blurb: 'energy taken in, less everything spent on upkeep, movement and signalling', invented: true },
  { key: 'per_tick', name: 'energy a tick', blurb: 'energy taken in per tick alive — the cleanest "is it good at living"', invented: true },
  { key: 'peak', name: 'peak reserve', blurb: 'the most it ever held at once', invented: true },
  { key: 'efficiency', name: 'foraging', blurb: 'energy taken in per unit of distance travelled', invented: true },
  { key: 'together', name: 'togetherness', blurb: 'time spent joined to others, weighted by how large the compound was', invented: true },
  { key: 'meals', name: 'meals', blurb: 'how many times it ate', invented: true },
]

export const N_SCALARS = FITNESS.length
export const KEYS: FitnessKey[] = FITNESS.map((f) => f.key)
export const indexOfKey = (k: FitnessKey): number => KEYS.indexOf(k)

/** All scalars are known exactly at death, and none of them can be infinite. */
export function scalarOf(key: FitnessKey, s: LifeStats): number {
  switch (key) {
    case 'offspring':
      return s.children
    case 'lifespan':
      return s.age
    case 'harvested':
      return s.harvested
    case 'net':
      return s.harvested - s.spent
    case 'per_tick':
      return s.harvested / Math.max(1, s.age)
    case 'peak':
      return s.peakReserve
    case 'efficiency':
      return s.harvested / Math.max(1, s.moved)
    case 'together':
      return s.orderTicks
    case 'meals':
      return s.meals
  }
}

/** Every scalar at once, in `FITNESS` order. Computing all nine is free; they are counter reads. */
export function scalarsOf(s: LifeStats, into = new Float64Array(N_SCALARS)): Float64Array {
  for (let i = 0; i < N_SCALARS; i++) into[i] = scalarOf(KEYS[i], s)
  return into
}

/** Kept for displaying one measure on its own. */
export const fitnessOf = scalarOf

export type Combiner = 'sum' | 'geometric' | 'chebyshev'

export const COMBINERS: { key: Combiner; name: string; blurb: string }[] = [
  {
    key: 'sum',
    name: 'add them up',
    blurb: 'a weighted average of the percentiles: being strong at one makes up for being weak at another',
  },
  {
    key: 'geometric',
    name: 'all of them',
    blurb: 'a weighted geometric mean: being useless at any one of them drags the whole score down, so it rewards being decent at everything',
  },
  {
    key: 'chebyshev',
    name: 'no weak spot',
    blurb: 'scored on its worst measure, with a nudge from the rest — the most demanding, and the slowest to show progress',
  },
]

/**
 * Which measures count and how they are put together. Weights are per scalar in `FITNESS` order,
 * and a weight of zero means "not counted" — one array rather than a list plus a lookup, because
 * that is what makes this cheap to snapshot and to re-score when it changes mid-run.
 */
export interface FitnessSpec {
  weights: number[]
  combine: Combiner
  /** How many recent deaths a percentile is measured against. */
  window: number
}

export const DEFAULT_WINDOW = 128

export function specFromKeys(keys: FitnessKey[], combine: Combiner = 'geometric', window = DEFAULT_WINDOW): FitnessSpec {
  const weights = new Array<number>(N_SCALARS).fill(0)
  const chosen = keys.length > 0 ? keys : ['offspring' as FitnessKey]
  for (const k of chosen) {
    const i = indexOfKey(k)
    if (i >= 0) weights[i] = 1 / chosen.length
  }
  return { weights, combine, window }
}

export const DEFAULT_SPEC = (): FitnessSpec => specFromKeys(['offspring'], 'geometric')

export function keysOf(spec: FitnessSpec): FitnessKey[] {
  return KEYS.filter((_, i) => (spec.weights[i] ?? 0) > 0)
}

/** Weights that sum to one, so a score is always comparable with another score of the same shape. */
export function normalised(spec: FitnessSpec): number[] {
  const total = spec.weights.reduce((a, b) => a + Math.max(0, b), 0)
  if (total <= 0) {
    const w = new Array<number>(N_SCALARS).fill(0)
    w[0] = 1
    return w
  }
  return spec.weights.map((w) => Math.max(0, w) / total)
}

export function describeSpec(spec: FitnessSpec): string {
  const keys = keysOf(spec)
  const names = keys.map((k) => FITNESS.find((f) => f.key === k)!.name)
  if (names.length === 0) return 'nothing'
  if (names.length === 1) return names[0]
  const how = COMBINERS.find((c) => c.key === spec.combine)!.name
  return `${names.join(' + ')} (${how})`
}

/** True when nothing invented has been written down: offspring alone. */
export function isImplicitOnly(spec: FitnessSpec): boolean {
  const keys = keysOf(spec)
  return keys.length === 1 && keys[0] === 'offspring'
}

/**
 * The recent dead, as raw scalar vectors.
 *
 * Raw rather than scored, which is the decision that makes everything else easy: changing which
 * measures count — even mid-run — re-scores the history instead of discarding it, so a GA's pool
 * stays valid and an in-flight batch does not contribute one stale update.
 */
export class Cohort {
  private readonly buf: Float64Array
  private readonly cap: number
  private pos = 0
  private filled = 0
  /** Scratch, so scoring a death allocates nothing. */
  private readonly terms = new Float64Array(N_SCALARS)

  constructor(cap = DEFAULT_WINDOW) {
    this.cap = Math.max(4, Math.round(cap))
    this.buf = new Float64Array(this.cap * N_SCALARS)
  }

  get size(): number {
    return this.filled
  }

  push(scalars: Float64Array): void {
    this.buf.set(scalars.subarray(0, N_SCALARS), this.pos * N_SCALARS)
    this.pos = (this.pos + 1) % this.cap
    if (this.filled < this.cap) this.filled++
  }

  /**
   * Where `x` falls among the cohort on scalar `i`, as a value in (0,1).
   *
   * Midranks for ties, because the ties are the point: when seven in ten organisms leave no
   * children, they are genuinely equal and should share a percentile rather than be ordered by
   * whatever the loop happened to see first.
   *
   * The plotting position is (r + 1/2) / (n + 1) rather than r / n, and the choice is load-bearing
   * in both directions: `x` need not be a member of the cohort, so r can be 0 (a value below
   * everything seen) or n (above everything), and the result must still be strictly inside (0,1).
   * Zero would annihilate a geometric mean, and one would let a single sample saturate the score.
   */
  percentile(i: number, x: number): number {
    const n = this.filled
    if (n === 0) return 0.5
    let below = 0
    let equal = 0
    for (let k = 0; k < n; k++) {
      const v = this.buf[k * N_SCALARS + i]
      if (v < x) below++
      else if (v === x) equal++
    }
    const r = below + 0.5 * equal
    return (r + 0.5) / (n + 1)
  }

  /** Mean raw value of each scalar over the window, for reporting what the numbers actually are. */
  means(into = new Float64Array(N_SCALARS)): Float64Array {
    into.fill(0)
    const n = this.filled
    if (n === 0) return into
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < N_SCALARS; i++) into[i] += this.buf[k * N_SCALARS + i]
    }
    for (let i = 0; i < N_SCALARS; i++) into[i] /= n
    return into
  }

  /**
   * One number from many, in (0,1].
   *
   * The three combiners mean different things and none is a default by accident: a weighted sum
   * lets a strong measure pay for a weak one; a geometric mean does not, so it asks for an
   * organism that is decent at everything; and Chebyshev scores the worst measure alone. The
   * augmenting term on Chebyshev is the standard fix for the plateau you otherwise get when two
   * samples share a worst measure — without it there is no gradient at all between them, and it
   * is divided back out so that all three agree exactly when only one measure is selected.
   */
  score(scalars: Float64Array, spec: FitnessSpec): number {
    const w = normalised(spec)
    const terms = this.terms
    let used = 0
    for (let i = 0; i < N_SCALARS; i++) {
      if (w[i] <= 0) {
        terms[i] = 0
        continue
      }
      terms[i] = this.percentile(i, scalars[i])
      used++
    }
    if (used === 0) return 0

    if (spec.combine === 'sum') {
      let s = 0
      for (let i = 0; i < N_SCALARS; i++) if (w[i] > 0) s += w[i] * terms[i]
      return s
    }
    if (spec.combine === 'geometric') {
      // in log space: a product of nine terms underflows long before a sum of logs does
      let s = 0
      for (let i = 0; i < N_SCALARS; i++) if (w[i] > 0) s += w[i] * Math.log(Math.max(1e-12, terms[i]))
      return Math.exp(s)
    }
    const RHO = 0.05
    let worst = Infinity
    let sum = 0
    for (let i = 0; i < N_SCALARS; i++) {
      if (w[i] <= 0) continue
      const t = w[i] * terms[i] * used // × used, so equal weights leave the scale alone
      worst = Math.min(worst, t)
      sum += w[i] * terms[i]
    }
    return (worst + RHO * sum) / (1 + RHO)
  }

  /** An independent copy, for use as a frozen reference. */
  copy(): Cohort {
    const c = new Cohort(this.cap)
    c.buf.set(this.buf)
    c.pos = this.pos
    c.filled = this.filled
    return c
  }

  // ---- snapshot ------------------------------------------------------------
  saveSize(): number {
    return 2 + this.cap * N_SCALARS
  }

  saveInto(a: Float64Array, off: number): void {
    a[off] = this.pos
    a[off + 1] = this.filled
    a.set(this.buf, off + 2)
  }

  loadFrom(a: Float64Array, off: number): void {
    this.pos = a[off]
    this.filled = a[off + 1]
    this.buf.set(a.subarray(off + 2, off + 2 + this.buf.length))
  }
}
