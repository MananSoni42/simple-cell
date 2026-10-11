import { writeFileSync } from 'node:fs'
import { GOLDEN, runGolden } from '../tests/golden'

const out: Record<string, unknown> = {}
for (const c of GOLDEN) out[c.name] = runGolden(c)
writeFileSync(new URL('../tests/golden.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log('wrote tests/golden.json', out)
