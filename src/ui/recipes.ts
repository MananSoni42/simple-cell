import { LEARN_DEFAULTS } from '../core/learning'
import { specFromKeys } from '../core/fitness'
import { type FoodLevel, type FoodMode, type FoodRegime, type Init, LAWS, applyFoodLevel, applyQuantization, applyWallStamp, initFromSeed, quantize, substepsFor } from '../core/params'
import { Rng } from '../core/rng'
import { N_MATRIX } from '../core/types'

/**
 * Two dials instead of a list of worlds.
 *
 * A named preset has a fixed chemistry, so re-rolling it changes almost nothing — eleven buttons
 * gave eleven worlds. A *character* instead describes what the matter wants to do and leaves the
 * details to the seed, so one chip gives endless worlds that still share a nature. Crossed with a
 * world character, five chips either side plus a seed cover far more ground than a list ever
 * could, and each one is describable in a sentence before you press anything.
 */

const FOOD = N_MATRIX - 1

export interface Chemistry {
  key: string
  name: string
  blurb: string
  /** What this chemistry wants, in words, so a choice can be understood before it is run. */
  describe(): string
  matrix(rng: Rng): number[][]
}

function blank(): number[][] {
  return Array.from({ length: N_MATRIX }, () => new Array<number>(N_MATRIX).fill(0))
}

function set(A: number[][], i: number, j: number, v: number): void {
  const q = quantize(v)
  A[i][j] = q
  A[j][i] = q
}

/** A shuffled list of the four matter types, so a character does not always use the same ones. */
function types(rng: Rng): number[] {
  const t = [0, 1, 2, 3]
  for (let i = 3; i > 0; i--) {
    const j = rng.int(i + 1)
    ;[t[i], t[j]] = [t[j], t[i]]
  }
  return t
}

const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[rng.int(xs.length)]

export const CHEMISTRIES: Chemistry[] = [
  {
    key: 'sticky',
    name: 'Sticky',
    blurb: 'two kinds cling to each other and avoid their own — the way to get sheets rather than blobs',
    describe: () => 'opposites attract, like repels like — so matter spreads into sheets and membranes instead of collapsing into a ball',
    matrix: (rng) => {
      const A = blank()
      const [a, b, c, d] = types(rng)
      set(A, a, b, pick(rng, [0.5, 1, 1]))
      set(A, a, a, -pick(rng, [0.25, 0.5, 1]))
      set(A, b, b, -pick(rng, [0.25, 0.5, 1]))
      set(A, c, d, pick(rng, [0.25, 0.5]))
      set(A, a, FOOD, pick(rng, [0.5, 1]))
      set(A, c, FOOD, pick(rng, [-0.5, 0, 0.25]))
      return applyQuantization(A)
    },
  },
  {
    key: 'clumpy',
    name: 'Clumpy',
    blurb: 'nearly everything attracts nearly everything — dense droplets that hold a lot together',
    describe: () => 'almost every pairing pulls, so matter gathers into dense droplets; expect big clusters and plenty of bonds',
    matrix: (rng) => {
      const A = blank()
      for (let i = 0; i < FOOD; i++) {
        for (let j = i; j < FOOD; j++) set(A, i, j, pick(rng, [0.25, 0.5, 0.5, 1]))
      }
      const [a, b] = types(rng)
      set(A, a, FOOD, pick(rng, [0.5, 1]))
      set(A, b, FOOD, pick(rng, [-0.25, 0, 0.5]))
      return applyQuantization(A)
    },
  },
  {
    key: 'chains',
    name: 'Chains',
    blurb: 'each kind likes only the next, so matter strings together instead of piling up',
    describe: () => 'a ring of preferences — the first likes the second, the second the third — so matter strings into filaments and arcs',
    matrix: (rng) => {
      const A = blank()
      const t = types(rng)
      for (let k = 0; k < 3; k++) set(A, t[k], t[k + 1], pick(rng, [0.5, 1, 1]))
      for (const i of t) set(A, i, i, -pick(rng, [0.5, 1]))
      set(A, t[0], FOOD, pick(rng, [0.5, 1]))
      set(A, t[3], FOOD, pick(rng, [-0.5, 0.25]))
      return applyQuantization(A)
    },
  },
  {
    key: 'hungry',
    name: 'Hungry',
    blurb: 'matter barely notices itself but chases food hard — movement matters more than structure',
    describe: () => 'strong appetites and weak attachments: organisms chase food and build little, so what happens is behaviour rather than structure',
    matrix: (rng) => {
      const A = blank()
      const t = types(rng)
      for (const i of t) set(A, i, FOOD, pick(rng, [0.5, 1, 1]))
      set(A, t[0], t[1], pick(rng, [-0.25, 0, 0.25]))
      set(A, t[2], t[2], -pick(rng, [0.25, 0.5]))
      return applyQuantization(A)
    },
  },
  {
    key: 'random',
    name: 'Random',
    blurb: 'no character at all — fifteen numbers drawn at random, which is what the world did before these dials existed',
    describe: () => 'fifteen numbers drawn at random: no character was chosen for this matter, so whatever it does is luck rather than design',
    matrix: (rng) => {
      const A = blank()
      for (let i = 0; i < N_MATRIX; i++) {
        for (let j = i; j < N_MATRIX; j++) {
          if (i === FOOD && j === FOOD) continue
          set(A, i, j, rng.next() * 2 - 1)
        }
      }
      return applyQuantization(A)
    },
  },
  {
    key: 'skittish',
    name: 'Skittish',
    blurb: 'mostly repulsion, with one or two exceptions that have to carry everything',
    describe: () => 'mostly mutual repulsion, so matter stays spread thin and whatever does hold together is doing it against the grain',
    matrix: (rng) => {
      const A = blank()
      const t = types(rng)
      for (let i = 0; i < FOOD; i++) {
        for (let j = i; j < FOOD; j++) set(A, i, j, -pick(rng, [0.25, 0.5, 1]))
      }
      set(A, t[0], t[1], 1)
      set(A, t[0], FOOD, pick(rng, [0.5, 1]))
      return applyQuantization(A)
    },
  },
]

