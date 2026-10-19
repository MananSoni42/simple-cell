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
    /** Mean limbs per member, for a size-matched travel baseline. */
    meanLimbs: number
    /** Members' command agreement above chance, in [0,1]: the travel rung's physical counterfactual. */
    align: number
    /** How many members contributed to `align`. */
    alignN: number
    /** The same agreement over the nearest non-members, matched on count and place: the control. */
    alignPop: number
    /** The order it has **now** — what a gate asking "is this a structure" must use. */
    order: number
    /** The largest order it ever held, which is what its lifetime score is built on. */
    peak: number
    age: number
    replacements: number
    /**
     * Net distance the centroid has travelled since it formed, torus-unwrapped — accumulated
     * **only across samples where the membership held**, since a centroid jump on a join or a
     * departure is not motion.
     */
    travel: number
    /** Births that happened inside it. */
    births: number
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
 * How well a set of commands agree: `R = |Σv| / Σ|v|`, raw.
 *
 * Raw on purpose, after two attempts to make it size-comparable failed in opposite directions. The
 * physics asks for exactly this quantity — the world is overdamped, so N bodies moving
 * independently each go at `|Fi| / g` while bonded into one structure of N times the drag they go
 * at `|Σ Fi| / (N g)`, and the ratio of the two is R. What R is not is comparable across group
 * sizes: its chance level is about `1 / sqrt(N)` and its ceiling is 1.
 *
 * - **Rescaling to the span between chance and 1** left a large positive bias at small N, because R
 *   fluctuates upward as often as down and the rescale clamps at zero. Unaided worlds tripped the
 *   null **8 times in 30**, structures reading 0.70 to 0.97 at n = 5 against populations at 0.25.
 * - **Standardising against a Monte-Carlo null per N** fixed that and broke it the other way: a
 *   z-score grows with `sqrt(N)`, so dividing a six-member structure's z by a forty-member
 *   population's z is biased *against* the structure. A synthetically well-coordinated structure
 *   read **0.39**, below the threshold, and the null then "passed" only because the rung had become
 *   nearly unpassable.
 *
 * So nothing is corrected here. The rung compares R against R over **the same number of non-member
 * organisms**, which holds N fixed by construction and needs no model of the null at all. See
 * `rivalAgreement`.
 */
export function agreement(sx: number, sy: number, mag: number, n: number): number {
  if (n < 2 || mag < 1e-9) return 0
  return Math.hypot(sx, sy) / mag
}

/**
 * The same agreement over **as many non-member organisms as the structure has members**.
 *
 * This is the rung's control, and holding the group size fixed is the whole point: R depends
 * sharply on how many commands go into it, so any comparison between a five-member structure and a
 * forty-member population is measuring size as much as coordination. Both sides here are computed
 * on exactly `n` commands.
 *
 * It must also be matched on **where they are**, and that is the part two earlier versions missed.
 * A structure's members are bonded, so they sit on top of each other; they read nearly the same food
 * gradient and therefore issue nearly the same command, for a reason that has nothing to do with
 * each other. A control drawn from anywhere in the world is spread out and agrees less, so the
 * ratio measures co-location. Measured: a world-wide average left 1 false positive in 30 unaided
 * worlds, and a size-matched but randomly-placed control was **worse at 9 in 30, worst 2.43** —
 * correcting size exposed the location confound it had been masking.
 *
 * So the comparison group is the `n` non-members **nearest the structure's own centroid**: the same
 * number of organisms, in the same part of the world, reading the same gradient. What remains is
 * whether being *bonded* makes them agree more than merely being *neighbours* does, which is the
 * question the rung is asking.
 */
