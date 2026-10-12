import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG_VERSION, type CatalogEntry, type WorldSpec, best, parseCatalog, rank, specId } from '../src/core/catalog'
import type { EvalOptions } from '../src/core/evaluate'
import { mix } from '../src/core/sample'
import { report, summarise } from '../src/core/analyse'
import { Rng } from '../src/core/rng'

/**
 * The search: phases of increasing cost over candidates of increasing promise.
 *
 * usage:
 *   npm run search -- [--phase 0|1|2|3|4] [--workers 12] [--dir search] [--budget 200000]
 *   npm run search -- --report            # read the catalog back, no simulation
 *
 * Each phase reads the catalog, decides what to run, shards the work across processes, and appends
 * results. Nothing is held in memory between phases and nothing is recomputed: a phase that has
 * already scored a world skips it, so the whole thing is resumable after a crash, a closed laptop,
 * or a deliberate stop.
 *
 * **Twelve workers, not fourteen.** Measured on this machine: throughput peaks at twelve (3.62
 * worlds a second) and *falls* at fourteen, because the four efficiency cores cost more in memory
 * contention than they contribute. Effective speedup is 8x rather than 12x.
 */

const args = process.argv.slice(2)
const flag = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const has = (n: string): boolean => args.includes(`--${n}`)

const DIR = flag('dir', 'search')
const WORKERS = Number(flag('workers', '12'))

/**
 * The phases.
 *
 * World size escalates with run length because cost is superlinear in density: 0.28 ms a tick at
 * 245 live particles against 4.24 at 916. Screening at the full size would cost forty hours.
 *
 * `kills` is what a phase is *allowed* to conclude. Phase 0 runs four tenths of a generation,
 * which is enough to judge that a world is impossible and nothing more — so it may only discard
 * worlds that cannot bond, cannot survive, or are numerically broken, and may not rank. Ranking on
 * half a generation would throw away slow starters, which is exactly what we are looking for.
 */
interface Phase {
  n: number
  name: string
  shape: { slots: number; matter: number; scale: number }
  opts: EvalOptions
  seeds: number
  /** How many candidates to run. Phase 0 draws fresh; later phases take the best of the previous. */
  budget: number
  /** How many to promote. */
  keep: number
  kills: 'impossible-only' | 'rank'
}

const PHASES: Phase[] = [
  {
    n: 0,
    name: 'sanity',
    shape: { slots: 24, matter: 120, scale: 1 },
    opts: { ticks: 500, maxExtend: 1, plateauFrac: 0, every: 100 },
    seeds: 1,
    budget: Number(flag('budget', '200000')),
    keep: 60000,
    kills: 'impossible-only',
  },
  {
    n: 1,
    name: 'screen',
    shape: { slots: 60, matter: 300, scale: 1 },
    opts: { ticks: 2000, maxExtend: 1.5, plateauFrac: 0.4, every: 200 },
    seeds: 1,
    budget: 60000,
    keep: 600,
    kills: 'rank',
  },
  {
    n: 2,
    name: 'rank',
    shape: { slots: 150, matter: 700, scale: 1 },
    opts: { ticks: 20000, maxExtend: 1.5, plateauFrac: 0.3, every: 500 },
    seeds: 2,
    budget: 600,
    keep: 40,
    kills: 'rank',
  },
  {
    n: 3,
    name: 'confirm',
    shape: { slots: 150, matter: 700, scale: 1 },
    opts: { ticks: 100000, maxExtend: 1.5, plateauFrac: 0.25, every: 1000 },
    seeds: 5,
    budget: 40,
    keep: 10,
    kills: 'rank',
  },
  {
    n: 4,
    name: 'deep',
    shape: { slots: 150, matter: 700, scale: 1 },
    opts: { ticks: 1000000, maxExtend: 1.2, plateauFrac: 0.2, every: 5000 },
    seeds: 3,
    budget: 5,
    keep: 5,
    kills: 'rank',
  },
]

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
const shardPath = (phase: number, k: number): string => join(DIR, `phase${phase}-${k}.jsonl`)
const headerPath = join(DIR, 'catalog.meta.json')
if (!existsSync(headerPath)) {
  writeFileSync(
    headerPath,
    JSON.stringify({ kind: 'simplecell-catalog', version: CATALOG_VERSION, startedAt: Date.now(), note: 'chemistry and world search' }, null, 2) + '\n',
  )
}

/** Everything catalogued so far, across every shard of every phase. */
function readCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.jsonl')) continue
    out.push(...parseCatalog(readFileSync(join(DIR, f), 'utf8')).entries)
  }
  return out
}

