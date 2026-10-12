import { type OrganismFile, exportOrganism } from './organism'
import { type FitnessSpec, describeSpec } from './fitness'
import { LEARN_DEFAULTS, type LearnAlgo, type LearnerStatus } from './learning'
import type { Init } from './params'
import { World } from './world'

/**
 * One island: a world run on its own, whose survivors are kept.
 *
 * Islands exist because the interesting question is not "what does a learner do" but "what do
 * *different* learners, in different worlds, produce — and what happens when those products are
 * put in one place". That needs several worlds run to completion, which is embarrassingly
 * parallel: a whole run per core, no shared state, and determinism preserved exactly because each
 * world is seeded and self-contained. Splitting the *forces* of one world across cores was
 * measured at about 2× (half a tick is serial); splitting *runs* is linear in cores.
 */

export interface IslandSpec {
  /** Which island this is. 1-based: 0 is reserved for "born in the merged world". */
  id: number
  name: string
  /** The world, which must share chemistry and terrain with its siblings — see `archipelago`. */
  init: Init
  ticks: number
}

export interface IslandResult {
  id: number
  name: string
  ticks: number
  /** Everything still alive at the end, as files that can be placed into another world. */
  survivors: OrganismFile[]
  /** Where the population sat, so it can be recentred when transplanted. */
  centroid: [number, number]
  learner: LearnerStatus | null
  measure: string
  foodMode: string
  seed: number
  census: { organisms: number; births: number; budded: number; deaths: number; maxGen: number; recordAge: number }
  /** True when the island emptied out: a merge of three populations is not a merge of four. */
  diedOut: boolean
}

/** Runs one island to completion. Pure: no workers, no messages — the parallel layer wraps this. */
export function runIsland(spec: IslandSpec): IslandResult {
  const w = new World(spec.init)
  for (let t = 0; t < spec.ticks; t++) w.step()

  const survivors: OrganismFile[] = []
  let sx = 0
  let sy = 0
  let maxGen = 0
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.alive[b] || !w.isBrain(b)) continue
    const file = exportOrganism(w, b)
    if (!file) continue
    // the island is part of where an organism came from, so it survives the trip
    file.from = { ...file.from!, island: spec.id, islandName: spec.name, measure: describeSpec(spec.init.learn.fitness) }
    survivors.push(file)
    sx += w.x[b]
    sy += w.y[b]
    maxGen = Math.max(maxGen, w.gen[b])
  }
  const n = Math.max(1, survivors.length)
  return {
    id: spec.id,
    name: spec.name,
    ticks: spec.ticks,
    survivors,
    centroid: [sx / n, sy / n],
    learner: spec.init.learn.algo === 'none' ? null : w.learner.status(),
    measure: describeSpec(spec.init.learn.fitness),
    foodMode: spec.init.foodMode,
    seed: spec.init.seed,
    census: {
      organisms: survivors.length,
      births: w.nBirths,
      budded: w.nBudded,
      deaths: w.nDeaths,
      maxGen,
      recordAge: w.recordAge,
    },
    diedOut: survivors.length === 0,
  }
}

export interface ArchipelagoPlan {
  /** The shared world: chemistry, terrain, temperature. Islands may differ only in what follows. */
  base: Init
  islands: { name: string; foodMode: Init['foodMode']; foodLevel: Init['foodLevel']; foodRegime: Init['foodRegime']; algo: LearnAlgo; fitness: FitnessSpec; seed: number }[]
  ticks: number
  /** Ticks for the merged world to draw the four populations together. */
  convergeTicks: number
}

/**
 * Four island worlds that differ in the ways that produce different *organisms*, and in no other
 * way.
 *
 * **Chemistry and terrain are shared, and that is not a simplification — it is what makes the
 * merge mean anything.** The matrix is a law of a world, and a merged world can only have one. An
 * organism evolved under a different matrix arrives under different physics: its limb types no
 * longer mean what they meant, and everything it learned about holding together is wrong. So the
 * islands differ in food, in what their learner optimises, and in seed, which is exactly the set
 * of differences that shape *behaviour* rather than invalidate it.
 */
