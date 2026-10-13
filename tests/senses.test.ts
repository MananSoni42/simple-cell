import { describe, expect, it } from 'vitest'
import { type Init, LAWS, initFromSeed, substepsFor } from '../src/core/params'
import { massByType } from '../src/core/metrics'
import { BRAIN_IN, BRAIN_OUT, N_BRAIN_IN } from '../src/core/neurons'
import { FOOD } from '../src/core/types'

/** Shortest wrapped separation, so a particle that crossed the edge is not credited with 300. */
const minImage = (d: number, size = 300): number => d - size * Math.round(d / size)
import { World } from '../src/core/world'
import { type ReproMode, type WorldSpec, specId, specInit } from '../src/core/catalog'
import { configText, parseConfig } from '../src/ui/config'

/**
 * What an organism can know, and how fast the thing it is chasing runs away.
 *
 * These four cover the gaps found by asking what the brain was structurally incapable of
 * perceiving, rather than what it happened to do badly. Each test is written so that it would
 * have *failed before the change* — the first one in particular is the old behaviour stated as
 * an assertion, which is the only honest way to show that a sense was missing.
 */

function solo(over: Partial<Init> = {}): Init {
  const init = { ...initFromSeed(7), n_intrinsic: 40, n_brain: 2, n_start: 0, n_food0: 0, T: 0, T_food: 1e9, T_spawn: 1e9, repro: false, decay_free: 0, bonds: false, ...over }
  init.A = Array.from({ length: 5 }, () => new Array(5).fill(0)) // no chemistry: only the sense under test
  if (over.substeps === undefined) init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return init
}

/** A brain at the centre of a symmetric ring of food, wired to move on one input alone. */
function inACloud(input: number, weight = 1): number {
  const w = new World(solo(), { laws: { SIZE: 300 }, autoSpawn: false })
  const b = w.nIntr
  w.placeOrganism({ brain: b, x: 150, y: 150, limbs: [] })
  // eight crumbs, evenly spaced, inside the interaction cutoff and outside eating range
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    w.feedAt(150 + 25 * Math.cos(a), 150 + 25 * Math.sin(a))
  }
  w.wBrain[b]!.fill(0)
  w.wBrain[b]![BRAIN_OUT.FX * N_BRAIN_IN + input] = weight
  w.step()
  return w.mvx[b]
}

describe('seeing food you are already inside of', () => {
  it('reads nothing from the food pull, which cancels in a symmetric cloud', () => {
    // This is the old blindness, pinned. The two food-pull inputs are a vector sum, so a feast
    // arranged evenly around an organism is arithmetically identical to an empty desert.
    expect(Math.abs(inACloud(BRAIN_IN.FOOD_X))).toBeLessThan(1e-6)
  })

  it('reads a strong signal from the food count, which cannot cancel', () => {
    const surrounded = inACloud(BRAIN_IN.FOOD_NEAR)
    expect(surrounded).toBeGreaterThan(0.4)
  })

  it('reads less when there is less food around, so the count is graded rather than a flag', () => {
    const w = new World(solo(), { laws: { SIZE: 300 }, autoSpawn: false })
    const b = w.nIntr
    w.placeOrganism({ brain: b, x: 150, y: 150, limbs: [] })
    w.feedAt(150 + 25, 150)
    w.wBrain[b]!.fill(0)
    w.wBrain[b]![BRAIN_OUT.FX * N_BRAIN_IN + BRAIN_IN.FOOD_NEAR] = 1
    w.step()
    const one = w.mvx[b]
    expect(one).toBeGreaterThan(0)
    expect(one).toBeLessThan(inACloud(BRAIN_IN.FOOD_NEAR))
  })
})

