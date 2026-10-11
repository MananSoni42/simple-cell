import type { Laws } from './params'

/**
 * Bonds between particles, with hysteresis: a bond forms easily when two particles are in
 * contact and their chemistry is attractive, and breaks only under much more tension than it
 * took to make. That gap is the activation energy, and it is what makes a joined pair *stay*
 * joined rather than reshuffling every time the soup jostles it.
 *
 * Stored as a fixed-width table — `partner[i * max + k]` is the k-th partner of particle i, or
 * -1 — so there is nothing to allocate per tick and a snapshot is a straight array copy.
 */
export class Bonds {
  readonly partner: Int32Array
  readonly max: number
  count = 0

  constructor(cap: number, max: number) {
    this.max = max
    this.partner = new Int32Array(cap * max).fill(-1)
  }

  slots(i: number): number {
    let n = 0
    for (let k = 0; k < this.max; k++) if (this.partner[i * this.max + k] >= 0) n++
    return this.max - n
  }

  has(i: number, j: number): boolean {
    for (let k = 0; k < this.max; k++) if (this.partner[i * this.max + k] === j) return true
    return false
  }

  add(i: number, j: number): boolean {
    let si = -1
    let sj = -1
    for (let k = 0; k < this.max; k++) {
      if (si < 0 && this.partner[i * this.max + k] < 0) si = k
      if (sj < 0 && this.partner[j * this.max + k] < 0) sj = k
    }
    if (si < 0 || sj < 0) return false
    this.partner[i * this.max + si] = j
    this.partner[j * this.max + sj] = i
    this.count++
    return true
  }

  remove(i: number, j: number): void {
    for (let k = 0; k < this.max; k++) {
      if (this.partner[i * this.max + k] === j) this.partner[i * this.max + k] = -1
      if (this.partner[j * this.max + k] === i) this.partner[j * this.max + k] = -1
    }
    this.count--
  }

  /** Drops every bond held by particle i (it died, or was captured as a limb). */
  clear(i: number): void {
    for (let k = 0; k < this.max; k++) {
      const j = this.partner[i * this.max + k]
      if (j >= 0) this.remove(i, j)
    }
  }

  /** Every bond once, as (i, j) with i < j. */
  forEach(fn: (i: number, j: number) => void, cap: number): void {
    for (let i = 0; i < cap; i++) {
      for (let k = 0; k < this.max; k++) {
        const j = this.partner[i * this.max + k]
        if (j > i) fn(i, j)
      }
    }
  }
}

/** Spring force along a bond: positive pulls the pair together. */
export function bondForce(r: number, L: Laws): number {
  return L.k_bond * (r - L.r_bond)
}
