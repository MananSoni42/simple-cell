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
  /**
   * The longest-lived *structure*, where identity survives a change of membership.
   *
   * Keying a group by its exact member list — which is how `live` and `surviving` above are
   * counted — means a group ceases to exist the moment one member dies or one joins. That is the
   * right measure for "are these particular organisms still together" and the wrong one for the
   * question that actually matters: whether a structure persists *while its parts turn over*. A
   * clump whose members are all original is a clump; one that has replaced half its members and
   * is still there is the first thing in this world worth calling alive.
   */
  oldest: {
    order: number
    age: number
    replacements: number
    /**
     * Its age as a fraction of an organism's life in this world — the number that says whether a
     * structure is a lasting thing or a passing clump. A pair that holds for a whole lifetime
     * reads 1.0; a twenty-strong clump that lasts an instant reads ~0.
     */
    heldFrac: number
    /** `(order - 1) × heldFrac^1.5`: duration weighted above size, per the note on `order_alpha`. */
    score: number
  } | null
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
    oldest: null,
  }
}

interface Group {
  /** Sorted brain indices, as a key. */
  key: string
  size: number
  since: number
}

/**
 * A structure tracked through changes of membership: matched between samples by overlap rather
 * than by identity, so losing or gaining a member does not end its life.
 */
interface Structure {
  members: Set<number>
  since: number
  /** Members that have joined or left since it was first seen. */
  replacements: number
  /** The largest order it has ever held. */
  peak: number
}

export class OrderTracker {
  private groups = new Map<string, Group>()
  private structures: Structure[] = []
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
    this.structures = []
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
    this.trackStructures(w)
  }

  /**
   * The same groups, followed through membership changes.
   *
   * A current group continues a tracked structure when they share **more than half** of the
   * smaller one's members. Half is the natural threshold: it makes the match unique (two
   * structures cannot both share a majority with the same group), so no bookkeeping is needed to
   * resolve ties, and a structure that has turned over gradually keeps its identity while one
   * that has been replaced wholesale correctly counts as new.
   */
  private trackStructures(w: World): void {
    const current = this.currentGroups(w).filter((g) => g.length >= 2).map((g) => new Set(g))
    const taken = new Set<number>()
    const next: Structure[] = []

    for (const members of current) {
      let best = -1
      let bestShare = 0
      for (let k = 0; k < this.structures.length; k++) {
        if (taken.has(k)) continue
        const st = this.structures[k]
        let shared = 0
        for (const m of members) if (st.members.has(m)) shared++
        const share = shared / Math.min(members.size, st.members.size)
        if (share > 0.5 && share > bestShare) {
          bestShare = share
          best = k
        }
      }
      if (best < 0) {
        next.push({ members, since: w.tick, replacements: 0, peak: members.size })
        continue
      }
      const st = this.structures[best]
      taken.add(best)
      let changed = 0
      for (const m of members) if (!st.members.has(m)) changed++
      for (const m of st.members) if (!members.has(m)) changed++
      next.push({
        members,
        since: st.since,
        replacements: st.replacements + changed,
        peak: Math.max(st.peak, members.size),
      })
    }
    this.structures = next
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
    // an organism's life, as the yardstick a structure's duration is measured against
    const life = Math.max(1, w.lifeOrganisms.summary().mean || w.recordAge || 1)
    for (const st of this.structures) {
      const age = w.tick - st.since
      const heldFrac = age / life
      // duration outweighs size: the exponent above 1 is what makes a brief giant score poorly
      const score = Math.max(0, st.peak - 1) * Math.pow(heldFrac, 1.5)
      if (!out.oldest || score > out.oldest.score) {
        out.oldest = { order: st.peak, age, replacements: st.replacements, heldFrac, score }
      }
    }
    return out
  }
}
