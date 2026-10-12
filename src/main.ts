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
import { type OrganismFile, checkCompatibility, parseOrganism } from './core/organism'
import { download } from './ui/config'

const MIN_RATE = 0.125
/**
 * The rate control is a *request*, not a promise: what you get is 1000 / (ms per tick), and no
 * setting can raise that. The cap sits just above what the smallest sensible world can deliver —
 * measured at 32,000 ticks/s for a 48-particle world with bonds and reproduction off, and 13,700
 * for a default one (`npm run ceiling`). Asking for more than the world can give is harmless; the
 * rail reports the rate actually achieved beside the one requested.
 */
const MAX_RATE = 32768
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const renderer = new Renderer($<HTMLCanvasElement>('c'), $('stage'))
const stats = new StatsPanel($('stats'))
const inspect = new InspectPanel($('inspect'), (o) => send({ kind: 'placeSaved', organism: o }))
inspect.learningHooks({
  setFitness: (spec) => send({ kind: 'setFitness', spec }),
  setLearner: (algo) => send({ kind: 'setLearner', algo }),
})
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
 * Whether the next world opens as a builder. The quick path through setup has no settings and no
 * placing, so it would be strange for it to arrive stopped; a world opened to be built must wait.
 */
let openPaused = true

/**
 * The world screen is also the builder: a new world arrives paused, with these tools available.
 * Building and running are the same screen, so there is nothing to compile and no preview that
 * could disagree with the real thing.
 */
type Tool = 'pan' | 'organism' | 'food' | 'wall' | 'erase'
let tool: Tool = 'pan'
/** The organism the palette has armed, if any; otherwise a random one is placed. */
let armed: OrganismFile | null = null
let armedId: string | null = null

function arm(o: OrganismFile | null, id: string | null = null): void {
  armed = o
  armedId = id
  const chip = $('armed')
  chip.hidden = !o
  chip.textContent = o ? `armed: ${o.name ?? 'organism'}` : ''
}

/**
 * The right rail doubles as the place to pick an organism from, so building never means leaving
 * the world. Whatever is being inspected wins: looking inside a creature is the more specific act.
 */
async function showPalette(): Promise<void> {
  if (tool !== 'organism' || inspect.open) return
  const kept = await collection.organisms()
  if (tool !== 'organism' || inspect.open) return
  const items = kept
    .filter((o) => checkCompatibility(o.organism).ok)
    .slice(0, 24)
    .map((o) => ({ id: o.id, name: o.name, organism: o.organism }))
  inspect.palette(items, armedId, (id) => {
    const found = id ? kept.find((o) => o.id === id) : null
    if (!found) {
      arm(null)
    } else {
      try {
        arm(parseOrganism(JSON.stringify(found.organism)), found.id)
      } catch {
        arm(null)
      }
    }
    void showPalette()
  })
}

const HELP: Record<Tool, string> = {
  pan: 'drag to pan · wheel to zoom · click an organism to inspect · shift-drag to feed',
  organism: 'pick one from the rail, then click in the world · cmd-Z takes it back',
  food: 'click or drag to drop food',
  wall: 'click or drag to paint terrain, which never moves · cmd-Z takes back a stroke',
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
  if (tool === 'pan') renderer.hover(null)
  helpEl.textContent = HELP[tool]
}

function setTool(t: Tool): void {
  tool = t
  syncControls()
  if (t === 'organism') void showPalette()
  else if (!inspect.open) inspect.hide()
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

function startWorld(init: Init, perf: Perf, build = true): void {
  openPaused = build
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
      // a built world waits so things can be placed in it; a world nobody configured just runs
      rate = resumeRate ?? (openPaused ? 1 : 8)
      resumeRate = null
      paused = openPaused
      setTool('pan')
      send({ kind: 'rate', rate })
      // the worker always starts a world paused, so the running case has to say so out loud
      send({ kind: 'pause', paused })
      router.go('world')
      syncControls()
    } else if (m.kind === 'stats') {
      latest = m.stats
      // the idle rail is the learning panel, so it follows the stats rather than a click
      if (!inspect.open && tool !== 'organism') inspect.learning(m.stats.learner, m.stats.learnAlgo, m.stats.fitnessChanges)
    }
    else if (m.kind === 'undoDepth') bUndo.disabled = m.depth === 0
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
          again: () => startWorld(init2, lastPerf, false),
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

const setup = mountSetup($('page-setup'), {
  start: (init, perf, opts) => {
    resumeRate = null // a world built by hand starts at a watchable speed
    startWorld(init, perf, opts.build)
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
    startWorld(init, lastPerf, false)
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
  // the picker's preview is a real world being stepped; it must not keep running off-screen
  if (page === 'setup') setup.refresh()
  else setup.stop()
}
void collection.init()

// ---------------------------------------------------------------- world controls

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tool]'))) {
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool))
}
$('t-save').addEventListener('click', () => send({ kind: 'snapshotConfig' }))
const bUndo = $<HTMLButtonElement>('t-undo')
bUndo.addEventListener('click', () => send({ kind: 'undo' }))

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
  // one restore point per stroke: dragging a wall into place is one thing done, so it is one undo
  send({ kind: 'mark' })
  apply(e, true)
})
canvas.addEventListener('pointermove', (e) => {
  if (painting) apply(e, false)
  if (!link) return
  // painting blind is the main thing that made the builder feel like guesswork
  if (tool === 'pan' && !e.shiftKey) renderer.hover(null)
  else {
    const [x, y] = toWorld(e)
    renderer.hover({ x, y, r: tool === 'organism' ? 9 : brush(), kind: tool === 'erase' ? 'erase' : 'add' })
  }
})
canvas.addEventListener('pointerleave', () => renderer.hover(null))
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
    if (inspect.open) {
      inspect.hide()
      if (tool === 'organism') void showPalette()
    } else stop()
  } else if (e.key === ' ') {
    e.preventDefault()
    paused ? play() : pause()
  } else if (e.key === 'ArrowRight') setRate(rate * 2)
  else if (e.key === 'ArrowLeft') setRate(rate / 2)
  else if (e.key === 'Backspace' || e.key === 'j' || e.key === 'J') {
    e.preventDefault()
    rewind()
  } else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    send({ kind: 'undo' })
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
