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
  /** The weights an organism was *born* with, when Darwinian inheritance is configured. */
  wBirthLimb: Float64Array
  wBirthBrain: Float64Array
  /** Four flags per matter slot: live limb, live brain, birth limb, birth brain. */
  wHas: Uint8Array
  patches: Float64Array // x, y, h, ox, oy, dx, dy per patch
  patchCount: number
  rng: [number, number | null]
  field: Float64Array
  freeFood: Int32Array
  freeFoodCount: number
  lineageCounter: number
  /** The learner's own state — its pool or its distribution — flattened. */
  learner: Float64Array
  /** False until the slot has been written at least once. */
  valid: boolean
}

/**
 * Per-particle arrays, in a fixed order. Keep this list in step with World's state.
 *
 * That instruction was already being disobeyed when `rows` was added, and the omissions are
 * instructive about how this fails: a missing array does not break a snapshot, it silently
 * restores a *different world*. Twelve arrays had accumulated outside the list —
 * `endowment` and `coastT` (so a rewind corrupted the ladder's per-organism yardsticks),
 * `hasJoined`, `parentJoined`, `wasLive`, `coparent`, `spawnX/Y`, `isSpore` (so a rewind orphaned
 * every spore), and `lvx/lvy`. The snapshot test only caught `rows` because `rows` changes the
 * forces and therefore the state hash; the others change bookkeeping, which nothing hashes.
 */
function views(w: World): (Float64Array | Float32Array | Int32Array | Int16Array | Int8Array | Uint8Array)[] {
  return [
    w.x, w.y, w.fx, w.fy, w.energy, w.theta, w.sig, w.msg, w.ffx, w.ffy,
    w.foodNear, w.mvx, w.mvy,
    w.type, w.alive,
    w.owner, w.socket, w.cool, w.repCool, w.bornAt, w.gen, w.parent, w.lineage, w.children,
    w.since, w.limbs, w.brainSig, w.bondCool, w.bonds.partner,
    w.harvested, w.spent, w.moved, w.meals, w.orderTicks, w.peakReserve, w.learnId, w.island,
    w.seeking, w.seekTicks, w.eRepro, w.repWait,
    // every particle's own chemistry: the thing that makes two P1s different, so a rewind that
    // dropped it would restore a world with the same positions and the wrong physics
    w.rows,
    w.endowment, w.coastT, w.hasJoined, w.parentJoined, w.wasLive, w.coparent,
    w.spawnX, w.spawnY, w.isSpore, w.lvx, w.lvy,
    // harvest already paid out as reward, and the replication cooldown: both decide the future
    w.rewarded, w.tmplCool,
  ]
}

