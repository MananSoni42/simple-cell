import { appendFileSync, readFileSync } from 'node:fs'
import { type CatalogEntry, specId } from '../src/core/catalog'
import { type EvalOptions, evaluateSeeds } from '../src/core/evaluate'
import type { WorldSpec } from '../src/core/catalog'

/**
 * One shard of a search phase, in its own process.
 *
 * `vite-node scripts/search-worker.ts <jobs.json> <out.jsonl>`
 *
 * A process rather than a thread because nothing transforms TypeScript inside a worker spawned
 * from a script, and the unit of parallelism here is a whole world anyway — no shared state, so
 * the result is identical to running the batch serially. Each shard appends to **its own** file,
 * which is what makes concurrent writing safe without a lock: the parent concatenates afterwards.
 */
const [jobsPath, outPath] = process.argv.slice(2)
const { specs, opts, seeds, phase } = JSON.parse(readFileSync(jobsPath, 'utf8')) as {
  specs: WorldSpec[]
  opts: EvalOptions
  seeds: number
  phase: number
}

for (const spec of specs) {
  const t0 = Date.now()
  const got = evaluateSeeds(spec, opts, seeds)
  const entry: CatalogEntry = { id: specId(spec), phase, ms: Date.now() - t0, at: Date.now(), ...got }
  // one line per world, flushed as it finishes: a killed search keeps everything it had done
  appendFileSync(outPath, JSON.stringify(entry) + '\n')
}
