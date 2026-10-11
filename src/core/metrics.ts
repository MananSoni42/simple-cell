import { type Summary, summarize } from './lifestats'
import { pairPotential } from './forces'
import { BRAIN, FOOD, MATRIX_INDEX, N_MATRIX } from './types'
import type { World } from './world'

export interface Counts {
  free: number
  bound: number
  organisms: number
  food: number
  energy: number
}

export function counts(w: World): Counts {
  let free = 0
  let bound = 0
  let organisms = 0
  for (let i = 0; i < w.nMatter; i++) {
    if (!w.alive[i]) continue
    if (w.type[i] === BRAIN) {
      if (w.isBrain(i)) organisms++
      else free++
    } else if (w.owner[i] >= 0) bound++
    else free++
  }
  return { free, bound, organisms, food: w.nFood, energy: w.totalEnergy() }
}

/** Number of particles of each type among matter (not food). Must never change. */
export function massByType(w: World): number[] {
  const m = [0, 0, 0, 0, 0]
  for (let i = 0; i < w.nMatter; i++) if (w.alive[i]) m[w.type[i]]++
  return m
}

/** Total pair potential, O(n^2). For small test worlds only; skips own brain-limb pairs. */
export function potentialEnergy(w: World): number {
  const { L } = w
  let U = 0
  for (let i = 0; i < w.cap; i++) {
    if (!w.alive[i]) continue
    for (let j = i + 1; j < w.cap; j++) {
      if (!w.alive[j]) continue
      if (w.owner[i] >= 0 && w.owner[i] === w.owner[j] && (w.type[i] === BRAIN || w.type[j] === BRAIN)) continue
      const dx = w.x[j] - w.x[i]
      const dy = w.y[j] - w.y[i]
      const r = Math.hypot(dx - L.SIZE * Math.round(dx / L.SIZE), dy - L.SIZE * Math.round(dy / L.SIZE))
      const mi = MATRIX_INDEX[w.type[i]]
      const mj = MATRIX_INDEX[w.type[j]]
      const a = mi >= 0 && mj >= 0 ? w.A[mi * N_MATRIX + mj] : 0
      U += pairPotential(r, a, L)
    }
  }
  return U
}

export interface ClusterStats {
  mean: number
  max: number
  count: number
}

/**
 * Connected components of matter (not food). Two particles are linked when they touch
 * (r < 2.5 r_0), and a brain is always linked to its own limbs through the rods.
 */
export function clusterStats(w: World): ClusterStats {
  const { L } = w
  w.grid.build()
  const parent = new Int32Array(w.nMatter).map((_, i) => i)
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]]
    return a
  }
  const link2 = (2.5 * L.beta * L.r_c) ** 2
  for (let i = 0; i < w.nMatter; i++) {
    if (!w.alive[i]) continue
    if (w.owner[i] >= 0 && w.owner[i] !== i) parent[find(i)] = find(w.owner[i])
    const n = w.grid.near(w.x[i], w.y[i])
    for (let k = 0; k < n; k++) {
      const j = w.grid.buf[k]
      if (j <= i || j >= w.nMatter) continue
      const dx = w.x[j] - w.x[i]
      const dy = w.y[j] - w.y[i]
      const ddx = dx - L.SIZE * Math.round(dx / L.SIZE)
      const ddy = dy - L.SIZE * Math.round(dy / L.SIZE)
      if (ddx * ddx + ddy * ddy < link2) parent[find(i)] = find(j)
    }
  }
  const size = new Int32Array(w.nMatter)
  let nAlive = 0
  for (let i = 0; i < w.nMatter; i++) {
    if (!w.alive[i]) continue
    size[find(i)]++
    nAlive++
  }
  let count = 0
  let max = 0
  for (let i = 0; i < w.nMatter; i++) {
    if (size[i] > 0) count++
    if (size[i] > max) max = size[i]
  }
  return { mean: count ? nAlive / count : 0, max, count }
}

export function meanClusterSize(w: World): number {
  return clusterStats(w).mean
}

