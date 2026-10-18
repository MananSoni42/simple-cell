import type { Init } from './params'
import type { Snapshot } from './snapshot'
import { allocSnapshot } from './snapshot'
import { World } from './world'

/**
 * A resume point: a world's complete state at one tick, in a form that survives a file.
 *
 * The run file a summary already writes carries the `init` and the history but **no state**, so
 * there has never been anything to resume *from* — every start was from tick 0. Warming up gets to
 * the same place, because the world is deterministic, but it costs the compute: ~28 minutes to
 * reach tick 10,000 in a 4x world. This is the file that makes it instant.
 *
 * Two design notes worth stating, because both are places this could quietly go wrong.
 *
 * **The `init` travels with the state and is not optional.** A snapshot is a pile of typed arrays
 * whose *meaning* comes entirely from the world they were taken from — how many matter slots, how
 * many brain weights, how big the signal field is. Restoring the arrays against a different `init`
 * does not fail, it produces a world that is subtly not the one that was saved. `check` below is
 * what refuses that.
 *
 * **Format version is on the file.** The snapshot layout has changed twice already during this
 * project (an added per-particle chemistry row, then the food-source offsets, which took the patch
 * stride from 5 to 7). A resume file from before either change would restore garbage silently, so
 * it is rejected by version instead.
 */
export interface ResumeFile {
  kind: 'simplecell-resume'
  version: number
  /** When it was taken, so a list of these is browsable. */
  at: number
  tick: number
  /** The world's own configuration, which is what gives the arrays below their meaning. */
  init: Init
  /** The shape the arrays were written against. A mismatch is a hard error, not a warning. */
  shape: { nMatter: number; nIntr: number; cap: number; brainWeights: number; field: number; patchCount: number }
  /** Everything else, base64-encoded per array. */
  state: Record<string, string> & { scalars: string }
  rng: [number, number | null]
  freeFoodCount: number
  lineageCounter: number
}

/**
 * The format version.
 *
 * Bump this whenever the snapshot layout changes — an added per-particle array, a changed stride.
 * A stale resume file restores without complaint and gives a world that is quietly wrong, which is
 * far worse than one that refuses to load.
 */
export const RESUME_VERSION = 3

const b64 = (buf: ArrayBufferLike, offset = 0, length?: number): string => {
  const bytes = new Uint8Array(buf, offset, length)
  // Chunked, because `String.fromCharCode(...bytes)` on a 20 MB array overflows the argument
  // limit — which is the realistic size here, not a corner case.
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  return btoa(s)
}

const unb64 = (s: string): Uint8Array => {
  const raw = atob(s)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Writes a snapshot into a portable file. */
export function encodeResume(w: World, snap: Snapshot): ResumeFile {
  return {
    kind: 'simplecell-resume',
    version: RESUME_VERSION,
    at: Date.now(),
    tick: snap.tick,
    init: w.init,
    shape: {
      nMatter: w.nMatter,
      nIntr: w.nIntr,
      cap: w.cap,
      brainWeights: w.brainWeightCount,
      field: w.field.length,
      patchCount: snap.patchCount,
    },
    state: {
      bytes: b64(snap.bytes),
      scalars: b64(snap.scalars.buffer, snap.scalars.byteOffset, snap.scalars.byteLength),
      wLimb: b64(snap.wLimb.buffer, snap.wLimb.byteOffset, snap.wLimb.byteLength),
      wBrain: b64(snap.wBrain.buffer, snap.wBrain.byteOffset, snap.wBrain.byteLength),
      wBirthLimb: b64(snap.wBirthLimb.buffer, snap.wBirthLimb.byteOffset, snap.wBirthLimb.byteLength),
      wBirthBrain: b64(snap.wBirthBrain.buffer, snap.wBirthBrain.byteOffset, snap.wBirthBrain.byteLength),
      wHas: b64(snap.wHas.buffer, snap.wHas.byteOffset, snap.wHas.byteLength),
      patches: b64(snap.patches.buffer, snap.patches.byteOffset, snap.patches.byteLength),
      field: b64(snap.field.buffer, snap.field.byteOffset, snap.field.byteLength),
      freeFood: b64(snap.freeFood.buffer, snap.freeFood.byteOffset, snap.freeFood.byteLength),
      learner: b64(snap.learner.buffer, snap.learner.byteOffset, snap.learner.byteLength),
    },
    rng: snap.rng,
    freeFoodCount: snap.freeFoodCount,
    lineageCounter: snap.lineageCounter,
  }
}

/** Reads a resume file back, against a world built from an `init` that must match its shape. */
export function decodeResume(file: ResumeFile, w: World): Snapshot {
  if (file.kind !== 'simplecell-resume') throw new Error('not a resume point')
  if (file.version !== RESUME_VERSION) {
    throw new Error(`that resume point is format ${file.version}, and this build reads ${RESUME_VERSION} — the world's state layout has changed since it was saved`)
  }
  const s = file.shape
  // Checked rather than trusted. Restoring these arrays against a differently-shaped world does
  // not throw on its own; it produces a world that looks fine and is not the one that was saved.
  const got = { nMatter: w.nMatter, nIntr: w.nIntr, cap: w.cap, brainWeights: w.brainWeightCount, field: w.field.length }
  for (const k of ['nMatter', 'nIntr', 'cap', 'brainWeights', 'field'] as const) {
    if (s[k] !== got[k]) throw new Error(`that resume point is for a different world: ${k} ${s[k]}, this one has ${got[k]}`)
  }

  const snap = allocSnapshot(w)
  snap.tick = file.tick
  const into = (key: string, dst: Float64Array | Int32Array | Uint8Array): void => {
    const src = unb64(file.state[key])
    if (src.byteLength !== dst.byteLength) throw new Error(`resume point's ${key} is ${src.byteLength} bytes, expected ${dst.byteLength}`)
    new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength).set(src)
  }
  const raw = unb64(file.state.bytes)
  if (raw.byteLength !== snap.bytes.byteLength) throw new Error(`resume point's particle arrays are ${raw.byteLength} bytes, expected ${snap.bytes.byteLength}`)
  new Uint8Array(snap.bytes).set(raw)
  into('scalars', snap.scalars)
  into('wLimb', snap.wLimb)
  into('wBrain', snap.wBrain)
  into('wBirthLimb', snap.wBirthLimb)
  into('wBirthBrain', snap.wBirthBrain)
  into('wHas', snap.wHas)
  into('patches', snap.patches)
  into('field', snap.field)
  into('freeFood', snap.freeFood)
  into('learner', snap.learner)
  snap.patchCount = s.patchCount
  snap.rng = file.rng
  snap.freeFoodCount = file.freeFoodCount
  snap.lineageCounter = file.lineageCounter
  snap.valid = true
  return snap
}

