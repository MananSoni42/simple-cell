import type { Init } from './params'
import type { Snapshot } from './snapshot'
import { allocSnapshot } from './snapshot'
import { World } from './world'

/**
 * Checkpoints: a world's complete state at one tick, in a form that survives a file and a database.
 *
 * The run files this project writes carry the configuration and the history but **no state**, so a
 * saved world has only ever been startable from tick 0. These are what make a non-zero start
 * possible, and the rule is that a start tick must be *backed by a checkpoint* — there is no
 * compute-ahead path. A run that offered to "warm up" to tick 10,000 by computing it was offering
 * half an hour of watching a progress bar dressed up as a feature; a world saves its own
 * checkpoints as it runs instead, and the next run starts from one of those.
 *
 * Two design notes, because both are places this could quietly go wrong.
 *
 * **The `init` travels with the state and is not optional.** A snapshot is a pile of typed arrays
 * whose *meaning* comes entirely from the world they were taken from — how many matter slots, how
 * many brain weights, how big the signal field is. Restoring the arrays against a different `init`
 * does not fail, it produces a world that is subtly not the one that was saved. `decodeResume`
 * refuses that.
 *
 * **Format version is on the file.** The snapshot layout has changed twice already during this
 * project (an added per-particle chemistry row, then the food-source offsets, which took the patch
 * stride from 5 to 7). A checkpoint from before either change would restore garbage silently, so
 * it is rejected by version instead.
 */

/**
 * The format version.
 *
 * Bump this whenever the snapshot layout changes — an added per-particle array, a changed stride.
 * A stale checkpoint restores without complaint and gives a world that is quietly wrong, which is
 * far worse than one that refuses to load.
 */
export const RESUME_VERSION = 4

/** How often a running world saves itself. Also the step of the slider that picks a start tick. */
export const CHECKPOINT_EVERY = 5000

/** Everything about a checkpoint except the bytes. Small enough to list without loading state. */
export interface ResumeMeta {
  kind: 'simplecell-resume'
  version: number
  at: number
  tick: number
  /** The world's own configuration, which is what gives the state its meaning. */
  init: Init
  /** The shape the arrays were written against. A mismatch is a hard error, not a warning. */
  shape: { nMatter: number; nIntr: number; cap: number; brainWeights: number; field: number; patchCount: number }
  rng: [number, number | null]
  freeFoodCount: number
  lineageCounter: number
  /** Byte length of each section of the packed buffer, in `SECTIONS` order. */
  sizes: number[]
}

/**
 * A packed checkpoint: metadata plus one buffer.
 *
 * One buffer rather than a field per array, because this is handed from the simulation worker to
 * the page every few thousand ticks and is tens of megabytes for a world with thousands of brains.
 * A single `ArrayBuffer` is *transferable* — it moves without being copied — and IndexedDB stores
 * it natively. The base64-per-array form this replaced was both 1.37x larger and had to be built
 * as a string on the worker thread, which would stall the simulation at every checkpoint.
 */
export interface PackedResume {
  meta: ResumeMeta
  buffer: ArrayBuffer
}

/** A checkpoint as a file: the same thing, with the buffer base64'd so it can live in JSON. */
export interface ResumeFile extends ResumeMeta {
  state: string
}

/**
 * The snapshot's sections, in a fixed order.
 *
 * Order is the format. Adding a section or reordering these changes what the packed bytes mean, so
 * either demands a `RESUME_VERSION` bump — the same discipline as the `views()` list in snapshot.ts,
 * and for the same reason: a mismatch here does not throw, it restores a different world.
 */
const SECTIONS = ['bytes', 'scalars', 'wLimb', 'wBrain', 'wBirthLimb', 'wBirthBrain', 'wHas', 'patches', 'field', 'freeFood', 'learner'] as const

const sectionsOf = (snap: Snapshot): (ArrayBufferLike | Float64Array | Int32Array | Uint8Array)[] => [
  snap.bytes,
  snap.scalars,
  snap.wLimb,
  snap.wBrain,
  snap.wBirthLimb,
  snap.wBirthBrain,
  snap.wHas,
  snap.patches,
  snap.field,
  snap.freeFood,
  snap.learner,
]

const bytesOf = (v: ArrayBufferLike | Float64Array | Int32Array | Uint8Array): Uint8Array =>
  v instanceof ArrayBuffer
    ? new Uint8Array(v)
    : new Uint8Array((v as Float64Array).buffer, (v as Float64Array).byteOffset, (v as Float64Array).byteLength)

