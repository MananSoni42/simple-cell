import { BRAIN_IN, BRAIN_OUT, N_BRAIN_IN, N_LIMB_IN, N_WLIMB } from './neurons'


/**
 * Brains written by hand, one per rung of the ladder.
 *
 * These exist to answer a question nothing else can: **is the ladder climbable?** It was
 * deliberately made hard, and nothing passes any rung above the viability tier in any condition —
 * which is the intended state and leaves three situations looking identical from a run that scores
 * zero. The rung may be hard but reachable; the threshold may be too strict; or the *instrument*
 * may be unable to see the behaviour at all. Those call for opposite responses, and a search
 * against the third is wasted compute.
 *
 * So each policy below is built to pass exactly one rung. If a deliberately-constructed solver
 * fails, the problem is the rung or the world, not the organisms.
 *
 * **The hard constraint on all of this: a brain is a single linear layer.** `y = W · x`, with no
 * hidden units and no internal state. So it cannot compute a *product* of two inputs — which rules
 * out a whole class of policies that would otherwise be obvious, and `lingers` below is the case
 * where that bites. The only nonlinearity anywhere is the `tanh` at each limb neuron, which makes
 * the body a one-layer hidden network reachable through the socket signals; and the brain→limb
 * signal path is a one-tick recurrence, which is the only memory in the system.
 */

const TAU = Math.PI * 2

/** Which way socket `s` points: the middle of its quadrant. */
export function socketDirection(s: number): number {
  return ((s + 0.5) * TAU) / 4
}

export interface HandBuilt {
  /** What this policy does, in words, for the Discoveries page. */
  describe: string
  /** Which rung it is built to pass. */
  rung: string
  /** Whether a single linear layer can express it at all. */
  representable: boolean
  brain(): Float64Array
  limb(): Float64Array
}

const w = (): Float64Array => new Float64Array(BRAIN_OUT_COUNT * N_BRAIN_IN)
const BRAIN_OUT_COUNT = 10
const set = (m: Float64Array, out: number, input: number, v: number): void => {
  m[out * N_BRAIN_IN + input] = v
}

/** A limb that reports nothing: the default, so a policy only enables what it needs. */
const silentLimb = (): Float64Array => new Float64Array(N_WLIMB)