export function rivalAgreement(w: World, members: Set<number>): number {
  const n = members.size
  if (n < 2) return 0
  // the structure's centroid, wrapped — a plain mean puts two members either side of the seam in
  // the middle of the empty half
  let cx = 0
  let sxs = 0
  let cy = 0
  let sys = 0
  let m = 0
  for (const b of members) {
    if (!w.alive[b] || !w.isBrain(b)) continue
    const ax = (2 * Math.PI * w.x[b]) / w.L.SIZE
    const ay = (2 * Math.PI * w.y[b]) / w.L.SIZE
    cx += Math.cos(ax)
    sxs += Math.sin(ax)
    cy += Math.cos(ay)
    sys += Math.sin(ay)
    m++
  }
  if (m < 2) return 0
  const back = (c: number, si: number): number => {
    const a = Math.atan2(si / m, c / m)
    return ((a < 0 ? a + 2 * Math.PI : a) * w.L.SIZE) / (2 * Math.PI)
  }
  const gx = back(cx, sxs)
  const gy = back(cy, sys)
  const half = w.L.SIZE / 2
  const wrap = (d: number): number => (d > half ? d - w.L.SIZE : d < -half ? d + w.L.SIZE : d)

  const near: { b: number; d: number }[] = []
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.alive[b] || !w.isBrain(b) || members.has(b)) continue
    near.push({ b, d: Math.hypot(wrap(w.x[b] - gx), wrap(w.y[b] - gy)) })
  }
  if (near.length < n) return 0
  near.sort((p, q) => p.d - q.d)
  let sx = 0
  let sy = 0
  let mag = 0
  for (let k = 0; k < n; k++) {
    const b = near[k].b
    sx += w.mvx[b]
    sy += w.mvy[b]
    mag += Math.hypot(w.mvx[b], w.mvy[b])
  }
  return agreement(sx, sy, mag, n)
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
  /**
   * Where it has been. The centroid is unwrapped sample to sample on the torus, so `ux, uy` is a
   * true position in the plane and net displacement means what it says — a path length would
   * accumulate pure diffusion and claim every clump "moves".
   */
  ux: number
  uy: number
  /** Unwrapped centroid at founding, for net displacement. */
  ox: number
  oy: number
  /** Raw (wrapped) centroid at the last sample, needed to unwrap the next one. */
  cx: number
  cy: number
  /** Births that happened inside: a child whose parent was a member, seen among the members. */
  births: number
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

  /**
   * The brains that are currently part of a multi-organism structure.
   *
   * Exposed because `soloBaseline` needs exactly this and had been approximating it with "holds any
   * bond at all", which stopped meaning the same thing. Once bodies assemble themselves out of
   * loose matter, a brain in a matter-rich region almost always holds *some* bond, so that test
   * excluded nearly every working organism and left a baseline made of brains sitting in empty
   * space — slow, often limbless, and not what "alone" is supposed to mean. Measured: `Moves
   * together` read 3.81x against that baseline in an unaided world, tripping a null that is meant
   * to be untrippable.
   *
   * This is the rung's own definition instead: joined to another organism, by the same union over
   * limb-to-limb bonds that decides a structure's order.
   */
  compoundMembers(w: World): Set<number> {
    const out = new Set<number>()
    for (const members of this.currentGroups(w)) {
      if (members.length > 1) for (const b of members) out.add(b)
    }
    return out
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
    const S = w.init.size
    const minImage = (d: number): number => ((d % S) + S * 1.5) % S - S / 2
    /**
     * Centroid on the torus, anchored to one member so a group straddling the seam stays whole.
     *
     * The anchor is read once. The first version spread `[...members][0]` inside the loop, which
     * allocated a fresh array of every member on every iteration — quadratic in group size, and
     * groups here reach forty.
     */
    const centroid = (members: Set<number>): [number, number] => {
      let anchor = -1
      for (const b of members) {
        anchor = b
        break
      }
      if (anchor < 0) return [0, 0]
      let sx = 0
      let sy = 0
      let n = 0
      for (const b of members) {
        sx += minImage(w.x[b] - w.x[anchor])
        sy += minImage(w.y[b] - w.y[anchor])
        n++
      }
      return [(((w.x[anchor] + sx / n) % S) + S) % S, (((w.y[anchor] + sy / n) % S) + S) % S]
    }
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
      const [cx, cy] = centroid(members)
      if (best < 0) {
        next.push({ members, since: w.tick, replacements: 0, peak: members.size, ux: cx, uy: cy, ox: cx, oy: cy, cx, cy, births: 0 })
        continue
      }
      const st = this.structures[best]
      taken.add(best)
      let changed = 0
      let births = st.births
      for (const m of members) {
        if (!st.members.has(m)) {
          changed++
          // a newcomer that is this structure's own newborn: its parent is a member and it was
          // born since the last sample. That is a birth *inside*, the thing rung 12 asks for.
          const p = w.parent[m]
          if (p >= 0 && (st.members.has(p) || members.has(p)) && w.tick - w.bornAt[m] <= 2 * this.sampleEvery) births++
        }
      }
      for (const m of st.members) if (!members.has(m)) changed++
      next.push({
        members,
        since: st.since,
        replacements: st.replacements + changed,
        peak: Math.max(st.peak, members.size),
        /*
         * Unwrap the centroid — but **only when the membership did not change**.
         *
         * The centroid jumps when members join or leave, and that jump is not motion. Measured on a
         * bonding world with `d_max = 5` and a 10-tick sample, so a physical ceiling of 50 units:
         * the largest single step was **394 units**, 8× the ceiling, and 1,620 of 1,668
         * membership-change samples moved more than 2 units. Decomposed, one structure's reported
         * travel of 64.6 (1.32× solo, enough to pass the rung) was 6.5 (0.13× solo) once
         * membership-change steps were excluded — a factor of ten. The rung was measuring churn,
         * and churn is highest in exactly the crowded clumps that are least coherent.
         */
        ux: changed === 0 ? st.ux + minImage(cx - st.cx) : st.ux,
        uy: changed === 0 ? st.uy + minImage(cy - st.cy) : st.uy,
        ox: st.ox,
        oy: st.oy,
        cx,
        cy,
        births,
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
        out.oldest = {
          /*
           * The order it **has**, not the largest it ever held.
           *
           * `peak` is a high-water mark, and both collective rungs gate on `order >= 3`. Measured:
           * a structure of **two** members was reported as order 39, and one seed passed `Moves
           * together` entirely because of it — swapping `peak` for the current size took that seed
           * from 3.871 (met) to 0.000. The readout lied too: "19° for 0.45 coasts" for a group of 9.
           *
           * `peak` is still the right thing for the *score* below, which is about what a structure
           * achieved over its life; it is the wrong thing for a gate asking what exists now.
           */
          order: st.members.size,
          peak: st.peak,
          /*
           * Mean limbs per member, carried so the travel rung can match its baseline on body size.
           * Computed here because this is where the membership is known; the ladder only ever sees
           * this summary.
           */
          meanLimbs: (() => {
            let sum = 0
            let n = 0
            for (const m of st.members) {
              if (!w.alive[m] || !w.isBrain(m)) continue
              sum += w.limbCount(m)
              n++
            }
            return n > 0 ? sum / n : 0
          })(),
          /*
           * The median speed its own members had **before they joined** — the rung's null, taken
           * from the same organisms rather than from a different set of them. Median because one
           * member that happened to get a clear run across the world should not set the bar.
           */
          /*
           * **Alignment of the members' commanded forces** — the counterfactual computed from the
           * physics rather than measured on a different set of organisms.
           *
           * This world is overdamped, so velocity is force over drag. N bodies moving independently
           * each go at `|F_i| / g`; bonded into one structure of N times the drag they go at
           * `|sum F_i| / (N g)`. The ratio of what the structure achieves to what its members would
           * achieve alone is therefore exactly `|sum F_i| / sum |F_i|` — the alignment of their
           * commands. No population baseline appears anywhere in it.
           *
           * Which matters because every population baseline tried here failed, and the last one
           * failed for a reason that cannot be patched: a within-organism null needs a solitary
           * phase to measure, and in a world that bonds readily there isn't one. Measured in the
           * world built to pass this rung: **median join age 19 ticks, 93% joining before age 100,
           * and zero of 60 organisms with a usable pre-join baseline.**
           *
           * Bounded in [0, 1] by construction, with a null that is known rather than estimated:
           * random commands align at `1 / sqrt(N)`. The rung divides by that, so passing means
           * pulling together better than chance — which is what "moves together" says.
           */
          align: (() => {
            let sx = 0
            let sy = 0
            let mag = 0
            let n = 0
            for (const m of st.members) {
              if (!w.alive[m] || !w.isBrain(m)) continue
              const vx = w.mvx[m]
              const vy = w.mvy[m]
              sx += vx
              sy += vy
              mag += Math.hypot(vx, vy)
              n++
            }
            return agreement(sx, sy, mag, n)
          })(),
          alignN: (() => {
            let n = 0
            for (const m of st.members) if (w.alive[m] && w.isBrain(m)) n++
            return n
          })(),
          /*
           * The same statistic over the **whole population**, as the control for shared
           * environment — the confound that made the raw alignment trip the null at 1.38 in a world
           * where nothing was coordinating anything.
           *
           * Members of a structure sit in one neighbourhood and read one food gradient, so their
           * commands point the same way for a reason that has nothing to do with each other. Every
           * organism in the world reading its own local gradient produces the same effect at
           * population scale, so dividing one normalised alignment by the other cancels it: both
           * are 1.0 under chance, both rise together when there is a common current, and the ratio
           * exceeds 1 only if the structure's members agree *more than the world does*.
           */
          alignPop: rivalAgreement(w, st.members),
          age,
          replacements: st.replacements,
          heldFrac,
          score,
          travel: Math.hypot(st.ux - st.ox, st.uy - st.oy),
          births: st.births,
        }
      }
    }
    return out
  }
}
