import { MAX_THREADS, type Perf, canShare, gpuAvailable } from '../compute/select'
import { type Init, QUANTA, clamp11, initFromSeed, quantize, stability, substepsFor } from '../core/params'
import { MATRIX_NAMES, N_MATRIX } from '../core/types'
import { configText, download, parseConfig, readHash, writeHash } from './config'
import { PRESETS } from './presets'

const FOOD_BLURB: Record<string, string> = {
  random: 'uniform sprinkle',
  patchy: 'drifting hot-spots',
  gradient: 'one sunlit band',
}

const COUNTS = [
  { key: 'n_intrinsic', label: 'particles', min: 4, max: 60000 },
  { key: 'n_brain', label: 'brains', min: 1, max: 6000 },
  { key: 'n_start', label: 'organisms at start', min: 0, max: 6000 },
  { key: 'n_food0', label: 'food at start', min: 0, max: 60000 },
] as const
type CountKey = (typeof COUNTS)[number]['key']

const SCALES = [1, 2, 4, 8, 16, 32]
const FOOD = N_MATRIX - 1
const TABS = ['world', 'chemistry', 'life', 'compute'] as const
type Tab = (typeof TABS)[number]

function cellColor(a: number): string {
  const m = Math.abs(a)
  return a >= 0 ? `rgba(255,170,60,${0.08 + 0.7 * m})` : `rgba(80,140,255,${0.08 + 0.7 * m})`
}

/**
 * Start screen. The seed proposes a world; everything shown can be edited, exported, imported
 * or shared as a link. Split into tabs because there is now rather a lot of it.
 */
