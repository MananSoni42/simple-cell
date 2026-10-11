import './ui/style.css'
import { type Perf, canShare } from './compute/select'
import { observe } from './core/observations'
import type { Init } from './core/params'
import { Renderer, capture } from './render/renderer'
import { H, type FrameBuffers, type FrameLayout, type RenderState, frameState } from './sim/frames'
import type { FromSim, StatsSnapshot, ToSim } from './sim/protocol'
import { explainHTML } from './ui/explain'
import { InspectPanel } from './ui/inspect'
import { mountLanding } from './ui/landing'
import { Router } from './ui/router'
import { mountSetup } from './ui/setup'
import { StatsPanel } from './ui/stats'
import { mountSummary } from './ui/summary'

const MIN_RATE = 0.125
const MAX_RATE = 8192 // above this the simulation outruns its own bookkeeping
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const renderer = new Renderer($<HTMLCanvasElement>('c'), $('stage'))
const stats = new StatsPanel($('stats'))
const inspect = new InspectPanel($('inspect'), (o) => send({ kind: 'placeSaved', organism: o }))
const bPlay = $('b-play')
const bPause = $('b-pause')
const bRate = $('b-rate')
const bSeek = $<HTMLInputElement>('b-seek')

const router = new Router(['landing', 'explain', 'setup', 'world', 'summary'])

/**
 * The page draws and nothing else. The world runs in a worker, publishing finished ticks into
 * three shared frame buffers; this side picks the newest each frame and reads stats off messages.
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
let lastInit: Init | null = null
let cameFrom: 'landing' | 'setup' = 'landing'
let lastPerf: Perf = { threads: 1, gpu: false }
let rate = 1
let paused = false
let seenCounter = -1
let shown: RenderState | null = null
let frameAt = 0
let frameGap = 1000

const send = (m: ToSim): void => link?.worker.postMessage(m)
const l0 = (): Link => link as Link
const rateLabel = (): string => (paused ? 'paused' : `${rate} tick/s`)

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
function rewind(): void {
  send({ kind: 'rewind', ticks: Math.max(1, Math.round(Math.min(rate, 240) * 3)) })
  paused = true
  syncControls()
}

/** Stop ends the run: the worker hands back a report, and the summary screen takes over. */
function stop(): void {
  if (!link) {
    router.go('setup')
    return
  }
  pause()
  send({ kind: 'finish' })
}

function teardown(): void {
  link?.worker.terminate()
  link = null
  latest = null
  shown = null
  inspect.hide()
}

function startWorld(init: Init, perf: Perf): void {
  teardown()
  lastInit = init
  lastPerf = perf
  const worker = new Worker(new URL('./sim/sim.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<FromSim>) => {
    const m = e.data
    if (m.kind === 'ready') {
      link = {
        worker,
        layout: m.layout,
        frames: m.frames,
        states: m.frames.map((f) => frameState(m.layout, f)),
        header: m.header,
        note: m.note,
      }
      shown = null
      seenCounter = -1
      renderer.reset()
      renderer.fit(m.layout.SIZE)
      stats.reset()
      inspect.hide()
      rate = 1
      paused = false
      router.go('world')
      syncControls()
    } else if (m.kind === 'stats') latest = m.stats
    else if (m.kind === 'organism') inspect.show(m.organism)
    else if (m.kind === 'finished') {
      const init2 = lastInit!
      mountSummary(
        $('page-summary'),
        { ...m.report, init: init2, observations: observe(m.report.record, init2) },
        { again: () => startWorld(init2, lastPerf), setup: () => router.go('setup') },
      )
      teardown()
      router.go('summary')
    } else if (m.kind === 'error') console.error('simulation error:', m.message)
  }
  worker.postMessage({ kind: 'start', init, perf } satisfies ToSim)
}

// ---------------------------------------------------------------- screens

mountLanding($('page-landing'), {
  explain: () => {
    cameFrom = 'landing'
    router.go('explain')
  },
  setup: () => router.go('setup'),
})

$('page-explain').innerHTML = explainHTML()
$('page-explain').addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  if (t.closest('#ex-back') || t.closest('#ex-back-2')) router.go(cameFrom)
})

mountSetup($('page-setup'), {
  start: startWorld,
  back: () => router.go('landing'),
  explain: () => {
    cameFrom = 'setup'
    router.go('explain')
  },
})

// ---------------------------------------------------------------- world controls

bPlay.addEventListener('click', play)
bPause.addEventListener('click', pause)
$('b-stop').addEventListener('click', stop)
$('b-rewind').addEventListener('click', rewind)
$('b-fast').addEventListener('click', () => setRate(rate * 2))
$('b-slow').addEventListener('click', () => setRate(rate / 2))
bSeek.addEventListener('input', () => {
  if (!latest) return
  const span = latest.tick - latest.oldestTick
  send({ kind: 'seek', tick: Math.round(latest.oldestTick + (span * Number(bSeek.value)) / 1000) })
  paused = true
  syncControls()
})

/**
 * Pointer: shift-drag (or a non-left button) scatters food where you point, a plain click
 * inspects whatever organism is there, and a plain drag pans the camera.
 */
const canvas = $<HTMLCanvasElement>('c')
let feeding = false
const toWorld = (e: PointerEvent | MouseEvent): [number, number] => renderer.toWorld(e.clientX, e.clientY, l0().layout.SIZE)
canvas.addEventListener('click', (e) => {
  if (e.shiftKey || !link) return
  const [x, y] = toWorld(e)
  renderer.markOrganism(x, y)
  send({ kind: 'inspect', x, y })
})
canvas.addEventListener('pointerdown', (e) => {
  if (!link || (!e.shiftKey && e.button === 0)) return
  e.preventDefault()
  feeding = true
  capture(canvas, e)
  const [x, y] = toWorld(e)
  renderer.flash(x, y)
  send({ kind: 'feed', x, y, n: 3, radius: 14 })
})
canvas.addEventListener('pointermove', (e) => {
  if (!feeding || !link) return
  const [x, y] = toWorld(e)
  renderer.flash(x, y)
  send({ kind: 'feed', x, y, n: 2, radius: 14 })
})
canvas.addEventListener('pointerup', () => (feeding = false))
canvas.addEventListener('contextmenu', (e) => e.preventDefault())

addEventListener('keydown', (e) => {
  const page = router.page
  if (page === 'explain' && (e.key === 'Escape' || e.key === 'Enter')) {
    e.preventDefault()
    router.go(cameFrom)
    return
  }
  if (page !== 'world' || !link) return
  if (e.key === 'Escape') {
    if (inspect.open) inspect.hide()
    else stop()
  } else if (e.key === ' ') {
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

// ---------------------------------------------------------------- frame loop

/** Mark the newest published buffer as being read, so the worker will not overwrite it. */
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
  if (!l || router.page !== 'world') return

  if (Atomics.load(l.header, H.COUNTER) !== seenCounter) {
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
  renderer.draw(shown, smooth ? Math.min(1, (now - frameAt) / frameGap) : 1, now)
  if (latest) {
    stats.update(
      latest,
      rateLabel(),
      `${latest.backend} · ${latest.tps.toFixed(latest.tps < 10 ? 1 : 0)} tick/s · ${latest.historyTicks}t history${l.note ? ' · ' + l.note : ''}`,
    )
    if (document.activeElement !== bSeek) bSeek.value = '1000'
  }
}
requestAnimationFrame(frame)

if (!canShare) console.info('not cross-origin isolated: threads are unavailable, the simulation runs on one')
router.go('landing')
