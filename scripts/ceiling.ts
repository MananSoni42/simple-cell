import { LAWS, initFromSeed, type Init } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * What one tick actually costs, and so what tick rate is reachable.
 *
 * The rate control is a *request*: the achieved rate is 1000 / (ms per tick), and nothing in the
 * UI can raise that. This script is how the cap was chosen — it is set just above what the
 * smallest sensible world can deliver, so the number on screen is never a promise the model
 * cannot keep. Note that `npm run profile` reads slower than reality: it wraps two dozen methods
 * in timers, which is most of the difference.
 *
 * usage: vite-node scripts/ceiling.ts
 */
const cases: { name: string; init: () => Init }[] = [
  { name: 'default scale 1', init: () => initFromSeed(3, 1) },
  { name: 'substeps 1', init: () => ({ ...initFromSeed(3, 1), substeps: 1, T: 0.5 }) },
  { name: 'no bonds', init: () => ({ ...initFromSeed(3, 1), substeps: 1, T: 0.5, bonds: false }) },
  {
    name: 'tiny (30 matter, 2 brains)',
    init: () => ({ ...initFromSeed(3, 1), substeps: 1, T: 0.5, n_intrinsic: 30, n_brain: 2, n_start: 2, max_food: 20, n_food0: 10 }),
  },
  {
    name: 'tiny, no bonds, no repro',
    init: () => ({ ...initFromSeed(3, 1), substeps: 1, T: 0.5, n_intrinsic: 30, n_brain: 2, n_start: 2, max_food: 20, n_food0: 10, bonds: false, repro: false }),
  },
]

console.log(`fieldN at scale 1: ${Math.min(256, Math.round((LAWS.fieldN * 300) / LAWS.SIZE))}² cells\n`)
for (const c of cases) {
  const w = new World(c.init())
  for (let i = 0; i < 300; i++) w.step()
  const N = 4000
  const t0 = performance.now()
  for (let i = 0; i < N; i++) w.step()
  const ms = (performance.now() - t0) / N
  let live = 0
  for (let i = 0; i < w.cap; i++) if (w.alive[i]) live++
  console.log(`${c.name.padEnd(28)} ${ms.toFixed(4)} ms/tick → ${Math.round(1000 / ms).toLocaleString()} ticks/s  (${live} live, substeps ${w.init.substeps})`)
}
