/**
 * Shapes of the two neuron types. Kept in one place because the world, the snapshot format and
 * the explainer page all have to agree on them.
 *
 * LIMB  in : [ S_brain, S_field, pFx, pFy, FFx, FFy, reserve, bias ]        -> 8
 *       out: one signal S, sent inward to the brain and deposited outward   -> 1
 *
 * BRAIN in : per socket [ alive, onehot4(type), S_particle ] = 6 x 4         -> 24
 *          + [ reserve, S_field, bias, food pull x, food pull y ]            -> 29
 *       out: [ Fx, Fy, 4 x food share (softmax), 4 x signal to limb (tanh) ] -> 10
 *
 * The particle's two force inputs are directions it can act on: pF is the force it feels and FF
 * the part of that which came from food. Both are already computed by the force pass.
 */
export const N_LIMB_IN = 8
export const N_LIMB_OUT = 1
export const N_WLIMB = N_LIMB_IN * N_LIMB_OUT

export const N_BRAIN_IN = 29
export const N_BRAIN_OUT = 10
export const BRAIN_OUT = { FX: 0, FY: 1, FOOD: 2, SIG: 6 } as const

/**
 * How a fresh brain is drawn.
 *
 * The old rule was one scale for everything — every brain weight `0.5·N(0,1)`, every limb weight
 * `N(0,1)` — and it was **too large by a factor of about 2.7**. With 29 inputs of typical
 * magnitude around 0.5 the pre-activation spread came out near 1.35, and `tanh(1.35) = 0.87`:
 * random brains were born saturated, their outputs pinned near ±1 and barely responding to what
 * they could see. A constant policy cannot be selected on, which is part of why the only strategy
 * any learner ever found was to spend less.
 *
 * The scales below are `1/sqrt(n_in)` — the standard choice for tanh — adjusted per output block,
 * because the ten outputs do not want the same prior:
 *
 * - **movement** small, because moving costs five times upkeep per unit and a thrashing newborn
 *   dies before it finds anything;
 * - **food share** small *spread*, which is what gives near-equal sharing between the four
 *   sockets. Note that the level is irrelevant: the shares pass through a softmax, so adding the
 *   same constant to all four logits changes nothing at all — only the spread matters;
 * - **signals** almost zero, since signalling costs energy and random signalling is noise.
 *
 * None of this tells an organism what to do. It is a prior over random genomes — the same tier as
 * the chemistry matrix — chosen so that a newborn starts out able to respond rather than deaf.
 */
export const INIT_SCALE = {
  /** 1/sqrt(29) ≈ 0.186, the unsaturated default for everything unlisted. */
  brain: 0.186,
  move: 0.1,
  food: 0.05,
  signal: 0.05,
  /** 1/sqrt(8) ≈ 0.354. */
  limb: 0.354,
} as const

/** The scale for one brain output row, by its index. */
export function brainRowScale(out: number): number {
  if (out === BRAIN_OUT.FX || out === BRAIN_OUT.FY) return INIT_SCALE.move
  if (out >= BRAIN_OUT.FOOD && out < BRAIN_OUT.FOOD + 4) return INIT_SCALE.food
  if (out >= BRAIN_OUT.SIG && out < BRAIN_OUT.SIG + 4) return INIT_SCALE.signal
  return INIT_SCALE.brain
}

/** Weights for a fresh brain, laid out `[out * N_BRAIN_IN + in]`. */
export function randomBrain(gauss: () => number): Float64Array {
  const w = new Float64Array(N_BRAIN_OUT * N_BRAIN_IN)
  for (let o = 0; o < N_BRAIN_OUT; o++) {
    const scale = brainRowScale(o)
    for (let i = 0; i < N_BRAIN_IN; i++) w[o * N_BRAIN_IN + i] = scale * gauss()
  }
  return w
}

export function randomLimb(gauss: () => number): Float64Array {
  return Float64Array.from({ length: N_WLIMB }, () => INIT_SCALE.limb * gauss())
}
