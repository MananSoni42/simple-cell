import type { Init } from './params'
import { World } from './world'

/**
 * A complete world state. Built for rewind, and the same primitive gives state save/load and
 * long-run checkpoints. Everything that affects the future must be here — including the RNG,
 * the brain weights, the food free-list and the metric trackers — or a restored world would
 * diverge from the one it was copied from.
 */
export interface Snapshot {
  tick: number
  bytes: ArrayBuffer // all per-particle arrays, packed back to back
  scalars: Float64Array
  weights: (Float64Array | null)[][] // [limbWeights, brainWeights] per brain slot
  patches: { x: number; y: number; h: number }[]
  rng: [number, number | null]
  field: Float64Array
  freeFood: Int32Array
  lineageCounter: number
}

/** Per-particle arrays, in a fixed order. Keep this list in step with World's state. */
function views(w: World): (Float64Array | Float32Array | Int32Array | Int16Array | Int8Array | Uint8Array)[] {
  return [
    w.x, w.y, w.fx, w.fy, w.energy, w.theta, w.sig, w.msg, w.ffx, w.ffy,
    w.foodNear, w.mvx, w.mvy,
    w.type, w.alive,
    w.owner, w.socket, w.cool, w.repCool, w.bornAt, w.gen, w.parent, w.lineage, w.children,
    w.since, w.limbs,
  ]
}

export function snapshotBytes(w: World): number {
  let n = 0
  for (const v of views(w)) n += v.byteLength
  return n + w.field.byteLength + 512
}

export function takeSnapshot(w: World): Snapshot {
  const vs = views(w)
  let total = 0
  for (const v of vs) total += v.byteLength
  const bytes = new ArrayBuffer(total)
  let off = 0
  for (const v of vs) {
    new Uint8Array(bytes, off, v.byteLength).set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    off += v.byteLength
  }
  const weights: (Float64Array | null)[][] = []
  for (let b = w.nIntr; b < w.nMatter; b++) {
    weights.push([w.wLimb[b] ? Float64Array.from(w.wLimb[b]!) : null, w.wBrain[b] ? Float64Array.from(w.wBrain[b]!) : null])
  }
  return {
    tick: w.tick,
    bytes,
    scalars: Float64Array.of(w.burned, w.injected, w.nBirths, w.nBudded, w.nDeaths, w.recordAge, w.nClamped, w.nSteps),
    weights,
    patches: w.patches.map((p) => ({ ...p })),
    rng: w.rng.state(),
    field: Float64Array.from(w.field),
    freeFood: Int32Array.from(w.freeFoodSlots()),
    lineageCounter: w.lineageCounter,
  }
}

/** Rebuilds a world at the snapshot's moment. The Init must be the one it was created with. */
export function restoreSnapshot(init: Init, snap: Snapshot, opts?: { shared?: boolean }): World {
  const w = new World(init, { ...opts, autoSpawn: false })
  const vs = views(w)
  let off = 0
  for (const v of vs) {
    new Uint8Array(v.buffer, v.byteOffset, v.byteLength).set(new Uint8Array(snap.bytes, off, v.byteLength))
    off += v.byteLength
  }
  w.tick = snap.tick
  const [burned, injected, births, budded, deaths, recordAge, clamped, steps] = snap.scalars
  w.burned = burned
  w.injected = injected
  w.nBirths = births
  w.nBudded = budded
  w.nDeaths = deaths
  w.recordAge = recordAge
  w.nClamped = clamped
  w.nSteps = steps
  for (let i = 0; i < snap.weights.length; i++) {
    const [wl, wb] = snap.weights[i]
    w.wLimb[w.nIntr + i] = wl ? Float64Array.from(wl) : undefined
    w.wBrain[w.nIntr + i] = wb ? Float64Array.from(wb) : undefined
  }
  w.patches.length = 0
  for (const p of snap.patches) w.patches.push({ ...p })
  w.rng.setState(snap.rng)
  w.field.set(snap.field)
  w.setFreeFoodSlots(snap.freeFood)
  w.lineageCounter = snap.lineageCounter
  w.aggregates.reset()
  w.grid.build()
  return w
}
