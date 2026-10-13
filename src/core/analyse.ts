import { type CatalogEntry, TRI, type WorldSpec } from './catalog'
import { FOOD_ROW, MATRIX_NAMES } from './types'

/**
 * What the search learned, as opposed to what it found.
 *
 * A top-ten list says which worlds worked; it does not say *why*, and the why is the part that
 * generalises to the next search. So every catalogued world — including the hundreds of thousands
 * that failed — is read back here to answer: which couplings matter, which food regimes matter,
 * and which of the dials are doing the work.
 *
 * Two statistical rules throughout, because a search over a space this large will otherwise
 * manufacture conclusions:
 *
 * - **Nothing is reported from fewer than `MIN_N` worlds.** With fourteen matrix entries at seven
 *   levels, some cells are simply empty, and the mean of three worlds is noise with a decimal
 *   point.
 * - **Every difference is reported with its standard error**, and the lift is only called real
 *   when the gap exceeds two of them. A search that ranks a hundred thousand candidates will
 *   always produce an impressive-looking best cell; the question is whether the *cell* is better
 *   or the winner inside it got lucky.
 *
 * And one rule about what may be compared at all: **analyse one phase at a time.** Phases fix some
 * dials themselves — world size escalates with run length — so pooling them makes those dials a
 * proxy for how long a world was run. The first report produced this way confidently announced
 * that sixty brain slots beat twenty-four at z = 8.1, which was entirely a restatement of phase 1
 * running four times longer than phase 0.
 */

const MIN_N = 30

/**
 * Max and min by reduction, never by spread.
 *
 * `Math.max(...xs)` passes every element as an argument, and at two hundred thousand elements that
 * overflows the call stack — which is how phase 0 completed all 200,000 worlds and then crashed in
 * the line that was about to report the best score. Every aggregate here can see the whole catalog,
 * so none of them may spread.
 */
const maxOf = (xs: number[]): number => xs.reduce((a, b) => (b > a ? b : a), -Infinity)
const minOf = (xs: number[]): number => xs.reduce((a, b) => (b < a ? b : a), Infinity)

export interface Cell {
  label: string
  n: number
  mean: number
  /** Standard error of the mean, so a difference can be judged rather than admired. */
  se: number
  /** Share of worlds in this cell that reached level 1 or better. */
  aliveFrac: number
  best: number
}

export interface Factor {
  name: string
  cells: Cell[]
  /** Gap between the best and worst qualifying cell, in standard errors of the two combined. */
  z: number
  /** True when that gap clears two standard errors: worth reading, rather than worth ignoring. */
  real: boolean
}

function cell(label: string, rows: CatalogEntry[]): Cell {
  const n = rows.length
  const scores = rows.map((r) => r.score)
  const mean = n ? scores.reduce((a, b) => a + b, 0) / n : 0
  const varr = n > 1 ? scores.reduce((a, s) => a + (s - mean) ** 2, 0) / (n - 1) : 0
  return {
    label,
    n,
    mean,
    se: n > 0 ? Math.sqrt(varr / n) : 0,
    aliveFrac: n ? rows.filter((r) => r.level >= 1).length / n : 0,
    best: n ? maxOf(scores) : 0,
  }
}

function factor(name: string, groups: Map<string, CatalogEntry[]>): Factor {
  const cells = [...groups.entries()]
    .map(([label, rows]) => cell(label, rows))
    .filter((c) => c.n >= MIN_N)
    .sort((a, b) => b.mean - a.mean)
  const hi = cells[0]
  const lo = cells[cells.length - 1]
  const z = hi && lo && hi !== lo ? (hi.mean - lo.mean) / Math.sqrt(hi.se ** 2 + lo.se ** 2 || 1e-9) : 0
  return { name, cells, z, real: z >= 2 }
}

const group = <T,>(rows: CatalogEntry[], key: (e: CatalogEntry) => T): Map<string, CatalogEntry[]> => {
  const m = new Map<string, CatalogEntry[]>()
  for (const r of rows) {
    const k = String(key(r))
    const a = m.get(k)
    if (a) a.push(r)
    else m.set(k, [r])
  }
  return m
}

