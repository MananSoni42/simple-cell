import { makeBackend, canShare } from '../compute/select'
import { census, lifeStats } from '../core/metrics'
import { type Snapshot, restoreSnapshot, snapshotBytes, takeSnapshot } from '../core/snapshot'
import { World } from '../core/world'
import { H, N_FRAMES, allocFrame, layoutOf, writeFrame, type FrameBuffers } from './frames'
import type { FromSim, StatsSnapshot, ToSim } from './protocol'

/**
 * Owns the world and advances it on its own thread, so drawing never slows the
 * simulation. Finished ticks are published as snapshots in a triple buffer: the page
 * always reads a complete, consistent frame and never blocks the simulation.
 */
const post = (m: FromSim) => (self as unknown as Worker).postMessage(m)

let frames: FrameBuffers[] = []
let header = new Int32Array(new SharedArrayBuffer(4 * H.SIZE))
let session = 0
let rate = 1
let paused = false
let stepRequests = 0
let note = ''
let world: World | null = null
let history: Snapshot[] = []
let historyEvery = 1
let rewindTo = -1 // a pending request, applied between ticks

const HISTORY_BUDGET = 256 << 20 // bytes of snapshots we are willing to hold

/**
 * Keeps a ring of past states so the world can be rewound. The interval adapts to the world's
 * size: a small world keeps every tick, a large one keeps fewer, so the memory cost is bounded
 * either way.
 */
function planHistory(w: World): void {
  const per = snapshotBytes(w)
  const slots = Math.max(8, Math.min(600, Math.floor(HISTORY_BUDGET / per)))
  history = []
  historyEvery = Math.max(1, Math.ceil(600 / slots))
  historyCap = slots
}
let historyCap = 60

function remember(w: World): void {
  if (w.tick % historyEvery !== 0) return
  history.push(takeSnapshot(w))
  if (history.length > historyCap) history.shift()
}

const channel = new MessageChannel()
const yieldNow = () =>
  new Promise<void>((resolve) => {
    channel.port2.onmessage = () => resolve()
    channel.port1.postMessage(0)
  })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Rewinds to the newest snapshot at or before `tick`. Returns the world to run from. */
function rewind(w: World, tick: number): World {
  let pick = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].tick <= tick) {
      pick = i
      break
    }
  }
  if (pick < 0) pick = 0
  if (history.length === 0) return w
  const snap = history[pick]
  history.length = pick + 1 // the future we are abandoning is no longer history
  const fresh = restoreSnapshot(w.init, snap, { shared: canShare })
  fresh.backend = w.backend
  return fresh
}

function publish(w: World): void {
  const active = Atomics.load(header, H.ACTIVE)
  const reading = Atomics.load(header, H.READING)
  let idx = 0
  while (idx === active || idx === reading) idx++
  writeFrame(w, frames[idx])
  Atomics.store(header, H.TICK, w.tick)
  Atomics.store(header, H.ACTIVE, idx)
  Atomics.add(header, H.COUNTER, 1)
}

function snapshot(w: World, tps: number, heavy: StatsSnapshot | null): StatsSnapshot {
  return {
    tick: w.tick,
    seed: w.init.seed,
    size: w.init.size,
    foodMode: w.init.foodMode,
    foodMoves: w.init.foodMoves,
    T: w.init.T,
    cap: w.cap,
    backend: w.backend.name,
    tps,
    census: census(w),
    life: heavy ? heavy.life : lifeStats(w),
    aggregates: heavy ? heavy.aggregates : w.aggregates.stats(w),
    clampedPct: w.nSteps > 0 ? (100 * w.nClamped) / w.nSteps : 0,
    historyTicks: history.length * historyEvery,
    oldestTick: history.length ? history[0].tick : w.tick,
    burned: w.burned,
    births: w.nBirths,
    budded: w.nBudded,
    deaths: w.nDeaths,
    recordAge: w.recordAge,
  }
}

async function run(w0: World, mine: number): Promise<void> {
  let w = w0
  let last = performance.now()
  let acc = 0
  let dirty = true
  let lastPublish = 0
  let lastStats = 0
  let lastHeavy = 0
  let heavy: StatsSnapshot | null = null
  let tickCount = 0
  let tpsSince = last
  let tps = 0
  publish(w)
  remember(w)

  while (mine === session) {
    if (rewindTo >= 0) {
      w = rewind(w, rewindTo)
      rewindTo = -1
      world = w
      paused = true
      acc = 0
      publish(w)
      post({ kind: 'stats', stats: snapshot(w, 0, null) })
    }
    const now = performance.now()
    const dt = Math.min(0.25, (now - last) / 1000)
    last = now

    if (stepRequests > 0) {
      stepRequests = 0
      await w.stepAsync()
      remember(w)
      tickCount++
      dirty = true
      lastPublish = 0 // publish immediately
    } else if (!paused) {
      acc = Math.min(acc + dt * rate, Math.max(3, rate * 0.02))
      const deadline = performance.now() + 8
      while (mine === session && acc >= 1 && performance.now() < deadline) {
        await w.stepAsync()
        remember(w)
        acc -= 1
        tickCount++
        dirty = true
      }
    }

    const t = performance.now()
    if (dirty && t - lastPublish >= 12) {
      publish(w)
      dirty = false
      lastPublish = t
    }
    if (t - tpsSince >= 1000) {
      tps = (tickCount * 1000) / (t - tpsSince)
      tickCount = 0
      tpsSince = t
    }
    if (t - lastStats >= 250) {
      const refresh = t - lastHeavy >= 700
      const s = snapshot(w, tps, refresh ? null : heavy)
      if (refresh) {
        heavy = s
        lastHeavy = t
      }
      post({ kind: 'stats', stats: s })
      lastStats = t
    }
    if (!paused && acc >= 1) await yieldNow()
    else await sleep(paused ? 20 : 1)
  }
}

self.onmessage = async (e: MessageEvent<ToSim>) => {
  const m = e.data
  try {
    if (m.kind === 'start') {
      session++
      const w = new World(m.init, { shared: canShare })
      const made = await makeBackend(w, m.perf)
      w.backend = made.backend
      note = made.note
      world = w
      planHistory(w)
      const layout = layoutOf(w)
      frames = Array.from({ length: N_FRAMES }, () => allocFrame(layout))
      header = new Int32Array(new SharedArrayBuffer(4 * H.SIZE))
      header[H.READING] = -1
      rate = 1
      paused = false
      stepRequests = 0
      const mine = session
      // first frame is published inside run(); announce once it exists
      const starting = run(w, mine)
      post({ kind: 'ready', layout, frames, header, note })
      await starting
    } else if (m.kind === 'rewind') {
      rewindTo = Math.max(0, (world?.tick ?? 0) - m.ticks)
    } else if (m.kind === 'seek') {
      rewindTo = Math.max(0, m.tick)
    } else if (m.kind === 'rate') rate = m.rate
    else if (m.kind === 'pause') paused = m.paused
    else if (m.kind === 'step') {
      paused = true
      stepRequests++
    }
  } catch (err) {
    post({ kind: 'error', message: (err as Error).message })
  }
}
