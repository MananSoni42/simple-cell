import { type Init, applyQuantization, initFromSeed, substepsFor, LAWS } from '../core/params'

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
  return init
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
      ]), { T: 1.4, n_intrinsic: 120, n_brain: 6, n_start: 3, foodMode: 'patchy', food_life: 300 }),
  },
  {
    name: 'Grazers',
    blurb: 'mouths that chase food in drifting patches, with little else going on — the simplest world where moving pays',
    build: () =>
      world(202, matrix([
        [0, FOOD, 1], [1, FOOD, 1],
        [0, 0, -0.25], [1, 1, -0.25], [2, 2, -0.25], [3, 3, -0.25],
      ]), { T: 2, foodMode: 'patchy', foodMoves: false, n_start: 4, n_brain: 8, T_food: 2, food_life: 150 }),
  },
  {
    name: 'Crowd',
    blurb: 'dense and sticky, so organisms meet constantly — where to look for groups that stay together',
    build: () =>
      world(303, matrix([
        [0, 1, 1], [2, 3, 1], [0, 2, 0.5], [1, 3, 0.5],
        [0, FOOD, 0.5], [2, FOOD, 0.5],
      ]), { T: 1, n_intrinsic: 160, n_brain: 12, n_start: 8, T_spawn: 40, n_food0: 60, food_life: 250 }),
  },
  {
    name: 'Desert',
    blurb: 'one thin sunlit band and nothing elsewhere; almost everything starves, which is the point',
    build: () =>
      world(404, matrix([
        [0, FOOD, 1], [1, 2, 0.5], [3, 3, -0.5],
      ]), { T: 2.5, foodMode: 'gradient', T_food: 6, n_food0: 10, max_food: 60, n_brain: 6, n_start: 2, food_life: 120, decay_free: 0.004 }),
  },
  {
    name: 'Cold soup',
    blurb: 'barely any noise, so structures freeze where they form — good for seeing what the chemistry actually wants',
    build: () =>
      world(505, matrix([
        [0, 1, 1], [1, 2, 1], [2, 3, 1], [0, 0, -1], [2, 2, -1],
        [0, FOOD, 0.25],
      ]), { T: 0.3, n_intrinsic: 140, n_brain: 4, n_start: 2, repro: false, food_life: 0 }),
  },
]
