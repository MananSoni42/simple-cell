import { describe, expect, it } from 'vitest'
import { type WorldSpec, specId, specInit } from '../src/core/catalog'
import { type Element, type Init, LAWS, elementsOf } from '../src/core/params'
import { configText, parseConfig } from '../src/ui/config'
import { massTotals } from '../src/core/metrics'
import { P1, P2 } from '../src/core/types'
import { World } from '../src/core/world'

/**
 * What makes P1 not P2.
 *
 * Before this, the chemistry matrix was the *only* thing distinguishing the four matter types —
 * size, mass, valence, bond strength and perishability were single global constants shared by
 * everything. Four types differing in one dimension are barely four types.
 *
 * Two things these tests are really guarding. First, that each property has an effect at all, in a
 * direction that makes physical sense. Second, and more important, that **every existing global
 * dial still works**: each one is now the *default* for its per-type field, so a world that says
 * nothing about elements has to behave exactly as it did.
 */
const VIABLE: WorldSpec = {
  seed: 4242,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 40, matter: 200, metabolism: 0.5, bondFlow: 0.05, T: 2,
  foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady',
  patches: 2, radius: 50, foodLife: 250, fission: false, scale: 1,
}

/** Runs a world and reports bonds held per particle of each matter type, plus the ledger. */
function run(els?: (Partial<Element> | undefined)[], ticks = 9000): { held: number[]; bonds: number; closed: boolean; w: World } {
  /*
   * `redraw_kind: 0` — the composition a world starts with is the composition it keeps.
   *
   * Every test here asks a question *about a kind*: does a low valence cap its bonds, does a big
   * radius push its neighbours away. By default a particle returning to the loose pool has its kind
   * drawn again, so a world set up with a known mix drifts toward an even one and the per-kind
   * averages regress toward each other — which is the dial working, and fatal to the measurement.
   * Measured with the drift on: a valence-2 type held 0.318 bonds against a valence-6 type's 0.280,
   * i.e. the wrong way round, because by then the two kinds were the same population.
   */
  const init = { ...specInit(VIABLE), laws: { ...specInit(VIABLE).laws, redraw_kind: 0 } }
  if (els) init.elements = els
  const w = new World(init, {})
  const mass0 = massTotals(w)
  for (let t = 0; t < ticks; t++) w.step()
  expect(massTotals(w)).toEqual(mass0) // totals, since a released particle has its kind drawn again
  const sum = new Array(7).fill(0)
  const n = new Array(7).fill(0)
  for (let i = 0; i < w.nMatter; i++) {
    if (!w.alive[i]) continue
    n[w.type[i]]++
    sum[w.type[i]] += w.bonds.held(i)
  }
  return {
    held: sum.map((h, t) => (n[t] ? h / n[t] : 0)),
    bonds: w.bonds.count,
    closed: Math.abs(w.totalEnergy() + w.burned - w.initialEnergy - w.injected) < 1e-6,
    w,
  }
}

describe('the element table defaults to exactly the old global constants', () => {
  it('reproduces every global dial as a per-type default', () => {
    const els = elementsOf(undefined, LAWS)
    for (const e of els) {
      expect(e.valence).toBe(LAWS.max_bonds)
      expect(e.bondCost).toBe(LAWS.E_bond)
      expect(e.bondStrength).toBe(1)
      expect(e.decay).toBe(0)
      // half the old universal exclusion, so two default particles part at exactly r_0 = beta·r_c
      expect(e.radius * 2).toBeCloseTo(LAWS.beta * LAWS.r_c, 9)
    }
    expect(els[5].mobility).toBe(LAWS.mu_food) // food's entry *is* what mu_food used to be
    expect(els[P1].mobility).toBe(1)
  })

  it('still lets a global law set every type at once', () => {
    const w = new World(specInit({ ...VIABLE, maxBonds: 6, eBirth: 15 }), {})
    expect(w.bonds.max).toBe(6)
    for (const e of w.elements) expect(e.valence).toBe(6)
  })

  it('lets an element override the law for one type only', () => {
    const init = specInit({ ...VIABLE, maxBonds: 6 })
    init.elements = [{ valence: 1 }]
    const w = new World(init, {})
    expect(w.eValence[P1]).toBe(1)
    expect(w.eValence[P2]).toBe(6)
    expect(w.bonds.max).toBe(6) // the table is sized by the widest valence, not the narrowest
  })
})

