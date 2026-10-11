import { Rng } from './rng'
import { N_MATRIX } from './types'

/** Universal constants. Same for every particle; not play material. */
export const LAWS = {
  SIZE: 300,
  mu: 0.5, // mobility
  r_c: 40, // interaction cutoff
  beta: 0.25, // hard-core fraction -> r_0 = beta * r_c = 10
  K_core: 3,
  L_rod: 16,
  gap: 0.12, // angular gap between quadrants (rad)
  r_brain_core: 8, // a brain's exclusion radius against any particle
  r_brain: 16, // brain-against-brain exclusion: organisms may only touch through limbs
  K_brain: 12,
  food_coupling: 0.5, // scales every Food row/column entry, biasing chemistry toward structure
  // Hardest guardrail: half a core radius under a particle's own motion, so it can never
  // pass through anything. A rod tip may swing up to L_rod * dth_max = 4 on top of riding its
  // brain, so a limb's worst case is 9 — still inside r_0 = 10. Meant to be a backstop: if it
  // bites often (the stats panel reports how often), the world is too hot.
  d_max: 5,
  dth_max: 0.25,
  z_max: 3, // Brownian draws are clamped to this many sigma
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
  E_repro: 60, // brain reserve at which budding is allowed
  E_hold: 20, // reserve a parent must keep after paying for a child
  repro_cooldown: 80,
  repro_dist: 42, // how far from the parent a child appears
  E_birth: 15, // reserve each particle of a budded child starts with
  E_viable: 1,
  corpse_frac: 0.5, // share of a dead brain's reserve that is left behind as food // minimum reserve for a free particle to be captured as a limb
  substeps_max: 16, // integration sub-steps are capped here when a hot world needs them
  life_window: 10000, // lifetime averages are reported over this many trailing ticks
  life_buckets: 100,
}
export type Laws = { [K in keyof typeof LAWS]: number }

export type FoodMode = 'random' | 'patchy' | 'gradient'
export const FOOD_MODES: readonly FoodMode[] = ['random', 'patchy', 'gradient']

/** Bond strengths the quantized chemistry can take. */
export const QUANTA = [-1, -0.5, -0.25, 0, 0.25, 0.5, 1]

export function quantize(a: number): number {
  let best = QUANTA[0]
  for (const q of QUANTA) if (Math.abs(q - a) < Math.abs(best - a)) best = q
  return best
}

export const clamp11 = (a: number): number => Math.min(1, Math.max(-1, a))

/** Everything the start screen shows. Fully determined by the seed, then editable. */
export interface Init {
  seed: number
  size: number // world edge length; counts and rates below already include the area scaling
  scale: number
  A: number[][] // N_MATRIX x N_MATRIX, symmetric, Food-Food = 0
  quantized: boolean // snap the non-food 4x4 to QUANTA
  substeps: number // integration sub-steps per tick; >1 lets a hotter world stay stable
  T: number
  n_intrinsic: number
  n_brain: number
  n_start: number // organisms present at tick 0
  n_food0: number // food present at tick 0
  max_food: number // sun pauses when this much food is in the world
  food_batch: number // food particles per injection event (area scaling)
  spawn_batch: number // organisms per spawn event (area scaling)
  foodMoves: boolean // food drifts and responds to forces; otherwise it stays where it lands
  repro: boolean // budding reproduction
  repro_mut: number // std-dev of weight mutation in children
  food_life: number // ticks before an uneaten food particle spoils (0 = never)
  decay_free: number // fraction of its reserve a free particle loses each tick (burned)
  inflow: boolean // continuous organism inflow: new matter is created for each spawn, and all matter is mortal
  foodMode: FoodMode
  T_food: number
  T_spawn: number
  n_patch: number
  r_patch: number
  v_patch: number
}

/** Snaps the non-food block of a matrix to QUANTA, in place, keeping it symmetric. */
export function applyQuantization(A: number[][]): number[][] {
  for (let i = 0; i < N_MATRIX - 1; i++) {
    for (let j = i; j < N_MATRIX - 1; j++) {
      const q = quantize(A[i][j])
      A[i][j] = q
      A[j][i] = q
    }
  }
  return A
}

