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

/**
 * Critical values of the studentized range, q(k, ∞), at α = 0.05, indexed by the number of cells.
 *
 * The gap this function reports is between the **best and worst of k sorted cells**, which is a
 * studentized range, not a two-sample difference. Judging it against a two-sample threshold of 2
 * SE announces findings that are not there, and the rate was measured: on a synthetic catalog
 * where the score is independent of every dial, **3 of 26 dial factors flagged `real`**, with a
 * maximum z of 3.4 at 20,000 worlds. With 26 dial factors plus 20 couplings plus 4 shapes, a
 * report should be expected to invent about five findings per run — and `z = 3` sits inside the
 * null.
 *
 * Tukey's range distribution is the correct null. The values below are the standard table; `q/√2`
 * converts it to the same scale as the two-sample z this used to compute, so the threshold for two
 * cells stays at 2.77/1.41 ≈ 1.96 — the familiar number — and rises as the number of cells grows.
 */
const Q_CRIT: readonly number[] = [0, 0, 2.77, 3.31, 3.63, 3.86, 4.03, 4.17, 4.29, 4.39, 4.47]

/**
 * How many factors a full report contains, for the family-wide correction.
 *
 * Counted rather than guessed: ~26 dials, 20 couplings, 4 shapes and a source. Hardcoding it is
 * the weak part of this — add a factor and the constant should move — so it is deliberately an
 * over-estimate, which errs toward calling fewer things real.
 */
const FAMILY = 55

/**
 * Normal quantile, Acklam's rational approximation. Accurate to about 1e-9 over (0,1), which is
 * far more than a significance threshold needs, and it avoids pulling in a dependency for one
 * number.
 */
function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) return -probit(1 - p)
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/**
 * The threshold the max−min gap must clear, in z units, for `k` qualifying cells in a report of
 * `family` factors.
 *
 * Two corrections, because there are two multiplicities and fixing one leaves the other. Within a
 * factor the gap is a **studentized range** over k cells, not a two-sample difference. Across the
 * report there are **fifty-odd factors**, so at α = 0.05 each a pure null yields two or three
 * flags whatever the within-factor test does — measured, the range correction alone still left 5
 * of 50 flagged on a catalog where the score was independent of every dial.
 *
 * So the bar is the larger of the two: the range critical value, and a Bonferroni-corrected normal
 * quantile for the family. Conservative by construction, which is the right direction for a report
 * whose purpose is to decide what the next search looks for.
 */
function rangeThreshold(k: number, family: number): number {
  const q = Q_CRIT[Math.min(k, Q_CRIT.length - 1)] ?? 4.47
  const bonferroni = probit(1 - 0.025 / Math.max(1, family))
  return Math.max(q / Math.SQRT2, bonferroni)
}

function factor(name: string, groups: Map<string, CatalogEntry[]>, family = FAMILY): Factor {
  const cells = [...groups.entries()]
    .map(([label, rows]) => cell(label, rows))
    .filter((c) => c.n >= MIN_N)
    .sort((a, b) => b.mean - a.mean)
  const hi = cells[0]
  const lo = cells[cells.length - 1]
  const z = hi && lo && hi !== lo ? (hi.mean - lo.mean) / Math.sqrt(hi.se ** 2 + lo.se ** 2 || 1e-9) : 0
  // against the studentized range for however many cells qualified, not a flat 2 SE
  return { name, cells, z, real: z >= rangeThreshold(cells.length, family) }
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
    /*
     * One factor for the whole element table, which is the point of having a spread dial at all.
     * Twenty-four per-type properties would give twenty-four factors of three cells each and no
     * interpretable answer; this asks the question the table exists to answer — does it help for
     * the four kinds of matter to differ in more than their chemistry?
     */
    factor('types differ by', group(rows, (e) => e.spec.elementSpread ?? '(uniform)')),
    // whether the chemistry evolves. Read this one first: it decides what every *other* chemistry
    // factor in the report is even about — a starting point, or a law
    factor('chemistry evolves', group(rows, (e) => (e.spec.templating ? 'yes' : 'no'))),
    factor('row mutation', group(rows, (e) => e.spec.rowMut ?? '(default)')),
    factor('matter decays at', group(rows, (e) => e.spec.decayScale ?? '(never)')),
    // where a world's organisms come from: the spawner, or its own reproduction
    factor('a free organism every', group(rows, (e) => e.spec.spawnEvery ?? '(default)')),
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