describe('food is heavier than life', () => {
  /** RMS displacement of food and of matter over `ticks`, from the same starting positions. */
  function drift(T: number, ticks = 40): { food: number; matter: number; clamped: number } {
    const init = solo({ T, n_intrinsic: 60, foodMoves: true, max_food: 60 })
    const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
    for (let k = 0; k < 60; k++) w.feedAt(((k * 37) % 300) + 0.5, ((k * 113) % 300) + 0.5)
    const x0 = Float64Array.from(w.x)
    const y0 = Float64Array.from(w.y)
    for (let t = 0; t < ticks; t++) w.step()
    const rms = (isFood: boolean): number => {
      let s = 0
      let n = 0
      for (let i = 0; i < w.cap; i++) {
        if (!w.alive[i] || w.owner[i] !== -1) continue
        if ((w.type[i] === FOOD) !== isFood) continue
        const dx = minImage(w.x[i] - x0[i])
        const dy = minImage(w.y[i] - y0[i])
        s += dx * dx + dy * dy
        n++
      }
      return n > 0 ? Math.sqrt(s / n) : 0
    }
    return { food: rms(true), matter: rms(false), clamped: w.nClamped / Math.max(1, w.nSteps) }
  }

  it('drifts a fraction as far as matter does at the same temperature', () => {
    const d = drift(3)
    expect(d.matter).toBeGreaterThan(0)
    expect(d.food).toBeGreaterThan(0) // still wanders: heavy, not nailed down
    // the thermal part scales as sqrt(mu_food) = 0.39; the force part as mu_food itself, and the
    // measured ratio sits a little above 0.39 because core repulsion is shared between them
    expect(d.food / d.matter).toBeLessThan(0.6)
  })

  it('makes no difference in a world already pinned to the step guardrail', () => {
    /*
     * A limit worth stating rather than discovering twice.
     *
     * The guardrail allows `d_max / substeps` of motion per sub-step. At T = 20 the Brownian
     * increment alone wants about 1.1 and the budget is 0.31, so *every* particle is clamped to
     * the same displacement and food is exactly as fast as life no matter what its mobility says.
     * Making food heavy therefore buys nothing above the temperature where the clamp bites — and
     * such a world is not merely hot, it is one where the integrator, not the chemistry, is
     * setting the dynamics. The search already discards worlds that clamp more than 60% of the
     * time; this is why that filter matters.
     */
    const d = drift(20)
    expect(d.clamped).toBeGreaterThan(0.5)
    expect(d.food / d.matter).toBeGreaterThan(0.9)
  })
})

describe('a brain feels its own motion', () => {
  it('reports last tick’s actual displacement, not the force it asked for', () => {
    const w = new World(solo(), { laws: { SIZE: 300 }, autoSpawn: false })
    const b = w.nIntr
    w.placeOrganism({ brain: b, x: 150, y: 150, limbs: [] })
    w.wBrain[b]!.fill(0)
    w.wBrain[b]![BRAIN_OUT.FX * N_BRAIN_IN + BRAIN_IN.BIAS] = 4 // always push +x
    // The force is decided in `think()`, which runs *after* `integrate()`, so a decision is
    // acted on at the start of the next tick and the velocity it produces is read the tick after
    // that. The brain's self-sense is two ticks behind its own intent, which is what makes it a
    // report from the world rather than a copy of the command.
    w.step()
    const before = w.x[b]
    w.step()
    expect(w.lvx[b]).toBeCloseTo(minImage(w.x[b] - before), 9)
    expect(w.lvx[b]).toBeGreaterThan(0)
    expect(Math.abs(w.lvy[b])).toBeLessThan(1e-9) // nothing pushed it sideways
  })
})

describe('silence has a reason', () => {
  it('counts the light it had no room for, instead of quietly dimming the sun', () => {
    const init = solo({ T_food: 1, food_batch: 40, max_food: 4 })
    const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false, maxFood: 4 })
    for (let t = 0; t < 5; t++) w.step()
    expect(w.lightWasted).toBeGreaterThan(0)
  })

  it('counts a reproduction it could not perform, and says which shortage stopped it', () => {
    const init = solo({ repro: true })
    const w = new World(init, { laws: { SIZE: 300 }, autoSpawn: false })
    const b = w.nIntr
    w.placeOrganism({ brain: b, x: 150, y: 150, limbs: [] }) // no limbs to copy
    w.energy[b] = 1000
    w.repCool[b] = 0 // a freshly placed organism waits out its cooldown first
    w.step()
    expect(w.repBlocked.limbless).toBeGreaterThan(0)
  })
})