/**
 * How far apart two particles must stay. The matrix governs the mid-range; this is the
 * universal exclusion, and brains carry a body radius so organisms can only touch through limbs.
 */
export function coreRadius(brainA: boolean, brainB: boolean, L: Laws): number {
  if (brainA && brainB) return L.r_brain
  if (brainA || brainB) return L.r_brain_core
  return L.beta * L.r_c
}

/** `scale` multiplies the world edge; counts and rates scale with area so density stays constant. */
function seedWorld(seed: number, scale = 1): Init {
  const rng = new Rng(seed)
  const area = scale * scale
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
    size: LAWS.SIZE * scale,
    scale,
    A: applyQuantization(A),
    quantized: true,
    substeps: 1,
    // Stability budget: the Brownian step sqrt(2 mu T) must stay under a fifth of the core
    // radius r_0 = 10, which caps T near 4. Hotter worlds can be typed in, and the start screen
    // flags them; reaching a genuine gas phase needs sub-stepping (see PLAN.md section 1).
    T: Math.round(Math.pow(4, rng.next()) * 10) / 10, // 1 .. 4
    n_intrinsic: (30 + rng.int(21)) * area,
    n_brain: 4 * area,
    n_start: (1 + rng.int(2)) * area,
    n_food0: 30 * area,
    max_food: 120 * area,
    food_batch: area,
    spawn_batch: area,
    foodMoves: false,
    repro: true,
    repro_mut: 0.05,
    food_life: 200,
    decay_free: 0.002,
    inflow: false,
    foodMode: FOOD_MODES[rng.int(FOOD_MODES.length)],
    T_food: 2 + rng.int(5),
    T_spawn: 60 + rng.int(81),
    n_patch: (1 + rng.int(3)) * area,
    r_patch: 35 + rng.int(31),
    v_patch: Math.round(rng.range(0.05, 0.2) * 100) / 100,
  }
}

/** A seeded world, already sub-stepped enough to be numerically safe. */
export function initFromSeed(seed: number, scale = 1): Init {
  const init = seedWorld(seed, scale)
  init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return init
}

/** Smallest sub-step count that brings a world inside its budget, or 0 if none within the cap. */
export function substepsFor(init: Init, L: Laws = LAWS): number {
  for (let n = 1; n <= L.substeps_max; n++) if (stability({ ...init, substeps: n }, L).ok) return n
  return 0
}

/** Diagnostics for the discrete-time budgets, shown on the start screen. */
export interface Stability {
  sigma: number // Brownian step per sub-step
  sigmaRatio: number // ... as a fraction of the core radius
  forceRatio: number // worst single-pair force step, same units
  bondDepth: number // potential depth of one strongest bond
  tempRatio: number // T / bond depth
  /** Numerically safe: steps are short enough that exclusion holds. Sub-stepping fixes this. */
  ok: boolean
  /** Cold enough for bonds to survive. A melted world is legitimate physics, not an error. */
  structured: boolean
}

export function stability(init: Init, L: Laws = LAWS): Stability {
  const r0 = L.beta * L.r_c
  const n = Math.max(1, Math.round(init.substeps))
  // sub-stepping splits the tick: each Brownian increment is sqrt(n) smaller
  const sigma = Math.sqrt((2 * L.mu * init.T) / n)
  const forceStep = (L.mu * L.K_core) / n
  const bondDepth = (L.r_c * (1 - L.beta)) / 2
  const s: Stability = {
    sigma,
    sigmaRatio: sigma / r0,
    forceRatio: forceStep / r0,
    bondDepth,
    tempRatio: init.T / bondDepth,
    ok: false,
    structured: init.T <= bondDepth,
  }
  s.ok = s.sigmaRatio <= 0.1 && s.forceRatio <= 0.35
  return s
}
