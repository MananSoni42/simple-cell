import { N_BRAIN_IN, N_BRAIN_OUT, N_WLIMB } from './neurons'
import type { World } from './world'

/** One organism, in a form that can be read, saved and put back. */
export interface OrganismFile {
  version: number
  /** Where it was, for reference; import places it wherever there is room. */
  at: [number, number]
  age: number
  generation: number
  children: number
  reserve: number
  limbs: { quad: number; type: number; angle: number; reserve: number }[]
  wLimb: number[]
  wBrain: number[]
}

export const ORGANISM_VERSION = 1

export function exportOrganism(w: World, b: number): OrganismFile | null {
  if (!w.alive[b] || !w.isBrain(b) || !w.wBrain[b] || !w.wLimb[b]) return null
  const limbs: OrganismFile['limbs'] = []
  for (let s = 0; s < 4; s++) {
    const l = w.limbs[b * 4 + s]
    if (l >= 0) limbs.push({ quad: s, type: w.type[l], angle: w.theta[l], reserve: w.energy[l] })
  }
  return {
    version: ORGANISM_VERSION,
    at: [w.x[b], w.y[b]],
    age: w.tick - w.bornAt[b],
    generation: w.gen[b],
    children: w.children[b],
    reserve: w.energy[b],
    limbs,
    wLimb: Array.from(w.wLimb[b]!),
    wBrain: Array.from(w.wBrain[b]!),
  }
}

const finite = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Reads an organism from untrusted JSON, repairing anything that does not fit this world. */
export function parseOrganism(text: string): OrganismFile {
  const raw = JSON.parse(text) as Partial<OrganismFile>
  const limbs = (Array.isArray(raw.limbs) ? raw.limbs : []).slice(0, 4).map((l, i) => ({
    quad: Math.min(3, Math.max(0, Math.round(finite(l?.quad, i)))),
    type: Math.min(3, Math.max(0, Math.round(finite(l?.type, 0)))),
    angle: finite(l?.angle, 0),
    reserve: Math.max(0, finite(l?.reserve, 0)),
  }))
  // one limb per quadrant, since that is what a body is
  const seen = new Set<number>()
  const unique = limbs.filter((l) => !seen.has(l.quad) && seen.add(l.quad))
  const pad = (a: unknown, n: number): number[] =>
    Array.from({ length: n }, (_, i) => finite(Array.isArray(a) ? (a as number[])[i] : 0, 0))
  return {
    version: ORGANISM_VERSION,
    at: [finite(raw.at?.[0]), finite(raw.at?.[1])],
    age: Math.max(0, finite(raw.age)),
    generation: Math.max(0, Math.round(finite(raw.generation))),
    children: Math.max(0, Math.round(finite(raw.children))),
    reserve: Math.max(0, finite(raw.reserve, 30)),
    limbs: unique.length > 0 ? unique : [{ quad: 0, type: 0, angle: 0.4, reserve: 15 }],
    wLimb: pad(raw.wLimb, N_WLIMB),
    wBrain: pad(raw.wBrain, N_BRAIN_IN * N_BRAIN_OUT),
  }
}
