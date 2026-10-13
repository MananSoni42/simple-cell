import { makeBackend, canShare } from '../compute/select'
import { ladder } from '../core/ladder'
import { census, lifeStats } from '../core/metrics'
import { type Snapshot, allocSnapshot, restoreSnapshot, snapshotBytes, takeSnapshot, writeSnapshot } from '../core/snapshot'
import { type OrganismFile, defaultName, exportOrganism } from '../core/organism'
import type { Init } from '../core/params'
import { Recorder } from '../core/recorder'
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
let historyEvery = 1
let rewindTo = -1 // a pending request, applied between ticks
let undoWanted = false // likewise: a world is replaced, so it cannot happen mid-tick
let recorder = new Recorder()

const HISTORY_BUDGET = 192 << 20 // bytes of snapshots we are willing to hold
const HISTORY_HZ = 20 // snapshots per second of wall clock, however fast the world runs

/**
 * A ring of past states so the world can be rewound. Two things keep it affordable:
 * the buffers are allocated once and overwritten in place, and the sampling interval is
 * recomputed from the *tick rate*, so a world running at thousands of ticks a second takes
 * no more snapshots per second than a slow one.
 */
let ring: Snapshot[] = []
let ringPos = 0
let ringLen = 0

function planHistory(w: World): void {
  const per = snapshotBytes(w)
  const slots = Math.max(8, Math.min(240, Math.floor(HISTORY_BUDGET / per)))
  ring = Array.from({ length: slots }, () => allocSnapshot(w))
  ringPos = 0
  ringLen = 0
  historyEvery = 1
}

/** Oldest-to-newest view of the ring. */
function snapshots(): Snapshot[] {
  const out: Snapshot[] = []
  for (let i = 0; i < ringLen; i++) out.push(ring[(ringPos - ringLen + i + ring.length) % ring.length])
  return out
}

function remember(w: World): void {
  if (ring.length === 0 || w.tick % historyEvery !== 0) return
  writeSnapshot(w, ring[ringPos])
  ringPos = (ringPos + 1) % ring.length
  ringLen = Math.min(ringLen + 1, ring.length)
}

/** Sample often enough to be useful, seldom enough to stay cheap. */
function retune(): void {
  historyEvery = Math.max(1, Math.round((paused ? 1 : rate) / HISTORY_HZ))
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
  const held = snapshots()
  if (held.length === 0) return w
  let pick = 0
  for (let i = held.length - 1; i >= 0; i--) {
    if (held[i].tick <= tick) {
      pick = i
      break
    }
  }
  const snap = held[pick]
  const fresh = restoreSnapshot(w.init, snap, { shared: canShare })
  // the future we are abandoning stops being history
  ringLen = pick + 1
  ringPos = (ringPos - (held.length - 1 - pick) + ring.length) % ring.length
  fresh.backend = w.backend
  return fresh
}

/**
 * Undo for hand-placed things, kept separately from the rewind ring.
 *
 * Rewind is indexed by tick, and everything placed in a paused world happens at the *same* tick,
 * so the ring cannot tell those edits apart. This stack remembers the world immediately before
 * each stroke instead. It is bounded by bytes rather than by count, because a snapshot of a large
 * world is megabytes and a dozen of them would be worse than having no undo at all.
 */
let edits: Snapshot[] = []
let editBudget = 2

function planEdits(w: World): void {
  edits = []
  editBudget = Math.max(2, Math.min(16, Math.floor((24 << 20) / snapshotBytes(w))))
}

function markEdit(w: World): void {
  if (edits.length >= editBudget) edits.shift()
  edits.push(takeSnapshot(w))
  post({ kind: 'undoDepth', depth: edits.length })
}

function undoEdit(w: World): World {
  const snap = edits.pop()
  post({ kind: 'undoDepth', depth: edits.length })
  if (!snap) return w
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

/** Everything the summary screen needs: the record, who survived, and a small hall of fame. */
function report(w: World): { record: ReturnType<Recorder['finish']>; organisms: OrganismFile[]; notable: { label: string; organism: OrganismFile }[] } {
  const organisms: OrganismFile[] = []
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.alive[b] || !w.isBrain(b)) continue
    const o = exportOrganism(w, b)
    if (o) organisms.push(o)
  }

  // The top three are picked by three *unrelated* measures rather than one score, so a library
  // accumulates different kinds of success instead of three near-copies of the same winner.
  const best = (label: string, score: (o: OrganismFile) => number): { label: string; organism: OrganismFile } | null => {
    let pick: OrganismFile | null = null
    let top = 0
    for (const o of organisms) {
      const v = score(o)
      if (v > top) {
        top = v
        pick = o
      }
    }
    return pick ? { label, organism: { ...pick, name: pick.name ?? defaultName(pick, label.split(' ')[0]) } } : null
  }
  const notable: { label: string; organism: OrganismFile }[] = []
  const seen = new Set<OrganismFile['wBrain']>()
  for (const cand of [
    best('oldest', (o) => o.age),
    best('most children', (o) => o.children),
    best('most time joined', (o) => o.fitness?.orderTicks ?? 0),
  ]) {
    if (!cand || seen.has(cand.organism.wBrain)) continue
    seen.add(cand.organism.wBrain)
    notable.push(cand)
  }
  return { record: recorder.finish(w), organisms, notable }
}

