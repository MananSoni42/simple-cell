import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPERIMENTS, type Row } from './experiments'

/**
 * The experiment runner: every condition × every seed, across processes.
 *
 * usage:
 *   npx vite-node scripts/sweep.ts <experiment> [--ticks 20000] [--seeds 30] [--workers 12]
 *   npx vite-node scripts/sweep.ts --list
 *   npx vite-node scripts/sweep.ts <experiment> --report      # re-read results, no simulation
 *
 * Why this exists. The first versions of these experiments were serial, and at five seeds E1
 * produced ablations that were **individually harmful and jointly helpful** — impossible as an
 * effect, and the signature of a sample far too small. The honest sample size for this world is the
 * thirty the v1 search used as its reporting minimum, and serially that is hours per question.
 *
 * Twelve workers, not fourteen: measured on this machine during the v1 search, throughput peaks at
 * twelve and *falls* at fourteen, because the four efficiency cores cost more in memory contention
 * than they contribute. Effective speedup is about 8x.
 *
 * Results are JSONL, one line per finished run, in `sweep/<experiment>/`. A sweep killed halfway
 * keeps everything it had done and `--report` will summarise it, which matters for a question that
 * takes an hour.
 */

const args = process.argv.slice(2)
const flag = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const has = (n: string): boolean => args.includes(`--${n}`)

if (has('list') || args.length === 0) {
  for (const [name, ex] of Object.entries(EXPERIMENTS)) {
    console.log(`${name.padEnd(10)} ${ex.cases.length} conditions · ${ex.question}`)
  }
  process.exit(0)
}

const NAME = args[0]
const EX = EXPERIMENTS[NAME]
if (!EX) throw new Error(`no experiment "${NAME}"; try --list`)
const TICKS = Number(flag('ticks', '20000'))
const SEEDS = Number(flag('seeds', '30'))
const WORKERS = Number(flag('workers', '12'))
const DIR = join(flag('dir', 'sweep'), NAME)

interface Done {
  name: string
  seed: number
  ms: number
  row?: Row
  error?: string
}

function read(): Done[] {
  if (!existsSync(DIR)) return []
  const out: Done[] = []
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t) as Done)
      } catch {
        /* a half-written final line, which is what an interrupted run leaves */
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- statistics

const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length)
const se = (xs: number[]): number => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length)
}

/**
 * Welch's two-sample t, and the honest verdict that goes with it.
 *
 * Welch rather than Student because the conditions have no reason to share a variance — a world
 * that collapses has a tiny spread and a world that thrives has a large one, and pooling them
 * would understate the uncertainty of exactly the comparison being made.
 *
 * Nothing under two standard errors is called anything. That threshold was not chosen here: it is
 * the one the v1 search used, after plain random search scored +0.002 on its headline statistic
 * and won 7 of 12 pairings, which is what calibrated "small and positive" as noise.
 */
function compare(a: number[], b: number[]): { d: number; t: number; verdict: string } {
  const d = mean(a) - mean(b)
  const s = Math.sqrt(se(a) ** 2 + se(b) ** 2)
  if (s === 0) return { d, t: 0, verdict: d === 0 ? 'identical' : 'single seed' }
  const t = d / s
  return { d, t, verdict: Math.abs(t) < 2 ? 'noise' : t > 0 ? 'better' : 'WORSE' }
}

function report(): void {
  const done = read().filter((r) => r.row)
  const failed = read().filter((r) => r.error)
  if (done.length === 0) {
    console.log('nothing finished yet')
    return
  }
  const by = new Map<string, Row[]>()
  for (const r of done) {
    const a = by.get(r.name)
    if (a) a.push(r.row!)
    else by.set(r.name, [r.row!])
  }
  const n = (name: string): number => by.get(name)?.length ?? 0

  console.log(`\n${EX.question}`)
  console.log(`${TICKS.toLocaleString()} ticks · ${done.length} runs finished${failed.length ? ` · ${failed.length} failed` : ''}\n`)

  const w = Math.max(...EX.cases.map((c) => c.length), 10)
  const head = EX.report.map((r) => r.label.padEnd(14)).join('')
  console.log(`${'condition'.padEnd(w)}  ${head}seeds`)
  for (const c of EX.cases) {
    const rows = by.get(c)
    if (!rows?.length) {
      console.log(`${c.padEnd(w)}  (nothing yet)`)
      continue
    }
    const cells = EX.report
      .map((r) => `${mean(rows.map((x) => x[r.key] ?? 0)).toFixed(r.dp)}±${se(rows.map((x) => x[r.key] ?? 0)).toFixed(r.dp)}`.padEnd(14))
      .join('')
    console.log(`${c.padEnd(w)}  ${cells}${rows.length}`)
  }

  const ctrl = by.get(EX.control)
  if (!ctrl?.length) {
    console.log(`\n(no runs for the control "${EX.control}" yet, so nothing is compared)`)
    return
  }
  console.log(`\nagainst "${EX.control}" (n ${ctrl.length}), Welch t; nothing inside 2 SE is called anything:`)
  for (const c of EX.cases) {
    if (c === EX.control) continue
    const rows = by.get(c)
    if (!rows?.length) continue
    const parts = EX.report
      .filter((r) => r.dp > 0) // the counts are diagnostics, not outcomes
      .map((r) => {
        const { d, t, verdict } = compare(
          rows.map((x) => x[r.key] ?? 0),
          ctrl.map((x) => x[r.key] ?? 0),
        )
        return `${r.label} ${d >= 0 ? '+' : ''}${d.toFixed(r.dp)} (t ${t.toFixed(1)}, ${verdict})`
      })
    console.log(`  ${c.padEnd(w)} ${parts.join(' · ')}`)
  }
  if (Math.min(...EX.cases.map(n).filter((x) => x > 0)) < 30) {
    console.log(`\n⚠ fewer than 30 seeds in at least one condition. This world is heavy-tailed enough
  that five seeds produced ablations which were individually harmful and jointly helpful — an
  impossible pattern, and the reason this runner exists. Treat anything below 30 as provisional.`)
  }
  if (failed.length) {
    const first = read().find((r) => r.error)!
    console.log(`\n${failed.length} runs failed, e.g. ${first.name}: ${first.error}`)
  }
}

