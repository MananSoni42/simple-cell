import { N_WLIMB } from './neurons'
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
  /** [limbWeights, brainWeights] per brain slot, flattened; `has` says which existed. */
  wLimb: Float64Array
  wBrain: Float64Array
  wHas: Uint8Array
  patches: Float64Array // x, y, h, ox, oy per patch
  patchCount: number
  rng: [number, number | null]
  field: Float64Array
  freeFood: Int32Array
  freeFoodCount: number
  lineageCounter: number
  /** False until the slot has been written at least once. */
  valid: boolean
}

/** Per-particle arrays, in a fixed order. Keep this list in step with World's state. */
function views(w: World): (Float64Array | Float32Array | Int32Array | Int16Array | Int8Array | Uint8Array)[] {
  return [
    w.x, w.y, w.fx, w.fy, w.energy, w.theta, w.sig, w.msg, w.ffx, w.ffy,
    w.foodNear, w.mvx, w.mvy,
    w.type, w.alive,
    w.owner, w.socket, w.cool, w.repCool, w.bornAt, w.gen, w.parent, w.lineage, w.children,
    w.since, w.limbs, w.brainSig, w.bondCool, w.bonds.partner,
    w.harvested, w.spent, w.moved, w.meals, w.orderTicks, w.peakReserve,
  ]
}

export function snapshotBytes(w: World): number {
  let n = 0
  for (const v of views(w)) n += v.byteLength
  return n + w.field.byteLength + 512
}

/**
 * An empty snapshot sized for this world. Allocate once and refill with `writeSnapshot`:
 * at a few thousand ticks a second, allocating a fresh one per tick produced hundreds of
 * megabytes a second of garbage and could bring the tab down.
 */
export function allocSnapshot(w: World): Snapshot {
  const vs = views(w)
  let total = 0
  for (const v of vs) total += v.byteLength
  const brains = w.nMatter - w.nIntr
  return {
    tick: 0,
    bytes: new ArrayBuffer(total),
    scalars: new Float64Array(9),
    wLimb: new Float64Array(brains * N_WLIMB),
    wBrain: new Float64Array(brains * w.brainWeightCount),
    wHas: new Uint8Array(brains * 2),
    patches: new Float64Array(Math.max(1, w.patches.length) * 5),
    patchCount: 0,
    rng: [0, null],
    field: new Float64Array(w.field.length),
    freeFood: new Int32Array(w.cap),
    freeFoodCount: 0,
    lineageCounter: 1,
    valid: false,
  }
}

/** Copies the world into an already-allocated snapshot. Allocation-free. */
export function writeSnapshot(w: World, snap: Snapshot): Snapshot {
  const vs = views(w)
  let off = 0
  for (const v of vs) {
    new Uint8Array(snap.bytes, off, v.byteLength).set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    off += v.byteLength
  }
  snap.tick = w.tick
  snap.scalars[0] = w.burned
  snap.scalars[1] = w.injected
  snap.scalars[2] = w.nBirths
  snap.scalars[3] = w.nBudded
  snap.scalars[4] = w.nDeaths
  snap.scalars[5] = w.recordAge
  snap.scalars[6] = w.nClamped
  snap.scalars[7] = w.nSteps
  snap.scalars[8] = w.foodOwed
  const nb = w.brainWeightCount
  for (let i = 0; i < w.nMatter - w.nIntr; i++) {
    const b = w.nIntr + i
    const wl = w.wLimb[b]
    const wb = w.wBrain[b]
    snap.wHas[i * 2] = wl ? 1 : 0
    snap.wHas[i * 2 + 1] = wb ? 1 : 0
    if (wl) snap.wLimb.set(wl, i * N_WLIMB)
    if (wb) snap.wBrain.set(wb, i * nb)
  }
  snap.patchCount = w.patches.length
  for (let i = 0; i < w.patches.length; i++) {
    const p = w.patches[i]
    snap.patches[i * 5] = p.x
    snap.patches[i * 5 + 1] = p.y
    snap.patches[i * 5 + 2] = p.h
    snap.patches[i * 5 + 3] = p.ox
    snap.patches[i * 5 + 4] = p.oy
  }
  snap.rng = w.rng.state()
  snap.field.set(w.field)
  const slots = w.freeFoodSlots()
  snap.freeFoodCount = slots.length
  for (let i = 0; i < slots.length; i++) snap.freeFood[i] = slots[i]
  snap.lineageCounter = w.lineageCounter
  snap.valid = true
  return snap
}

export function takeSnapshot(w: World): Snapshot {
  return writeSnapshot(w, allocSnapshot(w))
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
  const [burned, injected, births, budded, deaths, recordAge, clamped, steps, owed] = snap.scalars
  w.burned = burned
  w.injected = injected
  w.nBirths = births
  w.nBudded = budded
  w.nDeaths = deaths
  w.recordAge = recordAge
  w.nClamped = clamped
  w.nSteps = steps
  w.foodOwed = owed
  const nb = w.brainWeightCount
  for (let i = 0; i < w.nMatter - w.nIntr; i++) {
    const b = w.nIntr + i
    w.wLimb[b] = snap.wHas[i * 2] ? snap.wLimb.slice(i * N_WLIMB, (i + 1) * N_WLIMB) : undefined
    w.wBrain[b] = snap.wHas[i * 2 + 1] ? snap.wBrain.slice(i * nb, (i + 1) * nb) : undefined
  }
  w.patches.length = 0
  for (let i = 0; i < snap.patchCount; i++) {
    w.patches.push({
      x: snap.patches[i * 5], y: snap.patches[i * 5 + 1], h: snap.patches[i * 5 + 2],
      ox: snap.patches[i * 5 + 3], oy: snap.patches[i * 5 + 4],
    })
  }
  w.rng.setState(snap.rng)
  w.field.set(snap.field)
  w.setFreeFoodSlots(snap.freeFood.subarray(0, snap.freeFoodCount))
  w.lineageCounter = snap.lineageCounter
  w.aggregates.reset()
  w.orders.reset()
  w.grid.build()
  return w
}