describe('the physics is searchable, not fixed', () => {
  it('carries a spec’s law dials into the world it builds', () => {
    const spec = {
      seed: 11, A: new Array(14).fill(0.25), slots: 6, matter: 40, metabolism: 1, bondFlow: 0, T: 1,
      foodMode: 'random' as const, foodLevel: 'average' as const, foodRegime: 'steady' as const,
      patches: 1, radius: 30, foodLife: 200, fission: false, scale: 1,
      muFood: 0.4, fMax: 2, kBond: 1.2, fBreak: 8, maxBonds: 6, rEat: 12, eBirth: 30, eRepro: 120, reproMut: 0.15,
    }
    const init = specInit(spec)
    const w = new World(init, { autoSpawn: false })
    expect(w.L.mu_food).toBe(0.4)
    expect(w.L.F_max).toBe(2)
    expect(w.L.F_break).toBe(8)
    expect(w.L.r_eat).toBe(12)
    expect(w.L.E_repro).toBe(120)
    expect(w.bonds.max).toBe(6) // the bond table is sized from the law, so this one must be read early
    expect(init.repro_mut).toBe(0.15)
  })

  it('still hashes a spec with no law dials exactly as it did before they existed', () => {
    // Otherwise every row of the existing catalog gets a new id and a resumed search re-runs all
    // 260,640 worlds. The id is the catalog's primary key; changing it silently is not an option.
    const bare = {
      seed: 11, A: new Array(14).fill(0.25), slots: 6, matter: 40, metabolism: 1, bondFlow: 0, T: 1,
      foodMode: 'random' as const, foodLevel: 'average' as const, foodRegime: 'steady' as const,
      patches: 1, radius: 30, foodLife: 200, fission: false, scale: 1,
    }
    // this value was taken from the implementation at the commit *before* the law dials existed,
    // not from the one under test, which is the only way the assertion means anything
    expect(specId(bare)).toBe('hrbecs1jzq7eq')
    expect(specId({ ...bare, muFood: 0.4 })).not.toBe(specId(bare))
  })

  it('survives a config round-trip, so a searched world can be saved and reopened', () => {
    const init = specInit({
      seed: 3, A: new Array(14).fill(0), slots: 6, matter: 40, metabolism: 1, bondFlow: 0, T: 1,
      foodMode: 'random' as const, foodLevel: 'average' as const, foodRegime: 'steady' as const,
      patches: 1, radius: 30, foodLife: 200, fission: false, scale: 1,
      muFood: 0.4, fBreak: 8, maxBonds: 6,
    })
    const back = parseConfig(configText(init, { backend: 'cpu' } as never)).init
    expect(back.laws).toEqual({ mu_food: 0.4, F_break: 8, max_bonds: 6 })
  })

  it('refuses a law a config file has no business setting', () => {
    // SIZE would desynchronise every array in the world from the grid that indexes it, so the
    // parser is a whitelist. A spread would have accepted it.
    const text = JSON.stringify({ seed: 1, laws: { SIZE: 9, mu_food: 0.4 } })
    expect(parseConfig(text).init.laws).toEqual({ mu_food: 0.4 })
  })
})

/**
 * Two ways of reproducing that the world did not have.
 *
 * Both are tested first and hardest against the **energy ledger and matter conservation**, and
 * that order is deliberate: the first version of fission destroyed about 45 energy a run and
 * nothing but the ledger invariant noticed. A reproduction mode that works but leaks is worse
 * than one that does not work, because it quietly corrupts every measurement taken after it.
 *
 * The behavioural tests run a **known-viable chemistry**, not a random one. My first attempt used
 * `initFromSeed(5)` and asserted that conjugation happens; it does not, because that world is
 * extinct by tick 1,000 and a dead world reproduces by no method at all. A test that cannot
 * distinguish "the feature is broken" from "this world was never alive" is not a test of the
 * feature.
 */
const VIABLE = {
  seed: 4242,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 40, matter: 200, metabolism: 0.5, bondFlow: 0.05, T: 2,
  foodMode: 'patchy' as const, foodLevel: 'average' as const, foodRegime: 'steady' as const,
  patches: 2, radius: 50, foodLife: 250, fission: false, scale: 1,
}
const viable = (mode: ReproMode, over: Partial<WorldSpec> = {}): World =>
  new World(specInit({ ...VIABLE, reproMode: mode, ...over }), {})

/** Runs a world, checking the ledger and the matter count as it goes rather than only at the end. */
function runChecked(w: World, ticks: number): void {
  const mass0 = massByType(w)
  for (let t = 0; t < ticks; t++) {
    w.step()
    if (t % 200 === 0) {
      expect(massByType(w)).toEqual(mass0)
      expect(w.totalEnergy() + w.burned).toBeCloseTo(w.initialEnergy + w.injected, 6)
    }
  }
}

