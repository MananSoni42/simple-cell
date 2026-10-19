import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { WorldSpec } from '../src/core/catalog'
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
/**
 * Which world set to use. `--set b` draws an independent one from a different seed.
 *
 * A replication has to be on *different worlds*, not more reps of the same ones: more reps shrink
 * the within-world noise and leave any peculiarity of the thirty worlds themselves untouched. With
 * 51 of 90 pairs tied in the first run, the effect rested on 39 informative comparisons, and
 * whether those thirty worlds happen to suit one learner is exactly what a second set tests.
 */
/**
 * Which world sets to run. **Two by default, and reported side by side.**
 *
 * One set is not a replication however many paired comparisons it contains. The first run of this
 * gave MAP-Elites +0.098 at t = 2.4 over 90 pairs and I reported it as the first learner to beat
 * the control; on an independent set it came back at **-0.070, t = -1.6**, with the sign test
 * flipping from 24-15 to 18-28. Every other offline arm flipped or collapsed too.
 *
 * The reason is visible in the controls: `none` scored 1.282 on set A and 1.809 on set B, a 41%
 * shift that dwarfs every learner effect ever measured here (all under 0.15). So the effective
 * sample was **one world set**, not ninety comparisons — pseudo-replication, and reporting it as a
 * finding was my error. Running both by default makes that error structurally harder to repeat:
 * a result that does not appear in both columns is not a result.
 */
const SETS = flag('sets', 'a,b').split(',')
const SET_SEEDS: Record<string, number> = { a: 20261019, b: 20261020, c: 20261021, d: 20261022 }

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

/**
 * The world set: drawn once, read back for ever.
 *
 * Only *viable* worlds go in. A learner cannot be judged in a world where nothing lives, and a set
 * that is mostly dead worlds measures the death rate rather than the learner — 40% of sampled
 * worlds score zero at the gate horizon, so an unfiltered set would be dominated by them.
 */
function worldSet(set: string): WorldSpec[] {
  const path = `${DIR}/learner-worlds-${set}.json`
  if (existsSync(path)) {
    const held = JSON.parse(readFileSync(path, 'utf8')) as { specs: WorldSpec[] }
    if (held.specs.length >= N_SPECS) return held.specs.slice(0, N_SPECS)
  }
  const rng = new Rng(SET_SEEDS[set] ?? 1)
  const specs: WorldSpec[] = []
  let drawn = 0
  while (specs.length < N_SPECS) {
    const spec = draw(rng, { slots: 60, matter: 300, scale: 1 }, 'constrained')
    drawn++
    const gate = evaluate(spec, { ticks: 500, maxExtend: 1, plateauFrac: 0, every: 100 })
    const dead = (gate.stats.bonds === 0 && gate.stats.bestOrder === 0) || (gate.stats.organisms === 0 && gate.stop === 'extinct')
    if (!dead) specs.push(spec)
  }
  writeFileSync(path, JSON.stringify({ at: Date.now(), set, drawn, specs }, null, 2) + '\n')
  console.log(`set ${set}: drew ${specs.length} viable worlds from ${drawn} draws -> ${path}`)
  return specs
}

const algos: LearnAlgo[] = (ONLY ? (ONLY.split(',') as LearnAlgo[]) : LEARNERS.map((l) => l.key)).filter((a) =>
  LEARNERS.some((l) => l.key === a),
)

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
const median = (a: number[]): number => {
  const s2 = [...a].sort((x, y) => x - y)
  return s2.length === 0 ? 0 : s2[s2.length >> 1]
}

interface Arm {
  d: number
  se: number
  t: number
  up: number
  dn: number
  tied: number
}
/** per set, per algo */
const results = new Map<string, Map<LearnAlgo, Arm>>()
const controls = new Map<string, number>()

for (const set of SETS) {
  const specs = worldSet(set)
  const score = new Map<LearnAlgo, number[]>()
  const t0 = Date.now()
  let done = 0
  const total = algos.length * specs.length * REPS
  for (const algo of algos) {
    const ss: number[] = []
    for (const spec of specs) {
      for (let rep = 0; rep < REPS; rep++) {
        // the seed moves with the rep, so a rep is an independent world rather than a repeat of one
        const r = evaluate(
          { ...spec, learn: algo, seed: spec.seed + rep * 7919 },
          { ticks: TICKS, maxExtend: 1, plateauFrac: 0, every: 500 },
        )
        ss.push(r.score)
        done++
      }
    }
    score.set(algo, ss)
    const el = (Date.now() - t0) / 1000
    console.log(
      `  set ${set} ${algo.padEnd(8)} mean ${mean(ss).toFixed(3).padStart(7)} median ${median(ss).toFixed(3).padStart(7)}` +
        `  [${done}/${total}, ${el.toFixed(0)}s, eta ${((el / done) * (total - done)).toFixed(0)}s]`,
    )
  }
  const base = score.get('none')
  if (!base) continue
  controls.set(set, mean(base))
  const arms = new Map<LearnAlgo, Arm>()
  for (const algo of algos) {
    if (algo === 'none') continue
    const v = score.get(algo)!
    const d = v.map((x, i) => x - base[i])
    const m = mean(d)
    const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, d.length - 1))
    const se = sd / Math.sqrt(d.length)
    arms.set(algo, {
      d: m,
      se,
      t: se > 1e-12 ? m / se : 0,
      up: d.filter((x) => x > 1e-9).length,
      dn: d.filter((x) => x < -1e-9).length,
      tied: d.filter((x) => Math.abs(x) <= 1e-9).length,
    })
  }
  results.set(set, arms)
  writeFileSync(`${DIR}/learners-${set}.json`, JSON.stringify({ at: Date.now(), set, ticks: TICKS, reps: REPS, score: Object.fromEntries([...score]) }, null, 2) + '\n')
}

/*
 * Side by side, with the controls shown. The controls are the important column: if `none` itself
 * moves more between sets than any learner moves within one, then the learner effects are draw luck
 * and no amount of paired comparisons inside a single set will say otherwise.
 */
console.log(`\n${N_SPECS} worlds x ${REPS} reps at ${TICKS} ticks, per set`)
console.log(`control (none) mean score:  ${SETS.map((s) => `${s} ${(controls.get(s) ?? 0).toFixed(3)}`).join('   ')}`)
console.log(`\n${'algo'.padEnd(9)}${SETS.map((s) => `set ${s}`.padEnd(30)).join('')}replicates?`)
for (const algo of algos) {
  if (algo === 'none') continue
  const cells = SETS.map((s) => {
    const a = results.get(s)?.get(algo)
    return a ? `${(a.d >= 0 ? '+' : '') + a.d.toFixed(3)} ±${a.se.toFixed(3)} t${a.t.toFixed(1).padStart(5)} ${a.up}/${a.dn}`.padEnd(30) : '—'.padEnd(30)
  })
  const signs = SETS.map((s) => Math.sign(results.get(s)?.get(algo)?.d ?? 0))
  const same = signs.every((x) => x === signs[0])
  const anyStrong = SETS.some((s) => Math.abs(results.get(s)?.get(algo)?.t ?? 0) >= 2)
  const verdict = !same ? 'NO — sign flips' : anyStrong ? 'same sign, one set strong' : 'same sign, both weak'
  console.log(`${algo.padEnd(9)}${cells.join('')}${verdict}`)
}
console.log(`\nwrote ${SETS.map((s) => `${DIR}/learners-${s}.json`).join(', ')}`)
