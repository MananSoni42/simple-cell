import { type ForceBackend, serialBackend } from './backend'
import { type KernelArrays, type KernelParams } from './forcekernel'
import { AggregateTracker } from './aggregates'
import { Bonds, bondForce } from './bonds'
import { type FitnessSpec, describeSpec } from './fitness'
import { LadderTracker } from './ladder'
import { Cognition } from './cognition'
import { HAND_BUILT } from './handbuilt'
import { LEARN_DEFAULTS, type LearnConfig, type Learner, type LifeStats, ONLINE_ALGOS, makeLearner } from './learning'
import { LifeTracker, RollingMean } from './lifestats'
import { OrderTracker } from './orders'
import { BRAIN_IN, BRAIN_OUT, FOOD_NEAR_SCALE, N_BRAIN_IN, N_BRAIN_OUT, randomBrain, randomLimb } from './neurons'
import { type Element, type Init, type Laws, LAWS, applyQuantization, clamp11, elementsOf, quantize, widenMatrix, regimeMultiplier } from './params'
import { Rng } from './rng'
import { BRAIN, FOOD, FOOD_ROW, MATRIX_INDEX, N_MATRIX, WALL } from './types'

const HALF_PI = Math.PI / 2
const TAU = Math.PI * 2

/**
 * How often the source speed is re-measured against the population, in ticks.
 *
 * Not every tick: `soloBaseline` walks every organism. Not rarely either — the measurement is the
 * difficulty setting, and a source running at last millennium's population speed is the absolute-units
 * bug back again in slower form.
 */
const SRC_V_EVERY = 100

/** Solitary organisms needed before their median speed is worth setting a source's speed from. */
const SRC_MIN_SOLO = 5

/**
 * Solitary organisms of a given body size needed before a size-matched baseline is used.
 *
 * Below this the match is abandoned for the pooled median: a matched baseline drawn from two
 * organisms is noisier than an unmatched one drawn from eleven, and a rung beating noise is not
 * evidence of anything.
 */
const SOLO_MATCH_MIN = 4
const N_IN = N_BRAIN_IN
const N_OUT = N_BRAIN_OUT

export interface WorldOpts {
  laws?: Partial<Laws>
  autoSpawn?: boolean
  maxFood?: number
  /** Spare terrain slots for painting; 0 for a fixed world. */
  wallRoom?: number
  /** Allocate state in SharedArrayBuffers so worker threads can read and write it. */
  shared?: boolean
  /**
   * Brain inputs to hold at zero, by index (see `BRAIN_IN`).
   *
   * This is the ablation seam, and it exists so that "the brain can now sense X" is a measurable
   * claim rather than an asserted one. Adding a sense and adding a world change at the same time
   * makes neither attributable; blinding one input while changing nothing else does. It costs one
   * short loop per brain per tick and is off unless asked for.
   */
  blind?: number[]
}

export interface OrganismSpec {
  brain: number
  x: number
  y: number
  limbs: { idx: number; quad: number; angle: number }[]
  /** Inherited brain weights; fresh random ones are drawn when absent. */
  wLimb?: Float64Array
  wBrain?: Float64Array
  parent?: number
  gen?: number
  /** The learner's tag, when these weights came from one. */
  learnId?: number
  /** Which island this line came from; inherited by its descendants. */
  island?: number
}

function buffer(bytes: number, shared: boolean): ArrayBufferLike {
  return shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
}

/** Live-particle arrays the grid reads when it packs them in cell order. */
export interface GridSource {
  x: Float64Array
  y: Float64Array
  alive: Uint8Array
  type: Uint8Array
  owner: Int32Array
}

/**
 * Spatial hash over the torus. Cell size >= r_c, so a 3x3 block covers every interaction.
 * Live particles are counting-sorted into cells (ascending index within a cell, so matter
 * always precedes food) and their hot fields are copied into packed arrays in that order.
 */
export class Grid {
  readonly nc: number
  readonly cs: number
  readonly start: Int32Array // cell -> first packed slot
  readonly matterEnd: Int32Array // cell -> end of its matter (food follows, up to start[cell + 1])
  readonly items: Int32Array // packed slot -> particle index
  readonly cellOf: Int32Array // particle -> cell (-1 if not live)
  readonly px: Float64Array
  readonly py: Float64Array
  readonly ptype: Uint8Array
  readonly powner: Int32Array
  readonly pcell: Int32Array
  readonly buf: Int32Array
  count = 0 // number of live particles = packed length
  private fill: Int32Array

  constructor(size: number, rc: number, private cap: number, private nMatter: number, private src: GridSource, shared = false) {
    this.nc = Math.max(3, Math.floor(size / rc))
    this.cs = size / this.nc
    const cells = this.nc * this.nc
    this.start = new Int32Array(buffer(4 * (cells + 1), shared))
    this.matterEnd = new Int32Array(cells)
    this.fill = new Int32Array(cells)
    this.items = new Int32Array(buffer(4 * cap, shared))
    this.cellOf = new Int32Array(buffer(4 * cap, shared))
    this.px = new Float64Array(buffer(8 * cap, shared))
    this.py = new Float64Array(buffer(8 * cap, shared))
    this.ptype = new Uint8Array(buffer(cap, shared))
    this.powner = new Int32Array(buffer(4 * cap, shared))
    this.pcell = new Int32Array(buffer(4 * cap, shared))
    this.buf = new Int32Array(cap)
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.nc - 1, Math.floor(x / this.cs))
    const cy = Math.min(this.nc - 1, Math.floor(y / this.cs))
    return cy * this.nc + cx
  }

  build(): void {
    const { start, matterEnd, fill, items, cellOf, px, py, ptype, powner, pcell, cap, nMatter } = this
    const { x, y, alive, type, owner } = this.src
    const cells = fill.length
    start.fill(0)
    matterEnd.fill(0)
    for (let i = 0; i < cap; i++) {
      if (!alive[i]) {
        cellOf[i] = -1
        continue
      }
      const c = this.cellIndex(x[i], y[i])
      cellOf[i] = c
      start[c + 1]++
      if (i < nMatter) matterEnd[c]++
    }
    for (let c = 0; c < cells; c++) {
      start[c + 1] += start[c]
      matterEnd[c] += start[c]
    }
    fill.set(start.subarray(0, cells))
    for (let i = 0; i < cap; i++) {
      const c = cellOf[i]
      if (c < 0) continue
      const k = fill[c]++
      items[k] = i
      px[k] = x[i]
      py[k] = y[i]
      ptype[k] = type[i]
      powner[k] = owner[i]
      pcell[k] = c
    }
    this.count = start[cells]
  }

  /** Fills `buf` with every item in the 3x3 block around (x, y); returns the count. */
  near(x: number, y: number): number {
    const { nc, start, items, buf } = this
    const c = this.cellIndex(x, y)
    const cx = c % nc
    const cy = (c - cx) / nc
    let n = 0
    for (let dy = -1; dy <= 1; dy++) {
      const row = ((cy + dy + nc) % nc) * nc
      for (let dx = -1; dx <= 1; dx++) {
        const cc = row + ((cx + dx + nc) % nc)
        for (let k = start[cc]; k < start[cc + 1]; k++) buf[n++] = items[k]
      }
    }
    return n
  }
}

export class World {
  readonly L: Laws
  readonly init: Init
  readonly rng: Rng
  readonly A: Float64Array // flattened symmetric chemistry matrix
  readonly continuous: boolean
  readonly nWall: number
  readonly nIntr: number
  readonly nMatter: number
  readonly cap: number

  tick = 0
  burned = 0
  injected = 0
  nBirths = 0
  nBudded = 0
  /** Children with two parents (R7.9) and spores sown and germinated (R7.10). */
  nConjugated = 0
  nSown = 0
  nGerminated = 0
  /** Particles that have copied themselves (R7.11). */
  nTemplated = 0
  nDeaths = 0
  recordAge = 0
  readonly bornAt: Int32Array
  readonly gen: Int32Array // generation: 0 for spawned organisms, parent + 1 for budded ones
  readonly parent: Int32Array
  /**
   * The second parent of a conjugated child, or -1.
   *
   * `parent` stays single so that lineage, generation and every statistic built on them keep
   * meaning what they meant. A second parent is recorded alongside rather than instead, which is
   * the honest shape: descent through one line, inheritance from two.
   */
  readonly coparent: Int32Array
  /**
   * A free particle carrying a genome, waiting for somewhere worth waking up (R7.10).
   *
   * A spore is not a new kind of particle. It is ordinary free matter with a flag and a stored
   * brain — it drifts, it decays, it is pushed around by the same chemistry — which is why this
   * costs one array and no new physics.
   */
  readonly isSpore: Uint8Array
  readonly repCool: Int16Array
  /** What the brain last told each socket; the limb neuron reads it next tick. */
  readonly brainSig: Float64Array
  readonly bonds: Bonds
  readonly bondCool: Int16Array
  /** Tick at which a matter particle last became "live" (alive with energy > 0). */
  readonly since: Int32Array
  /** Snapshotted, so a rewind restores liveness bookkeeping rather than silently re-deriving it. */
  wasLive: Uint8Array
  readonly lifeParticles = new LifeTracker()
  readonly lifeOrganisms = new LifeTracker()
  readonly aggregates = new AggregateTracker()
  readonly orders = new OrderTracker()
  readonly lifeParticlesWindow: RollingMean
  readonly lifeOrganismsWindow: RollingMean
  /** Lineage: a spawned organism founds one; its descendants inherit the id. */
  readonly lineage: Int32Array
  readonly children: Int32Array
  /**
   * Per-organism lifetime tallies, indexed by the brain slot and reset when a body is placed.
   * Nothing but age and offspring was recorded before, which meant no fitness was computable —
   * these are what the library and any learner both need.
   */
  readonly harvested: Float64Array // energy taken in from food
  readonly spent: Float64Array // energy burned on upkeep, movement and signalling
  readonly moved: Float64Array // distance the body has travelled
  readonly meals: Int32Array // food particles consumed
  readonly orderTicks: Float64Array // time spent in a compound, weighted by its order
  readonly peakReserve: Float64Array // the most the brain ever held
  /**
   * How well a body's movement lines up with where food is, summed over the ticks it could tell.
   *
   * The cosine between the direction it moved and the direction food lay, accumulated only on
   * ticks when there was a direction to compare against. Divided by `seekTicks` it is a number in
   * [-1, 1]: zero is a random walk, and anything clearly positive is an organism *going to* food
   * rather than happening upon it. It is the one foraging measure that cannot be passed by sitting
   * still, because sitting still never adds a term.
   */
  readonly seeking: Float64Array
  readonly seekTicks: Float64Array
  /**
   * When an organism is ready to reproduce, and how long it waits afterwards — **per organism**,
   * inherited with mutation rather than fixed by law.
   *
   * These were two constants, `E_repro` and `repro_cooldown`, which made every organism in every
   * world share one reproductive strategy. Moving them into the genome deletes two laws rather
   * than adding one, and it makes the strategy itself something the world can discover: whether to
   * breed early and cheaply or late and well is exactly the kind of question this project is
   * supposed to let the world answer instead of us.
   */
  readonly eRepro: Float64Array
  readonly repWait: Float64Array
  /**
   * What a body was given at birth and how long that gift alone would last. Together they are the
   * yardstick the ladder measures lives against: an organism that outlives its coasting time has
   * fed itself, whatever the metabolism dial says — which is what makes the measure impossible to
   * game by making living cheaper.
   */
  readonly endowment: Float64Array
  readonly coastT: Float64Array
  /** Has this organism ever been part of an order-2+ group, and was its parent one when it was born. */
  readonly hasJoined: Uint8Array
  /**
   * Where an organism began, so its **net** displacement is available rather than only its path
   * length (`moved`).
   *
   * These two are not interchangeable and the difference decides a rung. A thrashing organism
   * accumulates path length and goes nowhere; one that swims straight accumulates both. "Did a
   * structure travel" is a question about net displacement, and nothing recorded it.
   */
  readonly spawnX: Float64Array
  readonly spawnY: Float64Array
  /**
   * What each organism does with what it knows — the measurements the intelligence rungs read.
   *
   * Separate from the world's own state because it is an *instrument*: it reads, accumulates, and
   * draws its shuffled nulls from its own random stream, so having it switched on moves nothing.
   */
  readonly cognition: Cognition
  /** Per-type properties, and the flat tables the hot loops read them from. */
  readonly elements: Element[]
  readonly eRadius: Float64Array
  readonly eMobility: Float64Array
  readonly eValence: Int32Array
  readonly eBondStrength: Float64Array
  readonly eBondCost: Float64Array
  readonly eDecay: Float64Array
  /** Each particle's own affinity row: `rows[i * N_MATRIX + m]`. See the constructor. */
  readonly rows: Float64Array
  /** Ticks before a particle may copy itself again. */
  /** Snapshotted: see `views()`. */
  readonly tmplCool: Int16Array
  /**
   * Where the next scan for an empty matter slot starts.
   *
   * A rotating cursor over a *scan*, deliberately not a free list. The first version kept a list
   * of slots emptied by decay, and the list went stale: `bud` recruits free matter by testing
   * `owner === -1 && type matches && cool === 0` with **no liveness check** — which was safe while
   * matter was immortal and every slot was alive. Once matter could die, budding began recruiting
   * corpses as limbs, and the stale list then let a replication overwrite a live limb and destroy
   * its reserve. Measured: 361 of the list's entries were alive, and 150 energy went missing.
   *
   * A scan cannot go stale, which is worth more here than the cost of the scan — and the cursor
   * means each pass starts where the last finished, so the work is spread rather than repeated.
   */
  /** Snapshotted as a scalar: a scan position is state like any other. */
  matterCursor = 0
  readonly parentJoined: Uint8Array
  /**
   * The learner's tag for this organism, or 0 if its weights came from chance. A distribution
   * learner has to match a death back to the sample that caused it, and recovering the sample from
   * the weights would be wrong the moment its mean moved — so the tag travels with the body.
   */
  readonly learnId: Int32Array
  /**
   * Which island an organism's line came from, or 0 for one born here.
   *
   * Set when a body is placed into a world, inherited by every descendant. Without it a merged
   * world is unreadable: four populations that look identical on the canvas, and no way to say
   * which of them is taking the place over — which is the entire question a merge asks.
   */
  readonly island: Int8Array
  /**
   * How new organisms get their weights. `none` by default, in which case this object only ever
   * answers "let chance decide" and the world behaves exactly as it did before learning existed.
   */
  learner: Learner
  /**
   * Every time the measure changed, and to what. A run whose objective moved mid-flight cannot be
   * compared against anything, so it has to be able to say so — otherwise the summary's "learned
   * with X on Y" is a lie about most of the run.
   */
  readonly fitnessChanges: { tick: number; measure: string }[] = []
  /** The ladder of milestones, tracked with windows and hysteresis so the readout cannot flicker. */
  readonly ladderT = new LadderTracker()
  /**
   * The tick convergence began, or null while the colonies are held apart. `merge_hold` starts a
   * world in the held state; `beginMerge()` releases it.
   */
  mergeStart: number | null = 0
  lineageCounter = 1
  nClamped = 0 // how often the per-tick step guardrail has had to bite
  nSteps = 0
  /**
   * Food the sun produced that the world had no room for.
   *
   * The supply rate is fixed; only storage is finite. Counting the overflow is what distinguishes
   * "this world is saturated with food" from "this world is barely lit", which were previously the
   * same observation — in both cases food simply stopped arriving.
   */
  lightWasted = 0
  /**
   * Why reproduction did not happen, counted by cause.
   *
   * `bud` had five silent early returns, so "nothing is breeding" could mean a shortage of energy,
   * of free matter, of brain slots, or of space — four different diagnoses with one symptom. A
   * world that has run out of matter looks exactly like a world whose chemistry cannot support
   * reproduction, and the first is a budget to raise while the second is a result.
   */
  repBlocked = { slots: 0, matter: 0, energy: 0, room: 0, limbless: 0 }
  readonly initialEnergy: number

  // particle state (struct of arrays)
  readonly x: Float64Array
  readonly y: Float64Array
  readonly fx: Float64Array
  readonly fy: Float64Array
  readonly energy: Float64Array
  readonly type: Uint8Array
  readonly alive: Uint8Array
  readonly owner: Int32Array // organism (brain index) or -1; a brain owns itself
  readonly socket: Int8Array
  readonly theta: Float64Array
  readonly sig: Float64Array
  readonly msg: Float64Array
  readonly foodNear: Float32Array
  readonly ffx: Float64Array
  readonly ffy: Float64Array
  readonly cool: Int16Array

  // organism state, indexed by brain particle
  readonly limbs: Int32Array // [brain*4 + socket] -> limb particle or -1
  readonly mvx: Float64Array
  readonly mvy: Float64Array
  /**
   * Where a brain was at the start of this tick, and how far it actually got.
   *
   * `lvx/lvy` is net displacement over the whole tick — after sub-stepping, after the step clamp,
   * after brain separation — which is why it is worth feeding back to the brain. `mvx/mvy` is the
   * force the brain *asked* for; this is what the world granted, and the difference between the
   * two is everything the body ran into.
   */
  private readonly preX: Float64Array
  private readonly preY: Float64Array
  readonly lvx: Float64Array
  readonly lvy: Float64Array
  /**
   * Harvest already reported to an online learner, so each tick's reward is what was eaten *since
   * the last look* rather than a running total. Only touched when a learner is online.
   */
  /** Snapshotted: see `views()`. Harvest already reported to an online learner. */
  readonly rewarded: Float64Array
  /**
   * The weights an organism was born with, kept only when inheritance is Darwinian.
   *
   * With `inherit: 'learned'` a child copies its parent's *current* weights, so anything the
   * parent learned within its life is passed on — Lamarckian, which is known to be faster and to
   * generalise worse. With `'birth'` it copies what the parent started from, so learning shapes
   * a life and selection alone shapes the lineage.
   */
  readonly wBirthBrain: (Float64Array | undefined)[]
  readonly wBirthLimb: (Float64Array | undefined)[]
  private readonly darwinian: boolean
  readonly wLimb: (Float64Array | undefined)[]
  readonly wBrain: (Float64Array | undefined)[]

  readonly grid: Grid
  readonly kernelArrays: KernelArrays
  readonly kernelParams: KernelParams
  backend: ForceBackend = serialBackend
  readonly field: Float64Array
  private fieldTmp: Float64Array
  /** Scratch for bond energy flow, so a tick allocates nothing. */
  private readonly flowOut: Float64Array
  private readonly flowIn: Float64Array
  private readonly flowE: Float64Array
  private freeFood: number[] = []
  /**
   * How fast a food source currently moves, in units per tick.
   *
   * Derived rather than configured: `sourceSpeed` is a *fraction* of how fast a solitary organism
   * travels, so this is that fraction times a measurement of the population. Cached and refreshed
   * on a cadence because `soloBaseline` walks every organism, and carried in the snapshot because
   * otherwise a restore would run on a stale value for up to `SRC_V_EVERY` ticks and diverge.
   */
  srcV = 0

