import { ladder } from '../src/core/ladder'
import { bestWorld } from '../src/ui/recipes'
import { World } from '../src/core/world'
const w = new World(bestWorld(11, 1))
for (let t = 0; t < 30000; t++) {
  w.step()
  if (t % 2000 === 0) ladder(w) // the cadence the worker would use
}
const l = ladder(w)
console.log(`level ${l.level} (${l.levelName}) · rung ${l.reached + 1}/${l.top + 1} · score ${l.score.toFixed(2)}`)
for (const r of l.rungs) console.log(`  ${r.met ? '✓' : '·'} L${r.level} ${r.name.padEnd(18)} ${String(Math.round(100 * Math.min(1, r.ratio))).padStart(3)}%  ${r.at}`)
