import type { World } from '../core/world'
import { BRAIN, FOOD } from '../core/types'

const COLORS = ['#ff5d73', '#ffb84d', '#4de1c1', '#6c8cff', '#ffffff', '#b6ff5c']
const SIZES = [14, 14, 14, 14, 22, 9] // sprite diameter in world units

function sprite(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, color)
  grad.addColorStop(0.25, color + 'cc')
  grad.addColorStop(1, color + '00')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return c
}

export class Renderer {
  private ctx: CanvasRenderingContext2D
  private sprites = COLORS.map(sprite)
  private fieldCanvas = document.createElement('canvas')
  private px = 0

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

  draw(w: World): void {
    const { ctx, px } = this
    const k = px / w.L.SIZE
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = '#06080d'
    ctx.fillRect(0, 0, px, px)

    this.drawField(w)
    ctx.globalCompositeOperation = 'lighter'

    ctx.lineWidth = Math.max(1.5, 2.4 * k)
    for (let b = w.nIntr; b < w.nMatter; b++) {
      if (!w.isBrain(b)) continue
      for (let s = 0; s < 4; s++) {
        const l = w.limbs[b * 4 + s]
        if (l < 0) continue
        ctx.strokeStyle = COLORS[w.type[l]]
        ctx.globalAlpha = 0.8
        ctx.beginPath()
        ctx.moveTo(w.x[b] * k, w.y[b] * k)
        ctx.lineTo((w.x[b] + w.L.L_rod * Math.cos(w.theta[l])) * k, (w.y[b] + w.L.L_rod * Math.sin(w.theta[l])) * k)
        ctx.stroke()
      }
    }

    for (let i = 0; i < w.cap; i++) {
      if (!w.alive[i]) continue
      const t = w.type[i]
      const r = SIZES[t] * k
      let a = 0.9
      if (t === BRAIN || w.owner[i] >= 0) a = 0.45 + 0.55 * Math.min(1, w.energy[i] / w.L.E_ref)
      else if (t !== FOOD) a = 0.4 + 0.4 * Math.min(1, w.energy[i] / w.L.E_ref)
      ctx.globalAlpha = a
      ctx.drawImage(this.sprites[t], w.x[i] * k - r, w.y[i] * k - r, r * 2, r * 2)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawField(w: World): void {
    const N = w.L.fieldN
    const fc = this.fieldCanvas
    fc.width = fc.height = N
    const g = fc.getContext('2d')!
    const img = g.createImageData(N, N)
    for (let i = 0; i < N * N; i++) {
      const v = Math.min(1, w.field[i] * 0.8)
      img.data[i * 4] = 110
      img.data[i * 4 + 1] = 150
      img.data[i * 4 + 2] = 255
      img.data[i * 4 + 3] = v * 150
    }
    g.putImageData(img, 0, 0)
    this.ctx.imageSmoothingEnabled = true
    this.ctx.drawImage(fc, 0, 0, this.px, this.px)
  }
}