/**
 * The world as a config: whatever is in it right now, recorded so a built world can be saved,
 * shared and reopened. Placements replace the random counts that produced them, so reloading
 * gives back the arrangement rather than a fresh roll of the dice.
 */
function builtConfig(w: World): Init {
  const organisms = []
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.alive[b] || !w.isBrain(b)) continue
    const o = exportOrganism(w, b)
    if (o) organisms.push({ organism: o as unknown, x: w.x[b], y: w.y[b] })
  }
  const food: [number, number][] = []
  for (let f = w.foodStart; f < w.cap; f++) if (w.alive[f]) food.push([w.x[f], w.y[f]])
  return {
    ...w.init,
    n_start: 0,
    n_food0: 0,
    wallPositions: w.wallPositionsNow(),
    seededFood: food,
    seededOrganisms: organisms,
  }
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
    bondCount: w.bonds.count,
    orders: heavy ? heavy.orders : w.orders.stats(w),
    clampedPct: w.nSteps > 0 ? (100 * w.nClamped) / w.nSteps : 0,
    lightWasted: w.lightWasted,
    conjugated: w.nConjugated,
    sown: w.nSown,
    germinated: w.nGerminated,
    repBlocked: { ...w.repBlocked },
    historyTicks: ringLen > 0 ? w.tick - snapshots()[0].tick : 0,
    oldestTick: ringLen > 0 ? snapshots()[0].tick : w.tick,
    burned: w.burned,
    births: w.nBirths,
    budded: w.nBudded,
    deaths: w.nDeaths,
    recordAge: w.recordAge,
    // sent whether or not anything is learning: "nothing is" is the thing the rail has to say
    learner: w.learner.status(),
    ladder: ladder(w),
    learnAlgo: w.init.learn.algo,
    fitnessChanges: w.fitnessChanges.slice(-8),
    islandNames: w.init.islandNames,
    mergeProgress: w.mergeProgress(),
    canMerge: w.init.foodMode === 'converging' || w.init.foodMode === 'breathing',
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
  recorder.observe(w)

  while (mine === session) {
    if (undoWanted) {
      undoWanted = false
      w = undoEdit(w)
      world = w
      paused = true
      acc = 0
      publish(w)
      post({ kind: 'stats', stats: snapshot(w, 0, null) })
    }
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
      recorder.observe(w)
      tickCount++
      dirty = true
      lastPublish = 0 // publish immediately
    } else if (!paused) {
      acc = Math.min(acc + dt * rate, Math.max(3, rate * 0.02))
      const deadline = performance.now() + 8
      while (mine === session && acc >= 1 && performance.now() < deadline) {
        await w.stepAsync()
        remember(w)
        recorder.observe(w)
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
      planEdits(w)
      recorder = new Recorder()
      retune()
      const layout = layoutOf(w)
      frames = Array.from({ length: N_FRAMES }, () => allocFrame(layout))
      header = new Int32Array(new SharedArrayBuffer(4 * H.SIZE))
      header[H.READING] = -1
      rate = 1
      paused = true // a new world waits, so it can be built before it runs
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
    } else if (m.kind === 'feed') {
      const w = world
      if (w) {
        for (let k = 0; k < m.n; k++) w.feedAt(m.x, m.y, m.radius)
        publish(w)
      }
    } else if (m.kind === 'finish') {
      const w = world
      if (w) post({ kind: 'finished', report: report(w) })
    } else if (m.kind === 'inspect') {
      const w = world
      if (w) {
        const b = w.pickOrganism(m.x, m.y)
        post({ kind: 'organism', organism: b >= 0 ? exportOrganism(w, b) : null })
      }
    } else if (m.kind === 'placeSaved') {
      const w = world
      if (w) {
        w.placeSaved(m.organism, m.at)
        publish(w)
      }
    } else if (m.kind === 'placeRandom') {
      const w = world
      if (w) {
        w.spawnRandom([m.x, m.y])
        publish(w)
      }
    } else if (m.kind === 'wall') {
      const w = world
      if (w) {
        w.addWall(m.x, m.y)
        publish(w)
      }
    } else if (m.kind === 'erase') {
      const w = world
      if (w) {
        w.eraseAt(m.x, m.y, m.radius)
        publish(w)
      }
    } else if (m.kind === 'snapshotConfig') {
      const w = world
      if (w) post({ kind: 'builtConfig', init: builtConfig(w) })
    } else if (m.kind === 'rate') {
      rate = m.rate
      retune()
    } else if (m.kind === 'pause') {
      paused = m.paused
      retune()
    }
    else if (m.kind === 'mark') {
      const w = world
      if (w) markEdit(w)
    } else if (m.kind === 'undo') {
      undoWanted = true
    } else if (m.kind === 'setFitness') {
      const w = world
      if (w) {
        w.retargetFitness(m.spec)
        post({ kind: 'stats', stats: snapshot(w, 0, null) })
      }
    } else if (m.kind === 'merge') {
      const w = world
      if (w) {
        w.beginMerge()
        publish(w)
        post({ kind: 'stats', stats: snapshot(w, 0, null) })
      }
    } else if (m.kind === 'setLearner') {
      const w = world
      if (w) {
        w.setLearner(m.algo)
        post({ kind: 'stats', stats: snapshot(w, 0, null) })
      }
    }
    else if (m.kind === 'step') {
      paused = true
      stepRequests++
    }
  } catch (err) {
    post({ kind: 'error', message: (err as Error).message })
  }
}