/** Which dial settings go with better worlds. One factor per thing a phase varied. */
export function dialFactors(rows: CatalogEntry[]): Factor[] {
  const bucket = (v: number, step: number): string => (Math.round(v / step) * step).toFixed(2)
  return [
    factor('food pattern', group(rows, (e) => e.spec.foodMode)),
    factor('food level', group(rows, (e) => e.spec.foodLevel)),
    factor('food over time', group(rows, (e) => e.spec.foodRegime)),
    factor('metabolism', group(rows, (e) => bucket(e.spec.metabolism, 0.25))),
    factor('energy along bonds', group(rows, (e) => bucket(e.spec.bondFlow, 0.05))),
    factor('temperature', group(rows, (e) => bucket(e.spec.T, 1))),
    factor('brain slots', group(rows, (e) => e.spec.slots)),
    factor('matter', group(rows, (e) => Math.round(e.spec.matter / 100) * 100)),
    factor('food patches', group(rows, (e) => e.spec.patches)),
    factor('spoils after', group(rows, (e) => Math.round(e.spec.foodLife / 100) * 100)),
    factor('fission', group(rows, (e) => (e.spec.fission ? 'on' : 'off'))),
    /*
     * The physics and the economics, which used to be constants.
     *
     * `?? '(default)'` matters: catalog rows written before these dials existed ran under the
     * law defaults, and labelling them as such keeps them in the analysis as a legitimate cell
     * instead of either dropping them or pretending they held some particular value.
     */
    factor('food mobility', group(rows, (e) => e.spec.muFood ?? '(default)')),
    factor('brain force', group(rows, (e) => e.spec.fMax ?? '(default)')),
    factor('bond stiffness', group(rows, (e) => e.spec.kBond ?? '(default)')),
    factor('bond breaks at', group(rows, (e) => e.spec.fBreak ?? '(default)')),
    factor('bonds per particle', group(rows, (e) => e.spec.maxBonds ?? '(default)')),
    factor('mouth width', group(rows, (e) => e.spec.rEat ?? '(default)')),
    factor('birth cost', group(rows, (e) => e.spec.eBirth ?? '(default)')),
    factor('breeds at', group(rows, (e) => e.spec.eRepro ?? '(default)')),
    factor('mutation rate', group(rows, (e) => e.spec.reproMut ?? '(default)')),
    factor('how it reproduces', group(rows, (e) => e.spec.reproMode ?? 'bud')),
    factor('spore cost', group(rows, (e) => e.spec.eSpore ?? '(default)')),
    factor('spore wakes at', group(rows, (e) => e.spec.sporeFood ?? '(default)')),
    /*
     * A ratio, not a dial, and the one this review predicts matters most: an organism that cannot
     * out-pull a bond can never drag a structure anywhere, whatever else is true of it.
     */
    factor('brain force vs bond strength', group(rows, (e) => ((e.spec.fMax ?? 1) / (e.spec.fBreak ?? 4)).toFixed(2))),
  ].filter((f) => f.cells.length >= 2)
}

/**
 * Which couplings matter: one factor per matrix entry, celled by the quantized value it held.
 *
 * This is the question the search exists to answer — whether some chemistry sustains life — asked
 * in the form that generalises. A single winning matrix is an anecdote; "P1×P1 wants to be
 * negative and P2×Food wants to be strong" is a finding that narrows the next search.
 */
export function couplingFactors(rows: CatalogEntry[]): Factor[] {
  return TRI.map(([i, j], k) =>
    factor(`${MATRIX_NAMES[i]}×${MATRIX_NAMES[j]}`, group(rows, (e) => (e.spec.A[k] ?? 0).toFixed(2))),
  ).filter((f) => f.cells.length >= 2)
}

/** Derived shapes of a chemistry, which is where the prior to be tested actually lives. */
export function chemistryShape(spec: WorldSpec): { nonzero: number; meanAbs: number; selfRepel: number; foodSpread: number } {
  const matter: number[] = []
  const diag: number[] = []
  const food: number[] = []
  TRI.forEach(([i, j], k) => {
    const v = spec.A[k] ?? 0
    if (i === FOOD_ROW || j === FOOD_ROW) food.push(v)
    else {
      matter.push(v)
      if (i === j) diag.push(v)
    }
  })
  const mean = (a: number[]): number => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0)
  return {
    nonzero: matter.filter((v) => v !== 0).length,
    meanAbs: mean(matter.map(Math.abs)),
    selfRepel: diag.filter((v) => v < 0).length,
    // how differentiated the food couplings are: a feeding layer needs some types to care and
    // others not to, which is a spread rather than a level
    foodSpread: food.length > 1 ? maxOf(food) - minOf(food) : 0,
  }
}

/**
 * The pre-registered test of the prior, asked directly: do candidates drawn from the constrained
 * region beat the uniform control? Reported only where the catalog records where a draw came from.
 */
export function sourceFactor(rows: CatalogEntry[]): Factor | null {
  const known = rows.filter((e) => e.source)
  if (known.length < MIN_N * 2) return null
  return factor('where the candidate came from', group(known, (e) => e.source!))
}

/** Derived shapes, which is how the same question is asked when the source was not recorded. */
export function shapeFactors(rows: CatalogEntry[]): Factor[] {
  const s = (e: CatalogEntry) => chemistryShape(e.spec)
  return [
    factor('nonzero matter couplings', group(rows, (e) => s(e).nonzero)),
    factor('mean coupling strength', group(rows, (e) => s(e).meanAbs.toFixed(2))),
    factor('self-repelling types', group(rows, (e) => s(e).selfRepel)),
    factor('food coupling spread', group(rows, (e) => s(e).foodSpread.toFixed(2))),
  ].filter((f) => f.cells.length >= 2)
}

