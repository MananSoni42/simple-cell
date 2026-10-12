import type { World } from './world'

/**
 * How many compound organisms of each order are holding together, and for how long.
 *
 *   order 1 = a single organism
 *   order 2 = two organisms bonded into one object
 *   order n = n of them
 *
 * An object only *counts* at order n if it has held for at least `holdFrac` of the trailing
 * window — which is the whole point: anything can touch for a moment, and the question is what
 * stays. Groups are found through **bonds** (R16), not proximity, so a group is a real object
 * rather than a coincidence of position.
 */
export interface OrderStats {
  /** Index n-1 holds the count of order-n objects currently assembled. */
  live: number[]
  /** ... and those that have held for holdFrac of the window. */
  surviving: number[]
  /** Highest order ever seen to survive, and when. */
  bestOrder: number
  bestAge: number
  windowTicks: number
  holdFrac: number
}

export const MAX_ORDER = 8

export function emptyOrders(windowTicks: number, holdFrac: number): OrderStats {
  return {
    live: new Array(MAX_ORDER).fill(0),
    surviving: new Array(MAX_ORDER).fill(0),
    bestOrder: 0,
    bestAge: 0,
    windowTicks,
    holdFrac,
  }
}

interface Group {
  /** Sorted brain indices, as a key. */
  key: string
  size: number
  since: number
}

export class OrderTracker {
  private groups = new Map<string, Group>()
  private lastSample = -1
  bestOrder = 0
  bestAge = 0

  constructor(
    // 2000 ticks rather than 10000: with random brains the longest-lived compound measured is
    // ~430 ticks, because organisms wander off and tear their own bonds apart. A window that
    // nothing can ever clear tells you nothing.
    readonly windowTicks = 2000,
    readonly holdFrac = 0.25,
    readonly sampleEvery = 10,
  ) {}

  reset(): void {
    this.groups.clear()
    this.lastSample = -1
    this.bestOrder = 0
    this.bestAge = 0
  }

  /** Connected groups of organisms, joined where a bond links two of their particles. */
  groupsNow(w: World): number[][] {
    return this.currentGroups(w)
  }

  private currentGroups(w: World): number[][] {
    const parent = new Map<number, number>()
    const find = (a: number): number => {
      let r = a
      while ((parent.get(r) ?? r) !== r) r = parent.get(r)!
      return r
    }
    const union = (a: number, b: number) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) parent.set(b, b)

    const bonds = w.bonds
    for (let i = 0; i < w.nIntr; i++) {
      if (!w.alive[i] || w.owner[i] < 0) continue
      for (let k = 0; k < bonds.max; k++) {
        const j = bonds.partner[i * bonds.max + k]
        if (j <= i || j >= w.nIntr || !w.alive[j] || w.owner[j] < 0) continue
        if (w.owner[i] !== w.owner[j]) union(w.owner[i], w.owner[j])
      }
    }
    const byRoot = new Map<number, number[]>()
    for (const b of parent.keys()) {
      const r = find(b)
      const list = byRoot.get(r)
      if (list) list.push(b)
      else byRoot.set(r, [b])
    }
    return [...byRoot.values()]
  }

  observe(w: World): void {
    if (this.lastSample >= 0 && w.tick - this.lastSample < this.sampleEvery) return
    this.lastSample = w.tick
    const seen = new Set<string>()
    for (const members of this.currentGroups(w)) {
      const key = members.sort((a, b) => a - b).join(',')
      seen.add(key)
      const existing = this.groups.get(key)
      if (existing) {
        const age = w.tick - existing.since
        if (members.length > 1 && (members.length > this.bestOrder || (members.length === this.bestOrder && age > this.bestAge))) {
          this.bestOrder = members.length
          this.bestAge = age
        }
      } else this.groups.set(key, { key, size: members.length, since: w.tick })
    }
    // a group that is no longer assembled stops existing; re-forming starts its clock again
    for (const key of this.groups.keys()) if (!seen.has(key)) this.groups.delete(key)
  }

  stats(w: World): OrderStats {
    const out = emptyOrders(this.windowTicks, this.holdFrac)
    const need = this.windowTicks * this.holdFrac
    for (const g of this.groups.values()) {
      const n = Math.min(MAX_ORDER, g.size)
      out.live[n - 1]++
      if (w.tick - g.since >= need) out.surviving[n - 1]++
    }
    out.bestOrder = this.bestOrder
    out.bestAge = this.bestAge
    return out
  }
}
