import type { World } from '../core/world'
import { BRAIN, FOOD } from '../core/types'

const BG = '#0b0e14'
const COLORS = ['#ff6b81', '#ffc145', '#3ddc97', '#5b8def', '#f4f6fb', '#a3e635']
const R_PARTICLE = 2.6 // world units
const R_BRAIN = 3.4
const R_FOOD = 2

/** Flat shapes only: circles for matter, squares for brains, diamonds for food. */
export class Renderer {
  private ctx: CanvasRenderingContext2D
  private fieldCanvas = document.createElement('canvas')
  private px = 0
  private prevX = new Float32Array(0)
  private prevY = new Float32Array(0)
  private prevAlive = new Uint8Array(0)

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

  /** Call right before each world step so the next frames can glide from these positions. */
  snapshot(w: World): void {
    if (this.prevX.length !== w.cap) {
      this.prevX = new Float32Array(w.cap)
      this.prevY = new Float32Array(w.cap)
      this.prevAlive = new Uint8Array(w.cap)
    }
    this.prevX.set(w.x)
    this.prevY.set(w.y)
    this.prevAlive.set(w.alive)
  }

  /** alpha in [0,1]: how far we are from the last snapshot to the current state. */
  draw(w: World, alpha: number): void {
    const { ctx, px } = this
    const S = w.L.SIZE
    const k = px / S
    const X = new Float32Array(w.cap)
    const Y = new Float32Array(w.cap)
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

    ctx.globalAlpha = 1
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, px, px)
    this.drawField(w)

    // organism footprints, then rods
    ctx.lineCap = 'round'
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.isBrain(b)) continue
      ctx.beginPath()
      ctx.arc(X[b], Y[b], (w.L.L_rod + 5) * k, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(244,246,251,0.045)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(244,246,251,0.14)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.lineWidth = Math.max(2, 1.5 * k)
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.isBrain(b)) continue
      for (let s = 0; s < 4; s++) {
        const l = w.limbs[b * 4 + s]
        if (l < 0) continue
        ctx.strokeStyle = COLORS[w.type[l]]
        ctx.beginPath()
        ctx.moveTo(X[b], Y[b])
        ctx.lineTo(X[b] + (w.x[l] - w.x[b] + wrapD(w.x[l] - w.x[b], S)) * k, Y[b] + (w.y[l] - w.y[b] + wrapD(w.y[l] - w.y[b], S)) * k)
        ctx.stroke()
      }
    }

    // food, free matter, bound limbs, brains
    for (let i = w.nMatter; i < w.cap; i++) if (w.alive[i]) this.diamond(X[i], Y[i], R_FOOD * k, COLORS[FOOD])
    for (let i = 0; i < w.nIntr; i++) {
      if (w.owner[i] >= 0) continue
      ctx.globalAlpha = 0.6
      this.circle(X[i], Y[i], R_PARTICLE * 0.8 * k, COLORS[w.type[i]])
    }
    ctx.globalAlpha = 1
    for (let i = 0; i < w.nIntr; i++) {
      if (w.owner[i] < 0) continue
      ctx.globalAlpha = 0.55 + 0.45 * Math.min(1, w.energy[i] / w.L.E_ref)
      this.circle(X[i], Y[i], R_PARTICLE * k, COLORS[w.type[i]])
    }
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (w.isBrain(b)) {
        ctx.globalAlpha = 0.55 + 0.45 * Math.min(1, w.energy[b] / w.L.E_ref)
        ctx.fillStyle = COLORS[BRAIN]
        ctx.fillRect(X[b] - R_BRAIN * k, Y[b] - R_BRAIN * k, 2 * R_BRAIN * k, 2 * R_BRAIN * k)
      } else {
        ctx.globalAlpha = 0.5
        ctx.strokeStyle = '#8b94a8'
        ctx.lineWidth = 1.5
        const r = R_BRAIN * 0.8 * k
        ctx.strokeRect(X[b] - r, Y[b] - r, 2 * r, 2 * r)
      }
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

/** Correction that turns a raw coordinate difference into its minimum-image value. */
function wrapD(d: number, S: number): number {
  return -S * Math.round(d / S)
}