export interface Census {
  organisms: number
  limbs: number
  freeMatter: number
  food: number
  eOrganisms: number
  eFree: number
  eFood: number
  oldest: number
  maxGen: number
  /** Lineages with at least one organism alive. */
  lineages: number
  /** Organisms in the largest surviving lineage. */
  biggestLineage: number
  children: number // children currently-alive organisms have produced
  maxChildren: number
}

export function census(w: World): Census {
  const c: Census = { organisms: 0, limbs: 0, freeMatter: 0, food: w.nFood, eOrganisms: 0, eFree: 0, eFood: 0, oldest: 0, maxGen: 0, lineages: 0, biggestLineage: 0, children: 0, maxChildren: 0 }
  const perLineage = new Map<number, number>()
  for (let i = 0; i < w.cap; i++) {
    if (!w.alive[i]) continue
    if (w.type[i] === FOOD) c.eFood += w.energy[i]
    else if (w.owner[i] >= 0) {
      c.eOrganisms += w.energy[i]
      if (w.owner[i] === i) {
        c.organisms++
        c.oldest = Math.max(c.oldest, w.tick - w.bornAt[i])
        c.maxGen = Math.max(c.maxGen, w.gen[i])
        c.children += w.children[i]
        c.maxChildren = Math.max(c.maxChildren, w.children[i])
        perLineage.set(w.lineage[i], (perLineage.get(w.lineage[i]) ?? 0) + 1)
      } else c.limbs++
    } else {
      c.eFree += w.energy[i]
      c.freeMatter++
    }
  }
  c.lineages = perLineage.size
  for (const n of perLineage.values()) c.biggestLineage = Math.max(c.biggestLineage, n)
  return c
}

/** Cheap fingerprint of the full dynamic state, for determinism tests. */
export function stateHash(w: World): number {
  let h = 2166136261
  for (let i = 0; i < w.cap; i++) {
    if (!w.alive[i] || w.type[i] === FOOD) {
      h = Math.imul(h ^ (w.alive[i] + 7), 16777619)
      if (!w.alive[i]) continue
    }
    h = Math.imul(h ^ Math.round(w.x[i] * 1e6), 16777619)
    h = Math.imul(h ^ Math.round(w.y[i] * 1e6), 16777619)
    h = Math.imul(h ^ Math.round(w.energy[i] * 1e6), 16777619)
  }
  return h >>> 0
}

export interface LifeStats {
  particlesNow: Summary // ages of matter that is live now (alive with energy > 0)
  particlesDied: Summary // completed lifespans: from becoming live to running dry or being removed
  organismsNow: Summary
  organismsDied: Summary
  /** Mean completed lifespan per bucket over the trailing window, oldest to newest. */
  particlesTrend: Float64Array
  organismsTrend: Float64Array
  windowTicks: number
  windowMeanParticles: number
  windowMeanOrganisms: number
}

export function lifeStats(w: World): LifeStats {
  const pa = new Float64Array(w.nMatter)
  let np = 0
  const oa = new Float64Array(w.nMatter - w.nIntr)
  let no = 0
  for (let i = 0; i < w.nMatter; i++) {
    if (!w.alive[i] || w.energy[i] <= 1e-12) continue
    pa[np++] = w.tick - w.since[i]
    if (i >= w.nIntr && w.isBrain(i)) oa[no++] = w.tick - w.bornAt[i]
  }
  return {
    particlesNow: summarize(pa, np),
    particlesDied: w.lifeParticles.summary(),
    organismsNow: summarize(oa, no),
    organismsDied: w.lifeOrganisms.summary(),
    particlesTrend: w.lifeParticlesWindow.series(w.tick),
    organismsTrend: w.lifeOrganismsWindow.series(w.tick),
    windowTicks: w.lifeParticlesWindow.windowTicks,
    windowMeanParticles: w.lifeParticlesWindow.mean(w.tick),
    windowMeanOrganisms: w.lifeOrganismsWindow.mean(w.tick),
  }
}