/** A world is impossible if it cannot bond, cannot stay alive, or is numerically broken. */
function possible(e: CatalogEntry): boolean {
  if (e.level < 0) return false // nothing was ever alive for a whole window
  if (e.stats.bonds === 0 && e.stats.bestOrder === 0) return false // the chemistry cannot hold
  if (e.stats.clampPct > 60) return false // the integrator is fighting it the whole way
  return true
}

function runPhase(phase: Phase): void {
  const cat = readCatalog()
  const done = new Set(cat.filter((e) => e.phase === phase.n).map((e) => e.id))
  let specs: WorldSpec[] = []
  const sources = new Map<string, CatalogEntry['source']>()

  if (phase.n === 0) {
    // fresh draws, skipping anything already catalogued at this phase
    const rng = new Rng(0x5eed ^ (cat.length * 2654435761))
    let guard = 0
    while (specs.length < phase.budget && guard < phase.budget * 4) {
      guard++
      const { spec, source } = mix(rng, phase.shape, [])
      const id = specId(spec)
      if (done.has(id) || sources.has(id)) continue
      sources.set(id, source)
      specs.push(spec)
    }
  } else {
    const prev = PHASES[phase.n - 1]
    const pool = best(cat).filter((e) => e.phase === prev.n)
    const survivors = prev.kills === 'impossible-only' ? pool.filter(possible) : pool
    const ranked = rank(survivors)
    // the cutoff, plus a random rescue from below it: a short run is a noisy ranker, and the
    // rescue both insures against that and measures how leaky the screen was
    const cut = ranked.slice(0, prev.keep)
    const rest = ranked.slice(prev.keep)
    const rescueN = Math.min(rest.length, Math.max(0, Math.round(prev.keep * 0.02)))
    const rng = new Rng(0xbeef ^ phase.n)
    const rescued: CatalogEntry[] = []
    for (let k = 0; k < rescueN; k++) rescued.push(rest[rng.int(rest.length)])
    specs = [...cut, ...rescued]
      .slice(0, phase.budget)
      .map((e) => ({ ...e.spec, ...phase.shape }))
      .filter((s) => !done.has(specId(s)))
    for (const s of specs) sources.set(specId(s), 'promoted')
    console.log(
      `phase ${phase.n}: ${pool.length} from phase ${prev.n}, ${survivors.length} possible, ` +
        `taking ${cut.length} ranked + ${rescueN} rescued, ${specs.length} still to run`,
    )
  }

  if (specs.length === 0) {
    console.log(`phase ${phase.n} (${phase.name}): nothing to do`)
    return
  }

  const perWorker = Math.ceil(specs.length / WORKERS)
  const est = (specs.length * phase.opts.ticks * phase.seeds * estMsPerTick(phase)) / 1000 / 8
  console.log(
    `phase ${phase.n} (${phase.name}): ${specs.length.toLocaleString()} worlds × ${phase.opts.ticks.toLocaleString()} ticks ` +
      `× ${phase.seeds} seed(s) on ${WORKERS} workers · est ${fmtDur(est)}`,
  )

  const t0 = Date.now()
  const jobs: Promise<void>[] = []
  for (let k = 0; k < WORKERS; k++) {
    const mine = specs.slice(k * perWorker, (k + 1) * perWorker)
    if (mine.length === 0) continue
    const jp = join(DIR, `jobs-p${phase.n}-${k}.json`)
    writeFileSync(
      jp,
      JSON.stringify({
        specs: mine,
        sources: mine.map((s) => sources.get(specId(s))),
        opts: phase.opts,
        seeds: phase.seeds,
        phase: phase.n,
      }),
    )
    jobs.push(
      new Promise<void>((res, rej) => {
        const p = spawn('npx', ['vite-node', 'scripts/search-worker.ts', jp, shardPath(phase.n, k)], {
          stdio: ['ignore', 'ignore', 'inherit'],
        })
        p.on('error', rej)
        p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`worker ${k} exited ${c}`))))
      }),
    )
  }

  // a heartbeat, because a silent eight-hour process is indistinguishable from a hung one
  const total = specs.length
  const beat = setInterval(() => {
    const n = readCatalog().filter((e) => e.phase === phase.n).length
    const el = (Date.now() - t0) / 1000
    const rate = n / Math.max(1, el)
    process.stdout.write(
      `\r  ${n}/${total} · ${rate.toFixed(1)}/s · elapsed ${fmtDur(el)} · left ${fmtDur((total - n) / Math.max(0.001, rate))}   `,
    )
  }, 15000)

  Promise.all(jobs)
    .then(() => {
      clearInterval(beat)
      const secs = (Date.now() - t0) / 1000
      process.stdout.write('\n')
      const after = readCatalog().filter((e) => e.phase === phase.n)
      const alive = after.filter(possible).length
      console.log(
        `phase ${phase.n} done in ${fmtDur(secs)} · ${after.length} catalogued · ${alive} possible ` +
          `(${Math.round((100 * alive) / Math.max(1, after.length))}%) · best score ${Math.max(...after.map((e) => e.score)).toFixed(2)}`,
      )
      appendFileSync(
        join(DIR, 'phases.log'),
        JSON.stringify({ phase: phase.n, at: Date.now(), secs, worlds: after.length, possible: alive }) + '\n',
      )
      // the job files are the specs again, one per worker, and at two hundred thousand candidates
      // they outweigh the results they produced. The catalog holds every spec, so they are spent.
      for (let k = 0; k < WORKERS; k++) {
        const jp = join(DIR, `jobs-p${phase.n}-${k}.json`)
        if (existsSync(jp)) rmSync(jp)
      }
    })
    .catch((err) => {
      clearInterval(beat)
      console.error(`\nphase ${phase.n} failed:`, (err as Error).message)
      process.exitCode = 1
    })
}

