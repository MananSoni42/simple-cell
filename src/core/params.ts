import { Rng } from './rng'
import { N_MATRIX } from './types'

/** Universal constants. Same for every particle; not play material. */
export const LAWS = {
  SIZE: 1000,
  mu: 0.5, // mobility
  r_c: 40, // interaction cutoff
  beta: 0.1, // hard-core fraction -> r_0 = beta * r_c
  K_core: 3,
  L_rod: 16,
  gap: 0.12, // angular gap between quadrants (rad)
  r_bind: 6,
  r_eat: 6,
  cooldown: 20, // ticks before an unbound limb can be recaptured
  E_food: 10,
  E_cap: 100,
  E_ref: 50,
  E_init: 30,
  c_up: 0.02,
  c_mv: 0.1,
  c_sig: 0.01,
  k_keep: 0.1,
  releaseFrac: 0.05,
  F_max: 1,
  lambda: 0.05,
  D_sig: 0.2,
  fieldN: 64,
}
export type Laws = { [K in keyof typeof LAWS]: number }

export type FoodMode = 'random' | 'patchy' | 'gradient'
export const FOOD_MODES: readonly FoodMode[] = ['random', 'patchy', 'gradient']

/** Everything the start screen shows. Fully determined by the seed. */
export interface Init {
  seed: number
  A: number[][] // N_MATRIX x N_MATRIX, symmetric, Food-Food = 0
  T: number
  n_intrinsic: number
  n_brain: number
  foodMode: FoodMode
  T_food: number
  T_spawn: number
  n_patch: number
  r_patch: number
  v_patch: number
}

export function initFromSeed(seed: number): Init {
  const rng = new Rng(seed)
  const A = Array.from({ length: N_MATRIX }, () => new Array<number>(N_MATRIX).fill(0))
  for (let i = 0; i < N_MATRIX; i++) {
    for (let j = i; j < N_MATRIX; j++) {
      if (i === N_MATRIX - 1 && j === N_MATRIX - 1) continue // Food x Food: nothing
      const a = Math.round((rng.next() * 2 - 1) * 100) / 100
      A[i][j] = a
      A[j][i] = a
    }
  }
  return {
    seed,
    A,
    T: Math.round(5 * Math.pow(30, rng.next())), // 5 .. 150; condensation melts near T ~ 50
    n_intrinsic: 1200,
    n_brain: 20,
    foodMode: FOOD_MODES[rng.int(FOOD_MODES.length)],
    T_food: 1 + rng.int(4),
    T_spawn: 30 + rng.int(51),
    n_patch: 2 + rng.int(5),
    r_patch: 60 + rng.int(61),
    v_patch: Math.round(rng.range(0.1, 0.4) * 100) / 100,
  }
}
