import { N_TRI, REPRO_MODES, TRI, type WorldSpec } from './catalog'
import { QUANTA, type FoodLevel, type FoodMode, type FoodRegime } from './params'
import { Rng } from './rng'
import { N_MATRIX } from './types'

/**
 * Where candidates come from.
 *
 * The draw is deliberately in three parts, and the proportions are an experiment rather than a
 * preference:
 *
 * - **constrained** — the region predicted to be productive: few nonzero couplings, moderate
 *   strengths, self-repulsion on the diagonal. The reasoning is that a dense matrix makes
 *   everything stick to everything (one blob, no selectivity), maximal strengths collapse against
 *   the hard core, and cross-attraction with self-repulsion is what makes sheets rather than
 *   droplets.
 * - **uniform** — the unfiltered quantized draw, as a control. If the constrained half does not
 *   beat it, the prior was wrong, and `analyse.ts` will say so with a standard error attached.
 *   Without this half the search could only confirm itself.
 * - **mutations of elites** — exploitation, once a phase has elites to mutate.
 *
 * The dials now include the **physics and the economics**, not only the chemistry and the food.
 * That multiplies the space by about 10^5, which sounds fatal and is not: this search has always
 * been a sampler rather than an enumerator — 7^14 chemistries was already 6.8 × 10^11 and 260,640
 * worlds covered 4 × 10^-7 of it. What a new dial actually costs is **statistical power per
 * dial**, not coverage, and at a 200,000-world phase every level of every dial still holds tens
 * of thousands of samples. What degrades is the ability to see *interactions* between dials, and
 * that is a real loss to be aware of rather than a reason to keep guessing at constants.
 *
 * Nothing here is clever. A search that samples cleverly and cannot tell whether the cleverness
 * helped has learned less than one that samples plainly.
 */

export type Source = 'constrained' | 'uniform' | 'mutant'

const MATTER = N_MATRIX - 1
const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[rng.int(xs.length)]

/** The dials, as discrete sets, so the catalog's factor analysis has cells with worlds in them. */
const DIALS = {
  metabolism: [0.25, 0.5, 1, 2],
  bondFlow: [0, 0.02, 0.05, 0.15],
  T: [1, 2, 3, 6],
  foodMode: ['patchy', 'random', 'gradient', 'spring', 'comet', 'breathing', 'converging', 'ring'] as FoodMode[],
  foodLevel: ['scarce', 'average', 'abundant'] as FoodLevel[],
  foodRegime: ['steady', 'cycle', 'bloom', 'noisy'] as FoodRegime[],
  patches: [1, 2, 3, 4],
  radius: [30, 50, 70],
  foodLife: [0, 150, 250, 600],
  fission: [true, false],
  /*
   * Physics and economics, previously constants.
   *
   * Every number below was once a judgement call of mine, written into `LAWS` and then never
   * tested against an alternative — and a search that fixes the physics and varies only the
   * chemistry can only find the best world *consistent with my guesses*. Two of those guesses
   * have already been measured wrong by a wide margin (`r_eat` 12 beat 6; `F_break` 2.5 lost
   * four fifths of all standing bonds against 4), which is the whole argument for this block.
   *
   * The levels are chosen around each default, geometrically, so a factor table reads as "an
   * order of magnitude either way" rather than as an arbitrary scatter. Defaults are included so
   * the search can find that the original guess was right.
   */
  /** Food's mobility against everything else's: 1 is the old world, where nothing could be caught. */
  muFood: [0.05, 0.15, 0.4, 1],
  /**
   * How hard a brain can push, which is only meaningful against how hard a bond holds. At
   * `F_max` 1 and `F_break` 4 a bond is four times stronger than any swimmer, so an organism can
   * never pull itself free of a structure or drag one anywhere — which may be exactly why nothing
   * has ever reached "moves together".
   */
  fMax: [0.5, 1, 2, 4],
  kBond: [0.3, 0.6, 1.2],
  fBreak: [2, 4, 8],
  /** 2 admits only chains and rings; 6 allows a particle to sit inside a sheet. */
  maxBonds: [2, 4, 6],
  rEat: [6, 12, 20],
  eBirth: [5, 15, 30],
  eRepro: [30, 60, 120],
  /** The mutation rate: 0 makes heredity exact and evolution impossible. */
  reproMut: [0, 0.02, 0.05, 0.15],
  /**
   * How reproduction works, beyond budding.
   *
   * `bud` is the world as it was, and it is clonal — which meant there was no recombination
   * anywhere: every in-world lineage was a mutation chain, and crossover existed only inside the
   * GA learner, between dead organisms. `conjugation` gives two bonded parents a recombined
   * child; `spore` gives a lineage a way to leave a crowded neighbourhood.
   */
  reproMode: REPRO_MODES,
  eSpore: [15, 30, 60],
  sporeFood: [1, 3, 8],
} as const

/** Which triangle entries are matter-matter, and which of those are the diagonal. */
const KIND = TRI.map(([i, j]) => (i === MATTER || j === MATTER ? 'food' : i === j ? 'self' : 'cross'))

