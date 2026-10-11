import { type ForceBackend, serialBackend } from './backend'
import { type KernelArrays, type KernelParams } from './forcekernel'
import { AggregateTracker } from './aggregates'
import { Bonds, bondForce } from './bonds'
import { LifeTracker, RollingMean } from './lifestats'
import { BRAIN_OUT, N_BRAIN_IN, N_BRAIN_OUT, N_WLIMB } from './neurons'
import { type Init, type Laws, LAWS, applyQuantization, bondRange } from './params'
import { Rng } from './rng'
import { BRAIN, FOOD, MATRIX_INDEX, N_MATRIX } from './types'

const HALF_PI = Math.PI / 2
const TAU = Math.PI * 2
const N_IN = N_BRAIN_IN
const N_OUT = N_BRAIN_OUT

export interface WorldOpts {
  laws?: Partial<Laws>
  autoSpawn?: boolean
  maxFood?: number
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
  readonly lifeParticlesWindow: RollingMean
  readonly lifeOrganismsWindow: RollingMean
  /** Lineage: a spawned organism founds one; its descendants inherit the id. */
  readonly lineage: Int32Array
  readonly children: Int32Array
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
  private freeFood: number[] = []
  readonly patches: { x: number; y: number; h: number }[] = []

  private xin = new Float64Array(N_IN)
  private yout = new Float64Array(N_OUT)

  constructor(init: Init, opts: WorldOpts = {}) {
    this.init = init
    this.L = { ...LAWS, SIZE: init.size, fieldN: Math.min(256, Math.round((LAWS.fieldN * init.size) / LAWS.SIZE)), ...opts.laws }
    this.rng = new Rng((init.seed ^ 0x9e3779b9) | 0)
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

    this.continuous = init.inflow
    const brainCap = this.continuous ? init.n_brain * 3 : init.n_brain
    this.nIntr = init.n_intrinsic + (this.continuous ? 4 * brainCap : 0)
    this.nMatter = this.nIntr + brainCap
    this.cap = this.nMatter + (opts.maxFood ?? init.max_food)
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
    this.bondCool = new Int16Array(n)
    this.lineage = new Int32Array(n)
    this.children = new Int32Array(n)
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
    for (let i = this.cap - 1; i >= this.nMatter; i--) this.freeFood.push(i)

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
      nc: g.nc, skipFood: !init.foodMoves,
    }
    this.field = new Float64Array(L.fieldN * L.fieldN)
    this.fieldTmp = new Float64Array(L.fieldN * L.fieldN)
    for (let p = 0; p < init.n_patch; p++) {
      this.patches.push({ x: this.rng.next() * L.SIZE, y: this.rng.next() * L.SIZE, h: this.rng.next() * TAU })
    }

    this.lifeParticlesWindow = new RollingMean(L.life_window, L.life_buckets)
    this.lifeOrganismsWindow = new RollingMean(L.life_window, L.life_buckets)
    this.initialEnergy = this.totalEnergy()
    if (opts.autoSpawn !== false) {
      for (let i = 0; i < init.n_start; i++) this.spawnRandom()
      for (let i = 0; i < init.n_food0; i++) this.injectFood()
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
    return this.cap - this.nMatter - this.freeFood.length
  }

  totalEnergy(): number {
    let e = 0
    for (let i = 0; i < this.cap; i++) if (this.alive[i]) e += this.energy[i]
    return e
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
    if (this.init.bonds) this.formBonds()
    this.stepField()
    this.stepPatches()
    this.aggregates.observe(this)
    this.tick++
    if (this.tick % this.init.T_food === 0) for (let k = 0; k < this.init.food_batch; k++) this.injectFood()
    if (this.tick % this.init.T_spawn === 0) for (let k = 0; k < this.init.spawn_batch; k++) this.spawnRandom()
    for (let i = 0; i < this.nMatter; i++) {
      if (this.cool[i] > 0) this.cool[i]--
      if (this.repCool[i] > 0) this.repCool[i]--
      if (this.bondCool[i] > 0) this.bondCool[i]--
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

  /** Guardrail: no particle may move further than d_max in one tick, whatever the forces say. */
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
      if (Math.abs(f) > L.F_break) {
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
      if (!foodMoves && this.type[i] === FOOD) continue
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
    for (let f = this.nMatter; f < this.cap; f++) {
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
    for (let f = this.nMatter; f < this.cap; f++) {
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

  private deaths(): void {
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b)) continue
      if (this.energy[b] <= 1e-12) {
        this.dropCorpse(b)
        for (let s = 0; s < 4; s++) {
          const l = this.limbs[b * 4 + s]
          if (l >= 0) this.unbind(l)
        }
        this.owner[b] = -1
        if (this.continuous) this.kill(b)
        this.nDeaths++
        this.lifeOrganisms.record(this.tick - this.bornAt[b])
        this.lifeOrganismsWindow.record(this.tick, this.tick - this.bornAt[b])
        this.recordAge = Math.max(this.recordAge, this.tick - this.bornAt[b])
        this.wLimb[b] = undefined
        this.wBrain[b] = undefined
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
    const v = this.init.v_patch
    for (const p of this.patches) {
      p.h += 0.1 * this.rng.gauss()
      p.x = this.wrap(p.x + v * Math.cos(p.h))
      p.y = this.wrap(p.y + v * Math.sin(p.h))
    }
  }

  // ---------------------------------------------------------------- creation

  private samplePoint(): [number, number] {
    const { rng, init, L } = this
    const S = L.SIZE
    if (init.foodMode === 'patchy' && this.patches.length > 0) {
      const p = this.patches[rng.int(this.patches.length)]
      const r = init.r_patch * Math.sqrt(rng.next())
      const a = rng.next() * TAU
      return [this.wrap(p.x + r * Math.cos(a)), this.wrap(p.y + r * Math.sin(a))]
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
    this.owner[b] = b
    this.nBirths++
    this.bornAt[b] = this.tick
    this.x[b] = this.wrap(spec.x)
    this.y[b] = this.wrap(spec.y)
    this.mvx[b] = 0
    this.mvy[b] = 0
    this.wLimb[b] = spec.wLimb ?? Float64Array.from({ length: N_WLIMB }, () => rng.gauss())
    this.wBrain[b] = spec.wBrain ?? Float64Array.from({ length: N_OUT * N_IN }, () => 0.5 * rng.gauss())
    this.gen[b] = spec.gen ?? 0
    this.parent[b] = spec.parent ?? -1
    this.children[b] = 0
    if (spec.parent !== undefined && spec.parent >= 0) {
      this.lineage[b] = this.lineage[spec.parent]
      this.children[spec.parent]++
    } else this.lineage[b] = this.lineageCounter++
    this.repCool[b] = this.L.repro_cooldown
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
      if (!this.isBrain(b) || this.repCool[b] > 0 || this.energy[b] < this.L.E_repro) continue
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
    })
    this.nBudded++
    this.repCool[b] = L.repro_cooldown
  }

  /** Tops a particle's reserve up to E_init. Energy created here is counted as injected. */
  private endow(i: number): void {
    const add = Math.max(0, this.L.E_init - this.energy[i])
    if (add > 0) this.beginLife(i)
    this.energy[i] += add
    this.injected += add
  }

  /** Spawns one organism at a random place with 1-4 random limbs. Returns false if matter is short. */
  spawnRandom(): boolean {
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
    const [sx, sy] = this.freeSpot()
    this.placeOrganism({ brain, x: sx, y: sy, limbs })
    return true
  }
}
