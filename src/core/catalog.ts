import { type Element, type FoodLevel, type FoodMode, type FoodRegime, type Init, LAWS, type Laws, applyFoodLevel, applyQuantization, initFromSeed, quantize, substepsFor } from './params'
import { LEARN_DEFAULTS, type LearnAlgo } from './learning'
import { FOOD_ROW, N_MATRIX } from './types'
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
  /**
   * Physics and economics the search is allowed to vary.
   *
   * These were constants, and a constant is a decision made before the evidence. Every one of
   * them was set by a judgement call — food's mobility, how hard a brain can push against how
   * hard a bond holds, what a child costs, how fast weights drift between generations — and none
   * of those judgements was ever tested against an alternative. Picking a number and then
   * searching everything *else* is a search that can only find the best world consistent with my
   * guesses.
   *
   * All optional, so a catalog row written before they existed still parses and still runs: an
   * absent dial means the law's default, which is what those rows were measured under.
   *
   * Discrete sets, not continuous ranges, for the same reason the chemistry is quantized — the
   * factor analysis in `analyse.ts` reports marginal means per level, and it needs cells with
   * worlds in them. Continuous dials would give every world its own cell and nothing would ever
   * clear thirty samples.
   */
  /** Food's mobility as a fraction of everything else's (R2.2b). */
  muFood?: number
  /** The largest force a brain can exert on itself, against which bond strength is measured. */
  fMax?: number
  /** Bond spring stiffness. */
  kBond?: number
  /** Tension a bond survives before breaking; the gap to `F_form` is the activation energy. */
  fBreak?: number
  /** How many bonds one particle may hold: 2 admits only chains and rings. */
  maxBonds?: number
  /** Mouth width — how close a particle must come to food to eat it. */
  rEat?: number
  /** What each particle of a newborn starts with, paid by the parent. */
  eBirth?: number
  /** The reserve at which a brain may reproduce. */
  eRepro?: number
  /** Std-dev of the Gaussian noise added to an inherited brain: the mutation rate. */
  reproMut?: number
  /**
   * Which ways of reproducing are available, on top of budding and the separate `fission` dial.
   *
   * A single categorical rather than independent flags, so the factor tables get cells with
   * worlds in them — the whole reason the chemistry is quantized. `bud` is the old world.
   */
  reproMode?: ReproMode
  /** What a parent invests in a spore, and how much food a spore needs to germinate (R7.10). */
  eSpore?: number
  sporeFood?: number
  /**
   * Per-type properties: size, mobility, valence, bond strength and cost, decay.
   *
   * Carried in full, like the chemistry matrix, rather than as a handful of summary dials — a
   * found world has to be reproducible and hand-editable. The *sampler* draws it from a structured
   * prior controlled by `elementSpread`, which is what the factor analysis reports on, so the
   * search has one interpretable question ("does differentiating the types help?") while the spec
   * keeps the whole answer.
   */
  elements?: (Partial<Element> | undefined)[]
  /** How differentiated the element table is: 0 uniform, 1 strongly varied. Analysis handle. */
  elementSpread?: number
  /**
   * Whether particles replicate and mutate their own chemistry (R7.11).
   *
   * With this on, the matrix stops being the world's law and becomes its **ancestral** chemistry:
   * what every particle starts from and drifts away from. That is a tier change — `A` becomes an
   * initial condition rather than a constant — so the factor analysis reports what a world
   * *started* with, not what it ran.
   */
  templating?: boolean
  /** Mutation std-dev on a copied affinity row, in quanta. */
  rowMut?: number
  /** Per-type decay, as a single multiplier on the drawn table: what makes slots free to copy into. */
  decayScale?: number
  /**
   * Ticks between free organisms arriving from the spawner (R7.1).
   *
   * Searchable because it was silently deciding where a world's population came from: at 25, most
   * organisms in a short run are spawned rather than descended, so the heredity rungs are reading
   * the spawner. High values make a world live or die on its own reproduction.
   */
  spawnEvery?: number
  /**
   * A named hand-built brain (see `handbuilt.ts`), instead of random weights.
   *
   * Never drawn by the sampler — these are written, not found. It travels in the spec so a
   * hand-built world is reproducible, catalogable and openable from the Discoveries page like any
   * other, which is the point: the policy the feasibility suite asserts on is the policy on screen.
   */
  handBuilt?: string
}

