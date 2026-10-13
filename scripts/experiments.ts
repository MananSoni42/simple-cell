import { type WorldSpec, specInit } from '../src/core/catalog'
import { specFromKeys } from '../src/core/fitness'
import { ladder } from '../src/core/ladder'
import { BRAIN_IN } from '../src/core/neurons'
import { LEARN_DEFAULTS, type LearnAlgo } from '../src/core/learning'
import { World } from '../src/core/world'

/**
 * Every experiment, in one registry, so that one parallel runner can execute all of them.
 *
 * The shape each experiment has to fit is deliberately narrow: **a list of named conditions, and a
 * function from (condition name, seed) to a bag of numbers.** That is enough for a sweep runner to
 * shard the work across processes, and it forces the one discipline that matters — a condition is
 * identified by a *name*, so the worker in another process can reconstruct exactly the world the
 * parent intended from a string, and there is no way for a closure to smuggle state across.
 *
 * Why this exists at all: the first version of these experiments was serial, and at the sample size
 * the results actually need — thirty seeds, not five — one question took hours. E1's first run
 * produced ablations that were individually harmful and jointly helpful, which is impossible as an
 * effect and is the signature of five seeds being nowhere near enough.
 */

/** One run's measurements. Free-form so each experiment reports what it cares about. */
export type Row = Record<string, number>

export interface Experiment {
  /** What question this answers, printed above the table. */
  question: string
  /** The conditions, in the order they should be reported. */
  cases: string[]
  /** The condition every other is compared against. */
  control: string
  /** Which measurements to print, in order, and to how many decimals. */
  report: { key: string; label: string; dp: number }[]
  run(name: string, seed: number, ticks: number): Row
}

/** The chemistry every experiment runs on: known to live, breed and bond for 20,000 ticks. */
const VIABLE: WorldSpec = {
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

/** The measurements almost every experiment wants, read off a finished world. */
function measure(w: World): Row {
  const l = ladder(w)
  // every rung's own progress, so the ladder can be calibrated against what worlds actually do
  // rather than against what I guessed when writing the thresholds
  const perRung: Row = {}
  for (const r of l.rungs) {
    perRung[`r:${r.name}`] = r.ratio
    perRung[`met:${r.name}`] = r.met ? 1 : 0
  }
  const by = (n: string): number => l.rungs.find((r) => r.name === n)?.ratio ?? 0
  const o = w.orders.stats(w)
  let alive = 0
  for (let b = w.nIntr; b < w.nMatter; b++) if (w.isBrain(b) && w.alive[b]) alive++
  const st = w.learner.status()
  const blocked = w.repBlocked
  /*
   * The **raw quantities** each rung thresholds, not only whether it passed.
   *
   * Pass/fail data goes stale the instant a threshold changes, so calibrating from it means
   * re-running the whole sweep per adjustment. The distributions of the underlying measurements do
   * not go stale: a threshold can be set from them analytically, and the only thing a re-run then
   * has to confirm is that the chosen number does what the distribution said it would.
   */
  let maxGen = 0
  let limbs = 0
  let nOrg = 0
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.isBrain(b) || !w.alive[b]) continue
    nOrg++
    if (w.gen[b] > maxGen) maxGen = w.gen[b]
    for (let k = 0; k < 4; k++) if (w.limbs[b * 4 + k] >= 0) limbs++
  }
  const solo = w.soloSpeed()
  const raw: Row = {
    'q:maxGen': maxGen,
    'q:limbsEach': nOrg > 0 ? limbs / nOrg : 0,
    'q:order': o.oldest?.order ?? 0,
    'q:heldFrac': o.oldest?.heldFrac ?? 0,
    'q:replaced': o.oldest?.replacements ?? 0,
    'q:birthsInside': o.oldest?.births ?? 0,
    'q:soloSpeed': solo,
    'q:structSpeed': o.oldest && o.oldest.age > 0 ? o.oldest.travel / o.oldest.age : 0,
    'q:travelOverSolo': o.oldest && o.oldest.age > 0 && solo > 1e-9 ? o.oldest.travel / o.oldest.age / solo : 0,
  }
  return {
    ...perRung,
    ...raw,
    fed: by('Feeds'),
    lasts: by('Lasts') * 2,
    seeks: by('Seeks') * 0.25,
    order: o.oldest?.order ?? 0,
    held: o.oldest?.heldFrac ?? 0,
    score: l.score,
    level: l.level,
    alive,
    gen: (() => {
      let g = 0
      for (let b = w.nIntr; b < w.nMatter; b++) if (w.isBrain(b) && w.gen[b] > g) g = w.gen[b]
      return g
    })(),
    budded: w.nBudded,
    // the four reasons reproduction did not happen, per thousand ticks: the figure that showed the
    // population cap, not food, to be what this world actually selects on
    blockedSlots: (1000 * blocked.slots) / Math.max(1, w.tick),
    blockedMatter: (1000 * blocked.matter) / Math.max(1, w.tick),
    blockedEnergy: (1000 * blocked.energy) / Math.max(1, w.tick),
    blockedRoom: (1000 * blocked.room) / Math.max(1, w.tick),
    lightWasted: w.lightWasted,
    updates: st.updates,
    lives: st.seen,
    clampPct: w.nSteps > 0 ? (100 * w.nClamped) / w.nSteps : 0,
  }
}

