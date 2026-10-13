import type { WorldSpec } from '../src/core/catalog'
import { ladder } from '../src/core/ladder'
import { specInit } from '../src/core/catalog'
import { LAWS } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * Is encounter rate the binding constraint on self-sufficiency?
 *
 * The search measured a lifetime harvest of 0.067 of the birth endowment — about half a meal per
 * life — and `Seeks` at zero of 597 worlds. The hypothesis is that both follow from how rarely a
 * limb comes within `r_eat` = 6 of food, and that two constants fix it: a wider mouth, and a
 * smaller inheritance to coast on. Laws are overridden rather than edited, so this measures the
 * question without changing the world anyone else gets.
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

const cases: { name: string; r_eat?: number; E_birth?: number; E_food?: number }[] = [
  { name: 'as it is' },
  { name: 'r_eat 12', r_eat: 12 },
  { name: 'r_eat 20', r_eat: 20 },
  { name: 'E_birth 5', E_birth: 5 },
  { name: 'r_eat 12 + E_birth 5', r_eat: 12, E_birth: 5 },
  { name: 'r_eat 20 + E_birth 5', r_eat: 20, E_birth: 5 },
  { name: 'r_eat 12 + E_food 30', r_eat: 12, E_food: 30 },
]

const TICKS = Number(process.argv[2] ?? 20000)
for (const c of cases) {
  const laws = { ...(c.r_eat ? { r_eat: c.r_eat } : {}), ...(c.E_birth ? { E_birth: c.E_birth } : {}), ...(c.E_food ? { E_food: c.E_food } : {}) }
  const w = new World(specInit(base), { laws })
  for (let t = 0; t < TICKS; t++) {
    w.step()
    if (t % 1000 === 0) ladder(w)
  }
  const l = ladder(w)
  const by = (n: string): number => l.rungs.find((r) => r.name === n)?.ratio ?? 0
  let meals = 0
  let fed = 0
  let n = 0
  for (let b = w.nIntr; b < w.nMatter; b++) {
    if (!w.alive[b] || !w.isBrain(b)) continue
    meals += w.meals[b]
    fed += w.harvested[b] / Math.max(1e-9, w.endowment[b])
    n++
  }
  console.log(
    `${c.name.padEnd(22)} level ${l.level} · ${l.passed}/13 met · score ${l.score.toFixed(2)} · ` +
      `fed ${by('Feeds').toFixed(2)} · lasts ${(by('Lasts') * 2).toFixed(2)} coasts · seeks ${(by('Seeks') * 0.25).toFixed(3)} · ` +
      `meals/organism ${(meals / Math.max(1, n)).toFixed(1)} · alive ${n}`,
  )
}
console.log(`\n(r_eat default ${LAWS.r_eat}, E_birth ${LAWS.E_birth}, E_food ${LAWS.E_food}; ${TICKS} ticks each)`)
