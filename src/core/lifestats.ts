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
