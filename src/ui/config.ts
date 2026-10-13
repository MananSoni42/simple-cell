import type { Perf } from '../compute/select'
import {
  applyWallStamp,
  type FoodLevel,
  FOOD_LEVELS,
  type FoodMode,
  FOOD_MODES,
  type FoodRegime,
  FOOD_REGIMES,
  type Init,
  type Laws,
  type SeededOrganism,
  WALL_LAYOUTS,
  type WallLayout,
  clamp11,
  initFromSeed,
} from '../core/params'
import { COMBINERS, FITNESS, type FitnessKey, type FitnessSpec, specFromKeys } from '../core/fitness'
import { LEARNERS, type LearnConfig } from '../core/learning'
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

/** A list of in-world points, with anything malformed dropped rather than crashing a load. */
const points = (v: unknown, size: number): [number, number][] =>
  Array.isArray(v)
    ? (v as unknown[])
        .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))
        .slice(0, 20000)
        .map(([x, y]) => [Math.min(size, Math.max(0, x)), Math.min(size, Math.max(0, y))] as [number, number])
    : []

/**
 * Rebuilds an Init from untrusted JSON. Anything missing or out of range falls back to what the
 * seed would have produced, so an old or hand-edited file still loads.
 */
/**
 * How a world learned is part of the world, so it travels in the config and comes back validated.
 * An unknown algorithm falls back to `none` rather than throwing: a config from a later build
 * should still open, minus the part this build cannot do.
 */
function learnConfig(src: unknown, base: LearnConfig): LearnConfig {
  if (!src || typeof src !== 'object') return { ...base }
  const r = src as Record<string, unknown>
  const algo = LEARNERS.some((l) => l.key === r.algo) ? (r.algo as LearnConfig['algo']) : base.algo
  return {
    algo,
    fitness: fitnessSpec(r.fitness, base.fitness),
    warmup: Math.round(num(r.warmup, base.warmup, 0, 1e8)),
    share: num(r.share, base.share, 0, 1),
    sigma: num(r.sigma, base.sigma, 0, 5),
    batch: Math.round(num(r.batch, base.batch, 2, 4096)),
    pool: Math.round(num(r.pool, base.pool, 2, 4096)),
    tournament: Math.round(num(r.tournament, base.tournament, 1, 64)),
    crossover: num(r.crossover, base.crossover, 0, 1),
    lr: num(r.lr, base.lr, 0, 10),
    maxAge: Math.round(num(r.maxAge, base.maxAge, 1, 1e9)),
    decay: num(r.decay, base.decay, 0, 1),
    explore: num(r.explore, base.explore, 0, 2),
    actorLr: num(r.actorLr, base.actorLr, 0, 1),
    criticLr: num(r.criticLr, base.criticLr, 0, 1),
    gamma: num(r.gamma, base.gamma, 0, 0.9999),
    lambda: num(r.lambda, base.lambda, 0, 0.9999),
    inherit: r.inherit === 'birth' ? 'birth' : base.inherit,
    cells: Math.round(num(r.cells, base.cells, 2, 32)),
  }
}

/**
 * A measure, from whatever shape the file has.
 *
 * Configs written before fitness could be several things carry a bare scalar name, and those must
 * still open: a string becomes a one-measure spec. Anything unrecognised falls back to the
 * default rather than throwing, like every other field here.
 */
function fitnessSpec(src: unknown, base: FitnessSpec): FitnessSpec {
  if (typeof src === 'string') {
    return FITNESS.some((f) => f.key === src) ? specFromKeys([src as FitnessKey], base.combine, base.window) : { ...base }
  }
  if (!src || typeof src !== 'object') return { ...base }
  const r = src as Record<string, unknown>
  const weights = Array.isArray(r.weights)
    ? FITNESS.map((_, i) => num((r.weights as unknown[])[i], 0, 0, 1e3))
    : base.weights.slice()
  const combine = COMBINERS.some((c) => c.key === r.combine) ? (r.combine as FitnessSpec['combine']) : base.combine
  const window = Math.round(num(r.window, base.window, 8, 4096))
  // a spec with nothing selected would score every life identically, so fall back to the default
  return weights.some((w) => w > 0) ? { weights, combine, window } : { ...base }
}

/**
 * The physics a config file is allowed to override, with each dial clamped to a sane range.
 *
 * A whitelist rather than a spread, for the same reason the rest of this parser is: a config file
 * is untrusted input, and `{...src.laws}` would let one set `SIZE` or `fieldN` and desynchronise
 * every array in the world from the grid that indexes it. Only the dials the search varies are
 * accepted, and only within bounds the integrator can survive.
 */
