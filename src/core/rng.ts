/** Seeded PRNG (mulberry32) with Gaussian sampling. The only source of randomness in core. */
export class Rng {
  private s: number
  private spare: number | null = null

  constructor(seed: number) {
    this.s = seed | 0
  }

  /** Captures the generator's position so a snapshot can resume the same stream. */
  state(): [number, number | null] {
    return [this.s, this.spare]
  }

  setState([s, spare]: [number, number | null]): void {
    this.s = s | 0
    this.spare = spare
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }

  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  gauss(): number {
    if (this.spare !== null) {
      const g = this.spare
      this.spare = null
      return g
    }
    const u = Math.max(this.next(), 1e-12)
    const r = Math.sqrt(-2 * Math.log(u))
    const a = 2 * Math.PI * this.next()
    this.spare = r * Math.sin(a)
    return r * Math.cos(a)
  }
}
