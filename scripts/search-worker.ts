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
const { specs, opts, seeds, phase, sources } = JSON.parse(readFileSync(jobsPath, 'utf8')) as {
  specs: WorldSpec[]
  opts: EvalOptions
  seeds: number
  phase: number
  sources?: CatalogEntry['source'][]
}

/**
 * Four significant figures on every number.
 *
 * A raw float costs seventeen bytes and carries about four digits of meaning: `score` arrives as
 * 7.329226211664039 when 7.329 is the whole of the claim. Over two hundred thousand worlds the
 * difference is some sixty megabytes of noise, and it makes the catalog unreadable besides.
 */
const trim = (v: unknown): unknown => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toPrecision(4))
  if (Array.isArray(v)) return v.map(trim)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)]))
  return v
}

specs.forEach((spec, i) => {
  const t0 = Date.now()
  const got = evaluateSeeds(spec, opts, seeds)
  const entry: CatalogEntry = { id: specId(spec), phase, ms: Date.now() - t0, at: Date.now(), source: sources?.[i], ...got }
  // one line per world, flushed as it finishes: a killed search keeps everything it had done
  appendFileSync(outPath, JSON.stringify(trim(entry)) + '\n')
})
