import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG_VERSION, type CatalogEntry, type WorldSpec, best, parseCatalog, rank, specId } from '../src/core/catalog'
import type { EvalOptions } from '../src/core/evaluate'
import { mix } from '../src/core/sample'
import { chemistryShape, report, summarise } from '../src/core/analyse'
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
    // a gate: the cap is a budget, taken as an unbiased subsample of the survivors rather than the
    // top of a ranking that carries no information at this horizon. 40,000 x 3 seeds is phase 1's
    // measured 5.3 hours on 14 cores
    keep: 40000,
    kills: 'impossible-only',
  },
  {
    n: 1,
    name: 'screen',
    shape: { slots: 60, matter: 300, scale: 1 },
    opts: { ticks: 2000, maxExtend: 1.5, plateauFrac: 0.4, every: 200 },
    // three seeds, because this is the first phase allowed to rank and a world's score has a
    // signal-to-noise of 2.4 at a short horizon — one seed would be ranking on a coin flip
    seeds: 3,
    budget: 40000,
    keep: 2000,
    kills: 'rank',
  },
  {
    n: 2,
    name: 'rank',
    shape: { slots: 150, matter: 700, scale: 1 },
    opts: { ticks: 20000, maxExtend: 1.5, plateauFrac: 0.3, every: 500 },
    // the first horizon at which the upper rungs are reachable, so this is where the factor tables
    // come from. S/N is 5.6 here, so three seeds rank reliably
    seeds: 3,
    budget: 2000,
    keep: 100,
    kills: 'rank',
  },
  {
    n: 3,
    name: 'confirm',
    shape: { slots: 150, matter: 700, scale: 1 },
    opts: { ticks: 100000, maxExtend: 1.5, plateauFrac: 0.25, every: 1000 },
    seeds: 5,
    budget: 100,
    // the showcase set: the worlds that get saved with checkpoints so progress can be watched
    keep: 20,
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

/**
 * A world is impossible if it cannot bond, cannot stay alive, or is numerically broken.
 *
 * **It must never test `level`,** and that rule was broken, which killed the whole search. `level`
 * requires every rung at and below a tier, and tier 0 contains `Lasts`, which wants a p90 lifetime
 * of 2,000 ticks. Phase 0 runs **500**. So no phase-0 world could ever reach level 0, and the
 * screen discarded everything: measured, `60 catalogued · 0 possible (0%)`, and phase 1 then had
 * nothing to run. At the full 200,000 budget that is roughly ten core-hours producing zero
 * survivors.
 *
 * This is why `kills: 'impossible-only'` exists at all — a 500-tick horizon can establish that a
 * world is *broken* and nothing more. Ranking or gating on achievement at that length throws away
 * every slow starter, which is precisely what the search is looking for.
 */
/** A stable hash of a world id, so a gate's random subsample is reproducible across a resume. */
function hashId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = ((h ^ id.charCodeAt(i)) * 0x01000193) >>> 0
  return h
}

