import { MAX_THREADS, type Perf, canShare, gpuAvailable } from '../compute/select'
import { type Init, initFromSeed } from '../core/params'
import { MATRIX_NAMES } from '../core/types'

const FOOD_BLURB: Record<string, string> = {
  random: 'uniform sprinkle',
  patchy: 'drifting hot-spots',
  gradient: 'one sunlit band',
}

/** Starting-population knobs. Defaults come from the seed (and the world scale); each can be overridden. */
const COUNTS = [
  { key: 'n_intrinsic', label: 'particles', min: 4, max: 60000 },
  { key: 'n_brain', label: 'brains', min: 1, max: 6000 },
  { key: 'n_start', label: 'organisms at start', min: 0, max: 6000 },
  { key: 'n_food0', label: 'food at start', min: 0, max: 60000 },
] as const
type CountKey = (typeof COUNTS)[number]['key']

const SCALES = [1, 2, 4, 8, 16, 32]

function cellColor(a: number): string {
  const m = Math.abs(a)
  return a >= 0 ? `rgba(255,170,60,${0.08 + 0.7 * m})` : `rgba(80,140,255,${0.08 + 0.7 * m})`
}

/**
 * Start screen. The seed fixes the chemistry and every rate (read-only). The world
 * scale, starting population, a few world options and the compute settings are editable.
 */
