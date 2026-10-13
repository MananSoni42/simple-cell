import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { census } from '../src/core/metrics'
import { describeSpec, specFromKeys } from '../src/core/fitness'
import { type ArchipelagoPlan, type IslandResult, type IslandSpec, islandSpecs, mergeIslands, runIsland } from '../src/core/island'
import { LEARN_DEFAULTS } from '../src/core/learning'
import { type Init, applyFoodLevel, initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * Four islands in parallel, then one world where their products meet.
 *
 * usage:
 *   npm run archipelago -- [--ticks 100000] [--merge 100000] [--seed 4242] [--scale 2]
 *                          [--converge 75000] [--serial] [--out world.json]
 *
 * `--merge 0` writes the merged world without simulating it, which is usually what you want: the
 * islands run four-at-a-time across cores, but the merge is **one world** and cannot be split that
 * way — the only parallelism inside a single world is its force kernel across threads, worth about
 * 2×. A 1200² merged world costs about 4 ms a tick, so 100k ticks is seven minutes of wall clock
 * whatever else is true. Watching it in the browser is both faster to start and more informative.
 *
 * Four worlds that share a chemistry and differ in food and in what their learner optimises run
 * one per thread; their survivors are then placed at the centres of the four quadrants of a world
 * twice as wide, with food colonies that migrate inward so that hunger drives the populations
 * together. The merged world has no learner: what happens there is the world adjudicating between
 * four stated preferences.
 *
 * What to watch for, and what cannot happen: population **share** can converge (one island's stock
 * displacing the others) and organisms from different islands can **bond** to each other. Their
 * *lines* cannot converge — reproduction here is asexual budding, so there is no gene flow however
 * long they mix.
 */

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name: string): boolean => args.includes(`--${name}`)

const ticks = Number(flag('ticks', '100000'))
const mergeTicks = Number(flag('merge', '100000'))
const seed = Number(flag('seed', '4242'))
const scale = Number(flag('scale', '2'))
// how long the colonies take to close once released; independent of the analysis length, since
// --merge 0 writes a world to be watched rather than simulated and still needs a sane approach
const convergeTicks = Number(flag('converge', String(Math.max(5000, Math.round(mergeTicks * 0.75)))))
const out = flag('out', 'archipelago-world.json')
const serial = has('serial')

/** The shared world. Chemistry, terrain and temperature are the same for every island. */
function base(): Init {
  const init = initFromSeed(seed, scale)
  init.walls = 'none'
  init.n_wall = 0
  init.wallPositions = []
  init.bonds = true
  init.repro = true
  init.n_brain = 12 * scale * scale
  init.n_start = 4 * scale * scale
  init.n_intrinsic = 120 * scale * scale
  init.T_spawn = 40
  init.food_life = 250
  init.learn = { ...LEARN_DEFAULTS, warmup: Math.round(ticks * 0.05), batch: 12, pool: 24, share: 1 }
  return applyFoodLevel(init)
}

/**
 * Four islands, differing in the two ways that shape behaviour: the world they live in and what
 * counts as doing well there. CEM throughout, since it is the only algorithm measured to work
 * (docs/LEARNING.md §0) — differences between islands should come from the question asked, not from
 * three of them having a learner that does nothing.
 */
const plan: ArchipelagoPlan = {
  base: base(),
  ticks,
  convergeTicks,
  islands: [
    { name: 'breeders', foodMode: 'patchy', foodLevel: 'average', foodRegime: 'steady', algo: 'cem', fitness: specFromKeys(['offspring']), seed: seed + 1 },
    { name: 'foragers', foodMode: 'spring', foodLevel: 'scarce', foodRegime: 'steady', algo: 'cem', fitness: specFromKeys(['efficiency']), seed: seed + 2 },
    { name: 'joiners', foodMode: 'breathing', foodLevel: 'average', foodRegime: 'steady', algo: 'cem', fitness: specFromKeys(['together']), seed: seed + 3 },
    { name: 'endurers', foodMode: 'patchy', foodLevel: 'average', foodRegime: 'cycle', algo: 'cem', fitness: specFromKeys(['lifespan']), seed: seed + 4 },
  ],
}

const scratch = mkdtempSync(join(tmpdir(), 'archipelago-'))

/** One island per process, all four at once: the unit of parallelism is a whole run. */
function inProcess(spec: IslandSpec): Promise<IslandResult> {
  const specPath = join(scratch, `island-${spec.id}.json`)
  const outPath = join(scratch, `result-${spec.id}.json`)
  writeFileSync(specPath, JSON.stringify(spec))
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite-node', 'scripts/island-run.ts', specPath, outPath], { stdio: ['ignore', 'ignore', 'inherit'] })
    p.on('error', reject)
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`island ${spec.id} exited ${code}`))
      resolve(JSON.parse(readFileSync(outPath, 'utf8')) as IslandResult)
    })
  })
}

