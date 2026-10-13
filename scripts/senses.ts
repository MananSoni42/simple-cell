import type { WorldSpec } from '../src/core/catalog'
import { ladder } from '../src/core/ladder'
import { specInit } from '../src/core/catalog'
import { BRAIN_IN } from '../src/core/neurons'
import { LAWS } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * Do the new senses pay, and which of them?
 *
 * Four things changed together — the brain can count food around it, feel its own motion, read
 * its limbs' angles and its bonds, and food became heavy — and four complementary changes made at
 * once are four changes none of which is attributable. So each is turned *off* here against an
 * otherwise identical world: the senses through the ablation seam (`blind`), the physics through
 * a law override. Blinding an input is not the same as removing it — the weights are still drawn
 * for it, so the random prior is identical and the comparison is clean at a seed.
 *
 * Several seeds per condition, reported as a mean with a standard error, because this world is
 * heavy-tailed and a single run is an anecdote. Read nothing from a gap inside two SE.
 *
 * usage: npx vite-node scripts/senses.ts [ticks] [seeds]
 */
const base: WorldSpec = {
  seed: 4242,
  A: [0.5, -0.5, 0.5, 0, 0.25, 0.5, 1, 0, 0.5, -0.25, 0.5, 1, 0.25, 0.5],
  slots: 150,
  matter: 700,
  metabolism: 0.5,
  bondFlow: 0.05,
  T: 2,
  foodMode: 'patchy',
  foodLevel: 'average',
  foodRegime: 'steady',
  patches: 2,
  radius: 50,
  foodLife: 250,
  fission: true,
  scale: 1,
}

const SOCKET_ANGLES = [0, 1, 2, 3].map((s) => s * BRAIN_IN.SOCKET_W + 7)
const SOCKET_BONDS = [0, 1, 2, 3].map((s) => s * BRAIN_IN.SOCKET_W + 6)
const NEW_SENSES = [BRAIN_IN.FOOD_NEAR, BRAIN_IN.VEL_X, BRAIN_IN.VEL_Y, BRAIN_IN.BOND_LOAD, ...SOCKET_ANGLES, ...SOCKET_BONDS]

interface Case {
  name: string
  blind?: number[]
  /** Food's mobility as a fraction of everything else's; the default is the new law. */
  mu_food?: number
  /** Food has to move for its mobility to mean anything. */
  foodMoves?: boolean
}

const cases: Case[] = [
  { name: 'everything on' },
  { name: '− food count', blind: [BRAIN_IN.FOOD_NEAR] },
  { name: '− own motion', blind: [BRAIN_IN.VEL_X, BRAIN_IN.VEL_Y] },
  { name: '− own body', blind: [...SOCKET_ANGLES, ...SOCKET_BONDS, BRAIN_IN.BOND_LOAD] },
  { name: '− all new senses', blind: NEW_SENSES },
  { name: 'drifting food, heavy', foodMoves: true },
  { name: 'drifting food, light', foodMoves: true, mu_food: 1 },
  { name: 'drifting food, light, blind', foodMoves: true, mu_food: 1, blind: NEW_SENSES },
]

const TICKS = Number(process.argv[2] ?? 20000)
const SEEDS = Number(process.argv[3] ?? 5)

interface Row {
  fed: number
  lasts: number
  seeks: number
  order: number
  held: number
  score: number
  alive: number
  wasted: number
}

function run(c: Case, seed: number): Row {
  const spec = { ...base, seed }
  const init = specInit(spec)
  if (c.foodMoves !== undefined) init.foodMoves = c.foodMoves
  const w = new World(init, { blind: c.blind, laws: c.mu_food !== undefined ? { mu_food: c.mu_food } : {} })
  for (let t = 0; t < TICKS; t++) {
    w.step()
    if (t % 1000 === 0) ladder(w) // the ladder is windowed, so it has to be read as the world runs
  }
  const l = ladder(w)
  const by = (n: string): number => l.rungs.find((r) => r.name === n)?.ratio ?? 0
  const o = w.orders.stats(w)
  let alive = 0
  for (let b = w.nIntr; b < w.nMatter; b++) if (w.alive[b] && w.isBrain(b)) alive++
  return {
    fed: by('Feeds'),
    lasts: by('Lasts') * 2,
    seeks: by('Seeks') * 0.25,
    order: o.oldest?.order ?? 0,
    held: o.oldest?.heldFrac ?? 0,
    score: l.score,
    alive,
    wasted: w.lightWasted,
  }
}

const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length)
const se = (xs: number[]): number => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length)
}
const pm = (xs: number[], dp = 2): string => `${mean(xs).toFixed(dp)}±${se(xs).toFixed(dp)}`

console.log(`${TICKS.toLocaleString()} ticks × ${SEEDS} seeds per condition · mu_food default ${LAWS.mu_food}\n`)
console.log(`${'condition'.padEnd(28)} ${'fed'.padEnd(13)} ${'lasts (coasts)'.padEnd(15)} ${'seeks'.padEnd(14)} ${'order'.padEnd(12)} score`)
const results: { name: string; rows: Row[] }[] = []
for (const c of cases) {
  const rows: Row[] = []
  for (let k = 0; k < SEEDS; k++) rows.push(run(c, base.seed + k * 7919))
  results.push({ name: c.name, rows })
  const col = (f: (r: Row) => number, dp = 2): string => pm(rows.map(f), dp)
  console.log(
    `${c.name.padEnd(28)} ${col((r) => r.fed).padEnd(13)} ${col((r) => r.lasts).padEnd(15)} ` +
      `${col((r) => r.seeks, 3).padEnd(14)} ${col((r) => r.order, 1).padEnd(12)} ${col((r) => r.score, 1)}`,
  )
}

// the comparisons the script exists to make, stated rather than left to the reader
const find = (n: string): Row[] => results.find((r) => r.name === n)!.rows
const gap = (a: string, b: string, f: (r: Row) => number): string => {
  const xa = find(a).map(f)
  const xb = find(b).map(f)
  const d = mean(xa) - mean(xb)
  const s = Math.sqrt(se(xa) ** 2 + se(xb) ** 2)
  return `${d >= 0 ? '+' : ''}${d.toFixed(3)} (${s > 0 ? `${Math.abs(d / s).toFixed(1)} SE` : 'single seed'})${Math.abs(d) < 2 * s ? ' — within noise' : ''}`
}
console.log('\nevery new sense vs none of them')
for (const [k, f] of [['fed', (r: Row) => r.fed], ['lasts', (r: Row) => r.lasts], ['seeks', (r: Row) => r.seeks], ['score', (r: Row) => r.score]] as const) {
  console.log(`  ${k.padEnd(8)} ${gap('everything on', '− all new senses', f)}`)
}
console.log('\nheavy food vs light, with drifting food')
for (const [k, f] of [['fed', (r: Row) => r.fed], ['seeks', (r: Row) => r.seeks], ['score', (r: Row) => r.score]] as const) {
  console.log(`  ${k.padEnd(8)} ${gap('drifting food, heavy', 'drifting food, light', f)}`)
}