describe('conjugation: two bonded parents, one recombined child', () => {
  it('keeps the energy ledger closed and conserves matter over a long run', () => {
    runChecked(viable('conjugation'), 4000)
  })

  it('produces children with two parents, and records both', () => {
    const w = viable('conjugation')
    for (let t = 0; t < 6000; t++) w.step()
    expect(w.nConjugated).toBeGreaterThan(0)
    let withCoparent = 0
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (w.coparent[b] >= 0) {
        withCoparent++
        expect(w.parent[b]).not.toBe(w.coparent[b]) // two parents, not one counted twice
      }
    }
    expect(withCoparent).toBeGreaterThan(0)
  })

  it('never happens without a bond, however rich the organisms are', () => {
    // No chemistry at all, so nothing can bond. Conjugation must then be *impossible* rather than
    // merely rare, because being bonded is the whole reason this mode fits the world — and the
    // organisms are force-fed so that a failure cannot be blamed on poverty.
    const w = new World(specInit({ ...VIABLE, reproMode: 'conjugation', A: new Array(14).fill(0) }), {})
    for (let t = 0; t < 3000; t++) {
      for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) w.energy[b] = 90
      w.step()
    }
    expect(w.bonds.count).toBe(0)
    expect(w.nConjugated).toBe(0)
    expect(w.nBudded).toBeGreaterThan(0) // it still reproduced, just clonally
  })

  it('is off unless asked for', () => {
    const w = viable('bud')
    for (let t = 0; t < 6000; t++) w.step()
    expect(w.nConjugated).toBe(0)
    expect(w.nBudded).toBeGreaterThan(0)
  })
})

describe('spores: a genome that drifts', () => {
  it('keeps the energy ledger closed and conserves matter', () => {
    runChecked(viable('spore'), 4000)
  })

  it('moves energy from parent to spore and no more', () => {
    const w = viable('spore')
    const b = w.nIntr
    w.placeOrganism({ brain: b, x: 150, y: 150, limbs: [{ idx: 0, quad: 0, angle: 0.5 }] })
    w.energy[b] = 100
    const before = w.totalEnergy()
    expect(w.sowFor(b)).toBe(true)
    expect(w.totalEnergy()).toBeCloseTo(before, 9)
    expect(w.energy[b]).toBeCloseTo(100 - LAWS.E_spore, 9)
    expect(w.nSown).toBe(1)
  })

  it('germinates only where there is food, using the same count the brain reads', () => {
    const w = new World(specInit({ ...VIABLE, reproMode: 'spore', T: 0 }), { autoSpawn: false })
    const b = w.nIntr
    w.placeOrganism({ brain: b, x: 40, y: 40, limbs: [{ idx: 0, quad: 0, angle: 0.5 }] })
    w.energy[b] = 100
    w.sowFor(b)
    const sp = Array.from({ length: w.nIntr }, (_, i) => i).find((i) => w.isSpore[i])!
    // park it somewhere empty, well clear of the patches: it must not wake
    w.x[sp] = 285
    w.y[sp] = 285
    for (let t = 0; t < 20; t++) w.step()
    if (w.isSpore[sp]) {
      // now surround it with food, and it should
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2
        w.feedAt(285 + 18 * Math.cos(a), 285 + 18 * Math.sin(a))
      }
      for (let t = 0; t < 20 && w.isSpore[sp]; t++) w.step()
      expect(w.isSpore[sp]).toBe(0)
      expect(w.owner[sp]).toBeGreaterThanOrEqual(0) // it became the new body's first limb
    }
    expect(w.nGerminated).toBeGreaterThan(0)
  })

  it('is never anybody else’s limb while it carries a genome', () => {
    const w = viable('spore')
    let everSpore = 0
    for (let t = 0; t < 3000; t++) {
      w.step()
      for (let i = 0; i < w.nIntr; i++) {
        if (w.isSpore[i]) {
          everSpore++
          expect(w.owner[i]).toBe(-1)
        }
      }
    }
    expect(everSpore).toBeGreaterThan(0)
    expect(w.nSown).toBeGreaterThan(0)
  })

  it('relieves the scarcity it exists for: the population cap', () => {
    /*
     * The measurement that corrected my own design. I built sowing as a response to crowding —
     * "nowhere to put a child" — and in a world that lives, that never happens: `room` blocked
     * reproduction 0 times and a free *brain slot* blocked it 41,244 times. A spore needs a slot
     * only when it germinates, so it banks a reproduction the cap would otherwise have discarded.
     */
    const plain = viable('bud')
    const sown = viable('spore')
    for (let t = 0; t < 6000; t++) {
      plain.step()
      sown.step()
    }
    expect(plain.repBlocked.slots).toBeGreaterThan(10000)
    expect(sown.nGerminated).toBeGreaterThan(0)
    expect(sown.repBlocked.slots).toBeLessThan(plain.repBlocked.slots / 4)
  })

  it('is off unless asked for', () => {
    const w = viable('bud')
    for (let t = 0; t < 3000; t++) w.step()
    expect(w.nSown).toBe(0)
  })
})
