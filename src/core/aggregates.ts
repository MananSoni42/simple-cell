import type { World } from './world'

/**
 * Organism-level connectivity. Two organisms are *in contact* when any of their limbs touch,
 * and a **bond** is a contact that has persisted: we sample contacts every `sampleEvery` ticks
 * and remember when each pair first appeared. An aggregate is then a connected group of
 * organisms, and a *stable* aggregate uses only bonds older than `stableTicks` — which turns
 * "always connected" into a number we can tune rather than a word we have to argue about.
 */
export interface AggregateStats {
  /** Groups of 2+ organisms in contact right now. */
  groups: number
  largest: number // sub-organisms in the biggest group
  meanSize: number // ... averaged over groups of 2+
  inGroups: number // organisms that are part of some group
  /** The same, counting only bonds older than stableTicks. */
  stableGroups: number
  stableLargest: number
  bonds: number
  stableBonds: number
  oldestBond: number // ticks
}

export const EMPTY_AGGREGATES: AggregateStats = {
  groups: 0,
  largest: 0,
  meanSize: 0,
  inGroups: 0,
  stableGroups: 0,
  stableLargest: 0,
  bonds: 0,
  stableBonds: 0,
  oldestBond: 0,
}

export class AggregateTracker {
  /** (brainA * cap + brainB) -> tick the contact was first seen. */
  private since = new Map<number, number>()
  private lastSample = -1

  constructor(
    readonly sampleEvery = 10,
    readonly stableTicks = 300,
  ) {}

  reset(): void {
    this.since.clear()
    this.lastSample = -1
  }

  /** Call every tick; samples on its own schedule. */
  observe(w: World): void {
    if (w.tick - this.lastSample < this.sampleEvery && this.lastSample >= 0) return
    this.lastSample = w.tick
    const seen = this.contacts(w)
    for (const key of seen) if (!this.since.has(key)) this.since.set(key, w.tick)
    for (const key of this.since.keys()) if (!seen.has(key)) this.since.delete(key)
  }

  /** Pairs of organisms whose limbs are touching, as packed keys. */
  private contacts(w: World): Set<number> {
    const reach = 2.5 * w.L.beta * w.L.r_c // "touching": within a couple of core radii
    const reach2 = reach * reach
    const out = new Set<number>()
    const S = w.L.SIZE
    for (let i = 0; i < w.nIntr; i++) {
      const oi = w.owner[i]
      if (!w.alive[i] || oi < 0) continue
      const n = w.grid.near(w.x[i], w.y[i])
      for (let k = 0; k < n; k++) {
        const j = w.grid.buf[k]
        if (j >= w.nIntr || j <= i) continue
        const oj = w.owner[j]
        if (oj < 0 || oj === oi || !w.alive[j]) continue
        let dx = w.x[j] - w.x[i]
        let dy = w.y[j] - w.y[i]
        dx -= S * Math.round(dx / S)
        dy -= S * Math.round(dy / S)
        if (dx * dx + dy * dy > reach2) continue
        const a = Math.min(oi, oj)
        const b = Math.max(oi, oj)
        out.add(a * w.cap + b)
      }
    }
    return out
  }

  stats(w: World): AggregateStats {
    const s = { ...EMPTY_AGGREGATES }
    if (this.since.size === 0) return s
    const parent = new Map<number, number>()
    const find = (a: number): number => {
      let r = a
      while ((parent.get(r) ?? r) !== r) r = parent.get(r)!
      let c = a
      while ((parent.get(c) ?? c) !== c) {
        const next = parent.get(c)!
        parent.set(c, r)
        c = next
      }
      return r
    }
    const union = (a: number, b: number) => parent.set(find(a), find(b))
    const stableParent = new Map<number, number>()
    const sfind = (a: number): number => {
      let r = a
      while ((stableParent.get(r) ?? r) !== r) r = stableParent.get(r)!
      return r
    }

    for (const [key, since] of this.since) {
      const a = Math.floor(key / w.cap)
      const b = key % w.cap
      if (!w.isBrain(a) || !w.isBrain(b) || !w.alive[a] || !w.alive[b]) continue
      s.bonds++
      s.oldestBond = Math.max(s.oldestBond, w.tick - since)
      union(a, b)
      if (w.tick - since >= this.stableTicks) {
        s.stableBonds++
        stableParent.set(sfind(a), sfind(b))
      }
    }

    const tally = (roots: (x: number) => number, keys: Iterable<number>) => {
      const size = new Map<number, number>()
      const members = new Set<number>()
      for (const k of keys) members.add(k)
      for (const m of members) size.set(roots(m), (size.get(roots(m)) ?? 0) + 1)
      return size
    }
    const members: number[] = []
    for (const key of this.since.keys()) {
      const a = Math.floor(key / w.cap)
      const b = key % w.cap
      if (!w.isBrain(a) || !w.isBrain(b) || !w.alive[a] || !w.alive[b]) continue
      members.push(a, b)
    }
    const sizes = tally(find, members)
    let total = 0
    for (const n of sizes.values()) {
      if (n < 2) continue
      s.groups++
      total += n
      s.largest = Math.max(s.largest, n)
    }
    s.inGroups = total
    s.meanSize = s.groups > 0 ? total / s.groups : 0

    const stableMembers: number[] = []
    for (const [key, since] of this.since) {
      if (w.tick - since < this.stableTicks) continue
      const a = Math.floor(key / w.cap)
      const b = key % w.cap
      if (!w.isBrain(a) || !w.isBrain(b) || !w.alive[a] || !w.alive[b]) continue
      stableMembers.push(a, b)
    }
    for (const n of tally(sfind, stableMembers).values()) {
      if (n < 2) continue
      s.stableGroups++
      s.stableLargest = Math.max(s.stableLargest, n)
    }
    return s
  }
}
