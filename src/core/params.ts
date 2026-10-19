import { LEARN_DEFAULTS, type LearnConfig } from './learning'
import { Rng } from './rng'
import { BRAIN_ROW, FOOD_ROW, N_MATRIX, N_MATTER } from './types'

/** Universal constants. Same for every particle; not play material. */
export const LAWS = {
  SIZE: 300,
  mu: 0.5, // mobility
  /**
   * Food's mobility, as a fraction of everything else's.
   *
   * It used to be 1: one global mobility meant a crumb of food drifted exactly as fast as a limb
   * swam, and took exactly the same thermal kick — about 0.8 to 1.4 units a sub-step at ordinary
   * temperatures. **You cannot catch what diffuses as fast as you move.** A pursuit that gains
   * nothing on its target is indistinguishable from thrift, which is one reason the only strategy
   * any search ever found was to spend less.
   *
   * At 0.15 food is heavy: it still responds to chemistry, so an attractive matrix can gather it
   * and a repulsive one can scatter it, but it drifts slowly enough to be overtaken. The thermal
   * part scales as sqrt of this, because a Brownian step goes as sqrt(mu T) — so food's kick falls
   * by about 2.6x rather than 6.7x, and food still wanders rather than sitting on a lattice.
   */
  mu_food: 0.15,
  r_c: 40, // interaction cutoff
  beta: 0.25, // hard-core fraction -> r_0 = beta * r_c = 10; per-type radii override it
  K_core: 3,
  L_rod: 16,
  gap: 0.12, // angular gap between quadrants (rad)
  r_brain_core: 8, // a brain's exclusion radius against any particle
  r_brain: 16, // brain-against-brain exclusion: organisms may only touch through limbs
  K_brain: 12,
  // A brain pushes everything away, not only other brains: it has no chemistry to attract with,
  // so its surroundings stay its own. The push reaches r_brain_push, deliberately short of the
  // rod circle plus the interaction range, so limbs can still reach food the brain has cleared.
  A_brain: 0.5,
  r_brain_push: 26,
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
  /**
   * How far from the parent a child appears.
   *
   * It used to be 42, which put a newborn **out of reach**: a child's limb and its parent's can
   * get no closer than 42 − L_rod − L_rod = 10, just inside the 12-unit bonding range but only
   * when both limbs point almost exactly at each other. Brains settle about 26 apart anyway under
   * their mutual push, and at that separation limbs overlap freely. So families can now form by
   * the ordinary bonding rule, with nothing in the laws saying that they should.
   */
  repro_dist: 28,
  E_birth: 15, // reserve each particle of a budded child starts with
  /**
   * What a parent invests in a spore, and how much food a spore needs to find before it wakes.
   *
   * A spore is the dispersal strategy the world was missing. Budding places a child `repro_dist`
   * away, so a lineage can only spread as fast as it breeds and only into space it can already
   * see is empty — and "nowhere to put a child" is one of the four counted reasons reproduction
   * fails. A spore instead becomes ordinary free matter carrying a genome: it drifts, it is
   * subject to the same decay as anything loose, and it germinates only where it finds food.
   *
   * `spore_food` is counted in the same units as the brain's new food-count input, so germination
   * and perception agree about what "food is here" means.
   */
  E_spore: 30,
  spore_food: 3,
  /**
   * What a particle spends to copy itself, and how long it waits before doing so again.
   *
   * Replication rather than creation, and the distinction is the whole design. A creation *rate*
   * spawns particles the world did not earn; this makes a particle copy itself, paying from its
   * own reserve, and only when **bonded** — so the chemistry that gets copied is the chemistry
   * that got itself attached to something where energy flows. A particle that merely clumps with
   * its own kind in a corner has no energy to spend, which is what stops the obvious degenerate
   * attractor: immortal self-attracting clots crowding everything else out.
   */
  E_template: 25,
  template_cooldown: 200,
  E_viable: 1,
  /**
   * What a loose BRAIN-typed particle must hold before it activates into an organism.
   *
   * **This replaces organism spawning, and the reason is an energy bug.** A spawn built a whole
   * four-limbed body and endowed every particle of it out of nothing — measured at 41% and 67% of
   * all energy entering two sample worlds. The books balanced, because the creation was *booked* as
   * injection, which is exactly why it went unnoticed; but energy input was not a function of food,
   * inefficient organisms got an unconditional subsidy proportional to how long the run was, and
   * plausibly some of the thrift attractor every learner falls into was an artefact of a free drip
   * arriving whatever anybody did.
   *
   * An **activation energy** is the elegant replacement, and it is the same shape as the thing
   * `F_form`/`F_break` hysteresis already resembles. A loose brain particle is inert matter: it eats
   * like any matter can, and its reserve bleeds at `decay_free`, so it only accumulates if feeding
   * beats decay. When it clears the barrier it pays this and becomes a bare organism — with no
   * grace period and no exemption, because it activated precisely *because* it could afford to.
   *
   * A rate competition rather than a subsidy. Nothing is exempt from decay, and nothing is created.
   */
  E_activate: 25,
  /**
   * Chance that a particle returning to the loose pool has its kind drawn again.
   *
   * A dial rather than a rule, for two reasons. It is the only "creation" in a world where matter
   * is conserved — it creates *identity*, not matter — so how fast identity turns over is a
   * property of the world worth searching rather than deciding. And at zero the composition a world
   * starts with is the composition it keeps, which is what an experiment needs when it is asking
   * about one kind: several tests set up a world with a known mix and were failing because the mix
   * drifted underneath them, which is the dial working rather than a bug.
   */
  redraw_kind: 1,
  corpse_frac: 0.5,
  r_wall: 10, // a wall's exclusion radius
  // Spare terrain slots kept in every world so it can be painted. Not free: every slot is one
  // more entry in the grid build, so this is deliberately modest - 300 pieces of radius 10 can
  // still cover a third of a 300-unit world.
  wall_cap: 300,
  K_wall: 12,
  // Bonds between particles, with hysteresis: forming is easy, breaking is not. The gap between
  // F_form and F_break is the activation energy, and it is what lets aggregates persist instead
  // of constantly reshuffling.
  /**
   * How many bonds one particle can hold — and with it, what shapes can exist at all.
   *
   * At two, the only topologies in the world are **chains and rings**: a sheet needs three
   * attachment points and a lattice four. Every large aggregate measured before this was a
   * necklace, with no inside and no outside, which is why membranes never appeared however the
   * chemistry was tuned. Four is the smallest number that admits a two-dimensional fabric.
   */
  max_bonds: 4,
  A_form: 0.25, // chemistry must be at least this attractive to bond at all
  k_bond: 0.6, // spring pulling a bond back to its rest length
  r_bond: 10, // rest length, which is also the core radius
  // The hysteresis, as the two forces: a bond forms only while the pair is slack enough to be
  // held by F_form, and survives until stretched hard enough to need F_break. With these
  // numbers that is "form within 12 units, break beyond 14.2".
  //
  // F_break sits against F_max, the largest force any chemistry can exert: at 4 a bond is four
  // times stronger than anything chemistry can do to it, so chemistry alone can never break one
  // and a bond ends only when a limb starves or detaches.
  //
  // That looked like a flaw — a weld rather than a bond — and lowering it was measured instead of
  // assumed. It was the wrong call. Over 5 seeds × 20k ticks, 2.5 bought 10% longer individual
  // lives and cost **four fifths of the standing bonds** (42 → 8), dropping best order from 7 to 5
  // and time-spent-joined from 0.83 to 0.69. Weaker bonds trade structure for longevity, and
  // structure is the point, so 4 stands. Recorded here because the argument for lowering it is
  // more persuasive than the evidence.
  F_form: 1.2,
  F_break: 4,
  E_bond: 0.1, // energy spent to form a bond, paid by both particles
  bond_cooldown: 30, // ticks before the same particle may bond again after a break // share of a dead brain's reserve that is left behind as food // minimum reserve for a free particle to be captured as a limb
  substeps_max: 16, // integration sub-steps are capped here when a hot world needs them
  /**
   * Compound time is credited as `(n-1)^order_alpha` per tick.
   *
   * It was 1.5, which made order count *superlinearly* while time counted linearly — so a
   * ten-organism clump that lasted an instant outscored a pair that held together for a lifetime.
   * That is backwards: **how long a structure lasts matters more than how big it is.** A
   * four-organism structure that persists for half an organism's life is a better thing than a
   * ten-organism one that persists for a hundredth of it. At 0.5 order contributes with a square
   * root while time still contributes in full.
   */
  order_alpha: 0.5,
  life_window: 10000, // lifetime averages are reported over this many trailing ticks
  life_buckets: 100,
}
export type Laws = { [K in keyof typeof LAWS]: number }