export function snapshotBytes(w: World): number {
  let n = 0
  for (const v of views(w)) n += v.byteLength
  return n + w.field.byteLength + 8 * w.learner.saveSize() + 512
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
  return {
    tick: 0,
    bytes: new ArrayBuffer(total),
    scalars: new Float64Array(17),
    // sized by every matter slot, not just the brain slots: a spore carries its genome on an
    // intrinsic particle, and birth weights can exist for any organism
    wLimb: new Float64Array(w.nMatter * N_WLIMB),
    wBrain: new Float64Array(w.nMatter * w.brainWeightCount),
    wBirthLimb: new Float64Array(w.nMatter * N_WLIMB),
    wBirthBrain: new Float64Array(w.nMatter * w.brainWeightCount),
    wHas: new Uint8Array(w.nMatter * 4),
    patches: new Float64Array(Math.max(1, w.patches.length) * 7),
    patchCount: 0,
    rng: [0, null],
    field: new Float64Array(w.field.length),
    freeFood: new Int32Array(w.cap),
    freeFoodCount: 0,
    lineageCounter: 1,
    learner: new Float64Array(w.learner.saveSize()),
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
  // a scan position and a merge clock are state: without them a rewound world replicates into
  // different slots, and a merged archipelago re-freezes its colonies because the constructor
  // resets `mergeStart` from `merge_hold`
  snap.scalars[9] = w.matterCursor
  snap.scalars[10] = w.mergeStart === null ? -1 : w.mergeStart
  snap.scalars[11] = w.nTemplated
  snap.scalars[12] = w.nSown
  snap.scalars[13] = w.nGerminated
  snap.scalars[14] = w.nConjugated
  snap.scalars[15] = w.lightWasted
  snap.scalars[16] = w.srcV
  /*
   * Weights for **every matter slot**, not just the brain slots.
   *
   * `sow()` stores a spore's genome on an *intrinsic* particle — below `nIntr` — and this loop
   * used to start at `nIntr`. So a snapshot destroyed every spore's inheritance: verified, a spore
   * at slot 5 came back with `isSpore` still 1 and `wBrain` `undefined`. It then germinated into a
   * body whose `wBrain` was undefined, so `placeOrganism` fell through to `randomBrain` — the
   * inherited genome silently replaced by a random one, *and* a draw taken from the world's RNG,
   * which diverges everything after it. Another instance of the `nIntr`-vs-`nMatter` class.
   *
   * Birth weights ride along too: without them a rewind silently turns `inherit: 'birth'` into
   * `'learned'`, so the run does the experiment it was configured not to do.
   */
  const nb = w.brainWeightCount
  for (let b = 0; b < w.nMatter; b++) {
    const wl = w.wLimb[b]
    const wb = w.wBrain[b]
    const bl = w.wBirthLimb[b]
    const bb = w.wBirthBrain[b]
    snap.wHas[b * 4] = wl ? 1 : 0
    snap.wHas[b * 4 + 1] = wb ? 1 : 0
    snap.wHas[b * 4 + 2] = bl ? 1 : 0
    snap.wHas[b * 4 + 3] = bb ? 1 : 0
    if (wl) snap.wLimb.set(wl, b * N_WLIMB)
    if (wb) snap.wBrain.set(wb, b * nb)
    if (bl) snap.wBirthLimb.set(bl, b * N_WLIMB)
    if (bb) snap.wBirthBrain.set(bb, b * nb)
  }
  snap.patchCount = w.patches.length
  for (let i = 0; i < w.patches.length; i++) {
    const p = w.patches[i]
    snap.patches[i * 7] = p.x
    snap.patches[i * 7 + 1] = p.y
    snap.patches[i * 7 + 2] = p.h
    snap.patches[i * 7 + 3] = p.ox
    snap.patches[i * 7 + 4] = p.oy
    snap.patches[i * 7 + 5] = p.dx
    snap.patches[i * 7 + 6] = p.dy
  }
  snap.rng = w.rng.state()
  snap.field.set(w.field)
  const slots = w.freeFoodSlots()
  snap.freeFoodCount = slots.length
  for (let i = 0; i < slots.length; i++) snap.freeFood[i] = slots[i]
  snap.lineageCounter = w.lineageCounter
  // a learner is state like any other: rewinding to before it learned something has to unlearn it
  if (snap.learner.length === w.learner.saveSize()) w.learner.saveInto(snap.learner, 0)
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
  w.matterCursor = snap.scalars[9]
  w.mergeStart = snap.scalars[10] < 0 ? null : snap.scalars[10]
  w.nTemplated = snap.scalars[11]
  w.nSown = snap.scalars[12]
  w.nGerminated = snap.scalars[13]
  w.nConjugated = snap.scalars[14]
  w.lightWasted = snap.scalars[15]
  w.srcV = snap.scalars[16]
  const nb = w.brainWeightCount
  for (let b = 0; b < w.nMatter; b++) {
    w.wLimb[b] = snap.wHas[b * 4] ? snap.wLimb.slice(b * N_WLIMB, (b + 1) * N_WLIMB) : undefined
    w.wBrain[b] = snap.wHas[b * 4 + 1] ? snap.wBrain.slice(b * nb, (b + 1) * nb) : undefined
    w.wBirthLimb[b] = snap.wHas[b * 4 + 2] ? snap.wBirthLimb.slice(b * N_WLIMB, (b + 1) * N_WLIMB) : undefined
    w.wBirthBrain[b] = snap.wHas[b * 4 + 3] ? snap.wBirthBrain.slice(b * nb, (b + 1) * nb) : undefined
  }
  w.patches.length = 0
  for (let i = 0; i < snap.patchCount; i++) {
    w.patches.push({
      x: snap.patches[i * 7], y: snap.patches[i * 7 + 1], h: snap.patches[i * 7 + 2],
      ox: snap.patches[i * 7 + 3], oy: snap.patches[i * 7 + 4],
      dx: snap.patches[i * 7 + 5], dy: snap.patches[i * 7 + 6],
    })
  }
  w.rng.setState(snap.rng)
  w.field.set(snap.field)
  w.setFreeFoodSlots(snap.freeFood.subarray(0, snap.freeFoodCount))
  w.lineageCounter = snap.lineageCounter
  if (snap.learner.length === w.learner.saveSize()) w.learner.loadFrom(snap.learner, 0)
  /*
   * `bonds.count` is re-derived, because `partner` is restored and the counter is not.
   *
   * Verified: a world reporting 98 bonds came back reporting **0** with 98 really there, then 1
   * against a real 99 three hundred ticks later — and it goes *negative* as pre-existing bonds
   * break, since `remove()` decrements unconditionally. The sim worker rewinds constantly and the
   * figure is reported in the stats panel, the recorder and `evaluate`.
   */
  w.bonds.recount(w.cap)
  w.aggregates.reset()
  w.orders.reset()
  w.grid.build()
  return w
}