function lawOverrides(src: unknown): Partial<Laws> | undefined {
  if (!src || typeof src !== 'object') return undefined
  const o = src as Record<string, unknown>
  const out: Partial<Laws> = {}
  const take = <K extends keyof Laws>(k: K, lo: number, hi: number, round = false): void => {
    const v = o[k as string]
    if (typeof v !== 'number' || !Number.isFinite(v)) return
    const c = Math.min(hi, Math.max(lo, v))
    out[k] = (round ? Math.round(c) : c) as Laws[K]
  }
  take('mu_food', 0.01, 1)
  take('F_max', 0.1, 16)
  take('k_bond', 0.05, 8)
  take('F_break', 0.2, 32)
  take('max_bonds', 1, 8, true)
  take('r_eat', 1, 40)
  take('E_birth', 1, 100)
  take('E_repro', 5, 400)
  take('E_spore', 1, 200)
  take('spore_food', 0, 50)
  return Object.keys(out).length > 0 ? out : undefined
}

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
    laws: lawOverrides(src.laws),
    quantized: bool(src.quantized, base.quantized),
    substeps: Math.round(num(src.substeps, base.substeps, 1, 64)),
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
    fission: bool(src.fission, base.fission),
    conjugation: bool(src.conjugation, base.conjugation),
    spore: bool(src.spore, base.spore),
    bonds: bool(src.bonds, base.bonds),
    walls: WALL_LAYOUTS.includes(src.walls as WallLayout) ? (src.walls as WallLayout) : base.walls,
    n_wall: Math.round(num(src.n_wall, base.n_wall, 0, 2e5)),
    wallPositions: points(src.wallPositions, base.size),
    seededFood: points(src.seededFood, base.size),
    seededOrganisms: Array.isArray(src.seededOrganisms)
      ? (src.seededOrganisms as SeededOrganism[])
          .slice(0, 500)
          .map((o) => ({
            organism: o?.organism,
            x: num(o?.x, 0, 0, base.size),
            y: num(o?.y, 0, 0, base.size),
            island: Math.round(num(o?.island, 0, 0, 100)),
          }))
      : base.seededOrganisms,
    repro_mut: num(src.repro_mut, base.repro_mut, 0, 5),
    decay_free: num(src.decay_free, base.decay_free, 0, 1),
    food_life: Math.round(num(src.food_life, base.food_life, 0, 1e7)),
    inflow: bool(src.inflow, base.inflow),
    foodMode: mode,
    foodLevel: FOOD_LEVELS.includes(src.foodLevel as FoodLevel) ? (src.foodLevel as FoodLevel) : base.foodLevel,
    foodRegime: FOOD_REGIMES.includes(src.foodRegime as FoodRegime) ? (src.foodRegime as FoodRegime) : base.foodRegime,
    regime_period: Math.max(1, Math.round(num(src.regime_period, base.regime_period, 1, 1e8))),
    converge_ticks: Math.max(1, Math.round(num(src.converge_ticks, base.converge_ticks, 1, 1e8))),
    T_food: Math.max(1, Math.round(num(src.T_food, base.T_food, 1, 1e6))),
    T_spawn: Math.max(1, Math.round(num(src.T_spawn, base.T_spawn, 1, 1e6))),
    n_patch: Math.round(num(src.n_patch, base.n_patch, 0, 1e4)),
    r_patch: num(src.r_patch, base.r_patch, 1, 1e5),
    v_patch: num(src.v_patch, base.v_patch, 0, 100),
    learn: learnConfig(src.learn, base.learn),
    merge_hold: bool(src.merge_hold, base.merge_hold ?? false),
    metabolism: num(src.metabolism, base.metabolism, 0.05, 8),
    bond_flow: num(src.bond_flow, base.bond_flow, 0, 0.5),
    patchOrigins: Array.isArray(src.patchOrigins) ? points(src.patchOrigins, base.size * 64) : base.patchOrigins,
    islandNames: Array.isArray(src.islandNames)
      ? (src.islandNames as unknown[]).slice(0, 32).map((n) => String(n).slice(0, 24))
      : base.islandNames,
  }
  init.n_brain = Math.min(init.n_brain, init.n_intrinsic)
  init.n_start = Math.min(init.n_start, init.n_brain)
  init.n_food0 = Math.min(init.n_food0, init.max_food)
  // a config that names a layout but carries no terrain means "stamp it", so hand-written
  // configs behave the way someone writing one would expect
  if (init.wallPositions.length === 0 && init.walls !== 'none') applyWallStamp(init)

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
