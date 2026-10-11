import { writeFileSync } from 'node:fs'
import { EQUIV, measure } from '../tests/equivalence'

/** Records per-metric mean and std over many seeds. Run before an "equivalent, not bit-exact" change. */
const out: Record<string, unknown> = {}
for (const c of EQUIV) out[c.name] = measure(c)
writeFileSync(new URL('../tests/baseline-stats.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
