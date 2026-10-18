import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { type CatalogEntry, type WorldSpec, specId } from '../src/core/catalog'
import { evaluate } from '../src/core/evaluate'
import { HAND_BUILT, HAND_BUILT_NAMES } from '../src/core/handbuilt'

/**
 * The hand-built worlds, scored and written for the Discoveries page.
 *
 * These are **written, not found**, which is why they live in their own exporter rather than in the
 * search's. Every other entry on that page is something a search turned up; these are policies
 * built on purpose to establish that a rung can be passed at all — so they are prefixed `manual`
 * and labelled with what they were built to do and whether they managed it.
 *
 * They run through exactly the same `evaluate` the search uses, against exactly the same ladder, so
 * the numbers beside them mean what they mean everywhere else. And they carry `handBuilt` in their
 * spec, so opening one from the page runs the same policy the feasibility suite asserts on — there
 * is no second copy of these brains anywhere.
 *
 * usage: npx vite-node scripts/manual.ts [--ticks 9000]
 */
const args = process.argv.slice(2)
const flag = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const TICKS = Number(flag('ticks', '9000'))

/**
 * The world these are tested in: generous, so a policy's limits are its own rather than the
 * world's. `reproMut: 0` because inheritance with mutation turns a hand-built brain into a drifted
 * one — the descendants of an all-zero brain reached a commanded force of 0.77 and went on to pass
 * a rung, so the first run of all this was measuring drift rather than policy.
 */
const BASE: WorldSpec = {
  seed: 4242,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 60,
  matter: 300,
  metabolism: 0.5,
  bondFlow: 0.05,
  T: 2,
  foodMode: 'patchy',
  foodLevel: 'abundant',
  foodRegime: 'steady',
  patches: 3,
  radius: 60,
  foodLife: 400,
  fission: false,
  scale: 1,
  reproMut: 0,
}

/** A chemistry that bonds everything, for the policy whose rung needs structures to exist. */
const STICKY = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5]

const rows: CatalogEntry[] = []
for (const name of HAND_BUILT_NAMES) {
  const h = HAND_BUILT[name]
  const spec: WorldSpec = { ...BASE, handBuilt: name, ...(name === 'movesTogether' ? { A: STICKY } : {}) }
  const t0 = Date.now()
  const r = evaluate(spec, { ticks: TICKS, maxExtend: 1, plateauFrac: 0, every: 500 })
  const passed = r.ratios.filter((x) => x >= 1).length
  rows.push({
    id: specId(spec),
    spec,
    phase: -1, // not a search phase: these were written, and the page says so
    ms: Date.now() - t0,
    ticks: r.ticks,
    stop: r.stop,
    level: r.level,
    score: r.score,
    ratios: r.ratios,
    stats: r.stats,
    seeds: 1,
    at: Date.now(),
    source: undefined,
    // the two policies that are not built *for* a rung get named for what they are instead
    why: `manual · ${h.rung.startsWith('(none') ? h.rung.replace(/^\(none — (.*)\)$/, '$1') : `built for ${h.rung}`} — ${h.describe}`,
  })
  console.log(`${name.padEnd(15)} level ${String(r.level).padStart(2)} score ${r.score.toFixed(2).padStart(6)} · ${passed} rungs met · ${h.rung}`)
}

/*
 * No aggregate factor tables: a factor analysis over five hand-written worlds would be five
 * anecdotes with standard errors attached, which is worse than nothing. The page tolerates an
 * absent summary; it does not tolerate a misleading one.
 */
const out = {
  kind: 'simplecell-discoveries',
  at: Date.now(),
  worlds: rows.length,
  phases: [{ phase: -1, worlds: rows.length }],
  summary: null,
  analysedPhase: -1,
  top: rows.sort((a, b) => b.score - a.score),
}
if (!existsSync('public')) mkdirSync('public', { recursive: true })
writeFileSync('public/discoveries.json', JSON.stringify(out))
console.log(`\nwrote public/discoveries.json: ${rows.length} manual worlds`)