describe('each property does something, in the direction it should', () => {
  const base = run()

  it('closes the energy ledger whatever the table says', () => {
    for (const els of [undefined, [{ radius: 9 }], [{ mobility: 0.1 }], [{ valence: 1 }], [{ bondStrength: 0.2 }], [{ decay: 0.02 }]]) {
      expect(run(els, 1500).closed, JSON.stringify(els)).toBe(true)
    }
  })

  it('caps how many bonds a low-valence type can hold', () => {
    const r = run([{ valence: 1 }])
    expect(r.held[P1]).toBeLessThan(base.held[P1])
    expect(r.held[P1]).toBeLessThanOrEqual(1)
  })

  it('makes a fragile type hold fewer bonds', () => {
    // bond strength multiplies F_form and F_break, and a bond takes the *weaker* partner — so a
    // fragile type cannot be made structural by what it attaches to
    expect(run([{ bondStrength: 0.2 }]).held[P1]).toBeLessThan(base.held[P1] * 0.6)
  })

  it('makes a big type exclude its neighbours further away', () => {
    /*
     * **The force, not the bond count.** This asserted that a bigger radius leaves fewer standing
     * bonds, and that downstream consequence has now reversed sign three times as the world changed
     * underneath it: 65 against 59 at 9,000 ticks, 42 against 87 at 20,000, and 69 against 49 once
     * the element draw covered Brain. A claim that flips whenever anything moves is not a claim
     * about radius.
     *
     * The mechanism is exact and worth pinning instead: pair exclusion is the **sum of the two
     * radii**, so a particle with a bigger radius pushes back at a distance where a smaller one
     * feels nothing at all. Measured straight off the force kernel, with no world dynamics in the
     * way, so it cannot drift.
     */
    const forceAt = (radius: number | undefined, gap: number): number => {
      const b = specInit(VIABLE)
      const init: Init = { ...b, laws: { ...b.laws, redraw_kind: 0 }, T: 0 }
      if (radius !== undefined) init.elements = [{ radius }]
      const w = new World(init, { autoSpawn: false })
      // two particles of the same kind, `gap` apart, nothing else near them
      for (let i = 0; i < w.nIntr; i++) {
        w.alive[i] = 0
      }
      for (const i of [0, 1]) {
        w.alive[i] = 1
        w.setType(i, P1)
        w.energy[i] = 50
        w.y[i] = 150
      }
      w.x[0] = 150
      w.x[1] = 150 + gap
      w.step()
      // the x-force on the left particle: negative means it is being pushed away from the right one
      return w.fx[0]
    }
    const els = elementsOf([{ radius: 9 }], LAWS)
    expect(els[P1].radius).toBe(9)

    // at a gap inside a big pair's exclusion (18) but outside a default pair's (10)
    const gap = 14
    const big = forceAt(9, gap)
    const small = forceAt(undefined, gap)
    expect(big, `big ${big.toFixed(3)} vs default ${small.toFixed(3)} at gap ${gap}`).toBeLessThan(0)
    expect(Math.abs(big)).toBeGreaterThan(Math.abs(small) * 2)
  })

  it('makes a heavy type *more* bonded, not less', () => {
    /*
     * Worth pinning because it is the opposite of the naive guess. A low-mobility particle is not
     * dragged out of its bonds by the jostling that breaks everything else's, so it accumulates
     * them. Slow matter is structural matter, which is a mechanism this world did not previously
     * have.
     *
     * The *direction* is the claim; the margin is not. It was 2.35 against 0.72 — a factor of 3.3 —
     * when bodies arrived pre-assembled and endowed with energy. Now that a brain has to eat its
     * way over an activation barrier and pay to recruit each limb, there are fewer bonds in the
     * world to redistribute, and the same effect measures 0.77 against 0.60. Asserting the old
     * factor would be asserting the old world.
     */
    expect(run([{ mobility: 0.1 }]).held[P1]).toBeGreaterThan(base.held[P1] * 1.15)
  })
})

describe('an element table survives the round trips it has to', () => {
  it('travels in a spec, and changes the spec id', () => {
    const plain = { ...VIABLE }
    const varied: WorldSpec = { ...VIABLE, elements: [{ valence: 2, mobility: 0.3 }] }
    expect(specId(varied)).not.toBe(specId(plain))
    expect(specInit(varied).elements?.[0]?.valence).toBe(2)
  })

  it('hashes the same table identically however its keys were written', () => {
    // the canonical field order is what makes this true; without it two equal tables written in
    // different key orders would be two different worlds as far as the catalog is concerned
    const a: WorldSpec = { ...VIABLE, elements: [{ valence: 2, mobility: 0.3 }] }
    const b: WorldSpec = { ...VIABLE, elements: [{ mobility: 0.3, valence: 2 }] }
    expect(specId(a)).toBe(specId(b))
  })

  it('survives a config round-trip with every field clamped', () => {
    const init = specInit(VIABLE)
    init.elements = [{ radius: 7, mobility: 0.4, valence: 3, bondStrength: 2, bondCost: 0.5, decay: 0.01 }]
    const back = parseConfig(configText(init, { backend: 'cpu' } as never)).init
    expect(back.elements?.[0]).toEqual({ radius: 7, mobility: 0.4, valence: 3, bondStrength: 2, bondCost: 0.5, decay: 0.01 })
  })

  it('refuses values that would break the integrator', () => {
    /*
     * Not preferences — bounds. A radius of zero lets particles sit on top of each other, and the
     * pair force as `r -> 0` is where an integrator goes to die. A mobility of ten clears the step
     * guardrail on every tick, so the clamp rather than the chemistry would set the dynamics.
     */
    const text = JSON.stringify({ seed: 1, elements: [{ radius: 0, mobility: 100, valence: 99 }] })
    const e = parseConfig(text).init.elements?.[0]
    expect(e?.radius).toBe(0.5)
    expect(e?.mobility).toBe(4)
    expect(e?.valence).toBe(8)
  })
})
