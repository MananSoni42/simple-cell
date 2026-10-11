import { type Init, LAWS, applyFoodLevel, applyQuantization, initFromSeed, substepsFor } from '../core/params'

/**
 * Hand-built worlds. Each is a seeded world with the chemistry and economy overridden, so a
 * preset is nothing more than a config you could have typed yourself.
 */
export interface Preset {
  name: string
  blurb: string
  build(): Init
}

/** Lower-triangle entries, as [i, j, value]; the rest of the matrix is zero. */
function matrix(entries: [number, number, number][]): number[][] {
  const A = Array.from({ length: 5 }, () => new Array<number>(5).fill(0))
  for (const [i, j, v] of entries) {
    A[i][j] = v
    A[j][i] = v
  }
  return applyQuantization(A)
}

function world(seed: number, A: number[][], over: Partial<Init> = {}): Init {
  const init: Init = { ...initFromSeed(seed), A, ...over }
  init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  // the level sets the arrival rate, unless the preset asked for a rate itself
  return over.T_food === undefined ? applyFoodLevel(init) : init
}

const FOOD = 4

export const PRESETS: Preset[] = [
  {
    name: 'Membrane',
    blurb: 'two types that like each other and not their own kind — the classic way to get a sheet rather than a blob',
    build: () =>
      world(101, matrix([
        [0, 1, 1], [0, 0, -0.5], [1, 1, -0.5],
        [2, 2, 0.25], [3, 3, 0.25],
        [0, FOOD, 0.5], [1, FOOD, -0.5],
      ]), {
        T: 1.4, n_intrinsic: 120, n_brain: 6, n_start: 3, food_life: 300,
        foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady',
      }),
  },
  {
    name: 'Grazers',
    blurb: 'mouths that chase food in drifting patches, with little else going on — the simplest world where moving pays',
    build: () =>
      world(202, matrix([
        [0, FOOD, 1], [1, FOOD, 1],
        [0, 0, -0.25], [1, 1, -0.25], [2, 2, -0.25], [3, 3, -0.25],
      ]), {
        T: 2, foodMoves: false, n_start: 4, n_brain: 8, food_life: 150,
        foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady',
      }),
  },
  {
    name: 'Crowd',
    blurb: 'dense and sticky, so organisms meet constantly — where to look for groups that stay together',
    build: () =>
      world(303, matrix([
        [0, 1, 1], [2, 3, 1], [0, 2, 0.5], [1, 3, 0.5],
        [0, FOOD, 0.5], [2, FOOD, 0.5],
      ]), {
        T: 1, n_intrinsic: 160, n_brain: 12, n_start: 8, T_spawn: 40, n_food0: 60, food_life: 250,
        foodMode: 'random', foodLevel: 'abundant', foodRegime: 'steady',
      }),
  },
  {
    name: 'Desert',
    blurb: 'one thin sunlit band and nothing elsewhere; almost everything starves, which is the point',
    build: () =>
      world(404, matrix([
        [0, FOOD, 1], [1, 2, 0.5], [3, 3, -0.5],
      ]), {
        T: 2.5, n_food0: 10, max_food: 60, n_brain: 6, n_start: 2, food_life: 120, decay_free: 0.004,
        foodMode: 'gradient', foodLevel: 'scarce', foodRegime: 'steady',
      }),
  },
  {
    name: 'Two colonies',
    blurb: 'two separate colonies, far apart, slowly migrating together until they share one source — isolation, then contact',
    build: () =>
      world(606, matrix([
        [0, 1, 1], [2, 3, 1], [0, 2, -0.5],
        [0, FOOD, 1], [2, FOOD, 1],
      ]), {
        foodMode: 'converging', foodLevel: 'average', foodRegime: 'steady', n_patch: 2, converge_ticks: 6000, r_patch: 55,
        T: 1.4, n_intrinsic: 150, n_brain: 12, n_start: 6, food_life: 250,
      }),
  },
  {
    name: 'Breathing',
    blurb: 'colonies that merge and part again for ever — populations meet and mix, then are pulled apart to drift on their own',
    build: () =>
      world(1010, matrix([
        [0, 1, 1], [2, 3, 1], [1, 2, 0.25],
        [0, FOOD, 1], [2, FOOD, 1],
      ]), {
        foodMode: 'breathing', foodLevel: 'average', foodRegime: 'steady',
        n_patch: 3, converge_ticks: 4000, r_patch: 50,
        T: 1.4, n_intrinsic: 160, n_brain: 12, n_start: 6, food_life: 250,
      }),
  },
  {
    name: 'Feast & famine',
    blurb: 'a cycle from famine to glut and back; nothing can live on the average, only on the swing',
    build: () =>
      world(707, matrix([
        [0, 1, 0.5], [1, 2, 0.5], [0, 0, -0.5],
        [0, FOOD, 1], [1, FOOD, 0.5],
      ]), {
        foodMode: 'patchy', foodLevel: 'average', foodRegime: 'cycle', regime_period: 2500,
        T: 2, n_brain: 12, n_start: 6, food_life: 200,
      }),
  },
  {
    name: 'One spring',
    blurb: 'a single small source that never moves — the most contested world there is',
    build: () =>
      world(808, matrix([
        [0, FOOD, 1], [1, FOOD, 1], [0, 1, 0.5],
        [0, 0, -0.5], [1, 1, -0.5],
      ]), {
        foodMode: 'spring', foodLevel: 'abundant', foodRegime: 'steady', r_patch: 60,
        T: 1.8, n_brain: 12, n_start: 6, food_life: 120,
      }),
  },
  {
    name: 'Running down',
    blurb: 'plenty at the start and nothing by the end; what is the last thing to die',
    build: () =>
      world(909, matrix([
        [0, 1, 1], [2, 3, 0.5], [0, FOOD, 0.5], [2, FOOD, 0.5],
      ]), {
        foodMode: 'random', foodLevel: 'abundant', foodRegime: 'decline', regime_period: 8000,
        T: 1.5, n_brain: 10, n_start: 6, food_life: 300,
      }),
  },
  {
    name: 'Cold soup',
    blurb: 'barely any noise, so structures freeze where they form — good for seeing what the chemistry actually wants',
    build: () =>
      world(505, matrix([
        [0, 1, 1], [1, 2, 1], [2, 3, 1], [0, 0, -1], [2, 2, -1],
        [0, FOOD, 0.25],
      ]), {
        T: 0.3, n_intrinsic: 140, n_brain: 4, n_start: 2, repro: false, food_life: 0,
        foodMode: 'random', foodLevel: 'average', foodRegime: 'steady',
      }),
  },
]