/**
 * The `init` fields that may differ between a resume point and the world it is restored into.
 *
 * This list is the whole safety story for "re-run a saved world with a tweak from tick N". The
 * state arrays are sized and indexed by the world's shape, so changing anything that decides a
 * shape — how many particles, how big the world, how many brain weights — makes the saved arrays
 * mean something different. Those changes are refused.
 *
 * Everything listed here only affects what happens *next*: what the sun drops and where, how hot
 * the world is, what a thing costs, whether reproduction is allowed. Changing one of those at a
 * resume point is exactly the experiment worth running — a population that matured under static
 * food, met with food that starts moving at tick 8,000.
 */
/*
 * Two near misses worth recording, because both would have passed review.
 *
 * `inflow` looks like a policy switch and is not: it sets `continuous`, which triples the brain
 * allocation and therefore `nMatter` and `cap`. Tweaking it at a resume point would restore the
 * saved arrays into a world with different array lengths.
 *
 * `elements` looks safe because it is only a table of per-type numbers, but the bond table's width
 * is `max(valence)` over that table, fixed at construction. Raising a valence would silently
 * overflow it.
 */
export const TWEAKABLE: readonly (keyof Init)[] = [
  'T',
  'substeps',
  'metabolism',
  'bond_flow',
  'foodMode',
  'foodLevel',
  'foodRegime',
  'foodMoves',
  'sourceMotion',
  'sourceRelation',
  'sourceSpeed',
  'n_patch',
  'r_patch',
  'v_patch',
  'converge_ticks',
  'regime_period',
  'food_batch',
  'food_life',
  'T_food',
  'T_spawn',
  'spawn_batch',
  'decay_free',
  'repro',
  'fission',
  'conjugation',
  'templating',
  'spore',
  'bonds',
  'repro_mut',
  'row_mut',
  'merge_hold',
  'laws',
  'A',
]

/**
 * Which of a world's fields a tweak would change, split into what may be applied at a resume point
 * and what may not.
 *
 * Returned rather than thrown so the UI can say *which* dial is the problem. "You cannot resume
 * with that change" is not useful; "the particle count cannot change at a resume point, and you
 * moved it from 11,200 to 4,000" is.
 */
export function tweakDiff(saved: Init, wanted: Init): { allowed: string[]; refused: string[] } {
  const allowed: string[] = []
  const refused: string[] = []
  const keys = new Set([...Object.keys(saved), ...Object.keys(wanted)]) as Set<keyof Init>
  for (const k of keys) {
    const a = JSON.stringify(saved[k] ?? null)
    const b = JSON.stringify(wanted[k] ?? null)
    if (a === b) continue
    if (TWEAKABLE.includes(k)) allowed.push(k as string)
    else refused.push(k as string)
  }
  return { allowed, refused }
}

/**
 * Applies the allowed part of a tweak to a world that has already been restored.
 *
 * Note the ordering this implies and the reason for it: the world is restored from the resume point
 * under its **original** configuration, and only then do the tweaks take effect. That is the
 * changeover semantics — the saved world developed under the params it developed under, and the
 * tweak is a perturbation applied to a mature population rather than a different history. Applying
 * the tweak first would be a different experiment, and a much less interesting one.
 */
export function applyTweaks(w: World, wanted: Init): string[] {
  const applied: string[] = []
  for (const k of TWEAKABLE) {
    const a = JSON.stringify(w.init[k] ?? null)
    const b = JSON.stringify(wanted[k] ?? null)
    if (a === b) continue
    // `init` is the world's own record of its configuration and several systems read it live, so
    // writing to it is how a changeover happens at all.
    ;(w.init as unknown as Record<string, unknown>)[k] = wanted[k]
    applied.push(k as string)
  }
  if (applied.length > 0) w.relaw()
  return applied
}
