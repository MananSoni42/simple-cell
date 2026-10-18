import { describe, expect, it } from 'vitest'
import { type WorldSpec, specInit } from '../src/core/catalog'
import { CHECKPOINT_EVERY, RESUME_VERSION, applyTweaks, decodeResume, encodeResume, initId, packResume, tweakDiff } from '../src/core/resume'
import { restoreSnapshot, takeSnapshot } from '../src/core/snapshot'
import { World } from '../src/core/world'

/**
 * Resume points: a world's state in a file, so a run can start at a non-zero tick.
 *
 * The saved run files this project writes carry the configuration and the history but no state, so
 * there has never been anything to resume *from*. Warming up reaches the same place because the
 * world is deterministic, but it costs the compute — roughly half an hour to reach tick 10,000 in a
 * 4x world. These tests pin the three things that make the file trustworthy:
 *
 * 1. a restored world is **bit-identical** to the one that was saved, through a JSON round-trip
 * 2. a state restored against a differently-shaped world is **refused**, not silently mangled
 * 3. a tweak applied at a resume point changes what happens next and nothing about the past
 */

const BASE: WorldSpec = {
  seed: 31,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 40,
  matter: 200,
  metabolism: 0.5,
  bondFlow: 0.05,
  T: 2,
  foodMode: 'patchy',
  foodLevel: 'average',
  foodRegime: 'steady',
  patches: 3,
  radius: 50,
  foodLife: 300,
  fission: true,
  scale: 1,
}

/** Everything that decides the future, as one comparable value. */
const fingerprint = (w: World): string =>
  JSON.stringify([
    w.tick,
    w.burned.toFixed(9),
    w.injected.toFixed(9),
    w.nBirths,
    w.nDeaths,
    Array.from(w.x.subarray(0, 60), (v) => v.toFixed(9)),
    Array.from(w.y.subarray(0, 60), (v) => v.toFixed(9)),
    Array.from(w.energy.subarray(0, 60), (v) => v.toFixed(9)),
    Array.from(w.rows.subarray(0, 60), (v) => v.toFixed(9)),
    w.patches.map((p) => [p.x.toFixed(9), p.y.toFixed(9), p.dx.toFixed(9)]),
  ])

const after = (w: World, n: number): World => {
  for (let t = 0; t < n; t++) w.step()
  return w
}