/** The reproduction modes a world may allow. Budding is always available; these add to it. */
export type ReproMode = 'bud' | 'conjugation' | 'spore' | 'conjugation+spore'
export const REPRO_MODES: ReproMode[] = ['bud', 'conjugation', 'spore', 'conjugation+spore']



/** Lower-triangle index pairs, in the order `WorldSpec.A` stores them. */
export const TRI: [number, number][] = (() => {
  const out: [number, number][] = []
  for (let i = 0; i < N_MATRIX; i++) {
    for (let j = 0; j <= i; j++) {
      if (i === FOOD_ROW && j === FOOD_ROW) continue // Food x Food is always zero
      out.push([i, j])
    }
  }
  return out
})()

/**
 * How many lower-triangle entries a spec carries. 20 with Brain in the matrix, 14 without.
 *
 * Derived from `TRI` rather than written down, because the two going out of step would corrupt
 * every spec silently — `matrixOf` would read past the end of the array and fill the tail with
 * zeros, which is a world that runs and is not the world that was asked for.
 */
export const N_TRI = TRI.length

/** Element fields in a fixed order, so a spec's hash cannot depend on key order. */
export const ELEMENT_FIELDS: (keyof Element)[] = ['radius', 'mobility', 'valence', 'bondStrength', 'bondCost', 'decay']

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
  /*
   * **Food has to be allowed to move for its mobility to mean anything.**
   *
   * `foodMoves` was never set here, so it stayed `false` from the seed, the integrator skipped food
   * entirely, and `muFood` — four levels across a twentyfold range — produced **bit-identical
   * worlds**. Verified: 6 of 6 pairs identical between `muFood` 0.05 and 1. So the dial was dead,
   * the factor table for "food mobility" was reporting pure noise over tens of thousands of worlds
   * per cell, and pre-registered prediction P3 ("muFood below 0.4 is necessary for Seeks") was
   * untestable by the search that was meant to test it.
   *
   * Tied to the dial rather than forced on: `muFood` at 1 means food that drifts exactly as fast as
   * a limb swims, which is the regime where nothing can be caught, so the search needs to be able
   * to choose it. The cost is real — moving food also turns on the kernel's food path, which
   * `skipFood` had been eliding for about half the packed particles.
   */
  if (spec.muFood !== undefined) init.foodMoves = true
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
  /*
   * The spawner, which was supplying most of every world's population.
   *
   * This was hardcoded at 25 against 60–140 from the seed, and in no dial. Measured at the phase-0
   * horizon: **20 spawns per 500-tick run against a mean of 3.0 budded children** — so roughly
   * 80% of every organism a short world ever held was a gift from the spawner rather than a
   * descendant. Every tier-0 rung was partly reading the spawn rate, and `evaluate`'s `extinct`
   * early stop could essentially never fire: 120 of 120 sampled worlds ran to `done`.
   *
   * Now a dial, with the old value among its levels so a search can find that it was right.
   */
  init.T_spawn = spec.spawnEvery ?? 25
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
  if (spec.reproMut !== undefined) init.repro_mut = spec.reproMut
  if (spec.elements) init.elements = spec.elements
  if (spec.templating !== undefined) init.templating = spec.templating
  if (spec.handBuilt) init.handBuilt = spec.handBuilt
  if (spec.rowMut !== undefined) init.row_mut = spec.rowMut
  if (spec.decayScale !== undefined && spec.decayScale > 0) {
    // templating needs somewhere to copy *into*, and only decay frees a slot — so a world that
    // replicates without decaying would stall after filling whatever was empty at init
    init.elements = [0, 1, 2, 3].map((t) => ({ ...(init.elements?.[t] ?? {}), decay: spec.decayScale }))
  }
  const mode = spec.reproMode ?? 'bud'
  init.conjugation = mode === 'conjugation' || mode === 'conjugation+spore'
  init.spore = mode === 'spore' || mode === 'conjugation+spore'
  // carried on the Init so that every path which takes an Init — the worker, a snapshot, the
  // Discoveries preview — runs the physics the world was scored under rather than the default
  init.laws = specLaws(spec)
  applyFoodLevel(init)
  init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return init
}

