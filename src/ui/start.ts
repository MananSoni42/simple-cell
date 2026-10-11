import { type Init, initFromSeed } from '../core/params'
import { MATRIX_NAMES } from '../core/types'

const FOOD_BLURB: Record<string, string> = {
  random: 'uniform sprinkle',
  patchy: 'drifting hot-spots',
  gradient: 'one sunlit band',
}

/** The only editable knobs besides the seed: how much stuff the world starts with. */
const COUNTS = [
  { key: 'n_intrinsic', label: 'particles', min: 4, max: 300 },
  { key: 'n_brain', label: 'brains', min: 1, max: 30 },
  { key: 'n_start', label: 'organisms at start', min: 0, max: 30 },
  { key: 'n_food0', label: 'food at start', min: 0, max: 120 },
] as const
type CountKey = (typeof COUNTS)[number]['key']

function cellColor(a: number): string {
  const m = Math.abs(a)
  return a >= 0 ? `rgba(255,170,60,${0.08 + 0.7 * m})` : `rgba(80,140,255,${0.08 + 0.7 * m})`
}

/**
 * Start screen. The seed fixes the chemistry and every rate (read-only); the starting
 * population counts default from the seed but can be overridden here.
 */
export function mountStart(root: HTMLElement, onStart: (init: Init) => void): { show(): void; hide(): void } {
  let seed = Math.floor(Math.random() * 1e9)
  const overrides: Partial<Record<CountKey, number>> = {}
  let base = initFromSeed(seed)

  const current = (): Init => {
    const init = { ...base, ...overrides }
    init.n_brain = Math.min(init.n_brain, init.n_intrinsic)
    init.n_start = Math.min(init.n_start, init.n_brain)
    init.n_food0 = Math.min(init.n_food0, init.max_food)
    return init
  }

  root.innerHTML = `
    <div class="card">
      <h1>CELL LIFE</h1>
      <div class="sub">a world is a seed. the chemistry below is frozen.</div>
      <div class="row">
        <label>seed <input id="seed" inputmode="numeric" /></label>
        <button id="roll">re-roll (R)</button>
      </div>
      <table class="m" id="matrix"></table>
      <div class="legend">attraction <span style="color:#ffaa3c">■</span> positive &nbsp; <span style="color:#508cff">■</span> negative &nbsp; (symmetric; Food×Food = 0)</div>
      <dl id="params"></dl>
      <div class="sub" style="margin-bottom:6px">starting population <span class="dim">(editable)</span></div>
      <div class="counts" id="counts"></div>
      <div class="go">press ENTER to enter the world</div>
    </div>`
  const seedEl = root.querySelector<HTMLInputElement>('#seed')!
  const matrixEl = root.querySelector<HTMLTableElement>('#matrix')!
  const paramsEl = root.querySelector<HTMLElement>('#params')!
  const countsEl = root.querySelector<HTMLElement>('#counts')!

  countsEl.innerHTML = COUNTS.map((c) => `<label>${c.label}<input type="number" data-k="${c.key}" min="${c.min}" max="${c.max}" /></label>`).join('')
  const countInputs = Array.from(countsEl.querySelectorAll<HTMLInputElement>("input"))
  for (const input of countInputs) {
    input.addEventListener('input', () => {
      const spec = COUNTS.find((c) => c.key === input.dataset.k)!
      const n = Math.round(Number(input.value))
      if (input.value !== '' && Number.isFinite(n)) overrides[spec.key] = Math.min(spec.max, Math.max(spec.min, n))
    })
    input.addEventListener('change', render)
  }

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
      ['food every', `${init.T_food} ticks (up to ${init.max_food} in the world)`],
      ['organism every', `${init.T_spawn} ticks (brain weights random each time)`],
    ]
    paramsEl.innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    for (const input of countInputs) {
      if (document.activeElement !== input) input.value = String(init[input.dataset.k as CountKey])
    }
  }

  function setSeed(s: number): void {
    seed = s
    base = initFromSeed(seed)
    for (const c of COUNTS) delete overrides[c.key]
    render()
  }

  root.querySelector('#roll')!.addEventListener('click', () => setSeed(Math.floor(Math.random() * 1e9)))
  seedEl.addEventListener('input', () => {
    const n = Number(seedEl.value)
    if (Number.isFinite(n) && seedEl.value.trim() !== '') setSeed(Math.floor(n))
  })
  addEventListener('keydown', (e) => {
    if (root.hidden) return
    const typing = e.target instanceof HTMLInputElement
    if (e.key === 'Enter') {
      ;(document.activeElement as HTMLElement | null)?.blur()
      onStart(current())
    } else if ((e.key === 'r' || e.key === 'R') && !typing) setSeed(Math.floor(Math.random() * 1e9))
  })

  render()
  return {
    show: () => (root.hidden = false),
    hide: () => (root.hidden = true),
  }
}
