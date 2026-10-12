import { type FoodLevel, type FoodMode, type FoodRegime, type Init, LAWS, applyFoodLevel, applyQuantization, initFromSeed, quantize, substepsFor } from './params'
import { LEARN_DEFAULTS, type LearnAlgo } from './learning'
import { N_MATRIX } from './types'
import { specFromKeys } from './fitness'

/**
 * The catalog: every world we have ever run, in a form that can be run again.
 *
 * Two decisions shape this file.
 *
 * **A world is stored as a `WorldSpec`, not as an `Init`.** A spec is the handful of numbers a
 * search actually varies — fourteen matrix entries and a dozen dials — and `specInit` turns one
 * into a world deterministically. An `Init` serialises to about 1.5 kB, so cataloguing two hundred
 * thousand of them would cost 300 MB; a spec costs about 250 bytes, and *is* reproducible, which
 * is the only property that matters. It is also the thing a search mutates, so the catalog key and
 * the search genome are the same object.
 *
 * **The id is a hash of the spec.** That makes the catalog a set rather than a list: a run can be
 * resumed by skipping ids already present, two phases cannot double-count the same world, and an
 * interrupted overnight search costs nothing but the candidate it was mid-way through.
 */

/** The searchable description of a world: everything a phase may vary. */
export interface WorldSpec {
  seed: number
  /**
   * The chemistry, as the lower triangle in row-major order — 14 entries, since Food×Food is
   * always zero. Quantized to QUANTA, which is what makes the space countable.
   */
  A: number[]
  slots: number
  matter: number
  metabolism: number
  bondFlow: number
  T: number
  foodMode: FoodMode
  foodLevel: FoodLevel
  foodRegime: FoodRegime
  patches: number
  radius: number
  foodLife: number
  fission: boolean
  scale: number
  /** Off for the search itself; set only when a surviving world is tested with a learner. */
  learn?: LearnAlgo
}

export const N_TRI = 14

/** Lower-triangle index pairs, in the order `WorldSpec.A` stores them. */
export const TRI: [number, number][] = (() => {
  const out: [number, number][] = []
  for (let i = 0; i < N_MATRIX; i++) {
    for (let j = 0; j <= i; j++) {
      if (i === N_MATRIX - 1 && j === N_MATRIX - 1) continue // Food x Food is always zero
      out.push([i, j])
    }
  }
  return out
})()

export function matrixOf(a: number[]): number[][] {
  const A = Array.from({ length: N_MATRIX }, () => new Array<number>(N_MATRIX).fill(0))
  TRI.forEach(([i, j], k) => {
    const v = quantize(a[k] ?? 0)
    A[i][j] = v
    A[j][i] = v
  })
  return applyQuantization(A)
}

export function triOf(A: number[][]): number[] {
  return TRI.map(([i, j]) => quantize(A[i][j]))
}

/** A world from a spec. Deterministic: the same spec always gives the same world. */
export function specInit(spec: WorldSpec): Init {
  const init = initFromSeed(spec.seed, spec.scale)
  init.A = matrixOf(spec.A)
  init.quantized = true
  init.foodMode = spec.foodMode
  init.foodLevel = spec.foodLevel
  init.foodRegime = spec.foodRegime
  init.n_patch = spec.patches
  init.r_patch = spec.radius
  init.food_life = spec.foodLife
  init.n_brain = spec.slots
  init.n_start = Math.max(2, Math.round(spec.slots * 0.1))
  init.n_intrinsic = spec.matter
  init.T = spec.T
  init.T_spawn = 25
  init.metabolism = spec.metabolism
  init.bond_flow = spec.bondFlow
  init.fission = spec.fission
  init.bonds = true
  init.repro = true
  init.inflow = false
  init.walls = 'none'
  init.n_wall = 0
  init.wallPositions = []
  init.learn = { ...LEARN_DEFAULTS, algo: spec.learn ?? 'none', fitness: specFromKeys(['offspring']) }
  applyFoodLevel(init)
  init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return init
}

/** Stable id, so the catalog is a set and a search can be resumed by skipping what it holds. */
export function specId(spec: WorldSpec): string {
  const canon = [
    spec.seed,
    spec.A.map((v) => v.toFixed(2)).join(','),
    spec.slots,
    spec.matter,
    spec.metabolism,
    spec.bondFlow,
    spec.T,
    spec.foodMode,
    spec.foodLevel,
    spec.foodRegime,
    spec.patches,
    spec.radius,
    spec.foodLife,
    spec.fission ? 1 : 0,
    spec.scale,
    spec.learn ?? 'none',
  ].join('|')
  // FNV-1a, 64 bits as two 32-bit halves: short, stable across runs, and no dependency
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).padStart(13, '0')
}

/** Why a run stopped, which is part of the result rather than an aside. */
export type StopReason =
  | 'done' // ran its full horizon
  | 'extinct' // nothing left alive, so nothing more to learn
  | 'plateau' // the score stopped improving, so the rest of the horizon was spent elsewhere
  | 'extended' // still climbing at the horizon, so it earned more ticks

/** One simulation, catalogued. Everything needed to rank it, explain it, or run it again. */
export interface CatalogEntry {
  id: string
  spec: WorldSpec
  /** Which phase produced this row; later phases supersede earlier ones for the same id. */
  phase: number
  /** Wall-clock milliseconds and the ticks actually run, so cost per phase is measurable. */
  ms: number
  ticks: number
  stop: StopReason
  /** The ladder: the level reached, the continuous score, and every rung's progress. */
  level: number
  score: number
  ratios: number[]
  /** Enough of the measurements to sort and to explain a sort without re-running anything. */
  stats: {
    organisms: number
    p90Coasts: number
    fed: number
    seek: number
    limbs: number
    maxGen: number
    bonds: number
    bestOrder: number
    heldFrac: number
    replacements: number
    travel: number
    lifeMean: number
    clampPct: number
  }
  /** Medians across seeds, when a phase ran more than one. */
  seeds: number
  at: number
}

/** The header line of a catalog shard, so a file explains itself years later. */
export interface CatalogHeader {
  kind: 'simplecell-catalog'
  version: number
  startedAt: number
  note: string
}

export const CATALOG_VERSION = 1

/**
 * Parses a catalog shard, skipping anything unreadable.
 *
 * A search appends as it goes and may be killed at any moment, so the last line of a shard is
 * routinely half-written. Dropping it is correct; refusing to read the file because of it would
 * throw away a night's work.
 */
export function parseCatalog(text: string): { header: CatalogHeader | null; entries: CatalogEntry[] } {
  let header: CatalogHeader | null = null
  const entries: CatalogEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const row = JSON.parse(t) as CatalogHeader | CatalogEntry
      if ((row as CatalogHeader).kind === 'simplecell-catalog') header = row as CatalogHeader
      else if ((row as CatalogEntry).id && (row as CatalogEntry).spec) entries.push(row as CatalogEntry)
    } catch {
      /* a half-written final line, which is what an interrupted run leaves */
    }
  }
  return { header, entries }
}

/**
 * The best of several entries for one world. Later phases ran longer with more seeds, so they
 * win regardless of score — a high score from 500 ticks is not evidence against a lower one from
 * a hundred thousand.
 */
export function best(entries: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>()
  for (const e of entries) {
    const prev = byId.get(e.id)
    if (!prev || e.phase > prev.phase) byId.set(e.id, e)
  }
  return [...byId.values()]
}

/** The ordering the Discoveries screen uses: level first, then score, then how long it was run. */
export function rank(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => b.level - a.level || b.score - a.score || b.ticks - a.ticks)
}