/**
 * The law overrides a spec asks for, as a `Partial<Laws>` to hand to `new World`.
 *
 * Returned separately from the `Init` rather than folded into it because laws and initial
 * conditions are different tiers and this project keeps them apart: an `Init` describes a world
 * you could set up, a `Laws` override describes a different physics. The search varies both, but
 * it should never be able to confuse them.
 */
export function specLaws(spec: WorldSpec): Partial<Laws> {
  const L: Partial<Laws> = {}
  if (spec.muFood !== undefined) L.mu_food = spec.muFood
  if (spec.fMax !== undefined) L.F_max = spec.fMax
  if (spec.kBond !== undefined) L.k_bond = spec.kBond
  if (spec.fBreak !== undefined) L.F_break = spec.fBreak
  if (spec.maxBonds !== undefined) L.max_bonds = spec.maxBonds
  if (spec.rEat !== undefined) L.r_eat = spec.rEat
  if (spec.eBirth !== undefined) L.E_birth = spec.eBirth
  if (spec.eRepro !== undefined) L.E_repro = spec.eRepro
  if (spec.eSpore !== undefined) L.E_spore = spec.eSpore
  if (spec.sporeFood !== undefined) L.spore_food = spec.sporeFood
  return L
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
  ]
  /*
   * The law dials are appended only when at least one is set, and that is deliberate.
   *
   * A spec with no law overrides must hash exactly as it did before these dials existed, or every
   * row in the existing catalog gets a new id and a resumed search re-runs all 260,640 worlds.
   * Appending an empty field would not do — it still changes the canonical string — so the whole
   * group is omitted when it is empty.
   */
  const laws = [
    spec.muFood, spec.fMax, spec.kBond, spec.fBreak, spec.maxBonds, spec.rEat, spec.eBirth, spec.eRepro, spec.reproMut,
    spec.reproMode, spec.eSpore, spec.sporeFood,
    spec.templating === undefined ? undefined : spec.templating ? 1 : 0, spec.rowMut, spec.decayScale,
    spec.handBuilt, spec.spawnEvery,
    // the element table, canonicalised: field order fixed by `ELEMENT_FIELDS` so two equal tables
    // written in different key orders cannot hash differently
    spec.elements
      ? spec.elements.map((e) => (e ? ELEMENT_FIELDS.map((f) => e[f] ?? '').join('/') : '')).join(';')
      : undefined,
  ]
  if (laws.some((v) => v !== undefined)) canon.push(laws.map((v) => (v === undefined ? '' : String(v))).join(','))
  const text = canon.join('|')
  // FNV-1a, 64 bits as two 32-bit halves: short, stable across runs, and no dependency
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
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
    /** Share of the sun's output the world had no room for; see R4.1. */
    lightWastedPct?: number
    /**
     * Why reproduction did not happen, by cause, per thousand ticks (R7.7a). Four scalars rather
     * than one, because "out of matter" is a budget to raise and "out of energy" is a result
     * about the chemistry, and they used to be the same silent symptom.
     */
    blockedSlots?: number
    blockedMatter?: number
    blockedEnergy?: number
    blockedRoom?: number
  }
  /** Medians across seeds, when a phase ran more than one. */
  seeds: number
  at: number
  /**
   * Where the candidate came from: the constrained region, the uniform control, a mutation of an
   * elite, or promotion from an earlier phase.
   *
   * This is the pre-registered test of the search's own prior, and leaving it out was an oversight
   * — without it the constrained half can only be compared through derived shapes, which is an
   * inference rather than the measurement that was promised.
   */
  source?: 'constrained' | 'uniform' | 'mutant' | 'promoted'
  /** Set by the export: why this world is worth looking at, rather than merely where it ranked. */
  why?: string
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
