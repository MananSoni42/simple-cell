/**
 * Shapes of the two neuron types. Kept in one place because the world, the snapshot format and
 * the explainer page all have to agree on them.
 *
 * LIMB  in : [ S_brain, S_field, pFx, pFy, FFx, FFy, reserve, bias ]        -> 8
 *       out: one signal S, sent inward to the brain and deposited outward   -> 1
 *
 * BRAIN in : per socket [ alive, onehot4(type), S_particle, bond load, angle ] = 8 x 4  -> 32
 *          + [ reserve, S_field, bias, food pull x, food pull y,
 *              food around, own velocity x, own velocity y, own bond load ]  -> 41
 *       out: [ Fx, Fy, 4 x food share (softmax), 4 x signal to limb (tanh) ] -> 10
 *
 * The particle's two force inputs are directions it can act on: pF is the force it feels and FF
 * the part of that which came from food. Both are already computed by the force pass.
 *
 * Four of these inputs were added after a review of what the brain could not possibly know, and
 * each closes a gap that made some rung of the ladder unreachable rather than merely hard:
 *
 * - **food around** is a *count*, where the two food-pull inputs are a *vector sum*. Inside a
 *   symmetric cloud of food the pull cancels exactly, so an organism at a feast read the same
 *   zero as one in a desert. A count cannot cancel. The force pass already computed it and
 *   nothing had ever read it.
 * - **own velocity** is last tick's actual displacement, not the force the brain asked for. It is
 *   the one input that comes back through the world, so it is also the brain's only memory: it
 *   can tell that it is moving, and in which direction, which is what "keep going" needs.
 * - **angle** is each limb's direction within its quadrant. The socket index is already implicit
 *   in which inputs a weight reads, so a within-quadrant angle completes the direction. Without
 *   it a brain could not know which way its own body pointed.
 * - **bond load** is the fraction of a particle's bond slots that are filled, per limb and for
 *   the whole body. Coordinated motion and passing a bond along both ask about attachment, and
 *   nothing in the inputs had ever mentioned a bond.
 */
export const N_LIMB_IN = 8
export const N_LIMB_OUT = 1
export const N_WLIMB = N_LIMB_IN * N_LIMB_OUT

export const N_BRAIN_IN = 41

/** Where each block of brain inputs starts, so the world and the explainer cannot drift apart. */
export const BRAIN_IN = {
  /** Per socket, 8 wide: alive, onehot4(type), signal, bond load, angle. */
  SOCKET: 0,
  SOCKET_W: 8,
  RESERVE: 32,
  FIELD: 33,
  BIAS: 34,
  FOOD_X: 35,
  FOOD_Y: 36,
  FOOD_NEAR: 37,
  VEL_X: 38,
  VEL_Y: 39,
  BOND_LOAD: 40,
} as const

/**
 * How many food neighbours count as "surrounded".
 *
 * The force pass counts food within r_c and the count is unbounded, so it is squashed by
 * `tanh(near / FOOD_NEAR_SCALE)`. Eight is chosen so the input is informative over the range that
 * matters — a lone crumb reads 0.12, a handful of four reads 0.46, a dense patch of twenty reads
 * 0.99 — rather than saturating at the first particle, which is what feeding a raw count into a
 * linear layer would do. The same mistake as the old oversized weight init, one layer earlier.
 */
export const FOOD_NEAR_SCALE = 8
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
  /** 1/sqrt(41) ≈ 0.156, the unsaturated default for everything unlisted. */
  brain: 0.156,
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
