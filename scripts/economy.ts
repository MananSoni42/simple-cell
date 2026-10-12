import { type Laws, applyFoodLevel, initFromSeed, type FoodLevel, type Init } from '../src/core/params'
import { census } from '../src/core/metrics'
import { World } from '../src/core/world'

/**
 * What the energy economy does to lifespan and to complexity.
 *
 * usage: npm run economy -- [--ticks 20000] [--seeds 5]
 *
 * The question this answers is whether a world can be made to support organisms that live *longer*
 * and get *more complex*, and which dial moves which. Food supply and metabolism are swept
 * independently because they are not the same lever: more food raises the ceiling on how many can
 * live, while a slower metabolism raises the ceiling on how long any one of them can.
 *
 * Laws are overridden per run rather than edited, so nothing here changes the world anyone else
 * gets — `new World(init, { laws })` is the seam that exists for exactly this.
 */

const args = process.argv.slice(2)
const flag = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const ticks = Number(flag('ticks', '20000'))
const nSeeds = Number(flag('seeds', '5'))

interface Variant {
  name: string
  /** Multiplier on every per-tick cost: upkeep, movement, signalling. */
  metabolism?: number
  food?: FoodLevel
  /** How much a particle may bank. The ceiling on riding out a famine. */
  cap?: number
  /** Loose-matter decay, which takes about seven times more of the budget than bodies do. */
  decay?: number
  /** What a newborn is given per particle. */
  birth?: number
  /** Brain slots: the hard ceiling on how many organisms can exist at once. */
  slots?: number
}

const VARIANTS: Variant[] = [
  { name: 'baseline' },
  { name: 'food ×scarce', food: 'scarce' },
  { name: 'food ×abundant', food: 'abundant' },
  { name: 'metabolism 0.25', metabolism: 0.25 },
  { name: 'metabolism 0.5', metabolism: 0.5 },
  { name: 'metabolism 2', metabolism: 2 },
  { name: 'bank 300', cap: 300 },
  { name: 'bank 1000', cap: 1000 },
  { name: 'no loose decay', decay: 0 },
  { name: 'rich newborns 40', birth: 40 },
  { name: 'slow + abundant', metabolism: 0.25, food: 'abundant' },
  { name: 'slow + bank', metabolism: 0.25, cap: 1000 },
  { name: 'slow + abundant + bank', metabolism: 0.25, food: 'abundant', cap: 1000 },
  // the hypothesis the first sweep suggested: with only ten brain slots the population pins at the
  // cap, so every birth needs a death and living longer is in direct conflict with breeding at all
  { name: 'slots 40', slots: 40 },
  { name: 'slots 40 + abundant', slots: 40, food: 'abundant' },
  { name: 'slots 40 + slow', slots: 40, metabolism: 0.25 },
  { name: 'slots 40 + slow + abundant', slots: 40, metabolism: 0.25, food: 'abundant' },
  { name: 'slots 80 + slow + abundant', slots: 80, metabolism: 0.25, food: 'abundant' },
]

interface Row {
  variant: string
  lifeMean: number
  lifeP90: number
  oldest: number
  popMean: number
  popCV: number
  limbs: number
  joined: number
  bestOrder: number
  maxGen: number
  diedOut: number
}

function world(seed: number, v: Variant): Init {
  const init = initFromSeed(seed, 1)
  init.foodMode = 'patchy'
  init.foodLevel = v.food ?? 'average'
  init.foodRegime = 'steady'
  init.n_patch = 2
  init.r_patch = 50
  init.food_life = 250
  init.n_brain = v.slots ?? 10
  init.n_start = 4
  // four particles per brain slot plus a loose pool, so slots are never starved of bodies to use
  init.n_intrinsic = 140 + 5 * Math.max(0, (v.slots ?? 10) - 10)
  init.T_spawn = 25
  init.bonds = true
  init.repro = true
  if (v.decay !== undefined) init.decay_free = v.decay
  return applyFoodLevel(init)
}