/** Where food lands. */
/**
 * Where food lands around a source.
 *
 * This used to mean three things at once — where food lands, how a source moves, and how several
 * sources relate to each other — which is why "number of sources" and "their relation" had nowhere
 * to live. `converging` and `breathing` were *relations* masquerading as placements; `comet` was a
 * *motion*. They are kept as names for backward compatibility (every saved world and catalog row
 * uses them) and are translated into the three axes by `foodAxes` below.
 */
export type FoodMode = 'random' | 'patchy' | 'gradient' | 'converging' | 'breathing' | 'spring' | 'comet' | 'ring'

/**
 * How each food source moves. Speeds are a **fraction of how fast an organism travels**, not
 * absolute units — see `sourceSpeed`.
 *
 * A static source makes the optimal policy a constant: find it once, stop. Nothing to track, nothing
 * to re-acquire, nothing to improve at. It also underwrites three rung exploits that all need food
 * at a fixed location. These are chosen to be *contrastive*, so a search can answer what moving food
 * selects for rather than only whether it helps.
 */
export type SourceMotion =
  /** Fixed. Kept deliberately as the control, so "moving food helps" stays measurable. */
  | 'static'
  /** Straight line, constant heading, wrapping. Rewards pure pursuit. */
  | 'comet'
  /** Circles the world centre. Periodic and predictable, so it *returns* — rewards anticipation. */
  | 'orbit'
  /** Random walk at the same speed as `orbit`. Tracking without anticipation; the control for it. */
  | 'wander'
  /** A band sweeping across and wrapping. Rewards positioning rather than chasing. */
  | 'tide'
  /** Flees the densest cluster of organisms. Anti-camping, and the one most likely to degenerate. */
  | 'shy'

export const SOURCE_MOTIONS: readonly SourceMotion[] = ['static', 'comet', 'orbit', 'wander', 'tide', 'shy']

/**
 * How several sources relate to each other — the axis that matters most in a large world.
 *
 * At 16× the world is 4,800 units across and a single source is a needle in it; what decides whether
 * a population can live is whether the sources are spread, gathering, or scattering, and whether
 * that changes over time.
 */
export type SourceRelation =
  /** Each source moves on its own. No relationship. */
  | 'independent'
  /** All sources close on the world's middle and stay. Isolated populations end up meeting. */
  | 'converging'
  /** All sources spread outward from where they began. Populations that met are driven apart. */
  | 'diverging'
  /** Converge and diverge for ever, so isolation and contact keep alternating. */
  | 'cyclical'
  /** Sources keep their spacing and move as a formation — the whole pattern travels. */
  | 'formation'

export const SOURCE_RELATIONS: readonly SourceRelation[] = ['independent', 'converging', 'diverging', 'cyclical', 'formation']

/**
 * The food worlds worth choosing between, as named combinations of the three axes.
 *
 * The axes are the right factorisation for a *search* — orthogonal, so a factor table can say which
 * one mattered. They are the wrong thing to put in front of a person. The cross-product is 8 x 6 x 5
 * = 240 combinations and most are not worlds: uniform food cannot show a source motion because
 * nothing is placed relative to a source, a `comet` pattern with `static` motion is a contradiction
 * in its own name, and `formation` means nothing with one source. Offering all 240 and relying on
 * the reader to avoid the nonsense produced exactly the complaint it deserved — dials that appear
 * not to work.
 *
 * So: one list, each entry a world that makes sense and is a *different experiment* from its
 * neighbours. The axes stay exactly as they are underneath and the search still varies them freely;
 * this is the human-facing projection of them, not a replacement.
 */
