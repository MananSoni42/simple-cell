import type { Perf } from './compute/select'
import type { Init } from './core/params'
import { Renderer } from './render/renderer'
import { H, type FrameBuffers, type FrameLayout, type RenderState, frameState } from './sim/frames'
import type { FromSim, StatsSnapshot, ToSim } from './sim/protocol'
import { explainHTML } from './ui/explain'
import { mountStart } from './ui/start'
import { StatsPanel } from './ui/stats'

const MIN_RATE = 0.125
const MAX_RATE = 8192 // above this the simulation outruns its own bookkeeping
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const startEl = $('start')
const explainEl = $('explain')
const worldEl = $('world')
const renderer = new Renderer($<HTMLCanvasElement>('c'))
const stats = new StatsPanel($('stats'))
const bPlay = $('b-play')
const bPause = $('b-pause')
const bRate = $('b-rate')
const bSeek = $<HTMLInputElement>('b-seek')

/**
 * The page only draws. The world runs in a worker (sim/sim.worker.ts) and publishes
 * snapshots into three shared frame buffers; this side picks the newest one each frame.
 */
interface Link {
  worker: Worker
  layout: FrameLayout
  frames: FrameBuffers[]
  states: RenderState[]
  header: Int32Array
  note: string
}

let link: Link | null = null
let latest: StatsSnapshot | null = null
let rate = 1 // requested ticks per second
let paused = false
let seenCounter = -1
let shown: RenderState | null = null
let frameAt = 0
let frameGap = 1000

const send = (m: ToSim) => link?.worker.postMessage(m)
const rateLabel = () => (paused ? 'paused' : `${rate} tick/s`)

function syncControls(): void {
  bPlay.classList.toggle('on', !paused)
  bPause.classList.toggle('on', paused)
  bRate.textContent = `${rate} tick/s`
}
function play(): void {
  paused = false
  send({ kind: 'pause', paused: false })
  syncControls()
}
function pause(): void {
  paused = true
  send({ kind: 'pause', paused: true })
  syncControls()
}
function setRate(r: number): void {
  rate = Math.min(MAX_RATE, Math.max(MIN_RATE, r))
  send({ kind: 'rate', rate })
  syncControls()
}
/** Rewind by a visible amount: a few seconds of world time at the current rate. */
function rewind(): void {
  const ticks = Math.max(1, Math.round(Math.min(rate, 240) * 3))
  send({ kind: 'rewind', ticks })
  paused = true
  syncControls()
}

function stop(): void {
  link?.worker.terminate() // also ends its force workers
  link = null
  latest = null
  shown = null
  worldEl.hidden = true
  start.show()
}

function showExplain(): void {
  if (!explainEl.innerHTML) explainEl.innerHTML = explainHTML()
  explainEl.hidden = false
  startEl.hidden = true
}

function hideExplain(): void {
  explainEl.hidden = true
  startEl.hidden = false
}

addEventListener('keydown', (e) => {
  if (explainEl.hidden) return
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault()
    hideExplain()
  }
})

const start = mountStart(startEl, (init: Init, perf: Perf) => {
  link?.worker.terminate()
  const worker = new Worker(new URL('./sim/sim.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<FromSim>) => {
    const m = e.data
    if (m.kind === 'ready') {
      link = { worker, layout: m.layout, frames: m.frames, states: m.frames.map((f) => frameState(m.layout, f)), header: m.header, note: m.note }
      shown = null
      seenCounter = -1
      renderer.reset()
      stats.reset()
      rate = 1
      paused = false
      start.hide()
      worldEl.hidden = false
      syncControls()
    } else if (m.kind === 'stats') latest = m.stats
    else console.error('simulation error:', m.message)
  }
  worker.postMessage({ kind: 'start', init, perf } satisfies ToSim)
}, showExplain)

bPlay.addEventListener('click', play)
bPause.addEventListener('click', pause)
$('b-stop').addEventListener('click', stop)
$('b-rewind').addEventListener('click', rewind)
bSeek.addEventListener('input', () => {
  if (!latest) return
  const span = latest.tick - latest.oldestTick
  send({ kind: 'seek', tick: Math.round(latest.oldestTick + (span * Number(bSeek.value)) / 1000) })
  paused = true
  syncControls()
})
$('b-fast').addEventListener('click', () => setRate(rate * 2))
$('b-slow').addEventListener('click', () => setRate(rate / 2))

addEventListener('keydown', (e) => {
  if (!link) return
  if (e.key === 'Escape') stop()
  else if (e.key === ' ') {
    e.preventDefault()
    paused ? play() : pause()
  } else if (e.key === 'ArrowRight') setRate(rate * 2)
  else if (e.key === 'ArrowLeft') setRate(rate / 2)
  else if (e.key === 'Backspace' || e.key === 'j' || e.key === 'J') {
    e.preventDefault()
    rewind()
  } else if (e.key === '.') {
    paused = true
    syncControls()
    send({ kind: 'step' })
  }
})

/** Mark the newest published buffer as "being read" so the simulation will not overwrite it. */
function acquire(l: Link): number {
  for (;;) {
    const a = Atomics.load(l.header, H.ACTIVE)
    Atomics.store(l.header, H.READING, a)
    if (Atomics.load(l.header, H.ACTIVE) === a) return a
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame)
  const l = link
  if (!l) return

  if (Atomics.load(l.header, H.COUNTER) !== seenCounter) {
    // remember the frame we are leaving (still protected as "being read") for gliding between ticks
    if (shown) renderer.snapshot(shown)
    const a = acquire(l)
    shown = l.states[a]
    seenCounter = Atomics.load(l.header, H.COUNTER)
    const gap = now - frameAt
    if (frameAt > 0 && gap < 2000) frameGap = frameGap * 0.7 + gap * 0.3
    frameAt = now
  }
  if (!shown) return

  // glide between ticks only when ticks are slow enough to see
  const smooth = !paused && rate <= 10
  renderer.draw(shown, smooth ? Math.min(1, (now - frameAt) / frameGap) : 1)
  if (latest) {
    stats.update(latest, rateLabel(), `${latest.backend} · ${latest.tps.toFixed(latest.tps < 10 ? 1 : 0)} tick/s achieved · ${latest.cap} slots · ${latest.historyTicks}t history${l.note ? ' · ' + l.note : ''}`)
    if (document.activeElement !== bSeek) bSeek.value = '1000'
  }
}
requestAnimationFrame(frame)
