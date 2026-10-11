import type { World } from '../core/world'
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
  private X = new Float32Array(0)
  private Y = new Float32Array(0)

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.resize()
    addEventListener('resize', () => this.resize())
  }

  private resize(): void {
    const side = Math.floor(Math.min(innerWidth, innerHeight))
    const dpr = devicePixelRatio || 1
    this.canvas.style.width = this.canvas.style.height = side + 'px'
    this.canvas.width = this.canvas.height = Math.floor(side * dpr)
    this.px = this.canvas.width
  }

  /** Call right before each world step so the next frames can glide from these states. */
  snapshot(w: World): void {
    if (this.prevX.length !== w.cap) {
      this.prevX = new Float32Array(w.cap)
      this.prevY = new Float32Array(w.cap)
      this.prevTheta = new Float32Array(w.cap)
      this.prevAlive = new Uint8Array(w.cap)
      this.prevOwner = new Int32Array(w.cap)
      this.X = new Float32Array(w.cap)
      this.Y = new Float32Array(w.cap)
    }
    this.prevX.set(w.x)
    this.prevY.set(w.y)
    this.prevTheta.set(w.theta)
    this.prevAlive.set(w.alive)
    this.prevOwner.set(w.owner)
  }

  /** Screen positions for this frame. Limbs are rebuilt from their brain so rod and tip never drift apart. */
  private place(w: World, alpha: number): void {
    const { X, Y } = this
    const S = w.L.SIZE
    const k = this.px / S
    for (let i = 0; i < w.cap; i++) {
      let x = w.x[i]
      let y = w.y[i]
      if (alpha < 1 && this.prevAlive[i] && w.alive[i]) {
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
        const l = w.limbs[b * 4 + s]
        if (l < 0) continue
        let th = w.theta[l]
        if (alpha < 1 && this.prevOwner[l] === b) th = this.prevTheta[l] + (th - this.prevTheta[l]) * alpha
        X[l] = X[b] + w.L.L_rod * Math.cos(th) * k
        Y[l] = Y[b] + w.L.L_rod * Math.sin(th) * k
      }
    }
  }

  /** alpha in [0,1]: how far we are from the last snapshot to the current state. */
  draw(w: World, alpha: number): void {
    const { ctx, px, X, Y } = this
    const k = px / w.L.SIZE
    this.place(w, alpha)

    ctx.globalAlpha = 1
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, px, px)
    this.drawField(w)

    const brains: number[] = []
    for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) brains.push(b)

    // organism footprints, then rods
    for (const b of brains) {
      ctx.beginPath()
      ctx.arc(X[b], Y[b], (w.L.L_rod + 5) * k, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(244,246,251,0.045)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(244,246,251,0.14)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(2, 1.5 * k)
    for (const b of brains) {
      for (let s = 0; s < 4; s++) {
        const l = w.limbs[b * 4 + s]
        if (l < 0) continue
        ctx.strokeStyle = COLORS[w.type[l]]
        ctx.beginPath()
        ctx.moveTo(X[b], Y[b])
        ctx.lineTo(X[l], Y[l])
        ctx.stroke()
      }
    }

    // food, then free matter
    for (let i = w.nMatter; i < w.cap; i++) if (w.alive[i]) this.diamond(X[i], Y[i], R_FOOD * k, COLORS[FOOD])
    ctx.globalAlpha = 0.6
    for (let i = 0; i < w.nIntr; i++) {
      if (w.alive[i] && w.owner[i] < 0) this.circle(X[i], Y[i], R_PARTICLE * 0.8 * k, COLORS[w.type[i]])
    }
    ctx.globalAlpha = 1

    // bound limbs: dim disc + bright core sized by energy
    for (let i = 0; i < w.nIntr; i++) {
      if (!w.alive[i] || w.owner[i] < 0) continue
      const e = clamp01(w.energy[i] / w.L.E_ref)
      const r = R_PARTICLE * k
      ctx.globalAlpha = 0.28
      this.circle(X[i], Y[i], r, COLORS[w.type[i]])
      ctx.globalAlpha = 1
      this.circle(X[i], Y[i], r * Math.sqrt(e), COLORS[w.type[i]])
      ctx.strokeStyle = e < 0.12 ? LOW : COLORS[w.type[i]]
      ctx.lineWidth = Math.max(1, 0.5 * k)
      ctx.beginPath()
      ctx.arc(X[i], Y[i], r, 0, Math.PI * 2)
      ctx.stroke()
    }

    // brains: gauge filling from the bottom
    for (const b of brains) {
      const e = clamp01(w.energy[b] / w.L.E_ref)
      const r = R_BRAIN * k
      const x0 = X[b] - r
      const y0 = Y[b] - r
      ctx.fillStyle = '#1b2230'
      ctx.fillRect(x0, y0, 2 * r, 2 * r)
      ctx.fillStyle = e < 0.12 ? LOW : COLORS[BRAIN]
      ctx.fillRect(x0, y0 + 2 * r * (1 - e), 2 * r, 2 * r * e)
      ctx.strokeStyle = COLORS[BRAIN]
      ctx.lineWidth = Math.max(1, 0.5 * k)
      ctx.strokeRect(x0, y0, 2 * r, 2 * r)
    }
    // unborn brains: hollow squares
    ctx.globalAlpha = 0.45
    ctx.strokeStyle = '#8b94a8'
    ctx.lineWidth = 1.5
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.alive[b] || w.isBrain(b)) continue
      const r = R_BRAIN * 0.8 * k
      ctx.strokeRect(X[b] - r, Y[b] - r, 2 * r, 2 * r)
    }
    ctx.globalAlpha = 1
  }

  private circle(x: number, y: number, r: number, color: string): void {
    const { ctx } = this
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  private diamond(x: number, y: number, r: number, color: string): void {
    const { ctx } = this
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
    ctx.fill()
  }

  private drawField(w: World): void {
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
