import { MAX_THREADS, type Perf, canShare, gpuAvailable } from '../compute/select'
import {
  type FoodLevel,
  type FoodMode,
  type FoodRegime,
  type Init,
  LEVEL_MULTIPLIER,
  QUANTA,
  type WallLayout,
  applyFoodLevel,
  baseFoodRate,
  clamp11,
  initFromSeed,
  quantize,
  stability,
  substepsFor,
  sustenanceRate,
} from '../core/params'
import { MATRIX_NAMES, N_MATRIX } from '../core/types'
import { configText, download, parseConfig, readHash, writeHash } from './config'
import { capture } from '../render/renderer'
import { Chips, Slider, Toggle, card, fieldsOf } from './controls'
import { PRESETS } from './presets'

const FOOD = N_MATRIX - 1
const TABS = [
  ['physics', 'Physics'],
  ['chemistry', 'Chemistry'],
  ['food', 'Food'],
  ['life', 'Life'],
  ['compute', 'Compute'],
] as const
type Tab = (typeof TABS)[number][0]

function cellColor(a: number): string {
  const m = Math.abs(a)
  return a >= 0 ? `rgba(255,170,60,${0.08 + 0.7 * m})` : `rgba(80,140,255,${0.08 + 0.7 * m})`
}

/**
 * World setup, grouped by what each setting governs rather than by which part of the code reads
 * it. Sliders carry a line of plain English about what the current value *means*, so a number
 * does not have to be understood to be used.
 */