const specs = islandSpecs(plan)
console.log(`four islands × ${ticks.toLocaleString()} ticks at ${plan.base.size}² — ${serial ? 'serially' : 'one per thread'}`)
for (const s of specs) {
  const i = plan.islands[s.id - 1]
  console.log(`  ${s.id}. ${s.name.padEnd(9)} ${s.init.foodMode}/${s.init.foodLevel}/${s.init.foodRegime} · optimising ${describeSpec(i.fitness)}`)
}

const t0 = Date.now()
const results: IslandResult[] = serial ? specs.map(runIsland) : await Promise.all(specs.map(inProcess))
const islandSecs = (Date.now() - t0) / 1000
console.log(`\nislands done in ${islandSecs.toFixed(1)}s`)

console.table(
  results.map((r) => ({
    island: r.name,
    optimising: r.measure,
    food: r.foodMode,
    survivors: r.census.organisms,
    born: r.census.births,
    bred: r.census.budded,
    gen: r.census.maxGen,
    oldest: r.census.recordAge,
    'learner best': r.learner ? Number(r.learner.best.toFixed(3)) : '—',
    'lives scored': r.learner ? r.learner.seen : 0,
  })),
)

const empty = results.filter((r) => r.diedOut)
if (empty.length) console.log(`\n${empty.length} island(s) died out: ${empty.map((r) => r.name).join(', ')} — this is a merge of ${4 - empty.length}`)

// ---------------------------------------------------------------- the merge
const merged = mergeIslands(plan, results, 2)
writeFileSync(out, JSON.stringify({ version: 1, init: merged }, null, 2) + '\n')
console.log(
  `\nmerged world: ${merged.size}² · ${merged.seededOrganisms.length} organisms placed · ` +
    `colonies meet by tick ${merged.converge_ticks.toLocaleString()} · written to ${out}`,
)

// ---------------------------------------------------------------- what happens
if (mergeTicks <= 0) {
  console.log('\n--merge 0: the world is written but not simulated. Open it from the picker to watch.')
  process.exit(0)
}

const w = new World(merged)
// the file is written held so it can be released by hand in the browser; the headless analysis
// wants the whole arc, so it releases immediately
w.beginMerge()
// measure before committing: the cost of one tick here is knowable, so an eight-minute run should
// announce itself rather than appear to hang
{
  const warm = performance.now()
  for (let i = 0; i < 200; i++) w.step()
  const ms = (performance.now() - warm) / 200
  console.log(
    `simulating the merge: ${ms.toFixed(2)} ms/tick at ${merged.size}² → about ` +
      `${Math.round((mergeTicks * ms) / 1000)}s for ${mergeTicks.toLocaleString()} ticks. ` +
      `This part is one world and cannot be parallelised; --merge 0 skips it.`,
  )
}
const names = ['native', ...results.map((r) => r.name)]
const rows: Record<string, unknown>[] = []
const sample = Math.max(1, Math.round(mergeTicks / 10))
let crossSeen = 0
let firstCross = -1

for (let t = 0; t <= mergeTicks; t++) {
  if (t % sample === 0) {
    const c = census(w)
    const total = Math.max(1, c.organisms)
    // Shannon entropy over island shares, in bits: 2 bits is four equal populations, 0 is one left
    let h = 0
    for (const n of c.islands) {
      if (n <= 0) continue
      const p = n / total
      h -= p * Math.log2(p)
    }
    rows.push({
      tick: t,
      organisms: c.organisms,
      ...Object.fromEntries(c.islands.map((n, i) => [names[i] ?? `i${i}`, n])),
      'cross bonds': c.crossBonds,
      'diversity (bits)': Number(h.toFixed(2)),
      // the largest compound *standing right now*, not the run-wide record: a running max
      // printed per sample looks static and says nothing about the merge
      joined: (() => {
        const live = w.orders.stats(w).live
        for (let k = live.length; k >= 2; k--) if (live[k - 1] > 0) return k
        return 0
      })(),
    })
  }
  if (t < mergeTicks) {
    w.step()
    // a census walks every slot, so checking contact every tick would cost more than the world;
    // every 200 is dense enough to catch the first crossing within a fraction of a percent
    if (t % 200 === 0) {
      const c = census(w).crossBonds
      if (c > 0) {
        crossSeen = Math.max(crossSeen, c)
        if (firstCross < 0) firstCross = t
      }
    }
  }
}

console.log('\nthe merged world, every 10% of the run:')
console.table(rows)
const end = census(w)
console.log(
  `\nfinal: ${end.organisms} organisms · shares ${end.islands.map((n, i) => `${names[i] ?? i}:${n}`).join(' ')} · ` +
    `cross-island bonds peaked at ${crossSeen}${firstCross >= 0 ? ` (first at tick ${firstCross.toLocaleString()})` : ' — no contact'}` +
    ` · largest compound ever ${w.orders.stats(w).bestOrder}`,
)
console.log(`\nopen ${out} from the picker's import to watch it. total ${((Date.now() - t0) / 1000).toFixed(0)}s`)