export interface WorldKind {
  key: string
  name: string
  blurb: string
  describe(): string
  apply(init: Init, rng: Rng): void
}

export const WORLD_KINDS: WorldKind[] = [
  {
    key: 'plenty',
    name: 'Plenty',
    blurb: 'food everywhere, more than anything can eat',
    describe: () => 'food arrives everywhere, faster than it can be eaten — nothing has to go looking, so whatever happens is not about hunger',
    apply: (init, rng) => {
      init.foodMode = 'random'
      init.foodLevel = 'average'
      init.foodRegime = 'steady'
      init.food_life = pick(rng, [0, 400, 800])
    },
  },
  {
    key: 'patchy',
    name: 'Patches',
    blurb: 'a few drifting hot-spots worth travelling to',
    describe: () => 'food collects in a few drifting patches, so finding one and staying with it is worth more than wandering',
    apply: (init, rng) => {
      init.foodMode = 'patchy'
      init.foodLevel = 'average'
      init.foodRegime = 'steady'
      init.n_patch = 1 + rng.int(3)
      init.r_patch = 35 + rng.int(40)
      init.food_life = 150 + rng.int(200)
    },
  },
  {
    key: 'harsh',
    name: 'Harsh',
    blurb: 'barely enough, and only in one place',
    describe: () => 'barely any food, and only where the light falls — most things starve, and position decides which do not',
    apply: (init, rng) => {
      init.foodMode = pick(rng, ['gradient', 'spring'] as FoodMode[])
      init.foodLevel = 'scarce'
      init.foodRegime = 'steady'
      init.food_life = 100 + rng.int(120)
      init.decay_free = 0.004
      init.r_patch = 45 + rng.int(25)
    },
  },
  {
    key: 'pulsing',
    name: 'Pulsing',
    blurb: 'famine and glut, over and over',
    describe: () => 'food swings between famine and glut, so nothing can live on the average — only on the swing',
    apply: (init, rng) => {
      init.foodMode = pick(rng, ['patchy', 'random'] as FoodMode[])
      init.foodLevel = 'average'
      init.foodRegime = pick(rng, ['cycle', 'cycle', 'bloom'] as FoodRegime[])
      init.regime_period = 1500 + rng.int(2500)
      init.food_life = 150 + rng.int(150)
    },
  },
  {
    key: 'drifting',
    name: 'Drifting',
    blurb: 'separate colonies that meet, and sometimes part again',
    describe: () => 'food gathers into separate colonies that migrate together — populations grow up apart, then meet',
    apply: (init, rng) => {
      init.foodMode = pick(rng, ['converging', 'breathing', 'breathing'] as FoodMode[])
      init.foodLevel = 'average'
      init.foodRegime = 'steady'
      init.n_patch = 2 + rng.int(3)
      init.converge_ticks = 2500 + rng.int(4000)
      init.r_patch = 45 + rng.int(25)
      init.food_life = 200 + rng.int(150)
    },
  },
]