export function mountStart(root: HTMLElement, onStart: (init: Init, perf: Perf) => void, onExplain?: () => void): { show(): void; hide(): void } {
  let init = initFromSeed(Math.floor(Math.random() * 1e9), 1)
  const perf: Perf = { threads: 1, gpu: false }
  let tab: Tab = 'world'
  const fromHash = readHash()
  if (fromHash) {
    init = fromHash.init
    if (fromHash.perf) Object.assign(perf, fromHash.perf)
  }

  root.innerHTML = `
    <div class="card">
      <h1>CELL LIFE</h1>
      <div class="sub">a world is a seed, then whatever you change about it.</div>
      <div class="row">
        <label>seed <input id="seed" inputmode="numeric" /></label>
        <button id="roll">re-roll (R)</button>
        <label>world <select id="scale">${SCALES.map((s) => `<option value="${s}">${s}× (${300 * s}²)</option>`).join('')}</select></label>
        <button id="explainBtn">how it works (H)</button>
      </div>
      <div class="presets" id="presets"></div>
      <div class="tabs">${TABS.map((t) => `<button data-tab="${t}">${t}</button>`).join('')}</div>

      <div class="panel" data-panel="world">
        <dl id="params"></dl>
        <div class="sub" style="margin-bottom:6px">starting population</div>
        <div class="counts" id="counts"></div>
      </div>

      <div class="panel" data-panel="chemistry">
        <table class="m" id="matrix"></table>
        <div class="legend">
          <span style="color:#ffaa3c">■</span> attract &nbsp; <span style="color:#508cff">■</span> repel &nbsp;
          drag a cell, use the arrows, or double-click to type · only one half is shown because the
          matrix is symmetric · Food×Food = 0 · the Food row acts at half strength
        </div>
        <label class="check"><input type="checkbox" id="quantized" /> quantized bonds <span class="dim">— snap the 4×4 to ${QUANTA.join(', ')}</span></label>
      </div>

      <div class="panel" data-panel="life">
        <div class="row">
          <label>temperature <input type="number" id="temp" min="0" max="200" step="0.1" style="width:80px" /></label>
          <label>sub-steps <input type="number" id="substeps" min="1" max="16" style="width:60px" /></label>
          <button id="autoSub">auto</button>
        </div>
        <div id="stab" class="stab"></div>
        <div class="row">
          <label>free decay <input type="number" id="decay" min="0" max="10" step="0.05" style="width:70px" /> %/tick</label>
          <label>food lasts <input type="number" id="foodLife" min="0" max="100000" step="10" style="width:80px" /> ticks <span class="dim">(0 = forever)</span></label>
        </div>
        <label class="check"><input type="checkbox" id="repro" /> reproduction <span class="dim">— organisms holding enough energy bud off a mutated child</span></label>
        <label class="check"><input type="checkbox" id="foodMoves" /> food drifts <span class="dim">— off: food stays where it lands</span></label>
        <label class="check"><input type="checkbox" id="inflow" /> continuous organism inflow <span class="dim">— new particles arrive with every organism, and all matter can die</span></label>
      </div>

      <div class="panel" data-panel="compute">
        <div class="sub" style="margin-bottom:8px">${MAX_THREADS} cores detected; threads and GPU only pay off for large worlds, and never change what the world does</div>
        <div class="row">
          <label>threads <input type="number" id="threads" min="1" max="${MAX_THREADS}" style="width:70px" ${canShare ? '' : 'disabled'} /></label>
          <label class="check" style="margin:0"><input type="checkbox" id="gpu" ${gpuAvailable() ? '' : 'disabled'} /> GPU forces <span class="dim">${gpuAvailable() ? '' : '(WebGPU unavailable)'}</span></label>
        </div>
        <div class="row" style="margin-top:14px">
          <button id="export">export config</button>
          <button id="copy">copy JSON</button>
          <button id="importBtn">import…</button>
          <input type="file" id="file" accept="application/json" hidden />
          <span class="dim" id="io"></span>
        </div>
        <textarea id="paste" placeholder="paste a config JSON here, then press Import again" hidden></textarea>
      </div>

      <div class="go">press ENTER to enter the world</div>
    </div>`
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const seedEl = q<HTMLInputElement>('#seed')
  const matrixEl = q<HTMLTableElement>('#matrix')
  const paramsEl = q('#params')
  const countsEl = q('#counts')
  const ioEl = q('#io')
  const pasteEl = q<HTMLTextAreaElement>('#paste')

  q('#presets').innerHTML = PRESETS.map((p, i) => `<button data-preset="${i}" title="${p.blurb}">${p.name}</button>`).join('')
  for (const el of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-preset]'))) {
    el.addEventListener('click', () => {
      init = PRESETS[Number(el.dataset.preset)].build()
      ioEl.textContent = PRESETS[Number(el.dataset.preset)].blurb
      render()
    })
  }

  for (const el of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
    el.addEventListener('click', () => {
      tab = el.dataset.tab as Tab
      renderTabs()
    })
  }
  function renderTabs(): void {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-tab]'))) el.classList.toggle('on', el.dataset.tab === tab)
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-panel]'))) el.hidden = el.dataset.panel !== tab
  }

  countsEl.innerHTML = COUNTS.map((c) => `<label>${c.label}<input type="number" data-k="${c.key}" min="${c.min}" max="${c.max}" /></label>`).join('')
  const countInputs = Array.from(countsEl.querySelectorAll<HTMLInputElement>('input'))
  for (const input of countInputs) {
    input.addEventListener('input', () => {
      const spec = COUNTS.find((c) => c.key === input.dataset.k)!
      const n = Math.round(Number(input.value))
      if (input.value !== '' && Number.isFinite(n)) {
        init[spec.key] = Math.min(spec.max, Math.max(spec.min, n))
        sync()
      }
    })
    input.addEventListener('change', render)
  }

  const checks = ['quantized', 'repro', 'foodMoves', 'inflow'] as const
  for (const key of checks) {
    q<HTMLInputElement>('#' + key).addEventListener('change', (e) => {
      init[key] = (e.target as HTMLInputElement).checked
      if (key === 'quantized' && init.quantized) {
        for (let i = 0; i < FOOD; i++) {
          for (let j = i; j < FOOD; j++) {
            const v = quantize(init.A[i][j])
            init.A[i][j] = v
            init.A[j][i] = v
          }
        }
      }
      render()
    })
  }
  const numField = (sel: string, apply: (v: number) => void) => {
    const el = q<HTMLInputElement>(sel)
    el.addEventListener('input', () => {
      const v = Number(el.value)
      if (Number.isFinite(v) && el.value !== '') {
        apply(v)
        renderStability()
        sync()
      }
    })
    return el
  }
  const tempEl = numField('#temp', (v) => {
    init.T = Math.min(200, Math.max(0, v))
    // a hotter world needs shorter sub-steps to keep exclusion working; raise them to suit
    init.substeps = Math.max(1, substepsFor(init) || 1)
    subEl.value = String(init.substeps)
  })
  const subEl = numField('#substeps', (v) => (init.substeps = Math.min(16, Math.max(1, Math.round(v)))))
  const decayEl = numField('#decay', (v) => (init.decay_free = Math.min(0.1, Math.max(0, v / 100))))
  const foodLifeEl = numField('#foodLife', (v) => (init.food_life = Math.max(0, Math.round(v))))
  q('#autoSub').addEventListener('click', () => {
    init.substeps = Math.max(1, substepsFor(init) || 16)
    render()
  })
  const threadsEl = q<HTMLInputElement>('#threads')
  threadsEl.addEventListener('input', () => (perf.threads = Math.min(MAX_THREADS, Math.max(1, Math.round(Number(threadsEl.value)) || 1))))
  const gpuEl = q<HTMLInputElement>('#gpu')
  gpuEl.addEventListener('change', () => (perf.gpu = gpuEl.checked))
  const scaleEl = q<HTMLSelectElement>('#scale')
  scaleEl.addEventListener('change', () => resetSeed(init.seed, Number(scaleEl.value)))

  function setCell(i: number, j: number, v: number): void {
    let a = clamp11(v)
    if (init.quantized && i < FOOD && j < FOOD) a = quantize(a)
    init.A[i][j] = a
    init.A[j][i] = a // symmetric by law, so editing one half is editing both
    render()
  }

  /** Lower triangle only: the other half is the same numbers. */
  function renderMatrix(): void {
    let html = '<tr><th></th>' + MATRIX_NAMES.map((n) => `<th>${n}</th>`).join('') + '</tr>'
    for (let i = 0; i < N_MATRIX; i++) {
      html += `<tr><th>${MATRIX_NAMES[i]}</th>`
      for (let j = 0; j < N_MATRIX; j++) {
        if (j > i) html += '<td class="empty"></td>'
        else if (i === FOOD && j === FOOD) html += '<td class="locked">0.00</td>'
        else html += `<td style="background:${cellColor(init.A[i][j])}" data-i="${i}" data-j="${j}" tabindex="0">${init.A[i][j].toFixed(2)}</td>`
      }
      html += '</tr>'
    }
    matrixEl.innerHTML = html
    for (const td of Array.from(matrixEl.querySelectorAll<HTMLTableCellElement>('td[data-i]'))) {
      const i = Number(td.dataset.i)
      const j = Number(td.dataset.j)
      const ask = () => {
        const typed = prompt(`${MATRIX_NAMES[i]} × ${MATRIX_NAMES[j]} (-1 … 1)`, String(init.A[i][j]))
        if (typed !== null && Number.isFinite(Number(typed))) setCell(i, j, Number(typed))
      }
      td.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        td.setPointerCapture(e.pointerId)
        const startY = e.clientY
        const startV = init.A[i][j]
        const move = (ev: PointerEvent) => setCell(i, j, startV - (ev.clientY - startY) / 60)
        const up = () => {
          td.removeEventListener('pointermove', move)
          td.removeEventListener('pointerup', up)
        }
        td.addEventListener('pointermove', move)
        td.addEventListener('pointerup', up)
      })
      td.addEventListener('keydown', (e) => {
        const step = init.quantized ? 0.25 : 0.05
        if (e.key === 'ArrowUp') setCell(i, j, init.A[i][j] + step)
        else if (e.key === 'ArrowDown') setCell(i, j, init.A[i][j] - step)
        else if (/^-?[0-9.]$/.test(e.key)) ask()
      })
      td.addEventListener('dblclick', ask)
    }
  }

  function render(): void {
    if (document.activeElement !== seedEl) seedEl.value = String(init.seed)
    scaleEl.value = String(init.scale)
    renderMatrix()
    const patchy = init.foodMode === 'patchy' ? ` · ${init.n_patch} patches, r=${init.r_patch}, drift ${init.v_patch}` : ''
    const items: [string, string][] = [
      ['food', `${init.foodMode} (${FOOD_BLURB[init.foodMode]})${patchy}`],
      ['food every', `${init.T_food} ticks${init.food_batch > 1 ? ` × ${init.food_batch}` : ''} (up to ${init.max_food} in the world)`],
      ['organism every', `${init.T_spawn} ticks${init.spawn_batch > 1 ? ` × ${init.spawn_batch}` : ''} (brain weights random each time)`],
    ]
    paramsEl.innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    for (const input of countInputs) {
      if (document.activeElement !== input) input.value = String(init[input.dataset.k as CountKey])
    }
    for (const key of checks) q<HTMLInputElement>('#' + key).checked = init[key]
    if (document.activeElement !== tempEl) tempEl.value = String(init.T)
    if (document.activeElement !== subEl) subEl.value = String(init.substeps)
    if (document.activeElement !== decayEl) decayEl.value = (init.decay_free * 100).toFixed(2)
    if (document.activeElement !== foodLifeEl) foodLifeEl.value = String(init.food_life)
    threadsEl.value = String(perf.threads)
    gpuEl.checked = perf.gpu
    renderStability()
    renderTabs()
    sync()
  }

  /** Shows whether the world is inside its discrete-time budgets (see PLAN.md section 1). */
  function renderStability(): void {
    const s = stability(init)
    const pct = (v: number) => `${Math.round(v * 100)}%`
    const need = s.ok ? 0 : substepsFor(init)
    const fix = s.ok ? '' : need > 1 ? ` — needs ${need} sub-steps, or a lower temperature` : ' — lower the temperature'
    q('#stab').innerHTML =
      `<b class="${s.ok ? 'ok' : 'warn'}">${s.ok ? 'stable' : 'steps too long'}</b> ` +
      `<span class="dim">Brownian step ${s.sigma.toFixed(2)} = ${pct(s.sigmaRatio)} of a particle radius · ` +
      `force step ${pct(s.forceRatio)} · ` +
      `${s.structured ? 'cold enough for bonds' : 'melted: hotter than one bond'} (${pct(s.tempRatio)})` +
      fix +
      '</span>'
  }

  function sync(): void {
    writeHash(init, perf)
  }

  function resetSeed(seed: number, scale = init.scale): void {
    init = initFromSeed(Math.floor(seed), scale)
    ioEl.textContent = ''
    render()
  }

  q('#roll').addEventListener('click', () => resetSeed(Math.floor(Math.random() * 1e9)))
  seedEl.addEventListener('input', () => {
    const n = Number(seedEl.value)
    if (Number.isFinite(n) && seedEl.value.trim() !== '') resetSeed(Math.floor(n))
  })
  q('#explainBtn').addEventListener('click', () => onExplain?.())

  q('#export').addEventListener('click', () => {
    download(`cell-life-${init.seed}-${init.scale}x.json`, configText(init, perf))
    ioEl.textContent = 'downloaded'
  })
  q('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(configText(init, perf))
      ioEl.textContent = 'copied'
    } catch {
      pasteEl.hidden = false
      pasteEl.value = configText(init, perf)
      ioEl.textContent = 'copy from the box'
    }
  })
  const applyConfig = (text: string): void => {
    try {
      const parsed = parseConfig(text)
      init = parsed.init
      if (parsed.perf) Object.assign(perf, parsed.perf)
      pasteEl.hidden = true
      ioEl.textContent = 'imported'
      render()
    } catch (e) {
      ioEl.textContent = `could not read that: ${(e as Error).message}`
    }
  }
  q('#importBtn').addEventListener('click', () => {
    if (pasteEl.hidden) {
      pasteEl.hidden = false
      pasteEl.value = ''
      pasteEl.focus()
      ioEl.textContent = 'paste, then press Import again — or pick a file'
      q<HTMLInputElement>('#file').click()
    } else if (pasteEl.value.trim()) applyConfig(pasteEl.value)
    else pasteEl.hidden = true
  })
  q<HTMLInputElement>('#file').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (f) applyConfig(await f.text())
  })

  addEventListener('keydown', (e) => {
    if (root.hidden) return
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      ;(document.activeElement as HTMLElement | null)?.blur()
      onStart(init, { ...perf })
    } else if (typing) return
    else if (e.key === 'r' || e.key === 'R') resetSeed(Math.floor(Math.random() * 1e9))
    else if (e.key === 'h' || e.key === 'H' || e.key === '?') onExplain?.()
    else if (e.key === 'Tab') {
      e.preventDefault()
      tab = TABS[(TABS.indexOf(tab) + 1) % TABS.length]
      renderTabs()
    }
  })

  render()
  return {
    show: () => (root.hidden = false),
    hide: () => (root.hidden = true),
  }
}