/** Runs a world to `ticks`, reading the ladder as it goes because the rungs are windowed. */
function runWorld(w: World, ticks: number): Row {
  for (let t = 0; t < ticks; t++) {
    w.step()
    if (t % 1000 === 0) ladder(w)
  }
  return measure(w)
}

// ---------------------------------------------------------------- E1: the senses

const SOCKET_ANGLES = [0, 1, 2, 3].map((s) => s * BRAIN_IN.SOCKET_W + 7)
const SOCKET_BONDS = [0, 1, 2, 3].map((s) => s * BRAIN_IN.SOCKET_W + 6)
const NEW_SENSES = [BRAIN_IN.FOOD_NEAR, BRAIN_IN.VEL_X, BRAIN_IN.VEL_Y, BRAIN_IN.BOND_LOAD, ...SOCKET_ANGLES, ...SOCKET_BONDS]

const SENSE_CASES: Record<string, { blind?: number[]; muFood?: number; foodMoves?: boolean }> = {
  'everything on': {},
  '− food count': { blind: [BRAIN_IN.FOOD_NEAR] },
  '− own motion': { blind: [BRAIN_IN.VEL_X, BRAIN_IN.VEL_Y] },
  '− own body': { blind: [...SOCKET_ANGLES, ...SOCKET_BONDS, BRAIN_IN.BOND_LOAD] },
  '− all new senses': { blind: NEW_SENSES },
  'drifting food, heavy': { foodMoves: true },
  'drifting food, light': { foodMoves: true, muFood: 1 },
  'drifting food, light, blind': { foodMoves: true, muFood: 1, blind: NEW_SENSES },
}

// ---------------------------------------------------------------- E1b: the learners

const LEARNER_CASES: LearnAlgo[] = ['none', 'random', 'ga', 'es', 'cem', 'elites', 'td', 'hebb']

// ---------------------------------------------------------------- E7: what the world selects on

/**
 * Is perception unpaid because the population cap, not food, is what this world selects on?
 *
 * The number that prompted this: over 6,000 ticks a living world blocked **41,244** reproductions
 * for want of a free brain slot and completed **230**. Nothing about that pressure has anything to
 * do with finding food — so an organism that could perceive food would gain nothing from it, and
 * E1 measuring the new senses as flat would be the expected result rather than a verdict on them.
 *
 * So: raise slots and matter until the cap stops binding, and ask whether the senses then pay.
 * `blockedSlots` is the check that the manipulation worked — it has to fall, or the condition did
 * not do what it claims. Both the sighted and blind versions are run at each level, because the
 * question is not "does more room help" (it will) but "does more room make *perception* help".
 */
const CAP_LEVELS: Record<string, { slots: number; matter: number }> = {
  'cap bites (150 slots)': { slots: 150, matter: 700 },
  'roomier (400 slots)': { slots: 400, matter: 1800 },
  'ample (900 slots)': { slots: 900, matter: 4000 },
}

const CAP_CASES: Record<string, { slots: number; matter: number; blind?: number[] }> = Object.fromEntries(
  Object.entries(CAP_LEVELS).flatMap(([name, shape]) => [
    [`${name}, sighted`, shape],
    [`${name}, blind`, { ...shape, blind: NEW_SENSES }],
  ]),
)

const COMMON_REPORT = [
  { key: 'fed', label: 'fed', dp: 2 },
  { key: 'lasts', label: 'lasts', dp: 2 },
  { key: 'seeks', label: 'seeks', dp: 3 },
  { key: 'order', label: 'order', dp: 1 },
  { key: 'score', label: 'score', dp: 1 },
]

/**
 * How hard is the ladder, actually?
 *
 * The thresholds were written from reasoning about what each rung *ought* to demand, calibrated
 * against nulls in intrinsic units — and that is the right way to set them, but it is not evidence
 * that the result is hard. A rung is only a milestone if a world without the capability it names
 * fails it, and the only way to know that is to run worlds that plainly lack the capability and
 * see how far up they get.
 *
 * So: the same chemistry at four levels of capability, from a world where nothing learns and
 * nothing can even perceive, up to one with every sense and an online learner. If the bottom
 * condition clears most of the ladder, the ladder is measuring the world rather than the organisms
 * in it, and the numbers below are what to recalibrate against.
 */
const RUNG_CASES: Record<string, { blind?: number[]; algo?: LearnAlgo; slots?: number; matter?: number }> = {
  'blind, no learner': { blind: NEW_SENSES },
  'sighted, no learner': {},
  'sighted, offline learner': { algo: 'cem' },
  'sighted, online learner': { algo: 'td' },
}