export interface Recipe {
  chemistry: string
  world: string
  seed: number
  scale: number
  /** Terrain is a separate small choice because it changes the shape of a world, not its economy. */
  terrain?: Init['walls']
}

export const DEFAULT_RECIPE: Recipe = { chemistry: 'sticky', world: 'patchy', seed: 7, scale: 1, terrain: 'none' }

/**
 * A world worth watching, with nothing chosen.
 *
 * `random` chemistry is excluded for the same reason as Skittish and Plenty: it is the unfiltered
 * draw, which is exactly what the dials exist to improve on. It stays available as a chip for
 * anyone who wants the old behaviour back.
 *
 * The default path through the app has no settings at all, so this is where the quality of a first
 * impression is decided. The draw is deliberately not uniform: Skittish worlds are interesting to
 * study but look like a thin gas, and Plenty removes the pressure that makes anything happen at
 * all. Neither is ever rolled for you — both stay one click away in the builder. What is left are
 * the combinations that visibly build something within a few hundred ticks.
 */
export function randomRecipe(seed = Math.floor(Math.random() * 1e9)): Recipe {
  const rng = new Rng((seed ^ 0x5bf03635) | 0)
  const chemistry = pick(rng, ['sticky', 'sticky', 'sticky', 'clumpy', 'clumpy', 'chains', 'chains', 'hungry'])
  const world = pick(rng, ['patchy', 'patchy', 'patchy', 'pulsing', 'drifting', 'drifting', 'harsh'])
  const terrain = pick(rng, ['none', 'none', 'none', 'pillars', 'maze'] as Init['walls'][])
  return { chemistry, world, seed, scale: 1, terrain }
}

/**
 * The best world we know how to build, as one press.
 *
 * Every number here was measured rather than chosen, and the measurements are in RULES.md §24 and
 * LEARNING.md §0. Paired against the old defaults over 5 seeds × 20k ticks this configuration took
 * the 90th-percentile lifespan from 489 to 1,259, best compound order from 8 to 18, and time spent
 * joined from 0.71 to 0.98.
 *
 * - **Sticky** chemistry, because self-repulsion with cross-attraction is what makes sheets rather
 *   than droplets — and sheets only became possible at all once a particle could hold four bonds.
 * - **Patches, average**: food concentrated in space was already the strongest lever on
 *   aggregation, and scarcity was measured to be actively lethal — but *abundant* with a tight cap
 *   pinned the population against it, which is worse than either.
 * - **A hundred and fifty brain slots**, far more than the food can support, so the population is
 *   set by the ecology rather than by an array length. This single change took the 90th-percentile
 *   lifespan from 131–173 to 2,104–2,355.
 * - **Metabolism 0.5**, the strongest single lever on how long anything lives.
 * - **Energy along bonds**, so a bonded group shares one metabolism.
 * - **Cross-entropy** learning, the only algorithm measured to beat its controls (p = 0.003).
 * - Scored on **offspring together with togetherness**, combined so that being poor at either
 *   drags the score down. That last choice is the one *not* justified by a measurement: offspring
 *   alone is the better-evidenced objective, but it is thrift that wins it, and the rung this
 *   world is trying to climb is about structures. It is a bet, and labelled as one.
 */
