import { serialBackend } from '../src/core/backend'
import { initFromSeed } from '../src/core/params'
import { World } from '../src/core/world'

/** Per-phase cost of one tick on a single thread. usage: vite-node scripts/profile.ts [scale ...] */
const scales = process.argv.slice(2).map(Number).filter(Boolean)
for (const scale of scales.length ? scales : [8, 16, 32]) {
  const w = new World(initFromSeed(3, scale))
  for (let i = 0; i < 150; i++) w.step()
  const acc: Record<string, number> = {}
  const wrap = (name: string, obj: any, label = name) => {
    if (typeof obj[name] !== 'function') return
    const f = obj[name].bind(obj)
    obj[name] = (...a: unknown[]) => {
      const t = performance.now()
      const r = f(...a)
      acc[label] = (acc[label] || 0) + performance.now() - t
      return r
    }
  }
  const anyW = w as any
  for (const n of ['prepare', 'integrate', 'uptake', 'think', 'costs', 'decayFree', 'freeMatterDecay', 'deaths', 'reproduce', 'captures', 'stepField', 'stepPatches', 'injectFood', 'spawnRandom']) wrap(n, anyW)
  wrap('build', anyW.grid, 'gridBuild')
  const orig = serialBackend.compute.bind(serialBackend)
  ;(serialBackend as any).compute = (x: World) => {
    const t = performance.now()
    orig(x)
    acc.forces = (acc.forces || 0) + performance.now() - t
  }
  const N = scale >= 32 ? 25 : 50
  const t0 = performance.now()
  for (let i = 0; i < N; i++) w.step()
  const total = (performance.now() - t0) / N
  let alive = 0
  for (let i = 0; i < w.cap; i++) if (w.alive[i]) alive++
  const parts = Object.entries(acc).sort((a, b) => b[1] - a[1])
  console.log(`scale ${scale}: ${alive} live of ${w.cap} slots, ${total.toFixed(2)} ms/tick`)
  console.log('  ' + parts.map(([k, v]) => `${k} ${(v / N).toFixed(2)}`).join(' | '))
  ;(serialBackend as any).compute = orig
}
