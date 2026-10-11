import type { Init } from './params'
import { type Metric, type RunRecord } from './recorder'

/**
 * Turns a recorded run into sentences. Each rule has a threshold and says nothing unless the
 * data actually clears it, so an uneventful run honestly reports that it was uneventful rather
 * than being dressed up. Every number quoted here comes straight off the record.
 */

const pct = (v: number): string => `${Math.round(v * 100)}%`
const n = (v: number): string => Math.round(v).toLocaleString('en-US')
const plural = (v: number, one: string, many = one + 's'): string => `${n(v)} ${Math.round(v) === 1 ? one : many}`

function mean(a: Float64Array, from: number, to: number): number {
  let sum = 0
  let k = 0
  for (let i = from; i < to; i++) {
    if (!Number.isFinite(a[i])) continue
    sum += a[i]
    k++
  }
  return k > 0 ? sum / k : NaN
}

function trend(r: RunRecord, m: Metric): { first: number; last: number } {
  const a = r.series[m]
  const third = Math.max(1, Math.floor(r.n / 3))
  return { first: mean(a, 0, third), last: mean(a, r.n - third, r.n) }
}

export function observe(r: RunRecord, init: Init): string[] {
  const out: string[] = []
  const f = r.final
  if (r.ticks < 50) return ['The run was too short to say anything about.']

  // --- population shape
  const pop = trend(r, 'organisms')
  const peak = r.peaks.organisms
  if (peak.value >= 2 && peak.tick > r.ticks * 0.1 && peak.value > pop.last * 1.6) {
    out.push(
      `The population <b>peaked at ${n(peak.value)}</b> around tick ${n(peak.tick)}, then fell to about ${n(pop.last)} — it overshot what the food could keep alive.`,
    )
  } else if (Number.isFinite(pop.first) && pop.last > pop.first * 1.5 && pop.last >= 2) {
    out.push(`The population <b>grew steadily</b>, from about ${n(pop.first)} organisms early on to ${n(pop.last)} by the end.`)
  } else if (f.organisms === 0) {
    out.push(`<b>Everything died.</b> The last organism was gone by the end of the run, after ${n(f.deaths)} deaths in total.`)
  } else if (Number.isFinite(pop.first) && Math.abs(pop.last - pop.first) < Math.max(1, pop.first * 0.2)) {
    out.push(`The population <b>held steady</b> at around ${n(pop.last)} organisms — births and deaths stayed in balance.`)
  }

  // --- turnover
  if (f.deaths > 0 && f.births > 0) {
    const life = f.lifeOrganisms
    if (Number.isFinite(life) && life > 0) {
      const generations = r.ticks / life
      if (generations > 8) {
        out.push(
          `Life was <b>cheap and fast</b>: ${n(f.births)} organisms were born and ${n(f.deaths)} died, averaging ${n(life)} ticks each — about ${Math.round(generations)} lifetimes over the run.`,
        )
      } else if (f.recordAge > life * 4) {
        out.push(
          `Most organisms died young (${n(life)} ticks on average) but <b>one lasted ${n(f.recordAge)}</b> — more than four times the average.`,
        )
      }
    }
  }

  // --- reproduction and lineage
  if (f.budded > 0) {
    out.push(
      `<b>${n(f.budded)} of ${n(f.births)} births were offspring</b> rather than fresh spawns, reaching generation ${n(f.peakGen)}${f.maxChildren > 1 ? `, and one organism had ${plural(f.maxChildren, 'child', 'children')}` : ''}.`,
    )
  } else if (init.repro) {
    out.push('Reproduction was on, but <b>nothing ever bred</b> — no organism held enough energy long enough to pay for a child.')
  }
  if (f.lineages === 1 && f.organisms > 1) {
    out.push(`Everything alive at the end <b>came from a single lineage</b> — ${plural(f.organisms, 'organism')}, one ancestor.`)
  } else if (f.biggestLineage > 2 && f.lineages > 1) {
    out.push(`The largest surviving lineage held <b>${n(f.biggestLineage)} of ${plural(f.organisms, 'organism')}</b>, across ${plural(f.lineages, 'lineage')} in all.`)
  }

  // --- togetherness
  if (f.bestOrder >= 2) {
    const held = f.ordersHeld.reduce((a, b, i) => (i > 0 ? a + b : a), 0)
    out.push(
      `Organisms <b>joined up</b>: the largest compound reached <b>order ${f.bestOrder}</b> and held for ${n(f.bestOrderAge)} ticks${held > 0 ? `, and ${n(held)} compound${held === 1 ? '' : 's'} lasted long enough to count as stable` : ', though none lasted long enough to count as stable'}.`,
    )
  } else if (init.bonds && r.peaks.bonds.value > 0) {
    out.push(
      `Particles bonded — up to <b>${n(r.peaks.bonds.value)} bonds at once</b> — but no two organisms ever held together long enough to form a compound.`,
    )
  } else if (init.bonds) {
    out.push(`Bonding was on, but <b>nothing ever bonded</b>: no two particles with attractive chemistry stayed close enough for long enough.`)
  }

  // --- the energy economy
  // the ledger is energy + burned = initial + injected, so the denominator is both sources
  const totalIn = f.initialEnergy + f.injected
  if (totalIn > 0) {
    out.push(
      `Of the ${n(totalIn)} energy that ever existed here — ${n(f.initialEnergy)} to begin with and ${n(f.injected)} arriving since — <b>${pct(f.burned / totalIn)} was burned</b> and ${pct(f.energy / totalIn)} was still held at the end.`,
    )
  }
  const foodTrend = trend(r, 'food')
  if (Number.isFinite(foodTrend.first) && Number.isFinite(foodTrend.last)) {
    if (foodTrend.last > init.max_food * 0.9) {
      out.push(`Food <b>piled up uneaten</b>, sitting near its cap of ${n(init.max_food)} by the end — nothing was hungry enough to clear it.`)
    } else if (foodTrend.last < foodTrend.first * 0.5 && foodTrend.last < init.max_food * 0.25) {
      out.push(`Food got <b>scarce</b>: the standing supply fell from about ${n(foodTrend.first)} to ${n(foodTrend.last)}.`)
    }
  }
  const freeTrend = trend(r, 'freeMatter')
  if (Number.isFinite(freeTrend.last) && freeTrend.last > init.n_intrinsic * 0.75) {
    out.push(
      `Most matter <b>never joined a body</b>: about ${n(freeTrend.last)} of ${n(init.n_intrinsic)} particles were still drifting free at the end.`,
    )
  }

  // --- the simulation itself
  if (f.clampedPct > 5) {
    out.push(
      `The motion clamp bit on <b>${f.clampedPct.toFixed(1)}% of steps</b> — this world is hot enough that the guardrail, not the chemistry, was setting how far things moved. Lower the temperature or add sub-steps.`,
    )
  }
  if (out.length === 0) out.push('Not much happened. Try a warmer world, more food, or a chemistry with stronger attractions.')
  return out
}