function possible(e: CatalogEntry): boolean {
  if (e.stats.bonds === 0 && e.stats.bestOrder === 0) return false // the chemistry cannot hold
  if (e.stats.clampPct > 60) return false // the integrator is fighting it the whole way
  if (e.stats.organisms === 0 && e.stop === 'extinct') return false // nothing survived to judge
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
    /*
     * Promotion is **stratified**, not top-N, and the reason is a flaw worth naming.
     *
     * Phase 0 scores what four tenths of a generation can see: clumping and limb retention. Those
     * favour universal attraction, so a plain top-N cut would systematically discard the
     * self-repelling chemistries that a membrane needs — and this search has a written prediction
     * that self-repulsion wins by phase 2. Ranking globally would quietly make that prediction
     * untestable, which is the worst kind of experimental error: the screen would confirm the
     * screen.
     *
     * So the budget is divided across strata — how many types repel themselves, crossed with the
     * food pattern — and the best of each stratum is taken. Unfilled quota is redistributed, so
     * nothing is wasted on empty cells.
     */
    /*
     * Metabolism is in the strata because phase 0 is biased toward it, and the bias is visible:
     * every one of the top twenty worlds ran at metabolism 2, the most expensive setting, while
     * the marginal means say 0.25 is best by a wide margin. Both are true. Several rungs need
     * *completed lives* before they can report anything, and a cheap-living world has barely any
     * at five hundred ticks — so a fast-dying world is not better, it is merely measurable sooner.
     * Stratifying on it stops that artifact deciding what survives the screen.
     */
    const stratum = (e: CatalogEntry): string =>
      `${chemistryShape(e.spec).selfRepel}|${e.spec.foodMode}|${e.spec.metabolism}`
    const cells = new Map<string, CatalogEntry[]>()
    for (const e of survivors) {
      const k = stratum(e)
      const a = cells.get(k)
      if (a) a.push(e)
      else cells.set(k, [e])
    }
    /*
     * **A gate subsamples at random; a ranker sorts by score.** Measured, this is the difference
     * between a valid screen and selection on noise.
     *
     * Spearman between a 500-tick score and a 6,000-tick score is 0.87 over ten worlds — but
     * **0.16 among the six live ones.** The 0.87 was entirely the four dead worlds correctly
     * staying dead, so at a gate horizon the score tells you *whether* a world lives and nothing
     * about how well. One world went 1.69 -> 1.05 while another went 0.60 -> 3.28.
     *
     * So a phase that is only allowed to kill the impossible must not also rank. It still needs a
     * budget cap, and that cap is taken as a deterministic shuffle within each stratum — unbiased
     * with respect to a score that carries no information at this horizon.
     */
    if (prev.kills === 'impossible-only') {
      for (const a of cells.values()) {
        // keyed on the world's own id, so the subsample is reproducible across a resumed run
        a.sort((x, y) => (hashId(x.id) - hashId(y.id)) || (x.id < y.id ? -1 : 1))
      }
    } else for (const a of cells.values()) a.sort((x, y) => y.score - x.score)
    const cut: CatalogEntry[] = []
    const chosen = new Set<CatalogEntry>()
    let quota = Math.max(1, Math.ceil(prev.keep / Math.max(1, cells.size)))
    for (let pass = 0; pass < 4 && cut.length < prev.keep; pass++) {
      for (const a of cells.values()) {
        const want = Math.min(a.length, quota)
        // a Set rather than Array.includes: at a sixty-thousand promotion budget the linear scan
        // would be three billion comparisons, which is a hang rather than a slow step
        for (let i = 0; i < want && cut.length < prev.keep; i++) {
          if (!chosen.has(a[i])) {
            chosen.add(a[i])
            cut.push(a[i])
          }
        }
      }
      quota *= 2 // redistribute what thin cells could not use
    }
    const rest = rank(survivors).filter((e) => !chosen.has(e))
    console.log(`  stratified across ${cells.size} cells (self-repulsion × food pattern)`)
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
        `taking ${cut.length} stratified + ${rescueN} rescued, ${specs.length} still to run`,
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
    /*
     * No estimate until every worker has reported at least once.
     *
     * A rate computed from zero completions is zero, and dividing by it produced "left 11.1h" on a
     * phase that finished in 1.5 — which is worse than printing nothing, because it looks like
     * information. In a phase of forty long runs across ten workers, the first completions all
     * arrive at once, so the first honest estimate is available only after that.
     */
    const warm = n >= Math.min(WORKERS, total)
    const left = warm ? `left ${fmtDur((total - n) / Math.max(1e-6, rate))}` : 'estimating…'
    process.stdout.write(`\r  ${n}/${total} · ${rate.toFixed(2)}/s · elapsed ${fmtDur(el)} · ${left}   `)
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
          `(${Math.round((100 * alive) / Math.max(1, after.length))}%) · ` +
          `best score ${after.reduce((a, e) => (e.score > a ? e.score : a), 0).toFixed(2)}`,
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

/** Rough cost per tick at a phase's world size, from the measurements in docs/RULES.md §24. */
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
  const top = Number(flag('top', '40'))
  const phases = [...new Set(all.map((e) => e.phase))].sort((a, b) => b - a)
  const deepest = phases.find((p) => all.filter((e) => e.phase === p).length >= 200) ?? phases[0] ?? 0
  /*
   * Interesting, not merely best.
   *
   * Ranking a quarter of a million worlds by one number returns ten near-identical matrices: they
   * all found the same trick, and nine of the ten in this search shared a metabolism setting. So
   * the export picks along several axes — the best overall, then the best *at each thing the
   * ladder measures separately*, then the best per food pattern — and de-duplicates. What comes
   * out is a set of worlds that are different from each other, each labelled with why it is here,
   * which is what makes a list worth browsing rather than scrolling.
   */
  const ranked = rank(cat)
  const picks: { why: string; entry: CatalogEntry }[] = []
  const seen = new Set<string>()
  const take = (why: string, e: CatalogEntry | undefined): void => {
    if (!e || seen.has(e.id)) return
    seen.add(e.id)
    picks.push({ why, entry: e })
  }
  const bestBy = (f: (e: CatalogEntry) => number): CatalogEntry | undefined =>
    ranked.reduce<CatalogEntry | undefined>((a, e) => (!a || f(e) > f(a) ? e : a), undefined)

  take('highest score overall', ranked[0])
  take('longest-lived organisms', bestBy((e) => e.stats.p90Coasts ?? 0))
  take('best fed', bestBy((e) => e.stats.fed ?? 0))
  take('most food-seeking', bestBy((e) => e.stats.seek ?? 0))
  take('largest structure', bestBy((e) => e.stats.bestOrder ?? 0))
  take('longest-held structure', bestBy((e) => e.stats.heldFrac ?? 0))
  take('most member turnover', bestBy((e) => e.stats.replacements ?? 0))
  take('furthest-travelling structure', bestBy((e) => e.stats.travel ?? 0))
  take('deepest lineage', bestBy((e) => e.stats.maxGen ?? 0))
  take('most bonds standing', bestBy((e) => e.stats.bonds ?? 0))
  for (const mode of [...new Set(ranked.map((e) => e.spec.foodMode))]) {
    take(`best with ${mode} food`, ranked.find((e) => e.spec.foodMode === mode))
  }
  /*
   * Fill the rest **stratified**, not by rank.
   *
   * Taking the next best twenty from a quarter of a million worlds returns twenty variations on
   * whatever trick the leader found — nine of this search's top ten shared a metabolism setting.
   * Filling by stratum instead (how many types repel themselves × food pattern × metabolism) gives
   * a browsable set: worlds that differ from each other in the ways the search varied, each still
   * the best of its own kind.
   */
  const strata = new Map<string, CatalogEntry[]>()
  for (const e of ranked) {
    const k = `${chemistryShape(e.spec).selfRepel}|${e.spec.foodMode}|${e.spec.metabolism}`
    const a = strata.get(k)
    if (a) a.push(e)
    else strata.set(k, [e])
  }
  const lists = [...strata.values()]
  for (let round = 0; picks.length < top && round < 8; round++) {
    for (const a of lists) {
      if (picks.length >= top) break
      const e = a[round]
      if (e) take(`best of its kind (${chemistryShape(e.spec).selfRepel} self-repelling, ${e.spec.foodMode}, metabolism ${e.spec.metabolism})`, e)
    }
  }

  const out = {
    kind: 'simplecell-discoveries',
    at: Date.now(),
    worlds: cat.length,
    phases: phases.map((p) => ({ phase: p, worlds: all.filter((e) => e.phase === p).length })),
    summary: summarise(all.filter((e) => e.phase === deepest)),
    analysedPhase: deepest,
    top: picks.slice(0, top).map((p) => ({ ...p.entry, why: p.why })),
  }
  // public/ is what Vite serves at the site root, so the UI can fetch it with no build step
  const outPath = flag('out', 'public/discoveries.json')
  if (!existsSync('public')) mkdirSync('public', { recursive: true })
  writeFileSync(outPath, JSON.stringify(out))
  console.log(`wrote ${outPath}: ${out.top.length} worlds of ${cat.length} catalogued`)
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
