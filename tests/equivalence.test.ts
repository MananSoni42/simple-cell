import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EQUIV, METRICS, measure, type Metric, type Stat } from './equivalence'

const file = new URL('./baseline-stats.json', import.meta.url)

describe.skipIf(!existsSync(file))('statistical equivalence with the recorded baseline', () => {
  const base: Record<string, Record<Metric, Stat>> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  for (const c of EQUIV) {
    it(`${c.name}: every metric's mean is within sampling error of the baseline`, () => {
      const now = measure(c)
      for (const m of METRICS) {
        const a = base[c.name][m]
        const b = now[m]
        // difference of two means; 4 standard errors, plus a little slack for discrete metrics
        const se = Math.sqrt((a.std ** 2) / a.n + (b.std ** 2) / b.n)
        const tol = 4 * se + 0.05 * Math.max(1, Math.abs(a.mean))
        expect(Math.abs(a.mean - b.mean), `${c.name}.${m}: baseline ${a.mean.toFixed(2)}±${a.std.toFixed(2)}, now ${b.mean.toFixed(2)}±${b.std.toFixed(2)}`).toBeLessThanOrEqual(tol)
      }
    }, 120_000)
  }
})