export function mountSetup(
  root: HTMLElement,
  hooks: { start(init: Init, perf: Perf): void; back(): void; explain(): void; library(): void },
): { refresh(): void } {
  let init = initFromSeed(Math.floor(Math.random() * 1e9), 1)
  const perf: Perf = { threads: 1, gpu: false }
  let tab: Tab = 'physics'
  /** Which preset is selected, or -1 for a seeded world. */
  let chosen = -1
  const fromHash = readHash()
  if (fromHash) {
    init = fromHash.init
    if (fromHash.perf) Object.assign(perf, fromHash.perf)
  }

  root.innerHTML = `
    <div class="setup">
      <div class="setup-head">
        <div>
          <h1>PICK A WORLD</h1>
          <div class="note">three choices is enough to start. the rest of it is down there if you want it.</div>
        </div>
        <div class="row">
          <button id="s-back">← back</button>
          <button id="s-lib">collection</button>
          <button id="s-how">how it works</button>
        </div>
      </div>

      <div class="pick">
        <div class="field"><div class="field-head"><label>a world</label></div>
          <div class="presets" id="s-presets"></div>
          <div class="field-hint" id="s-preset-hint"></div>
        </div>
        <div id="s-size"></div>
        <div class="row" style="margin-bottom:18px">
          <label class="mono-k">seed</label>
          <input id="s-seed" inputmode="numeric" style="width:120px" />
          <button id="s-roll">re-roll</button>
          <span class="note" id="s-io"></span>
        </div>
      </div>

      <div class="row" style="margin-bottom:20px">
        <button class="primary" id="s-start">Build it →</button>
        <span class="note">it opens paused, so you can place things before it runs</span>
      </div>

      <details class="advanced" id="s-adv">
        <summary>Advanced <span class="note" id="s-changed"></span></summary>
        <div class="tabs">${TABS.map(([k, label]) => `<button type="button" data-tab="${k}">${label}</button>`).join('')}</div>
        ${TABS.map(([k]) => `<div class="panel" data-panel="${k}"></div>`).join('')}
      </details>
    </div>`

  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const seedEl = q<HTMLInputElement>('#s-seed')
  const ioEl = q('#s-io')
  const panel = (k: Tab): HTMLElement => q(`[data-panel="${k}"]`)

  // ------------------------------------------------------------------ physics
  const physics = (): void => {
    const p = panel('physics')
    p.innerHTML = '<div class="cols"></div><div class="stab" id="s-stab"></div>'
    const cols = p.querySelector('.cols')!
    const left = card('The world')
    const right = card('Matter')
    cols.append(left, right)

    fieldsOf(left).append(
      new Chips<string>({
        label: 'size',
        value: String(init.scale),
        options: [1, 2, 4, 8, 16, 32].map((s) => ({ value: String(s), label: `${s}×`, hint: `${300 * s} units across` })),
        onChange: (v) => reseed(init.seed, Number(v)),
      }).el,
      new Slider({
        label: 'temperature',
        min: 0.1,
        max: 40,
        step: 0.1,
        value: init.T,
        curve: 'log',
        hint: (v) => {
          const s = stability({ ...init, T: v })
          if (!s.ok) return 'too hot for this step size — sub-steps will be raised to suit'
          if (v < 1) return 'very cold: whatever forms will freeze in place'
          if (v < 4) return 'cold: structures hold together'
          return 'warm: bonds form but keep being torn apart'
        },
        onChange: (v) => {
          init.T = v
          init.substeps = Math.max(1, substepsFor(init) || 1)
          refresh()
        },
      }).el,
      new Slider({
        label: 'sub-steps',
        min: 1,
        max: 16,
        step: 1,
        value: init.substeps,
        hint: (v) => (v === 1 ? 'one move per tick' : `each tick split into ${v}, so no single move is long enough to pass through anything`),
        onChange: (v) => {
          init.substeps = v
          refresh()
        },
      }).el,
      new Chips<WallLayout>({
        label: 'terrain',
        value: init.walls,
        options: [
          { value: 'none', label: 'open', hint: 'nothing in the way' },
          { value: 'pillars', label: 'pillars', hint: 'a regular grid of immovable blocks' },
          { value: 'maze', label: 'maze', hint: 'straight runs at right angles' },
          { value: 'ring', label: 'ring', hint: 'one closed circle of wall' },
        ],
        onChange: (v) => {
          init.walls = v
          refresh()
        },
      }).el,
    )

    fieldsOf(right).append(
      new Slider({
        label: 'particles',
        min: 4,
        max: Math.max(200, 60 * init.scale * init.scale),
        step: 1,
        value: init.n_intrinsic,
        curve: 'log',
        hint: (v) => `${(v / (init.size * init.size / 1e4)).toFixed(1)} per 100×100 of world`,
        onChange: (v) => {
          init.n_intrinsic = v
          sync()
        },
      }).el,
      new Slider({
        label: 'brains',
        min: 1,
        max: Math.max(20, 20 * init.scale * init.scale),
        step: 1,
        value: init.n_brain,
        hint: (v) => `at most ${v} organisms alive at once${init.inflow ? ` (×3 with inflow on)` : ''}`,
        onChange: (v) => {
          init.n_brain = v
          init.n_start = Math.min(init.n_start, v)
          refresh()
        },
      }).el,
      new Toggle({
        label: 'particle bonds',
        hint: 'touching particles with attractive chemistry latch, and hold until pulled much harder — the route to compound organisms',
        value: init.bonds,
        onChange: (v) => {
          init.bonds = v
          sync()
        },
      }).el,
      new Toggle({
        label: 'continuous inflow',
        hint: 'new matter arrives with every organism, and all matter can die — a world that turns over instead of filling up',
        value: init.inflow,
        onChange: (v) => {
          init.inflow = v
          refresh()
        },
      }).el,
    )
    paintStability()
  }

  const paintStability = (): void => {
    const el = root.querySelector('#s-stab')
    if (!el) return
    const s = stability(init)
    const need = s.ok ? 0 : substepsFor(init)
    el.innerHTML =
      `<b class="${s.ok ? 'ok' : 'warn'}">${s.ok ? 'stable' : 'steps too long'}</b> — ` +
      `a particle moves ${s.sigma.toFixed(2)} per sub-step, ${Math.round(s.sigmaRatio * 100)}% of its own radius; ` +
      `${s.structured ? 'cold enough for bonds to survive' : 'hotter than one bond, so structures melt'}.` +
      (s.ok ? '' : need > 1 ? ` Needs ${need} sub-steps, or less heat.` : ' Lower the temperature.')
  }

  // ------------------------------------------------------------------ chemistry
  const chemistry = (): void => {
    const p = panel('chemistry')
    p.innerHTML = `
      <div class="note" style="margin-bottom:12px">Fifteen numbers decide everything the world can build.
        Positive attracts, negative repels. Drag a cell up or down, or double-click to type.
        Only one half is shown: the table is symmetric by law.</div>
      <table class="m" id="s-matrix"></table>
      <div class="legend" style="margin-bottom:16px">
        <span><span class="swatch" style="background:rgba(255,170,60,.8)"></span>attract</span>
        <span><span class="swatch" style="background:rgba(80,140,255,.8)"></span>repel</span>
        <span class="note">Food×Food is always 0 · the Food row acts at half strength</span>
      </div>
      <div class="cols"><div id="s-chem-l"></div></div>`
    const l = q('#s-chem-l')
    l.append(
      new Toggle({
        label: 'quantized bonds',
        hint: `snap the 4×4 to ${QUANTA.join(', ')} — far fewer distinct chemistries, so a world is repeatable and comparable`,
        value: init.quantized,
        onChange: (v) => {
          init.quantized = v
          if (v) {
            for (let i = 0; i < FOOD; i++) {
              for (let j = i; j < FOOD; j++) setCell(i, j, quantize(init.A[i][j]), false)
            }
          }
          refresh()
        },
      }).el,
    )
    paintMatrix()
  }

  function setCell(i: number, j: number, v: number, repaint = true): void {
    let a = clamp11(v)
    if (init.quantized && i < FOOD && j < FOOD) a = quantize(a)
    init.A[i][j] = a
    init.A[j][i] = a
    if (repaint) {
      paintMatrix()
      sync()
    }
  }

  function paintMatrix(): void {
    const el = root.querySelector<HTMLTableElement>('#s-matrix')
    if (!el) return
    let html = '<tr><th></th>' + MATRIX_NAMES.map((nm) => `<th>${nm}</th>`).join('') + '</tr>'
    for (let i = 0; i < N_MATRIX; i++) {
      html += `<tr><th>${MATRIX_NAMES[i]}</th>`
      for (let j = 0; j < N_MATRIX; j++) {
        if (j > i) html += '<td class="empty"></td>'
        else if (i === FOOD && j === FOOD) html += '<td class="locked">0.00</td>'
        else
          html += `<td style="background:${cellColor(init.A[i][j])}" data-i="${i}" data-j="${j}" tabindex="0">${init.A[i][j].toFixed(2)}</td>`
      }
      html += '</tr>'
    }
    el.innerHTML = html
    for (const td of Array.from(el.querySelectorAll<HTMLTableCellElement>('td[data-i]'))) {
      const i = Number(td.dataset.i)
      const j = Number(td.dataset.j)
      const ask = (): void => {
        const typed = prompt(`${MATRIX_NAMES[i]} × ${MATRIX_NAMES[j]}  (−1 … 1)`, String(init.A[i][j]))
        if (typed !== null && Number.isFinite(Number(typed))) setCell(i, j, Number(typed))
      }
      td.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        capture(td, e)
        const y0 = e.clientY
        const v0 = init.A[i][j]
        const move = (ev: PointerEvent): void => setCell(i, j, v0 - (ev.clientY - y0) / 60)
        const up = (): void => {
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

  // ------------------------------------------------------------------ food
  const food = (): void => {
    const p = panel('food')
    p.innerHTML = '<div class="cols"></div>'
    const cols = p.querySelector('.cols')!
    const where = card('Where it falls')
    const how = card('How much, and for how long')
    cols.append(where, how)

    fieldsOf(where).append(
      new Chips<FoodMode>({
        label: 'pattern',
        value: init.foodMode,
        options: [
          { value: 'random', label: 'uniform', hint: 'everywhere equally — standing still is as good as moving' },
          { value: 'patchy', label: 'patches', hint: 'a few drifting hot-spots, so following the food pays' },
          { value: 'gradient', label: 'sunlit band', hint: 'one bright stripe; the rest is desert' },
          { value: 'converging', label: 'colonies', hint: 'separate colonies that slowly migrate together and merge into one — isolation, then contact' },
          { value: 'breathing', label: 'breathing', hint: 'colonies that merge and separate again, for ever — populations meet, mix, and are pulled apart to drift on their own' },
          { value: 'spring', label: 'spring', hint: 'a single small fixed source everything must come to; the most contested world there is' },
          { value: 'comet', label: 'comet', hint: 'one fast-moving source: food is a target you follow or starve' },
          { value: 'ring', label: 'ring', hint: 'a closed band of food around the middle — a circuit rather than a field' },
        ],
        onChange: (v) => {
          init.foodMode = v
          refresh()
        },
      }).el,
      new Toggle({
        label: 'food drifts',
        hint: 'off, food sits where it lands and has to be reached',
        value: init.foodMoves,
        onChange: (v) => {
          init.foodMoves = v
          sync()
        },
      }).el,
    )
    if (init.foodMode === 'converging' || init.foodMode === 'breathing') {
      const breathing = init.foodMode === 'breathing'
      fieldsOf(where).append(
        new Slider({
          label: 'colonies',
          min: 2,
          max: 4,
          step: 1,
          value: Math.max(2, Math.min(4, init.n_patch)),
          hint: (v) => `${v} colonies, spread evenly round the world to begin with`,
          onChange: (v) => {
            init.n_patch = v
            refresh()
          },
        }).el,
        new Slider({
          label: breathing ? 'one full breath' : 'meet after',
          min: 200,
          max: 40000,
          step: 100,
          value: init.converge_ticks,
          curve: 'log',
          format: (v) => `${Math.round(v)}t`,
          hint: (v) =>
            breathing
              ? `merged every ${Math.round(v)} ticks and fully apart again halfway between`
              : `apart until roughly tick ${Math.round(v * 0.3)}, fully merged by ${Math.round(v)}`,
          onChange: (v) => {
            init.converge_ticks = Math.round(v)
            sync()
          },
        }).el,
      )
    }
    if (init.foodMode !== 'random' && init.foodMode !== 'gradient') {
      fieldsOf(where).append(
        new Slider({
          label: 'source radius',
          min: 10,
          max: 200,
          step: 5,
          value: init.r_patch,
          hint: (v) => `${Math.round((100 * Math.PI * v * v * Math.max(1, init.n_patch)) / (init.size * init.size))}% of the world is within reach of food`,
          onChange: (v) => {
            init.r_patch = v
            refresh()
          },
        }).el,
      )
    }
    if (init.foodMode === 'patchy') {
      fieldsOf(where).append(
        new Slider({
          label: 'patches',
          min: 1,
          max: Math.max(6, 6 * init.scale * init.scale),
          step: 1,
          value: init.n_patch,
          onChange: (v) => {
            init.n_patch = v
            sync()
          },
        }).el,
      )
    }

    const sus = sustenanceRate(init)
    fieldsOf(how).append(
      new Chips<FoodLevel>({
        label: 'how much',
        value: init.foodLevel,
        options: [
          { value: 'scarce', label: 'scarce', hint: 'about a fifth of what the world spends — most things starve, and position decides who does not' },
          { value: 'average', label: 'average', hint: 'enough for a contested population well below the cap' },
          { value: 'abundant', label: 'abundant', hint: 'more than can be eaten; food piles up to the cap' },
        ],
        onChange: (v) => {
          init.foodLevel = v
          applyFoodLevel(init)
          refresh()
        },
      }).el,
      new Chips<FoodRegime>({
        label: 'over time',
        value: init.foodRegime,
        options: [
          { value: 'steady', label: 'steady', hint: 'the same rate forever' },
          { value: 'cycle', label: 'cycle', hint: 'famine to feast and back again — 0.15× at the trough, 2.5× at the peak' },
          { value: 'bloom', label: 'bloom', hint: 'a long famine broken by brief, enormous blooms at 9×' },
          { value: 'decline', label: 'decline', hint: 'a world running down: full at the start, nothing by the end' },
          { value: 'rising', label: 'rising', hint: 'a world filling up, from almost nothing to plenty' },
          { value: 'noisy', label: 'noisy', hint: 'wanders unpredictably, with no pattern to learn' },
        ],
        onChange: (v) => {
          init.foodRegime = v
          refresh()
        },
      }).el,
      new Slider({
        label: 'arrives every',
        min: 1,
        max: 60,
        step: 1,
        value: init.T_food,
        curve: 'log',
        format: (v) => `${Math.round(v)}t`,
        hint: (v) => {
          const r = init.food_batch / v
          return `${r.toFixed(2)} particles a tick — ${(r / Math.max(1e-6, sus)).toFixed(2)}× what this world spends`
        },
        onChange: (v) => {
          init.T_food = v
          refresh()
        },
      }).el,
      new Slider({
        label: 'spoils after',
        min: 0,
        max: 3000,
        step: 10,
        value: init.food_life,
        format: (v) => (v === 0 ? 'never' : `${Math.round(v)}t`),
        hint: (v) =>
          v === 0
            ? 'food waits forever, so it piles up to the cap'
            : `uneaten food lasts ${Math.round(v)} ticks — scarcity is what makes foraging worth the cost`,
        onChange: (v) => {
          init.food_life = v
          refresh()
        },
      }).el,
      new Slider({
        label: 'at most',
        min: 10,
        max: Math.max(400, 400 * init.scale * init.scale),
        step: 10,
        value: init.max_food,
        curve: 'log',
        hint: () => 'the sun pauses while this much food is in the world',
        onChange: (v) => {
          init.max_food = v
          init.n_food0 = Math.min(init.n_food0, v)
          refresh()
        },
      }).el,
      ...(init.foodRegime === 'steady'
        ? []
        : [
            new Slider({
              label: init.foodRegime === 'cycle' || init.foodRegime === 'bloom' ? 'cycle length' : 'over',
              min: 200,
              max: 100000,
              step: 100,
              value: init.regime_period,
              curve: 'log',
              format: (v) => `${Math.round(v)}t`,
              hint: () => `at ${baseFoodRate(init).toFixed(2)} a tick on average, ${LEVEL_MULTIPLIER[init.foodLevel]}× sustenance`,
              onChange: (v) => {
                init.regime_period = Math.round(v)
                refresh()
              },
            }).el,
          ]),
      new Slider({
        label: 'at the start',
        min: 0,
        max: Math.max(100, init.max_food),
        step: 5,
        value: init.n_food0,
        onChange: (v) => {
          init.n_food0 = v
          sync()
        },
      }).el,
    )
  }

  // ------------------------------------------------------------------ life
  const life = (): void => {
    const p = panel('life')
    p.innerHTML = '<div class="cols"></div>'
    const cols = p.querySelector('.cols')!
    const arrive = card('Arrivals')
    const rules = card('Living and dying')
    cols.append(arrive, rules)

    fieldsOf(arrive).append(
      new Slider({
        label: 'organisms at the start',
        min: 0,
        max: Math.max(1, init.n_brain),
        step: 1,
        value: init.n_start,
        onChange: (v) => {
          init.n_start = v
          sync()
        },
      }).el,
      new Slider({
        label: 'a new one every',
        min: 5,
        max: 2000,
        step: 5,
        value: init.T_spawn,
        curve: 'log',
        format: (v) => `${Math.round(v)}t`,
        hint: () => 'spawned organisms get random brain weights — nothing about them is designed',
        onChange: (v) => {
          init.T_spawn = v
          sync()
        },
      }).el,
    )

    fieldsOf(rules).append(
      new Toggle({
        label: 'reproduction',
        hint: 'an organism with enough energy pays for a child from its own reserve, passing on its weights with a little noise',
        value: init.repro,
        onChange: (v) => {
          init.repro = v
          refresh()
        },
      }).el,
      new Slider({
        label: 'mutation',
        min: 0,
        max: 0.5,
        step: 0.005,
        value: init.repro_mut,
        format: (v) => v.toFixed(3),
        hint: (v) => (v === 0 ? 'children are exact copies' : v < 0.1 ? 'children resemble their parents closely' : 'children differ sharply from their parents'),
        onChange: (v) => {
          init.repro_mut = v
          sync()
        },
      }).el,
      new Slider({
        label: 'free particles decay',
        min: 0,
        max: 2,
        step: 0.02,
        value: init.decay_free * 100,
        format: (v) => `${v.toFixed(2)}%`,
        hint: (v) =>
          v === 0
            ? 'loose matter keeps its energy forever'
            : `a loose particle is half empty after ${Math.round(Math.log(0.5) / Math.log(1 - v / 100))} ticks`,
        onChange: (v) => {
          init.decay_free = v / 100
          refresh()
        },
      }).el,
    )
  }

  // ------------------------------------------------------------------ compute
  const compute = (): void => {
    const p = panel('compute')
    p.innerHTML = `
      <div class="note" style="margin-bottom:14px">${MAX_THREADS} cores detected. These change only
        <i>where</i> the forces are computed, never what the world does — threads give bit-identical
        results, and the GPU matches to about one part in ten thousand.</div>
      <div class="cols"><div id="s-c-l"></div><div id="s-c-r"></div></div>
      <div class="row" style="margin-top:10px">
        <button id="s-export">export config</button>
        <button id="s-copy">copy JSON</button>
        <button id="s-import">import…</button>
        <input type="file" id="s-file" accept="application/json" hidden />
      </div>
      <textarea id="s-paste" placeholder="paste a config here, then press Import again" hidden></textarea>`
    q('#s-c-l').append(
      new Slider({
        label: 'threads',
        min: 1,
        max: Math.max(1, MAX_THREADS),
        step: 1,
        value: perf.threads,
        hint: (v) => (!canShare ? 'unavailable: this page is not cross-origin isolated' : v === 1 ? 'one thread' : `forces split across ${v}; only worth it for large worlds`),
        onChange: (v) => (perf.threads = v),
      }).el,
    )
    q('#s-c-r').append(
      new Toggle({
        label: 'GPU forces',
        hint: gpuAvailable() ? 'WebGPU compute, single precision' : 'WebGPU is unavailable in this browser',
        value: perf.gpu,
        onChange: (v) => (perf.gpu = v && gpuAvailable()),
      }).el,
    )

    const paste = q<HTMLTextAreaElement>('#s-paste')
    q('#s-export').addEventListener('click', () => {
      download(`simplecell-${init.seed}-${init.scale}x.json`, configText(init, perf))
      ioEl.textContent = 'downloaded'
    })
    q('#s-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(configText(init, perf))
        ioEl.textContent = 'copied'
      } catch {
        paste.hidden = false
        paste.value = configText(init, perf)
        ioEl.textContent = 'copy it from the box'
      }
    })
    const apply = (text: string): void => {
      try {
        const parsed = parseConfig(text)
        init = parsed.init
        if (parsed.perf) Object.assign(perf, parsed.perf)
        paste.hidden = true
        ioEl.textContent = 'imported'
        refresh()
      } catch (e) {
        ioEl.textContent = `could not read that: ${(e as Error).message}`
      }
    }
    q('#s-import').addEventListener('click', () => {
      if (paste.hidden) {
        paste.hidden = false
        paste.value = ''
        paste.focus()
        ioEl.textContent = 'paste it, then press Import again — or pick a file'
        q<HTMLInputElement>('#s-file').click()
      } else if (paste.value.trim()) apply(paste.value)
      else paste.hidden = true
    })
    q<HTMLInputElement>('#s-file').addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (f) apply(await f.text())
    })
  }

  // ------------------------------------------------------------------ chrome
  q('#s-presets').innerHTML =
    PRESETS.map((p, i) => `<button type="button" data-preset="${i}" title="${p.blurb}">${p.name}</button>`).join('') +
    '<button type="button" data-preset="-1" title="whatever the seed happens to produce">Surprise me</button>'
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-preset]'))) {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.preset)
      if (i < 0) {
        chosen = -1
        reseed(Math.floor(Math.random() * 1e9))
        return
      }
      chosen = i
      init = PRESETS[i].build()
      refresh()
    })
  }
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab as Tab
      paintTabs()
    })
  }

  function paintTabs(): void {
    for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-tab]'))) b.classList.toggle('on', b.dataset.tab === tab)
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-panel]'))) el.hidden = el.dataset.panel !== tab
  }

  function sync(): void {
    writeHash(init, perf)
  }

  /** What the chosen preset would have produced, so changes can be pointed out. */
  function baseline(): Init {
    return chosen >= 0 ? PRESETS[chosen].build() : initFromSeed(init.seed, init.scale)
  }

  /**
   * Hiding settings is only safe if you can see that you have changed them. This names the
   * differences from whatever was picked, so a world can never behave oddly for invisible reasons.
   */
  function changeSummary(): string {
    const base = baseline() as unknown as Record<string, unknown>
    const now = init as unknown as Record<string, unknown>
    const watch: [string, string][] = [
      ['T', 'temperature'], ['foodMode', 'food pattern'], ['foodLevel', 'food level'],
      ['foodRegime', 'food over time'], ['food_life', 'food lifetime'], ['n_intrinsic', 'particles'],
      ['n_brain', 'brains'], ['n_start', 'organisms at start'], ['n_food0', 'food at start'],
      ['bonds', 'bonds'], ['repro', 'reproduction'], ['inflow', 'inflow'], ['foodMoves', 'food drift'],
      ['walls', 'terrain'], ['decay_free', 'decay'], ['substeps', 'sub-steps'], ['quantized', 'quantized'],
    ]
    const diffs = watch.filter(([k]) => String(base[k]) !== String(now[k])).map(([k, label]) => `${label} ${now[k]}`)
    if (diffs.length === 0) return ''
    return `— ${diffs.slice(0, 3).join(' · ')}${diffs.length > 3 ? ` and ${diffs.length - 3} more` : ''}`
  }

  function refresh(): void {
    if (document.activeElement !== seedEl) seedEl.value = String(init.seed)
    const sizeHost = q('#s-size')
    sizeHost.innerHTML = ''
    sizeHost.append(
      new Chips<string>({
        label: 'how big',
        value: String(init.scale),
        options: [1, 2, 4, 8].map((n) => ({
          value: String(n),
          label: `${n}×`,
          hint: `${300 * n} units across${n > 4 ? ' — placing things by hand needs a zoom in' : ''}`,
        })),
        onChange: (v) => reseed(init.seed, Number(v)),
      }).el,
    )
    for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-preset]'))) {
      b.classList.toggle('on', Number(b.dataset.preset) === chosen)
    }
    q('#s-preset-hint').textContent =
      chosen >= 0 ? PRESETS[chosen].blurb : 'a world rolled from the seed — press re-roll until something looks interesting'
    q('#s-changed').textContent = changeSummary()
    physics()
    chemistry()
    food()
    life()
    compute()
    paintTabs()
    sync()
  }

  function reseed(seed: number, scale = init.scale): void {
    // a preset re-rolled keeps its character and changes only its world; a seeded world rerolls whole
    init = chosen >= 0 ? { ...PRESETS[chosen].build(), seed: Math.floor(seed) } : initFromSeed(Math.floor(seed), scale)
    init.scale = scale
    init.size = 300 * scale
    ioEl.textContent = ''
    refresh()
  }

  q('#s-roll').addEventListener('click', () => reseed(Math.floor(Math.random() * 1e9)))
  seedEl.addEventListener('input', () => {
    const v = Number(seedEl.value)
    if (Number.isFinite(v) && seedEl.value.trim() !== '') reseed(Math.floor(v))
  })
  q('#s-back').addEventListener('click', () => hooks.back())
  q('#s-how').addEventListener('click', () => hooks.explain())
  q('#s-lib').addEventListener('click', () => hooks.library())
  q('#s-start').addEventListener('click', () => hooks.start(init, { ...perf }))

  addEventListener('keydown', (e) => {
    if (root.hidden) return
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      ;(document.activeElement as HTMLElement | null)?.blur()
      hooks.start(init, { ...perf })
    } else if (typing) return
    else if (e.key >= '1' && e.key <= '5') {
      tab = TABS[Number(e.key) - 1][0]
      paintTabs()
    } else if (e.key === 'r' || e.key === 'R') reseed(Math.floor(Math.random() * 1e9))
  })

  refresh()
  return { refresh }
}
