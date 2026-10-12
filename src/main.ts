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
import { mountLibrary } from './ui/library'
import { mountSetup } from './ui/setup'
import { collection } from './ui/store'
import { StatsPanel } from './ui/stats'
import { mountSummary } from './ui/summary'
import type { OrganismFile } from './core/organism'
import { download } from './ui/config'

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
const stage = $('stage')
const brushEl = $<HTMLInputElement>('brush')
const helpEl = $('help')

const router = new Router(['landing', 'explain', 'setup', 'world', 'summary', 'library'])

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
/** Speed to resume at when a run is restarted, so 'run it again' does not look frozen. */
let resumeRate: number | null = null

/**
 * The world screen is also the builder: a new world arrives paused, with these tools available.
 * Building and running are the same screen, so there is nothing to compile and no preview that
 * could disagree with the real thing.
 */
type Tool = 'pan' | 'organism' | 'food' | 'wall' | 'erase'
let tool: Tool = 'pan'
/** The organism the palette has armed, if any; otherwise a random one is placed. */
let armed: OrganismFile | null = null

function arm(o: OrganismFile | null): void {
  armed = o
  const chip = $('armed')
  chip.hidden = !o
  chip.textContent = o ? `armed: ${o.name ?? 'organism'}` : ''
}

const HELP: Record<Tool, string> = {
  pan: 'drag to pan · wheel to zoom · click an organism to inspect · shift-drag to feed',
  organism: 'click to place an organism · nothing armed means a random one',
  food: 'click or drag to drop food',
  wall: 'click or drag to paint terrain, which never moves',
  erase: 'click or drag to remove food, terrain and organisms',
}

const send = (m: ToSim): void => link?.worker.postMessage(m)
const l0 = (): Link => link as Link
const rateLabel = (): string => (paused ? 'paused' : `${rate} tick/s`)

function syncControls(): void {
  bPlay.classList.toggle('on', !paused)
  bPause.classList.toggle('on', paused)
  bRate.textContent = `${rate} tick/s`
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-tool]'))) {
    b.classList.toggle('on', b.dataset.tool === tool)
  }
  stage.classList.toggle('editing', tool !== 'pan')
  helpEl.textContent = HELP[tool]
}

function setTool(t: Tool): void {
  tool = t
  syncControls()
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
  resumeRate = rate
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
      // keep the speed the run was using; starting a fast world back at 1 tick/s reads as broken
      rate = resumeRate ?? 1
      resumeRate = null
      paused = true // it arrives waiting, so it can be built before it runs
      setTool('pan')
      send({ kind: 'rate', rate })
      router.go('world')
      syncControls()
    } else if (m.kind === 'stats') latest = m.stats
    else if (m.kind === 'organism') inspect.show(m.organism)
    else if (m.kind === 'builtConfig') {
      download(`simplecell-world-${m.init.seed}.json`, JSON.stringify({ version: 1, init: m.init }, null, 2))
    }
    else if (m.kind === 'finished') {
      const init2 = lastInit!
      mountSummary(
        $('page-summary'),
        { ...m.report, init: init2, observations: observe(m.report.record, init2) },
        {
          again: () => startWorld(init2, lastPerf),
          setup: () => router.go('setup'),
          library: () => router.go('library'),
        },
      )
      teardown()
      router.go('summary')
    } else if (m.kind === 'error') console.error('simulation error:', m.message)
  }
  worker.postMessage({ kind: 'start', init, perf } satisfies ToSim)
}

// ---------------------------------------------------------------- screens

mountLanding($('page-landing'), {
  library: () => router.go('library'),
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
  start: (init, perf) => {
    resumeRate = null // a world built by hand starts at a watchable speed
    startWorld(init, perf)
  },
  back: () => router.go('landing'),
  library: () => router.go('library'),
  explain: () => {
    cameFrom = 'setup'
    router.go('explain')
  },
})

const library = mountLibrary($('page-library'), {
  replay: (init) => {
    resumeRate = null
    startWorld(init, lastPerf)
  },
  arm: (o) => {
    arm(o)
    setTool('organism')
    router.go(link ? 'world' : 'setup')
  },
  back: () => router.go(lastInit ? 'setup' : 'landing'),
})
router.onEnter = (page) => {
  if (page === 'library') void library.refresh()
}
void collection.init()

// ---------------------------------------------------------------- world controls

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tool]'))) {
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool))
}
$('t-save').addEventListener('click', () => send({ kind: 'snapshotConfig' }))

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
let painting = false
const toWorld = (e: PointerEvent | MouseEvent): [number, number] => renderer.toWorld(e.clientX, e.clientY, l0().layout.SIZE)
const brush = (): number => Number(brushEl.value) || 16

/** One stroke of whichever tool is selected. Shift always feeds, whatever the tool. */
function apply(e: PointerEvent, first: boolean): void {
  if (!link) return
  const [x, y] = toWorld(e)
  const feed = e.shiftKey || tool === 'food'
  if (feed) {
    renderer.flash(x, y)
    send({ kind: 'feed', x, y, n: first ? 3 : 2, radius: brush() })
    return
  }
  if (tool === 'wall') send({ kind: 'wall', x, y })
  else if (tool === 'erase') send({ kind: 'erase', x, y, radius: brush() })
  else if (tool === 'organism' && first) {
    renderer.flash(x, y)
    if (armed) send({ kind: 'placeSaved', organism: armed, at: [x, y] })
    else send({ kind: 'placeRandom', x, y })
  }
}

canvas.addEventListener('click', (e) => {
  // in Look mode a plain click inspects; every other tool is handled on pointerdown
  if (e.shiftKey || !link || tool !== 'pan') return
  const [x, y] = toWorld(e)
  renderer.markOrganism(x, y)
  send({ kind: 'inspect', x, y })
})
canvas.addEventListener('pointerdown', (e) => {
  if (!link) return
  const editing = tool !== 'pan' || e.shiftKey || e.button !== 0
  if (!editing) return
  e.preventDefault()
  painting = true
  capture(canvas, e)
  apply(e, true)
})
canvas.addEventListener('pointermove', (e) => {
  if (painting) apply(e, false)
})
canvas.addEventListener('pointerup', () => (painting = false))
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
  } else if (e.key === 'v' || e.key === 'V') setTool('pan')
  else if (e.key === '1') setTool('organism')
  else if (e.key === '2') setTool('food')
  else if (e.key === '3') setTool('wall')
  else if (e.key === '4') setTool('erase')
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
