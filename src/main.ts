import type { Init } from './core/params'
import { World } from './core/world'
import { Renderer } from './render/renderer'
import { mountStart } from './ui/start'
import { StatsPanel } from './ui/stats'

const MIN_RATE = 0.125
const MAX_RATE = 512
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const startEl = $('start')
const worldEl = $('world')
const renderer = new Renderer($<HTMLCanvasElement>('c'))
const stats = new StatsPanel($('stats'))
const bPlay = $('b-play')
const bPause = $('b-pause')
const bRate = $('b-rate')

let world: World | null = null
let rate = 1 // ticks per second
let paused = false
let acc = 0
let last = 0

function step(w: World): void {
  renderer.snapshot(w)
  w.step()
}

const rateLabel = () => (paused ? 'paused' : `${rate} tick/s`)

function syncControls(): void {
  bPlay.classList.toggle('on', !paused)
  bPause.classList.toggle('on', paused)
  bRate.textContent = `${rate} tick/s`
}

function play(): void {
  paused = false
  last = performance.now()
  syncControls()
}
function pause(): void {
  paused = true
  syncControls()
}
function faster(): void {
  rate = Math.min(MAX_RATE, rate * 2)
  syncControls()
}
function slower(): void {
  rate = Math.max(MIN_RATE, rate / 2)
  syncControls()
}
function stop(): void {
  world = null
  worldEl.hidden = true
  start.show()
}

const start = mountStart(startEl, (init: Init) => {
  world = new World(init)
  renderer.snapshot(world)
  rate = 1
  acc = 0
  stats.reset()
  start.hide()
  worldEl.hidden = false
  play()
})

bPlay.addEventListener('click', play)
bPause.addEventListener('click', pause)
$('b-stop').addEventListener('click', stop)
$('b-fast').addEventListener('click', faster)
$('b-slow').addEventListener('click', slower)

addEventListener('keydown', (e) => {
  if (!world) return
  if (e.key === 'Escape') stop()
  else if (e.key === ' ') {
    e.preventDefault()
    paused ? play() : pause()
  } else if (e.key === 'ArrowRight') faster()
  else if (e.key === 'ArrowLeft') slower()
  else if (e.key === '.') {
    pause()
    acc = 0
    step(world)
  }
})

function frame(now: number): void {
  requestAnimationFrame(frame)
  if (!world) return
  const dt = Math.min(0.25, (now - last) / 1000)
  last = now
  if (!paused) {
    const deadline = performance.now() + 12
    acc += dt * rate
    while (acc >= 1 && performance.now() < deadline) {
      step(world)
      acc -= 1
    }
    if (acc > 3) acc = 0
  }
  // glide between ticks only when ticks are slow enough to see
  const smooth = !paused && rate <= 10
  renderer.draw(world, smooth ? Math.min(1, acc) : 1)
  stats.update(world, rateLabel())
}
requestAnimationFrame(frame)
