import { describe, expect, it } from 'vitest'
import { N_BRAIN_IN, N_BRAIN_OUT, N_WLIMB } from '../src/core/neurons'
import { BRAIN_SHAPE, type OrganismFile, exportOrganism } from '../src/core/organism'
import { initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'
import { noBootstrap, placeOne } from './helpers'
import { bodyDiagram, reserveBars, weightMap } from '../src/ui/portrait'

/*
 * Placed rather than found. This used to run a small world for 800 ticks and pick the first live
 * brain, which worked only while bodies arrived pre-assembled at tick 0. A body now has to eat its
 * way over an activation barrier and recruit its own limbs, so a small world run briefly often
 * contains nothing — and these tests are about *drawing* a body, not about whether a world can
 * sustain one.
 */
function anOrganism(): OrganismFile {
  const w = new World(noBootstrap({ ...initFromSeed(101), n_start: 0, n_intrinsic: 150, n_brain: 10 }))
  return exportOrganism(w, placeOne(w, 2))!
}

describe('organism portrait', () => {
  it('draws one rod per limb, and never emits a NaN coordinate', () => {
    const o = anOrganism()
    const svg = bodyDiagram(o)
    expect(svg).not.toContain('NaN')
    // one rod line and two discs per limb, plus the four quadrant guides
    expect((svg.match(/<line /g) ?? []).length).toBe(4 + o.limbs.length)
    expect((svg.match(/<circle /g) ?? []).length).toBe(1 + 3 * o.limbs.length)
    for (const l of o.limbs) expect(svg).toContain(`>q${l.quad}<`)
  })

  it('survives an empty body and an over-full reserve without producing nonsense', () => {
    const bare: OrganismFile = {
      version: 2, brain: { ...BRAIN_SHAPE }, at: [0, 0], age: 0, generation: 0, children: 0,
      reserve: 1e6, limbs: [], wLimb: new Array(N_WLIMB).fill(0), wBrain: new Array(N_BRAIN_IN * N_BRAIN_OUT).fill(0),
    }
    const svg = bodyDiagram(bare) + reserveBars(bare) + weightMap(bare)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('Infinity')
    expect((svg.match(/<line /g) ?? []).length).toBe(4) // quadrant guides only
  })

  it('shows a bar per reserve, and marks only the ones that are actually low', () => {
    const o = anOrganism()
    o.reserve = 2 // starving
    o.limbs[0].reserve = 90 // full
    const html = reserveBars(o)
    expect((html.match(/bar-row/g) ?? []).length).toBe(1 + o.limbs.length)
    // red appears for the starving brain; the full limb is drawn in the neutral ink
    expect(html).toContain('#ff6b81')
    expect(html).toContain('#aab4c6')
  })

  it('renders every inherited weight as a cell', () => {
    const o = anOrganism()
    const html = weightMap(o)
    expect((html.match(/<rect /g) ?? []).length).toBe(N_BRAIN_IN * N_BRAIN_OUT + N_WLIMB)
    expect(html).not.toContain('NaN')
  })
})