export function mountStart(root: HTMLElement, onStart: (init: Init, perf: Perf) => void): { show(): void; hide(): void } {
  let seed = Math.floor(Math.random() * 1e9)
  let scale = 1
  const overrides: Partial<Record<CountKey, number>> = {}
  const flags = { inflow: false, foodMoves: false, repro: true }
  let decayPct = 0.2 // % of its reserve a free particle loses per tick
  const perf: Perf = { threads: 1, gpu: false }
  let base = initFromSeed(seed, scale)

  const current = (): Init => {
    const init = { ...base, ...overrides, ...flags, decay_free: decayPct / 100 }
    init.n_brain = Math.min(init.n_brain, init.n_intrinsic)
    init.n_start = Math.min(init.n_start, init.n_brain)
    init.n_food0 = Math.min(init.n_food0, init.max_food)
    return init
  }

  const check = (id: string, label: string, hint: string, off = false) =>
    `<label class="check"><input type="checkbox" id="${id}" ${off ? 'disabled' : ''} /> ${label} <span class="dim">— ${hint}</span></label>`

  root.innerHTML = `
    <div class="card">
      <h1>CELL LIFE</h1>
      <div class="sub">a world is a seed. the chemistry below is frozen.</div>
      <div class="row">
        <label>seed <input id="seed" inputmode="numeric" /></label>
        <button id="roll">re-roll (R)</button>
        <label>world <select id="scale">${SCALES.map((s) => `<option value="${s}">${s}× (${300 * s}²)</option>`).join('')}</select></label>
      </div>
      <table class="m" id="matrix"></table>
      <div class="legend">attraction <span style="color:#ffaa3c">■</span> positive &nbsp; <span style="color:#508cff">■</span> negative &nbsp; (symmetric; Food×Food = 0)</div>
      <dl id="params"></dl>
      <div class="sub" style="margin-bottom:6px">starting population <span class="dim">(editable)</span></div>
      <div class="counts" id="counts"></div>
      <div class="row"><label>free particle decay <input type="number" id="decay" min="0" max="10" step="0.05" value="0.2" style="width:80px" /> % of reserve per tick <span class="dim">(0 = off)</span></label></div>
      ${check('repro', 'reproduction', 'organisms holding enough energy bud off a mutated child')}
      ${check('foodMoves', 'food drifts', 'off: food stays where it lands')}
      ${check('inflow', 'continuous organism inflow', 'new particles arrive with every organism, and all matter can die')}
      <div class="sub" style="margin:14px 0 6px">compute <span class="dim">(${MAX_THREADS} cores detected; only pays off for large worlds)</span></div>
      <div class="row">
        <label>threads <input type="number" id="threads" min="1" max="${MAX_THREADS}" value="1" ${canShare ? '' : 'disabled'} /></label>
        <label class="check" style="margin:0"><input type="checkbox" id="gpu" ${gpuAvailable() ? '' : 'disabled'} /> GPU forces <span class="dim">${gpuAvailable() ? '' : '(WebGPU unavailable)'}</span></label>
      </div>
      <div class="go">press ENTER to enter the world</div>
    </div>`
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const seedEl = q<HTMLInputElement>('#seed')
  const matrixEl = q<HTMLTableElement>('#matrix')
  const paramsEl = q('#params')
  const countsEl = q('#counts')

  countsEl.innerHTML = COUNTS.map((c) => `<label>${c.label}<input type="number" data-k="${c.key}" min="${c.min}" max="${c.max}" /></label>`).join('')
  const countInputs = Array.from(countsEl.querySelectorAll<HTMLInputElement>('input'))
  for (const input of countInputs) {
    input.addEventListener('input', () => {
      const spec = COUNTS.find((c) => c.key === input.dataset.k)!
      const n = Math.round(Number(input.value))
      if (input.value !== '' && Number.isFinite(n)) overrides[spec.key] = Math.min(spec.max, Math.max(spec.min, n))
    })
    input.addEventListener('change', render)
  }

  for (const key of ['repro', 'foodMoves', 'inflow'] as const) {
    const el = q<HTMLInputElement>('#' + key)
    el.checked = flags[key]
    el.addEventListener('change', () => (flags[key] = el.checked))
  }
  const decayEl = q<HTMLInputElement>('#decay')
  decayEl.addEventListener('input', () => (decayPct = Math.min(10, Math.max(0, Number(decayEl.value) || 0))))
  const threadsEl = q<HTMLInputElement>('#threads')
  const gpuEl = q<HTMLInputElement>('#gpu')
  threadsEl.addEventListener('input', () => (perf.threads = Math.min(MAX_THREADS, Math.max(1, Math.round(Number(threadsEl.value)) || 1))))
  gpuEl.addEventListener('change', () => (perf.gpu = gpuEl.checked))
  const scaleEl = q<HTMLSelectElement>('#scale')
  scaleEl.addEventListener('change', () => {
    scale = Number(scaleEl.value)
    resetSeed(seed)
  })

  function render(): void {
    const init = current()
    if (document.activeElement !== seedEl) seedEl.value = String(seed)
    const head = '<tr><th></th>' + MATRIX_NAMES.map((n) => `<th>${n}</th>`).join('') + '</tr>'
    const rows = init.A.map(
      (row, i) =>
        `<tr><th>${MATRIX_NAMES[i]}</th>` +
        row.map((a) => `<td style="background:${cellColor(a)}">${a.toFixed(2)}</td>`).join('') +
        '</tr>',
    ).join('')
    matrixEl.innerHTML = head + rows
    const patchy = init.foodMode === 'patchy' ? ` · ${init.n_patch} patches, r=${init.r_patch}, drift ${init.v_patch}` : ''
    const items: [string, string][] = [
      ['temperature', String(init.T)],
      ['food', `${init.foodMode} (${FOOD_BLURB[init.foodMode]})${patchy}`],
      ['food every', `${init.T_food} ticks${init.food_batch > 1 ? ` × ${init.food_batch}` : ''} (up to ${init.max_food} in the world)`],
      ['organism every', `${init.T_spawn} ticks${init.spawn_batch > 1 ? ` × ${init.spawn_batch}` : ''} (brain weights random each time)`],
    ]
    paramsEl.innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    for (const input of countInputs) {
      if (document.activeElement !== input) input.value = String(init[input.dataset.k as CountKey])
    }
  }

  function resetSeed(s: number): void {
    seed = s
    base = initFromSeed(seed, scale)
    for (const c of COUNTS) delete overrides[c.key]
    render()
  }

  q('#roll').addEventListener('click', () => resetSeed(Math.floor(Math.random() * 1e9)))
  seedEl.addEventListener('input', () => {
    const n = Number(seedEl.value)
    if (Number.isFinite(n) && seedEl.value.trim() !== '') resetSeed(Math.floor(n))
  })
  addEventListener('keydown', (e) => {
    if (root.hidden) return
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
    if (e.key === 'Enter') {
      ;(document.activeElement as HTMLElement | null)?.blur()
      onStart(current(), { ...perf })
    } else if ((e.key === 'r' || e.key === 'R') && !typing) resetSeed(Math.floor(Math.random() * 1e9))
  })

  render()
  return {
    show: () => (root.hidden = false),
    hide: () => (root.hidden = true),
  }
}
