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
