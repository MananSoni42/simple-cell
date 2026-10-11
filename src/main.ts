import type { Init } from './core/params'
import { World } from './core/world'
import { Renderer } from './render/renderer'
import { mountStart } from './ui/start'
import { StatsPanel } from './ui/stats'

const RATES = [0.25, 0.5, 1, 2, 5, 10, 30, 60, Infinity]
const startEl = document.getElementById('start')!
const worldEl = document.getElementById('world')!
const renderer = new Renderer(document.getElementById('c') as HTMLCanvasElement)
const stats = new StatsPanel(document.getElementById('stats')!)

let world: World | null = null
let rateIdx = 2
let paused = false
let acc = 0
let last = 0

function step(w: World): void {
  renderer.snapshot(w)
  w.step()
}

const start = mountStart(startEl, (init: Init) => {
  world = new World(init)
  renderer.snapshot(world)
  rateIdx = 2
  paused = false
  acc = 0
  stats.reset()
  start.hide()
  worldEl.hidden = false
  last = performance.now()
})

addEventListener('keydown', (e) => {
  if (!world) return
  if (e.key === 'Escape') {
    world = null
    worldEl.hidden = true
    start.show()
  } else if (e.key === ' ') {
    paused = !paused
    e.preventDefault()
  } else if (e.key === 'ArrowRight') rateIdx = Math.min(RATES.length - 1, rateIdx + 1)
  else if (e.key === 'ArrowLeft') rateIdx = Math.max(0, rateIdx - 1)
  else if (e.key === '.') {
    paused = true
    acc = 0
    step(world)
  }
})

function frame(now: number): void {
  requestAnimationFrame(frame)
  if (!world) return
  const dt = Math.min(0.25, (now - last) / 1000)
  last = now
  const rate = RATES[rateIdx]
  if (!paused) {
    const deadline = performance.now() + 12
    if (rate === Infinity) {
      while (performance.now() < deadline) step(world)
      acc = 0
    } else {
      acc += dt * rate
      while (acc >= 1 && performance.now() < deadline) {
        step(world)
        acc -= 1
      }
      if (acc > 3) acc = 0
    }
  }
  const smooth = !paused && rate !== Infinity && rate <= 10
  renderer.draw(world, smooth ? Math.min(1, acc) : 1)
  stats.update(world, paused ? 'paused' : rate === Infinity ? 'max speed' : `${rate} tick/s`)
}
requestAnimationFrame(frame)
