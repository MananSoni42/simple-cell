import { type CatalogEntry, type StopReason, type WorldSpec, specId, specInit } from './catalog'
import { ladder } from './ladder'
import { census } from './metrics'
import { World } from './world'

/**
 * Running one candidate world and scoring it — the unit of work the search is made of.
 *
 * The only interesting part is when to stop. A fixed horizon spends the same compute on a world
 * that died in the first hundred ticks as on one that is still climbing at the end, and both of
 * those are the wrong amount:
 *
 * - **extinct**: nothing alive and nothing that can bring anything back, so the rest of the run
 *   would measure an empty box. Checked often, since this is the common case for a random
 *   chemistry and the saving is large.
 * - **plateau**: the ladder score has not improved for a quarter of the horizon. Safe because the
 *   score is cumulative in the things it measures — a world that has stopped improving on every
 *   rung at once has, as far as this phase can tell, finished.
 * - **extended**: the inverse, and the one that matters. A world *still climbing* when it reaches
 *   its horizon earns more ticks, up to a multiple of it. A fixed horizon would throw away
 *   precisely the worlds that are slowly getting somewhere, which is what we are looking for.
 */

export interface EvalOptions {
  ticks: number
  /** How far a still-improving world may run past its horizon, as a multiple. 1 disables it. */
  maxExtend?: number
  /** Stop when the score has not improved for this fraction of the horizon. 0 disables it. */
  plateauFrac?: number
  /** How often to check the ladder. Fewer checks are cheaper; the ladder is not free. */
  every?: number
}

export interface EvalResult {
  level: number
  score: number
  ratios: number[]
  ticks: number
  stop: StopReason
  stats: CatalogEntry['stats']
}

/** One world, run and scored. Deterministic for a given spec. */
export function evaluate(spec: WorldSpec, opts: EvalOptions): EvalResult {
  const horizon = Math.max(1, Math.round(opts.ticks))
  const every = Math.max(50, Math.round(opts.every ?? Math.max(100, horizon / 40)))
  const maxTicks = Math.round(horizon * Math.max(1, opts.maxExtend ?? 1))
  const plateau = Math.max(0, opts.plateauFrac ?? 0.25) * horizon

  // the spec's physics travels on the Init (see `specLaws`), so nothing is passed here and
  // nothing can diverge between what is scored and what the UI later runs
  const w = new World(specInit(spec))
  let best = -1
  let bestAt = 0
  let stop: StopReason = 'done'
  let t = 0

  while (t < maxTicks) {
    w.step()
    t++
    if (t % every !== 0) continue

    const l = ladder(w)
    if (l.score > best + 1e-9) {
      best = l.score
      bestAt = t
    }

    // nothing alive, and with no inflow and no seeded organisms nothing will be again
    if (census(w).organisms === 0) {
      stop = 'extinct'
      break
    }
    if (plateau > 0 && t - bestAt >= plateau) {
      stop = 'plateau'
      break
    }
    if (t >= horizon) {
      // still climbing? then the horizon was the wrong length, not the world
      const climbing = t - bestAt < every * 2
      if (!climbing || maxTicks <= horizon) {
        stop = t > horizon ? 'extended' : 'done'
        break
      }
      stop = 'extended'
    }
  }

  const l = ladder(w)
  const c = census(w)
  const o = w.orders.stats(w)
  const byName = (n: string): number => l.rungs.find((r) => r.name === n)?.ratio ?? 0
  return {
    level: l.level,
    score: l.score,
    ratios: l.rungs.map((r) => r.ratio),
    ticks: t,
    stop,
    stats: {
      organisms: c.organisms,
      // the ratios carry the thresholds, so these are reported as the ratios the rungs saw
      p90Coasts: byName('Lasts') * 2,
      fed: byName('Feeds'),
      seek: byName('Seeks') * 0.25,
      limbs: byName('Keeps its body') * 3.5,
      maxGen: c.maxGen,
      bonds: w.bonds.count,
      bestOrder: o.oldest?.order ?? 0,
      heldFrac: o.oldest?.heldFrac ?? 0,
      replacements: o.oldest?.replacements ?? 0,
      travel: o.oldest?.travel ?? 0,
      lifeMean: w.lifeOrganisms.summary().mean,
      clampPct: w.nSteps > 0 ? (100 * w.nClamped) / w.nSteps : 0,
      /*
       * Two saturation figures, so a world that ran out of *room* is distinguishable from a world
       * that could not use what it had. Both were previously invisible: an overflowing sun looked
       * like a dim one, and a population out of free matter looked infertile.
       */
      lightWastedPct: (100 * w.lightWasted) / Math.max(1e-9, w.lightWasted + w.injected / w.L.E_food),
      // as rates per thousand ticks, so they compare across a 500-tick screen and a 100k
      // confirmation, and kept as four scalars because every stat here is averaged as a median
      blockedSlots: (1000 * w.repBlocked.slots) / Math.max(1, t),
      blockedMatter: (1000 * w.repBlocked.matter) / Math.max(1, t),
      blockedEnergy: (1000 * w.repBlocked.energy) / Math.max(1, t),
      blockedRoom: (1000 * w.repBlocked.room) / Math.max(1, t),
    },
  }
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const a = [...xs].sort((p, q) => p - q)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/**
 * One candidate over several seeds, reported as medians.
 *
 * Medians rather than means throughout, because this world's outcomes are heavy-tailed: one seed
 * where a lineage happens to find a patch can double a mean and say nothing about the chemistry.
 * The seeds are derived from the spec's own seed, so a candidate's score is reproducible.
 */
export function evaluateSeeds(spec: WorldSpec, opts: EvalOptions, seeds: number): Omit<CatalogEntry, 'id' | 'phase' | 'at' | 'ms'> {
  const runs: EvalResult[] = []
  for (let k = 0; k < Math.max(1, seeds); k++) {
    runs.push(evaluate(k === 0 ? spec : { ...spec, seed: spec.seed + k * 7919 }, opts))
  }
  const nRatios = runs[0].ratios.length
  const keys = Object.keys(runs[0].stats) as (keyof CatalogEntry['stats'])[]
  const stats = {} as CatalogEntry['stats']
  // every stat is a number; the optional ones are optional in the *stored* row, not in a result
  for (const k of keys) stats[k] = median(runs.map((r) => r.stats[k] ?? 0)) as never
  return {
    spec,
    seeds: runs.length,
    ticks: Math.round(median(runs.map((r) => r.ticks))),
    // the worst outcome is the honest summary of a stop: a candidate that died on any seed died
    stop: runs.find((r) => r.stop === 'extinct')?.stop ?? runs[0].stop,
    level: Math.min(...runs.map((r) => r.level)),
    score: median(runs.map((r) => r.score)),
    ratios: Array.from({ length: nRatios }, (_, i) => median(runs.map((r) => r.ratios[i]))),
    stats,
  }
}

export { specId }
