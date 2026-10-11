import { census, stateHash } from '../src/core/metrics'
import { initFromSeed, type Init } from '../src/core/params'
import { World } from '../src/core/world'

/** Fixed worlds whose end state is pinned bit-for-bit, so pure optimizations can prove they change nothing. */
export interface GoldenConfig {
  name: string
  seed: number
  scale: number
  ticks: number
  over: Partial<Init>
}

export const GOLDEN: GoldenConfig[] = [
  { name: 'base-s1', seed: 1, scale: 1, ticks: 1500, over: {} },
  { name: 'drift-s2', seed: 2, scale: 1, ticks: 1500, over: { foodMoves: true } },
  { name: 'inflow-s3', seed: 3, scale: 1, ticks: 1500, over: { inflow: true } },
  { name: 'scale2-s4', seed: 4, scale: 2, ticks: 700, over: {} },
  { name: 'plain-s5', seed: 5, scale: 1, ticks: 1500, over: { repro: false, decay_free: 0 } },
  { name: 'patchy-s7', seed: 7, scale: 1, ticks: 1500, over: { foodMoves: true, inflow: true } },
]

export interface GoldenResult {
  hash: number
  births: number
  budded: number
  deaths: number
  organisms: number
  energy: number
}

export function runGolden(c: GoldenConfig): GoldenResult {
  const w = new World({ ...initFromSeed(c.seed, c.scale), ...c.over })
  for (let t = 0; t < c.ticks; t++) w.step()
  return {
    hash: stateHash(w),
    births: w.nBirths,
    budded: w.nBudded,
    deaths: w.nDeaths,
    organisms: census(w).organisms,
    energy: Math.round(w.totalEnergy() * 1e6) / 1e6,
  }
}
