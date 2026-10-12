import type { Init } from '../core/params'
import { BRAIN, FOOD, WALL } from '../core/types'
import { World } from '../core/world'
import { WORLD } from './theme'
import { reducedMotion } from './theme'

const BG = '#0b0e14'

/**
 * A moving look at the world you are about to build.
 *
 * Choosing between worlds by name is guessing: "Sticky" and "Chains" mean nothing until you have
 * watched one. So the picker runs the actual world — same code, same seed, same laws — in a small
 * canvas, a few hundred ticks in, and shows what it settles into. The preview is the model, not an
 * illustration of it, so it cannot lie about what pressing the button will give you.
 *
 * It runs in slices on the frame clock rather than all at once, because a one-second freeze every
 * time a chip is clicked would cost more than the preview is worth.
 */

const TICKS = 420
const SLICE_MS = 7

export interface Preview {
  /** Show this world. Any run already in progress is abandoned. */
  show(init: Init): void
  stop(): void
}

export function mountPreview(canvas: HTMLCanvasElement, onStats?: (s: PreviewStats) => void): Preview {
  const ctx = canvas.getContext('2d')!
  let world: World | null = null
  let want = 0
  let frame = 0
  let generation = 0

  const resize = (): void => {
    const dpr = Math.min(2, devicePixelRatio || 1)
    const w = canvas.clientWidth || 300
    const h = canvas.clientHeight || 200
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    if (world) draw(world)
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas)

  function draw(w: World): void {
    const { width: W, height: H } = canvas
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, W, H)
    // the world is square; fit it and letterbox the rest
    const s = Math.min(W, H) / w.init.size
    const ox = (W - s * w.init.size) / 2
    const oy = (H - s * w.init.size) / 2
    const px = (v: number): number => ox + v * s
    const py = (v: number): number => oy + v * s

    ctx.fillStyle = WORLD[6]
    for (let i = 0; i < w.cap; i++) {
      if (!w.alive[i] || w.type[i] !== WALL) continue
      ctx.fillRect(px(w.x[i]) - 2 * s, py(w.y[i]) - 2 * s, 4 * s, 4 * s)
    }

    ctx.fillStyle = WORLD[5]
    for (let i = 0; i < w.cap; i++) {
      if (!w.alive[i] || w.type[i] !== FOOD) continue
      ctx.fillRect(px(w.x[i]) - 1.1 * s, py(w.y[i]) - 1.1 * s, 2.2 * s, 2.2 * s)
    }

    for (let i = 0; i < w.cap; i++) {
      if (!w.alive[i] || w.type[i] === FOOD || w.type[i] === WALL || w.type[i] === BRAIN) continue
      ctx.fillStyle = WORLD[w.type[i]] ?? WORLD[4]
      ctx.beginPath()
      ctx.arc(px(w.x[i]), py(w.y[i]), Math.max(1, 2.7 * s), 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = WORLD[4]
    for (let i = 0; i < w.cap; i++) {
      if (!w.alive[i] || w.type[i] !== BRAIN) continue
      const r = Math.max(1.5, 4 * s)
      ctx.fillRect(px(w.x[i]) - r, py(w.y[i]) - r, 2 * r, 2 * r)
    }
  }

  function stats(w: World): PreviewStats {
    let organisms = 0
    let food = 0
    let matter = 0
    let bonded = 0
    for (let i = 0; i < w.cap; i++) {
      if (!w.alive[i]) continue
      if (w.type[i] === FOOD) food++
      else if (w.type[i] === BRAIN) organisms++
      else if (w.type[i] !== WALL) {
        matter++
        if (w.bonds.slots(i) < w.bonds.max) bonded++
      }
    }
    return { tick: w.tick, organisms, food, matter, bonded }
  }

  function pump(): void {
    frame = 0
    const w = world
    if (!w) return
    const mine = generation
    const until = performance.now() + SLICE_MS
    while (w.tick < want && performance.now() < until) w.step()
    if (generation !== mine) return
    draw(w)
    onStats?.(stats(w))
    if (w.tick < want) frame = requestAnimationFrame(pump)
  }

  return {
    show(init) {
      generation++
      // a preview must not perturb the real world, so it gets its own copy of everything
      world = new World(JSON.parse(JSON.stringify(init)) as Init)
      want = reducedMotion() ? Math.round(TICKS / 2) : TICKS
      if (frame) cancelAnimationFrame(frame)
      resize()
      pump()
    },
    stop() {
      generation++
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      world = null
    },
  }
}

export interface PreviewStats {
  tick: number
  organisms: number
  food: number
  matter: number
  /** Particles holding at least one bond — the clearest single sign of structure. */
  bonded: number
}
