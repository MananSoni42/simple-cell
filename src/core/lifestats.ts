export interface Summary {
  n: number
  min: number
  mean: number
  median: number
  p90: number
  max: number
}

const EMPTY: Summary = { n: 0, min: 0, mean: 0, median: 0, p90: 0, max: 0 }

function quantile(sorted: ArrayLike<number>, n: number, q: number): number {
  if (n === 0) return 0
  const pos = (n - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Summary of a set of values (the input is not modified). */
export function summarize(values: ArrayLike<number>, n = values.length): Summary {
  if (n === 0) return EMPTY
  const a = Float64Array.from({ length: n }, (_, i) => values[i])
  a.sort()
  let sum = 0
  for (let i = 0; i < n; i++) sum += a[i]
  return { n, min: a[0], mean: sum / n, median: quantile(a, n, 0.5), p90: quantile(a, n, 0.9), max: a[n - 1] }
}

/**
 * Running record of completed lifespans. Count, mean, min and max are exact over
 * everything recorded; median and p90 come from the most recent `capacity` values.
 */
export class LifeTracker {
  private count = 0
  private sum = 0
  private lo = Infinity
  private hi = 0
  private ring: Float64Array
  private filled = 0
  private pos = 0

  constructor(capacity = 4096) {
    this.ring = new Float64Array(capacity)
  }

  record(v: number): void {
    this.count++
    this.sum += v
    if (v < this.lo) this.lo = v
    if (v > this.hi) this.hi = v
    this.ring[this.pos] = v
    this.pos = (this.pos + 1) % this.ring.length
    if (this.filled < this.ring.length) this.filled++
  }

  summary(): Summary {
    if (this.count === 0) return EMPTY
    const recent = summarize(this.ring, this.filled)
    return { n: this.count, min: this.lo, mean: this.sum / this.count, median: recent.median, p90: recent.p90, max: this.hi }
  }
}

/**
 * Mean of recorded values over a trailing window of ticks, bucketed so the window can be
 * long (10k ticks) without keeping every value. Buckets older than the window are recycled.
 */
export class RollingMean {
  private sums: Float64Array
  private counts: Int32Array
  private epoch: Int32Array // which window-slot each bucket currently holds
  readonly bucketTicks: number

  constructor(
    readonly windowTicks: number,
    readonly buckets: number,
  ) {
    this.bucketTicks = Math.max(1, Math.round(windowTicks / buckets))
    this.sums = new Float64Array(buckets)
    this.counts = new Int32Array(buckets)
    this.epoch = new Int32Array(buckets).fill(-1)
  }

  private slotOf(tick: number): { idx: number; ep: number } {
    const ep = Math.floor(tick / this.bucketTicks)
    return { idx: ((ep % this.buckets) + this.buckets) % this.buckets, ep }
  }

  record(tick: number, value: number): void {
    const { idx, ep } = this.slotOf(tick)
    if (this.epoch[idx] !== ep) {
      this.epoch[idx] = ep
      this.sums[idx] = 0
      this.counts[idx] = 0
    }
    this.sums[idx] += value
    this.counts[idx]++
  }

  /** Bucket means oldest-to-newest, NaN where the window holds no data. */
  series(tick: number): Float64Array {
    const out = new Float64Array(this.buckets)
    const newest = Math.floor(tick / this.bucketTicks)
    for (let b = 0; b < this.buckets; b++) {
      const ep = newest - (this.buckets - 1 - b)
      const idx = ((ep % this.buckets) + this.buckets) % this.buckets
      out[b] = ep >= 0 && this.epoch[idx] === ep && this.counts[idx] > 0 ? this.sums[idx] / this.counts[idx] : NaN
    }
    return out
  }

  /** Mean over the whole window, NaN if it is empty. */
  mean(tick: number): number {
    const newest = Math.floor(tick / this.bucketTicks)
    let sum = 0
    let n = 0
    for (let b = 0; b < this.buckets; b++) {
      const ep = newest - b
      if (ep < 0) break
      const idx = ((ep % this.buckets) + this.buckets) % this.buckets
      if (this.epoch[idx] !== ep) continue
      sum += this.sums[idx]
      n += this.counts[idx]
    }
    return n === 0 ? NaN : sum / n
  }
}