export interface FoodWorld {
  key: string
  name: string
  /** What choosing it is an experiment *about*, which is why these are not just presets. */
  why: string
  mode: FoodMode
  motion: SourceMotion
  relation: SourceRelation
  /** Whether a source count is meaningful here, and whether speed is. */
  sources: boolean
  speed: boolean
}

export const FOOD_WORLDS: readonly FoodWorld[] = [
  {
    key: 'spring',
    name: 'a fixed spring',
    why: 'one small source, fixed. The control: a fixed source makes the best policy a constant — find it once and stop — so nothing can get better at it, and every moving world is measured against this',
    mode: 'spring',
    motion: 'static',
    relation: 'independent',
    sources: true,
    speed: false,
  },
  {
    key: 'band',
    name: 'a sunlit band',
    why: 'one bright stripe and desert either side. Fixed, like the spring, but the resource is a line rather than a point, so position matters in one dimension instead of two',
    mode: 'gradient',
    motion: 'static',
    relation: 'independent',
    sources: true,
    speed: false,
  },
  {
    key: 'ring',
    name: 'a ring',
    why: 'a closed band at a radius — a circuit rather than a field. The only fixed world with no centre to crowd around',
    mode: 'ring',
    motion: 'static',
    relation: 'independent',
    sources: true,
    speed: false,
  },
  {
    key: 'patches',
    name: 'drifting patches',
    why: 'food in a few slow hot-spots. Following it pays a little, and this is the closest thing here to an ordinary ecology',
    mode: 'patchy',
    motion: 'wander',
    relation: 'independent',
    sources: true,
    speed: true,
  },
  {
    key: 'comet',
    name: 'a comet to chase',
    why: 'one source on a straight run. Pure pursuit: catch it or starve, with nothing to anticipate',
    mode: 'comet',
    motion: 'comet',
    relation: 'independent',
    sources: true,
    speed: true,
  },
  {
    key: 'orbit',
    name: 'an orbit that returns',
    why: 'the same chase, but periodic — so it comes back. The only food world where remembering where it was can pay, and therefore the one that bears on intelligence rather than reflexes. Compare it against the comet at the same speed: same difficulty, differing only in predictability',
    mode: 'patchy',
    motion: 'orbit',
    relation: 'independent',
    sources: true,
    speed: true,
  },
  {
    key: 'tide',
    name: 'a sweeping tide',
    why: 'every source on one heading, so the food crosses the world as a band and the pattern keeps its shape. Rewards being in the right place rather than chasing',
    mode: 'patchy',
    motion: 'tide',
    relation: 'formation',
    sources: true,
    speed: true,
  },
  {
    key: 'gathering',
    name: 'colonies that gather',
    why: 'separate populations that have never met, drawn together once and left together. Isolation, then contact, then a shared world for good',
    mode: 'patchy',
    motion: 'wander',
    relation: 'converging',
    sources: true,
    speed: true,
  },
  {
    key: 'colonies',
    name: 'colonies that meet and part',
    why: 'the same, for ever: drawn together and pulled apart again. The social worlds start here, because contact has to keep being possible before cooperation can be worth anything',
    mode: 'patchy',
    motion: 'wander',
    relation: 'cyclical',
    sources: true,
    speed: true,
  },
  {
    key: 'scattering',
    name: 'colonies driven apart',
    why: 'populations that had met, pushed outward. The one world where being in a group becomes a liability, which is the null for every claim that grouping helps',
    mode: 'patchy',
    motion: 'wander',
    relation: 'diverging',
    sources: true,
    speed: true,
  },
  {
    key: 'shy',
    name: 'food that flees you',
    why: 'sources that move away from wherever the population has massed. Adversarial: the better they get at finding it, the harder it is to hold, and the most likely of these to go degenerate',
    mode: 'patchy',
    motion: 'shy',
    relation: 'independent',
    sources: true,
    speed: true,
  },
  {
    key: 'uniform',
    name: 'food everywhere',
    why: 'uniform. Standing still is as good as moving, so this is the null for every claim that foraging matters at all',
    mode: 'random',
    motion: 'static',
    relation: 'independent',
    sources: false,
    speed: false,
  },
]

/**
 * The named world a configuration corresponds to, or null when the axes were set to a combination
 * the list does not cover.
 *
 * Matches on the **resolved** axes, which is the part that matters. A world that predates the axes
 * leaves both unset and gets its motion from `foodMode`, so comparing the raw fields would report
 * every rolled world as hand-built — which is exactly what it did, and what sent a brand-new world
 * to the page labelled as something the user had built by hand.
 *
 * Motion and relation decide the match and the landing pattern only breaks ties, because motion is
 * what distinguishes these worlds from each other. `random` is the exception: uniform food is a
 * different world whatever its sources do, since nothing is placed relative to one.
 */
export function foodWorldOf(init: Pick<Init, 'foodMode' | 'sourceMotion' | 'sourceRelation'>): FoodWorld | null {
  const legacy = foodAxes(init.foodMode)
  const motion = init.sourceMotion ?? legacy.motion
  const relation = init.sourceRelation ?? legacy.relation
  if (init.foodMode === 'random') return FOOD_WORLDS.find((w) => w.mode === 'random') ?? null
  const fits = FOOD_WORLDS.filter((w) => w.mode !== 'random' && w.motion === motion && w.relation === relation)
  return fits.find((w) => w.mode === init.foodMode) ?? fits[0] ?? null
}

/**
 * The three axes a legacy `foodMode` stands for.
 *
 * One place, so the old names keep meaning exactly what they meant while the new axes become the
 * thing the search and the UI actually vary.
 */