export function bestRecipe(seed = Math.floor(Math.random() * 1e9)): Recipe {
  return { chemistry: 'sticky', world: 'plenty', seed, scale: 1, terrain: 'none' }
}

export function bestWorld(seed = Math.floor(Math.random() * 1e9), scale = 1): Init {
  const init = buildRecipe({ ...bestRecipe(seed), scale })
  init.foodMode = 'patchy'
  init.foodLevel = 'average'
  init.foodRegime = 'steady'
  init.n_patch = 2 * scale
  init.r_patch = 50
  init.food_life = 250
  init.metabolism = 0.5
  init.bond_flow = 0.05
  init.n_brain = 150 * scale * scale
  init.n_start = 16 * scale * scale
  init.n_intrinsic = 700 * scale * scale
  init.T_spawn = 25
  init.bonds = true
  init.repro = true
  init.learn = {
    ...LEARN_DEFAULTS,
    algo: 'cem',
    fitness: specFromKeys(['offspring', 'together'], 'geometric'),
    warmup: 1000,
    batch: 12,
    pool: 24,
    share: 1,
  }
  applyFoodLevel(init)
  init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return init
}

export function chemistryOf(key: string): Chemistry {
  return CHEMISTRIES.find((c) => c.key === key) ?? CHEMISTRIES[0]
}

export function worldKindOf(key: string): WorldKind {
  return WORLD_KINDS.find((w) => w.key === key) ?? WORLD_KINDS[0]
}

/**
 * A world from a recipe. Everything not named by the two characters still comes from the seed, so
 * two worlds of the same character are siblings rather than copies.
 */
export function buildRecipe(r: Recipe): Init {
  const init = initFromSeed(r.seed, r.scale)
  const rng = new Rng((r.seed * 2654435761) | 0)
  const chem = chemistryOf(r.chemistry)
  const kind = worldKindOf(r.world)

  init.A = chem.matrix(rng)
  kind.apply(init, rng)
  init.walls = r.terrain ?? 'none'
  init.n_wall = init.walls === 'none' ? 0 : 30 + rng.int(20) * r.scale * r.scale
  applyWallStamp(init)

  /*
   * Room for a crowd. Brain slots are the hard ceiling on how many organisms can exist, and at
   * eight the population pinned against it: every birth needed a death, so living longer and
   * breeding at all were in direct conflict. Measured over 5 seeds × 20k ticks, going from 10 to
   * 40 slots raised best compound order from 7 to 18, lineage depth from 6 to 18 generations, and
   * the 90th-percentile lifespan from 941 to 1,259 — the single largest effect of anything tried.
   */
  /*
   * Slots far beyond what the food can support, so the population is set by the **ecology** rather
   * than by the size of an array. Measured: moving from 40 slots with abundant food to 150 slots
   * with average food took the 90th-percentile lifespan from 131–173 to 2,104–2,355, a thirteen-
   * fold jump, with a structure reaching order 101. A binding cap had been hiding everything: it
   * put longevity in conflict with breeding, made reproductive strategy invisible to selection,
   * and left the learner with no free slot to spawn into.
   */
  init.n_brain = 150 * r.scale * r.scale
  init.n_start = 16 * r.scale * r.scale
  init.n_intrinsic = (650 + rng.int(100)) * r.scale * r.scale
  init.n_food0 = Math.round(init.max_food * 0.25)
  init.bonds = true
  init.repro = true

  applyFoodLevel(init)
  init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return init
}

/** The one line that says what a recipe is, for the picker. */
export function describeRecipe(r: Recipe): { chemistry: string; world: string } {
  return { chemistry: chemistryOf(r.chemistry).describe(), world: worldKindOf(r.world).describe() }
}

/** Food levels, exposed so the picker can show what a world will deliver. */
export const LEVEL_WORDS: Record<FoodLevel, string> = {
  scarce: 'barely any food',
  average: 'enough food to compete over',
  abundant: 'more food than can be eaten',
}