export function islandSpecs(plan: ArchipelagoPlan): IslandSpec[] {
  return plan.islands.map((i, k) => ({
    id: k + 1,
    name: i.name,
    ticks: plan.ticks,
    init: {
      ...plan.base,
      seed: i.seed,
      foodMode: i.foodMode,
      foodLevel: i.foodLevel,
      foodRegime: i.foodRegime,
      learn: { ...LEARN_DEFAULTS, ...plan.base.learn, algo: i.algo, fitness: i.fitness },
    },
  }))
}

/**
 * The merged world: four quadrants, four populations, and food that migrates inward.
 *
 * The populations are *drawn* together rather than placed in contact — organisms only move because
 * of food, so converging colonies starting at the quadrant centres make hunger do the work, and
 * the run passes through isolation, frontier contact, and one contested pool. Each island's
 * survivors are recentred on their own centroid before being placed, which keeps whatever
 * structure they had formed intact while discarding the island's own wrap-around.
 *
 * Bonds are deliberately **not** transplanted. A compound that re-forms after the merge is
 * evidence that the chemistry and the brains support it; one that arrives pre-assembled is an
 * assumption dressed as a result.
 *
 * The merged world runs with **no learner**, so what happens is the world adjudicating between
 * four stated preferences rather than an optimiser continuing to push one.
 */
export function mergeIslands(plan: ArchipelagoPlan, results: IslandResult[], scale = 2): Init {
  const base = plan.base
  const islandSize = base.size
  const size = islandSize * scale
  const quads: [number, number][] = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ]

  const seededOrganisms: Init['seededOrganisms'] = []
  const origins: [number, number][] = []
  results.forEach((r, k) => {
    const [qx, qy] = quads[k % quads.length]
    const cx = qx * size
    const cy = qy * size
    const [ox, oy] = r.centroid
    origins.push([cx, cy])
    for (const o of r.survivors) {
      // relative to its own population's centre, on the island's torus, then into the quadrant
      const dx = ((o.at[0] - ox + islandSize * 1.5) % islandSize) - islandSize / 2
      const dy = ((o.at[1] - oy + islandSize * 1.5) % islandSize) - islandSize / 2
      seededOrganisms.push({
        organism: o,
        x: Math.min(size - 1, Math.max(0, cx + dx)),
        y: Math.min(size - 1, Math.max(0, cy + dy)),
        island: r.id,
      })
    }
  })

  const brains = Math.max(16, Math.ceil(seededOrganisms.length * 1.5))
  return {
    ...base,
    seed: base.seed ^ 0x5eed,
    scale: base.scale * scale,
    size,
    // four colonies that start where the populations are and migrate into one
    foodMode: 'converging',
    foodLevel: 'average',
    foodRegime: 'steady',
    n_patch: 4,
    // the colonies begin on top of the populations and migrate inward from there
    patchOrigins: origins,
    r_patch: Math.round(islandSize * 0.18),
    converge_ticks: plan.convergeTicks,
    food_life: 250,
    max_food: Math.round(base.max_food * scale * scale),
    n_food0: Math.round(base.max_food * scale * scale * 0.25),
    food_batch: base.food_batch * scale * scale,
    // the population arrives rather than being generated
    n_start: 0,
    n_intrinsic: base.n_intrinsic * scale * scale,
    n_brain: brains,
    T_spawn: 1e9,
    wallPositions: [],
    walls: 'none',
    n_wall: 0,
    seededFood: [],
    seededOrganisms,
    islandNames: ['native', ...results.map((r) => r.name)],
    // held, so that whoever opens this world chooses the moment the populations meet
    merge_hold: true,
    // no learner: the merged world is where the world decides, not where an optimiser does
    learn: { ...LEARN_DEFAULTS, algo: 'none' },
  }
}