export function foodAxes(m: FoodMode): { motion: SourceMotion; relation: SourceRelation; sources: number | null } {
  switch (m) {
    case 'comet':
      return { motion: 'comet', relation: 'independent', sources: 1 }
    case 'spring':
      return { motion: 'static', relation: 'independent', sources: 1 }
    case 'converging':
      return { motion: 'wander', relation: 'converging', sources: null }
    case 'breathing':
      return { motion: 'wander', relation: 'cyclical', sources: null }
    case 'ring':
    case 'gradient':
      return { motion: 'static', relation: 'independent', sources: null }
    default:
      // `patchy` and `random` drifted independently at `v_patch`, which is what `wander` is
      return { motion: 'wander', relation: 'independent', sources: null }
  }
}
export const FOOD_MODES: readonly FoodMode[] = [
  'random',
  'patchy',
  'gradient',
  'converging',
  'breathing',
  'spring',
  'comet',
  'ring',
]

/** How much arrives, as a multiple of what the world costs to run. */
export type FoodLevel = 'scarce' | 'average' | 'abundant'
export const FOOD_LEVELS: readonly FoodLevel[] = ['scarce', 'average', 'abundant']

/** How that amount changes over time. */
export type FoodRegime = 'steady' | 'cycle' | 'bloom' | 'decline' | 'rising' | 'noisy'
export const FOOD_REGIMES: readonly FoodRegime[] = ['steady', 'cycle', 'bloom', 'decline', 'rising', 'noisy']

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
  /**
   * Explicit physics overrides for this world.
   *
   * Laws and initial conditions are different tiers and this project keeps them apart: an `Init`
   * describes a world you could set up, `LAWS` describes the universe it sets up in. So why is
   * there a `Laws` block on `Init`?
   *
   * Because a world that is *searched over* varies both, and the alternative is worse. A search
   * that returns "this chemistry works, at these forces" has to be able to hand that world to the
   * renderer, the snapshot format, the worker and the Discoveries page — all of which pass an
   * `Init` and nothing else. Without this field each of those paths would silently revert to the
   * default physics, and the world you watched would not be the world that was scored. A named,
   * validated block is a crossing on purpose; a silent one is a bug.
   *
   * `WorldOpts.laws` still wins over this, so an experiment can override a world's own physics.
   */
  laws?: Partial<Laws>
  /**
   * Per-type properties: size, mobility, valence, bond strength and cost, decay.
   *
   * Sparse and optional — a missing type or a missing field falls back to `ELEMENTS`, which
   * reproduces the old global constants exactly. So an `Init` that says nothing about elements is
   * the world as it was.
   */
  elements?: (Partial<Element> | undefined)[]
  A: number[][] // N_MATRIX x N_MATRIX, symmetric, Food-Food = 0
  quantized: boolean // snap the non-food 4x4 to QUANTA
  substeps: number // integration sub-steps per tick; >1 lets a hotter world stay stable
  T: number
  n_intrinsic: number
  n_brain: number
  n_start: number // organisms present at tick 0
  n_food0: number // food present at tick 0
  /**
   * How many food particles the world has room for.
   *
   * This is a **capacity, not a thermostat**: the sun's rate is fixed by `food_batch / T_food`
   * and the regime, and nothing throttles it. But storage is finite, so when every slot is
   * occupied the arriving light has nowhere to land and is wasted. That used to happen silently,
   * which made the ceiling indistinguishable from a quiet sun; `lightWasted` now counts it, so a
   * world that is saturated says so instead of merely looking poorly fed.
   */
  max_food: number
  food_batch: number // food particles per injection event (area scaling)
  spawn_batch: number // organisms per spawn event (area scaling)
  foodMoves: boolean // food drifts and responds to forces; otherwise it stays where it lands
  /**
   * Which ways of reproducing this world allows, beyond budding (R7.7), which is always on when
   * `repro` is. Both are off by default, so an existing world behaves exactly as it did.
   *
   * These are *modes*, not improvements. Budding and fission are both clonal, which means that
   * before conjugation existed there was **no recombination anywhere in the world** — every
   * in-world lineage was a mutation chain, and crossover happened only inside the GA learner,
   * between dead organisms, at population level. That is a large gap for a model whose goal is
   * evolution.
   */
  conjugation: boolean
  spore: boolean
  /**
   * Whether particles replicate and mutate their own chemistry — evolution of the *substrate*,
   * alongside the brains' evolution of behaviour.
   *
   * Off by default: with it on, `massByType` stops being constant, because the point is that a
   * chemistry which works becomes more numerous.
   */
  /**
   * A named hand-built brain every organism is born with, instead of random weights.
   *
   * The seam that makes the feasibility tests and the Discoveries page show the *same* thing: a
   * policy written to pass one rung is installed here, so what is asserted in the suite is what
   * runs on screen. Absent means random weights, which is every ordinary world.
   */
  handBuilt?: string
  templating: boolean
  /**
   * Std-dev of the mutation applied to a copied affinity row, in quanta.
   *
   * Its own dial rather than sharing `repro_mut`: that is a std-dev over brain *weights*, on a
   * different scale and a different timescale — a brain's genome turns over once per generation,
   * a particle's once per replication.
   */
  row_mut: number
  /** The stamp a world started from. Terrain itself lives in `wallPositions`. */
  walls: 'none' | 'pillars' | 'maze' | 'ring'
  n_wall: number
  /** Every piece of terrain, as placed. A stamp fills this; painting edits it. */
  wallPositions: [number, number][]
  /** Food present at tick 0, beyond `n_food0`'s random scatter. */
  seededFood: [number, number][]
  /** Organisms placed into the world before it starts. */
  seededOrganisms: SeededOrganism[]
  /**
   * What the islands of a merged world were called, index 0 being organisms born here. Present
   * only for a merged world, and only so that four populations on one canvas can be told apart.
   */
  islandNames?: string[]
  /**
   * Where food colonies begin, when it matters. A merged world has to put its colonies on top of
   * the populations it transplanted — four islands placed in four quadrants starve within a few
   * hundred ticks if the food they are meant to converge toward starts somewhere else.
   */
  patchOrigins?: [number, number][]
  /**
   * Hold food colonies where they started until something asks them to converge. A merged world
   * uses it so that four populations meet when you press the button, not on a timer.
   */
  merge_hold?: boolean
  /**
   * What living costs, as a multiple of the laws' per-tick rates (upkeep, movement, signalling).
   *
   * In the same tier as temperature: not a law but a property of the world you are setting up.
   * Measured over 18 variants × 5 seeds × 20k ticks, it is the strongest single lever on how long
   * anything lives — 0.5 gave the longest mean life of any setting tried, 0.25 produced an
   * organism that lived 16,000 of a 20,000-tick run, and 2 halved everything.
   */
  metabolism: number
  /**
   * How fast energy moves along a bond, as a fraction of the difference per tick.
   *
   * 0 is the old world, where a bond carried force and nothing else. Above 0 a bonded group has a
   * **shared metabolism**: a member in food feeds its neighbours and a starving one can be
   * rescued. Nothing is created or destroyed — it is the only new rule in this round, and it is a
   * universal one rather than a statement that being together is good.
   */
  bond_flow: number
  bonds: boolean // particles may bond to each other (R16)
  repro: boolean // budding reproduction
  /**
   * Splitting as well as budding: a well-fed organism with two or more limbs may divide in two,
   * sharing out its limbs and halving its reserve, instead of building a child from free matter.
   */
  fission: boolean
  repro_mut: number // std-dev of weight mutation in children
  food_life: number // ticks before an uneaten food particle spoils (0 = never)
  decay_free: number // fraction of its reserve a free particle loses each tick (burned)
  inflow: boolean // continuous organism inflow: new matter is created for each spawn, and all matter is mortal
  foodMode: FoodMode
  foodLevel: FoodLevel
  foodRegime: FoodRegime
  /** Length of one cycle / bloom interval / ramp, in ticks. */
  regime_period: number
  /** How long converging colonies take to meet — and, for breathing colonies, one full cycle. */
  converge_ticks: number
  T_food: number
  T_spawn: number
  n_patch: number
  /**
   * How each source moves, and how the sources relate to each other.
   *
   * Absent means "whatever the legacy `foodMode` implied" — see `foodAxes` — so every saved world
   * and catalog row keeps behaving as it did.
   */
  sourceMotion?: SourceMotion
  sourceRelation?: SourceRelation
  /**
   * Source speed as a **fraction of how fast a solitary organism travels**, measured in-world.
   *
   * Absolute units were the bug: `comet` moved at 0.363 units a tick against an organism's 0.196, so
   * the target outran its pursuer — not a chase but an impossibility — while three other modes sat
   * at exactly zero. A fraction is catchable by construction and stays meaningful when metabolism or
   * `F_max` changes.
   */
  sourceSpeed?: number
  r_patch: number
  v_patch: number
  /**
   * How new organisms get their weights. `algo: 'none'` is the default and the control, and a
   * world with it is identical in every respect to one built before learning existed.
   */
  learn: LearnConfig
}

