import type { Perf } from '../compute/select'
import { type Init, type FoodMode, FOOD_MODES, clamp11, initFromSeed } from '../core/params'
import { N_MATRIX } from '../core/types'

export const CONFIG_VERSION = 1

/** A shareable world: the seed plus every edit made to it on the start screen. */
export interface ConfigFile {
  version: number
  init: Init
  perf?: Perf
}

export function toConfig(init: Init, perf: Perf): ConfigFile {
  return { version: CONFIG_VERSION, init, perf }
}

export function configText(init: Init, perf: Perf): string {
  return JSON.stringify(toConfig(init, perf), null, 2)
}

const num = (v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/**
 * Rebuilds an Init from untrusted JSON. Anything missing or out of range falls back to what the
 * seed would have produced, so an old or hand-edited file still loads.
 */
export function parseConfig(text: string): { init: Init; perf?: Perf } {
  const raw = JSON.parse(text) as Partial<ConfigFile> & Record<string, unknown>
  const src = (raw.init ?? raw) as Partial<Init> & Record<string, unknown>
  const seed = num(src.seed, 1)
  const scale = num(src.scale, 1, 1, 64)
  const base = initFromSeed(Math.floor(seed), Math.round(scale))

  const A = base.A.map((row) => row.slice())
  if (Array.isArray(src.A)) {
    for (let i = 0; i < N_MATRIX; i++) {
      for (let j = 0; j < N_MATRIX; j++) {
        const v = (src.A as number[][])?.[i]?.[j]
        if (typeof v === 'number' && Number.isFinite(v)) A[i][j] = clamp11(v)
      }
    }
    for (let i = 0; i < N_MATRIX; i++) for (let j = i + 1; j < N_MATRIX; j++) A[j][i] = A[i][j] // enforce symmetry
    A[N_MATRIX - 1][N_MATRIX - 1] = 0
  }

  const mode = typeof src.foodMode === 'string' && FOOD_MODES.includes(src.foodMode as FoodMode) ? (src.foodMode as FoodMode) : base.foodMode
  const init: Init = {
    ...base,
    A,
    quantized: bool(src.quantized, base.quantized),
    T: num(src.T, base.T, 0, 1e4),
    n_intrinsic: Math.round(num(src.n_intrinsic, base.n_intrinsic, 1, 2e6)),
    n_brain: Math.round(num(src.n_brain, base.n_brain, 1, 2e5)),
    n_start: Math.round(num(src.n_start, base.n_start, 0, 2e5)),
    n_food0: Math.round(num(src.n_food0, base.n_food0, 0, 2e6)),
    max_food: Math.round(num(src.max_food, base.max_food, 0, 2e6)),
    food_batch: Math.round(num(src.food_batch, base.food_batch, 0, 1e5)),
    spawn_batch: Math.round(num(src.spawn_batch, base.spawn_batch, 0, 1e5)),
    foodMoves: bool(src.foodMoves, base.foodMoves),
    repro: bool(src.repro, base.repro),
    repro_mut: num(src.repro_mut, base.repro_mut, 0, 5),
    decay_free: num(src.decay_free, base.decay_free, 0, 1),
    inflow: bool(src.inflow, base.inflow),
    foodMode: mode,
    T_food: Math.max(1, Math.round(num(src.T_food, base.T_food, 1, 1e6))),
    T_spawn: Math.max(1, Math.round(num(src.T_spawn, base.T_spawn, 1, 1e6))),
    n_patch: Math.round(num(src.n_patch, base.n_patch, 0, 1e4)),
    r_patch: num(src.r_patch, base.r_patch, 1, 1e5),
    v_patch: num(src.v_patch, base.v_patch, 0, 100),
  }
  init.n_brain = Math.min(init.n_brain, init.n_intrinsic)
  init.n_start = Math.min(init.n_start, init.n_brain)
  init.n_food0 = Math.min(init.n_food0, init.max_food)

  const p = raw.perf as Partial<Perf> | undefined
  const perf = p ? { threads: Math.round(num(p.threads, 1, 1, 256)), gpu: bool(p.gpu, false) } : undefined
  return { init, perf }
}

/** Worlds travel as links: the config lives, compressed to JSON, in the URL hash. */
export function writeHash(init: Init, perf: Perf): void {
  history.replaceState(null, '', '#' + encodeURIComponent(JSON.stringify(toConfig(init, perf))))
}

export function readHash(): { init: Init; perf?: Perf } | null {
  const h = location.hash.slice(1)
  if (!h) return null
  try {
    return parseConfig(decodeURIComponent(h))
  } catch {
    return null
  }
}

export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