export interface Summary {
  worlds: number
  byLevel: number[]
  /**
   * Per rung: the share of worlds that met it, and the mean progress toward it.
   *
   * This is the most useful aggregate the catalog can produce, and the one a top-ten list cannot.
   * A pass rate near zero on a rung that everything below it clears identifies **the wall** — the
   * single thing standing between this world and the next level of organisation — and it is a
   * statement about the world's laws rather than about any candidate in it.
   */
  rungPass: number[]
  rungMean: number[]
  /** Distribution of the ladder score, in twenty buckets from zero to the rung count. */
  scoreHist: number[]
  /** Share that died out, plateaued, ran their horizon, or earned an extension. */
  byStop: Record<string, number>
  /** Of all worlds, the share that got past "anything alive" at all. */
  aliveFrac: number
  meanScore: number
  bestScore: number
  /** Total simulated ticks and wall-clock hours, so the cost of a finding is on the record. */
  ticks: number
  hours: number
  factors: { dials: Factor[]; couplings: Factor[]; shapes: Factor[]; source: Factor | null }
}

export function summarise(rows: CatalogEntry[]): Summary {
  const byLevel = new Array(7).fill(0)
  const byStop: Record<string, number> = {}
  const nRungs = rows.reduce((a, r) => Math.max(a, r.ratios?.length ?? 0), 0)
  const pass = new Array(nRungs).fill(0)
  const sum = new Array(nRungs).fill(0)
  const BUCKETS = 20
  const hist = new Array(BUCKETS).fill(0)
  let ticks = 0
  let ms = 0
  for (const r of rows) {
    byLevel[Math.max(0, r.level + 1)]++
    byStop[r.stop] = (byStop[r.stop] ?? 0) + 1
    ticks += r.ticks * r.seeds
    ms += r.ms
    for (let i = 0; i < (r.ratios?.length ?? 0); i++) {
      if (r.ratios[i] >= 1) pass[i]++
      sum[i] += Math.min(1, r.ratios[i])
    }
    const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor((r.score / Math.max(1, nRungs)) * BUCKETS)))
    hist[b]++
  }
  const n = Math.max(1, rows.length)
  return {
    worlds: rows.length,
    byLevel,
    rungPass: pass.map((p) => p / n),
    rungMean: sum.map((p) => p / n),
    scoreHist: hist,
    byStop,
    aliveFrac: rows.length ? rows.filter((r) => r.level >= 0).length / rows.length : 0,
    meanScore: rows.length ? rows.reduce((a, r) => a + r.score, 0) / rows.length : 0,
    bestScore: rows.length ? maxOf(rows.map((r) => r.score)) : 0,
    ticks,
    hours: ms / 3.6e6,
    factors: { dials: dialFactors(rows), couplings: couplingFactors(rows), shapes: shapeFactors(rows), source: sourceFactor(rows) },
  }
}

/** A plain-text report, because a finding nobody reads is not a finding. */
export function report(s: Summary): string {
  const out: string[] = []
  out.push(`${s.worlds.toLocaleString()} worlds · ${(s.ticks / 1e6).toFixed(1)}M ticks · ${s.hours.toFixed(1)} core-hours`)
  out.push(`levels reached: ${s.byLevel.map((n, i) => `${i - 1}:${n}`).join('  ')}`)
  out.push(`stopped: ${Object.entries(s.byStop).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  out.push(`score mean ${s.meanScore.toFixed(2)}, best ${s.bestScore.toFixed(2)}`)
  if (s.rungPass.length) {
    out.push('', 'WHERE THE WALLS ARE')
    s.rungPass.forEach((p, i) => {
      const bar = '█'.repeat(Math.round(20 * s.rungMean[i])).padEnd(20, '·')
      out.push(`  rung ${String(i).padStart(2)}  ${bar}  ${(100 * p).toFixed(1)}% met · mean progress ${(100 * s.rungMean[i]).toFixed(0)}%`)
    })
  }
  const show = (title: string, fs: Factor[]): void => {
    out.push('', title.toUpperCase())
    for (const f of fs.sort((a, b) => b.z - a.z)) {
      const tag = f.real ? '' : '   (within noise)'
      out.push(`  ${f.name.padEnd(26)} z=${f.z.toFixed(1)}${tag}`)
      for (const c of f.cells.slice(0, 4)) {
        out.push(`      ${c.label.padEnd(10)} n=${String(c.n).padStart(6)}  score ${c.mean.toFixed(2)}±${c.se.toFixed(2)}  alive ${Math.round(100 * c.aliveFrac)}%  best ${c.best.toFixed(1)}`)
      }
    }
  }
  if (s.factors.source) show('where the candidates came from', [s.factors.source])
  show('what the dials did', s.factors.dials)
  show('what shape of chemistry did', s.factors.shapes)
  show('which couplings mattered most', s.factors.couplings.slice(0, 6))
  return out.join('\n')
}