/** Snaps the non-food block of a matrix to QUANTA, in place, keeping it symmetric. */
/**
 * What makes P1 not P2: the properties that differ between kinds of matter.
 *
 * Until now the chemistry matrix was the *only* thing distinguishing the four matter types. Every
 * other property — how big a particle is, how readily it moves, how many neighbours it can hold,
 * how hard its bonds are to break, how fast it runs down — was a single global constant shared by
 * everything in the world. Four types that differ in one dimension are barely four types.
 *
 * These are deliberately the properties a chemical **element** has. All of them are per *type* and
 * therefore set by the search, not by the world's own evolution — the one property that becomes
 * individual and heritable is the affinity row, which is a separate change.
 *
 * Every default below reproduces the old global constant exactly, so a world that does not mention
 * elements behaves precisely as it did.
 */
export interface Element {
  /**
   * Hard-core **radius**, in world units. The pair exclusion distance is the sum of the two radii,
   * which is what makes this a size rather than a per-pair fudge: a big particle excludes a small
   * one at the distance their surfaces meet. Default 5, since `beta · r_c / 2 = 5` gave the old
   * universal `r_0` of 10 for any pair.
   */
  radius: number
  /** Mobility, as a fraction of the global `mu`. Food's entry is what `mu_food` used to be. */
  mobility: number
  /** How many bonds one particle of this type may hold — a chemical valence. */
  valence: number
  /**
   * Multiplier on `F_form` and `F_break`. A bond takes the **weaker** of its two partners, so a
   * fragile type cannot be made structural by what it attaches to.
   */
  bondStrength: number
  /** What forming a bond costs this particle. */
  bondCost: number
  /** Per-tick fractional loss of reserve while loose, replacing the single global `decay_free`. */
  decay: number
}

/**
 * The element table for a world, with **every default taken from that world's own laws**.
 *
 * This is the part that keeps the existing dials honest. `max_bonds`, `E_bond`, `mu_food` and
 * `beta` were global constants and they still are: each one is now the *default* for its per-type
 * field, so setting the law still sets every type, and the element table is the finer instrument
 * that overrides individual ones. Nothing that worked before works differently.
 *
 * Read down a column and you have one kind of matter; read across and you have one property for
 * every kind. Food's mobility is the one non-uniform default and it comes from `mu_food`, which is
 * the measured value: at 1 a crumb of food drifts exactly as fast as a limb swims, and nothing can
 * be caught.
 */
/**
 * The smallest hard-core radius a particle may have, derived rather than chosen.
 *
 * The motion budget `d_max` is justified as "half a core radius" against the old universal
 * exclusion of `r_0 = 10`. But exclusion is now the **sum of the two radii**, so a pair of small
 * particles can exclude each other at less than one tick's permitted displacement — at
 * `elementSpread` 1 the sampler draws radii down to 1.84, giving an exclusion of 3.68 against a
 * budget of 5. Measured: the share of in-core pairs sitting below a tenth of their own exclusion
 * rose from 0.0015 at the default radius to 0.0106 at radius 2, a sevenfold degradation, and two
 * isolated particles approached to 3.9% of their exclusion against 20% at the default.
 *
 * The floor is `d_max / 2`, so the worst-case pair exclusion is `d_max` itself, and `stability`
 * below then buys the rest of the margin by raising the sub-step count — the budget that actually
 * governs a single move is `d_max / substeps`, not `d_max`. Flooring each radius at `d_max`
 * instead would restore the original two-fold margin in one stroke but forbid small particles
 * altogether, turning size into a dial that only goes up.
 *
 * Clamped here rather than in the sampler, so a hand-written config and a search draw are bound
 * by the same rule.
 */
