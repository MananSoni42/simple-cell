import { type WorldSpec, specInit } from '../src/core/catalog'
import { ladder } from '../src/core/ladder'
import { LEARNERS, LEARN_DEFAULTS, type LearnAlgo } from '../src/core/learning'
import { specFromKeys } from '../src/core/fitness'
import { World } from '../src/core/world'

/**
 * Which learners work, and which should be discarded?
 *
 * Every learner is run on the **same world with the same seeds**, so the only difference is the
 * algorithm. Two controls rather than one, and both matter:
 *
 * - `none` — random weights for every organism, which is what the world did before any of this.
 * - `random` — still random, but it keeps the best genome it ever saw. This is the one that counts.
 *   Measured earlier in this project, plain random search scored +0.002 on the percentile
 *   statistic and won 7 of 12 pairings, which is what calibrated that statistic as noise. A
 *   learner that merely improves on `none` has shown nothing; beating `random` is the bar.
 *
 * usage: npx vite-node scripts/learners.ts [ticks] [seeds]
 */
const base: WorldSpec = {
  seed: 4242,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 150,
  matter: 700,
  metabolism: 0.5,
  bondFlow: 0.05,
  T: 2,
  foodMode: 'patchy',
  foodLevel: 'average',
  foodRegime: 'steady',
  patches: 2,
  radius: 50,
  foodLife: 250,
  fission: true,
  scale: 1,
}

const TICKS = Number(process.argv[2] ?? 20000)
const SEEDS = Number(process.argv[3] ?? 5)
const ALGOS: LearnAlgo[] = ['none', 'random', 'ga', 'es', 'cem', 'elites', 'td', 'hebb']

interface Row {
  fed: number
  lasts: number
  seeks: number
  order: number
  score: number
  updates: number
  /** Lives the learner was shown. An algorithm with updates but no lives is not learning. */
  seen: number
  alive: number
}

function run(algo: LearnAlgo, seed: number): Row {
  const init = specInit({ ...base, seed })
  init.learn = {
    ...LEARN_DEFAULTS,
    algo,
    // offspring alone: the only measure that cannot be gamed by living frugally, which is the
    // failure mode every learner here has fallen into at least once
    fitness: specFromKeys(['offspring']),
    warmup: 500,
  }
  const w = new World(init, {})
  for (let t = 0; t < TICKS; t++) {
    w.step()
    if (t % 1000 === 0) ladder(w)
  }
  const l = ladder(w)
  const by = (n: string): number => l.rungs.find((r) => r.name === n)?.ratio ?? 0
  const st = w.learner.status()
  let alive = 0
  for (let b = w.nIntr; b < w.nMatter; b++) if (w.isBrain(b) && w.alive[b]) alive++
  return {
    fed: by('Feeds'),
    lasts: by('Lasts') * 2,
    seeks: by('Seeks') * 0.25,
    order: ladderOrder(w),
    score: l.score,
    updates: st.updates,
    seen: st.seen,
    alive,
  }
}

function ladderOrder(w: World): number {
  return w.orders.stats(w).oldest?.order ?? 0
}

const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length)
const se = (xs: number[]): number => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length)
}
const pm = (xs: number[], dp = 2): string => `${mean(xs).toFixed(dp)}±${se(xs).toFixed(dp)}`

console.log(`${TICKS.toLocaleString()} ticks × ${SEEDS} seeds · fitness = offspring\n`)
console.log(`${'learner'.padEnd(14)} ${'fed'.padEnd(13)} ${'lasts'.padEnd(13)} ${'seeks'.padEnd(13)} ${'score'.padEnd(12)} ${'updates'.padEnd(10)} lives`)
const results = new Map<LearnAlgo, Row[]>()
for (const algo of ALGOS) {
  const rows: Row[] = []
  for (let k = 0; k < SEEDS; k++) rows.push(run(algo, base.seed + k * 7919))
  results.set(algo, rows)
  const col = (f: (r: Row) => number, dp = 2): string => pm(rows.map(f), dp)
  console.log(
    `${algo.padEnd(14)} ${col((r) => r.fed).padEnd(13)} ${col((r) => r.lasts).padEnd(13)} ${col((r) => r.seeks, 3).padEnd(13)} ` +
      `${col((r) => r.score, 1).padEnd(12)} ${col((r) => r.updates, 0).padEnd(10)} ${col((r) => r.seen, 0)}`,
  )
}

/*
 * The verdict, stated rather than left to the reader — and stated against `random`, so that a
 * learner which only beats doing nothing is reported as what it is.
 */
console.log('\nagainst keeping the best of random:')
const ref = results.get('random')!
for (const algo of ALGOS) {
  if (algo === 'random') continue
  const rows = results.get(algo)!
  const parts: string[] = []
  for (const [k, f] of [['lasts', (r: Row) => r.lasts], ['fed', (r: Row) => r.fed], ['score', (r: Row) => r.score]] as const) {
    const a = rows.map(f)
    const b = ref.map(f)
    const d = mean(a) - mean(b)
    const s = Math.sqrt(se(a) ** 2 + se(b) ** 2)
    const verdict = Math.abs(d) < 2 * s ? 'noise' : d > 0 ? 'better' : 'WORSE'
    parts.push(`${k} ${d >= 0 ? '+' : ''}${d.toFixed(2)} (${verdict})`)
  }
  const inert = mean(rows.map((r) => r.updates)) === 0
  console.log(`  ${algo.padEnd(10)} ${parts.join(' · ')}${inert ? '  — made no updates at all' : ''}`)
}
console.log(`\n${LEARNERS.map((l) => l.key).join(', ')}`)