/** Packs a snapshot into metadata plus one transferable buffer. */
export function packResume(w: World, snap: Snapshot): PackedResume {
  const parts = sectionsOf(snap).map(bytesOf)
  const sizes = parts.map((p) => p.byteLength)
  const buffer = new ArrayBuffer(sizes.reduce((a, b) => a + b, 0))
  const out = new Uint8Array(buffer)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return {
    meta: {
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
      rng: snap.rng,
      freeFoodCount: snap.freeFoodCount,
      lineageCounter: snap.lineageCounter,
      sizes,
    },
    buffer,
  }
}

const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf)
  // Chunked, because `String.fromCharCode(...bytes)` on a 20 MB array overflows the argument
  // limit — which is the realistic size here, not a corner case.
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  return btoa(s)
}

const unb64 = (s: string): ArrayBuffer => {
  const raw = atob(s)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out.buffer
}

/** A packed checkpoint as JSON, for downloading. */
export const toResumeFile = (p: PackedResume): ResumeFile => ({ ...p.meta, state: b64(p.buffer) })

/** A downloaded checkpoint, back in packed form. */
export const fromResumeFile = (f: ResumeFile): PackedResume => ({ meta: f, buffer: unb64(f.state) })

/** Writes a snapshot straight to a file. */
export const encodeResume = (w: World, snap: Snapshot): ResumeFile => toResumeFile(packResume(w, snap))

/** Reads a checkpoint back, against a world built from an `init` that must match its shape. */
export function decodeResume(packed: PackedResume | ResumeFile, w: World): Snapshot {
  const p: PackedResume = 'state' in packed ? fromResumeFile(packed) : packed
  const meta = p.meta
  if (meta.kind !== 'simplecell-resume') throw new Error('not a checkpoint')
  if (meta.version !== RESUME_VERSION) {
    throw new Error(
      `that checkpoint is format ${meta.version}, and this build reads ${RESUME_VERSION} — the world's state layout has changed since it was saved`,
    )
  }
  const s = meta.shape
  // Checked rather than trusted. Restoring these arrays against a differently-shaped world does
  // not throw on its own; it produces a world that looks fine and is not the one that was saved.
  const got = { nMatter: w.nMatter, nIntr: w.nIntr, cap: w.cap, brainWeights: w.brainWeightCount, field: w.field.length }
  for (const k of ['nMatter', 'nIntr', 'cap', 'brainWeights', 'field'] as const) {
    if (s[k] !== got[k]) throw new Error(`that checkpoint is for a different world: ${k} ${s[k]}, this one has ${got[k]}`)
  }

  const snap = allocSnapshot(w)
  snap.tick = meta.tick
  const src = new Uint8Array(p.buffer)
  const dsts = sectionsOf(snap).map(bytesOf)
  let at = 0
  for (let i = 0; i < SECTIONS.length; i++) {
    const want = dsts[i].byteLength
    if (meta.sizes[i] !== want) throw new Error(`that checkpoint's ${SECTIONS[i]} is ${meta.sizes[i]} bytes, expected ${want}`)
    dsts[i].set(src.subarray(at, at + want))
    at += want
  }
  if (at !== src.byteLength) throw new Error(`that checkpoint is ${src.byteLength} bytes, expected ${at}`)
  snap.patchCount = s.patchCount
  snap.rng = meta.rng
  snap.freeFoodCount = meta.freeFoodCount
  snap.lineageCounter = meta.lineageCounter
  snap.valid = true
  return snap
}

/**
 * A stable identity for a world configuration, so a checkpoint can be matched to the world it
 * belongs to.
 *
 * The *whole* `init` goes into it, deliberately. A checkpoint is only valid for a world identical
 * to the one it was taken from, and narrowing this to "the fields that matter" would be a second
 * place to get that judgement wrong. An over-strict id costs a checkpoint that could have been
 * reused; an under-strict one restores the wrong world. Only one of those is recoverable.
 */
export function initId(init: Init): string {
  const s = JSON.stringify(init)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = ((h1 ^ s.charCodeAt(i)) * 0x01000193) >>> 0
    h2 = ((h2 + s.charCodeAt(i)) * 0x85ebca6b) >>> 0
  }
  return `${h1.toString(36)}${h2.toString(36)}`
}

/*
 * Two near misses worth recording, because both would have passed review.
 *
 * `inflow` looks like a policy switch and is not: it sets `continuous`, which triples the brain
 * allocation and therefore `nMatter` and `cap`. Tweaking it at a checkpoint would restore the
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
 * Which of a world's fields a tweak would change, split into what may be applied at a checkpoint
 * and what may not.
 *
 * Returned rather than thrown so the UI can say *which* dial is the problem. "You cannot resume
 * with that change" is not useful; "the particle count cannot change at a checkpoint, and you
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
 * Note the ordering this implies and the reason for it: the world is restored from the checkpoint
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
