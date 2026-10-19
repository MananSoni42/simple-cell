import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type WorldSpec, specId } from '../src/core/catalog'
import { evaluate } from '../src/core/evaluate'
import { LEARNERS, type LearnAlgo } from '../src/core/learning'
import { Rng } from '../src/core/rng'
import { draw } from '../src/core/sample'

/**
 * Does any learner beat no learner? Measured against a **persisted** set of worlds.
 *
 * The spec set is drawn once and written to disk, and every later run reads it back. That is the
 * whole point of this script existing rather than a throwaway: the previous comparison drew its
 * worlds from the sampler each time, so adding a dial shifted the random sequence and silently
 * replaced every world in the experiment. The control's own score moved from 2.289 to 0.336 between
 * two runs and the two sets of numbers were not comparable — which I did not notice until the
 * control moved more than any learner had.
 *
 * Paired on `(spec, seed)`, so every learner faces exactly the same worlds and the same food in the
 * same places, and the difference from `none` is taken per pair before averaging. With per-world
 * variance as large as it is here, a paired design is the only one that can see an effect at all.
 *
 * usage:
 *   npx vite-node scripts/learners.ts                     # 30 specs x 3 seeds, 6000 ticks
 *   npx vite-node scripts/learners.ts --specs 30 --reps 3 --ticks 6000
 *   npx vite-node scripts/learners.ts --algos none,hebb,td # a subset, same worlds
 */
const args = process.argv.slice(2)
const flag = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const N_SPECS = Number(flag('specs', '30'))
const REPS = Number(flag('reps', '3'))
const TICKS = Number(flag('ticks', '6000'))
const ONLY = flag('algos', '')
const DIR = flag('dir', 'search')
const SET_PATH = `${DIR}/learner-worlds.json`

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

/**
 * The world set: drawn once, read back for ever.
 *
 * Only *viable* worlds go in. A learner cannot be judged in a world where nothing lives, and a set
 * that is mostly dead worlds measures the death rate rather than the learner — 40% of sampled
 * worlds score zero at the gate horizon, so an unfiltered set would be dominated by them.
 */
function worldSet(): WorldSpec[] {
  if (existsSync(SET_PATH)) {
    const held = JSON.parse(readFileSync(SET_PATH, 'utf8')) as { specs: WorldSpec[] }
    if (held.specs.length >= N_SPECS) return held.specs.slice(0, N_SPECS)
  }
  const rng = new Rng(20261019)
  const specs: WorldSpec[] = []
  let drawn = 0
  while (specs.length < N_SPECS) {
    const spec = draw(rng, { slots: 60, matter: 300, scale: 1 }, 'constrained')
    drawn++
    const gate = evaluate(spec, { ticks: 500, maxExtend: 1, plateauFrac: 0, every: 100 })
    const dead = (gate.stats.bonds === 0 && gate.stats.bestOrder === 0) || (gate.stats.organisms === 0 && gate.stop === 'extinct')
    if (!dead) specs.push(spec)
  }
  writeFileSync(SET_PATH, JSON.stringify({ at: Date.now(), drawn, ticks: TICKS, specs }, null, 2) + '\n')
  console.log(`drew ${specs.length} viable worlds from ${drawn} draws -> ${SET_PATH}`)
  return specs
}

const specs = worldSet()
const algos: LearnAlgo[] = (ONLY ? (ONLY.split(',') as LearnAlgo[]) : LEARNERS.map((l) => l.key)).filter((a) =>
  LEARNERS.some((l) => l.key === a),
)

/** score[algo][specIndex * REPS + rep] — the full grid, so any pairing can be formed afterwards. */
const score = new Map<LearnAlgo, number[]>()
const level = new Map<LearnAlgo, number[]>()
const t0 = Date.now()
let done = 0
const total = algos.length * specs.length * REPS
for (const algo of algos) {
  const ss: number[] = []
  const ll: number[] = []
  for (const spec of specs) {
    for (let rep = 0; rep < REPS; rep++) {
      // the seed moves with the rep, so a rep is an independent world and not a repeat of one
      const r = evaluate({ ...spec, learn: algo, seed: spec.seed + rep * 7919 }, { ticks: TICKS, maxExtend: 1, plateauFrac: 0, every: 500 })
      ss.push(r.score)
      ll.push(r.level)
      done++
    }
  }
  score.set(algo, ss)
  level.set(algo, ll)
  const el = (Date.now() - t0) / 1000
  console.log(
    `${algo.padEnd(8)} mean ${mean(ss).toFixed(3).padStart(7)}  median ${median(ss).toFixed(3).padStart(7)}  ` +
      `level ${mean(ll).toFixed(2).padStart(5)}  [${done}/${total}, ${el.toFixed(0)}s, eta ${((el / done) * (total - done)).toFixed(0)}s]`,
  )
}

function mean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
}
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y)
  return s.length === 0 ? 0 : s[s.length >> 1]
}

const base = score.get('none')
if (!base) console.log('\nno `none` arm: nothing to compare against')
else {
  console.log(`\npaired against none, ${specs.length} worlds x ${REPS} reps at ${TICKS} ticks:`)
  for (const algo of algos) {
    if (algo === 'none') continue
    const v = score.get(algo)!
    const d = v.map((x, i) => x - base[i])
    const m = mean(d)
    const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, d.length - 1))
    const se = sd / Math.sqrt(d.length)
    /*
     * A sign test as well as a t, because the paired differences are heavy-tailed here — a handful
     * of worlds swing by whole points while most move by hundredths, and a mean over that is
     * dominated by the few. The sign test asks only "does it win more often than it loses", which
     * no outlier can carry.
     */
    const up = d.filter((x) => x > 1e-9).length
    const dn = d.filter((x) => x < -1e-9).length
    console.log(
      `  ${algo.padEnd(8)} d ${(m >= 0 ? '+' : '') + m.toFixed(3)} ± ${se.toFixed(3)}  t ${(se > 1e-12 ? m / se : 0).toFixed(1).padStart(5)}  ` +
        `won ${String(up).padStart(3)} lost ${String(dn).padStart(3)} tied ${d.length - up - dn}`,
    )
  }
}

writeFileSync(
  `${DIR}/learners.json`,
  JSON.stringify(
    {
      at: Date.now(),
      ticks: TICKS,
      reps: REPS,
      specs: specs.map((s) => specId(s)),
      score: Object.fromEntries([...score]),
      level: Object.fromEntries([...level]),
    },
    null,
    2,
  ) + '\n',
)
console.log(`\nwrote ${DIR}/learners.json`)