function laws(v: Variant): Partial<Laws> {
  const m = v.metabolism ?? 1
  const L: Partial<Laws> = { c_up: 0.02 * m, c_mv: 0.1 * m, c_sig: 0.01 * m }
  if (v.cap !== undefined) L.E_cap = v.cap
  if (v.birth !== undefined) L.E_birth = v.birth
  return L
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const a = [...xs].sort((p, q) => p - q)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** One world, measured for how long things live and how complicated they get. */
function measure(seed: number, v: Variant): Omit<Row, 'variant'> {
  const w = new World(world(seed, v), { laws: laws(v) })
  const lives: number[] = []
  const pops: number[] = []
  const limbs: number[] = []
  let joinedSamples = 0
  let samples = 0
  let maxGen = 0
  const wasAlive = new Uint8Array(w.cap)
  const isBrain = (b: number): boolean => w.alive[b] === 1 && w.isBrain(b)
  for (let b = w.nIntr; b < w.nMatter; b++) if (isBrain(b)) wasAlive[b] = 1

  for (let t = 0; t < ticks; t++) {
    w.step()
    for (let b = w.nIntr; b < w.nMatter; b++) {
      const now = isBrain(b)
      if (now) maxGen = Math.max(maxGen, w.gen[b])
      else if (wasAlive[b]) lives.push(w.tick - w.bornAt[b])
      wasAlive[b] = now ? 1 : 0
    }
    if (t % 200 === 0) {
      const c = census(w)
      pops.push(c.organisms)
      if (c.organisms > 0) limbs.push(c.limbs / c.organisms)
      const live = w.orders.stats(w).live
      let top = 0
      for (let k = live.length; k >= 2; k--) if (live[k - 1] > 0) { top = k; break }
      if (top >= 2) joinedSamples++
      samples++
    }
  }
  const popMean = pops.reduce((a, b) => a + b, 0) / Math.max(1, pops.length)
  const sd = Math.sqrt(pops.reduce((a, b) => a + (b - popMean) ** 2, 0) / Math.max(1, pops.length))
  const sorted = [...lives].sort((a, b) => a - b)
  return {
    lifeMean: lives.length ? lives.reduce((a, b) => a + b, 0) / lives.length : 0,
    lifeP90: sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0,
    oldest: w.recordAge,
    popMean,
    popCV: popMean > 0 ? sd / popMean : 0,
    limbs: limbs.length ? limbs.reduce((a, b) => a + b, 0) / limbs.length : 0,
    joined: samples ? joinedSamples / samples : 0,
    bestOrder: w.orders.stats(w).bestOrder,
    maxGen,
    diedOut: census(w).organisms === 0 ? 1 : 0,
  }
}

const seeds = Array.from({ length: nSeeds }, (_, i) => 3000 + i * 11)
console.log(`${VARIANTS.length} variants × ${nSeeds} seeds × ${ticks.toLocaleString()} ticks · medians over seeds\n`)
const rows: Row[] = []
for (const v of VARIANTS) {
  const got = seeds.map((s) => measure(s, v))
  rows.push({
    variant: v.name,
    lifeMean: Math.round(median(got.map((g) => g.lifeMean))),
    lifeP90: Math.round(median(got.map((g) => g.lifeP90))),
    oldest: Math.round(median(got.map((g) => g.oldest))),
    popMean: Number(median(got.map((g) => g.popMean)).toFixed(1)),
    popCV: Number(median(got.map((g) => g.popCV)).toFixed(2)),
    limbs: Number(median(got.map((g) => g.limbs)).toFixed(2)),
    joined: Number(median(got.map((g) => g.joined)).toFixed(2)),
    bestOrder: Math.round(median(got.map((g) => g.bestOrder))),
    maxGen: Math.round(median(got.map((g) => g.maxGen))),
    diedOut: got.reduce((a, g) => a + g.diedOut, 0),
  })
  const r = rows[rows.length - 1]
  process.stdout.write(`${r.variant.padEnd(24)} life ${String(r.lifeMean).padStart(5)} · oldest ${String(r.oldest).padStart(6)} · pop ${String(r.popMean).padStart(5)} · joined ${r.joined}\n`)
}
console.log('')
console.table(rows)
console.log(
  '\nlife/lifeP90 = mean and 90th percentile of completed lifespans · oldest = longest single life\n' +
    'popCV = how much the population swings (lower is steadier) · limbs = mean limbs per organism\n' +
    'joined = fraction of samples with any compound of 2+ · diedOut = seeds that emptied out',
)