describe('resume points', () => {
  it('restores a world bit-identically through a JSON round-trip', () => {
    /*
     * Through `JSON.parse(JSON.stringify(...))` on purpose, not by passing the object along. The
     * file is the point of this format, and base64 of a Float64Array is exactly where a lossy
     * encoding would hide — numbers that agree to six decimal places and then diverge.
     */
    const a = after(new World(specInit(BASE)), 600)
    const file = JSON.parse(JSON.stringify(encodeResume(a, takeSnapshot(a))))
    const wanted = fingerprint(after(a, 400))

    const fresh = new World(specInit(BASE))
    const b = restoreSnapshot(fresh.init, decodeResume(file, fresh))
    expect(b.tick).toBe(600)
    expect(fingerprint(after(b, 400))).toBe(wanted)
  })

  it('reaches the same state by warming up as by resuming, because the world is deterministic', () => {
    // This is the claim that lets the slider sit at any tick, with or without a saved point: a
    // warm-up is not an approximation of a resume, it is the same state arrived at slowly.
    const saved = after(new World(specInit(BASE)), 500)
    const file = JSON.parse(JSON.stringify(encodeResume(saved, takeSnapshot(saved))))
    const resumed = restoreSnapshot(new World(specInit(BASE)).init, decodeResume(file, new World(specInit(BASE))))
    const warmed = after(new World(specInit(BASE)), 500)
    expect(fingerprint(resumed)).toBe(fingerprint(warmed))
  })

  it('refuses a resume point taken from a differently shaped world', () => {
    // The failure being guarded against is not a crash. Restoring these arrays against a world
    // with different array lengths produces something that looks fine and is not what was saved.
    const a = after(new World(specInit(BASE)), 200)
    const file = encodeResume(a, takeSnapshot(a))
    expect(() => decodeResume(file, new World(specInit({ ...BASE, matter: 400 })))).toThrow(/different world/)
    expect(() => decodeResume(file, new World(specInit({ ...BASE, slots: 80 })))).toThrow(/different world/)
    expect(() => decodeResume(file, new World(specInit({ ...BASE, scale: 2 })))).toThrow(/different world/)
  })

  it('refuses a resume point written by a different format version', () => {
    // The snapshot layout has already changed twice in this project. A stale file restores without
    // complaint and gives a quietly wrong world, which is worse than one that will not load.
    const a = after(new World(specInit(BASE)), 100)
    const file = { ...encodeResume(a, takeSnapshot(a)), version: RESUME_VERSION - 1 }
    expect(() => decodeResume(file, new World(specInit(BASE)))).toThrow(/format/)
  })

  it('splits a tweak into what may be applied at a resume point and what may not', () => {
    const saved = specInit(BASE)
    const safe = specInit({ ...BASE, T: 6, foodLevel: 'scarce' })
    expect(tweakDiff(saved, safe).refused).toEqual([])
    expect(tweakDiff(saved, safe).allowed.sort()).toContain('T')

    /*
     * The two near misses. `n_intrinsic` is obviously a shape. `inflow` is not obvious at all — it
     * looks like a policy switch and in fact triples the brain allocation, so it changes `nMatter`
     * and `cap`, and `elements` sets the bond table's width through `max(valence)`.
     */
    expect(tweakDiff(saved, specInit({ ...BASE, matter: 400 })).refused).toContain('n_intrinsic')
    expect(tweakDiff(saved, { ...saved, inflow: !saved.inflow }).refused).toContain('inflow')
    expect(tweakDiff(saved, { ...saved, elements: [] }).refused).toContain('elements')
  })

  it('applies a tweak to the future and leaves the past alone', () => {
    /*
     * The experiment the feature exists for: a population that matured under one temperature, met
     * with another at tick 500. The restored world must be identical to the saved one *at* that
     * tick — the tweak is a perturbation, not a different history — and must then diverge.
     */
    const saved = after(new World(specInit(BASE)), 500)
    const file = JSON.parse(JSON.stringify(encodeResume(saved, takeSnapshot(saved))))
    const control = fingerprint(after(new World(specInit(BASE)), 900))

    const w = restoreSnapshot(new World(specInit(BASE)).init, decodeResume(file, new World(specInit(BASE))))
    const atTick = fingerprint(w)
    const applied = applyTweaks(w, specInit({ ...BASE, T: 6 }))
    expect(applied).toContain('T')
    expect(fingerprint(w)).toBe(atTick) // nothing about the state changed, only what governs it
    expect(fingerprint(after(w, 400))).not.toBe(control)
  })

  it('re-derives the laws a tweak reaches, and leaves per-particle chemistry alone', () => {
    // `relaw` has to rebuild what the constructor derived from `init` and never looked at again.
    // It must *not* rewrite per-particle affinity rows: those have drifted from the matrix through
    // replication, and overwriting them would discard the world's history to change a dial.
    const w = after(new World(specInit({ ...BASE, matter: 60, slots: 10 })), 300)
    const rows = Array.from(w.rows.subarray(0, 60))
    const c0 = w.L.c_up
    applyTweaks(w, specInit({ ...BASE, matter: 60, slots: 10, metabolism: 2 }))
    expect(w.L.c_up).toBeCloseTo(c0 * 4, 12) // 2 / 0.5
    expect(Array.from(w.rows.subarray(0, 60))).toEqual(rows)
  })

  it('round-trips through the packed binary form without going near base64', () => {
    /*
     * The form a running world actually saves in: metadata plus one transferable ArrayBuffer, which
     * is what the worker hands the page every 5,000 ticks. Base64 is only for files — on this path
     * it would be 1.37x the bytes built as a string on the simulation thread, stalling the world at
     * every checkpoint.
     */
    const a = after(new World(specInit(BASE)), 300)
    const packed = packResume(a, takeSnapshot(a))
    expect(packed.buffer.byteLength).toBe(packed.meta.sizes.reduce((x, y) => x + y, 0))
    const wanted = fingerprint(after(a, 200))
    const b = restoreSnapshot(new World(specInit(BASE)).init, decodeResume(packed, new World(specInit(BASE))))
    expect(fingerprint(after(b, 200))).toBe(wanted)
  })

  it('gives a world one identity, and two worlds different ones', () => {
    // How a checkpoint finds its way back to the world it belongs to. Strict on purpose: an
    // over-strict id costs a reuse, an under-strict one restores the wrong world.
    expect(initId(specInit(BASE))).toBe(initId(specInit(BASE)))
    expect(initId(specInit(BASE))).not.toBe(initId(specInit({ ...BASE, seed: 32 })))
    expect(initId(specInit(BASE))).not.toBe(initId(specInit({ ...BASE, T: 6 })))
  })

  it('takes checkpoints on a tick schedule a slider can land on', () => {
    // The interval is the step of the control that picks a start tick, so a world must actually
    // pass through the ticks on offer. A wall-clock schedule would not be reproducible.
    expect(CHECKPOINT_EVERY).toBeGreaterThan(0)
    expect(10 * CHECKPOINT_EVERY % CHECKPOINT_EVERY).toBe(0)
  })

  it('carries the food-source axes across a resume, legacy or not', () => {
    // The axes include `srcV`, a cached measurement, and a per-source offset. Both are state: a
    // resume that dropped them would run on a stale source speed and drift.
    for (const motion of ['comet', 'orbit', 'wander'] as const) {
      const spec = { ...BASE, sourceMotion: motion, sourceSpeed: 0.8 }
      const a = after(new World(specInit(spec)), 700)
      expect(a.srcV).toBeGreaterThan(0)
      const file = JSON.parse(JSON.stringify(encodeResume(a, takeSnapshot(a))))
      const b = restoreSnapshot(new World(specInit(spec)).init, decodeResume(file, new World(specInit(spec))))
      expect(b.srcV, `motion ${motion}`).toBe(a.srcV)
      expect(fingerprint(after(b, 300))).toBe(fingerprint(after(a, 300)))
    }
  })
})
