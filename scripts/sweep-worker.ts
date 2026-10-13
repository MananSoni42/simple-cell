import { appendFileSync, readFileSync } from 'node:fs'
import { EXPERIMENTS } from './experiments'

/**
 * One shard of a sweep, in its own process.
 *
 * `vite-node scripts/sweep-worker.ts <jobs.json> <out.jsonl>`
 *
 * A process rather than a thread, for the same reason the search uses processes: nothing transforms
 * TypeScript inside a worker spawned from a script, and the unit of parallelism here is a whole
 * world, which shares no state. The result is identical to running the jobs serially.
 *
 * Each shard appends to **its own** file, which is what makes concurrent writing safe with no lock.
 * One line per finished run, so a sweep killed halfway through still has everything it had done.
 */
const [jobsPath, outPath] = process.argv.slice(2)
const { experiment, jobs, ticks } = JSON.parse(readFileSync(jobsPath, 'utf8')) as {
  experiment: string
  jobs: { name: string; seed: number }[]
  ticks: number
}

const ex = EXPERIMENTS[experiment]
if (!ex) throw new Error(`no experiment "${experiment}"`)

for (const job of jobs) {
  const t0 = Date.now()
  try {
    const row = ex.run(job.name, job.seed, ticks)
    appendFileSync(outPath, `${JSON.stringify({ ...job, ms: Date.now() - t0, row })}\n`)
  } catch (err) {
    // one broken condition must not take the sweep down with it: record it and carry on, so the
    // other conditions still produce a table rather than nothing
    appendFileSync(outPath, `${JSON.stringify({ ...job, ms: Date.now() - t0, error: (err as Error).message })}\n`)
  }
}