if (has('report')) {
  report()
} else {
  mkdirSync(DIR, { recursive: true })
  // what is already done, so a resumed sweep does not re-run it
  const already = new Set(read().map((r) => `${r.name}|${r.seed}`))
  const jobs: { name: string; seed: number }[] = []
  for (const name of EX.cases) {
    for (let k = 0; k < SEEDS; k++) {
      const seed = 4242 + k * 7919
      if (!already.has(`${name}|${seed}`)) jobs.push({ name, seed })
    }
  }
  if (jobs.length === 0) {
    console.log('nothing to run; summarising what is there')
    report()
    process.exit(0)
  }

  /*
   * Interleaved, not blocked by condition.
   *
   * Sharding `[all of A, all of B, ...]` contiguously would give one worker every run of the
   * slowest condition, so the sweep would finish when that one worker did. It also means a sweep
   * stopped early has *complete* data for some conditions and none for others, which is worse than
   * partial data for all of them: a table with every condition at n=8 can be read, and a table with
   * three conditions at n=30 and five empty cannot.
   */
  jobs.sort((a, b) => a.seed - b.seed || EX.cases.indexOf(a.name) - EX.cases.indexOf(b.name))
  const shards: typeof jobs[] = Array.from({ length: WORKERS }, () => [])
  jobs.forEach((j, i) => shards[i % WORKERS].push(j))

  console.log(`${NAME}: ${EX.cases.length} conditions × ${SEEDS} seeds = ${jobs.length} runs of ${TICKS.toLocaleString()} ticks on ${WORKERS} workers`)
  const t0 = Date.now()
  const running: Promise<void>[] = []
  for (const [k, mine] of shards.entries()) {
    if (mine.length === 0) continue
    const jp = join(DIR, `jobs-${k}.json`)
    writeFileSync(jp, JSON.stringify({ experiment: NAME, jobs: mine, ticks: TICKS }))
    running.push(
      new Promise<void>((res, rej) => {
        const p = spawn('npx', ['vite-node', 'scripts/sweep-worker.ts', jp, join(DIR, `out-${k}.jsonl`)], {
          stdio: ['ignore', 'ignore', 'inherit'],
        })
        p.on('error', rej)
        p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`worker ${k} exited ${c}`))))
      }),
    )
  }

  const total = jobs.length + already.size
  const beat = setInterval(() => {
    const n = read().length
    const el = (Date.now() - t0) / 1000
    const rate = (n - already.size) / Math.max(1, el)
    // no estimate until every worker has reported once: a rate computed from zero completions is
    // zero, and dividing by it printed "left 11.1h" on a phase that took 1.5 during the v1 search
    const warm = n - already.size >= Math.min(WORKERS, jobs.length)
    const left = warm ? `left ${fmt((total - n) / Math.max(1e-6, rate))}` : 'estimating…'
    process.stdout.write(`\r  ${n}/${total} · ${rate.toFixed(2)}/s · elapsed ${fmt(el)} · ${left}   `)
  }, 10000)

  Promise.all(running)
    .then(() => {
      clearInterval(beat)
      process.stdout.write(`\ndone in ${fmt((Date.now() - t0) / 1000)}\n`)
      for (let k = 0; k < WORKERS; k++) {
        const jp = join(DIR, `jobs-${k}.json`)
        if (existsSync(jp)) rmSync(jp) // the results hold everything these described
      }
      report()
    })
    .catch((err) => {
      clearInterval(beat)
      console.error(`\n${NAME} failed:`, (err as Error).message)
      report() // whatever finished is still worth reading
      process.exitCode = 1
    })
}

function fmt(secs: number): string {
  if (!Number.isFinite(secs)) return '?'
  if (secs < 90) return `${Math.round(secs)}s`
  if (secs < 5400) return `${(secs / 60).toFixed(1)}m`
  return `${(secs / 3600).toFixed(1)}h`
}