/** Rough cost per tick at a phase's world size, from the measurements in RULES.md §24. */
function estMsPerTick(phase: Phase): number {
  const live = phase.shape.matter + phase.shape.slots * 5
  if (live <= 300) return 0.3
  if (live <= 650) return 1.25
  return 4.3
}

function fmtDur(secs: number): string {
  if (!Number.isFinite(secs)) return '?'
  if (secs < 90) return `${Math.round(secs)}s`
  if (secs < 5400) return `${(secs / 60).toFixed(1)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

if (has('export')) {
  /*
   * The top worlds, as a file the browser can read.
   *
   * The catalog is hundreds of megabytes of JSONL on disk and the UI has no business reading it;
   * this writes the handful worth looking at, with the aggregate figures that explain the sort.
   * Specs rather than worlds, so the page rebuilds each one deterministically and nothing can
   * drift between what was scored and what is shown.
   */
  const all = readCatalog()
  const cat = best(all)
  const top = Number(flag('top', '24'))
  const phases = [...new Set(all.map((e) => e.phase))].sort((a, b) => b - a)
  const deepest = phases.find((p) => all.filter((e) => e.phase === p).length >= 200) ?? phases[0] ?? 0
  const out = {
    kind: 'simplecell-discoveries',
    at: Date.now(),
    worlds: cat.length,
    phases: phases.map((p) => ({ phase: p, worlds: all.filter((e) => e.phase === p).length })),
    summary: summarise(all.filter((e) => e.phase === deepest)),
    analysedPhase: deepest,
    top: rank(cat).slice(0, top),
  }
  writeFileSync(flag('out', 'discoveries.json'), JSON.stringify(out))
  console.log(`wrote ${flag('out', 'discoveries.json')}: ${out.top.length} worlds of ${cat.length} catalogued`)
} else if (has('report')) {
  const all = readCatalog()
  const cat = best(all)
  if (cat.length === 0) console.log('nothing catalogued yet')
  else {
    // one phase at a time: phases fix world size themselves, so pooling them turns those dials
    // into a proxy for run length and the factor analysis starts describing the schedule
    const phases = [...new Set(all.map((e) => e.phase))].sort((a, b) => b - a)
    const which = Number(flag('analyse', String(phases.find((p) => all.filter((e) => e.phase === p).length >= 200) ?? phases[0])))
    const rows = all.filter((e) => e.phase === which)
    console.log(`analysing phase ${which} alone (${rows.length.toLocaleString()} worlds); phases present: ${phases.join(', ')}\n`)
    console.log(report(summarise(rows)))
    console.log('\nTOP WORLDS (all phases, best per world)')
    for (const e of rank(cat).slice(0, 10)) {
      console.log(
        `  ${e.id} level ${e.level} score ${e.score.toFixed(2)} · ${e.spec.foodMode}/${e.spec.foodLevel}/${e.spec.foodRegime} ` +
          `· met ${e.spec.metabolism} flow ${e.spec.bondFlow} T ${e.spec.T} · ${e.ticks.toLocaleString()}t ${e.stop}`,
      )
    }
  }
} else {
  const n = Number(flag('phase', '0'))
  const phase = PHASES.find((p) => p.n === n)
  if (!phase) throw new Error(`no phase ${n}`)
  runPhase(phase)
}
