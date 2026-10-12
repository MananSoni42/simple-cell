import { type Init, type Laws, applyFoodLevel, initFromSeed } from '../src/core/params'
import { census } from '../src/core/metrics'
import { World } from '../src/core/world'

/**
 * Did stages 1-3 do anything? Paired runs on identical seeds, old laws against new.
 *
 * The old world is recovered by overriding the laws back, which is why `WorldOpts.laws` exists —
 * so a change of this size can be measured rather than believed.
 */
const ticks = Number(process.argv[2] ?? 20000)
const nSeeds = Number(process.argv[3] ?? 5)

const OLD: Partial<Laws> = { max_bonds: 2, F_break: 4, repro_dist: 42 }

interface V { name: string; laws?: Partial<Laws>; metabolism?: number; flow?: number; oldInit?: boolean }
const VARIANTS: V[] = [
  { name: 'before (all old)', laws: OLD, metabolism: 1, flow: 0, oldInit: true },
  { name: '+ bonds 4, break 2.5', laws: { repro_dist: 42 }, metabolism: 1, flow: 0, oldInit: true },
  { name: '+ repro_dist 28', metabolism: 1, flow: 0, oldInit: true },
  { name: '+ metabolism 0.5', metabolism: 0.5, flow: 0, oldInit: true },
  { name: '+ new brain init', metabolism: 0.5, flow: 0 },
  { name: '+ bond flow 0.05 (all)', metabolism: 0.5, flow: 0.05 },
  { name: 'flow 0.2', metabolism: 0.5, flow: 0.2 },
  { name: 'break 3 not 2.5', laws: { F_break: 3 }, metabolism: 0.5, flow: 0.05 },
  { name: 'break 4 (old glue)', laws: { F_break: 4 }, metabolism: 0.5, flow: 0.05 },
  { name: 'all + slots 40', metabolism: 0.5, flow: 0.05 },
  { name: 'all + slots 40 + break 4', laws: { F_break: 4 }, metabolism: 0.5, flow: 0.05 },
]

function world(seed: number, v: V, slots = 10): Init {
  const init = initFromSeed(seed, 1)
  init.foodMode = 'patchy'
  init.foodLevel = 'average'
  init.foodRegime = 'steady'
  init.n_patch = 2
  init.r_patch = 50
  init.food_life = 250
  init.n_brain = slots
  init.n_start = 4
  init.n_intrinsic = 140 + 5 * Math.max(0, slots - 10)
  init.T_spawn = 25
  init.metabolism = v.metabolism ?? 0.5
  init.bond_flow = v.flow ?? 0.05
  return applyFoodLevel(init)
}

/** The old initialisation, so its effect can be isolated from everything else. */
function oldWeights(w: World): void {
  const rng = (w as unknown as { rng: { gauss(): number } }).rng
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.alive[b] || !w.isBrain(b)) continue
    const wb = w.wBrain[b]
    const wl = w.wLimb[b]
    if (wb) for (let i = 0; i < wb.length; i++) wb[i] = 0.5 * rng.gauss()
    if (wl) for (let i = 0; i < wl.length; i++) wl[i] = rng.gauss()
  }
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((p, q) => p - q)
  const m = a.length >> 1
  return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : 0
}

const rows: Record<string, unknown>[] = []
for (const v of VARIANTS) {
  const slots = v.name.includes('slots 40') ? 40 : 10
  const got = Array.from({ length: nSeeds }, (_, s) => {
    const init = world(4000 + s * 13, v, slots)
    const w = new World(init, { laws: v.laws })
    if (v.oldInit) oldWeights(w)
    const lives: number[] = []
    const wasAlive = new Uint8Array(w.cap)
    const live = (b: number) => w.alive[b] === 1 && w.isBrain(b)
    for (let b = w.nIntr; b < w.nMatter; b++) if (live(b)) wasAlive[b] = 1
    let joined = 0
    let samples = 0
    let harvest = 0
    let span = 0
    let maxGen = 0
    for (let t = 0; t < ticks; t++) {
      w.step()
      for (let b = w.nIntr; b < w.nMatter; b++) {
        const now = live(b)
        if (now) maxGen = Math.max(maxGen, w.gen[b])
        else if (wasAlive[b]) {
          const age = w.tick - w.bornAt[b]
          lives.push(age)
          harvest += w.harvested[b]
          span += age
        }
        wasAlive[b] = now ? 1 : 0
      }
      if (t % 200 === 0) {
        const o = w.orders.stats(w).live
        for (let k = o.length; k >= 2; k--) if (o[k - 1] > 0) { joined++; break }
        samples++
      }
    }
    const sorted = lives.sort((a, b) => a - b)
    return {
      p90: sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0,
      oldest: w.recordAge,
      bonds: w.bonds.count,
      bestOrder: w.orders.stats(w).bestOrder,
      joined: samples ? joined / samples : 0,
      perTick: span > 0 ? harvest / span : 0,
      pop: census(w).organisms,
      maxGen,
      ledger: Math.abs(w.totalEnergy() + w.burned - w.initialEnergy - w.injected),
    }
  })
  rows.push({
    variant: v.name,
    p90: Math.round(median(got.map((g) => g.p90))),
    oldest: Math.round(median(got.map((g) => g.oldest))),
    'harvest/tick': Number(median(got.map((g) => g.perTick)).toFixed(4)),
    bonds: Math.round(median(got.map((g) => g.bonds))),
    order: Math.round(median(got.map((g) => g.bestOrder))),
    joined: Number(median(got.map((g) => g.joined)).toFixed(2)),
    pop: Math.round(median(got.map((g) => g.pop))),
    gen: Math.round(median(got.map((g) => g.maxGen))),
    'ledger err': Number(Math.max(...got.map((g) => g.ledger)).toFixed(9)),
  })
  const r = rows[rows.length - 1]
  console.log(`${String(r.variant).padEnd(24)} p90 ${String(r.p90).padStart(5)} · oldest ${String(r.oldest).padStart(6)} · harvest/tick ${r['harvest/tick']} · order ${r.order} · bonds ${r.bonds} · joined ${r.joined}`)
}
console.log('')
console.table(rows)
