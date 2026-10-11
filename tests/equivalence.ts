import { census, clusterStats } from '../src/core/metrics'
import { initFromSeed, type Init } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * Statistical fingerprint of a world: means and standard deviations, over many seeds, of a
 * few end-of-run measurements. Used to show that a change which reshuffles random numbers or
 * floating-point order (so it cannot be bit-exact) still produces the same kind of world.
 */
export interface EquivConfig {
  name: string
  seeds: number
  scale: number
  ticks: number
  over: Partial<Init>
}

export const EQUIV: EquivConfig[] = [
  { name: 'default', seeds: 40, scale: 1, ticks: 1200, over: {} },
  { name: 'drift-inflow', seeds: 40, scale: 1, ticks: 1200, over: { foodMoves: true, inflow: true } },
]

export const METRICS = ['organisms', 'births', 'budded', 'deaths', 'energy', 'freeMatter', 'food', 'maxCluster'] as const
export type Metric = (typeof METRICS)[number]
export type Stat = { mean: number; std: number; n: number }

export function sample(c: EquivConfig, seed: number): Record<Metric, number> {
  const w = new World({ ...initFromSeed(seed, c.scale), ...c.over })
  for (let t = 0; t < c.ticks; t++) w.step()
  const k = census(w)
  return {
    organisms: k.organisms,
    births: w.nBirths,
    budded: w.nBudded,
    deaths: w.nDeaths,
    energy: w.totalEnergy(),
    freeMatter: k.freeMatter,
    food: k.food,
    maxCluster: clusterStats(w).max,
  }
}

export function measure(c: EquivConfig): Record<Metric, Stat> {
  const rows = Array.from({ length: c.seeds }, (_, s) => sample(c, s + 100))
  const out = {} as Record<Metric, Stat>
  for (const m of METRICS) {
    const v = rows.map((r) => r[m])
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    const std = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1))
    out[m] = { mean, std, n: v.length }
  }
  return out
}
