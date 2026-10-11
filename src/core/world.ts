import { type ForceBackend, serialBackend } from './backend'
import { type KernelArrays, type KernelParams } from './forcekernel'
import { LifeTracker } from './lifestats'
import { type Init, type Laws, LAWS } from './params'
import { Rng } from './rng'
import { BRAIN, FOOD, N_MATRIX } from './types'

const HALF_PI = Math.PI / 2
const TAU = Math.PI * 2
const N_IN = 27 // brain inputs: 4 sockets x 6 + 3
const N_OUT = 6 // 4 food shares + 2 move

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
  /** Tick at which a matter particle last became "live" (alive with energy > 0). */
  readonly since: Int32Array
  private wasLive: Uint8Array
  readonly lifeParticles = new LifeTracker()
  readonly lifeOrganisms = new LifeTracker()
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
    for (let i = 0; i < N_MATRIX; i++) for (let j = 0; j < N_MATRIX; j++) this.A[i * N_MATRIX + j] = init.A[i][j]

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
    this.cool = new Int16Array(n)
    this.bornAt = new Int32Array(n)
    this.gen = new Int32Array(n)
    this.parent = new Int32Array(n).fill(-1)
    this.repCool = new Int16Array(n)
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
      cellStart: g.start, fx: this.fx, fy: this.fy, foodNear: this.foodNear, A: this.A,
    }
    this.kernelParams = { SIZE: L.SIZE, r_c: L.r_c, beta: L.beta, K_core: L.K_core, nc: g.nc, skipFood: !init.foodMoves }
    this.field = new Float64Array(L.fieldN * L.fieldN)
    this.fieldTmp = new Float64Array(L.fieldN * L.fieldN)
    for (let p = 0; p < init.n_patch; p++) {
      this.patches.push({ x: this.rng.next() * L.SIZE, y: this.rng.next() * L.SIZE, h: this.rng.next() * TAU })
    }

    this.initialEnergy = this.totalEnergy()
    if (opts.autoSpawn !== false) {
      for (let i = 0; i < init.n_start; i++) this.spawnRandom()
      for (let i = 0; i < init.n_food0; i++) this.injectFood()
    }
  }

  // ---------------------------------------------------------------- accessors

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
    this.integrate()
    this.grid.build()
    this.uptake()
    this.think()
    this.costs()
    this.decayFree()
    if (this.continuous) this.freeMatterDecay()
    this.deaths()
    if (this.init.repro) this.reproduce()
    this.captures()
    this.stepField()
    this.stepPatches()
    this.tick++
    if (this.tick % this.init.T_food === 0) for (let k = 0; k < this.init.food_batch; k++) this.injectFood()
    if (this.tick % this.init.T_spawn === 0) for (let k = 0; k < this.init.spawn_batch; k++) this.spawnRandom()
    for (let i = 0; i < this.nMatter; i++) {
      if (this.cool[i] > 0) this.cool[i]--
      if (this.repCool[i] > 0) this.repCool[i]--
      const live = this.alive[i] && this.energy[i] > 1e-12 ? 1 : 0
      if (live !== this.wasLive[i]) {
        if (live) this.since[i] = this.tick
        else this.lifeParticles.record(this.tick - this.since[i])
        this.wasLive[i] = live
      }
    }
  }

  private integrate(): void {
    const { L, x, y, fx, fy, owner, alive, theta, rng } = this
    const mu = L.mu
    const sn = Math.sqrt(2 * mu * this.init.T)

    const foodMoves = this.init.foodMoves
    for (let i = 0; i < this.cap; i++) {
      if (!alive[i] || owner[i] !== -1) continue
      if (!foodMoves && this.type[i] === FOOD) continue
      x[i] = this.wrap(x[i] + mu * fx[i] + sn * rng.gauss())
      y[i] = this.wrap(y[i] + mu * fy[i] + sn * rng.gauss())
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
        const th = theta[l] + (mu * tangent + sn * rng.gauss()) / L.L_rod
        theta[l] = Math.min(this.quadHi(s), Math.max(this.quadLo(s), th))
      }
      x[b] = this.wrap(x[b] + mu * bx + sn * rng.gauss())
      y[b] = this.wrap(y[b] + mu * by + sn * rng.gauss())
      this.placeLimbs(b)
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
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l < 0) continue
        const x0 = energy[l] / L.E_ref
        const x1 = Math.min(1, field[this.fieldIndex(this.x[l], this.y[l])])
        const x2 = Math.min(1, this.foodNear[l] / 4)
        this.sig[l] = Math.tanh(wl[0] * x0 + wl[1] * x1 + wl[2] * x2 + wl[3])
        this.msg[l] = Math.tanh(wl[4] * x0 + wl[5] * x1 + wl[6] * x2 + wl[7])
        const o = s * 6
        xin[o] = this.msg[l]
        xin[o + 1 + this.type[l]] = 1
        xin[o + 5] = 1
      }
      xin[24] = energy[b] / L.E_ref
      xin[25] = Math.min(1, field[this.fieldIndex(this.x[b], this.y[b])])
      xin[26] = 1
      for (let k = 0; k < N_OUT; k++) {
        let sum = 0
        for (let m = 0; m < N_IN; m++) sum += wb[k * N_IN + m] * xin[m]
        yout[k] = sum
      }

      this.mvx[b] = L.F_max * Math.tanh(yout[4])
      this.mvy[b] = L.F_max * Math.tanh(yout[5])

      let zmax = -Infinity
      for (let s = 0; s < 4; s++) if (this.limbs[b * 4 + s] >= 0) zmax = Math.max(zmax, yout[s])
      if (zmax === -Infinity) continue
      let z = 0
      for (let s = 0; s < 4; s++) if (this.limbs[b * 4 + s] >= 0) z += Math.exp(yout[s] - zmax)
      const release = L.releaseFrac * energy[b]
      for (let s = 0; s < 4; s++) {
        const l = this.limbs[b * 4 + s]
        if (l < 0) continue
        const share = (release * Math.exp(yout[s] - zmax)) / z
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
        this.pay(l, L.c_sig * Math.max(0, this.sig[l]))
      }
    }
  }

  /** Free particles lose a fraction of their reserve each tick; the loss is burned. */
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

  /** Deactivates a slot; any residual reserve is burned so the ledger stays exact. */
  private kill(i: number): void {
    this.burned += this.energy[i]
    this.energy[i] = 0
    this.alive[i] = 0
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
    this.limbs[b * 4 + this.socket[l]] = -1
    this.owner[l] = -1
    this.socket[l] = -1
    this.cool[l] = this.L.cooldown
  }

  private deaths(): void {
    for (let b = this.nIntr; b < this.nMatter; b++) {
      if (!this.isBrain(b)) continue
      if (this.energy[b] <= 1e-12) {
        for (let s = 0; s < 4; s++) {
          const l = this.limbs[b * 4 + s]
          if (l >= 0) this.unbind(l)
        }
        this.owner[b] = -1
        if (this.continuous) this.kill(b)
        this.nDeaths++
        this.lifeOrganisms.record(this.tick - this.bornAt[b])
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
          if (Math.min(3, Math.floor(phi / HALF_PI)) !== s) continue
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

  injectFood(): boolean {
    if (this.freeFood.length === 0) return false
    const [px, py] = this.samplePoint()
    const i = this.freeFood.pop()!
    this.alive[i] = 1
    this.type[i] = FOOD
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
    this.wLimb[b] = spec.wLimb ?? Float64Array.from({ length: 8 }, () => rng.gauss())
    this.wBrain[b] = spec.wBrain ?? Float64Array.from({ length: N_OUT * N_IN }, () => 0.5 * rng.gauss())
    this.gen[b] = spec.gen ?? 0
    this.parent[b] = spec.parent ?? -1
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
        const open = this.continuous ? !this.alive[i] : this.owner[i] === -1 && this.type[i] === w.type && this.cool[i] === 0
        if (open) pick = i
      }
      if (pick < 0) continue
      taken.add(pick)
      cost += Math.max(0, L.E_birth - this.energy[pick])
      limbs.push({ idx: pick, quad: w.quad, angle: w.angle })
      if (this.continuous) this.type[pick] = w.type
    }
    if (limbs.length === 0 || this.energy[b] < cost + L.E_hold) return

    const a = rng.next() * TAU
    const sigma = this.init.repro_mut
    const mutate = (w: Float64Array) => Float64Array.from(w, (v) => v + sigma * rng.gauss())
    for (const idx of [childBrain, ...limbs.map((l) => l.idx)]) {
      this.alive[idx] = 1
      const add = Math.max(0, L.E_birth - this.energy[idx])
      this.energy[idx] += add
      this.energy[b] -= add
    }
    this.placeOrganism({
      brain: childBrain,
      x: this.x[b] + L.repro_dist * Math.cos(a),
      y: this.y[b] + L.repro_dist * Math.sin(a),
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
    this.energy[i] += add
    this.injected += add
  }

  /** Spawns one organism at a random place with 1-4 random limbs. Returns false if matter is short. */
  spawnRandom(): boolean {
    const { rng, L } = this
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
    this.placeOrganism({
      brain,
      x: rng.next() * L.SIZE,
      y: rng.next() * L.SIZE,
      limbs,
    })
    return true
  }
}
