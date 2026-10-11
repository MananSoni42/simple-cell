import { type Perf, canShare, makeBackend } from './compute/select'
import type { Init } from './core/params'
import { World } from './core/world'
import { Renderer } from './render/renderer'
import { mountStart } from './ui/start'
import { StatsPanel } from './ui/stats'

const MIN_RATE = 0.125
const MAX_RATE = 65536
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const startEl = $('start')
const worldEl = $('world')
const renderer = new Renderer($<HTMLCanvasElement>('c'))
const stats = new StatsPanel($('stats'))
const bPlay = $('b-play')
const bPause = $('b-pause')
const bRate = $('b-rate')

let world: World | null = null
let rate = 1 // requested ticks per second
let paused = false
let acc = 0
let last = 0
let session = 0
let busy = false
let perfNote = ''
let tps = 0 // achieved ticks per second
let tpsCount = 0
let tpsSince = 0

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
  session++
  world?.backend.dispose?.()
  world = null
  worldEl.hidden = true
  start.show()
}

const start = mountStart(startEl, async (init: Init, perf: Perf) => {
  session++
  busy = false
  const w = new World(init, { shared: canShare })
  const { backend, note } = await makeBackend(w, perf)
  w.backend = backend
  perfNote = note
  world = w
  renderer.reset()
  renderer.snapshot(w)
  rate = 1
  acc = 0
  tps = tpsCount = 0
  tpsSince = performance.now()
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
  else if (e.key === '.' && !busy) {
    pause()
    acc = 0
    renderer.snapshot(world)
    void world.stepAsync()
  }
})

async function advance(w: World, mine: number): Promise<void> {
  busy = true
  const deadline = performance.now() + 12
  try {
    while (mine === session && acc >= 1 && performance.now() < deadline) {
      renderer.snapshot(w)
      await w.stepAsync()
      acc -= 1
      tpsCount++
    }
  } finally {
    if (mine === session) busy = false
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame)
  if (!world) return
  const dt = Math.min(0.25, (now - last) / 1000)
  last = now
  if (!paused && !busy) {
    acc = Math.min(acc + dt * rate, Math.max(3, rate * 0.05))
    void advance(world, session)
  }
  if (now - tpsSince > 1000) {
    tps = (tpsCount * 1000) / (now - tpsSince)
    tpsCount = 0
    tpsSince = now
  }
  // glide between ticks only when ticks are slow enough to see
  const smooth = !paused && rate <= 10
  renderer.draw(world, smooth ? Math.min(1, acc) : 1)
  const w = world
  stats.update(w, rateLabel(), `${w.backend.name} · ${tps.toFixed(tps < 10 ? 1 : 0)} tick/s achieved · ${w.cap} slots${perfNote ? ' · ' + perfNote : ''}`)
}
requestAnimationFrame(frame)
