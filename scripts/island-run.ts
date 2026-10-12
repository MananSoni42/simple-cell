import { readFileSync, writeFileSync } from 'node:fs'
import { type IslandSpec, runIsland } from '../src/core/island'

/**
 * One island, in its own process. `vite-node scripts/island-run.ts <spec.json> <out.json>`.
 *
 * A process rather than a `worker_threads` worker because the worker entry would have to be
 * JavaScript — nothing transforms TypeScript inside a thread spawned from a script. A process
 * costs half a second to start, against runs of half a minute or more, and buys the same thing:
 * one whole world per core, no shared state, and a result identical to running it serially,
 * because each world is seeded and self-contained.
 */
const [specPath, outPath] = process.argv.slice(2)
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as IslandSpec
writeFileSync(outPath, JSON.stringify(runIsland(spec)))
