import { makeBackend, MAX_THREADS, canShare, gpuAvailable } from './compute/select'
import { serialBackend } from './core/backend'
import { census } from './core/metrics'
import { initFromSeed } from './core/params'
import { World } from './core/world'

/** Times each force backend on the same world and checks it against the serial kernel. */
const q = new URLSearchParams(location.search)
const scale = Number(q.get('scale') || 8)
const ticks = Number(q.get('ticks') || 20)
const out = document.getElementById('out')!
const lines: string[] = []
const sink = q.get('sink') // optional http endpoint that collects results when run headless
const log = (s: string) => {
  lines.push(s)
  out.textContent = lines.join('\n')
  if (sink) void fetch(sink, { method: 'POST', body: s, mode: 'cors' }).catch(() => undefined)
}

async function main(): Promise<void> {
  const w = new World(initFromSeed(3, scale), { shared: canShare })
  for (let i = 0; i < 150; i++) w.step()
  const c = census(w)
  log(`scale ${scale}: world ${w.L.SIZE}x${w.L.SIZE}, slots ${w.cap}, organisms ${c.organisms}, food ${c.food}`)
  log(`isolated=${canShare} cores=${MAX_THREADS} webgpu=${gpuAvailable()}`)

  const configs: { label: string; perf: { threads: number; gpu: boolean } }[] = [{ label: 'serial', perf: { threads: 1, gpu: false } }]
  if (canShare) for (const t of [2, 4, 8, MAX_THREADS]) if (t <= MAX_THREADS && !configs.some((c) => c.perf.threads === t && !c.perf.gpu)) configs.push({ label: `${t} threads`, perf: { threads: t, gpu: false } })
  if (gpuAvailable()) configs.push({ label: 'gpu', perf: { threads: 1, gpu: true } })

  for (const { label, perf } of configs) {
    const { backend, note } = await makeBackend(w, perf)
    if (note) {
      log(`${label}: ${note}`)
      continue
    }
    // reference forces from the serial kernel on the current state
    w.grid.build()
    serialBackend.compute(w)
    const ref = { fx: Float64Array.from(w.fx), fy: Float64Array.from(w.fy), near: Float32Array.from(w.foodNear) }
    await backend.compute(w)
    let worst = 0
    let scaleF = 1e-12
    let nearBad = 0
    for (let i = 0; i < w.cap; i++) {
      if (!w.alive[i] || (!w.init.foodMoves && w.type[i] === 5)) continue // serial skips static food
      scaleF = Math.max(scaleF, Math.abs(ref.fx[i]), Math.abs(ref.fy[i]))
      worst = Math.max(worst, Math.abs(w.fx[i] - ref.fx[i]), Math.abs(w.fy[i] - ref.fy[i]))
      if (w.foodNear[i] !== ref.near[i]) nearBad++
    }
    w.backend = backend
    for (let i = 0; i < 3; i++) await w.stepAsync()
    const t0 = performance.now()
    for (let i = 0; i < ticks; i++) await w.stepAsync()
    const ms = (performance.now() - t0) / ticks
    const live = w.nMatter + w.nFood
    log(`${backend.name.padEnd(28)} ${ms.toFixed(2).padStart(8)} ms/tick  ${(1000 / ms).toFixed(1).padStart(8)} tick/s  ${((live * 1000) / ms / 1e6).toFixed(2).padStart(7)} Mparticle-ticks/s  maxForceErr/scale=${(worst / scaleF).toExponential(1)} foodNear mismatches=${nearBad}`)
    backend.dispose?.()
    w.backend = serialBackend
  }
  log('DONE')
  document.title = 'done'
}

main().catch((e) => {
  log('ERROR ' + (e as Error).stack)
  document.title = 'error'
})