export const minRadius = (L: Laws): number => L.d_max / 2

export function elementsOf(given: (Partial<Element> | undefined)[] | undefined, L: Laws): Element[] {
  const floor = minRadius(L)
  return [0, 1, 2, 3, 4, 5, 6].map((t) => ({
    // half the old universal exclusion, so two default particles still part at exactly r_0
    radius: (L.beta * L.r_c) / 2,
    mobility: t === FOOD_TYPE ? L.mu_food : 1,
    valence: L.max_bonds,
    bondStrength: 1,
    bondCost: L.E_bond,
    decay: 0,
    ...(given?.[t] ?? {}),
  })).map((e) => ({ ...e, radius: Math.max(floor, e.radius) }))
}

/** Food's type tag. Spelled out here because params must not import from types for this alone. */
const FOOD_TYPE = 5

/**
 * Pads a matrix up to the current width, leaving the new rows and columns at zero.
 *
 * Exists so that adding Brain to the chemistry did not require touching every preset, recipe,
 * saved config, test fixture and catalog row in the project. A 5x5 matrix means "the world as it
 * was, with no brain chemistry", which is precisely the behaviour those worlds were measured
 * under, so widening with zeros is not a convenience — it is the correct interpretation.
 *
 * Returns the input untouched when it is already wide enough, so this is safe to call anywhere.
 */
export function widenMatrix(A: number[][]): number[][] {
  if (A.length >= N_MATRIX && A.every((r) => r.length >= N_MATRIX)) return A
  return Array.from({ length: N_MATRIX }, (_, i) => Array.from({ length: N_MATRIX }, (_, j) => A[i]?.[j] ?? 0))
}