  /** Food patches. `ox, oy` is where a patch started, which converging colonies travel from. */
  readonly patches: { x: number; y: number; h: number; ox: number; oy: number; dx: number; dy: number }[] = []
  /**
   * How fast a brain was travelling **before it first joined a compound**, as net displacement per
   * tick. Zero until it joins, and frozen from then on.
   *
   * This is the travel rung's null, and it is a *within-organism* one, which is the only kind that
   * survives this world. Every between-group baseline tried here failed for a different reason and
   * each failure looked like the rung working:
   *
   * - "organisms that never joined" is sticky, so in a world that bonds well the baseline empties
   *   and the rung silently reports zero — a structure of order 41 travelling at 0.77 scored 0.
   * - "organisms holding no bond" was fine only while bodies arrived pre-assembled; once a brain
   *   builds its body from loose matter it nearly always holds a bond, so the baseline collapsed to
   *   brains in empty space and `Moves together` read 3.81x on an unaided world.
   * - "organisms not in a compound, size-matched" fixed the size confound and still read 2.77x,
   *   because a solo brain is typically bonded to *inert matter it drags* while a compound member's
   *   partners are organisms that push. Anchoring, not coordination.
   *
   * Comparing an organism against its own earlier self cancels all three at once — size, anchoring
   * and whereabouts are held constant because it is the same organism.
   */
  readonly preJoinSpeed: Float64Array

  /** Fractional food owed by the sun, so any arrival rate works, including less than one a tick. */
  /** Fractional food the sun still owes; part of the state, so a snapshot must carry it. */
  foodOwed = 0
  /** Where `arriveBrain` last looked, so a full world is not rescanned from zero each tick. */
  private brainCursor = 0
  private spring: [number, number] = [0, 0]

  /** Brain inputs forced to zero, for ablation experiments; null in an ordinary world. */
  private readonly blind: number[] | null
  private xin = new Float64Array(N_IN)
  private yout = new Float64Array(N_OUT)

  constructor(init: Init, opts: WorldOpts = {}) {
    this.init = init
    // The metabolism dial scales the three per-tick costs here rather than at every call site, so
    // nothing downstream has to remember it exists — and an explicit `opts.laws` override still
    // wins, which is what the sweeps rely on.
    const met = init.metabolism ?? 1
    this.L = {
      ...LAWS,
      SIZE: init.size,
      fieldN: Math.min(256, Math.round((LAWS.fieldN * init.size) / LAWS.SIZE)),
      c_up: LAWS.c_up * met,
      c_mv: LAWS.c_mv * met,
      c_sig: LAWS.c_sig * met,
      // a searched world carries its own physics, and an experiment's override still wins over it
      ...init.laws,
      ...opts.laws,
    }
    this.blind = opts.blind && opts.blind.length > 0 ? [...opts.blind] : null
    this.rng = new Rng((init.seed ^ 0x9e3779b9) | 0)
    // learner constructed below, once the brain slot range is known
    this.mergeStart = init.merge_hold ? null : 0
    const L = this.L

    this.A = new Float64Array(buffer(8 * N_MATRIX * N_MATRIX, opts.shared ?? false))
    // widened first: a 5x5 matrix is a world from before Brain had chemistry, and means zeros there
    const Araw = widenMatrix(init.quantized ? applyQuantization(init.A.map((r) => r.slice())) : init.A)
    const food = FOOD_ROW
    for (let i = 0; i < N_MATRIX; i++) {
      for (let j = 0; j < N_MATRIX; j++) {
        // food couples more weakly than matter does, which biases chemistry toward structure
        const w = i === food || j === food ? this.L.food_coupling : 1
        this.A[i * N_MATRIX + j] = w * Araw[i][j]
      }
    }

    // room for terrain: whatever the world starts with, plus space to paint more
    this.nWall = Math.min(L.wall_cap, Math.max(init.wallPositions.length, 0) + (opts.wallRoom ?? L.wall_cap))
    this.continuous = init.inflow
    const brainCap = this.continuous ? init.n_brain * 3 : init.n_brain
    this.nIntr = init.n_intrinsic + (this.continuous ? 4 * brainCap : 0)
    this.nMatter = this.nIntr + brainCap
    this.cap = this.nMatter + this.nWall + (opts.maxFood ?? init.max_food)
    const n = this.cap
    const sh = opts.shared ?? false
    this.x = new Float64Array(buffer(8 * n, sh))
    this.y = new Float64Array(buffer(8 * n, sh))
    this.fx = new Float64Array(buffer(8 * n, sh))
    this.fy = new Float64Array(buffer(8 * n, sh))
    this.energy = new Float64Array(n)
    this.type = new Uint8Array(buffer(n, sh)).fill(FOOD)
    this.alive = new Uint8Array(buffer(n, sh))
    this.owner = new Int32Array(buffer(4 * n, sh)).fill(-1)
    this.socket = new Int8Array(n).fill(-1)
    this.theta = new Float64Array(n)
    this.sig = new Float64Array(n)
    this.msg = new Float64Array(n)
    this.foodNear = new Float32Array(buffer(4 * n, sh))
    this.ffx = new Float64Array(buffer(8 * n, sh))
    this.ffy = new Float64Array(buffer(8 * n, sh))
    this.cool = new Int16Array(n)
    this.bornAt = new Int32Array(n)
    this.gen = new Int32Array(n)
    this.parent = new Int32Array(n).fill(-1)
    this.coparent = new Int32Array(n).fill(-1)
    this.isSpore = new Uint8Array(n)
    this.repCool = new Int16Array(n)
    this.brainSig = new Float64Array(n * 4)
    /*
     * The element table, flattened to typed arrays indexed by particle type.
     *
     * Flat rather than an array of objects because `radius` is read in the innermost pair loop of
     * the force kernel — the hottest code in the program — and a seven-entry Float64Array stays in
     * cache where an array of objects would chase pointers.
     */
    const els = elementsOf(init.elements, this.L)
    this.elements = els
    this.eRadius = Float64Array.from(els, (e) => e.radius)
    this.eMobility = Float64Array.from(els, (e) => e.mobility)
    this.eValence = Int32Array.from(els, (e) => Math.max(0, Math.round(e.valence)))
    this.eBondStrength = Float64Array.from(els, (e) => e.bondStrength)
    this.eBondCost = Float64Array.from(els, (e) => e.bondCost)
    this.eDecay = Float64Array.from(els, (e) => e.decay)
    // the bond table is sized by the most any type may hold; per-particle limits are enforced
    // against `eValence`, so a low-valence type simply never fills its allocation
    this.bonds = new Bonds(n, Math.max(1, ...Array.from(this.eValence)))
    this.flowOut = new Float64Array(n)
    this.flowIn = new Float64Array(n)
    this.flowE = new Float64Array(n)
    this.bondCool = new Int16Array(n)
    this.lineage = new Int32Array(n)
    this.children = new Int32Array(n)
    this.harvested = new Float64Array(n)
    this.spent = new Float64Array(n)
    this.moved = new Float64Array(n)
    this.meals = new Int32Array(n)
    this.orderTicks = new Float64Array(n)
    this.peakReserve = new Float64Array(n)
    this.seeking = new Float64Array(n)
    this.seekTicks = new Float64Array(n)
    this.eRepro = new Float64Array(n)
    this.repWait = new Float64Array(n)
    this.endowment = new Float64Array(n)
    this.coastT = new Float64Array(n)
    this.hasJoined = new Uint8Array(n)
    this.spawnX = new Float64Array(n)
    this.spawnY = new Float64Array(n)
    this.preJoinSpeed = new Float64Array(n)
    this.cognition = new Cognition(n, init.seed)
    /*
     * Each particle's own affinity row.
     *
     * Initialised from its type's row in the matrix, so at tick zero every particle of a type is
     * identical and the world is exactly the world it was. The matrix stops being the law and
     * becomes the **ancestral** chemistry: what a particle starts with, and what it drifts away
     * from as replication copies it with mutation.
     *
     * This is the particle's genome. The brain's genome is 418 numbers saying what to *do*; this is
     * six numbers saying what to *stick to* — and unlike the brain's, it belongs to a particle
     * rather than to an organism, which is what finally gives non-brain matter something to evolve.
     */
    this.rows = new Float64Array(buffer(8 * n * N_MATRIX, sh))
    this.tmplCool = new Int16Array(n)
    this.parentJoined = new Uint8Array(n)
    this.learnId = new Int32Array(n)
    this.island = new Int8Array(n)
    this.since = new Int32Array(n)
    this.wasLive = new Uint8Array(n)
    this.limbs = new Int32Array(n * 4).fill(-1)
    this.mvx = new Float64Array(n)
    this.mvy = new Float64Array(n)
    this.preX = new Float64Array(n)
    this.preY = new Float64Array(n)
    this.lvx = new Float64Array(n)
    this.lvy = new Float64Array(n)
    this.rewarded = new Float64Array(n)
    this.darwinian = (init.learn ?? LEARN_DEFAULTS).inherit === 'birth' && ONLINE_ALGOS.includes((init.learn ?? LEARN_DEFAULTS).algo)
    this.wBirthBrain = new Array(n)
    this.wBirthLimb = new Array(n)
    this.wLimb = new Array(n)
    this.wBrain = new Array(n)

    // Slots beyond the starting counts stay inactive; with continuous inflow they are
    // filled by spawns, and slots of dead matter return to the inactive pool.
    for (let i = 0; i < this.nMatter; i++) {
      this.x[i] = this.rng.next() * L.SIZE
      this.y[i] = this.rng.next() * L.SIZE
      this.type[i] = i < this.nIntr ? this.rng.int(4) : BRAIN
      const active = i < this.nIntr ? i < init.n_intrinsic : !this.continuous
      this.alive[i] = active ? 1 : 0
      this.energy[i] = active ? L.E_init : 0
      this.wasLive[i] = active ? 1 : 0
    }
    this.placeWalls()
    this.seedRows()
    for (let i = this.cap - 1; i >= this.nMatter + this.nWall; i--) this.freeFood.push(i)

    /*
     * The learner is built here, not earlier, because an online one has to be told the brain slot
     * range: its state is per living organism and has to be a flat array to fit in a snapshot.
     */
    this.learner = makeLearner(init.learn ?? LEARN_DEFAULTS, init.seed, this.nIntr, this.nMatter - this.nIntr)
    this.grid = new Grid(L.SIZE, L.r_c, n, this.nMatter, this, sh)
    const g = this.grid
    this.kernelArrays = {
      px: g.px, py: g.py, ptype: g.ptype, powner: g.powner, pcell: g.pcell, items: g.items,
      cellStart: g.start, fx: this.fx, fy: this.fy, foodNear: this.foodNear,
      ffx: this.ffx, ffy: this.ffy, A: this.A, rows: this.rows,
    }
    this.kernelParams = {
      SIZE: L.SIZE, r_c: L.r_c, K_core: L.K_core, r_0: L.beta * L.r_c,
      r_brain_core: L.r_brain_core, r_brain: L.r_brain, K_brain: L.K_brain,
      A_brain: L.A_brain, r_brain_push: L.r_brain_push,
      r_wall: L.r_wall, K_wall: L.K_wall,
      nc: g.nc, skipFood: !init.foodMoves,
      radius: this.eRadius,
      // only `templateParticles` ever writes a row, so without it rows stay equal to `A` forever
      uniformRows: !init.templating,
    }
    this.field = new Float64Array(L.fieldN * L.fieldN)
    this.fieldTmp = new Float64Array(L.fieldN * L.fieldN)
    const colonyModes = init.foodMode === 'converging' || init.foodMode === 'breathing'
    const colonies = colonyModes ? Math.max(2, Math.min(4, init.n_patch)) : init.n_patch
    /*
     * The source count is `n_patch`, full stop — the world no longer second-guesses it.
     *
     * `comet` and `spring` each described a *single* source, so they used to force the count to one
     * and ignore `n_patch` entirely. That is wrong now the count is its own dial: asking for eight
     * sources and getting one is the dial not working, and gating the override on "did you also set
     * a motion?" only moved the surprise somewhere less obvious. The legacy default now lives where
     * defaults belong — `specInit` and `initFromSeed` set `n_patch` to 1 for those two patterns, so
     * every catalogued world keeps the count it was scored with, while anything that states a count
     * is believed.
     */
    const nPatch = colonies
    for (let p = 0; p < nPatch; p++) {
      // colony modes start spread evenly round the world, so they really are apart; a world that
      // names its origins (a merge) overrides that, because its colonies have to begin where its
      // populations already are
      const given = init.patchOrigins?.[p]
      const even = colonyModes
      const a = (p / Math.max(1, nPatch)) * TAU
      const x = given ? this.wrap(given[0]) : even ? this.wrap(L.SIZE / 2 + L.SIZE * 0.33 * Math.cos(a)) : this.rng.next() * L.SIZE
      const y = given ? this.wrap(given[1]) : even ? this.wrap(L.SIZE / 2 + L.SIZE * 0.33 * Math.sin(a)) : this.rng.next() * L.SIZE
      this.patches.push({ x, y, h: this.rng.next() * TAU, ox: x, oy: y, dx: 0, dy: 0 })
    }
    this.spring = [this.rng.next() * L.SIZE, this.rng.next() * L.SIZE]

    this.lifeParticlesWindow = new RollingMean(L.life_window, L.life_buckets)
    this.lifeOrganismsWindow = new RollingMean(L.life_window, L.life_buckets)
    this.initialEnergy = this.totalEnergy()
    if (opts.autoSpawn !== false) {
      this.seedOrganisms(init.n_start)
      for (let i = 0; i < init.n_food0; i++) this.injectFood()
      this.applySeeded()
    }
  }

  // ---------------------------------------------------------------- accessors

  /** How many weights a brain holds, so a snapshot can size itself. */
  get brainWeightCount(): number {
    return N_OUT * N_IN
  }

  /** The food free-list, for snapshots. */
  freeFoodSlots(): number[] {
    return this.freeFood
  }

  setFreeFoodSlots(slots: ArrayLike<number>): void {
    this.freeFood.length = 0
    for (let i = 0; i < slots.length; i++) this.freeFood.push(slots[i])
  }

  get nFood(): number {
    return this.cap - this.nMatter - this.nWall - this.freeFood.length
  }

  /** First food slot; wall slots sit between the matter and the food. */
  get foodStart(): number {
    return this.nMatter + this.nWall
  }

  /** Terrain actually in the world, as opposed to the slots reserved for painting more. */
  get wallCount(): number {
    let n = 0
    for (let i = this.nMatter; i < this.foodStart; i++) if (this.alive[i]) n++
    return n
  }

  /**
   * Immovable terrain. Walls never move and have no chemistry — they exclude by their core
   * alone — so they are the one thing in the world that an organism can have a shape *against*.
   */
  /**
   * Terrain, from the position list. Slots beyond it stay inactive and are what painting fills,
   * so a layout is a starting point rather than a fixed world.
   */
  private placeWalls(): void {
    for (let k = 0; k < this.nWall; k++) {
      const i = this.nMatter + k
      this.type[i] = WALL
      this.alive[i] = 0
      this.energy[i] = 0
      this.owner[i] = -1
      this.socket[i] = -1
    }
    for (const [px, py] of this.init.wallPositions) this.addWall(px, py)
  }

  /** Activates a terrain slot at (px, py). Returns false when there is no room left. */
  addWall(px: number, py: number): boolean {
    for (let k = 0; k < this.nWall; k++) {
      const i = this.nMatter + k
      if (this.alive[i]) continue
      this.x[i] = this.wrap(px)
      this.y[i] = this.wrap(py)
      this.type[i] = WALL
      this.alive[i] = 1
      this.energy[i] = 0
      return true
    }
    return false
  }

  /** Terrain currently in the world, for saving a built world back into a config. */
  wallPositionsNow(): [number, number][] {
    const out: [number, number][] = []
    for (let k = 0; k < this.nWall; k++) {
      const i = this.nMatter + k
      if (this.alive[i] && this.type[i] === WALL) out.push([this.x[i], this.y[i]])
    }
    return out
  }