export const EXPERIMENTS: Record<string, Experiment> = {
  rungs: {
    question: 'Is each rung genuinely hard — does a world lacking the capability fail it?',
    cases: Object.keys(RUNG_CASES),
    control: 'blind, no learner',
    // every rung, by name, so the table *is* the calibration data
    report: [
      { key: 'level', label: 'level', dp: 2 },
      // the raw quantities first: these are the calibration data and they do not go stale when a
      // threshold moves, which pass/fail does
      { key: 'q:maxGen', label: 'gen', dp: 1 },
      { key: 'q:limbsEach', label: 'limbs', dp: 2 },
      { key: 'q:order', label: 'order', dp: 1 },
      { key: 'q:heldFrac', label: 'heldFrac', dp: 2 },
      { key: 'q:replaced', label: 'replaced', dp: 1 },
      { key: 'q:birthsInside', label: 'birthsIn', dp: 1 },
      { key: 'q:travelOverSolo', label: 'travel/solo', dp: 2 },
      { key: 'fed', label: 'fed', dp: 2 },
      { key: 'lasts', label: 'lasts', dp: 2 },
      { key: 'seeks', label: 'seeks', dp: 3 },
      { key: 'met:Persists', label: 'Persists', dp: 2 },
      { key: 'met:Feeds', label: 'Feeds', dp: 2 },
      { key: 'met:Lasts', label: 'Lasts', dp: 2 },
      { key: 'met:Seeks', label: 'Seeks', dp: 2 },
      { key: 'met:Keeps its body', label: 'KeepsBody', dp: 2 },
      { key: 'met:Breeds true', label: 'BreedsTrue', dp: 2 },
      { key: 'met:Lineage outlives', label: 'LineageOut', dp: 2 },
      { key: 'met:Joins', label: 'Joins', dp: 2 },
      { key: 'met:Holds', label: 'Holds', dp: 2 },
      { key: 'met:Renews', label: 'Renews', dp: 2 },
      { key: 'met:Moves together', label: 'MovesTog', dp: 2 },
      { key: 'met:Transmits joining', label: 'Transmits', dp: 2 },
      { key: 'met:Grows from within', label: 'GrowsIn', dp: 2 },
    ],
    run(name, seed, ticks) {
      const c = RUNG_CASES[name]
      if (!c) throw new Error(`no rung case "${name}"`)
      const init = specInit({ ...VIABLE, seed, slots: c.slots ?? VIABLE.slots, matter: c.matter ?? VIABLE.matter })
      if (c.algo) init.learn = { ...LEARN_DEFAULTS, algo: c.algo, fitness: specFromKeys(['offspring']), warmup: 500 }
      return runWorld(new World(init, { blind: c.blind }), ticks)
    },
  },

  senses: {
    question: 'Does each new brain input pay, and does heavy food pay?',
    cases: Object.keys(SENSE_CASES),
    control: '− all new senses',
    report: COMMON_REPORT,
    run(name, seed, ticks) {
      const c = SENSE_CASES[name]
      if (!c) throw new Error(`no sense case "${name}"`)
      const init = specInit({ ...VIABLE, seed })
      if (c.foodMoves !== undefined) init.foodMoves = c.foodMoves
      return runWorld(new World(init, { blind: c.blind, laws: c.muFood !== undefined ? { mu_food: c.muFood } : {} }), ticks)
    },
  },

  learners: {
    question: 'Which learners beat doing nothing, and which should be discarded?',
    /*
     * The control is `none`, not `random`, and that is a correction.
     *
     * `random` still spawns random weights — it merely *records* the best genome it ever saw — so
     * its world is bit-identical to `none`'s, which the first run confirmed to the last decimal on
     * every column. Comparing against it is comparing a world against itself. What `random`
     * actually provides is a yardstick *number*: the best score luck alone reaches, which is what
     * calibrated the percentile statistic as noise once before.
     */
    cases: LEARNER_CASES,
    control: 'none',
    report: [...COMMON_REPORT, { key: 'updates', label: 'updates', dp: 0 }, { key: 'lives', label: 'lives', dp: 0 }],
    run(name, seed, ticks) {
      const init = specInit({ ...VIABLE, seed })
      init.learn = {
        ...LEARN_DEFAULTS,
        algo: name as LearnAlgo,
        // offspring alone: the one measure that cannot be gamed by living frugally, which is the
        // failure mode every learner here has fallen into at least once
        fitness: specFromKeys(['offspring']),
        warmup: 500,
      }
      return runWorld(new World(init, {}), ticks)
    },
  },

  cap: {
    question: 'Is perception unpaid because the population cap, not food, is what this world selects on?',
    cases: Object.keys(CAP_CASES),
    control: 'cap bites (150 slots), blind',
    report: [...COMMON_REPORT, { key: 'blockedSlots', label: 'slot-blocked/kt', dp: 0 }, { key: 'gen', label: 'gen', dp: 0 }],
    run(name, seed, ticks) {
      const c = CAP_CASES[name]
      if (!c) throw new Error(`no cap case "${name}"`)
      const init = specInit({ ...VIABLE, seed, slots: c.slots, matter: c.matter })
      return runWorld(new World(init, { blind: c.blind }), ticks)
    },
  },
}
