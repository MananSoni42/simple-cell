import type { World } from '../core/world'

/** What the renderer needs to draw one frame, and nothing else. */
export interface RenderState {
  cap: number
  nIntr: number
  nMatter: number
  L: { SIZE: number; L_rod: number; E_ref: number; fieldN: number }
  x: Float32Array | Float64Array
  y: Float32Array | Float64Array
  energy: Float32Array | Float64Array
  theta: Float32Array | Float64Array
  field: Float32Array | Float64Array
  alive: Uint8Array
  type: Uint8Array
  owner: Int32Array
  /** Present when the world has bonding on, so the renderer can draw the joins. */
  bonds?: { max: number; partner: Int32Array }
  limbOf(brain: number, socket: number): number
  isBrain(i: number): boolean
}

export interface FrameLayout {
  cap: number
  nIntr: number
  nMatter: number
  fieldN: number
  SIZE: number
  L_rod: number
  E_ref: number
  maxBonds: number
}

/** One published snapshot of the world, in shared memory. */
export interface FrameBuffers {
  x: Float32Array
  y: Float32Array
  energy: Float32Array
  theta: Float32Array
  field: Float32Array
  alive: Uint8Array
  type: Uint8Array
  owner: Int32Array
  limbs: Int32Array // 4 sockets for each brain slot, indexed from nIntr
  bondPartner: Int32Array
}

export const N_FRAMES = 3 // one being written, one latest, one being read

export function layoutOf(w: World): FrameLayout {
  return { cap: w.cap, nIntr: w.nIntr, nMatter: w.nMatter, fieldN: w.L.fieldN, SIZE: w.L.SIZE, L_rod: w.L.L_rod, E_ref: w.L.E_ref, maxBonds: w.bonds.max }
}

const sab = (bytes: number) => new SharedArrayBuffer(bytes)

export function allocFrame(l: FrameLayout): FrameBuffers {
  return {
    x: new Float32Array(sab(4 * l.cap)),
    y: new Float32Array(sab(4 * l.cap)),
    energy: new Float32Array(sab(4 * l.cap)),
    theta: new Float32Array(sab(4 * l.cap)),
    field: new Float32Array(sab(4 * l.fieldN * l.fieldN)),
    alive: new Uint8Array(sab(l.cap)),
    type: new Uint8Array(sab(l.cap)),
    owner: new Int32Array(sab(4 * l.cap)),
    limbs: new Int32Array(sab(4 * 4 * (l.nMatter - l.nIntr))),
    bondPartner: new Int32Array(sab(4 * l.cap * Math.max(1, l.maxBonds))),
  }
}

export function writeFrame(w: World, f: FrameBuffers): void {
  const n = w.cap
  for (let i = 0; i < n; i++) {
    f.x[i] = w.x[i]
    f.y[i] = w.y[i]
    f.energy[i] = w.energy[i]
    f.theta[i] = w.theta[i]
  }
  f.alive.set(w.alive)
  f.type.set(w.type)
  f.owner.set(w.owner)
  f.limbs.set(w.limbs.subarray(4 * w.nIntr, 4 * w.nMatter))
  f.bondPartner.set(w.bonds.partner)
  for (let i = 0; i < f.field.length; i++) f.field[i] = w.field[i]
}

export function frameState(l: FrameLayout, f: FrameBuffers): RenderState {
  const { owner, limbs } = f
  return {
    cap: l.cap,
    nIntr: l.nIntr,
    nMatter: l.nMatter,
    L: { SIZE: l.SIZE, L_rod: l.L_rod, E_ref: l.E_ref, fieldN: l.fieldN },
    x: f.x,
    y: f.y,
    energy: f.energy,
    theta: f.theta,
    field: f.field,
    alive: f.alive,
    type: f.type,
    owner,
    bonds: { max: l.maxBonds, partner: f.bondPartner },
    limbOf: (b, s) => limbs[(b - l.nIntr) * 4 + s],
    isBrain: (i) => owner[i] === i,
  }
}

/** Render directly from a live world (no worker), e.g. for tests and screenshots. */
export function worldState(w: World): RenderState {
  return {
    cap: w.cap,
    nIntr: w.nIntr,
    nMatter: w.nMatter,
    L: w.L,
    x: w.x,
    y: w.y,
    energy: w.energy,
    theta: w.theta,
    field: w.field,
    alive: w.alive,
    type: w.type,
    owner: w.owner,
    bonds: { max: w.bonds.max, partner: w.bonds.partner },
    limbOf: (b, s) => w.limbs[b * 4 + s],
    isBrain: (i) => w.owner[i] === i,
  }
}

/** Header words shared by the simulation and the page. */
export const H = { COUNTER: 0, ACTIVE: 1, READING: 2, TICK: 3, SIZE: 8 } as const
