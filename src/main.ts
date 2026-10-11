import { counts, meanClusterSize } from './core/metrics'
import type { Init } from './core/params'
import { World } from './core/world'
import { Renderer } from './render/renderer'
import { mountStart } from './ui/start'

const RATES = [0.25, 0.5, 1, 2, 5, 10, 30, 60, Infinity]
const startEl = document.getElementById('start')!
const worldEl = document.getElementById('world')!
const hud = document.getElementById('hud')!
const renderer = new Renderer(document.getElementById('c') as HTMLCanvasElement)

let world: World | null = null
let rateIdx = 2
let paused = false
let acc = 0
let last = 0
let clusterSize = 0
let clusterAt = 0

const start = mountStart(startEl, (init: Init) => {
  world = new World(init)
  rateIdx = 2
  paused = false
  acc = 0
  clusterSize = 0
  clusterAt = 0
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
    world.step()
  }
})

function updateHud(w: World): void {
  const c = counts(w)
  const now = performance.now()
  if (now - clusterAt > 1000) {
    clusterSize = meanClusterSize(w)
    clusterAt = now
  }
  const rate = RATES[rateIdx]
  const i = w.init
  hud.textContent =
    `tick ${w.tick}   ${paused ? 'PAUSED' : rate === Infinity ? 'max' : rate + ' tick/s'}\n` +
    `seed ${i.seed} · food ${i.foodMode} · T ${i.T}\n` +
    `organisms ${c.organisms}   bound ${c.bound}   free ${c.free}\n` +
    `food ${c.food}   energy ${c.energy.toFixed(0)}   burned ${w.burned.toFixed(0)}\n` +
    `mean cluster ${clusterSize.toFixed(1)}`
}

function frame(now: number): void {
  requestAnimationFrame(frame)
  if (!world) return
  const dt = Math.min(0.25, (now - last) / 1000)
  last = now
  if (!paused) {
    const rate = RATES[rateIdx]
    if (rate === Infinity) {
      const t0 = performance.now()
      while (performance.now() - t0 < 12) world.step()
    } else {
      acc += dt * rate
      let budget = performance.now() + 12
      while (acc >= 1 && performance.now() < budget) {
        world.step()
        acc -= 1
      }
      if (acc > 5) acc = 0
    }
  }
  renderer.draw(world)
  updateHud(world)
}
requestAnimationFrame(frame)