export const HAND_BUILT: Record<string, HandBuilt> = {
  /**
   * Taxis: swim along the food gradient.
   *
   * One weight per axis, because the food-pull vector is already an input. If this fails there is
   * nothing simpler to try and the instrument is broken.
   */
  taxis: {
    rung: 'Taxis',
    representable: true,
    describe: 'swims straight up the food gradient — one weight per axis, the simplest policy that could pass anything',
    brain() {
      const m = w()
      set(m, BRAIN_OUT.FX, BRAIN_IN.FOOD_X, 4)
      set(m, BRAIN_OUT.FY, BRAIN_IN.FOOD_Y, 4)
      return m
    },
    limb: silentLimb,
  },

  /**
   * Lingers: turn more where food is dense. **Not representable, and that is the finding.**
   *
   * The rung wants commanded *turning rate* to correlate with the food count. A turn is a rotation
   * of the current heading, so the policy wants `FX ← −VEL_Y × FOOD_NEAR` — a **product of two
   * inputs**, which a single linear layer cannot compute.
   *
   * What a linear brain can do instead is add a food-driven component to the command, and that
   * pushes the correlation the *wrong way*: a large constant component makes the heading more
   * stable, so turning ends up **anti**-correlated with food. This policy is the best linear
   * attempt — rotate the velocity by a fixed angle, at a strength set by food — and it is included
   * precisely so the failure is on the record rather than assumed.
   *
   * If it fails, the conclusion is about the **world**, not the rung: area-restricted search needs
   * either a hidden layer or a multiplicative input, and that is a world change.
   */
  lingers: {
    rung: 'Lingers',
    representable: false,
    describe:
      'the best a single linear layer can do at turning where food is dense — which is not enough, because the rung needs a product of two inputs and a linear layer cannot multiply',
    brain() {
      const m = w()
      // rotate the heading 90°: the turn is there, but its *rate* cannot be conditioned on food
      set(m, BRAIN_OUT.FX, BRAIN_IN.VEL_Y, -3)
      set(m, BRAIN_OUT.FY, BRAIN_IN.VEL_X, 3)
      // and the food count, added rather than multiplied, which is the whole problem
      set(m, BRAIN_OUT.FX, BRAIN_IN.FOOD_NEAR, 1)
      return m
    },
    limb: silentLimb,
  },

  /**
   * Follows signal: read the field gradient off the body.
   *
   * The brain's own field input is a **scalar at its own position** — there is no gradient input.
   * But each limb reads the field at *its* position and sends one signal inward, and the four
   * limbs sit in known quadrants. So the gradient is reconstructible as a weighted sum of the four
   * socket signals, with each weighted by the direction its socket points. The body is the sensor
   * array, and the sum is linear, so this one a single layer *can* express.
   */
  followsSignal: {
    rung: 'Follows signal',
    representable: true,
    describe:
      'reads the signal gradient off its own body — each limb reports the field where it is, and the brain combines the four by the direction each limb points',
    brain() {
      const m = w()
      /*
       * **Shout first.** The signal field is self-extinguishing without this.
       *
       * A limb only deposits into the field when its own neuron outputs a positive signal, and a
       * limb neuron's largest input is `S_brain` — what the brain told it. So with every brain
       * silent the field stays at zero, no limb has anything to report, and there is no gradient
       * for anybody to follow: no signal, no field, no signal. The first version of this policy
       * read the socket signals and commanded nothing at all, scoring *identically* to the
       * do-nothing control to every decimal place.
       *
       * This is almost certainly why `Follows signal` measured 0.01 in every condition ever run.
       * Nothing was signalling, so there was nothing to measure.
       */
      for (let s = 0; s < 4; s++) set(m, BRAIN_OUT.SIG + s, BRAIN_IN.BIAS, 2)
      for (let s = 0; s < 4; s++) {
        const o = s * BRAIN_IN.SOCKET_W + 5 // the socket's signal input
        const a = socketDirection(s)
        set(m, BRAIN_OUT.FX, o, 6 * Math.cos(a))
        set(m, BRAIN_OUT.FY, o, 6 * Math.sin(a))
      }
      return m
    },
    limb() {
      const l = new Float64Array(N_WLIMB)
      l[0] = 1 // S_brain: relay the brain's shout, which is what puts anything into the field
      l[1] = 4 // S_field: and report the field where this limb is standing
      return l
    },
  },

  /**
   * Moves together: every organism pushes the same way.
   *
   * Random organisms fail this because each pushes its own direction and a structure's centroid
   * cancels. Identical ones should not — which is what makes the rung a test of *coherence* rather
   * than of swimming, and what the solitary-organism null is there to establish.
   */
  movesTogether: {
    rung: 'Moves together',
    representable: true,
    describe: 'every organism pushes in the same fixed direction, so anything bonded into a structure carries it along',
    brain() {
      const m = w()
      set(m, BRAIN_OUT.FX, BRAIN_IN.BIAS, 3)
      set(m, BRAIN_OUT.FY, BRAIN_IN.BIAS, 1.2)
      return m
    },
    limb: silentLimb,
  },

  /**
   * The exploit, kept as a policy so it can never quietly come back.
   *
   * Two weights, reading **no food, no field, no sockets** — "swim the way I am already drifting".
   * It scored **2.94 on Taxis**, met, at nearly three times the threshold, while eating *less than
   * the do-nothing control*. The food gradient is a force already applied to the body, `VEL` feeds
   * the resulting motion back in, and this brain inherits the whole correlation for free.
   *
   * Taxis now subtracts the drift's own alignment, so this scores ~0. The policy stays as a
   * permanent adversary: any future change that lets it pass the rung again fails a test.
   */
  momentum: {
    rung: '(none — the exploit)',
    representable: true,
    describe: 'swims whichever way it is already drifting, reading nothing at all — the policy that used to pass Taxis for free',
    brain() {
      const m = w()
      set(m, BRAIN_OUT.FX, BRAIN_IN.VEL_X, 8)
      set(m, BRAIN_OUT.FY, BRAIN_IN.VEL_Y, 8)
      return m
    },
    limb: silentLimb,
  },

  /**
   * A thrifty control: pushes nothing, signals nothing, spends as little as it can.
   *
   * Not built to pass a rung — built to **fail all of them** while staying alive, because that is
   * the strategy every search and every learner in this project has actually found. It is the floor
   * any hand-built policy has to beat.
   */
  thrifty: {
    rung: '(none — the control)',
    representable: true,
    describe: 'does nothing at all and lives off its endowment: the strategy every learner here has actually found, and the floor the others must beat',
    brain: w,
    limb: silentLimb,
  },
}

export type HandBuiltName = keyof typeof HAND_BUILT

export const HAND_BUILT_NAMES = Object.keys(HAND_BUILT) as HandBuiltName[]

/** Sanity: the limb layout these policies index into has not moved under them. */
export const HAND_BUILT_LIMB_IN = N_LIMB_IN