export function applyQuantization(A: number[][]): number[][] {
  // the matter block only: Food and Brain couplings are scaled rather than quantized
  for (let i = 0; i < N_MATTER; i++) {
    for (let j = i; j < N_MATTER; j++) {
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
export const WALL_LAYOUTS = ['none', 'pillars', 'maze', 'ring'] as const
export type WallLayout = (typeof WALL_LAYOUTS)[number]

/** An organism to place before the world starts; `organism` is a saved file, inline. */
export interface SeededOrganism {
  /** Serialized OrganismFile, kept as unknown here so core/params stays free of UI types. */
  organism?: unknown
  x: number
  y: number
  /** Which island this line came from, for a merged world. 0 means native. */
  island?: number
}

/** Lays a layout's terrain into an Init, replacing whatever was there. */
export function applyWallStamp(init: Init, L: Laws = LAWS): Init {
  init.wallPositions = wallStamp(init.walls, init.n_wall, init.size, L)
  return init
}

/**
 * Terrain for a named layout. A stamp is only a starting point: it fills `wallPositions`, which
 * can then be painted over, so a layout is a convenience rather than a constraint.
 */
export function wallStamp(layout: WallLayout, count: number, size: number, L: Laws = LAWS): [number, number][] {
  const out: [number, number][] = []
  if (layout === 'none' || count <= 0) return out
  const wrap = (v: number): number => ((v % size) + size) % size
  if (layout === 'pillars') {
    const per = Math.max(2, Math.round(Math.sqrt(count)))
    const cell = size / per
    for (let k = 0; k < count; k++) {
      out.push([wrap((k % per) * cell + cell / 2), wrap(Math.floor(k / per) * cell + cell / 2)])
    }
    return out
  }
  if (layout === 'ring') {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2
      out.push([wrap(size / 2 + size * 0.35 * Math.cos(a)), wrap(size / 2 + size * 0.35 * Math.sin(a))])
    }
    return out
  }
  // maze: a few straight runs at right angles
  const runs = Math.max(1, Math.round(count / 12))
  const perRun = Math.max(1, Math.round(count / runs))
  for (let k = 0; k < count; k++) {
    const run = Math.floor(k / perRun)
    const horizontal = run % 2 === 0
    const base = ((run + 1) / (runs + 1)) * size
    const along = (k % perRun) * 2 * L.r_wall + size * 0.1
    out.push(horizontal ? [wrap(along), wrap(base)] : [wrap(base), wrap(along)])
  }
  return out
}

export function coreRadius(brainA: boolean, brainB: boolean, L: Laws): number {
  if (brainA && brainB) return L.r_brain
  if (brainA || brainB) return L.r_brain_core
  return L.beta * L.r_c
}

/** `scale` multiplies the world edge; counts and rates scale with area so density stays constant. */
function seedWorld(seed: number, scale = 1): Init {
  const rng = new Rng(seed)
  // eslint-disable-next-line prefer-const -- named so the single-source clamp below can be applied
  const area = scale * scale
  const A = Array.from({ length: N_MATRIX }, () => new Array<number>(N_MATRIX).fill(0))
  /*
   * The P1..P4 and Food block, drawn in exactly the order and count it always was.
   *
   * This matters more than it looks. Widening the matrix inside this one loop would have drawn six
   * extra values from `rng` before everything else in this function — temperature, counts, food
   * pattern, the lot — so **every seeded world in the project would have become a different
   * world**, and the change would have looked like a bug in six unrelated tests rather than like
   * the matrix getting wider.
   */
  for (let i = 0; i <= FOOD_ROW; i++) {
    for (let j = i; j <= FOOD_ROW; j++) {
      if (i === FOOD_ROW && j === FOOD_ROW) continue // Food x Food: nothing
      const a = Math.round((rng.next() * 2 - 1) * 100) / 100
      A[i][j] = a
      A[j][i] = a
    }
  }
  /*
   * Brain's couplings, from a stream of their own, so not one draw above was displaced.
   *
   * A fresh seed therefore produces the world it always did *except* for the brain row, which is
   * the smallest honest change available: the matrix is the world's genome, so widening it has to
   * mean something, or the UI's random worlds could never show brain chemistry at all.
   *
   * Specs are unaffected either way. A catalog row carries its 14 entries explicitly and widens
   * with zeros, so every scored world still replays exactly as it was scored. Seeds move, specs
   * do not — and specs are what the search and the Discoveries page are built on.
   */
  const brng = new Rng((seed ^ 0x51a7f0b3) | 0)
  for (let j = 0; j <= BRAIN_ROW; j++) {
    const a = Math.round((brng.next() * 2 - 1) * 100) / 100
    A[BRAIN_ROW][j] = a
    A[j][BRAIN_ROW] = a
  }
  const init: Init = {
    seed,
    size: LAWS.SIZE * scale,
    scale,
    A: applyQuantization(A),
    quantized: true,
    substeps: 1,
    // Stability budget: the Brownian step sqrt(2 mu T) must stay under a fifth of the core
    // radius r_0 = 10, which caps T near 4. Hotter worlds can be typed in, and the start screen
    // flags them; reaching a genuine gas phase needs sub-stepping (see docs/PLAN.md section 1).
    T: Math.round(Math.pow(4, rng.next()) * 10) / 10, // 1 .. 4
    n_intrinsic: (30 + rng.int(21)) * area,
    n_brain: 4 * area,
    n_start: (1 + rng.int(2)) * area,
    n_food0: 30 * area,
    // Room for food to pile up. 120 was close enough to the standing stock of a well-fed world
    // that the ceiling, not the sun, was setting the supply — and a capacity that binds is a
    // thermostat whether or not it was meant as one. 300 leaves headroom for food to accumulate
    // where nothing eats it, which is what makes a patch genuinely rich and a desert genuinely
    // empty now that food is too heavy to spread itself out.
    max_food: 300 * area,
    food_batch: area,
    spawn_batch: area,
    foodMoves: false,
    conjugation: false,
    spore: false,
    templating: false,
    row_mut: 0.25, // one quantum: the smallest step the chemistry can actually represent
    walls: 'none',
    n_wall: 40 * area,
    wallPositions: [],
    seededFood: [],
    seededOrganisms: [],
    bonds: true,
    repro: true,
    fission: true,
    repro_mut: 0.05,
    food_life: 200,
    decay_free: 0.002,
    inflow: false,
    foodMode: FOOD_MODES[rng.int(FOOD_MODES.length)],
    foodLevel: FOOD_LEVELS[rng.int(FOOD_LEVELS.length)],
    foodRegime: FOOD_REGIMES[rng.int(FOOD_REGIMES.length)],
    regime_period: (1500 + rng.int(3501)) * scale,
    converge_ticks: (2000 + rng.int(6001)) * scale,
    T_food: 2 + rng.int(5),
    T_spawn: 60 + rng.int(81),
    n_patch: (1 + rng.int(3)) * area,
    r_patch: 35 + rng.int(31),
    v_patch: Math.round(rng.range(0.05, 0.2) * 100) / 100,
    learn: { ...LEARN_DEFAULTS },
    metabolism: 0.5,
    bond_flow: 0.05,
  }
  /*
   * `comet` and `spring` name worlds with a *single* source. Applied after the literal rather than
   * inside it, so that no random draw moves: `foodMode` must be drawn where it always was, or every
   * seed-based world shifts by one draw and all of them become different worlds.
   *
   * The clamp lives here and in `specInit` rather than in the World, which has to believe whatever
   * count it is handed — a world built in the browser with eight sources should get eight.
   */
  if (init.foodMode === 'comet' || init.foodMode === 'spring') init.n_patch = 1
  return init
}

/**
 * Food a world needs each tick simply to break even, in food particles.
 *
 * **Three** sinks now, and the third is the one that was missing. Upkeep of a full population (a
 * brain and four limbs each), the slow bleed of loose matter, and — new — the cost of *bringing
 * bodies into existence at all*.
 *
 * That third term used to be free. A spawn created a four-limbed body and endowed every particle of
 * it out of nothing, which was measured at 41% and 67% of all energy entering two sample worlds.
 * Now a loose brain has to eat its way over an activation barrier and pay to recruit each limb, so
 * the energy a population needs to keep replacing its dead is a real demand on the sun, and leaving
 * it out of the budget made every food level mean less than it claimed.
 *
 * How much it is: each body that comes into existence costs `E_activate` to start plus four bond
 * fees, and bodies have to be replaced at the rate they die. `recordAge` is not available here —
 * this is called before a world runs — so the replacement rate is taken as one full turnover of the
 * population per `T_LIFE` ticks, which is the order of magnitude a run actually shows.
 *
 * Measured consequence of getting this wrong: populations survived but barely, and peaked at about
 * **ten times** the old `average` level. Island worlds calibrated under the subsidy produced zero
 * survivors over 3,000 ticks.
 */
/** Ticks over which a population is assumed to replace itself once, for the budget above. */
const T_LIFE = 1200

export function sustenanceRate(init: Init, L: Laws = LAWS): number {
  // the metabolism dial has to appear here too: food levels are calibrated as multiples of what a
  // world costs to run, so a world that costs half as much must be fed half as much to mean the
  // same thing by "average"
  const m = init.metabolism ?? 1
  const slots = init.n_brain * (init.inflow ? 3 : 1)
  const bodies = 5 * (L.c_up * m) * slots
  const loose = init.n_intrinsic * L.E_init * init.decay_free
  // starting a body, and the four bonds that make it one, charged over a population's lifetime
  const renewal = (slots * (L.E_activate + 4 * L.E_bond)) / T_LIFE
  return (bodies + loose + renewal) / L.E_food
}

/**
 * Multiples of `sustenanceRate`, calibrated by what they actually produce rather than by the
 * budget on paper — most food is never reached, so break-even on paper is already plenty in
 * practice. Measured over 5000 ticks across three seeds: 0.12x leaves about 20 food standing and
 * barely one organism alive, 0.4x about 45 food and five organisms, and 2x pins both at the cap.
 */
export const LEVEL_MULTIPLIER: Record<FoodLevel, number> = { scarce: 0.12, average: 0.4, abundant: 2 }

/** Sets the base arrival rate so a level means the same thing at any world size. */
export function applyFoodLevel(init: Init, L: Laws = LAWS): Init {
  const want = sustenanceRate(init, L) * LEVEL_MULTIPLIER[init.foodLevel]
  // one particle per T_food ticks, batched when a single particle a tick is not enough
  init.food_batch = Math.max(1, Math.round(want))
  init.T_food = Math.max(1, Math.round(init.food_batch / Math.max(1e-6, want)))
  init.max_food = foodCapFor(init)
  return init
}

/**
 * How many food slots a world actually needs, from its own arrival rate and spoilage.
 *
 * It used to be `300 * area`, a per-tile constant, and **about 10% of it was ever used** — measured
 * at 11.0%, 9.8%, 9.9% and 9.8% across scales 1, 2, 4 and 8. That is nine tenths of the largest
 * allocation in the program sitting idle, which did not matter at 1x and decides whether a large
 * world fits in memory at all: at 128x the old rule asks for **4.9 million food slots**, and the
 * arrays behind them are most of a two-gigabyte world.
 *
 * Standing food is governed by arrival rate times spoilage life, which predicted the measured peak
 * within a factor of 1.6 at every scale (33 against 18, 118 against 67, 473 against 200, 1887
 * against 1200). The overshoot is food accumulating where nothing eats it, so the headroom below is
 * generous rather than tight — running out of food slots does not fail loudly, it quietly caps the
 * sun, and `lightWasted` is the only trace.
 *
 * Food that never spoils is the case with no natural bound, so it keeps the old per-area rule.
 */
export function foodCapFor(init: Init, L: Laws = LAWS): number {
  const area = (init.size / L.SIZE) ** 2
  const perArea = Math.round(300 * area)
  if (init.food_life <= 0) return perArea
  const rate = init.food_batch / Math.max(1, init.T_food)
  const standing = rate * init.food_life
  // 4x headroom over the predicted standing level, a floor so small worlds are not starved of
  // slots, and the old per-area figure as a ceiling so this can only ever ask for less
  return Math.max(64, Math.min(perArea, Math.ceil(standing * 4)))
}

/** Food particles a tick this world is set to deliver, before the regime scales it. */
export function baseFoodRate(init: Init): number {
  return init.food_batch / Math.max(1, init.T_food)
}

/**
 * How the arrival rate is scaled at a given tick. Deterministic in every regime — "noisy" is a
 * sum of sines rather than a random draw, so a world stays reproducible from its seed and the
 * regime never disturbs the random stream.
 */
export function regimeMultiplier(init: Init, tick: number): number {
  const p = Math.max(1, init.regime_period)
  const phase = (tick % p) / p
  switch (init.foodRegime) {
    case 'cycle':
      // famine to feast and back: 0.15x at the trough, 2.5x at the peak
      return 0.15 + 1.175 * (1 - Math.cos(2 * Math.PI * phase))
    case 'bloom': {
      // a long famine broken by a brief, enormous bloom
      const width = 0.08
      return phase < width ? 9 : 0.12
    }
    case 'decline':
      // a world running down: full at the start, nothing by the end of the period
      return Math.max(0, 1.8 * (1 - Math.min(1, tick / p)))
    case 'rising':
      return 0.1 + 1.7 * Math.min(1, tick / p)
    case 'noisy': {
      const t = tick / p
      const n = Math.sin(6.283 * t) + 0.7 * Math.sin(15.1 * t + 1.3) + 0.45 * Math.sin(37.7 * t + 2.9)
      return Math.max(0.05, 1 + 0.55 * n)
    }
    default:
      return 1
  }
}

/** A seeded world, already sub-stepped enough to be numerically safe and fed to its level. */
export function initFromSeed(seed: number, scale = 1): Init {
  const init = seedWorld(seed, scale)
  init.wallPositions = wallStamp(init.walls, init.n_wall, init.size)
  init.substeps = Math.max(1, substepsFor(init) || LAWS.substeps_max)
  return applyFoodLevel(init)
}

/** Smallest sub-step count that brings a world inside its budget, or 0 if none within the cap. */
export function substepsFor(init: Init, L: Laws = LAWS): number {
  for (let n = 1; n <= L.substeps_max; n++) if (stability({ ...init, substeps: n }, L).ok) return n
  return 0
}

/** How far apart a bond may be made, and how far it can be stretched before it snaps. */
export function bondRange(L: Laws): { form: number; breakAt: number } {
  return { form: L.r_bond + L.F_form / L.k_bond, breakAt: L.r_bond + L.F_break / L.k_bond }
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
  /*
   * Measured against **this world's own** smallest exclusion and fastest matter, not the global
   * defaults.
   *
   * It used `L.beta * L.r_c` and `L.mu` flat, so it was blind to both per-type radii and per-type
   * mobility: a world whose particles are small or light was declared stable on the strength of
   * numbers belonging to a different world. Measured over 20,000 sampled specs, **70% sat outside
   * the stated budget** — 0% at `elementSpread` 0 and about 93% at every nonzero spread — so
   * `elementSpread` was confounded with numerical breakage, and "does differentiating the types
   * help?" was partly "does over-stepping the integrator help?".
   *
   * Taking the worst case of each means `substepsFor` now buys sub-steps to cover whatever the
   * element table asks for, which is what keeps the exclusion guarantee while letting size and
   * mass vary.
   */
  const els = elementsOf(init.elements, L)
  const smallest = els.reduce((m, e) => Math.min(m, e.radius), Number.POSITIVE_INFINITY)
  const fastest = els.slice(0, 4).reduce((m, e) => Math.max(m, e.mobility), 1)
  const r0 = 2 * smallest
  const n = Math.max(1, Math.round(init.substeps))
  // sub-stepping splits the tick: each Brownian increment is sqrt(n) smaller
  const sigma = Math.sqrt((2 * L.mu * fastest * init.T) / n)
  const forceStep = (L.mu * fastest * L.K_core) / n
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
