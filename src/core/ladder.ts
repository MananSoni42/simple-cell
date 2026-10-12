import { census } from './metrics'
import type { World } from './world'

/**
 * How far along a world has got, as a ladder of milestones.
 *
 * Each rung is a stepping stone to the same destination: structures made of many organisms that
 * persist, and persist while their parts turn over. The order matters — a rung is a prerequisite
 * for the one above, not merely harder — and the first four are about individuals because nothing
 * can hold together if nothing can stay alive.
 *
 * **Thresholds are absolute, and that is a compromise worth naming.** The honest comparison is
 * paired: this world with and without its learner, over many seeds. A number on a live rail cannot
 * do that, so these are calibrated against a measured baseline instead — a `patchy`/`average`
 * world at the old defaults, which gave a 90th-percentile lifespan of 489, harvest of 0.078 per
 * tick, and compounds that lasted about ten ticks when keyed by exact membership. Read the rung as
 * "further than the world used to get", not as a statement about any particular world's ceiling.
 */
export interface Rung {
  n: number
  name: string
  /** What it takes, in words. */
  needs: string
  met: boolean
  /** Where this world currently stands against it. */
  at: string
}

export interface Ladder {
  /** The highest rung reached with no gaps below it. */
  reached: number
  top: number
  rungs: Rung[]
  /** The first unmet rung, which is the thing to work on. */
  next: Rung | null
}

/** Mean of a measure over the organisms alive now. */
function overLiving(w: World, f: (b: number) => number): { mean: number; n: number } {
  let sum = 0
  let n = 0
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.alive[b] || !w.isBrain(b)) continue
    sum += f(b)
    n++
  }
  return { mean: n === 0 ? 0 : sum / n, n }
}

export function ladder(w: World): Ladder {
  const c = census(w)
  const orders = w.orders.stats(w)
  const struct = orders.oldest
  const age = (b: number): number => Math.max(1, w.tick - w.bornAt[b])
  const net = overLiving(w, (b) => w.harvested[b] - w.spent[b])
  const rate = overLiving(w, (b) => w.harvested[b] / age(b))
  const seek = overLiving(w, (b) => (w.seekTicks[b] > 0 ? w.seeking[b] / w.seekTicks[b] : 0))
  const limbs = c.organisms > 0 ? c.limbs / c.organisms : 0
  const joined = orders.live.slice(1).reduce((a, n) => a + n, 0)

  const fmt1 = (v: number): string => (Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(2))
  const out: Rung[] = []
  const add = (name: string, needs: string, met: boolean, at: string): void => {
    out.push({ n: out.length, name, needs, met, at })
  }

  add('Persists', 'anything alive at all', c.organisms > 0, `${c.organisms} alive`)
  add('Lifespan', 'a life of 1,000 ticks', w.recordAge >= 1000, `longest ${Math.round(w.recordAge)}t`)
  add('Self-funding', 'the living have taken in more than they have spent', net.n > 0 && net.mean > 0, `net ${fmt1(net.mean)} each`)
  add('Foraging', 'taking in 0.10 a tick, better than chance', rate.mean >= 0.1, `${rate.mean.toFixed(3)} a tick`)
  /*
   * Finding food *on purpose*, which is a different claim from finding it at all.
   *
   * Every other foraging measure can be passed by luck or by stillness: harvest totals reward a
   * long life, harvest rates reward being born in a patch, and neither says anything about whether
   * the organism went anywhere deliberately. This one is the cosine between where a body moved and
   * where it could tell food was, averaged over the ticks when there was something to tell — so a
   * random walk scores 0, an organism that never moves scores nothing at all, and only going
   * toward food scores. 0.15 is a modest bar deliberately: the sense is noisy and food is often in
   * several directions at once, so a world that clears it is unambiguously doing something.
   */
  add('Seeks food', 'moving toward food rather than stumbling on it', seek.mean >= 0.15, `alignment ${seek.mean.toFixed(3)}`)
  add('Whole bodies', 'three and a half limbs each, kept', limbs >= 3.5, `${limbs.toFixed(2)} limbs`)
  add('Joining', 'two or more organisms bonded into one object', joined > 0, joined > 0 ? `${joined} compounds` : 'none joined')
  add(
    'Structure',
    'one holding together for 2,000 ticks',
    (struct?.age ?? 0) >= 2000,
    struct ? `${struct.order}° for ${Math.round(struct.age)}t` : 'none',
  )
  add(
    'Outlives its parts',
    'a structure that has replaced as many members as it has',
    !!struct && struct.age >= 1000 && struct.replacements >= struct.order,
    struct ? `${struct.replacements} replaced of ${struct.order}` : 'none',
  )
  add('Heritable joining', 'offspring of joiners join more often than others do', false, 'not measured yet')
  add('Group birth', 'a structure that grows by birth inside itself', false, 'not measured yet')

  // the highest rung with nothing unmet below it: a ladder is only as high as its lowest gap
  let reached = -1
  for (const r of out) {
    if (!r.met) break
    reached = r.n
  }
  return { reached, top: out.length - 1, rungs: out, next: out.find((r) => !r.met) ?? null }
}
