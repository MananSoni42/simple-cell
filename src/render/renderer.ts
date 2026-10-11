import type { RenderState } from '../sim/frames'
import { BRAIN, FOOD } from '../core/types'

const BG = '#0b0e14'
const COLORS = ['#ff6b81', '#ffc145', '#3ddc97', '#5b8def', '#f4f6fb', '#a3e635']
const LOW = '#ff4d4d'
const R_PARTICLE = 2.7 // world units
const R_BRAIN = 4
const R_FOOD = 2

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Flat shapes only: circles for matter, squares for brains, diamonds for food.
 * Energy is shown on the organism itself: a brain is a gauge that fills from the
 * bottom, a limb is a dim disc with a bright core that grows with its reserve.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D
  private fieldCanvas = document.createElement('canvas')
  private px = 0
  private prevX = new Float32Array(0)
  private prevY = new Float32Array(0)
  private prevTheta = new Float32Array(0)
  private prevAlive = new Uint8Array(0)
  private prevOwner = new Int32Array(0)
  private prevType = new Uint8Array(0)
  private X = new Float32Array(0)
  private Y = new Float32Array(0)

  // camera: wheel zooms about the cursor, drag pans, double-click resets
  private zoom = 1
  private ox = 0
  private oy = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.resize()
    addEventListener('resize', () => this.resize())
    const toCanvas = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect()
      return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height]
    }
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const [mx, my] = toCanvas(e)
        const z = Math.min(80, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
        this.ox = mx - ((mx - this.ox) * z) / this.zoom
        this.oy = my - ((my - this.oy) * z) / this.zoom
        this.zoom = z
        this.clampPan()
      },
      { passive: false },
    )
    let drag: [number, number] | null = null
    canvas.addEventListener('pointerdown', (e) => {
      drag = toCanvas(e) as [number, number]
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return
      const [mx, my] = toCanvas(e)
      this.ox += mx - drag[0]
      this.oy += my - drag[1]
      drag = [mx, my]
      this.clampPan()
    })
    canvas.addEventListener('pointerup', () => (drag = null))
    canvas.addEventListener('dblclick', () => this.reset())
  }

  reset(): void {
    this.zoom = 1
    this.ox = this.oy = 0
  }

  /** Where a client-space point lands in the world, accounting for zoom and pan. */
  toWorld(clientX: number, clientY: number, size: number): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    const cx = ((clientX - r.left) * this.canvas.width) / r.width
    const cy = ((clientY - r.top) * this.canvas.height) / r.height
    const k = this.px / size
    const wrap = (v: number) => ((v % size) + size) % size
    return [wrap((cx - this.ox) / this.zoom / k), wrap((cy - this.oy) / this.zoom / k)]
  }

  private clampPan(): void {
    const lim = this.px * (1 - this.zoom)
    this.ox = Math.min(0, Math.max(lim, this.ox))
    this.oy = Math.min(0, Math.max(lim, this.oy))
  }

  private resize(): void {
    const side = Math.floor(Math.min(innerWidth, innerHeight))
    const dpr = devicePixelRatio || 1
    this.canvas.style.width = this.canvas.style.height = side + 'px'
    this.canvas.width = this.canvas.height = Math.floor(side * dpr)
    this.px = this.canvas.width
  }

  /** Call right before each world step so the next frames can glide from these states. */
  snapshot(w: RenderState): void {
    if (this.prevX.length !== w.cap) {
      this.prevX = new Float32Array(w.cap)
      this.prevY = new Float32Array(w.cap)
      this.prevTheta = new Float32Array(w.cap)
      this.prevAlive = new Uint8Array(w.cap)
      this.prevOwner = new Int32Array(w.cap)
      this.prevType = new Uint8Array(w.cap)
      this.X = new Float32Array(w.cap)
      this.Y = new Float32Array(w.cap)
    }
    this.prevX.set(w.x)
    this.prevY.set(w.y)
    this.prevTheta.set(w.theta)
    this.prevAlive.set(w.alive)
    this.prevOwner.set(w.owner)
    this.prevType.set(w.type)
  }

  /** Screen positions for this frame. Limbs are rebuilt from their brain so rod and tip never drift apart. */
  private place(w: RenderState, alpha: number): void {
    const { X, Y } = this
    const S = w.L.SIZE
    const k = this.px / S
    for (let i = 0; i < w.cap; i++) {
      let x = w.x[i]
      let y = w.y[i]
      // slots are recycled, so a live-before/live-after slot may hold a different particle:
      // interpolating then makes food appear to fly across the world
      const same = this.prevAlive[i] && w.alive[i] && this.prevType[i] === w.type[i] && this.prevOwner[i] === w.owner[i]
      if (alpha < 1 && same) {
        const dx = x - this.prevX[i]
        const dy = y - this.prevY[i]
        if (Math.abs(dx) < S / 2 && Math.abs(dy) < S / 2) {
          x = this.prevX[i] + dx * alpha
          y = this.prevY[i] + dy * alpha
        }
      }
      X[i] = x * k
      Y[i] = y * k
    }
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.alive[b] || !w.isBrain(b)) continue
      for (let s = 0; s < 4; s++) {
        const l = w.limbOf(b, s)
        if (l < 0) continue
        let th = w.theta[l]
        if (alpha < 1 && this.prevOwner[l] === b) th = this.prevTheta[l] + (th - this.prevTheta[l]) * alpha
        X[l] = X[b] + w.L.L_rod * Math.cos(th) * k
        Y[l] = Y[b] + w.L.L_rod * Math.sin(th) * k
      }
    }
  }

  /** alpha in [0,1]: how far we are from the last snapshot to the current state. */
  draw(w: RenderState, alpha: number): void {
    const { ctx, px, X, Y, zoom: z } = this
    const k = px / w.L.SIZE
    this.place(w, alpha)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, px, px)
    ctx.setTransform(z, 0, 0, z, this.ox, this.oy)
    this.drawField(w)
    // visible window in unzoomed pixel coordinates, with a margin for shape sizes
    const m = 12 * k * z
    const x0 = -this.ox / z - m / z
    const x1 = (px - this.ox) / z + m / z
    const y0 = -this.oy / z - m / z
    const y1 = (px - this.oy) / z + m / z
    const vis = (i: number) => X[i] >= x0 && X[i] <= x1 && Y[i] >= y0 && Y[i] <= y1
    // The world is a torus, so anything within `band` of an edge is also drawn on the far side.
    const band = (w.L.L_rod + 8) * k
    const offs: [number, number][] = []
    const tiles = (sx: number, sy: number): [number, number][] => {
      offs.length = 0
      offs.push([0, 0])
      const left = sx < band
      const right = sx > px - band
      const top = sy < band
      const bottom = sy > px - band
      if (left) offs.push([px, 0])
      if (right) offs.push([-px, 0])
      if (top) offs.push([0, px])
      if (bottom) offs.push([0, -px])
      if (left && top) offs.push([px, px])
      if (left && bottom) offs.push([px, -px])
      if (right && top) offs.push([-px, px])
      if (right && bottom) offs.push([-px, -px])
      return offs
    }

    const brains: number[] = []
    for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) brains.push(b)

    // Each organism is drawn whole, once per tile it touches, so a body on the seam is
    // never cut in half and its rods never run off the canvas.
    for (const b of brains) {
      if (!vis(b)) continue
      for (const [ox, oy] of tiles(X[b], Y[b])) {
        const bx = X[b] + ox
        const by = Y[b] + oy
        ctx.beginPath()
        ctx.arc(bx, by, (w.L.L_rod + 5) * k, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(244,246,251,0.045)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(244,246,251,0.14)'
        ctx.lineWidth = 1
        ctx.stroke()

        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(2, 1.5 * k)
        for (let s = 0; s < 4; s++) {
          const l = w.limbOf(b, s)
          if (l < 0) continue
          ctx.strokeStyle = COLORS[w.type[l]]
          ctx.beginPath()
          ctx.moveTo(bx, by)
          ctx.lineTo(X[l] + ox, Y[l] + oy)
          ctx.stroke()
        }
        for (let s = 0; s < 4; s++) {
          const l = w.limbOf(b, s)
          if (l < 0) continue
          const e = clamp01(w.energy[l] / w.L.E_ref)
          const r = R_PARTICLE * k
          const lx = X[l] + ox
          const ly = Y[l] + oy
          ctx.globalAlpha = 0.28
          this.circle(lx, ly, r, COLORS[w.type[l]])
          ctx.globalAlpha = 1
          this.circle(lx, ly, r * Math.sqrt(e), COLORS[w.type[l]])
          ctx.strokeStyle = e < 0.12 ? LOW : COLORS[w.type[l]]
          ctx.lineWidth = Math.max(1, 0.5 * k)
          ctx.beginPath()
          ctx.arc(lx, ly, r, 0, Math.PI * 2)
          ctx.stroke()
        }
        const e = clamp01(w.energy[b] / w.L.E_ref)
        const r = R_BRAIN * k
        ctx.fillStyle = '#1b2230'
        ctx.fillRect(bx - r, by - r, 2 * r, 2 * r)
        ctx.fillStyle = e < 0.12 ? LOW : COLORS[BRAIN]
        ctx.fillRect(bx - r, by - r + 2 * r * (1 - e), 2 * r, 2 * r * e)
        ctx.strokeStyle = COLORS[BRAIN]
        ctx.lineWidth = Math.max(1, 0.5 * k)
        ctx.strokeRect(bx - r, by - r, 2 * r, 2 * r)
      }
    }

    // food, then free matter
    for (let i = w.nMatter; i < w.cap; i++) {
      if (!w.alive[i] || !vis(i)) continue
      for (const [ox, oy] of tiles(X[i], Y[i])) this.diamond(X[i] + ox, Y[i] + oy, R_FOOD * k, COLORS[FOOD])
    }
    ctx.globalAlpha = 0.6
    for (let i = 0; i < w.nIntr; i++) {
      if (!w.alive[i] || w.owner[i] >= 0 || !vis(i)) continue
      for (const [ox, oy] of tiles(X[i], Y[i])) this.circle(X[i] + ox, Y[i] + oy, R_PARTICLE * 0.8 * k, COLORS[w.type[i]])
    }
    ctx.globalAlpha = 1

    // unborn brains: hollow squares
    ctx.globalAlpha = 0.45
    ctx.strokeStyle = '#8b94a8'
    ctx.lineWidth = 1.5
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.alive[b] || w.isBrain(b) || !vis(b)) continue
      const r = R_BRAIN * 0.8 * k
      for (const [ox, oy] of tiles(X[b], Y[b])) ctx.strokeRect(X[b] + ox - r, Y[b] + oy - r, 2 * r, 2 * r)
    }
    ctx.globalAlpha = 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  private circle(x: number, y: number, r: number, color: string): void {
    const { ctx } = this
    ctx.fillStyle = color
    if (r * this.zoom < 1.2) {
      const m = 1.6 / this.zoom // sub-pixel: a small square is far cheaper than an arc
      ctx.fillRect(x - m / 2, y - m / 2, m, m)
      return
    }
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  private diamond(x: number, y: number, r: number, color: string): void {
    const { ctx } = this
    ctx.fillStyle = color
    if (r * this.zoom < 1.2) {
      const m = 1.2 / this.zoom
      ctx.fillRect(x - m / 2, y - m / 2, m, m)
      return
    }
    ctx.beginPath()
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
    ctx.fill()
  }

  private drawField(w: RenderState): void {
    const N = w.L.fieldN
    const fc = this.fieldCanvas
    fc.width = fc.height = N
    const g = fc.getContext('2d')!
    const img = g.createImageData(N, N)
    for (let i = 0; i < N * N; i++) {
      img.data[i * 4] = 110
      img.data[i * 4 + 1] = 150
      img.data[i * 4 + 2] = 255
      img.data[i * 4 + 3] = Math.min(1, w.field[i] * 0.8) * 70
    }
    g.putImageData(img, 0, 0)
    this.ctx.imageSmoothingEnabled = true
    this.ctx.drawImage(fc, 0, 0, this.px, this.px)
  }
}
