import { type ForceBackend, serialBackend } from './backend'
import { type KernelArrays, type KernelParams } from './forcekernel'
import { AggregateTracker } from './aggregates'
import { Bonds, bondForce } from './bonds'
import { type FitnessSpec, describeSpec } from './fitness'
import { LEARN_DEFAULTS, type LearnConfig, type Learner, type LifeStats, makeLearner } from './learning'
import { LifeTracker, RollingMean } from './lifestats'
import { OrderTracker } from './orders'
import { BRAIN_OUT, N_BRAIN_IN, N_BRAIN_OUT, randomBrain, randomLimb } from './neurons'
import { type Init, type Laws, LAWS, applyQuantization, bondRange, regimeMultiplier } from './params'
import { Rng } from './rng'
import { BRAIN, FOOD, MATRIX_INDEX, N_MATRIX, WALL } from './types'

const HALF_PI = Math.PI / 2
const TAU = Math.PI * 2
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
  nDeaths = 0
  recordAge = 0
  readonly bornAt: Int32Array
  readonly gen: Int32Array // generation: 0 for spawned organisms, parent + 1 for budded ones
  readonly parent: Int32Array
  readonly repCool: Int16Array
  /** What the brain last told each socket; the limb neuron reads it next tick. */
  readonly brainSig: Float64Array
  readonly bonds: Bonds
  readonly bondCool: Int16Array
  /** Tick at which a matter particle last became "live" (alive with energy > 0). */
  readonly since: Int32Array
  private wasLive: Uint8Array
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
  /**
   * The tick convergence began, or null while the colonies are held apart. `merge_hold` starts a
   * world in the held state; `beginMerge()` releases it.
   */
  mergeStart: number | null = 0
  lineageCounter = 1
  nClamped = 0 // how often the per-tick step guardrail has had to bite
  nSteps = 0
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
  /** Food patches. `ox, oy` is where a patch started, which converging colonies travel from. */
  readonly patches: { x: number; y: number; h: number; ox: number; oy: number }[] = []
  /** Fractional food owed by the sun, so any arrival rate works, including less than one a tick. */
  /** Fractional food the sun still owes; part of the state, so a snapshot must carry it. */
  foodOwed = 0
  private spring: [number, number] = [0, 0]

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
      ...opts.laws,
    }
    this.rng = new Rng((init.seed ^ 0x9e3779b9) | 0)
    this.learner = makeLearner(init.learn ?? LEARN_DEFAULTS, init.seed)
    this.mergeStart = init.merge_hold ? null : 0
    const L = this.L

    this.A = new Float64Array(buffer(8 * N_MATRIX * N_MATRIX, opts.shared ?? false))
    const Araw = init.quantized ? applyQuantization(init.A.map((r) => r.slice())) : init.A
    const food = N_MATRIX - 1
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
    this.repCool = new Int16Array(n)
    this.brainSig = new Float64Array(n * 4)
    this.bonds = new Bonds(n, this.L.max_bonds)
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
    this.learnId = new Int32Array(n)
    this.island = new Int8Array(n)
    this.since = new Int32Array(n)
    this.wasLive = new Uint8Array(n)
    this.limbs = new Int32Array(n * 4).fill(-1)
    this.mvx = new Float64Array(n)
    this.mvy = new Float64Array(n)
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
    for (let i = this.cap - 1; i >= this.nMatter + this.nWall; i--) this.freeFood.push(i)

    this.grid = new Grid(L.SIZE, L.r_c, n, this.nMatter, this, sh)
    const g = this.grid
    this.kernelArrays = {
      px: g.px, py: g.py, ptype: g.ptype, powner: g.powner, pcell: g.pcell, items: g.items,
      cellStart: g.start, fx: this.fx, fy: this.fy, foodNear: this.foodNear,
      ffx: this.ffx, ffy: this.ffy, A: this.A,
    }
    this.kernelParams = {
      SIZE: L.SIZE, r_c: L.r_c, K_core: L.K_core, r_0: L.beta * L.r_c,
      r_brain_core: L.r_brain_core, r_brain: L.r_brain, K_brain: L.K_brain,
      A_brain: L.A_brain, r_brain_push: L.r_brain_push,
      r_wall: L.r_wall, K_wall: L.K_wall,
      nc: g.nc, skipFood: !init.foodMoves,
    }
    this.field = new Float64Array(L.fieldN * L.fieldN)
    this.fieldTmp = new Float64Array(L.fieldN * L.fieldN)
    const colonyModes = init.foodMode === 'converging' || init.foodMode === 'breathing'
    const colonies = colonyModes ? Math.max(2, Math.min(4, init.n_patch)) : init.n_patch
    const nPatch = init.foodMode === 'comet' || init.foodMode === 'spring' ? 1 : colonies
    for (let p = 0; p < nPatch; p++) {
      // colony modes start spread evenly round the world, so they really are apart; a world that
      // names its origins (a merge) overrides that, because its colonies have to begin where its
      // populations already are
      const given = init.patchOrigins?.[p]
      const even = colonyModes
      const a = (p / Math.max(1, nPatch)) * TAU
      const x = given ? this.wrap(given[0]) : even ? this.wrap(L.SIZE / 2 + L.SIZE * 0.33 * Math.cos(a)) : this.rng.next() * L.SIZE
      const y = given ? this.wrap(given[1]) : even ? this.wrap(L.SIZE / 2 + L.SIZE * 0.33 * Math.sin(a)) : this.rng.next() * L.SIZE
      this.patches.push({ x, y, h: this.rng.next() * TAU, ox: x, oy: y })
    }
    this.spring = [this.rng.next() * L.SIZE, this.rng.next() * L.SIZE]

    this.lifeParticlesWindow = new RollingMean(L.life_window, L.life_buckets)
    this.lifeOrganismsWindow = new RollingMean(L.life_window, L.life_buckets)
    this.initialEnergy = this.totalEnergy()
    if (opts.autoSpawn !== false) {
      for (let i = 0; i < init.n_start; i++) this.spawnRandom()
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
    if (this.tick % this.init.T_spawn === 0) for (let k = 0; k < this.init.spawn_batch; k++) this.spawnRandom()
    this.learner.review(this.tick)
    for (let i = 0; i < this.nMatter; i++) {
      if (this.cool[i] > 0) this.cool[i]--
      if (this.repCool[i] > 0) this.repCool[i]--
      if (this.bondCool[i] > 0) this.bondCool[i]--
    }
  }

  /**
   * Credits time spent in a compound to each of its members. Order is a property of a group, so
   * to drive anything it has to become per-organism: every member earns `(n - 1) ^ order_alpha`
   * per tick, superlinear so that a long-held large compound counts for much more than a long
   * small one. Sampled on the tracker's cadence and scaled, rather than recomputed every tick.
   */
  private creditOrders(): void {
    if (this.tick % this.orders.sampleEvery !== 0) return
    const alpha = this.L.order_alpha
    for (const members of this.orders.groupsNow(this)) {
      if (members.length < 2) continue
      const credit = Math.pow(members.length - 1, alpha) * this.orders.sampleEvery
      for (const b of members) this.orderTicks[b] += credit
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
  /** Distance beyond which a bond's spring would need more than F_break to hold it. */
  private get bondBreakAt(): number {
    return this.L.r_bond + this.L.F_break / this.L.k_bond
  }

  /**
   * Breaks bonds that are over-stretched *now*. Run after integrating as well as before, because
   * a limb rides its brain: without this a bond could be stretched by a body's motion and stay
   * visible, over-long, until the next tick noticed.
   */
  private pruneBonds(): void {
    const { x, y, bonds, L } = this
    const limit = this.bondBreakAt
    bonds.forEach((i, j) => {
      const dead = !this.alive[i] || !this.alive[j]
      if (!dead && Math.hypot(this.minImage(x[j] - x[i]), this.minImage(y[j] - y[i])) <= limit) return
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
    e.set(energy.subarray(0, this.nIntr))
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
    for (let i = 0; i < this.nIntr; i++) {
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
    for (let i = 0; i < this.nIntr; i++) {
      if (!shares(i)) continue
      out[i] = out[i] > 0 ? Math.min(1, e[i] / out[i]) : 1
      const room = Math.max(0, L.E_cap - e[i])
      inn[i] = inn[i] > 0 ? Math.min(1, room / inn[i]) : 1
    }

    // Pass three: apply, scaled at both ends. Every transfer is one subtraction and one addition
    // of the same number, so the energy ledger closes exactly.
    for (let i = 0; i < this.nIntr; i++) {
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
      if (r > this.bondBreakAt) {
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

  /** Forms new bonds between touching particles whose chemistry likes the pairing. */
  private formBonds(): void {
    const { L, x, y, grid, bonds, type } = this
    const r2max = bondRange(L).form ** 2
    for (let i = 0; i < this.nIntr; i++) {
      if (!this.alive[i] || this.bondCool[i] > 0 || bonds.slots(i) === 0) continue
      const mi = MATRIX_INDEX[type[i]]
      if (mi < 0) continue
      const n = grid.near(x[i], y[i])
      for (let k = 0; k < n; k++) {
        const j = grid.buf[k]
        if (j <= i || j >= this.nIntr || !this.alive[j] || this.bondCool[j] > 0) continue
        if (this.owner[i] >= 0 && this.owner[i] === this.owner[j]) continue // siblings are already joined by rods
        if (bonds.has(i, j) || bonds.slots(j) === 0) continue
        const mj = MATRIX_INDEX[type[j]]
        if (mj < 0 || this.A[mi * N_MATRIX + mj] < L.A_form) continue
        const dx = this.minImage(x[j] - x[i])
        const dy = this.minImage(y[j] - y[i])
        const r2 = dx * dx + dy * dy
        if (r2 > r2max) continue // slack enough that F_form can hold it
        if (this.energy[i] < L.E_bond || this.energy[j] < L.E_bond) continue
        if (!bonds.add(i, j)) break
        this.pay(i, L.E_bond)
        this.pay(j, L.E_bond)
        if (bonds.slots(i) === 0) break
      }
    }
  }

  private integrate(): void {
    // Sub-stepping splits one tick into n smaller moves that reuse the same forces. Brownian
    // increments are independent, so each is sqrt(n) smaller and the total variance is unchanged;
    // the force part is simply applied in n pieces. This is how a hot world stays stable.
    const n = Math.max(1, Math.round(this.init.substeps))
    for (let k = 0; k < n; k++) this.integrateOnce(this.L.mu / n, Math.sqrt((2 * this.L.mu * this.init.T) / n))
    this.separateBrains()
  }

  private integrateOnce(mu: number, sn: number): void {
    const { L, x, y, fx, fy, owner, alive, theta } = this

    const foodMoves = this.init.foodMoves
    for (let i = 0; i < this.cap; i++) {
      if (!alive[i] || owner[i] !== -1) continue
      const t = this.type[i]
      if (t === WALL) continue // terrain does not move
      if (!foodMoves && t === FOOD) continue
      const [sx, sy] = this.clampStep(mu * fx[i] + sn * this.kick(), mu * fy[i] + sn * this.kick())
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
    const { L, energy, field, xin, yout } = this
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
        const o = s * 6
        xin[o] = 1 // alive
        xin[o + 1 + this.type[l]] = 1
        xin[o + 5] = sig
      }
      xin[24] = energy[b] / L.E_ref
      xin[25] = Math.min(1, field[this.fieldIndex(this.x[b], this.y[b])])
      xin[26] = 1
      xin[27] = Math.tanh(gx)
      xin[28] = Math.tanh(gy)
      for (let k = 0; k < N_OUT; k++) {
        let sum = 0
        for (let m = 0; m < N_IN; m++) sum += wb[k * N_IN + m] * xin[m]
        yout[k] = sum
      }

      this.mvx[b] = L.F_max * Math.tanh(yout[BRAIN_OUT.FX])
      this.mvy[b] = L.F_max * Math.tanh(yout[BRAIN_OUT.FY])

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
    const k = this.init.decay_free
    if (k <= 0) return
    for (let i = 0; i < this.nMatter; i++) {
      if (!this.alive[i] || this.owner[i] !== -1) continue
      const e = this.energy[i]
      if (e <= 0) continue
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

  private unbind(l: number): void {
    const b = this.owner[l]
    const s = this.socket[l]
    this.limbs[b * 4 + s] = -1
    this.owner[l] = -1
    this.socket[l] = -1
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
    if (this.continuous) this.kill(b)
    this.nDeaths++
    const age = this.tick - this.bornAt[b]
    this.lifeOrganisms.record(age)
    this.lifeOrganismsWindow.record(this.tick, age)
    this.recordAge = Math.max(this.recordAge, age)
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
    this.learnId[b] = 0
  }

  private deaths(): void {
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
          if (j >= this.nIntr || type[j] === FOOD || owner[j] !== -1 || energy[j] < L.E_viable || cool[j] > 0) continue
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

  private stepPatches(): void {
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
    if (init.foodMode === 'spring') {
      // one small fixed source: everything has to come here, so position is everything
      return inPatch({ x: this.spring[0], y: this.spring[1] }, init.r_patch * 0.22)
    }
    if (init.foodMode === 'ring') {
      const a = rng.next() * TAU
      const rr = S * 0.33 + (rng.next() - 0.5) * init.r_patch * 0.6
      return [this.wrap(S / 2 + rr * Math.cos(a)), this.wrap(S / 2 + rr * Math.sin(a))]
    }
    if (init.foodMode === 'gradient') {
      for (;;) {
        const px = rng.next() * S
        const w = (1 + Math.cos((TAU * px) / S)) / 2
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
        this.foodOwed = 0 // the world is full; the rest of this tick's light is wasted
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
    this.wLimb[b] = spec.wLimb ?? randomLimb(() => rng.gauss())
    this.wBrain[b] = spec.wBrain ?? randomBrain(() => rng.gauss())
    this.learnId[b] = spec.learnId ?? 0
    this.island[b] = spec.island ?? (spec.parent !== undefined && spec.parent >= 0 ? this.island[spec.parent] : 0)
    this.gen[b] = spec.gen ?? 0
    this.parent[b] = spec.parent ?? -1
    this.children[b] = 0
    this.harvested[b] = 0
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
      this.bud(b)
    }
  }

  private bud(b: number): void {
    const { L, rng } = this
    const want: { quad: number; type: number; angle: number }[] = []
    for (let s = 0; s < 4; s++) {
      const l = this.limbs[b * 4 + s]
      if (l >= 0) want.push({ quad: s, type: this.type[l], angle: this.theta[l] })
    }
    if (want.length === 0) return

    // find room: an open brain slot and one open particle per wanted limb
    let childBrain = -1
    for (let i = this.nIntr; i < this.nMatter && childBrain < 0; i++) {
      if (this.continuous ? !this.alive[i] : this.owner[i] === -1) childBrain = i
    }
    if (childBrain < 0) return
    const taken = new Set<number>()
    const limbs: OrganismSpec['limbs'] = []
    let cost = Math.max(0, L.E_birth - this.energy[childBrain])
    for (const w of want) {
      let pick = -1
      for (let i = 0; i < this.nIntr && pick < 0; i++) {
        if (taken.has(i)) continue
        const open = this.continuous ? !this.alive[i] && this.cool[i] === 0 : this.owner[i] === -1 && this.type[i] === w.type && this.cool[i] === 0
        if (open) pick = i
      }
      if (pick < 0) continue
      taken.add(pick)
      cost += Math.max(0, L.E_birth - this.energy[pick])
      limbs.push({ idx: pick, quad: w.quad, angle: w.angle })
      if (this.continuous) this.type[pick] = w.type
    }
    if (limbs.length === 0 || this.energy[b] < cost + L.E_hold) return

    // place the child clear of every other body, preferring the parent's own neighbourhood
    let cx = 0
    let cy = 0
    let bestGap = -1
    for (let t = 0; t < 16; t++) {
      const a = rng.next() * TAU
      const px = this.wrap(this.x[b] + L.repro_dist * Math.cos(a))
      const py = this.wrap(this.y[b] + L.repro_dist * Math.sin(a))
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
    if (bestGap < L.r_brain * L.r_brain * 0.25) return // nowhere to put it: wait
    const sigma = this.init.repro_mut
    const mutate = (w: Float64Array) => Float64Array.from(w, (v) => v + sigma * rng.gauss())
    for (const idx of [childBrain, ...limbs.map((l) => l.idx)]) {
      this.alive[idx] = 1
      const add = Math.max(0, L.E_birth - this.energy[idx])
      if (add > 0) this.beginLife(idx)
      this.energy[idx] += add
      this.energy[b] -= add
    }
    this.placeOrganism({
      brain: childBrain,
      x: cx,
      y: cy,
      limbs,
      wLimb: mutate(this.wLimb[b]!),
      wBrain: mutate(this.wBrain[b]!),
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
    this.repCool[b] = this.repWait[b]
  }

  private limbCount(b: number): number {
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
    const open = (i: number) => (this.continuous ? !this.alive[i] : this.owner[i] === -1)
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
      if (this.continuous) this.type[pick] = want.type
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

  /** Spawns one organism with 1-4 random limbs, at `at` or anywhere there is room. */
  spawnRandom(at?: [number, number]): boolean {
    const { rng } = this
    const brains: number[] = []
    const open = (i: number) => (this.continuous ? !this.alive[i] : this.owner[i] === -1)
    for (let b = this.nIntr; b < this.nMatter; b++) if (open(b)) brains.push(b)
    const pool: number[] = []
    for (let i = 0; i < this.nIntr; i++) if (open(i) && this.cool[i] === 0) pool.push(i)
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
    const brain = brains[rng.int(brains.length)]
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
    this.placeOrganism({
      brain,
      x: sx,
      y: sy,
      limbs,
      wLimb: g?.wLimb ?? randLimb,
      wBrain: g?.wBrain ?? randBrain,
      learnId: g?.id,
    })
    return true
  }
}