function constrainedMatrix(rng: Rng): number[] {
  const a = new Array<number>(N_TRI).fill(0)
  const crossIdx = KIND.map((k, i) => (k === 'cross' ? i : -1)).filter((i) => i >= 0)
  const selfIdx = KIND.map((k, i) => (k === 'self' ? i : -1)).filter((i) => i >= 0)
  const foodIdx = KIND.map((k, i) => (k === 'food' ? i : -1)).filter((i) => i >= 0)

  // a few cross-attractions, moderate: this is what holds a sheet together
  const nCross = 2 + rng.int(3)
  const shuffled = [...crossIdx]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  for (let k = 0; k < nCross; k++) a[shuffled[k]] = pick(rng, [0.25, 0.5, 0.5, 1])

  // self-repulsion on most types, which is what stops a sheet becoming a droplet
  for (const i of selfIdx) a[i] = rng.next() < 0.75 ? -pick(rng, [0.25, 0.5, 1]) : 0

  // differentiated appetites: some types care about food and others do not, which is the
  // ingredient a feeding layer around an indifferent core would need
  for (const i of foodIdx) a[i] = rng.next() < 0.5 ? pick(rng, [0.25, 0.5, 1]) : pick(rng, [0, 0, -0.25])
  return a
}

const uniformMatrix = (rng: Rng): number[] => Array.from({ length: N_TRI }, () => pick(rng, QUANTA))

function dials(rng: Rng, spec: Partial<WorldSpec> = {}): Omit<WorldSpec, 'seed' | 'A' | 'slots' | 'matter' | 'scale'> {
  return {
    metabolism: spec.metabolism ?? pick(rng, DIALS.metabolism),
    bondFlow: spec.bondFlow ?? pick(rng, DIALS.bondFlow),
    T: spec.T ?? pick(rng, DIALS.T),
    foodMode: spec.foodMode ?? pick(rng, DIALS.foodMode),
    foodLevel: spec.foodLevel ?? pick(rng, DIALS.foodLevel),
    foodRegime: spec.foodRegime ?? pick(rng, DIALS.foodRegime),
    patches: spec.patches ?? pick(rng, DIALS.patches),
    radius: spec.radius ?? pick(rng, DIALS.radius),
    foodLife: spec.foodLife ?? pick(rng, DIALS.foodLife),
    fission: spec.fission ?? pick(rng, DIALS.fission),
    muFood: spec.muFood ?? pick(rng, DIALS.muFood),
    fMax: spec.fMax ?? pick(rng, DIALS.fMax),
    kBond: spec.kBond ?? pick(rng, DIALS.kBond),
    fBreak: spec.fBreak ?? pick(rng, DIALS.fBreak),
    maxBonds: spec.maxBonds ?? pick(rng, DIALS.maxBonds),
    rEat: spec.rEat ?? pick(rng, DIALS.rEat),
    eBirth: spec.eBirth ?? pick(rng, DIALS.eBirth),
    eRepro: spec.eRepro ?? pick(rng, DIALS.eRepro),
    reproMut: spec.reproMut ?? pick(rng, DIALS.reproMut),
    reproMode: spec.reproMode ?? pick(rng, DIALS.reproMode),
    eSpore: spec.eSpore ?? pick(rng, DIALS.eSpore),
    sporeFood: spec.sporeFood ?? pick(rng, DIALS.sporeFood),
  }
}

export interface SampleShape {
  slots: number
  matter: number
  scale: number
}

/** One fresh candidate. `source` is recorded so the prior can be scored against the control. */
export function draw(rng: Rng, shape: SampleShape, source: Source): WorldSpec {
  return {
    seed: rng.int(1e9),
    A: source === 'constrained' ? constrainedMatrix(rng) : uniformMatrix(rng),
    ...shape,
    ...dials(rng),
  }
}

/**
 * A mutant of a known-good world.
 *
 * One or two matrix entries move by one quantum, and one dial is re-rolled. Small steps because
 * the matrix is quantized and a single entry is a large change already — at seven levels, moving
 * one coupling from 0.5 to 1 doubles it.
 */
export function mutate(rng: Rng, parent: WorldSpec): WorldSpec {
  const A = [...parent.A]
  const n = 1 + rng.int(2)
  for (let k = 0; k < n; k++) {
    const i = rng.int(N_TRI)
    const at = QUANTA.indexOf(QUANTA.reduce((best, q) => (Math.abs(q - A[i]) < Math.abs(best - A[i]) ? q : best), QUANTA[0]))
    const step = rng.next() < 0.5 ? -1 : 1
    A[i] = QUANTA[Math.min(QUANTA.length - 1, Math.max(0, at + step))]
  }
  const spec: WorldSpec = { ...parent, A, seed: rng.int(1e9) }
  // one dial re-rolled as well, so a lineage of mutants can drift off its parent's settings
  const which = pick(rng, Object.keys(DIALS) as (keyof typeof DIALS)[])
  return { ...spec, ...dials(rng, { ...spec, [which]: undefined }) }
}

/** The mix a phase draws from: shares that sum to one, with `mutant` ignored when there are none. */
export function mix(rng: Rng, shape: SampleShape, elites: WorldSpec[]): { spec: WorldSpec; source: Source } {
  const r = rng.next()
  if (elites.length > 0 && r < 0.2) {
    return { spec: mutate(rng, pick(rng, elites)), source: 'mutant' }
  }
  // 50/30 constrained to uniform among the rest, which is 5:3 once mutants take their fifth
  const useConstrained = rng.next() < 0.625
  const source: Source = useConstrained ? 'constrained' : 'uniform'
  return { spec: draw(rng, shape, source), source }
}
