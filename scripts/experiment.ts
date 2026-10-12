import { writeFileSync } from 'node:fs'
import { CONTROLS, type Variant, formatComparison, runExperiment } from '../src/core/experiment'
import { LEARN_DEFAULTS, type FitnessKey } from '../src/core/learning'
import { type Init, applyFoodLevel, initFromSeed } from '../src/core/params'

/**
 * Paired learner comparison, headless.
 *
 * Usage:
 *   npm run experiment -- [--ticks 6000] [--seeds 10] [--fitness offspring] [--algos ga,es,cem]
 *                         [--spawn 20] [--out learning-run.json]
 *
 * The protocol is LEARNING.md §7: one world per seed handed to every variant, controls always
 * included, a pre-registered measure, medians with spread, and the paired difference per seed.
 */

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const ticks = Number(flag('ticks', '6000'))
const nSeeds = Number(flag('seeds', '10'))
const fitness = flag('fitness', 'offspring') as FitnessKey
const algos = flag('algos', 'ga,es,cem').split(',').filter(Boolean)
const spawnEvery = Number(flag('spawn', '25'))
const out = flag('out', '')

/**
 * A world chosen to give a learner something to work with rather than to flatter it: food in
 * patches (so foraging is a skill rather than a given), average level, and spawns often enough
 * that the learner's samples actually reach the world within the run.
 */
function world(seed: number): Init {
  const init = initFromSeed(seed, 1)
  init.foodMode = 'patchy'
  init.foodLevel = 'average'
  init.foodRegime = 'steady'
  init.n_patch = 2
  init.r_patch = 50
  init.food_life = 250
  init.n_brain = 10
  init.n_start = 4
  init.n_intrinsic = 140
  init.T_spawn = spawnEvery
  init.repro = true
  init.bonds = true
  init.learn = { ...LEARN_DEFAULTS, fitness, warmup: Math.round(ticks * 0.1), batch: 12, pool: 24 }
  return applyFoodLevel(init)
}

const variants: Variant[] = [...CONTROLS, ...algos.map((a) => ({ name: a, learn: { algo: a as never } }))]
const seeds = Array.from({ length: nSeeds }, (_, i) => 1000 + i * 7)

const started = Date.now()
const result = runExperiment({
  ticks,
  seeds,
  variants,
  fitness,
  world,
  onProgress: (done, total, last) => {
    const pct = Math.round((100 * done) / total)
    process.stdout.write(
      `\r${String(pct).padStart(3)}% · ${done}/${total} · seed ${last.seed} ${last.variant.padEnd(13)} ` +
        `fitness ${last.fitness.toFixed(3)} · ${last.deaths} deaths · learner saw ${last.learnerSeen}   `,
    )
  },
})
process.stdout.write('\n\n')
console.log(formatComparison(result))
console.log(`\nran in ${((Date.now() - started) / 1000).toFixed(1)}s`)

// the secondary measures, because a learner that improves its scalar while the world empties out
// has not learned anything worth having
const summary = result.comparisons.map((c) => {
  const mine = result.outcomes.filter((o) => o.variant === c.variant)
  const mean = (f: (o: (typeof mine)[number]) => number): number => mine.reduce((a, o) => a + f(o), 0) / Math.max(1, mine.length)
  return {
    variant: c.variant,
    fitnessMedian: Number(c.median.toFixed(4)),
    pairedMedian: Number(c.medianPaired.toFixed(4)),
    wins: `${c.wins}/${c.n}`,
    organisms: Number(mean((o) => o.organisms).toFixed(2)),
    peak: Number(mean((o) => o.peakOrganisms).toFixed(2)),
    meanAge: Number(mean((o) => o.meanAge).toFixed(1)),
    recordAge: Number(mean((o) => o.recordAge).toFixed(1)),
    budded: Number(mean((o) => o.budded).toFixed(1)),
    maxGen: Number(mean((o) => o.maxGen).toFixed(2)),
    bestOrder: Number(mean((o) => o.bestOrder).toFixed(2)),
  }
})
console.log('')
console.table(summary)

if (out) {
  writeFileSync(out, JSON.stringify({ ...result, summary }, null, 2) + '\n')
  console.log(`\nwrote ${out}`)
}
