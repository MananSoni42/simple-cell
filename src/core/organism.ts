import { N_BRAIN_IN, N_BRAIN_OUT, N_WLIMB } from './neurons'
import type { World } from './world'

/** The shape an organism's weights were saved against. Stamped on every file. */
export interface BrainShape {
  in: number
  out: number
  limb: number
}

export const BRAIN_SHAPE: BrainShape = { in: N_BRAIN_IN, out: N_BRAIN_OUT, limb: N_WLIMB }

/** What an organism achieved in its life, as of the moment it was saved. */
export interface OrganismFitness {
  age: number
  children: number
  generation: number
  /** Energy taken in from food over its life. */
  harvested: number
  /** Energy burned on upkeep, movement and signalling. */
  spent: number
  /** Distance the body travelled. */
  moved: number
  meals: number
  /** Time spent in a compound, weighted by the compound's order. */
  orderTicks: number
  peakReserve: number
  /** Mean alignment between movement and the direction of food; 0 is a random walk. */
  seeking?: number
}

/** Where an organism came from, so it still means something months later. */
export interface Provenance {
  seed: number
  tick: number
  worldSize: number
  foodMode: string
  foodLevel: string
  foodRegime: string
  /** Set when the file is filed into a library. */
  runId?: string
  savedAt?: number
  /** Which island of an archipelago produced it, and what that island was optimising. */
  island?: number
  islandName?: string
  measure?: string
}

/** One organism, in a form that can be read, saved and put back. */
export interface OrganismFile {
  version: number
  /** The weight shape this was saved against. A file from another shape is not loadable. */
  brain: BrainShape
  name?: string
  /** Where it was, for reference; import places it wherever there is room. */
  at: [number, number]
  age: number
  generation: number
  children: number
  reserve: number
  limbs: { quad: number; type: number; angle: number; reserve: number }[]
  wLimb: number[]
  wBrain: number[]
  fitness?: OrganismFitness
  from?: Provenance
}

export const ORGANISM_VERSION = 2

export function exportOrganism(w: World, b: number): OrganismFile | null {
  if (!w.alive[b] || !w.isBrain(b) || !w.wBrain[b] || !w.wLimb[b]) return null
  const limbs: OrganismFile['limbs'] = []
  for (let s = 0; s < 4; s++) {
    const l = w.limbs[b * 4 + s]
    if (l >= 0) limbs.push({ quad: s, type: w.type[l], angle: w.theta[l], reserve: w.energy[l] })
  }
  const age = w.tick - w.bornAt[b]
  return {
    version: ORGANISM_VERSION,
    brain: { ...BRAIN_SHAPE },
    at: [w.x[b], w.y[b]],
    age,
    generation: w.gen[b],
    children: w.children[b],
    reserve: w.energy[b],
    limbs,
    wLimb: Array.from(w.wLimb[b]!),
    wBrain: Array.from(w.wBrain[b]!),
    fitness: {
      age,
      children: w.children[b],
      generation: w.gen[b],
      harvested: w.harvested[b],
      spent: w.spent[b],
      moved: w.moved[b],
      meals: w.meals[b],
      orderTicks: w.orderTicks[b],
      peakReserve: w.peakReserve[b],
      seeking: w.seekTicks[b] > 0 ? w.seeking[b] / w.seekTicks[b] : 0,
    },
    from: {
      seed: w.init.seed,
      tick: w.tick,
      worldSize: w.init.size,
      foodMode: w.init.foodMode,
      foodLevel: w.init.foodLevel,
      foodRegime: w.init.foodRegime,
    },
  }
}

/** Raised when a file cannot be loaded into *this* world rather than merely being malformed. */
export class IncompatibleOrganism extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'IncompatibleOrganism'
  }
}

export interface Compatibility {
  ok: boolean
  /** Why not, in words a reader can act on. */
  reason?: string
  shape?: BrainShape
}