  /**
   * Removes whatever is within `radius` of a point: food and terrain vanish, and an organism is
   * dissolved into its parts rather than deleted, because matter is conserved.
   */
  eraseAt(px: number, py: number, radius: number): number {
    let n = 0
    const r2 = radius * radius
    const near = (i: number): boolean => {
      const dx = this.minImage(this.x[i] - px)
      const dy = this.minImage(this.y[i] - py)
      return dx * dx + dy * dy <= r2
    }
    for (let i = this.nMatter; i < this.nMatter + this.nWall; i++) {
      if (this.alive[i] && near(i)) {
        this.alive[i] = 0
        n++
      }
    }
    for (let f = this.foodStart; f < this.cap; f++) {
      if (!this.alive[f] || !near(f)) continue
      this.burned += this.energy[f]
      this.energy[f] = 0
      this.alive[f] = 0
      this.freeFood.push(f)
      n++
    }
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.alive[b] || !this.isBrain(b) || !near(b)) continue
      this.dissolve(b)
      n++
    }
    return n
  }

  totalEnergy(): number {
    let e = 0
    for (let i = 0; i < this.cap; i++) if (this.alive[i]) e += this.energy[i]
    return e
  }

  /** Start the colonies closing from here. Harmless, and idempotent, if they already are. */
  beginMerge(): void {
    if (this.mergeStart === null) this.mergeStart = this.tick
  }

  /** How far the colonies have closed: null when still held, else 0..1. */
  mergeProgress(): number | null {
    if (this.mergeStart === null) return null
    return Math.min(1, (this.tick - this.mergeStart) / Math.max(1, this.init.converge_ticks))
  }

  /**
   * Point the learner at a different measure while the world runs. Nothing is discarded: the
   * cohort and the pool hold raw scalars, so this re-scores what is already there.
   */
  retargetFitness(spec: FitnessSpec): void {
    this.init.learn = { ...this.init.learn, fitness: spec }
    this.learner.retarget(spec)
    this.fitnessChanges.push({ tick: this.tick, measure: describeSpec(spec) })
  }

  /**
   * Swap the algorithm itself. Unlike a change of measure this *does* start over — a pool of
   * genomes and a distribution's mean are not interchangeable — so it is recorded as a change too.
   */
  setLearner(algo: LearnConfig['algo']): void {
    this.init.learn = { ...this.init.learn, algo }
    this.learner = makeLearner(this.init.learn, this.init.seed ^ this.tick)
    this.fitnessChanges.push({ tick: this.tick, measure: `${algo} from scratch` })
  }

  /** Everything one finished life amounts to, as the learner and the collection both want it. */
  lifeStatsOf(b: number, age = this.tick - this.bornAt[b]): LifeStats {
    return {
      age,
      children: this.children[b],
      generation: this.gen[b],
      harvested: this.harvested[b],
      spent: this.spent[b],
      moved: this.moved[b],
      meals: this.meals[b],
      orderTicks: this.orderTicks[b],
      peakReserve: this.peakReserve[b],
      seeking: this.seekTicks[b] > 0 ? this.seeking[b] / this.seekTicks[b] : 0,
    }
  }

  isBrain(b: number): boolean {
    return this.owner[b] === b
  }

  /** Quadrant angle limits for socket q. */
  quadLo(q: number): number {
    return q * HALF_PI + this.L.gap / 2
  }
  quadHi(q: number): number {
    return (q + 1) * HALF_PI - this.L.gap / 2
  }

  private wrap(v: number): number {
    const S = this.L.SIZE
    let r = v % S
    if (r < 0) r += S
    return r >= S ? 0 : r
  }

  private minImage(d: number): number {
    const S = this.L.SIZE
    return d - S * Math.round(d / S)
  }

  /**
   * The signal field's gradient at a point, by central difference on the field grid.
   *
   * Wrapped in both axes, because the field lives on the same torus the world does and a brain
   * sitting on the seam would otherwise read a cliff where there is none.
   */
  fieldGradient(x: number, y: number): [number, number] {
    const N = this.L.fieldN
    const f = this.field
    const cx = Math.min(N - 1, Math.floor((x / this.L.SIZE) * N))
    const cy = Math.min(N - 1, Math.floor((y / this.L.SIZE) * N))
    const at = (ax: number, ay: number): number => f[((ay + N) % N) * N + ((ax + N) % N)]
    return [(at(cx + 1, cy) - at(cx - 1, cy)) / 2, (at(cx, cy + 1) - at(cx, cy - 1)) / 2]
  }

  private fieldIndex(x: number, y: number): number {
    const N = this.L.fieldN
    const cx = Math.min(N - 1, Math.floor((x / this.L.SIZE) * N))
    const cy = Math.min(N - 1, Math.floor((y / this.L.SIZE) * N))
    return cy * N + cx
  }

  // ---------------------------------------------------------------- tick

  /** Advances one tick. Only valid with a synchronous force backend. */
  step(): void {
    this.prepare()
    if (this.backend.compute(this)) throw new Error(`backend "${this.backend.name}" is async; use stepAsync()`)
    this.finish()
  }

  async stepAsync(): Promise<void> {
    this.prepare()
    await this.backend.compute(this)
    this.finish()
  }

  private prepare(): void {
    this.grid.build()
  }

  private finish(): void {
    if (this.init.bonds) this.applyBonds()
    this.integrate()
    this.grid.build()
    this.uptake()
    this.flowBonds()
    this.think()
    this.costs()
    this.decayFree()
    this.spoilFood()
    if (this.continuous) this.freeMatterDecay()
    this.deaths()
    // before anything can re-endow a slot this tick, so a death-and-rebirth is still two lives
    this.trackLiveness()
    // Germination is not gated on `repro`, and deliberately: the parent has already paid for the
    // spore, so refusing to let it wake would destroy energy that was spent on a reproduction.
    if (this.init.templating) this.templateParticles()
    if (this.init.spore) this.germinate()
    if (this.init.repro) this.reproduce()
    this.captures()
    if (this.init.bonds) {
      this.formBonds()
      this.pruneBonds()
    }
    this.stepField()
    this.stepPatches()
    this.aggregates.observe(this)
    this.orders.observe(this)
    this.creditOrders()
    this.tick++
    this.shine()
    this.activateBrains()
    this.learner.review(this.tick)
    if (this.tick % this.orders.sampleEvery === 0) this.ladderT.observe(this)
    for (let i = 0; i < this.nMatter; i++) {
      if (this.cool[i] > 0) this.cool[i]--
      if (this.repCool[i] > 0) this.repCool[i]--
      if (this.bondCool[i] > 0) this.bondCool[i]--
      if (this.tmplCool[i] > 0) this.tmplCool[i]--
    }
  }

  /**
   * Re-derives the laws and the chemistry from `init`, for a parameter changeover mid-run.
   *
   * Everything here is state the constructor computed *from* `init` and then never looked at
   * again, so a world whose `init` has been edited is running on stale derived values until this
   * is called. It exists for resume points: restore a mature population under the parameters it
   * matured under, then change one thing and watch.
   *
   * Deliberately narrow. It re-derives only what `TWEAKABLE` in resume.ts can reach — the law
   * table and the scaled affinity matrix. It does **not** touch anything that decides an array's
   * length or a table's width, because those cannot change under a restored state at all; that is
   * enforced on the other side, by what `TWEAKABLE` omits.
   *
   * Note what it does not do to particles: `rows` are left alone. Every particle carries its own
   * affinity row, which has already drifted from the matrix through replication, and overwriting
   * those from a tweaked matrix would discard the world's entire evolutionary history to change a
   * dial. A new matrix governs what gets seeded from here on, and — in a world without templating,
   * where the kernel reads the matrix directly — the forces too.
   */
  relaw(): void {
    const met = this.init.metabolism ?? 1
    Object.assign(this.L, {
      ...LAWS,
      SIZE: this.init.size,
      fieldN: this.L.fieldN, // derived from size, which cannot change under a restored state
      c_up: LAWS.c_up * met,
      c_mv: LAWS.c_mv * met,
      c_sig: LAWS.c_sig * met,
      ...this.init.laws,
    })
    const Araw = widenMatrix(this.init.quantized ? applyQuantization(this.init.A.map((r) => r.slice())) : this.init.A)
    for (let i = 0; i < N_MATRIX; i++) {
      for (let j = 0; j < N_MATRIX; j++) {
        const w = i === FOOD_ROW || j === FOOD_ROW ? this.L.food_coupling : 1
        this.A[i * N_MATRIX + j] = w * Araw[i][j]
      }
    }
  }

  /**
   * Credits time spent in a compound to each of its members. Order is a property of a group, so
   * to drive anything it has to become per-organism: every member earns `(n - 1) ^ order_alpha`
   * per tick, superlinear so that a long-held large compound counts for much more than a long
   * small one. Sampled on the tracker's cadence and scaled, rather than recomputed every tick.
   */
  /**
   * How fast a **solitary** organism gets anywhere in this world, as net displacement per tick.
   *
   * This is the null that "moves together" needs, and the one it did not have. It used to be
   * compared against thermal diffusion, `sqrt(2·μ·T·age/k)` — but a random brain is a *constant*
   * policy, so a random organism swims persistently in one direction and its net displacement
   * grows far faster than the square root of time. Measured: a solitary organism with random
   * weights and no senses reached 0.76–2.27× the "three times drift" bar on its own, with no
   * structure and nothing coordinated. The rung was testing whether anything was swimming.
   *
   * A within-world null fixes it in kind rather than by degree: the question becomes "does a
   * structure go further than its members would alone", which is what the rung's name claims. It
   * also cancels every dial — temperature, mobility, how hard a brain may push — because both
   * sides of the comparison are subject to all of them.
   *
   * Median rather than mean: one organism that happens to find a clear run across the world would
   * otherwise set the bar for everybody.
   */
  soloSpeed(): number {
    return this.soloBaseline().speed
  }

  /**
   * The solitary baseline, with the sample size it came from.
   *
   * The count matters as much as the value. A baseline drawn from one or two organisms is noise,
   * and a structure beating noise is not evidence of anything — which is how an unaided world came
   * to pass "moves together" once this measure stopped excluding anything that had ever joined.
   */
  /**
   * The solitary baseline, optionally **matched on body size**.
   *
   * Size matching is not a refinement, it is the difference between the rung measuring what it
   * claims and measuring something else. Organisms that end up in a compound are the ones that
   * successfully recruited, so they are mostly four-limb bodies; organisms still alone skew
   * smaller. Measured in an unaided world: 13 of 27 compound members had four limbs against a solo
   * distribution of 4/2/3/4 across one to four. Comparing a structure of full bodies against a
   * baseline of partial ones credits the structure for its members' size, and `Moves together`
   * read 2.77x on a world where nothing was coordinating anything.
   *
   * `limbs` asks for the baseline among organisms of that body size. Falls back to the pooled
   * median when that bucket is too small to mean anything, because a matched baseline drawn from
   * two organisms is worse than an unmatched one drawn from eleven.
   */
  soloBaseline(limbs?: number): { speed: number; n: number } {
    const compound = this.orders.compoundMembers(this)
    const speeds: number[] = []
    const matched: number[] = []
    for (let b = this.nIntr; b < this.nMatter; b++) {
      /*
       * **Not currently in a compound**, rather than never having been, and rather than holding any
       * bond at all. Both of the rejected versions were measured failures.
       *
       * `hasJoined` is sticky for life, so in a world that bonds well every organism is excluded
       * forever and `soloSpeed` returns zero — a structure of order 41 travelling at 0.77 scored
       * zero, because all sixty organisms had joined something at some point. The better the world
       * was at the thing the rung is about, the less measurable the rung became.
       *
       * "Holds any bond" replaced it and was fine only while bodies arrived pre-assembled. Once a
       * brain *builds* its body out of loose matter it lives where matter is, so it nearly always
       * holds some bond, and the baseline collapsed to brains sitting in empty space: slow, often
       * limbless, and not what "alone" means. Measured: `Moves together` read 3.81x against that
       * baseline in an unaided world, which is a null failing.
       *
       * So the baseline is the rung's own definition of alone — not joined to another organism —
       * taken from the same union over limb-to-limb bonds that decides a structure's order.
       */
      if (!this.isBrain(b) || !this.alive[b] || compound.has(b)) continue
      const age = this.tick - this.bornAt[b]
      if (age < 100) continue // too young for a displacement to mean anything
      const v = Math.hypot(this.minImage(this.x[b] - this.spawnX[b]), this.minImage(this.y[b] - this.spawnY[b])) / age
      speeds.push(v)
      if (limbs !== undefined && this.limbCount(b) === limbs) matched.push(v)
    }
    const pick = matched.length >= SOLO_MATCH_MIN ? matched : speeds
    if (pick.length === 0) return { speed: 0, n: 0 }
    pick.sort((a, b) => a - b)
    return { speed: pick[pick.length >> 1], n: pick.length }
  }

  private creditOrders(): void {
    if (this.tick % this.orders.sampleEvery !== 0) return
    const alpha = this.L.order_alpha
    for (const members of this.orders.groupsNow(this)) {
      if (members.length < 2) continue
      const credit = Math.pow(members.length - 1, alpha) * this.orders.sampleEvery
      for (const b of members) {
        this.orderTicks[b] += credit
        this.hasJoined[b] = 1 // sticky for this life: the ladder asks "did it ever", not "is it now"
      }
    }
  }

  /** Opens and closes particle lifetimes. A life runs from first having energy until running dry. */
  private trackLiveness(): void {
    for (let i = 0; i < this.nMatter; i++) {
      const live = this.alive[i] && this.energy[i] > 1e-12 ? 1 : 0
      if (live === this.wasLive[i]) continue
      if (live) this.since[i] = this.tick
      else {
        const span = this.tick - this.since[i]
        this.lifeParticles.record(span)
        this.lifeParticlesWindow.record(this.tick, span)
      }
      this.wasLive[i] = live
    }
  }

  /** Starts a fresh life for a slot that is being endowed, closing any previous one. */
  private beginLife(i: number): void {
    if (this.wasLive[i] && this.energy[i] > 1e-12) {
      const span = this.tick - this.since[i]
      this.lifeParticles.record(span)
      this.lifeParticlesWindow.record(this.tick, span)
    }
    this.since[i] = this.tick
    this.wasLive[i] = 1
  }

  /**
   * Guardrail: no particle may move further than `d_max` **in one tick**, whatever the forces say,
   * which is why the budget is divided by the sub-step count.
   *
   * It looks as though it should be a per-sub-step bound, and it is tempting because the clamp
   * then fires *less* often as sub-steps rise rather than more. That was tried and it is wrong:
   * `integrateOnce` reuses the forces computed once at the start of the tick, so a particle
   * allowed `d_max` per sub-step can travel `n × d_max` through a world whose forces it stopped
   * consulting — straight through anything in the way. Two tests caught it immediately.
   *
   * The odd-looking consequence is therefore real and not a defect: a sub-step's force term
   * shrinks as `1/n` while its Brownian term shrinks only as `1/sqrt(n)`, so at high sub-step
   * counts thermal motion is what approaches the budget, and clamping it is the guardrail doing
   * its job. One thing to remember when reading the number: the clamp percentage is **not
   * comparable across different sub-step counts.**
   */
  private clampStep(dx: number, dy: number): [number, number] {
    const lim = this.L.d_max / Math.max(1, Math.round(this.init.substeps))
    const d = Math.hypot(dx, dy)
    this.nSteps++
    if (d <= lim) return [dx, dy]
    this.nClamped++
    const k = lim / d
    return [dx * k, dy * k]
  }

  /** A Brownian draw, clamped to z_max sigma so a rare tail cannot teleport a particle. */
  private kick(): number {
    const z = this.rng.gauss()
    return Math.min(this.L.z_max, Math.max(-this.L.z_max, z))
  }

  /**
   * Bond springs, and the breaking test. Tension above F_break snaps the bond: that is the
   * hysteresis, since forming only needed the pair to touch with F_form of pull behind it.
   */
  /**
   * Replaces the world's ancestral chemistry and reseeds every particle from it.
   *
   * The counterpart to per-particle rows: writing `A` directly is now a no-op, because the live
   * chemistry is in the rows and `A` only seeds them. This discards whatever the particles had
   * evolved, which is the honest meaning of changing a world's chemistry mid-run.
   */
  setChemistry(A: number[][]): void {
    const wide = widenMatrix(A)
    const food = FOOD_ROW
    for (let i = 0; i < N_MATRIX; i++) {
      for (let j = 0; j < N_MATRIX; j++) {
        const w = i === food || j === food ? this.L.food_coupling : 1
        this.A[i * N_MATRIX + j] = w * wide[i][j]
      }
    }
    this.seedRows()
  }

  /**
   * Particles copying themselves: the substrate's own evolution.
   *
   * The three Darwinian requirements, in the one property a particle actually has:
   *
   * - **variation** — the copy's row is mutated by `row_mut` and re-quantized
   * - **heredity** — the copy takes its parent's row, not its type's ancestral one
   * - **differential reproduction** — only a *bonded* particle with energy to spare can copy, so
   *   what gets copied is the chemistry that got itself attached somewhere energy flows
   *
   * That last condition is doing the work. Without it the attractor is obvious and useless:
   * maximally self-attracting particles forming dense immortal clots, crowding out everything
   * else. Requiring a bond *and* a reserve means a particle has to be useful to a body to
   * replicate, which selects chemistry for being recruitable rather than merely sticky.
   */
  private templateParticles(): void {
    const { L } = this
    if (!this.init.templating) return
    const sigma = this.init.row_mut
    /** The next empty matter slot, found by scanning from where the last pass left off. */
    const takeSlot = (): number => {
      for (let n = 0; n < this.nIntr; n++) {
        const j = this.matterCursor
        this.matterCursor = (this.matterCursor + 1) % this.nIntr
        if (!this.alive[j] && this.owner[j] === -1 && !this.isSpore[j]) return j
      }
      return -1
    }
    for (let i = 0; i < this.nIntr; i++) {
      if (!this.alive[i] || this.isSpore[i] || this.tmplCool[i] > 0) continue
      if (this.bonds.held(i) === 0) continue // unbonded: no structure, no replication
      if (this.energy[i] < L.E_template + L.E_viable) continue
      const j = takeSlot()
      if (j < 0) return // nothing has died yet, so there is nowhere for a copy to go
      // energy moves, never appears: the parent's loss is exactly the copy's endowment
      this.energy[i] -= L.E_template
      this.energy[j] = L.E_template
      this.alive[j] = 1
      this.beginLife(j)
      this.type[j] = this.type[i]
      this.owner[j] = -1
      this.socket[j] = -1
      this.cool[j] = 0
      this.bondCool[j] = 0
      this.isSpore[j] = 0
      this.tmplCool[i] = L.template_cooldown
      this.tmplCool[j] = L.template_cooldown
      // placed a core's width away, so the copy starts clear of its parent rather than inside it
      const a = this.rng.next() * TAU
      const d = this.eRadius[this.type[i]] * 2 + 1
      this.x[j] = this.wrap(this.x[i] + d * Math.cos(a))
      this.y[j] = this.wrap(this.y[i] + d * Math.sin(a))
      // the genome: the parent's row, mutated, and re-quantized so the space stays countable
      const src = i * N_MATRIX
      const dst = j * N_MATRIX
      for (let k = 0; k < N_MATRIX; k++) {
        if (sigma <= 0) {
          this.rows[dst + k] = this.rows[src + k]
          continue
        }
        const mutated = this.rows[src + k] + sigma * this.rng.gauss()
        /*
         * The **food column keeps its own rules**: continuous, and capped at `food_coupling`.
         *
         * Mutating all six entries alike broke two of them. R1.4a keeps the food row continuous —
         * `applyQuantization` deliberately touches only the 4×4 matter block — and `food_coupling`
         * caps every food entry at 0.5, because `A` is pre-scaled by it in the constructor.
         * Snapping a food entry onto the matter lattice did both wrongs at once: it quantized a row
         * meant to be continuous, and the lattice reaches ±1, so replication walked food affinity
         * clean through its ceiling. Measured over 8,000 ticks: the largest food entry went from
         * 0.500 — exactly the legal maximum — to **1.000**, and the realised pair coupling to food
         * reached about 0.735 against a legal 0.5.
         *
         * The Brain column is left quantized and clamped to ±1, which is correct: nothing
         * pre-scales it, so ±1 *is* its legal range, and starting from zero it simply explores it.
         */
        this.rows[dst + k] =
          k === FOOD_ROW
            ? Math.max(-this.L.food_coupling, Math.min(this.L.food_coupling, mutated))
            : quantize(clamp11(mutated))
      }
      this.nTemplated++
    }
  }

  /** Gives every particle its type's ancestral row. Called once at init. */
  private seedRows(): void {
    for (let i = 0; i < this.cap; i++) this.resetRow(i)
  }

  /**
   * Changes a particle's kind, and its row with it.
   *
   * **The only safe way to retype a particle.** Writing `type[i]` directly now leaves a stale
   * affinity row behind — the particle looks like a P1 and is still attracted to whatever its
   * previous kind was. That is a silent wrong answer rather than a crash, which is the worst kind,
   * so the write goes through here.
   */
  setType(i: number, t: number): void {
    this.type[i] = t
    this.resetRow(i)
  }

  /**
   * Resets one particle's row to its type's ancestral chemistry.
   *
   * Needed wherever a particle's *type* changes — under continuous inflow a child's limb is
   * retyped to match its parent's — because a row is an opinion about other kinds held *by* a
   * kind, and carrying one across a change of type would be carrying somebody else's genome.
   */
  private resetRow(i: number): void {
    const m = MATRIX_INDEX[this.type[i]]
    const o = i * N_MATRIX
    for (let k = 0; k < N_MATRIX; k++) this.rows[o + k] = m >= 0 ? this.A[m * N_MATRIX + k] : 0
  }

  /**
   * The coupling between two particles: the mean of what each thinks of the other's kind.
   *
   * The single place this is computed outside the force kernel, so the bond test and the force can
   * never disagree about whether a pair likes each other.
   */
  coupling(i: number, j: number): number {
    const mi = MATRIX_INDEX[this.type[i]]
    const mj = MATRIX_INDEX[this.type[j]]
    if (mi < 0 || mj < 0) return 0
    return 0.5 * (this.rows[i * N_MATRIX + mj] + this.rows[j * N_MATRIX + mi])
  }

  /**
   * A bond takes the **weaker** of its two partners' bond strengths.
   *
   * The minimum rather than a mean, so a fragile type cannot be made structural by what it happens
   * to attach to — which is what "fragile" has to mean for the property to be worth having.
   */
  private pairStrength(ti: number, tj: number): number {
    return Math.min(this.eBondStrength[ti], this.eBondStrength[tj])
  }

  /** Squared distance within which a pair of these types can form a bond at all. */
  private formRange2(ti: number, tj: number): number {
    const r = this.L.r_bond + (this.L.F_form * this.pairStrength(ti, tj)) / this.L.k_bond
    return r * r
  }

  /** Distance beyond which a bond's spring would need more than this pair's F_break to hold it. */
  private breakAt(ti: number, tj: number): number {
    return this.L.r_bond + (this.L.F_break * this.pairStrength(ti, tj)) / this.L.k_bond
  }

  /**
   * Breaks bonds that are over-stretched *now*. Run after integrating as well as before, because
   * a limb rides its brain: without this a bond could be stretched by a body's motion and stay
   * visible, over-long, until the next tick noticed.
   */
  private pruneBonds(): void {
    const { x, y, bonds, L, type } = this
    bonds.forEach((i, j) => {
      const dead = !this.alive[i] || !this.alive[j]
      // per pair, from the weaker partner: a bond between two fragile types snaps sooner
      if (!dead && Math.hypot(this.minImage(x[j] - x[i]), this.minImage(y[j] - y[i])) <= this.breakAt(type[i], type[j])) return
      bonds.remove(i, j)
      if (!dead) {
        this.bondCool[i] = L.bond_cooldown
        this.bondCool[j] = L.bond_cooldown
      }
    }, this.cap)
  }

  /**
   * Energy moves along bonds, down the gradient.
   *
   * This is the only new law in the round, and it is what turns a bonded group from something
   * sticky into something with a **shared metabolism**: a member sitting in food feeds its
   * neighbours, and a member that has run dry can be rescued by them. Nothing is created or
   * destroyed — every transfer is a pair of equal and opposite changes, so the ledger closes
   * untouched.
   *
   * Three decisions worth keeping:
   *
   * - It is **passive**, a diffusion down the difference, not a decision. No organism chooses to
   *   share and no brain output is involved, so nothing in the laws says that cooperating is
   *   good. What follows — families that survive famine, and neighbours that drain each other —
   *   follows from one symmetric rule.
   * - It is computed from a **snapshot** and applied afterwards, so the result does not depend on
   *   the order particles are visited in. That is what keeps a threaded force backend and a
   *   replayed snapshot bit-identical.
   * - A transfer is capped at what the donor actually holds above the receiver, and never pushes
   *   anyone past `E_cap`, so it cannot invent a reserve or drive one negative.
   */
  private flowBonds(): void {
    const k = Math.min(0.5, Math.max(0, this.init.bond_flow ?? 0))
    if (k <= 0 || !this.init.bonds) return
    const { bonds, energy, alive, L } = this
    const max = bonds.max
    const out = this.flowOut
    const inn = this.flowIn
    // every quantity below is read from this copy, never from the energies being written: without
    // it the third pass would see its own earlier transfers and the result would depend on the
    // order particles happen to be visited in
    const e = this.flowE
    /*
     * `nMatter`, not `nIntr`, and this bound is load-bearing in all four places below.
     *
     * A brain's index sits *above* `nIntr`, and brains can now be bond partners. With the snapshot
     * covering only the intrinsic range, `e[brain]` read a stale zero outside the filled region:
     * the transfer was computed against a value that was never there, and the receiving end was
     * credited energy no end had been debited. The ledger test caught it as a reserve exceeding
     * `E_cap` by 0.65 — energy created out of an array bound.
     */
    e.set(energy.subarray(0, this.nMatter))
    out.fill(0)
    inn.fill(0)

    // Flow is between particles that belong to *bodies*, not to anything a bond happens to touch.
    // Measured: with loose matter included the rule was a straight energy sink — a drifting
    // particle has no use for a reserve and decays, so every unit shared outward was burned, and
    // organisms died sooner than with no sharing at all. A body sharing with a body is the rule
    // that was wanted; a body feeding dust is a leak.
    const shares = (p: number): boolean => alive[p] === 1 && this.owner[p] >= 0

    // Pass one: what every bond would move, from the snapshot. A brain reaches its own limbs
    // through its food share and a limb passes inward, so this is the step that joins two bodies
    // into one metabolism.
    for (let i = 0; i < this.nMatter; i++) {
      if (!shares(i)) continue
      for (let s = 0; s < max; s++) {
        const j = bonds.partner[i * max + s]
        if (j <= i || !shares(j)) continue // each bond once, both ends in a body
        const t = k * (e[i] - e[j])
        if (t > 0) {
          out[i] += t
          inn[j] += t
        } else if (t < 0) {
          out[j] -= t
          inn[i] -= t
        }
      }
    }

    // Pass two: per-particle scale factors, so nobody gives more than it holds or takes more than
    // it can hold. Both are derived from the snapshot, which is what makes the result independent
    // of visiting order — and therefore identical under a threaded backend or after a rewind.
    for (let i = 0; i < this.nMatter; i++) {
      if (!shares(i)) continue
      out[i] = out[i] > 0 ? Math.min(1, e[i] / out[i]) : 1
      const room = Math.max(0, L.E_cap - e[i])
      inn[i] = inn[i] > 0 ? Math.min(1, room / inn[i]) : 1
    }

    // Pass three: apply, scaled at both ends. Every transfer is one subtraction and one addition
    // of the same number, so the energy ledger closes exactly.
    for (let i = 0; i < this.nMatter; i++) {
      if (!shares(i)) continue
      for (let s = 0; s < max; s++) {
        const j = bonds.partner[i * max + s]
        if (j <= i || !shares(j)) continue
        const t = k * (e[i] - e[j])
        if (t === 0) continue
        const from = t > 0 ? i : j
        const to = t > 0 ? j : i
        const moved = Math.abs(t) * out[from] * inn[to]
        if (moved <= 0) continue
        energy[from] -= moved
        energy[to] += moved
      }
    }
  }

  private applyBonds(): void {
    const { L, x, y, fx, fy, bonds } = this
    bonds.forEach((i, j) => {
      if (!this.alive[i] || !this.alive[j]) {
        bonds.remove(i, j)
        return
      }
      const dx = this.minImage(x[j] - x[i])
      const dy = this.minImage(y[j] - y[i])
      const r = Math.hypot(dx, dy)
      if (r < 1e-9) return
      const f = bondForce(r, L)
      if (r > this.breakAt(this.type[i], this.type[j])) {
        bonds.remove(i, j)
        this.bondCool[i] = L.bond_cooldown
        this.bondCool[j] = L.bond_cooldown
        return
      }
      const ux = dx / r
      const uy = dy / r
      fx[i] += f * ux
      fy[i] += f * uy
      fx[j] -= f * ux
      fy[j] -= f * uy
    }, this.cap)
  }

  /**
   * Forms new bonds between touching particles whose chemistry likes the pairing.
   *
   * The loop runs to `nMatter`, not `nIntr`, which is what lets a **brain** bond now that it has a
   * matrix row. That was the second half of the exemption: giving brains chemistry achieves nothing
   * while the bond loop's index range excludes them.
   *
   * One consequence worth being plain about: **brain-to-brain bonds still cannot form.**
   * `separateBrains` holds brains at least `r_brain` (16) apart as a law, and a bond needs the pair
   * within about 12. So this delivers brain-to-matter bonding — a brain holding loose matter
   * directly, by chemistry — and multi-brain bodies remain out of reach until that exclusion
   * becomes a dial, which needs the stability budget re-derived.
   */
  private formBonds(): void {
    const { L, x, y, grid, bonds, type } = this
    for (let i = 0; i < this.nMatter; i++) {
      if (!this.alive[i] || this.bondCool[i] > 0) continue
      if (this.isSpore[i]) continue // carrying a genome; not available for structural chemistry
      const ti = type[i]
      if (bonds.slots(i, this.eValence[ti]) === 0) continue
      const mi = MATRIX_INDEX[ti]
      if (mi < 0) continue
      const n = grid.near(x[i], y[i])
      for (let k = 0; k < n; k++) {
        const j = grid.buf[k]
        if (j <= i || j >= this.nMatter || !this.alive[j] || this.bondCool[j] > 0 || this.isSpore[j]) continue
        const tj = type[j]
        // Brains do not bond to each other, as a rule rather than as an accident of two radii.
        // It held only because `separateBrains` keeps brains 16 apart and a bond needs about 12 —
        // so it would have quietly stopped holding the moment that exclusion became a dial.
        /*
         * **Distance first.** Every test here is a conjunction, so the order is free to choose —
         * and this loop was asking the expensive, least selective questions before the cheap,
         * most selective one.
         *
         * A 3×3 cell block is about 128 units across and a bond forms within roughly 12, so the
         * distance test rejects about 97% of candidates on its own. It was running *after*
         * `bonds.has`, `bonds.slots` and `coupling` — two table walks and four array reads — for
         * every one of them. Measured: 93.7 → 38.6 µs/tick at the phase-0 shape (−59%) and
         * 845.6 → 402.3 µs at the phase-2 shape (−52%), bit-exact, goldens unchanged.
         *
         * `formRange2` needs both types, which is why the type reads stay above it.
         */
        const dx = this.minImage(x[j] - x[i])
        const dy = this.minImage(y[j] - y[i])
        const r2 = dx * dx + dy * dy
        if (r2 > this.formRange2(ti, tj)) continue // slack enough that F_form can hold it
        if (ti === BRAIN && tj === BRAIN) continue
        if (this.owner[i] >= 0 && this.owner[i] === this.owner[j]) continue // siblings are already joined by rods
        if (bonds.has(i, j) || bonds.slots(j, this.eValence[tj]) === 0) continue
        const mj = MATRIX_INDEX[tj]
        // the pair's own coupling, not their types' — two P1 particles may now disagree about
        // whether they like each other, and the bond test has to ask the same question the force does
        if (mj < 0 || this.coupling(i, j) < L.A_form) continue
        const ci = this.eBondCost[ti]
        const cj = this.eBondCost[tj]
        if (this.energy[i] < ci || this.energy[j] < cj) continue
        if (!bonds.add(i, j)) break
        this.pay(i, ci)
        this.pay(j, cj)
        if (bonds.slots(i, this.eValence[ti]) === 0) break
      }
    }
  }

  private integrate(): void {
    // Sub-stepping splits one tick into n smaller moves that reuse the same forces. Brownian
    // increments are independent, so each is sqrt(n) smaller and the total variance is unchanged;
    // the force part is simply applied in n pieces. This is how a hot world stays stable.
    const n = Math.max(1, Math.round(this.init.substeps))
    for (let b = this.nIntr; b < this.nMatter; b++) {
      this.preX[b] = this.x[b]
      this.preY[b] = this.y[b]
    }
    for (let k = 0; k < n; k++) this.integrateOnce(this.L.mu / n, Math.sqrt((2 * this.L.mu * this.init.T) / n))
    this.separateBrains()
    // net displacement over the whole tick, measured last so it includes the separation pass:
    // what the body actually did, which is the version worth telling the brain about
    for (let b = this.nIntr; b < this.nMatter; b++) {
      this.lvx[b] = this.minImage(this.x[b] - this.preX[b])
      this.lvy[b] = this.minImage(this.y[b] - this.preY[b])
    }
  }

  private integrateOnce(mu: number, sn: number): void {
    const { L, x, y, fx, fy, owner, alive, theta } = this

    const foodMoves = this.init.foodMoves
    /*
     * Mobility is per type (R2.2b), which is mass.
     *
     * The drift scales with mobility and the thermal part with its **square root**, because a
     * Brownian step goes as `sqrt(μT)`. Both kicks are still drawn whatever the mobility, so the
     * random stream is identical across mobility settings and two such worlds are comparable at a
     * seed.
     *
     * Food's entry is what `mu_food` used to be, and the measurement behind it stands: at mobility
     * 1 a crumb of food drifts exactly as fast as a limb swims, and **you cannot catch what
     * diffuses as fast as you move**. It is now one mechanism instead of a global law plus a
     * special case for food.
     */
    for (let i = 0; i < this.cap; i++) {
      if (!alive[i] || owner[i] !== -1) continue
      const t = this.type[i]
      if (t === WALL) continue // terrain does not move
      if (!foodMoves && t === FOOD) continue
      const mob = this.eMobility[t]
      const m = mu * mob
      const s = sn * Math.sqrt(mob)
      const [sx, sy] = this.clampStep(m * fx[i] + s * this.kick(), m * fy[i] + s * this.kick())
      x[i] = this.wrap(x[i] + sx)
      y[i] = this.wrap(y[i] + sy)
    }

    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b)) continue
      let bx = fx[b] + this.mvx[b]
      let by = fy[b] + this.mvy[b]
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l < 0) continue
        const ex = Math.cos(theta[l])
        const ey = Math.sin(theta[l])
        const radial = fx[l] * ex + fy[l] * ey
        const tangent = -fx[l] * ey + fy[l] * ex
        bx += radial * ex // a rigid rod passes its radial load to the brain
        by += radial * ey
        const dthLim = L.dth_max / Math.max(1, Math.round(this.init.substeps))
        let dth = (mu * tangent + sn * this.kick()) / L.L_rod
        dth = Math.min(dthLim, Math.max(-dthLim, dth))
        theta[l] = Math.min(this.quadHi(s), Math.max(this.quadLo(s), theta[l] + dth))
      }
      const [bsx, bsy] = this.clampStep(mu * bx + sn * this.kick(), mu * by + sn * this.kick())
      x[b] = this.wrap(x[b] + bsx)
      y[b] = this.wrap(y[b] + bsy)
      this.moved[b] += Math.hypot(bsx, bsy)
      if (this.energy[b] > this.peakReserve[b]) this.peakReserve[b] = this.energy[b]
      this.placeLimbs(b)
    }
  }

  /**
   * Enforces the minimum separation between organisms as a constraint rather than a force.
   * Repulsion alone cannot guarantee it: a limb pulling toward a neighbour drags its own brain
   * inward, and the step clamp then carries it there. So after integrating, any two brains
   * closer than r_brain are pushed apart along their separation. Organisms can still touch —
   * through their limbs, which is the point.
   */
  private separateBrains(): void {
    const { L, x, y, grid } = this
    const want = L.r_brain
    for (let pass = 0; pass < 2; pass++) {
      let moved = false
      for (let b = this.nIntr; b < this.nMatter; b++) {
        if (!this.alive[b] || !this.isBrain(b)) continue
        const n = grid.near(x[b], y[b])
        for (let k = 0; k < n; k++) {
          const o = grid.buf[k]
          if (o <= b || o < this.nIntr || !this.alive[o] || !this.isBrain(o)) continue
          const dx = this.minImage(x[o] - x[b])
          const dy = this.minImage(y[o] - y[b])
          const d = Math.hypot(dx, dy)
          if (d >= want) continue
          // degenerate overlap: pick an arbitrary axis so the pair still separates
          const ux = d > 1e-9 ? dx / d : 1
          const uy = d > 1e-9 ? dy / d : 0
          // bounded like every other motion, so separation converges over a few ticks
          const push = Math.min((want - d) / 2, L.d_max)
          x[b] = this.wrap(x[b] - ux * push)
          y[b] = this.wrap(y[b] - uy * push)
          x[o] = this.wrap(x[o] + ux * push)
          y[o] = this.wrap(y[o] + uy * push)
          moved = true
        }
      }
      if (!moved) break
      for (let b = this.nIntr; b < this.nMatter; b++) if (this.alive[b] && this.isBrain(b)) this.placeLimbs(b)
    }
  }

  private placeLimbs(b: number): void {
    for (let s = 0; s < 4; s++) {
      const l = this.limbs[b * 4 + s]
      if (l < 0) continue
      this.x[l] = this.wrap(this.x[b] + this.L.L_rod * Math.cos(this.theta[l]))
      this.y[l] = this.wrap(this.y[b] + this.L.L_rod * Math.sin(this.theta[l]))
    }
  }

  private canEat(j: number): boolean {
    const { L, type, owner, energy } = this
    if (type[j] === FOOD) return false
    const o = owner[j]
    if (o >= 0 && j !== o) {
      return energy[j] + L.k_keep * L.E_food <= L.E_cap + 1e-9 && energy[o] + (1 - L.k_keep) * L.E_food <= L.E_cap + 1e-9
    }
    return energy[j] + L.E_food <= L.E_cap + 1e-9
  }

  private uptake(): void {
    const { L, x, y, grid, owner, energy, alive } = this
    const { nc, start, matterEnd, items, px, py, cellOf } = grid
    const re2 = L.r_eat * L.r_eat
    const S = L.SIZE
    const half = S / 2
    for (let f = this.foodStart; f < this.cap; f++) {
      if (!alive[f]) continue
      const c = cellOf[f]
      const cx = c % nc
      const cy = (c - cx) / nc
      const fxp = x[f]
      const fyp = y[f]
      let best = -1
      let bestD = re2
      for (let dy = -1; dy <= 1; dy++) {
        const row = ((cy + dy + nc) % nc) * nc
        for (let dx = -1; dx <= 1; dx++) {
          const cc = row + ((cx + dx + nc) % nc)
          for (let k = start[cc], e = matterEnd[cc]; k < e; k++) {
            let ex = px[k] - fxp
            if (ex >= half) ex -= S
            else if (ex < -half) ex += S
            let ey = py[k] - fyp
            if (ey >= half) ey -= S
            else if (ey < -half) ey += S
            const d2 = ex * ex + ey * ey
            if (d2 < bestD) {
              const j = items[k]
              if (this.canEat(j)) {
                bestD = d2
                best = j
              }
            }
          }
        }
      }
      if (best < 0) continue
      const o = owner[best]
      if (o >= 0 && best !== o) {
        energy[best] += L.k_keep * L.E_food
        energy[o] += (1 - L.k_keep) * L.E_food
      } else {
        energy[best] += L.E_food
      }
      // credit the meal to whichever organism the eater belongs to
      const credit = o >= 0 ? o : best >= this.nIntr ? best : -1
      if (credit >= 0) {
        this.harvested[credit] += L.E_food
        this.meals[credit]++
      }
      this.alive[f] = 0
      energy[f] = 0
      this.freeFood.push(f)
    }
  }

  private think(): void {
    const { L, energy, field, xin, yout, theta } = this
    const maxBonds = Math.max(1, this.bonds.max)
    const online = this.learner.online
    for (let b = this.nIntr; b < this.nMatter; b++) {
      this.mvx[b] = 0
      this.mvy[b] = 0
      if (!this.isBrain(b)) continue
      const wl = this.wLimb[b]!
      const wb = this.wBrain[b]!
      xin.fill(0)
      // the body's net pull toward food: already computed by the force pass, and it carries a
      // direction, so chemotaxis is one weight away rather than an inference from scalars
      let gx = this.ffx[b]
      let gy = this.ffy[b]
      // How much food is *around*, as opposed to which way it pulls. The pull above is a vector
      // sum and cancels exactly in the middle of a symmetric cloud; a count cannot cancel, so
      // this is the input that tells a feast from a desert. Summed over the whole body, since a
      // limb reaching into a patch is the body's news as much as the brain's.
      let near = this.foodNear[b]
      // bond load over the whole body: whether this organism is attached to anything at all
      let held = 0
      let slots = 0
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l < 0) continue
        // limb neuron: what the brain told it, what the field says, which way it is being
        // pulled, which way food is, and how much it is carrying
        const sig = Math.tanh(
          wl[0] * this.brainSig[b * 4 + s] +
            wl[1] * Math.min(1, field[this.fieldIndex(this.x[l], this.y[l])]) +
            wl[2] * Math.tanh(this.fx[l]) +
            wl[3] * Math.tanh(this.fy[l]) +
            wl[4] * Math.tanh(this.ffx[l]) +
            wl[5] * Math.tanh(this.ffy[l]) +
            wl[6] * (energy[l] / L.E_ref) +
            wl[7],
        )
        this.sig[l] = sig // one signal, sent both ways
        this.msg[l] = sig
        gx += this.ffx[l]
        gy += this.ffy[l]
        near += this.foodNear[l]
        const mine = maxBonds - this.bonds.slots(l)
        held += mine
        slots += maxBonds
        const o = s * BRAIN_IN.SOCKET_W
        xin[o] = 1 // alive
        xin[o + 1 + this.type[l]] = 1
        xin[o + 5] = sig
        xin[o + 6] = mine / maxBonds
        // the limb's direction within its own quadrant, mapped to [-1, 1]. Which quadrant it is
        // in is already implicit in which weights read this input, so the pair is a full heading.
        const lo = this.quadLo(s)
        const hi = this.quadHi(s)
        xin[o + 7] = hi > lo ? (2 * (theta[l] - lo)) / (hi - lo) - 1 : 0
      }
      xin[BRAIN_IN.RESERVE] = energy[b] / L.E_ref
      xin[BRAIN_IN.FIELD] = Math.min(1, field[this.fieldIndex(this.x[b], this.y[b])])
      xin[BRAIN_IN.BIAS] = 1
      xin[BRAIN_IN.FOOD_X] = Math.tanh(gx)
      xin[BRAIN_IN.FOOD_Y] = Math.tanh(gy)
      xin[BRAIN_IN.FOOD_NEAR] = Math.tanh(near / FOOD_NEAR_SCALE)
      // last tick's actual displacement, in units of the step guardrail: the brain's only
      // feedback from the world about itself, and so its only memory of what it was doing
      xin[BRAIN_IN.VEL_X] = Math.tanh(this.lvx[b] / L.d_max)
      xin[BRAIN_IN.VEL_Y] = Math.tanh(this.lvy[b] / L.d_max)
      held += maxBonds - this.bonds.slots(b)
      slots += maxBonds
      xin[BRAIN_IN.BOND_LOAD] = held / slots
      if (this.blind) for (const i of this.blind) xin[i] = 0
      for (let k = 0; k < N_OUT; k++) {
        let sum = 0
        for (let m = 0; m < N_IN; m++) sum += wb[k * N_IN + m] * xin[m]
        yout[k] = sum
      }

      /*
       * An online learner gets its turn here, between the decision and its consequences.
       *
       * This is the only point in the tick where what the organism saw, what it decided, and what
       * it was just paid are all in hand at once — `uptake` has already run, so the reward is this
       * tick's food rather than last tick's. The learner may rewrite `wBrain` and may add
       * exploration noise to `yout`, which the lines below then act on.
       *
       * Reward is **harvest**, not net energy: net would reward sitting still, and spending less
       * is already the only strategy anything here has ever found.
       */
      if (online) {
        const got = this.harvested[b] - this.rewarded[b]
        this.rewarded[b] = this.harvested[b]
        // in units of **one meal**, not raw energy. A reward of 10 against a value function
        // starting at 0 is what made TD(λ) diverge on its first run; the natural unit is the meal,
        // and it keeps the learning rates meaning the same thing at any `E_food`.
        this.learner.act({ b, wBrain: wb, wLimb: wl, xin, yout, reward: got / L.E_food, tick: this.tick })
      }

      this.mvx[b] = L.F_max * Math.tanh(yout[BRAIN_OUT.FX])
      this.mvy[b] = L.F_max * Math.tanh(yout[BRAIN_OUT.FY])

      /*
       * The cognition instrument sees the **command**, not the motion.
       *
       * Taken here, after any online learner has had its say and before the world has had any:
       * `mvx/mvy` is what this brain asked for. The realised step is that plus every force acting
       * on the body, and a crowded food patch jostles whatever is in it — so realised motion
       * correlates with food for reasons that have nothing to do with the organism.
       */
      const [sgx, sgy] = this.fieldGradient(this.x[b], this.y[b])
      this.cognition.observe({
        b,
        mx: this.mvx[b],
        my: this.mvy[b],
        vx: this.lvx[b],
        vy: this.lvy[b],
        gx,
        gy,
        food: near,
        sx: sgx,
        sy: sgy,
        age: this.tick - this.bornAt[b],
        meals: this.meals[b],
      })

      // Did it move toward what it could tell about food? Scored here, where both the perception
      // and the choice made from it are in hand, and only on ticks where there was something to
      // perceive — so an organism that never moves never scores rather than scoring zero.
      const fd = Math.hypot(gx, gy)
      const mv = Math.hypot(this.mvx[b], this.mvy[b])
      if (fd > 1e-6 && mv > 1e-6) {
        this.seeking[b] += (this.mvx[b] * gx + this.mvy[b] * gy) / (fd * mv)
        this.seekTicks[b]++
      }

      // signals back out to each limb, read by its neuron on the next tick
      for (let s = 0; s < 4; s++) this.brainSig[b * 4 + s] = Math.tanh(yout[BRAIN_OUT.SIG + s])

      // softmax over all four outputs (R5.2): a share allocated to an empty socket simply
      // stays in the brain, so "hoard by addressing a missing limb" is a usable strategy
      let zmax = -Infinity
      for (let s = 0; s < 4; s++) zmax = Math.max(zmax, yout[BRAIN_OUT.FOOD + s])
      let z = 0
      for (let s = 0; s < 4; s++) z += Math.exp(yout[BRAIN_OUT.FOOD + s] - zmax)
      const release = L.releaseFrac * energy[b]
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l < 0) continue
        const share = (release * Math.exp(yout[BRAIN_OUT.FOOD + s] - zmax)) / z
        const amt = Math.min(share, L.E_ref - energy[l])
        if (amt > 0) {
          energy[l] += amt
          energy[b] -= amt
        }
      }
    }
  }

  private pay(i: number, amount: number): void {
    const d = Math.min(amount, this.energy[i])
    this.energy[i] -= d
    this.burned += d
    const o = this.owner[i]
    if (o >= 0) this.spent[o] += d
  }

  private costs(): void {
    const { L } = this
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b)) continue
      this.pay(b, L.c_up)
      this.pay(b, L.c_mv * L.mu * (this.mvx[b] ** 2 + this.mvy[b] ** 2))
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l < 0) continue
        this.pay(l, L.c_up)
        this.pay(l, L.c_sig * Math.abs(this.sig[l]))
        this.pay(b, L.c_sig * Math.abs(this.brainSig[b * 4 + s])) // talking to a limb costs too
      }
    }
  }

  /** Free particles lose a fraction of their reserve each tick; the loss is burned. */
  /** Uneaten food spoils, so the world cannot silently fill up with food that waits forever. */
  private spoilFood(): void {
    const life = this.init.food_life
    if (life <= 0) return
    for (let f = this.foodStart; f < this.cap; f++) {
      if (!this.alive[f] || this.tick - this.bornAt[f] < life) continue
      this.burned += this.energy[f]
      this.energy[f] = 0
      this.alive[f] = 0
      this.freeFood.push(f)
    }
  }

  private decayFree(): void {
    /*
     * Per-type decay, with the world's `decay_free` as the floor under all of them.
     *
     * An element's own `decay` adds to the world's rate rather than replacing it, so turning the
     * global dial still does what it always did and a type can additionally be made perishable.
     * A type that decays faster than it is replicated simply dies out, which is how abundance
     * becomes an outcome rather than a setting.
     */
    const base = this.init.decay_free
    let any = base > 0
    for (let t = 0; t < this.eDecay.length && !any; t++) if (this.eDecay[t] > 0) any = true
    if (!any) return
    for (let i = 0; i < this.nMatter; i++) {
      if (!this.alive[i] || this.owner[i] !== -1) continue
      const e = this.energy[i]
      if (e <= 0) continue
      const k = base + this.eDecay[this.type[i]]
      if (k <= 0) continue
      let d = e * k
      if (e - d < 0.01) d = e // snap the tail to zero so particles actually run dry
      this.energy[i] = e - d
      this.burned += d
    }
  }

  /**
   * A corpse is food. When an organism dissolves, `corpse_frac` of what its body still held is
   * left behind as food particles and the rest is burned. Energy is converted, never created,
   * so the ledger still closes - and the loop from death back to life is closed with it.
   */
  private dropCorpse(b: number): void {
    const { L } = this
    let pool = this.energy[b]
    for (let s = 0; s < 4; s++) {
      const l = this.limbs[b * 4 + s]
      if (l >= 0) pool += this.energy[l]
    }
    const give = pool * L.corpse_frac
    const n = Math.floor(give / L.E_food)
    if (n <= 0) return
    // take the cost out of the body before it scatters, brain first
    let owed = n * L.E_food
    const take = (i: number) => {
      const d = Math.min(owed, this.energy[i])
      this.energy[i] -= d
      owed -= d
    }
    take(b)
    for (let s = 0; s < 4 && owed > 1e-12; s++) {
      const l = this.limbs[b * 4 + s]
      if (l >= 0) take(l)
    }
    for (let k = 0; k < n; k++) {
      const f = this.freeFood.pop()
      if (f === undefined) {
        this.burned += L.E_food // nowhere to put it: it dissipates
        continue
      }
      const a = this.rng.next() * TAU
      const r = L.r_brain * Math.sqrt(this.rng.next())
      this.alive[f] = 1
      this.type[f] = FOOD
      this.bornAt[f] = this.tick
      this.owner[f] = -1
      this.socket[f] = -1
      this.x[f] = this.wrap(this.x[b] + r * Math.cos(a))
      this.y[f] = this.wrap(this.y[b] + r * Math.sin(a))
      this.energy[f] = L.E_food
    }
  }

  /** Deactivates a slot; any residual reserve is burned so the ledger stays exact. */
  private kill(i: number): void {
    this.bonds.clear(i)
    this.burned += this.energy[i]
    this.energy[i] = 0
    this.alive[i] = 0
    this.cool[i] = this.L.cooldown // a dead slot waits as long as an unbound limb does
    this.sig[i] = 0
  }

  /** Continuous-inflow worlds: free matter pays upkeep too and vanishes at zero energy. */
  private freeMatterDecay(): void {
    for (let i = 0; i < this.nMatter; i++) {
      if (!this.alive[i] || this.owner[i] !== -1) continue
      this.pay(i, this.L.c_up)
      if (this.energy[i] <= 1e-12) this.kill(i)
    }
  }

  /**
   * A particle returning to the loose pool, re-drawn as a random kind.
   *
   * This is the only "creation" in the world, and it creates *identity* rather than matter: the
   * slot pool is fixed for all time, so a particle is never made or destroyed, it is recycled. What
   * a recycled particle *is* gets drawn again, which is what keeps the mix of kinds from freezing
   * into whatever the first few hundred ticks happened to assemble.
   *
   * **Only among the four matter kinds**, and that is a correction rather than a simplification. A
   * brain is identified by its *index* — every loop that looks for one runs `nIntr..nMatter`, and
   * `isBrain` asks whether a particle owns itself — so an intrinsic slot re-drawn as a brain would
   * be a particle that looks like a brain, is attracted like a brain, and can never activate,
   * because nothing that activates brains would ever examine it.
   *
   * So the two pools cycle separately. Brain slots are a fixed population that moves between loose
   * and active: a dissolved brain returns to the pool with nothing, and has to eat its way back
   * over the activation barrier like any other. Matter slots cycle among the four kinds.
   */
  private redrawKind(i: number): void {
    if (i >= this.nIntr) return
    const p = this.L.redraw_kind
    if (p <= 0) return
    if (p < 1 && this.rng.next() >= p) return
    this.setType(i, this.rng.int(4))
  }

  private unbind(l: number): void {
    const b = this.owner[l]
    const s = this.socket[l]
    this.limbs[b * 4 + s] = -1
    this.owner[l] = -1
    this.socket[l] = -1
    // back in the pool, and what it *is* is drawn again
    this.redrawKind(l)
    this.cool[l] = this.L.cooldown
    this.sig[l] = 0 // otherwise the next socket to capture it deposits this, unpaid for
    this.msg[l] = 0
    this.brainSig[b * 4 + s] = 0
  }

  /**
   * Takes an organism apart: its limbs are released, half of what the body held is left behind as
   * food, and the brain becomes a free particle. The one path out of being alive, used both by
   * starvation and by erasing a body by hand.
   */
  dissolve(b: number): void {
    if (!this.alive[b] || !this.isBrain(b)) return
    this.dropCorpse(b)
    for (let s = 0; s < 4; s++) {
      const l = this.limbs[b * 4 + s]
      if (l >= 0) this.unbind(l)
    }
    this.owner[b] = -1
    /*
     * A cooldown, so a brain cannot dissolve and restart on the same tick. The activation rate
     * makes that nearly impossible anyway — a dissolved brain holds nothing, and the barrier at
     * that deficit is `exp(-25/T)`, about four in a million at T = 2 — but "nearly impossible"
     * is not a rule, and this is.
     */
    this.cool[b] = this.L.cooldown
    if (this.continuous) this.kill(b)
    this.nDeaths++
    const age = this.tick - this.bornAt[b]
    this.lifeOrganisms.record(age)
    this.lifeOrganismsWindow.record(this.tick, age)
    this.recordAge = Math.max(this.recordAge, age)
    this.ladderT.observeDeath(this, b, age)
    const wBrain = this.wBrain[b]
    const wLimb = this.wLimb[b]
    if (wBrain && wLimb) {
      this.learner.observe(
        { id: this.learnId[b], wBrain, wLimb, diedAt: this.tick, stats: this.lifeStatsOf(b, age) },
        this.tick,
      )
    }
    this.wLimb[b] = undefined
    this.wBrain[b] = undefined
    this.wBirthBrain[b] = undefined
    this.wBirthLimb[b] = undefined
    this.learnId[b] = 0
    this.learner.forget(b)
  }

  private deaths(): void {
    /*
     * Loose matter can now die, and that is what makes replication possible at all.
     *
     * Matter was previously immortal: `decayFree` ran a particle's reserve to zero and left it
     * sitting there, because nothing ever needed a free matter slot. Templating does — a copy has
     * to go *somewhere*, and total matter stays conserved precisely because the only slots
     * available are the ones decay has emptied. So abundance becomes the outcome of replication
     * against decay rather than a number set at init.
     *
     * Only with templating on, so a world that does not replicate keeps immortal matter and every
     * existing `massByType` invariant.
     */
    if (this.init.templating) {
      for (let i = 0; i < this.nIntr; i++) {
        if (!this.alive[i] || this.owner[i] !== -1 || this.isSpore[i]) continue
        if (this.energy[i] > 1e-12) continue
        // the residue is **burned**, not dropped. `totalEnergy` counts only live particles, so
        // clearing `alive` without booking what was left would quietly delete it — a per-death
        // crumb of about 1e-13 that still accumulated past the ledger's tolerance over a few
        // hundred deaths. Burning it is the same convention decay and corpses already use.
        this.burned += this.energy[i]
        this.energy[i] = 0
        this.alive[i] = 0
        this.bonds.clear(i)
      }
    }
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b)) continue
      if (this.energy[b] <= 1e-12) {
        this.dissolve(b)
        continue
      }
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l >= 0 && this.energy[l] <= 1e-12) {
          this.unbind(l)
          if (this.continuous) this.kill(l)
        }
      }
    }
  }

  private captures(): void {
    const { L, x, y, grid, type, owner, energy, cool } = this
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b)) continue
      let n = -1
      for (let s = 0; s < 4; s++) {
        if (this.limbs[b * 4 + s] >= 0) continue
        if (n < 0) n = grid.near(x[b], y[b])
        let best = -1
        let bestErr = L.r_bind
        let bestAngle = 0
        for (let k = 0; k < n; k++) {
          const j = grid.buf[k]
          if (j >= this.nIntr || type[j] === FOOD || owner[j] !== -1 || cool[j] > 0) continue
          if (this.isSpore[j]) continue // carrying a genome; not available as spare matter
          const dx = this.minImage(x[j] - x[b])
          const dy = this.minImage(y[j] - y[b])
          const err = Math.abs(Math.hypot(dx, dy) - L.L_rod)
          if (err >= bestErr) continue
          let phi = Math.atan2(dy, dx)
          if (phi < 0) phi += TAU
          // must lie inside the socket's quadrant proper, not in the gap between quadrants
          if (phi < this.quadLo(s) || phi > this.quadHi(s)) continue
          best = j
          bestErr = err
          bestAngle = phi
        }
        if (best < 0) continue
        /*
         * **The brain pays to recruit.** It used to be the other way round: a limb had to hold
         * `E_viable` itself, so an exhausted particle was unrecruitable however much a rich brain
         * wanted it — which is backwards, since the thing with a reserve and an interest in growing
         * is the brain. A body that cannot afford another limb simply does not get one, and
         * assembling a body becomes an *investment* out of throughput, which is exactly the
         * quantity T1's rung measures.
         */
        const fee = this.eBondCost[type[best]]
        if (energy[b] < fee) continue
        energy[b] -= fee
        this.burned += fee
        owner[best] = b
        this.socket[best] = s
        this.theta[best] = Math.min(this.quadHi(s), Math.max(this.quadLo(s), bestAngle))
        this.limbs[b * 4 + s] = best
        this.placeLimbs(b)
      }
    }
  }

  private stepField(): void {
    const { L, field, fieldTmp: tmp } = this
    const N = L.fieldN
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b)) continue
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l >= 0 && this.sig[l] > 0) field[this.fieldIndex(this.x[l], this.y[l])] += this.sig[l]
      }
    }
    for (let cy = 0; cy < N; cy++) {
      for (let cx = 0; cx < N; cx++) {
        const i = cy * N + cx
        const avg =
          (field[cy * N + ((cx + 1) % N)] +
            field[cy * N + ((cx + N - 1) % N)] +
            field[((cy + 1) % N) * N + cx] +
            field[((cy + N - 1) % N) * N + cx]) /
          4
        tmp[i] = (1 - L.lambda) * (field[i] + L.D_sig * (avg - field[i]))
      }
    }
    field.set(tmp)
  }

  /**
   * Moves the food sources.
   *
   * Two code paths, deliberately. A world that sets neither new axis takes the **legacy** branch,
   * which is the old code unchanged — every saved world, catalog row and golden keeps its exact
   * trajectory, and `foodAxes` in params.ts records what each legacy `foodMode` meant on the new
   * axes so the UI and the sampler can speak one language. A world that sets either axis takes the
   * factored branch below.
   *
   * The factored branch composes two independent things, which is the whole point of the split:
   *
   * - **motion** moves each source relative to where it started, accumulating into `dx, dy`
   * - **relation** places the *anchor* each of those offsets is measured from
   *
   * Keeping them separate is what makes relation idempotent. The obvious implementation — scale
   * each source's distance from the middle every tick — compounds, and a converging world collapses
   * to a point in a few dozen ticks instead of over `converge_ticks`.
   */
  /**
   * The temperature at a point.
   *
   * Scalar today — it returns the world's `T` wherever you ask — and that is the point of its
   * existing at all. Every rule that should care about local temperature asks *here*, so turning
   * `T` into a field `T(x, y)` is a change to this one function rather than a hunt through the
   * model for every place a global constant was read.
   *
   * What the field buys, once it exists: cold regions are where structures survive and hot regions
   * tear them apart, so **habitats** appear without a habitat feature and spatial structure gets a
   * cause that is not food. It adds a second navigable gradient with a clear payoff, which matters
   * because food is the only one now. And it makes `stability()` need the *maximum local* T rather
   * than a scalar — that function was fixed for exactly this class of blindness, so the lesson is
   * fresh and the trap is known.
   */
  temperatureAt(_px: number, _py: number): number {
    return this.init.T
  }

  private stepPatches(): void {
    const { init, L } = this
    if (init.sourceMotion === undefined && init.sourceRelation === undefined) return this.stepPatchesLegacy()

    if (this.tick % SRC_V_EVERY === 0) {
      const base = this.soloBaseline()
      // Below a handful of solitary organisms the measurement is noise, and a food source whose
      // speed is set by noise is not a difficulty setting. Hold the last good value instead; at
      // tick 0 that is zero, so sources sit still until there is a population to outrun.
      if (base.n >= SRC_MIN_SOLO) this.srcV = (init.sourceSpeed ?? 0.5) * base.speed
    }
    const v = this.srcV
    const motion = init.sourceMotion ?? 'wander'
    const half = L.SIZE / 2

    // --- motion: each source's offset from its own starting point ---
    if (motion !== 'static' && v > 0) {
      // `tide` is a *band*: every source shares one heading, so the whole field sweeps across
      // rather than each source wandering off on its own. Source zero's heading is the band's.
      const bandH = this.patches.length > 0 ? this.patches[0].h : 0
      // `shy` needs the population's centre of mass once, not once per source.
      let fx = 0
      let fy = 0
      if (motion === 'shy') {
        const c = this.crowdCentre()
        fx = c.x
        fy = c.y
        if (c.n === 0) fx = Number.NaN // nobody to flee: fall through to holding position
      }
      for (let i = 0; i < this.patches.length; i++) {
        const p = this.patches[i]
        switch (motion) {
          case 'comet':
            // straight line, constant heading. No wobble — this is the pure-pursuit control, and a
            // random walk superimposed on it would make it a slower `wander` instead.
            p.dx += v * Math.cos(p.h)
            p.dy += v * Math.sin(p.h)
            break
          case 'orbit': {
            // A circle about the middle, at this source's own starting radius, so a ring of sources
            // stays a ring. Periodic, therefore it *returns* — the one pattern where remembering
            // where food was pays off.
            const rx = this.minImage(p.ox - half)
            const ry = this.minImage(p.oy - half)
            const r = Math.hypot(rx, ry)
            if (r < 1e-6) break // a source at the exact centre has no orbit to run
            const a0 = Math.atan2(ry, rx)
            const a = a0 + (v * this.tick) / r // angular speed chosen so the tangential speed is v
            p.dx = half + r * Math.cos(a) - p.ox
            p.dy = half + r * Math.sin(a) - p.oy
            break
          }
          case 'wander':
            p.h += 0.1 * this.rng.gauss()
            p.dx += v * Math.cos(p.h)
            p.dy += v * Math.sin(p.h)
            break
          case 'tide':
            p.dx += v * Math.cos(bandH)
            p.dy += v * Math.sin(bandH)
            break
          case 'shy': {
            if (Number.isNaN(fx)) break
            // Directly away from the crowd. Adversarial: the better organisms are at finding food,
            // the harder it is to keep. Most likely of the five to go degenerate, which is why it
            // is a separate level rather than the default.
            const ax = this.minImage(p.x - fx)
            const ay = this.minImage(p.y - fy)
            const d = Math.hypot(ax, ay)
            if (d < 1e-6) break
            p.dx += (v * ax) / d
            p.dy += (v * ay) / d
            break
          }
        }
      }
    }

    // --- relation: where each source's offset is measured from ---
    const rel = init.sourceRelation ?? 'independent'
    let f = 0 // 0 = sources where they started, 1 = all at the middle
    if (rel === 'converging' || rel === 'diverging' || rel === 'cyclical') {
      // Held worlds wait for the word, exactly as `converging` always has: four populations that
      // have never met stay apart until something asks them to meet, not until a counter says so.
      const period = Math.max(1, init.converge_ticks)
      const since = this.mergeStart === null ? 0 : this.tick - this.mergeStart
      if (rel === 'converging') {
        const t = Math.min(1, since / period)
        f = t * t * (3 - 2 * t) // slow at both ends, so the meeting is gradual
      } else if (rel === 'cyclical') {
        f = (1 - Math.cos((TAU * since) / period)) / 2 // apart, merged, apart, for ever
      } else {
        // Diverging is converging run backwards: negative f pushes a source further out than it
        // began. Capped, because past about one extra radius every source is against the same
        // wrap-around and "spread out" stops meaning anything on a torus.
        const t = Math.min(1, since / period)
        f = -(t * t * (3 - 2 * t))
      }
    }
    for (const p of this.patches) {
      let ax = p.ox
      let ay = p.oy
      if (f !== 0) {
        ax = p.ox + this.minImage(half - p.ox) * f
        ay = p.oy + this.minImage(half - p.oy) * f
      }
      if (rel === 'formation' && this.patches.length > 0) {
        // One source leads and the rest hold their spacing, so the *pattern* travels. Distinct from
        // `tide`, where each source accumulates its own offset and rounding slowly shears the band.
        p.x = this.wrap(ax + this.patches[0].dx)
        p.y = this.wrap(ay + this.patches[0].dy)
      } else {
        p.x = this.wrap(ax + p.dx)
        p.y = this.wrap(ay + p.dy)
      }
    }
  }

  /**
   * Where the organisms are massed, as a wrapped centre of mass.
   *
   * Wrapped, which is why this is not a plain mean: averaging raw coordinates on a torus puts the
   * centre of two organisms either side of the seam in the middle of the empty half. Summing unit
   * vectors of the angular coordinate and taking the argument back is the circular mean, which does
   * not have that failure.
   */
  private crowdCentre(): { x: number; y: number; n: number } {
    const { L } = this
    let n = 0
    let cx = 0
    let sx = 0
    let cy = 0
    let sy = 0
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.alive[b] || !this.isBrain(b)) continue
      const ax = (TAU * this.x[b]) / L.SIZE
      const ay = (TAU * this.y[b]) / L.SIZE
      cx += Math.cos(ax)
      sx += Math.sin(ax)
      cy += Math.cos(ay)
      sy += Math.sin(ay)
      n++
    }
    if (n === 0) return { x: 0, y: 0, n: 0 }
    const wrapBack = (c: number, si: number): number => {
      const a = Math.atan2(si / n, c / n)
      return ((a < 0 ? a + TAU : a) * L.SIZE) / TAU
    }
    return { x: wrapBack(cx, sx), y: wrapBack(cy, sy), n }
  }

  /** The pre-factorisation source motion, byte for byte, for every world that predates the axes. */
  private stepPatchesLegacy(): void {
    const { init, L } = this
    if (init.foodMode === 'converging' || init.foodMode === 'breathing') {
      // How far along the walk to the middle each colony is. Converging goes one way and stays;
      // breathing goes in and back out again, for ever, so isolation and contact keep alternating.
      const period = Math.max(1, init.converge_ticks)
      // A held world waits for the word: the colonies sit where they started until something
      // asks them to close. For a merged world that is the whole point — four populations that
      // have never met should stay apart until *you* decide they meet, not until a tick counter
      // says so.
      if (this.mergeStart === null) {
        for (const p of this.patches) {
          p.x = this.wrap(p.ox)
          p.y = this.wrap(p.oy)
        }
        return
      }
      const since = this.tick - this.mergeStart
      let f: number
      if (init.foodMode === 'converging') {
        const t = Math.min(1, since / period)
        f = t * t * (3 - 2 * t) // slow at both ends, so the meeting is gradual
      } else {
        f = (1 - Math.cos((TAU * since) / period)) / 2 // 0 apart, 1 merged, 0 again
      }
      for (const p of this.patches) {
        p.x = this.wrap(p.ox + (L.SIZE / 2 - p.ox) * f)
        p.y = this.wrap(p.oy + (L.SIZE / 2 - p.oy) * f)
      }
      return
    }
    if (init.foodMode === 'comet') {
      // one fast source: food is a moving target, and standing still means starving
      const p = this.patches[0]
      if (!p) return
      p.h += 0.012 * this.rng.gauss()
      const v = Math.max(1.5, init.v_patch * 12)
      p.x = this.wrap(p.x + v * Math.cos(p.h))
      p.y = this.wrap(p.y + v * Math.sin(p.h))
      return
    }
    if (init.foodMode === 'spring' || init.foodMode === 'ring' || init.foodMode === 'gradient') return // fixed
    const v = init.v_patch
    for (const p of this.patches) {
      p.h += 0.1 * this.rng.gauss()
      p.x = this.wrap(p.x + v * Math.cos(p.h))
      p.y = this.wrap(p.y + v * Math.sin(p.h))
    }
  }

  /**
   * Whatever was placed by hand before the world started: food where it was dropped, and
   * organisms where they were put. A built world is just a config carrying these.
   */
  private applySeeded(): void {
    for (const [px, py] of this.init.seededFood) this.feedAt(px, py, 0)
    for (const seed of this.init.seededOrganisms) {
      const spec = seed.organism as
        | { reserve: number; limbs: { quad: number; type: number; angle: number; reserve: number }[]; wLimb: number[]; wBrain: number[] }
        | undefined
      if (spec && Array.isArray(spec.wBrain)) this.placeSaved(spec, [seed.x, seed.y], seed.island ?? 0)
      else this.spawnRandom([seed.x, seed.y])
    }
  }

  // ---------------------------------------------------------------- creation

  private samplePoint(): [number, number] {
    const { rng, init, L } = this
    const S = L.SIZE
    const inPatch = (p: { x: number; y: number }, radius: number): [number, number] => {
      const r = radius * Math.sqrt(rng.next())
      const a = rng.next() * TAU
      return [this.wrap(p.x + r * Math.cos(a)), this.wrap(p.y + r * Math.sin(a))]
    }
    if (
      (init.foodMode === 'patchy' || init.foodMode === 'converging' || init.foodMode === 'breathing' || init.foodMode === 'comet') &&
      this.patches.length > 0
    ) {
      const p = this.patches[rng.int(this.patches.length)]
      const radius = init.foodMode === 'comet' ? init.r_patch * 0.45 : init.r_patch
      return inPatch(p, radius)
    }
    /*
     * Three patterns were written against *fixed* geometry — `spring` reads a stored point,
     * `ring` and `gradient` are defined relative to the world's middle — which was fine while
     * motion was part of the pattern. It is not fine now that motion is its own axis: a source
     * could be orbiting while the food kept landing in the same place, so choosing a motion
     * appeared to do nothing at all. That is the bug this guard fixes.
     *
     * With an axis set, each of the three becomes source-relative and therefore moves with its
     * source. `random` is deliberately left alone: uniform food is uniform, and a source motion
     * genuinely cannot show through it — the UI says so rather than pretending otherwise.
     */
    const axed = init.sourceMotion !== undefined || init.sourceRelation !== undefined
    const anchor = axed && this.patches.length > 0 ? this.patches[rng.int(this.patches.length)] : null
    if (init.foodMode === 'spring') {
      // one small tight source: everything has to come to it, so position is everything
      return inPatch(anchor ?? { x: this.spring[0], y: this.spring[1] }, init.r_patch * 0.22)
    }
    if (init.foodMode === 'ring') {
      const a = rng.next() * TAU
      const rr = S * 0.33 + (rng.next() - 0.5) * init.r_patch * 0.6
      const cx = anchor ? anchor.x : S / 2
      const cy = anchor ? anchor.y : S / 2
      return [this.wrap(cx + rr * Math.cos(a)), this.wrap(cy + rr * Math.sin(a))]
    }
    if (init.foodMode === 'gradient') {
      /*
       * A sunlit stripe, centred on its source when there is one so the band itself travels.
       *
       * The legacy centre is **zero, not the middle**: `(1 + cos(2*pi*x/S)) / 2` peaks at x = 0,
       * which is the wrap seam. Taking it as the middle instead moved the band half a world for
       * every existing gradient world — caught by two pinned goldens, which is exactly what they
       * are for.
       */
      const centre = anchor ? anchor.x : 0
      for (;;) {
        const px = rng.next() * S
        const w = (1 + Math.cos((TAU * this.minImage(px - centre)) / S)) / 2
        if (rng.next() < w * w) return [px, rng.next() * S]
      }
    }
    return [rng.next() * S, rng.next() * S]
  }

  /** Squared distance to the nearest live brain, on the torus. */
  private brainGap2(px: number, py: number, ignore = -1): number {
    let best = Infinity
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (b === ignore || !this.alive[b] || !this.isBrain(b)) continue
      const dx = this.minImage(this.x[b] - px)
      const dy = this.minImage(this.y[b] - py)
      best = Math.min(best, dx * dx + dy * dy)
    }
    return best
  }

  /**
   * A spot at least `r_brain` from every existing organism. Bodies must never be placed
   * overlapping: the repulsion can only separate them a few units per tick, so an overlapping
   * spawn would stay tangled for a long time.
   */
  private freeSpot(tries = 24): [number, number] {

    const want = this.L.r_brain * this.L.r_brain
    let bx = 0
    let by = 0
    let bestGap = -1
    for (let t = 0; t < tries; t++) {
      const px = this.rng.next() * this.L.SIZE
      const py = this.rng.next() * this.L.SIZE
      const gap = this.brainGap2(px, py)
      if (gap >= want) return [px, py]
      if (gap > bestGap) {
        bestGap = gap
        bx = px
        by = py
      }
    }
    return [bx, by] // crowded world: take the roomiest spot we saw
  }

  /** Food particles the sun owes per tick right now: the base rate scaled by the regime. */
  foodRateNow(): number {
    const base = this.init.food_batch / Math.max(1, this.init.T_food)
    return base * regimeMultiplier(this.init, this.tick)
  }

  /**
   * The sun. An accumulator rather than "every N ticks", so any rate works — a tenth of a
   * particle a tick during a famine, nine a tick during a bloom — and the regime can change it
   * continuously without the arrival pattern stuttering.
   */
  private shine(): void {
    this.foodOwed = Math.min(this.foodOwed + this.foodRateNow(), 64)
    while (this.foodOwed >= 1) {
      this.foodOwed -= 1
      if (!this.injectFood()) {
        // The world has no room left. The sun does not slow down for that — the rate is fixed —
        // so the rest of this tick's light is wasted, and counted, because an unrecorded ceiling
        // is a thermostat pretending to be a shortage.
        this.lightWasted += 1 + this.foodOwed
        this.foodOwed = 0
        break
      }
    }
  }

  /** Drops one food particle near (px, py). Used by the pointer, so a world can be hand-fed. */
  feedAt(px: number, py: number, radius = 0): boolean {
    if (this.freeFood.length === 0) return false
    const a = this.rng.next() * TAU
    const r = radius * Math.sqrt(this.rng.next())
    const i = this.freeFood.pop()!
    this.alive[i] = 1
    this.type[i] = FOOD
    this.bornAt[i] = this.tick
    this.owner[i] = -1
    this.socket[i] = -1
    this.x[i] = this.wrap(px + r * Math.cos(a))
    this.y[i] = this.wrap(py + r * Math.sin(a))
    this.energy[i] = this.L.E_food
    this.injected += this.L.E_food
    return true
  }

  injectFood(): boolean {
    if (this.freeFood.length === 0) return false
    const [px, py] = this.samplePoint()
    const i = this.freeFood.pop()!
    this.alive[i] = 1
    this.type[i] = FOOD
    this.bornAt[i] = this.tick // so it can spoil
    this.x[i] = px
    this.y[i] = py
    this.energy[i] = this.L.E_food
    this.owner[i] = -1
    this.socket[i] = -1
    this.injected += this.L.E_food
    return true
  }

  /** Turns a free brain and free intrinsic particles into an organism. Brain weights are fresh random. */
  placeOrganism(spec: OrganismSpec): void {
    const b = spec.brain
    const { rng } = this
    // A body is placed outright, which teleports every particle in it. Any bond those particles
    // held would be stretched across the world, so they are cut: a bond is a contact, and these
    // particles are no longer in contact with what they were touching.
    this.bonds.clear(b)
    for (const { idx } of spec.limbs) this.bonds.clear(idx)
    this.owner[b] = b
    this.nBirths++
    this.bornAt[b] = this.tick
    this.x[b] = this.wrap(spec.x)
    this.y[b] = this.wrap(spec.y)
    this.mvx[b] = 0
    this.mvy[b] = 0
    /*
     * Weights: inherited if given, else hand-built if the world names a policy, else random.
     *
     * One place, so a hand-built world cannot leak a random brain through some other spawn path —
     * and so the policy the feasibility tests assert on is exactly the one the Discoveries page
     * runs.
     */
    const hand = this.init.handBuilt ? HAND_BUILT[this.init.handBuilt] : undefined
    this.wLimb[b] = spec.wLimb ?? (hand ? hand.limb() : randomLimb(() => rng.gauss()))
    this.wBrain[b] = spec.wBrain ?? (hand ? hand.brain() : randomBrain(() => rng.gauss()))
    this.learnId[b] = spec.learnId ?? 0
    this.island[b] = spec.island ?? (spec.parent !== undefined && spec.parent >= 0 ? this.island[spec.parent] : 0)
    this.gen[b] = spec.gen ?? 0
    this.parent[b] = spec.parent ?? -1
    this.children[b] = 0
    this.harvested[b] = 0
    this.rewarded[b] = 0
    /*
     * Darwinian inheritance needs the weights an organism was *born* with kept aside, because an
     * online learner rewrites the live ones — so without this copy the world would be Lamarckian
     * by accident rather than by choice, which is the wrong way to settle a question that has
     * been studied for a century. Only paid for when it is asked for.
     */
    if (this.darwinian) {
      this.wBirthBrain[b] = Float64Array.from(this.wBrain[b]!)
      this.wBirthLimb[b] = Float64Array.from(this.wLimb[b]!)
    }
    this.spent[b] = 0
    this.moved[b] = 0
    this.meals[b] = 0
    this.orderTicks[b] = 0
    this.peakReserve[b] = this.energy[b]
    this.seeking[b] = 0
    this.seekTicks[b] = 0
    // inherited with noise where there is a parent, straight from the laws where there is not
    const mut = this.init.repro_mut
    const jitter = (v: number): number => v * Math.exp(mut * rng.gauss())
    const from = spec.parent !== undefined && spec.parent >= 0 ? spec.parent : -1
    this.eRepro[b] = Math.min(
      this.L.E_cap,
      Math.max(2 * this.L.E_birth, from >= 0 && this.eRepro[from] > 0 ? jitter(this.eRepro[from]) : this.L.E_repro),
    )
    this.repWait[b] = Math.min(
      4000,
      Math.max(10, from >= 0 && this.repWait[from] > 0 ? jitter(this.repWait[from]) : this.L.repro_cooldown),
    )
    if (spec.parent !== undefined && spec.parent >= 0) {
      this.lineage[b] = this.lineage[spec.parent]
      this.children[spec.parent]++
    } else this.lineage[b] = this.lineageCounter++
    this.repCool[b] = this.repWait[b]
    for (const { idx, quad, angle } of spec.limbs) {
      this.owner[idx] = b
      this.socket[idx] = quad
      this.theta[idx] = angle
      this.limbs[b * 4 + quad] = idx
    }
    this.placeLimbs(b)
    // the yardsticks of this life: what it was given, and how long the gift alone sustains it
    let given = this.energy[b]
    let body = 1
    for (const { idx } of spec.limbs) {
      given += this.energy[idx]
      body++
    }
    this.endowment[b] = given
    /*
     * Coasting time against the **laws'** upkeep rate, not this world's.
     *
     * It used `this.L.c_up`, which the metabolism dial scales — and that inverted the rung it was
     * built to protect. Measured over forty confirmed worlds: at metabolism 2 organisms lived 479
     * ticks, the shortest absolute lifespan of any setting, and scored 2.35 coasting times, the
     * highest, because the yardstick halves while the lifespan falls by less. Nine of the top ten
     * worlds in the whole search ran at the most expensive metabolism, which is the search finding
     * the flaw rather than finding a world.
     *
     * A fixed yardstick is the honest version: coasting time is a property of the laws, so "lived
     * five coasts" means the same length of life in every world. The rung then pairs it with an
     * absolute floor, so neither a cheap metabolism nor an expensive one can buy it.
     */
    this.coastT[b] = given / Math.max(1e-9, body * LAWS.c_up)
    this.hasJoined[b] = 0
    this.spawnX[b] = this.x[b]
    this.spawnY[b] = this.y[b]
    this.cognition.reset(b) // a new life in this slot inherits none of the last one's record
    this.parentJoined[b] = spec.parent !== undefined && spec.parent >= 0 ? this.hasJoined[spec.parent] : 0
  }

  /**
   * Budding: a brain holding at least E_repro pays for a child's body (every particle
   * topped up to E_birth) and keeps at least E_hold. The child copies the parent's limb
   * types and angles, inherits its brain weights plus Gaussian noise, and appears
   * `repro_dist` away. Energy only moves from parent to child, so nothing is injected.
   */
  private reproduce(): void {
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b) || this.repCool[b] > 0) continue
      // each organism against its own threshold, not one the laws imposed on everybody
      if (this.energy[b] < this.eRepro[b]) continue
      if (this.init.fission && this.limbCount(b) >= 2 && this.energy[b] >= this.eRepro[b] * 1.5) {
        if (this.split(b)) continue
      }
      /*
       * Conjugation is tried before budding, and that ordering is a choice worth naming: a
       * partner is only sometimes available, so trying it first means an organism takes the
       * recombining option whenever it can and falls back to a clone when it cannot. The reverse
       * order would make conjugation almost never happen, since budding almost always succeeds.
       */
      if (this.init.conjugation) {
        const mate = this.bondedMate(b)
        if (mate >= 0) {
          this.bud(b, mate)
          continue
        }
      }
      /*
       * A spore instead of a child, whenever a child could not be made.
       *
       * I first gated this on "no room to place a body", reasoning that crowding was what
       * dispersal answers. Measured in a world that actually lives, that was the wrong scarcity:
       * over 6,000 ticks `room` blocked reproduction **0** times and a free brain slot blocked it
       * **41,244** times. The population cap is the binding constraint, as it has been every time
       * this has been measured.
       *
       * Which makes the spore more useful than I thought rather than less. It needs one free
       * particle now and a brain slot only when it germinates — so sowing *banks* a reproduction
       * that cannot happen yet, and carries it somewhere else in the meantime. So the trigger is
       * simply: budding failed, for whatever reason.
       */
      if (!this.bud(b) && this.init.spore) this.sow(b)
    }
  }

  /**
   * One child, from one parent or two.
   *
   * With `mate < 0` this is budding exactly as it was. With a mate it is **conjugation**: the two
   * parents split the cost, the body plan is drawn socket by socket from one or the other, and the
   * brain weights are a uniform crossover. One function rather than two, because every hard part
   * — finding free matter, affording it, finding room for the child, keeping the ledger closed —
   * is identical, and a parallel reproduction path is exactly where the fission energy bug came
   * from.
   */
  private bud(b: number, mate = -1): boolean {
    const { L, rng } = this
    const parents = mate >= 0 ? [b, mate] : [b]
    const want: { quad: number; type: number; angle: number }[] = []
    for (let s = 0; s < 4; s++) {
      /*
       * The body plan recombines by the same rule as the weights: each socket comes from one
       * parent or the other. Where only one parent has a limb in a socket it is inherited anyway
       * — a coin flip over an empty socket would make conjugation a way of *losing* limbs, and
       * selection would then favour never doing it.
       */
      const mine = this.limbs[b * 4 + s]
      const theirs = mate >= 0 ? this.limbs[mate * 4 + s] : -1
      const l = mine >= 0 && theirs >= 0 ? (rng.next() < 0.5 ? mine : theirs) : mine >= 0 ? mine : theirs
      if (l >= 0) want.push({ quad: s, type: this.type[l], angle: this.theta[l] })
    }
    if (want.length === 0) {
      this.repBlocked.limbless++
      return false
    }

    // find room: an open brain slot and one open particle per wanted limb
    let childBrain = -1
    for (let i = this.nIntr; i < this.nMatter && childBrain < 0; i++) {
      if (this.continuous ? !this.alive[i] : this.owner[i] === -1) childBrain = i
    }
    if (childBrain < 0) {
      this.repBlocked.slots++
      return false
    }
    const taken = new Set<number>()
    const limbs: OrganismSpec['limbs'] = []
    let cost = Math.max(0, L.E_birth - this.energy[childBrain])
    for (const w of want) {
      let pick = -1
      for (let i = 0; i < this.nIntr && pick < 0; i++) {
        if (taken.has(i)) continue
        // `!isSpore`: a spore is free matter with a genome on it, and letting a body eat one as a
        // limb would silently discard a reproduction its parent had already paid for
        const open =
          !this.isSpore[i] &&
          (this.continuous ? !this.alive[i] && this.cool[i] === 0 : this.owner[i] === -1 && this.type[i] === w.type && this.cool[i] === 0)
        if (open) pick = i
      }
      if (pick < 0) continue
      taken.add(pick)
      cost += Math.max(0, L.E_birth - this.energy[pick])
      limbs.push({ idx: pick, quad: w.quad, angle: w.angle })
      if (this.continuous) this.setType(pick, w.type) // a row cannot survive a change of kind
    }
    if (limbs.length === 0) {
      this.repBlocked.matter++
      return false
    }
    // each parent pays an equal share and each must still keep E_hold: a conjugation that would
    // starve one partner is not a cheaper child, it is a death
    const share = cost / parents.length
    if (parents.some((p) => this.energy[p] < share + L.E_hold)) {
      this.repBlocked.energy++
      return false
    }

    // place the child clear of every other body, preferring the parent's own neighbourhood
    let cx = 0
    let cy = 0
    let bestGap = -1
    // a conjugated child starts from the midpoint of its parents, the one place that belongs to
    // both; min-image so a pair straddling the world's seam does not aim across the whole world
    const ox = mate >= 0 ? this.wrap(this.x[b] + this.minImage(this.x[mate] - this.x[b]) / 2) : this.x[b]
    const oy = mate >= 0 ? this.wrap(this.y[b] + this.minImage(this.y[mate] - this.y[b]) / 2) : this.y[b]
    for (let t = 0; t < 16; t++) {
      const a = rng.next() * TAU
      const px = this.wrap(ox + L.repro_dist * Math.cos(a))
      const py = this.wrap(oy + L.repro_dist * Math.sin(a))
      const gap = this.brainGap2(px, py, b)
      if (gap >= L.r_brain * L.r_brain) {
        cx = px
        cy = py
        bestGap = Infinity
        break
      }
      if (gap > bestGap) {
        bestGap = gap
        cx = px
        cy = py
      }
    }
    if (bestGap < L.r_brain * L.r_brain * 0.25) {
      this.repBlocked.room++ // nowhere to put it: wait
      return false
    }
    const sigma = this.init.repro_mut
    const mutate = (w: Float64Array) => Float64Array.from(w, (v) => v + sigma * rng.gauss())
    /*
     * Uniform crossover, per weight: the standard operator for a real-valued genome, and the one
     * that assumes least about how the 418 weights are organised. A one-point crossover would
     * treat the flattening order as meaningful, and it is not — it is the order the weight matrix
     * happens to be stored in, nothing more.
     */
    const cross = (u: Float64Array, v: Float64Array): Float64Array => Float64Array.from(u, (a, i) => (rng.next() < 0.5 ? a : v[i]))
    const inherit = (pick: (p: number) => Float64Array): Float64Array => mutate(mate >= 0 ? cross(pick(b), pick(mate)) : pick(b))
    const heritable = (p: number, live: (Float64Array | undefined)[], born: (Float64Array | undefined)[]): Float64Array =>
      (this.darwinian ? born[p] : undefined) ?? live[p]!
    /*
     * Energy comes from the parents in equal shares, and the inner loop always draws from
     * whichever parent currently has most, so no rounding can push one of them negative. The
     * ledger invariant is what catches a mistake here: the first version of `split` destroyed
     * about 45 energy a run and nothing but that test noticed.
     */
    for (const idx of [childBrain, ...limbs.map((l) => l.idx)]) {
      this.alive[idx] = 1
      const add = Math.max(0, L.E_birth - this.energy[idx])
      if (add > 0) this.beginLife(idx)
      this.energy[idx] += add
      let owed = add
      while (owed > 1e-12) {
        const richest = parents.reduce((x, p) => (this.energy[p] > this.energy[x] ? p : x), parents[0])
        const take = Math.min(owed, this.energy[richest])
        if (take <= 0) break
        this.energy[richest] -= take
        owed -= take
      }
    }
    this.placeOrganism({
      brain: childBrain,
      x: cx,
      y: cy,
      limbs,
      wLimb: inherit((p) => heritable(p, this.wLimb, this.wBirthLimb)),
      wBrain: inherit((p) => heritable(p, this.wBrain, this.wBirthBrain)),
      parent: b,
      gen: this.gen[b] + 1,
      island: this.island[b],
      /*
       * A budded child inherits its parent's learner tag, and that is how a learner hears anything
       * at all in a healthy world.
       *
       * A learner may only act at a *spawn*, and a spawn needs a free brain slot — so a population
       * sitting at its cap produces none, and the learner was measured handing out samples it
       * could never score: 400 lives observed, **zero** updates. The better the world, the more
       * inert the learner, which is precisely backwards.
       *
       * A child carries its parent's weights plus a little noise, so it *is* a perturbed copy of
       * the same sample, and attributing its death back to that sample is approximately honest —
       * the mutation noise is real and is simply absorbed into the estimate. The learner still has
       * no say in reproduction; it only gets to find out what became of its own lineages.
       */
      learnId: this.learnId[b],
    })
    this.nBudded++
    for (const p of parents) this.repCool[p] = this.repWait[p]
    if (mate >= 0) {
      this.nConjugated++
      this.coparent[childBrain] = mate
    }
    return true
  }

  /**
   * An organism this one is bonded to, or -1.
   *
   * Bonded, not merely nearby — which is what makes conjugation fit the world rather than being
   * bolted onto it. A bond is already the world's only notion of association, it already costs
   * energy to make and has an activation energy to break, and `Joins` is met by every world that
   * has ever been confirmed. So the precondition for sexual reproduction is a thing that already
   * reliably happens, and the brain can now even perceive it (R5.5) and so could learn to seek it.
   *
   * Either body's particles count, since an organism touches the world through its limbs. The
   * partner must be fertile on its own terms too: its own threshold, its own cooldown.
   */
  private bondedMate(b: number): number {
    const max = this.bonds.max
    for (let s = -1; s < 4; s++) {
      const i = s < 0 ? b : this.limbs[b * 4 + s]
      if (i < 0) continue
      for (let k = 0; k < max; k++) {
        const j = this.bonds.partner[i * max + k]
        if (j < 0) continue
        const o = this.owner[j]
        if (o < 0 || o === b || !this.isBrain(o)) continue
        if (this.repCool[o] > 0 || this.energy[o] < this.eRepro[o]) continue
        return o
      }
    }
    return -1
  }

  /**
   * Sows a spore: one free particle, endowed with `E_spore` and carrying a copy of the genome.
   *
   * The spore is not a new kind of thing. It is free matter with a flag — it drifts under the same
   * chemistry, decays at the same rate, and is pushed by the same forces — so dispersal costs the
   * model one array and no new physics. What it buys is a lineage that can leave: budding can only
   * place a child in space it can already see is empty, and a spore goes wherever the drift takes
   * it and wakes where it finds food.
   */
  /** Sows a spore on demand, so a test can exercise one without waiting for a crowded world. */
  sowFor(b: number): boolean {
    return this.sow(b)
  }

  private sow(b: number): boolean {
    const { L } = this
    if (this.energy[b] < L.E_spore + L.E_hold) {
      this.repBlocked.energy++
      return false
    }
    let pick = -1
    for (let i = 0; i < this.nIntr && pick < 0; i++) {
      if (this.owner[i] === -1 && !this.isSpore[i] && this.alive[i] && this.cool[i] === 0) pick = i
    }
    if (pick < 0) {
      this.repBlocked.matter++
      return false
    }
    /*
     * Energy moves, never appears — and the target's reserve is **capped**.
     *
     * `energy[pick] += E_spore` with no cap could push a free particle past `E_cap`: verified, a
     * particle at 95 reached 125 against a cap of 100. The ledger stayed closed, because the parent
     * paid exactly the same amount, so this is R4's reserve ceiling breaking rather than
     * conservation. Whatever will not fit is simply not spent, so the parent keeps it.
     */
    const room = Math.max(0, L.E_cap - this.energy[pick])
    const give = Math.min(L.E_spore, room)
    if (give <= 0) return false // no room in that particle; try again another tick
    this.energy[b] -= give
    this.energy[pick] += give
    this.isSpore[pick] = 1
    this.wBrain[pick] = Float64Array.from(this.wBrain[b]!)
    this.wLimb[pick] = Float64Array.from(this.wLimb[b]!)
    this.parent[pick] = b
    this.gen[pick] = this.gen[b] + 1
    this.learnId[pick] = this.learnId[b]
    this.island[pick] = this.island[b]
    this.nSown++
    this.repCool[b] = this.repWait[b]
    return true
  }

  /**
   * Wakes any spore that has drifted somewhere worth waking up.
   *
   * The germination test is the **same food count the brain reads** (R5.4), so perception and
   * germination agree about what "there is food here" means — one definition, two uses. The spore
   * particle becomes the new organism's first limb, which is both tidy and right: the matter that
   * carried the genome is the matter the body starts from.
   *
   * A spore whose reserve falls below what a body costs stops being a spore and goes back to being
   * ordinary matter. That is the failure mode, and it is a quiet one on purpose — a spore that
   * never finds food has simply spent its parent's investment on nothing, which is what dispersal
   * risks.
   */
  private germinate(): void {
    const { L } = this
    for (let i = 0; i < this.nIntr; i++) {
      if (!this.isSpore[i]) continue
      if (this.energy[i] < 2 * L.E_birth) {
        this.forgetSpore(i)
        continue
      }
      if (this.owner[i] !== -1 || !this.alive[i]) {
        this.forgetSpore(i)
        continue
      }
      if (this.foodNear[i] < L.spore_food) continue
      let brain = -1
      for (let k = this.nIntr; k < this.nMatter && brain < 0; k++) {
        if (this.continuous ? !this.alive[k] : this.owner[k] === -1) brain = k
      }
      if (brain < 0) {
        this.repBlocked.slots++
        continue
      }
      if (this.brainGap2(this.x[i], this.y[i], brain) < L.r_brain * L.r_brain * 0.25) {
        this.repBlocked.room++
        continue
      }
      // the spore's own reserve endows the whole body: nothing is injected, nothing is destroyed
      const half = this.energy[i] / 2
      this.energy[i] -= half
      this.alive[brain] = 1
      this.beginLife(brain)
      this.energy[brain] += half
      const quad = this.socketFor(i, brain)
      this.placeOrganism({
        brain,
        x: this.x[i],
        y: this.y[i],
        limbs: [{ idx: i, quad, angle: this.quadMid(quad) }],
        wBrain: this.wBrain[i]!,
        wLimb: this.wLimb[i]!,
        parent: this.parent[i],
        gen: this.gen[i],
        island: this.island[i],
        learnId: this.learnId[i],
      })
      this.isSpore[i] = 0
      this.nGerminated++
    }
  }

  /** A spore that failed: the flag and the stored genome go, the matter and its energy stay. */
  private forgetSpore(i: number): void {
    this.isSpore[i] = 0
    this.wBrain[i] = undefined
    this.wLimb[i] = undefined
  }

  /** The quadrant a particle already lies in relative to a brain, so a rod is born where it is. */
  private socketFor(i: number, b: number): number {
    let phi = Math.atan2(this.minImage(this.y[i] - this.y[b]), this.minImage(this.x[i] - this.x[b]))
    if (phi < 0) phi += TAU
    return Math.min(3, Math.floor((phi / TAU) * 4))
  }

  private quadMid(s: number): number {
    return (this.quadLo(s) + this.quadHi(s)) / 2
  }

  limbCount(b: number): number {
    let n = 0
    for (let s = 0; s < 4; s++) if (this.limbs[b * 4 + s] >= 0) n++
    return n
  }

  /**
   * Fission: one organism becomes two, dividing what it has rather than paying for a newcomer.
   *
   * Budding builds a child out of free matter and tops every particle up to `E_birth`, which costs
   * energy the parent must have spare. Splitting costs nothing: the limbs are shared out, the
   * brain's reserve is halved, and no new matter is needed at all. What it costs instead is
   * *body* — two organisms of two limbs each where there was one of four — so size and
   * reproduction become a genuine trade-off rather than reproduction being purely a question of
   * surplus.
   *
   * The halves are placed within bonding range of each other and left alone. Whether they stay
   * together is then a question for the chemistry and for them, which is the only honest way to
   * ask it: nothing here bonds them, and nothing stops them.
   */
  private split(b: number): boolean {
    const { L, rng } = this
    const mine: { idx: number; quad: number; angle: number }[] = []
    for (let s = 0; s < 4; s++) {
      const l = this.limbs[b * 4 + s]
      if (l >= 0) mine.push({ idx: l, quad: s, angle: this.theta[l] })
    }
    if (mine.length < 2) return false

    let other = -1
    for (let i = this.nIntr; i < this.nMatter && other < 0; i++) {
      if (this.continuous ? !this.alive[i] : this.owner[i] === -1) other = i
    }
    if (other < 0) return false

    // somewhere to put the other half: close enough that a bond *could* form, far enough that the
    // two brains are not inside each other's exclusion radius
    const a = rng.next() * TAU
    const gap = L.r_brain + 2
    const cx = this.wrap(this.x[b] + gap * Math.cos(a))
    const cy = this.wrap(this.y[b] + gap * Math.sin(a))
    if (this.brainGap2(cx, cy, b) < L.r_brain * L.r_brain * 0.9) return false

    // half the limbs go, chosen from the end so each half keeps a contiguous spread of sockets
    const handOver = mine.splice(Math.ceil(mine.length / 2))
    if (handOver.length === 0) return false
    for (const g of handOver) {
      this.unbind(g.idx)
      this.alive[g.idx] = 1
    }
    // Energy *moves*, exactly as it does in budding: half the reserve is handed over, and what
    // will not fit under `E_cap` simply stays with the parent. The first version of this set both
    // halves to E/2 and booked the difference as injection, which quietly destroyed the parent's
    // half — 45 units of energy per test run, caught by the ledger invariants within seconds.
    this.alive[other] = 1
    this.beginLife(other)
    const give = this.energy[b] / 2
    const moved = Math.min(give, Math.max(0, L.E_cap - this.energy[other]))
    this.energy[other] += moved
    this.energy[b] -= moved

    const mut = this.init.repro_mut
    const mutate = (w: Float64Array): Float64Array => Float64Array.from(w, (v) => v + mut * rng.gauss())
    this.placeOrganism({
      brain: other,
      x: cx,
      y: cy,
      limbs: handOver.map((g) => ({ idx: g.idx, quad: g.quad, angle: g.angle })),
      wLimb: mutate(this.wLimb[b]!),
      wBrain: mutate(this.wBrain[b]!),
      parent: b,
      gen: this.gen[b] + 1,
      island: this.island[b],
      learnId: this.learnId[b],
    })
    this.nBudded++
    this.repCool[b] = this.repWait[b]
    this.placeLimbs(b)
    return true
  }

  /** Tops a particle's reserve up to E_init. Energy created here is counted as injected. */
  private endow(i: number): void {
    const add = Math.max(0, this.L.E_init - this.energy[i])
    if (add > 0) this.beginLife(i)
    this.energy[i] += add
    this.injected += add
  }

  /** The organism whose body is nearest (px, py), within `within`, or -1. */
  pickOrganism(px: number, py: number, within = this.L.L_rod + 6): number {
    let best = -1
    let bestD = within * within
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.alive[b] || !this.isBrain(b)) continue
      const dx = this.minImage(this.x[b] - px)
      const dy = this.minImage(this.y[b] - py)
      const d2 = dx * dx + dy * dy
      if (d2 < bestD) {
        bestD = d2
        best = b
      }
    }
    return best
  }

  /**
   * Places a saved organism: a free brain, free particles of the right types, somewhere clear.
   * Its energy is injected, like a spawn's, so the ledger still closes.
   */
  placeSaved(
    spec: {
      reserve: number
      limbs: { quad: number; type: number; angle: number; reserve: number }[]
      wLimb: number[]
      wBrain: number[]
    },
    at?: [number, number],
    island = 0,
  ): number {
    const { L } = this
    const open = (i: number) => !this.isSpore[i] && (this.continuous ? !this.alive[i] : this.owner[i] === -1)
    let brain = -1
    for (let b = this.nIntr; b < this.nMatter && brain < 0; b++) if (open(b)) brain = b
    if (brain < 0) return -1

    const taken = new Set<number>()
    const limbs: OrganismSpec['limbs'] = []
    for (const want of spec.limbs) {
      let pick = -1
      for (let i = 0; i < this.nIntr && pick < 0; i++) {
        if (taken.has(i) || !open(i) || this.cool[i] > 0) continue
        if (!this.continuous && this.type[i] !== want.type) continue
        pick = i
      }
      if (pick < 0) continue
      taken.add(pick)
      if (this.continuous) this.setType(pick, want.type)
      limbs.push({ idx: pick, quad: want.quad, angle: Math.min(this.quadHi(want.quad), Math.max(this.quadLo(want.quad), want.angle)) })
    }
    if (limbs.length === 0) return -1

    const [sx, sy] = at ?? this.freeSpot()
    // Setting a reserve has to be booked both ways: energy added is injected, energy the chosen
    // particle already held and no longer needs is burned. Only crediting the shortfall silently
    // destroyed energy whenever the particle was richer than the saved organism.
    const setReserve = (idx: number, give: number): void => {
      const delta = give - this.energy[idx]
      if (delta > 0) this.injected += delta
      else this.burned += -delta
      this.energy[idx] = give
    }
    for (const { idx, quad } of limbs) {
      this.alive[idx] = 1
      this.beginLife(idx)
      const want = spec.limbs.find((l) => l.quad === quad)
      setReserve(idx, Math.min(L.E_cap, Math.max(0, want?.reserve ?? L.E_birth)))
    }
    this.alive[brain] = 1
    this.beginLife(brain)
    setReserve(brain, Math.min(L.E_cap, Math.max(1, spec.reserve)))
    this.placeOrganism({
      brain,
      x: sx,
      y: sy,
      limbs,
      wLimb: Float64Array.from(spec.wLimb),
      wBrain: Float64Array.from(spec.wBrain),
      island,
    })
    return brain
  }

  /**
   * Loose brain particles that have eaten enough become organisms.
   *
   * This is the whole of how a body comes into existence now, and it creates nothing. A BRAIN-typed
   * particle sitting in the loose pool is inert matter: it eats like any matter can, and its
   * reserve bleeds at `decay_free`, so it crosses `E_activate` only if feeding beats decay. When it
   * does, it pays that energy as the cost of starting up — **burned, not moved** — and owns itself,
   * which is literally what `isBrain` tests and what lets `captures` begin filling its sockets.
   *
   * No grace period, no exemption, no endowment. It activated because it could afford to, and from
   * this tick it pays upkeep like any other body. Compare what this replaced: a spawn created a
   * body and its energy from nothing every `T_spawn` ticks regardless of whether the world could
   * support one.
   *
   * It arrives with zero limbs on purpose. A brain assembles its own body out of whatever drifts
   * into the right quadrant at the right radius, which `captures` already did and which keeps the
   * rod-and-quarter mechanics exactly as they were.
   */
  private activateBrains(): void {
    const { L } = this
    if (this.continuous) this.arriveBrain()
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.alive[b] || this.owner[b] !== -1 || this.isSpore[b]) continue
      if (this.cool[b] > 0) continue
      /*
       * **Arrhenius, not a threshold**, and written this way now so that a temperature *field* is a
       * substitution rather than a rewrite.
       *
       * `P(activate) = exp(-(E_activate - held) / T)`: a particle that has banked the whole barrier
       * starts immediately, one short of it starts at a rate that falls off exponentially with how
       * short it is, divided by how hot it is. A hard threshold would make this a cliff; a rate
       * makes temperature the thing that decides how readily life starts, which is the same law
       * that will decide how readily bonds break.
       *
       * Once `T` is a field, warm regions become nurseries where bodies start easily and hold
       * together badly, and cold regions become refuges where little starts and what exists lasts.
       * Habitats fall out of one law, and thermotaxis gets a payoff — which matters because food is
       * currently the only gradient worth following.
       */
      const deficit = L.E_activate - this.energy[b]
      if (deficit > 0) {
        const T = this.temperatureAt(this.x[b], this.y[b])
        if (T <= 0) continue
        if (this.rng.next() >= Math.exp(-deficit / T)) continue
        // Started below the barrier: thermal help got it over, and it keeps what it had.
      }
      /*
       * **The barrier is a threshold to clear, not a tax to pay.**
       *
       * Charging the whole barrier was a bug, and a severe one: a particle that activated on
       * exactly `E_activate` was left holding nothing, paid upkeep on its next tick and died. So
       * brains activated at the expected rate and died immediately, populations went extinct, and
       * **food piled up uneaten** — standing food of 269 to 1,264 particles in worlds with no
       * organisms left to eat it. The signature was unmistakable once seen, and it is the same one
       * the user's own saved 4x world showed: food at its cap with 87% of energy burned.
       *
       * Arrhenius has the right picture and it is not a tax. A barrier decides *how readily* a
       * transition happens; it is not consumed by it. Crossing one does cost work — here the work of
       * forming the body's first internal structure, one bond's worth — and everything above the
       * barrier is retained as the working capital a new body needs to go and find its next meal.
       */
      const paid = Math.min(this.energy[b], L.E_bond)
      this.burned += paid
      this.energy[b] -= paid
      this.owner[b] = b
      this.socket[b] = -1
      for (let s = 0; s < 4; s++) this.limbs[b * 4 + s] = -1
      this.bornAt[b] = this.tick
      this.mvx[b] = 0
      this.mvy[b] = 0
      this.beginLife(b)
      /*
       * Fresh random weights, as a spawn had. The one place a learner may act is the weights a new
       * organism is born with, so it is offered the same choice here.
       */
      const randLimb = randomLimb(() => this.rng.gauss())
      const randBrain = randomBrain(() => this.rng.gauss())
      const g = this.learner.genomeForSpawn(this.tick)
      const hand = this.init.handBuilt ? HAND_BUILT[this.init.handBuilt] : undefined
      this.wLimb[b] = g?.wLimb ?? hand?.limb() ?? randLimb
      this.wBrain[b] = g?.wBrain ?? hand?.brain() ?? randBrain
      this.learnId[b] = g?.id ?? 0
      this.nBirths++
    }
  }

  /**
   * One dead brain slot brought to life as a loose brain, in a continuous-inflow world.
   *
   * Inflow worlds need this and fixed-pool worlds do not, which is the whole distinction between
   * them. A fixed pool starts every slot alive and cycles it: a body dissolves, its particles go
   * loose, and a loose brain eats its way back over the barrier. A continuous world starts its
   * brain slots **dead** — that is what `inflow` means — so there is no loose brain to eat, and
   * `activateBrains` could never find a live one. Measured before this existed: one birth in 3,000
   * ticks of an inflow world, and that one was the seeded organism's.
   *
   * It arrives with **zero energy**, so nothing is created; it is matter appearing, which is the
   * premise of an inflow world, and it still has to eat its way over the barrier like any other.
   * One per tick at most, so a world does not fill with brains the instant it starts.
   */
  private arriveBrain(): void {
    const span = this.nMatter - this.nIntr
    if (span <= 0) return
    /*
     * A rotating cursor rather than a scan from zero: scanning from zero costs O(n) per arrival in
     * a full world and biases every arrival toward low indices, which would show up spatially
     * because `freeSpot` is called in arrival order.
     */
    for (let k = 0; k < span; k++) {
      const b = this.nIntr + ((this.brainCursor + k) % span)
      if (this.alive[b] || this.cool[b] > 0 || this.isSpore[b] || this.owner[b] !== -1) continue
      this.brainCursor = b - this.nIntr + 1
      const [sx, sy] = this.freeSpot()
      this.x[b] = sx
      this.y[b] = sy
      this.alive[b] = 1
      this.energy[b] = 0
      this.bornAt[b] = this.tick
      this.beginLife(b)
      return
    }
  }

  /** Spawns one organism with 1-4 random limbs, at `at` or anywhere there is room. */
  /**
   * Candidate slots for a spawn: free brains, and free matter to use as limbs.
   *
   * Pulled out of `spawnRandom` so a batch of spawns can build it **once**. Rebuilding it per spawn
   * made seeding O(n_start x nMatter), which is invisible at 1x and quadratic at scale: measured
   * 4.1 seconds to seed a 64x world's 4,096 organisms and **63 seconds** for a 128x world's 6,553,
   * against 73 milliseconds to allocate the same world with no organisms in it. Nearly all of a
   * large world's start-up time was this one scan, repeated.
   */
  private spawnPools(): { brains: number[]; pool: number[] } {
    const open = (i: number) => !this.isSpore[i] && (this.continuous ? !this.alive[i] : this.owner[i] === -1)
    const brains: number[] = []
    for (let b = this.nIntr; b < this.nMatter; b++) if (open(b)) brains.push(b)
    const pool: number[] = []
    for (let i = 0; i < this.nIntr; i++) if (open(i) && this.cool[i] === 0) pool.push(i)
    return { brains, pool }
  }

  /**
   * Seeds `n` organisms, scanning for candidates once rather than once per organism.
   *
   * Used for a world's initial population. Each placement removes what it consumed from the shared
   * pools, so the result is the same set of organisms a loop of `spawnRandom` would have produced —
   * what changes is that the scan happens once.
   */
  seedOrganisms(n: number): number {
    const pools = this.spawnPools()
    let made = 0
    for (let k = 0; k < n; k++) {
      if (!this.spawnRandom(undefined, pools)) break
      made++
    }
    return made
  }

  spawnRandom(at?: [number, number], pools?: { brains: number[]; pool: number[] }): boolean {
    const { rng } = this
    const { brains, pool } = pools ?? this.spawnPools()
    if (brains.length === 0 || pool.length === 0) return false

    const quads = [0, 1, 2, 3]
    for (let i = 3; i > 0; i--) {
      const j = rng.int(i + 1)
      ;[quads[i], quads[j]] = [quads[j], quads[i]]
    }
    const k = Math.min(pool.length, 1 + rng.int(4))
    const limbs: OrganismSpec['limbs'] = []
    for (let n = 0; n < k; n++) {
      const pick = rng.int(pool.length)
      const idx = pool[pick]
      pool[pick] = pool[pool.length - 1]
      pool.pop()
      const q = quads[n]
      limbs.push({ idx, quad: q, angle: this.quadLo(q) + rng.next() * (this.quadHi(q) - this.quadLo(q)) })
    }
    const bi = rng.int(brains.length)
    const brain = brains[bi]
    // taken out of the shared pool: a batch would otherwise hand the same brain out repeatedly
    brains[bi] = brains[brains.length - 1]
    brains.pop()
    for (const idx of [brain, ...limbs.map((l) => l.idx)]) {
      this.alive[idx] = 1
      this.endow(idx)
    }
    const [sx, sy] = at ?? this.freeSpot()
    // The weights a spawn would have had are drawn here whether or not they are used, in the same
    // order placeOrganism would have drawn them. Switching a learner on therefore does not move a
    // single food particle, which is what makes a paired run on one seed an honest comparison —
    // the only kind this world's variance allows.
    const randLimb = randomLimb(() => rng.gauss())
    const randBrain = randomBrain(() => rng.gauss())
    // the one place a learner may act: the weights a new organism is born with
    const g = this.learner.genomeForSpawn(this.tick)
    /*
     * A hand-built policy replaces the *random* draw, and a learner still outranks it.
     *
     * The random weights above are drawn either way, in the same order, so switching a hand-built
     * brain on does not move a single food particle — the same property the learner relies on, and
     * the reason a paired run on one seed is an honest comparison here.
     */
    const hand = this.init.handBuilt ? HAND_BUILT[this.init.handBuilt] : undefined
    this.placeOrganism({
      brain,
      x: sx,
      y: sy,
      limbs,
      wLimb: g?.wLimb ?? hand?.limb() ?? randLimb,
      wBrain: g?.wBrain ?? hand?.brain() ?? randBrain,
      learnId: g?.id,
    })
    return true
  }
}