/**
 * Whether a file's weights were made for the brain this build has.
 *
 * An organism *is* its weights, and those weights only mean anything against the input and output
 * they were trained or evolved against. The brain's shape has already changed twice during this
 * project (27 → 33 → 29 → 41 inputs), and padding an old vector to fit produces a creature that is not
 * the one that was saved — it just fails quietly instead of loudly. So a mismatch is refused.
 */
export function checkCompatibility(raw: unknown): Compatibility {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an organism file' }
  const o = raw as Partial<OrganismFile>
  const shape = o.brain
  if (!shape || typeof shape.in !== 'number' || typeof shape.out !== 'number') {
    return {
      ok: false,
      reason: `saved before organisms recorded their brain shape (file version ${o.version ?? '?'}), so its weights cannot be matched to this brain`,
    }
  }
  if (shape.in !== BRAIN_SHAPE.in || shape.out !== BRAIN_SHAPE.out || shape.limb !== BRAIN_SHAPE.limb) {
    return {
      ok: false,
      shape,
      reason: `made for a ${shape.in}→${shape.out} brain with ${shape.limb} limb weights; this world has ${BRAIN_SHAPE.in}→${BRAIN_SHAPE.out} with ${BRAIN_SHAPE.limb}`,
    }
  }
  const nb = Array.isArray(o.wBrain) ? o.wBrain.length : -1
  const nl = Array.isArray(o.wLimb) ? o.wLimb.length : -1
  if (nb !== shape.in * shape.out || nl !== shape.limb) {
    return { ok: false, shape, reason: `weight counts do not match its own stamp (${nb} brain, ${nl} limb)` }
  }
  return { ok: true, shape }
}

const finite = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * Reads an organism from untrusted JSON. Anything cosmetic is repaired; an incompatible brain is
 * **refused**, because a padded brain is a different organism wearing the same name.
 */
export function parseOrganism(text: string): OrganismFile {
  const raw = JSON.parse(text) as Partial<OrganismFile>
  const compat = checkCompatibility(raw)
  if (!compat.ok) throw new IncompatibleOrganism(compat.reason!)

  const limbs = (Array.isArray(raw.limbs) ? raw.limbs : []).slice(0, 4).map((l, i) => ({
    quad: Math.min(3, Math.max(0, Math.round(finite(l?.quad, i)))),
    type: Math.min(3, Math.max(0, Math.round(finite(l?.type, 0)))),
    angle: finite(l?.angle, 0),
    reserve: Math.max(0, finite(l?.reserve, 0)),
  }))
  // one limb per quadrant, since that is what a body is
  const seen = new Set<number>()
  const unique = limbs.filter((l) => !seen.has(l.quad) && seen.add(l.quad))
  const weights = (a: unknown, n: number): number[] => Array.from({ length: n }, (_, i) => finite((a as number[])[i], 0))

  return {
    version: ORGANISM_VERSION,
    brain: { ...BRAIN_SHAPE },
    name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : undefined,
    at: [finite(raw.at?.[0]), finite(raw.at?.[1])],
    age: Math.max(0, finite(raw.age)),
    generation: Math.max(0, Math.round(finite(raw.generation))),
    children: Math.max(0, Math.round(finite(raw.children))),
    reserve: Math.max(0, finite(raw.reserve, 30)),
    limbs: unique.length > 0 ? unique : [{ quad: 0, type: 0, angle: 0.4, reserve: 15 }],
    wLimb: weights(raw.wLimb, BRAIN_SHAPE.limb),
    wBrain: weights(raw.wBrain, BRAIN_SHAPE.in * BRAIN_SHAPE.out),
    fitness: raw.fitness,
    from: raw.from,
  }
}

/**
 * A readable handle, built from where an organism came from, because unnamed things never get
 * used again. Deterministic, so the same organism always gets the same name.
 */
export function defaultName(o: OrganismFile, label?: string): string {
  const f = o.from
  const parts = [f?.foodMode ?? 'world', f?.foodLevel ?? '', `g${o.generation}`, label ?? '']
  return parts.filter(Boolean).join('-').replace(/\s+/g, '-').toLowerCase()
}
