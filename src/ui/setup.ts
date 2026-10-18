import { MAX_THREADS, type Perf, canShare, gpuAvailable } from '../compute/select'
import {
  type FoodLevel,
  type FoodMode,
  type FoodRegime,
  // aliased: `Element` is a DOM global, and the collision reports as "cannot assign to read-only
  // property ATTRIBUTE_NODE", which points nowhere near the actual problem
  type Element as Elem,
  type Init,
  LAWS,
  type Laws,
  elementsOf,
  FOOD_WORLDS,
  foodWorldOf,
  LEVEL_MULTIPLIER,
  QUANTA,
  type SourceMotion,
  type SourceRelation,
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
import { describeSpec } from '../core/fitness'
import { LEARNERS, ONLINE_ALGOS, type LearnAlgo } from '../core/learning'
import { measurePicker } from './measure'
import { FOOD_ROW, MATRIX_NAMES, N_MATRIX } from '../core/types'
import { configText, download, parseConfig, readHash, writeHash } from './config'
import { CHECKPOINT_EVERY, type PackedResume, type ResumeFile, fromResumeFile, initId, tweakDiff } from '../core/resume'
import { collection } from './store'
import { capture } from '../render/renderer'
import { Chips, Slider, Toggle, card, fieldsOf } from './controls'
import { PRESETS } from './presets'
import {
  CHEMISTRIES,
  type Recipe,
  WORLD_KINDS,
  bestRecipe,
  bestWorld,
  buildRecipe,
  chemistryOf,
  randomRecipe,
  worldKindOf,
} from './recipes'
import { mountPreview } from './preview'
import { fmt } from './theme'

const FOOD = FOOD_ROW
/**
 * The drawer's tabs, grouped by **what each setting is a property of**.
 *
 * They used to be Physics / Chemistry / Food / Life / Compute, which mixed tiers: a particle's
 * bond strength and an organism's breeding threshold both sat under "Physics" because both were
 * universal constants, and that stopped being the right story once properties moved down to
 * particles and organisms. The grouping now follows the thing that owns the property, so a
 * question like "what makes P1 different from P2" has one place to look.
 *
 * Learning is deliberately *not* here. It is the third dial on the main screen, level with what
 * the matter wants and what the world is like, because whether anything in a world is being
 * optimised is not a detail of that world.
 */
/*
 * The categories. One tab each, and every setting lives in exactly one of them.
 *
 * Learning has its own tab rather than sitting inside Organisms because whether anything in a world
 * is being optimised is not a detail of that world — it is the most consequential choice on the
 * screen, and it changes what the run *means*.
 */
const TABS = [
  ['particles', 'Particles'],
  ['organisms', 'Organisms'],
  ['food', 'Food'],
  ['world', 'World'],
  ['learning', 'Learning'],
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
  hooks: {
    start(init: Init, perf: Perf, opts: { build: boolean; resume?: PackedResume; tweaks?: Init }): void
    back(): void
    explain(): void
    library(): void
    discoveries(): void
  },
): { refresh(): void; stop(): void; load(init: Init): void } {
  /** The two-dial description of the world, when it came from the dials. */
  let recipe: Recipe = randomRecipe()
  let init = buildRecipe(recipe)
  const perf: Perf = { threads: 1, gpu: false }
  let tab: Tab = 'particles'
  /** Which named preset is selected, or -1 when the world came from the dials. */
  let chosen = -1
  /** True once the world stopped being a recipe — a preset, an import, a hand-edited number. */
  let custom = false
  /**
   * Which tick the run starts at, and the checkpoints that make that possible.
   *
   * Zero means from the beginning, which is why one control covers two things: at zero a tweaked
   * world simply runs tweaked from scratch, and above zero the tweak becomes a perturbation applied
   * at that tick. Only ticks in `available` can be chosen — there is no computing ahead.
   */
  let startTick = 0
  let available: number[] = []
  /** The configuration those checkpoints were saved under, which the dials are tweaks against. */
  let checkpointInit: Init | null = null
  /** A checkpoint loaded from a file rather than from this browser's collection. */
  let resume: PackedResume | null = null
  const fromHash = readHash()
  if (fromHash) {
    init = fromHash.init
    if (fromHash.perf) Object.assign(perf, fromHash.perf)
    custom = true
  }

  /*
   * One layer, with each category's own `advanced` block as the optional second.
   *
   * It used to be three: the settings below were behind a "Build it yourself" button, and every
   * actual dial behind a further disclosure called "Every setting". Three gates to reach a number,
   * and the thing most worth doing — change one and watch the preview — was buried deepest. The
   * preview is a *header* rather than a gate now: it keeps running whatever is changed below it.
   */
  root.innerHTML = `
    <div class="setup">
      <div class="setup-head">
        <div>
          <h1>A WORLD</h1>
          <div class="note">this is it, running. keep it, or roll another.</div>
        </div>
        <div class="row">
          <button id="s-back">← back</button>
          <button id="s-lib">collection</button>
          <button id="s-disco">discoveries</button>
          <button id="s-how">how it works</button>
        </div>
      </div>

      <div class="pitch">
        <div class="pitch-stage"><canvas id="s-prev"></canvas><div class="pitch-tick" id="s-prev-tick"></div></div>
        <div class="pitch-side">
          <div class="pitch-name" id="s-name"></div>
          <p class="pitch-line" id="s-chem"></p>
          <p class="pitch-line" id="s-world"></p>
          <div class="chips-row" id="s-prev-stats"></div>
          <p class="pitch-line" id="s-learn-line"></p>
          <div class="pitch-go">
            <button class="primary" id="s-start">Begin →</button>
            <button id="s-start-paused" title="paused, so you can place food, walls and saved organisms before it runs">open paused</button>
            <button id="s-roll">roll another</button>
            <button id="s-best" title="the measured-best world and learner: see docs/RULES.md §24">★ best known</button>
          </div>
          <div class="note" id="s-io"></div>
        </div>
      </div>

      <div class="builder" id="s-builder">
        <!--
          Quick starts, then the settings. These are not a *layer* over the settings: a preset and a
          seed both write the same numbers the tabs below show, and both are small enough to sit in
          the open. What used to be a layer was the "Build it yourself" panel offering a second,
          parallel way to set things the settings tabs already set — two control surfaces for one
          state, which is the part that was actually confusing rather than the depth.
        -->
        <div class="field"><div class="field-head"><label>start from a known world</label></div>
          <div class="presets" id="s-presets"></div>
          <div class="field-hint" id="s-preset-hint"></div>
        </div>
        <div class="row" style="margin-bottom:6px">
          <label class="mono-k">seed</label>
          <input id="s-seed" inputmode="numeric" style="width:120px" />
          <button id="s-roll2">re-roll</button>
          <span class="note" id="s-changed"></span>
        </div>
        <div class="tabs">${TABS.map(([k, label]) => `<button type="button" data-tab="${k}">${label}</button>`).join('')}</div>
        ${TABS.map(([k]) => `<div class="panel" data-panel="${k}"></div>`).join('')}
      </div>
    </div>`

  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const seedEl = q<HTMLInputElement>('#s-seed')
  const ioEl = q('#s-io')
  const panel = (k: Tab): HTMLElement => q(`[data-panel="${k}"]`)

  /**
   * A category's optional second layer.
   *
   * Every tab shows a handful of levers and puts the rest here. Collapsed rather than removed,
   * because hiding a setting is only safe if it is still reachable and the panel admits it exists —
   * the same discipline as `changeSummary` naming whatever has been changed away from the default.
   */
  const advanced = (host: HTMLElement, summary: string, fields: HTMLElement[]): void => {
    if (fields.length === 0) return
    const det = document.createElement('details')
    det.className = 'advanced'
    det.innerHTML = `<summary>${summary}</summary>`
    const box = document.createElement('div')
    box.className = 'fields'
    box.append(...fields)
    det.appendChild(box)
    host.appendChild(det)
  }

  type NumLaw = { [K in keyof Laws]: Laws[K] extends number ? K : never }[keyof Laws]
  /**
   * A slider over one of the world's law overrides.
   *
   * Every number these touch was a universal constant, and two of them have since been measured
   * wrong by a wide margin. They are a `Partial<Laws>` carried on the Init, so a world keeps its
   * own physics through the worker, a snapshot and a saved config rather than quietly reverting.
   */
  const lawSlider = (
    label: string,
    key: NumLaw,
    min: number,
    max: number,
    step: number,
    hint: (v: number) => string,
    round = false,
  ): HTMLElement =>
    new Slider({
      label,
      min,
      max,
      step,
      value: (init.laws?.[key] as number | undefined) ?? (LAWS[key] as number),
      curve: 'log',
      format: (v) => (round ? String(Math.round(v)) : v.toFixed(2)),
      hint,
      onChange: (v) => {
        init.laws = { ...init.laws, [key]: round ? Math.round(v) : v }
        refresh()
      },
    }).el


  // ------------------------------------------------------------------ physics
  const world = (): void => {
    const p = panel('world')
    p.innerHTML = '<div id="s-arena" style="margin-bottom:16px"></div><div class="cols"></div><div class="stab" id="s-stab"></div>'
    q('#s-arena').append(...arena())
    const cols = p.querySelector('.cols')!
    const left = card('The world')
    const right = card('Matter')
    cols.append(left, right)

    const beyondChips = new Slider({
      label: 'size beyond the chips',
      min: 1,
      max: 32,
      step: 1,
      value: init.scale,
      curve: 'log',
      format: (v) => `${Math.round(v)}×`,
      hint: (v) => `${300 * Math.round(v)} units across${v > 8 ? ' — too big to place things by hand' : ''}`,
      onChange: (v) => reseed(init.seed, Math.round(v)),
    }).el
    fieldsOf(left).append(
      new Slider({
        label: 'metabolism',
        min: 0.05,
        max: 4,
        step: 0.05,
        value: init.metabolism,
        curve: 'log',
        format: (v) => `${v.toFixed(2)}×`,
        hint: (v) => {
          const life = Math.round(1 / v)
          return v === 1
            ? 'what living costs, at the rate the laws name'
            : v < 1
              ? `everything costs ${v.toFixed(2)}× as much to do, so a full reserve lasts about ${life}× longer — the strongest single lever on lifespan there is`
              : `${v.toFixed(2)}× the cost of upkeep, moving and signalling; short, hectic lives`
        },
        onChange: (v) => {
          init.metabolism = v
          applyFoodLevel(init) // food is calibrated against what the world costs, so it moves too
          refresh()
        },
      }).el,
      new Slider({
        label: 'temperature',
        min: 0.1,
        max: 40,
        step: 0.1,
        value: init.T,
        curve: 'log',
        hint: (v) => {
          const s = stability({ ...init, T: v }, { ...LAWS, ...init.laws })
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
    )
    advanced(left, 'size and the integrator', [
      beyondChips,
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
    ])

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
        max: Math.max(120, 120 * init.scale * init.scale),
        step: 1,
        value: init.n_brain,
        hint: (v) =>
          `at most ${v} organisms alive at once${init.inflow ? ` (×3 with inflow on)` : ''} — ` +
          `the hard ceiling on the population, and measured to be the strongest lever on how complex it gets`,
        onChange: (v) => {
          init.n_brain = v
          init.n_start = Math.min(init.n_start, v)
          refresh()
        },
      }).el,
      new Toggle({
        label: 'particle bonds',
        hint: 'touching particles with attractive chemistry latch, and hold until pulled harder — the route to compound organisms',
        value: init.bonds,
        onChange: (v) => {
          init.bonds = v
          refresh()
        },
      }).el,
      ...(init.bonds
        ? [
            new Slider({
              label: 'energy flows along bonds',
              min: 0,
              max: 0.4,
              step: 0.01,
              value: init.bond_flow,
              format: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`),
              hint: (v) =>
                v === 0
                  ? 'a bond carries force and nothing else — two bonded bodies are neighbours, not partners'
                  : `${Math.round(v * 100)}% of the difference moves each tick, so bonded bodies share one reserve: a member sitting in food feeds the others, and a member that runs dry can be rescued. Nothing is created — and nothing stops a neighbour draining you`,
              onChange: (v) => {
                init.bond_flow = v
                sync()
              },
            }).el,
          ]
        : []),
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

  /**
   * Shown only when something is wrong. A permanent "stable" badge spends the most prominent space
   * in the panel on a non-event, and teaches you to skip the one line that would have told you the
   * world was about to misbehave.
   */
  const paintStability = (): void => {
    const el = root.querySelector<HTMLElement>('#s-stab')
    if (!el) return
    const s = stability(init, { ...LAWS, ...init.laws })
    el.hidden = s.ok
    if (s.ok) return
    const need = substepsFor(init, { ...LAWS, ...init.laws })
    el.innerHTML =
      // the ratio is against the **smallest pair exclusion in this world**, since exclusion is the
      // sum of two radii and the element table can make that much smaller than the old constant
      `<b class="warn">steps too long</b> — a particle moves ${s.sigma.toFixed(2)} per sub-step, ` +
      `${Math.round(s.sigmaRatio * 100)}% of the closest two particles' own exclusion, so it can pass straight through them.` +
      (need > 1 ? ` Needs ${need} sub-steps, or less heat.` : ' Lower the temperature.')
  }

  // ------------------------------------------------------------------ chemistry
  const particles = (): void => {
    const p = panel('particles')
    p.innerHTML = `
      <div id="s-chem-recipe"></div>
      <div class="field-hint" id="s-chem-hint" style="margin-bottom:16px"></div>
      <details class="advanced"><summary>the chemistry table itself<span class="note"> — what the recipe above sets</span></summary>
      <div id="s-chem-quant" class="fields"></div>
      <div class="note" style="margin-bottom:12px">The <b>ancestral</b> chemistry: what every
        particle starts from. Positive attracts, negative repels. Drag a cell up or down, or
        double-click to type. Only one half is shown, since the table is symmetric by law — an
        asymmetric coupling would have no potential energy and the energy ledger would stop meaning
        anything.<br>Each particle carries its <i>own</i> copy of its row, so if the chemistry
        evolves this table is only where the world begins.</div>
      <table class="m" id="s-matrix"></table>
      <div class="legend" style="margin-bottom:16px">
        <span><span class="swatch" style="background:rgba(255,170,60,.8)"></span>attract</span>
        <span><span class="swatch" style="background:rgba(80,140,255,.8)"></span>repel</span>
        <span class="note">Food×Food is always 0 · the Food row acts at half strength · Brain has a
          row too now, so a body can be held together by what it is made of rather than only by its rods</span>
      </div>
      </details>
      <div id="s-chem-r"></div>
      <div id="s-elements"></div>`
    /*
     * The recipe above the table it writes. It used to live in a separate "Build it yourself" panel
     * that set this table from a distance, which meant two controls for one piece of state and no
     * indication that one drove the other.
     */
    q('#s-chem-recipe').append(
      new Chips<string>({
        label: 'what the matter wants',
        value: chosen < 0 && !custom ? recipe.chemistry : '',
        options: CHEMISTRIES.map((c) => ({ value: c.key, label: c.name, hint: c.blurb })),
        onChange: (v) => setRecipe({ ...recipe, chemistry: v }),
      }).el,
    )
    // Only when the recipe is *not* driving: the chips carry their own description, so repeating it
    // underneath was the same sentence twice.
    q('#s-chem-hint').textContent =
      chosen < 0 && !custom ? '' : 'the chemistry came from a preset, an import or a hand edit — the table below is what it actually is'
    // Inside the table's own disclosure, because this snaps that table — on its own in a column it
    // read as an unrelated fourth collapsed thing.
    const l = q('#s-chem-quant')
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
    bondingCard()
    elementEditor()
  }

  /** How bonds behave, which is a property of the matter holding them rather than of the world. */
  const bondingCard = (): void => {
    const c = card('How matter holds together')
    q('#s-chem-r').appendChild(c)
    fieldsOf(c).append(
      lawSlider('bond breaks at', 'F_break', 0.5, 16, 0.5, (v) => {
        const f = (init.laws?.F_max as number | undefined) ?? LAWS.F_max
        return `${(v / f).toFixed(1)}× the strongest force a brain can exert. Measured: dropping this from 4 to 2.5 cost four fifths of all standing bonds`
      }),
      lawSlider('bonds per particle', 'max_bonds', 1, 8, 1, (v) => (v <= 2 ? 'two admits only chains and rings — never a sheet' : `up to ${Math.round(v)} neighbours, so a particle can sit inside a sheet`), true),
    )
    advanced(c, 'bond stiffness, and whether the chemistry itself evolves', [
      lawSlider('bond stiffness', 'k_bond', 0.05, 4, 0.05, () => 'the spring constant along a bond'),
      new Toggle({
        label: 'the chemistry evolves',
        hint: 'a bonded particle with energy to spare copies itself into a slot decay has emptied, mutating its own affinities. Only bonded particles can copy, so what gets selected is chemistry that gets itself attached where energy flows. Measured: affinity to matter falls far below what mutation alone gives, which is the opposite of the obvious prediction — an earlier claim that food affinity rises was an artefact of a bug and is retracted',
        value: init.templating,
        onChange: (v) => {
          init.templating = v
          refresh()
        },
      }).el,
      ...(init.templating
        ? [
            new Slider({
              label: 'row mutation',
              min: 0,
              max: 1,
              step: 0.05,
              value: init.row_mut,
              format: (v) => v.toFixed(2),
              hint: (v) =>
                v === 0
                  ? 'copies are exact, so the chemistry can spread but never change'
                  : `each copy's affinities shift by about ${v.toFixed(2)}, then snap back to the quantized lattice`,
              onChange: (v) => {
                init.row_mut = v
                sync()
              },
            }).el,
          ]
        : []),
    ])
  }

  // ------------------------------------------------------------------ food
  /**
   * What a kind of matter *is*, beyond who it sticks to.
   *
   * Six properties per type — the properties a chemical element has. Every one of them was a
   * single global constant until recently, which meant four types differing in one dimension, and
   * four types differing in one dimension are barely four types.
   */
  /**
   * What a kind of matter *is*, beyond who it sticks to — as a grid, not a column of sliders.
   *
   * Six properties across four types is twenty numbers, and twenty sliders stacked vertically came
   * to 2,190 pixels of wall. A grid is both shorter and the right shape for the data: **read down a
   * column and you have one property across every kind; read across and you have one kind.** It
   * also matches the chemistry matrix directly above it, so the same drag-or-double-click gesture
   * works in both.
   */
  const ELEMENT_COLS: { key: keyof Elem; label: string; min: number; max: number; step: number; dp: number; what: string }[] = [
    {
      key: 'radius',
      label: 'size',
      // floored at d_max/2: a pair must exclude each other at a distance one tick's motion cannot
      // cross, and exclusion is the sum of two radii. `elementsOf` clamps it anyway, so without
      // this the grid would offer values it silently discards
      min: LAWS.d_max / 2,
      max: 14,
      step: 0.5,
      dp: 1,
      what: 'hard core; a pair parts at the sum of their two radii, and cannot part closer than one tick of motion',
    },
    { key: 'mobility', label: 'mass', min: 0.02, max: 3, step: 0.02, dp: 2, what: 'mobility. A heavy type ends up MORE bonded, not less: it is not dragged out of its bonds' },
    { key: 'valence', label: 'bonds', min: 0, max: 8, step: 1, dp: 0, what: 'how many neighbours it can hold; two admits only chains and rings' },
    { key: 'bondStrength', label: 'strength', min: 0, max: 4, step: 0.05, dp: 2, what: 'multiplies forming and breaking; a bond takes the WEAKER of its partners' },
    { key: 'decay', label: 'decay', min: 0, max: 0.05, step: 0.001, dp: 3, what: 'how fast it runs down while loose — and what frees a slot for a copy' },
  ]

  const elementEditor = (): void => {
    const host = q('#s-elements')
    const now = elementsOf(init.elements, { ...LAWS, ...init.laws })
    const names = ['P1', 'P2', 'P3', 'P4']
    // Collapsed: twenty numbers describing what each kind of matter *is*. Real, and not what
    // anybody reaches for first — the recipe at the top of this tab is.
    host.innerHTML = `
      <details class="advanced"><summary>what each kind of matter is<span class="note"> — size, mass, bonds, strength, decay, per type</span></summary>
      <div class="note" style="margin:8px 0">Drag a cell up or down, or double-click to type.
        Every one of these was a single global constant until recently — four types differing only in
        their chemistry are barely four types.</div>
      <table class="m" id="s-elgrid"></table>
      <div class="note" id="s-elhint">&nbsp;</div></details>`
    const table = q<HTMLTableElement>('#s-elgrid')
    let html = `<tr><th></th>${ELEMENT_COLS.map((c) => `<th>${c.label}</th>`).join('')}</tr>`
    for (const [t, name] of names.entries()) {
      html += `<tr><th style="text-align:right">${name}</th>`
      for (const [ci, c] of ELEMENT_COLS.entries()) {
        const v = now[t][c.key]
        // shaded by how far the value sits from its default, so an edited table reads at a glance
        const base = elementsOf(undefined, { ...LAWS, ...init.laws })[t][c.key]
        const off = Math.min(1, Math.abs(v - base) / Math.max(1e-9, c.max - c.min))
        html += `<td tabindex="0" data-t="${t}" data-c="${ci}" style="background:rgba(255,170,60,${(0.06 + 0.5 * off).toFixed(3)})">${v.toFixed(c.dp)}</td>`
      }
      html += '</tr>'
    }
    table.innerHTML = html
    const hint = q('#s-elhint')
    for (const td of Array.from(table.querySelectorAll<HTMLTableCellElement>('td[data-t]'))) {
      const t = Number(td.dataset.t)
      const c = ELEMENT_COLS[Number(td.dataset.c)]
      const set = (v: number): void => {
        const clamped = Math.min(c.max, Math.max(c.min, c.step >= 1 ? Math.round(v) : v))
        const els = (init.elements ?? []).slice()
        els[t] = { ...(els[t] ?? {}), [c.key]: clamped }
        init.elements = els
        refresh()
      }
      td.addEventListener('pointerenter', () => {
        hint.textContent = `${names[t]} ${c.label} — ${c.what}`
      })
      const ask = (): void => {
        const typed = prompt(`${names[t]} ${c.label}  (${c.min} … ${c.max})`, String(now[t][c.key]))
        if (typed !== null && Number.isFinite(Number(typed))) set(Number(typed))
      }
      td.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        capture(td, e)
        const y0 = e.clientY
        const v0 = now[t][c.key]
        const span = c.max - c.min
        const move = (ev: PointerEvent): void => set(v0 - ((ev.clientY - y0) / 200) * span)
        const up = (): void => {
          td.removeEventListener('pointermove', move)
          td.removeEventListener('pointerup', up)
        }
        td.addEventListener('pointermove', move)
        td.addEventListener('pointerup', up)
      })
      td.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') set(now[t][c.key] + c.step)
        else if (e.key === 'ArrowDown') set(now[t][c.key] - c.step)
        else if (/^-?[0-9.]$/.test(e.key)) ask()
      })
      td.addEventListener('dblclick', ask)
    }
  }

  // ------------------------------------------------------------------ food

  /**
   * The food panel, as a handful of levers.
   *
   * It used to be three orthogonal axes — pattern, source motion, source relation — plus their
   * conditional extras, which is the right factorisation for a search and the wrong one for a
   * person. The cross-product is 240 combinations and most are not worlds: uniform food cannot show
   * a source motion, a comet that does not move is a contradiction, a formation of one source is
   * nothing. The result was dials that appeared not to work.
   *
   * So the top of the panel is **one list of named worlds**, each a combination that makes sense and
   * is a different experiment from its neighbours, plus the two numbers that mean something in all
   * of them. The raw axes are still there, under `advanced`, for building something the list does
   * not cover — and the search still varies them freely, because this is a projection of them
   * rather than a replacement.
   */
  const food = (): void => {
    const p = panel('food')
    p.innerHTML = '<div class="cols"></div>'
    const cols = p.querySelector('.cols')!
    const where = card('Where the food is')
    const how = card('How much, and for how long')
    cols.append(where, how)

    /*
     * The food recipe — Plenty, Patches, Harsh, Pulsing, Drifting — above the settings it writes.
     * Same reasoning as the chemistry recipe: it used to set these from a different panel.
     */
    const recipeHost = document.createElement('div')
    recipeHost.append(
      new Chips<string>({
        label: 'what the world is like',
        value: chosen < 0 && !custom ? recipe.world : '',
        options: WORLD_KINDS.map((w) => ({ value: w.key, label: w.name, hint: w.blurb })),
        onChange: (v) => setRecipe({ ...recipe, world: v }),
      }).el,
    )
    const recipeHint = document.createElement('div')
    recipeHint.className = 'field-hint'
    recipeHint.style.marginBottom = '16px'
    // Same as the chemistry recipe: the chips carry their own description, so a line under them
    // saying it again was the sentence twice.
    recipeHint.textContent =
      chosen < 0 && !custom ? '' : 'the food settings came from a preset, an import or a hand edit — what follows is what they actually are'
    p.prepend(recipeHost, recipeHint)

    const chosenWorld = foodWorldOf(init)
    fieldsOf(where).append(
      new Chips<string>({
        label: 'the world',
        value: chosenWorld?.key ?? 'custom',
        options: [
          ...FOOD_WORLDS.map((w) => ({ value: w.key, label: w.name, hint: w.why })),
          // Shown only once something is hand-set, so the list is six choices until you go digging.
          ...(chosenWorld ? [] : [{ value: 'custom', label: 'hand-built', hint: 'the axes below are set to a combination the list does not name' }]),
        ],
        onChange: (v) => {
          const w = FOOD_WORLDS.find((x) => x.key === v)
          if (!w) return
          init.foodMode = w.mode
          init.sourceMotion = w.motion
          init.sourceRelation = w.relation
          if (init.sourceSpeed === undefined) init.sourceSpeed = 0.5
          refresh()
        },
      }).el,
    )
    if (chosenWorld?.sources !== false) {
      fieldsOf(where).append(
        new Slider({
          label: 'how many sources',
          min: 1,
          max: Math.max(8, 8 * init.scale * init.scale),
          step: 1,
          value: Math.max(1, init.n_patch),
          curve: 'log',
          /*
           * Reads out coverage, not just the count, because the count alone means nothing across
           * scales: at 16x the world is 4,800 units across, where a handful of sources are needles
           * in it and a thousand blanket it so evenly there is no gradient left to navigate.
           */
          hint: (v) => {
            const cover = (100 * Math.PI * init.r_patch * init.r_patch * Math.round(v)) / (init.size * init.size)
            return cover > 70
              ? `${Math.round(v)} sources covering ~${Math.round(Math.min(100, cover))}% of the world — near-uniform, so there is no gradient left to follow`
              : `${Math.round(v)} sources, ~${cover < 1 ? cover.toFixed(1) : Math.round(cover)}% of the world within reach of food`
          },
          onChange: (v) => {
            init.n_patch = Math.round(v)
            refresh()
          },
        }).el,
        new Slider({
          label: 'source size',
          min: 10,
          max: 200,
          step: 5,
          value: init.r_patch,
          hint: (v) => `food lands within ${Math.round(v)} units of a source`,
          onChange: (v) => {
            init.r_patch = v
            refresh()
          },
        }).el,
      )
    }
    if (chosenWorld?.speed !== false) {
      fieldsOf(where).append(
        new Slider({
          label: 'how fast they move',
          min: 0.1,
          max: 1.5,
          step: 0.05,
          value: init.sourceSpeed ?? 0.5,
          format: (v) => `${v.toFixed(2)}×`,
          /*
           * A fraction of how fast an organism travels, not a number of units. The absolute version
           * was the bug: one pattern's source ran at 1.9x anything that could chase it while four
           * others sat at exactly zero, and no dial in the UI showed either.
           */
          hint: (v) =>
            v >= 1
              ? `${v.toFixed(2)}× an organism's own speed — faster than anything can chase, so this is the uncatchable control`
              : `${v.toFixed(2)}× an organism's own speed, so a good swimmer can catch it and a poor one cannot`,
          onChange: (v) => {
            init.sourceSpeed = Math.round(v * 100) / 100
            sync()
          },
        }).el,
      )
    }
    if (init.sourceRelation === 'converging' || init.sourceRelation === 'diverging' || init.sourceRelation === 'cyclical') {
      fieldsOf(where).append(
        new Slider({
          label: init.sourceRelation === 'cyclical' ? 'one full cycle' : 'takes',
          min: 200,
          max: 40000,
          step: 100,
          value: init.converge_ticks,
          curve: 'log',
          format: (v) => `${Math.round(v)}t`,
          hint: () =>
            init.merge_hold
              ? 'held: the colonies stay apart until you release them from the world screen'
              : 'from the first tick',
          onChange: (v) => {
            init.converge_ticks = Math.round(v)
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
        label: 'spoils after',
        min: 0,
        max: 3000,
        step: 10,
        value: init.food_life,
        format: (v) => (v === 0 ? 'never' : `${Math.round(v)}t`),
        hint: (v) =>
          v === 0
            ? 'food waits forever, so it piles up to the cap'
            : `uneaten food lasts ${Math.round(v)} ticks — scarcity is what makes foraging worth the cost. A long life behind a moving source leaves a trail, which re-creates the static world it was meant to replace`,
        onChange: (v) => {
          init.food_life = v
          refresh()
        },
      }).el,
    )

    /*
     * Everything below here is real and rarely the thing you want. It is collapsed rather than
     * removed: hiding a setting is only safe if it is still reachable and the panel admits it
     * exists, which is the same discipline as `changeSummary` naming what has been changed.
     */
    const adv = document.createElement('details')
    adv.className = 'advanced'
    adv.innerHTML = '<summary>the axes underneath, and the rest<span class="note"> — the named worlds above are combinations of these</span></summary>'
    const advFields = document.createElement('div')
    advFields.className = 'fields'
    adv.appendChild(advFields)
    how.appendChild(adv)
    advFields.append(
      new Chips<FoodMode>({
        label: 'where food lands around a source',
        value: init.foodMode,
        options: [
          { value: 'random', label: 'uniform', hint: 'everywhere equally, so nothing is placed around a source and a source motion cannot show' },
          { value: 'patchy', label: 'a disc', hint: 'a disc around each source' },
          { value: 'spring', label: 'a tight disc', hint: 'a much smaller disc: the most contested world there is' },
          { value: 'gradient', label: 'a band', hint: 'a bright stripe across the world; the rest is desert' },
          { value: 'ring', label: 'a ring', hint: 'a closed band at a radius from the source — a circuit rather than a field' },
        ],
        onChange: (v) => {
          init.foodMode = v
          refresh()
        },
      }).el,
      new Chips<SourceMotion>({
        label: 'how each source moves',
        value: init.sourceMotion ?? 'static',
        options: [
          { value: 'static', label: 'stays put', hint: 'fixed. The optimal policy is a constant, so there is nothing to get better at' },
          { value: 'comet', label: 'runs straight', hint: 'a constant heading across the world' },
          { value: 'orbit', label: 'circles', hint: 'periodic, so it comes back — the only motion where remembering pays' },
          { value: 'wander', label: 'wanders', hint: 'a random walk at the same speed as circling: tracking, with nothing to anticipate' },
          { value: 'tide', label: 'sweeps', hint: 'all sources share a heading, so the food crosses as a band' },
          { value: 'shy', label: 'flees the crowd', hint: 'moves away from wherever the population has massed' },
        ],
        onChange: (v) => {
          init.sourceMotion = v
          if (init.sourceRelation === undefined) init.sourceRelation = 'independent'
          refresh()
        },
      }).el,
      new Chips<SourceRelation>({
        label: 'what the sources do together',
        value: init.sourceRelation ?? 'independent',
        options: [
          { value: 'independent', label: 'independently', hint: 'each goes its own way' },
          { value: 'converging', label: 'gather', hint: 'all close on the middle and stay' },
          { value: 'diverging', label: 'scatter', hint: 'all spread outward from where they began' },
          { value: 'cyclical', label: 'gather and scatter', hint: 'in and out for ever, so isolation and contact alternate' },
          { value: 'formation', label: 'in formation', hint: 'spacing preserved while the whole pattern travels' },
        ],
        onChange: (v) => {
          init.sourceRelation = v
          if (init.sourceMotion === undefined) init.sourceMotion = 'wander'
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
      lawSlider('how fast food drifts', 'mu_food', 0.02, 1, 0.01, (v) =>
        v >= 0.9
          ? 'food drifts exactly as fast as a limb swims — you cannot catch what diffuses as fast as you move'
          : `food is ${(1 / v).toFixed(1)}× heavier than matter, so a swimmer can gain on it`,
      ),
      lawSlider('mouth width', 'r_eat', 2, 30, 1, (v) => `food is eaten within ${Math.round(v)} units. Measured: 12 beat both 6 and 20`, true),
      new Slider({
        label: 'at most',
        min: 10,
        max: Math.max(1000, 1000 * init.scale * init.scale),
        step: 10,
        value: init.max_food,
        curve: 'log',
        // Not a thermostat: the sun's rate never changes. This is how many food particles the
        // world has room for, and light that arrives with every slot taken is simply lost.
        hint: () => 'room for this much food; the sun keeps shining either way, and the excess is wasted',
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
  const organisms = (): void => {
    const p = panel('organisms')
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
    )
    advanced(arrive, 'how new organisms keep arriving', [
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
    ])

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
        hint: (v) =>
          v === 0
            ? 'children are exact copies — heredity without variation, so nothing can evolve at all'
            : v < 0.1
              ? 'children resemble their parents closely'
              : 'children differ sharply from their parents',
        onChange: (v) => {
          init.repro_mut = v
          sync()
        },
      }).el,
    )
    /*
     * The other routes to a child, and what birth costs. All real, none the first thing to reach
     * for — and `conjugation` and `spores` are *additional routes* rather than settings of the main
     * one, so listing them level with "reproduction" read as competing switches instead of one
     * default plus two options.
     */
    advanced(rules, 'other ways to reproduce, and what birth costs', [
      /*
       * The two modes that are not clonal.
       *
       * Budding and fission both copy one parent, which meant that before conjugation existed
       * there was no recombination anywhere in the world: every lineage was a mutation chain, and
       * crossover happened only inside the GA learner, between dead organisms. That is a large
       * gap in a model whose stated goal is evolution.
       */
      new Toggle({
        label: 'conjugation',
        hint: 'two organisms bonded to each other — not merely near — both ready to breed, make one child together — body plan drawn socket by socket from either parent, weights a uniform crossover. A bond is already the world’s only notion of association, and it is met by every world that has ever been confirmed',
        value: init.conjugation,
        onChange: (v) => {
          init.conjugation = v
          refresh()
        },
      }).el,
      lawSlider('how hard a brain can push', 'F_max', 0.1, 8, 0.1, (v) => {
        const br = (init.laws?.F_break as number | undefined) ?? LAWS.F_break
        return v >= br
          ? 'stronger than a bond: an organism can tear itself free of a structure, and drag one'
          : `a bond is ${(br / v).toFixed(1)}× stronger than any swimmer, so nothing can pull a structure anywhere`
      }),
      lawSlider('a newborn starts with', 'E_birth', 1, 80, 1, (v) => (v < 10 ? 'barely endowed: newborns starve before they can eat' : `${Math.round(v)} per particle, paid by the parent`), true),
      lawSlider('breeds at', 'E_repro', 10, 300, 5, (v) => `a brain holding ${Math.round(v)} may reproduce`, true),
      new Toggle({
        label: 'spores',
        hint: 'when a child cannot be made, a parent invests in one drifting particle carrying its genome, which wakes where it finds food. Measured: this cut reproductions blocked by the population cap from 41,244 to 853',
        value: init.spore,
        onChange: (v) => {
          init.spore = v
          refresh()
        },
      }).el,
      ...(init.spore
        ? [
            new Slider({
              label: 'spore investment',
              min: 5,
              max: 120,
              step: 5,
              value: (init.laws?.E_spore as number | undefined) ?? LAWS.E_spore,
              format: (v) => String(Math.round(v)),
              hint: (v) => `the parent spends ${Math.round(v)}, and the spore endows a whole body from it or is wasted`,
              onChange: (v) => {
                init.laws = { ...init.laws, E_spore: Math.round(v) }
                refresh()
              },
            }).el,
            new Slider({
              label: 'spore wakes at',
              min: 0,
              max: 20,
              step: 1,
              value: (init.laws?.spore_food as number | undefined) ?? LAWS.spore_food,
              format: (v) => `${Math.round(v)} food`,
              hint: (v) =>
                v === 0
                  ? 'wakes anywhere, so dispersal is blind'
                  : `needs ${Math.round(v)} food particles within reach — the same count the brain itself reads, so germination and perception agree about what "food is here" means`,
              onChange: (v) => {
                init.laws = { ...init.laws, spore_food: Math.round(v) }
                refresh()
              },
            }).el,
          ]
        : []),
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
    ])
  }

  // ------------------------------------------------------------------ learning
  /**
   * The third dial, and the one that has to argue with itself.
   *
   * It sits level with the other two rather than inside the settings drawer, because whether
   * anything in a world is being optimised is not a detail of that world — it is the most
   * consequential choice on the screen, and one that changes what the run *means*. So it says
   * plainly that `none` is the control, that a fitness function is an invention rather than a
   * measurement, and what each algorithm will do with the weights.
   */
  const learning = (): void => {
    const L = init.learn
    const on = L.algo !== 'none'
    /*
     * Its own tab, built here rather than hosted by the page markup. Whether anything in a world is
     * being optimised is not a detail of that world — it is the most consequential choice on the
     * screen and it changes what the run *means* — so it gets a category rather than a corner of
     * one, and `none` is the first option and says out loud that it is the control.
     */
    const tab = panel('learning')
    tab.innerHTML = '<div id="s-algos"></div><div class="field-hint" id="s-algo-hint" style="margin-bottom:16px"></div><div id="s-learn-panel"></div>'
    q('#s-algos').append(
      new Chips<string>({
        label: 'how they learn',
        value: L.algo,
        options: LEARNERS.map((l) => ({ value: l.key, label: l.name, hint: l.blurb })),
        onChange: (v) => {
          init.learn = { ...init.learn, algo: v as LearnAlgo }
          refresh()
        },
      }).el,
    )
    const host = q('#s-learn-panel')
    const isOnline = ONLINE_ALGOS.includes(L.algo)
    /*
     * Two kinds of learner now, and the difference is worth stating plainly on screen rather than
     * leaving someone to infer it: one chooses who is born, the other changes who is already
     * alive. The old note said a learner "may only choose the weights a new organism is born
     * with", which stopped being true the moment TD(λ) existed.
     */
    host.innerHTML = on
      ? `<div class="note" style="margin:2px 0 14px">${
          isOnline
            ? `This one learns <b>inside a life</b>. Every tick it sees what an organism saw, what it
               decided and what it was paid, and it rewrites that organism's own weights — so it
               does not wait for anything to die. That matters: an offline learner may only act at
               a spawn, a spawn needs a free brain slot, and a healthy population has none, so one
               was measured handing out 800 samples of which 788 could never be scored.`
            : `This one may only choose the weights a <i>new</i> organism is born with, and watch
               what became of the ones that died. Budding is left alone: it is already selection
               plus mutation, and it belongs to the world rather than to an algorithm.`
        }
           It cannot touch the physics, the chemistry or the energy, and it draws from its own
           random stream — so switching one on leaves the same world, with the same food in the
           same places.</div>
         <div class="cols"><div id="s-learn-l"></div><div id="s-learn-r"></div></div>`
      : ''

    q('#s-algo-hint').textContent = LEARNERS.find((l) => l.key === L.algo)?.blurb ?? ''
    if (!on) return

    fieldsOf(q('#s-learn-l').appendChild(card('What counts as doing well'))).append(
      measurePicker({
        spec: L.fitness,
        heading: false,
        onChange: (spec) => {
          init.learn = { ...init.learn, fitness: spec }
          refresh()
        },
      }),
      new Slider({
        label: 'learn nothing before',
        min: 0,
        max: 20000,
        step: 100,
        value: L.warmup,
        curve: 'log',
        format: (v) => `${Math.round(v)}t`,
        hint: () => 'startup transients would otherwise poison the first updates',
        onChange: (v) => {
          init.learn = { ...init.learn, warmup: Math.round(v) }
          sync()
        },
      }).el,
      new Slider({
        label: 'share of new organisms',
        min: 0,
        max: 1,
        step: 0.05,
        value: L.share,
        format: (v) => `${Math.round(v * 100)}%`,
        hint: (v) =>
          v === 0
            ? 'none: the learner only watches, and the world is identical to one with no learner at all'
            : v < 1
              ? `${Math.round(v * 100)}% come from the learner and the rest from chance — random spawns dilute selection, which is the single biggest knob here`
              : 'every spawn comes from the learner; budding still passes on whatever its parent had',
        onChange: (v) => {
          init.learn = { ...init.learn, share: v }
          refresh()
        },
      }).el,
    )

    const right = card(
      L.algo === 'ga' ? 'Pool and breeding' : isOnline ? 'Rates and exploration' : L.algo === 'elites' ? 'The behaviour grid' : 'Distribution',
    )
    q('#s-learn-r').appendChild(right)
    const slider = (
      label: string,
      key: keyof typeof L,
      min: number,
      max: number,
      step: number,
      hint: (v: number) => string,
      round = false,
    ): HTMLElement =>
      new Slider({
        label,
        min,
        max,
        step,
        value: L[key] as number,
        // precision from the step, so a learning rate of 0.001 does not read as "0.00" — which is
        // indistinguishable on screen from the setting that turns learning off
        format: (v) => (round ? String(Math.round(v)) : v.toFixed(step < 0.005 ? 4 : step < 0.05 ? 3 : 2)),
        hint,
        onChange: (v) => {
          init.learn = { ...init.learn, [key]: round ? Math.round(v) : v }
          sync()
        },
      }).el

    if (L.algo === 'ga') {
      fieldsOf(right).append(
        slider('pool size', 'pool', 2, 200, 1, (v) => `the best ${Math.round(v)} dead organisms are kept to breed from`, true),
        slider('tournament', 'tournament', 1, 16, 1, (v) => (v === 1 ? 'a random pool member, so no selection pressure at all' : `best of ${Math.round(v)} drawn at random — higher is greedier`), true),
        slider('crossover', 'crossover', 0, 1, 0.05, (v) => (v === 0 ? 'children come from one parent' : `${Math.round(v * 100)}% of children mix two winners, weight by weight`)),
        slider('mutation σ', 'sigma', 0, 1, 0.01, (v) => (v === 0 ? 'exact copies: the pool can never improve on itself' : 'Gaussian noise added to every weight')),
        slider('forget after', 'maxAge', 1000, 200000, 1000, (v) => `pool entries older than ${Math.round(v)} ticks are dropped: fitness earned under a food regime that has since changed misleads`, true),
      )
    } else if (L.algo === 'random') {
      fieldsOf(right).append(
        (() => {
          const d = document.createElement('div')
          d.className = 'note'
          d.textContent =
            'nothing to tune: spawns stay random and the best genome ever seen is merely recorded. It is the yardstick — a learner that cannot beat luck has not learned.'
          return d
        })(),
      )
    } else if (isOnline) {
      fieldsOf(right).append(
        slider('exploration', 'explore', 0, 0.6, 0.01, (v) =>
          v === 0
            ? 'no noise on the actions — and with none, a policy gradient has no gradient: there is nothing to learn from'
            : `actions are perturbed by ${v.toFixed(2)}, and that perturbation is itself what it learns from. Only this learner's organisms are affected`,
        ),
        slider('policy rate', 'actorLr', 0, 0.05, 0.0005, (v) => `${v.toFixed(4)} per unit of surprise, across all 410 brain weights at once`),
        ...(L.algo === 'td'
          ? [
              slider('value rate', 'criticLr', 0, 0.2, 0.005, () => `how fast the value estimate — "how good is this situation" — is corrected. Shared across this learner's organisms, since it is a model of one world`),
              slider('discount γ', 'gamma', 0.5, 0.995, 0.005, (v) => `food ${Math.round(1 / (1 - v))} ticks from now is worth about a third of food right now`),
              slider('trace decay λ', 'lambda', 0, 0.99, 0.01, (v) =>
                v === 0
                  ? 'credit goes only to the last tick, so nothing links an action to a meal that followed it'
                  : `credit reaches about ${Math.round(1 / (1 - v * L.gamma))} ticks back — which is what connects turning left to eating later`,
              ),
            ]
          : []),
        slider('weight decay', 'decay', 0, 0.02, 0.0005, (v) => (v === 0 ? 'nothing pulls the weights back, so they can grow until every output saturates' : 'a steady pull toward zero, against saturation')),
        /*
         * Only meaningful once something learns within a life, which is why it lives here rather
         * than next to the mutation rate. A real and long-studied distinction, not a detail: left
         * implicit it would have been Lamarckian by accident, since the world reproduces from
         * whatever weights an organism currently holds.
         */
        new Chips<'learned' | 'birth'>({
          label: 'children inherit',
          value: L.inherit,
          options: [
            { value: 'learned', label: 'what the parent learned', hint: 'Lamarckian: faster, and known to generalise worse — a lineage can bank adaptations to one situation' },
            { value: 'birth', label: 'what the parent was born with', hint: 'Darwinian: learning shapes a life, selection alone shapes the lineage' },
          ],
          onChange: (v) => {
            init.learn = { ...init.learn, inherit: v }
            refresh()
          },
        }).el,
        (() => {
          const d = document.createElement('div')
          d.className = 'note'
          d.innerHTML = `<b>Reward is what it <i>ate</i></b>, in meals, not its net energy change.
            Net gain would reward sitting still — and spending less is already the only strategy
            anything in this world has ever found. The cost of moving is left as something an
            organism has to survive rather than a penalty inside its objective.`
          return d
        })(),
      )
    } else if (L.algo === 'elites') {
      fieldsOf(right).append(
        slider('cells per axis', 'cells', 2, 12, 1, (v) => `${Math.round(v) ** 3} cells over three behaviours, each holding the best genome of its own kind`, true),
        slider('mutation σ', 'sigma', 0.01, 1, 0.01, (v) => `an elite is drawn at random and nudged by ${v.toFixed(2)} per weight`),
        (() => {
          const d = document.createElement('div')
          d.className = 'note'
          d.innerHTML = `Elites are drawn <b>uniformly over occupied cells</b>, not by score. Biasing
            toward the high scorers would turn this back into a plain optimiser wearing a grid,
            which is the one thing it exists not to be: today's loser is often the only available
            stepping stone to tomorrow's winner.`
          return d
        })(),
      )
    } else {
      fieldsOf(right).append(
        slider('exploration σ', 'sigma', 0.01, 1, 0.01, (v) => `samples sit ${v.toFixed(2)} away from the mean, per weight`),
        slider('batch', 'batch', 2, 128, 1, (v) => `the mean is updated once every ${Math.round(v)} deaths of its own samples`, true),
        ...(L.algo === 'es'
          ? [
              slider('step size', 'lr', 0.002, 0.2, 0.002, (v) =>
                v > 0.08
                  ? `${v.toFixed(3)} — large for Adam, which steps by about this much per weight whatever the gradient says. Measured: at 0.2 the mean moved *away* from a target it was meant to find`
                  : `${v.toFixed(3)} of a weight per update, normalised per weight by Adam`,
              ),
            ]
          : []),
      )
    }
  }

  // ------------------------------------------------------------------ compute
  const compute = (): void => {
    const p = panel('world')
    /*
     * Appended — `world()` owns this panel's markup — and collapsed, because none of it is the
     * world. Where the forces are computed, how a config moves in and out, and which checkpoint a
     * run starts from are all real and none is a thing you change while looking at a world.
     */
    const det = document.createElement('details')
    det.className = 'advanced'
    det.innerHTML = '<summary>compute, import, and where the run starts</summary>'
    p.appendChild(det)
    const host = document.createElement('div')
    det.appendChild(host)
    host.innerHTML = `
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
      <textarea id="s-paste" placeholder="paste a config here, then press Import again" hidden></textarea>
      <div class="field-sep"></div>
      <div class="note" style="margin:14px 0 10px">Where the run <i>starts</i>. A running world saves
        itself every ${CHECKPOINT_EVERY.toLocaleString()} ticks, and those checkpoints are the only
        ticks offered here — there is no computing ahead. So the first run of a world starts at the
        beginning; after that you can start from where it got to, change a dial, and watch what the
        change does to a world that already grew up.</div>
      <div id="s-warm"></div>
      <div class="row" style="margin-top:10px">
        <button id="s-resume">load a checkpoint file…</button>
        <button id="s-resume-clear" hidden>start from the beginning</button>
        <input type="file" id="s-resume-file" accept="application/json" hidden />
      </div>
      <div class="field-hint" id="s-resume-note"></div>`
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

    /*
     * The start-tick control, over the checkpoints that actually exist for this world.
     *
     * A free-range slider was the wrong shape for this. It offered every multiple of 5,000 up to
     * 200,000 and then quietly computed whichever one you picked, so the control implied a cheap
     * choice and delivered half an hour of waiting. Listing only what is backed by saved state
     * makes the honest thing the easy thing, and makes "nothing here yet, run it once" a visible
     * state rather than a surprise.
     */
    const warmHost = q('#s-warm')
    const paintWarm = (): void => {
      warmHost.innerHTML = ''
      const ticks = [0, ...available]
      if (available.length === 0) {
        warmHost.innerHTML = `<div class="field-hint">no checkpoints for this world yet — run it once and it
          will save one every ${CHECKPOINT_EVERY.toLocaleString()} ticks, then this will offer them</div>`
        return
      }
      warmHost.append(
        new Chips<string>({
          label: 'start at tick',
          value: String(startTick),
          options: ticks.map((t) => ({
            value: String(t),
            label: t === 0 ? 'the beginning' : t.toLocaleString(),
            hint:
              t === 0
                ? 'from scratch, with whatever the dials now say'
                : `restores the saved state at tick ${t.toLocaleString()}; dial changes take effect from there`,
          })),
          onChange: (v) => {
            startTick = Number(v)
            resume = null // a picked tick is loaded from the collection at start, not held here
            refresh()
          },
        }).el,
      )
    }
    paintWarm()
    const resumeNote = q('#s-resume-note')
    const paintResume = (): void => {
      q('#s-resume-clear').hidden = resume === null && startTick === 0
      const savedInit = resume?.meta.init ?? (startTick > 0 ? checkpointInit : null)
      if (!savedInit) {
        resumeNote.textContent = available.length > 0 ? 'or load a checkpoint saved from another browser' : ''
        return
      }
      /*
       * The two lists are the whole safety story. State arrays are sized and indexed by a world's
       * shape, so a dial that decides a shape cannot change under a restored state — and the
       * refusal has to name the dial, because "you cannot resume with that change" is useless.
       */
      const d = tweakDiff(savedInit, init)
      const at = resume?.meta.tick ?? startTick
      const parts = [`starting at tick ${at.toLocaleString()}, seed ${savedInit.seed}`]
      if (d.allowed.length > 0) parts.push(`changing ${d.allowed.join(', ')} from that tick on`)
      if (d.refused.length > 0)
        parts.push(`⚠ ${d.refused.join(', ')} cannot change at a checkpoint — that would restore the saved state into a differently shaped world, so those will be ignored`)
      if (d.allowed.length === 0 && d.refused.length === 0) parts.push('no changes: it will run on exactly as it was')
      resumeNote.textContent = parts.join(' · ')
    }
    paintResume()
    q('#s-resume').addEventListener('click', () => q<HTMLInputElement>('#s-resume-file').click())
    q('#s-resume-clear').addEventListener('click', () => {
      resume = null
      startTick = 0
      refresh()
    })
    q<HTMLInputElement>('#s-resume-file').addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (!f) return
      try {
        const file = JSON.parse(await f.text()) as ResumeFile
        if (file.kind !== 'simplecell-resume') throw new Error('that is a config or a run, not a checkpoint')
        resume = fromResumeFile(file)
        // The dials become the *tweaks*, so they have to start from what was saved — otherwise
        // every difference between the current panel and the saved world reads as a deliberate
        // change the user never made.
        init = file.init
        startTick = file.tick
        custom = true
        chosen = -1
        refresh()
      } catch (err) {
        resumeNote.textContent = `could not read that: ${(err as Error).message}`
      }
    })

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

  /*
   * The presets are still raw markup bound once, because the row never re-renders. The two recipe
   * dials used to be done the same way and are now `Chips` inside the tabs that own them — which is
   * the point of the change: a chemistry recipe belongs above the chemistry table, not in a separate
   * panel that sets it from a distance.
   */
  q('#s-presets').innerHTML = PRESETS.map(
    (p, i) => `<button type="button" data-preset="${i}" title="${p.blurb}">${p.name}</button>`,
  ).join('')

  const onEach = (attr: string, fn: (value: string, el: HTMLElement) => void): void => {
    for (const b of Array.from(root.querySelectorAll<HTMLElement>(`[data-${attr}]`))) {
      b.addEventListener('click', () => fn(b.dataset[attr]!, b))
    }
  }
  onEach('preset', (i) => {
    chosen = Number(i)
    custom = true
    init = PRESETS[chosen].build()
    refresh()
  })

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

  /**
   * The world changed: record it in the URL and rebuild the preview.
   *
   * Rebuilding here, rather than only at the end of `refresh`, is a fix rather than a tidy-up.
   * Controls split into two kinds — ones that call `refresh` because they change which *other*
   * controls should exist, and ones that call `sync` because they only change a number. The second
   * kind updated `init` and left the preview showing the previous world, so a dial could be moved
   * with no visible effect and the obvious conclusion was that the dial did not work. Which dials
   * were affected depended on which ones happened to need a re-layout, so it looked intermittent.
   */
  function sync(): void {
    writeHash(init, perf)
    repreview()
  }

  /** What the current choice would have produced untouched, so changes can be pointed out. */
  function baseline(): Init {
    if (chosen >= 0) return PRESETS[chosen].build()
    return custom ? initFromSeed(init.seed, init.scale) : buildRecipe(recipe)
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
    // learning is nested, and it is the one change nobody should be able to miss
    if (init.learn.algo !== 'none') diffs.unshift(`learning: ${init.learn.algo} on ${describeSpec(init.learn.fitness)}`)
    if (diffs.length === 0) return ''
    return `— ${diffs.slice(0, 3).join(' · ')}${diffs.length > 3 ? ` and ${diffs.length - 3} more` : ''}`
  }

  // ------------------------------------------------------------------ the preview
  const preview = mountPreview(q<HTMLCanvasElement>('#s-prev'), (s) => {
    q('#s-prev-tick').textContent = `tick ${fmt.n(s.tick)}`
    const chip = (k: string, v: string): string => `<span class="chip"><i>${k}</i>${v}</span>`
    q('#s-prev-stats').innerHTML =
      chip('organisms', fmt.n(s.organisms)) +
      chip('matter', fmt.n(s.matter)) +
      chip('bonded', `${Math.round((100 * s.bonded) / Math.max(1, s.matter))}%`) +
      chip('food', fmt.n(s.food))
  })

  /** Debounced, because dragging a slider should not start a new world on every frame. */
  let previewTimer = 0
  function repreview(): void {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => preview.show(init), 120) as unknown as number
  }

  /** The name of what is on screen, in the vocabulary the picker uses. */
  function title(): string {
    if (chosen >= 0) return PRESETS[chosen].name
    if (custom) return 'Your world'
    return `${chemistryOf(recipe.chemistry).name} · ${worldKindOf(recipe.world).name}`
  }

  /**
   * Looks up which checkpoints this world has, and re-paints if the answer changed.
   *
   * Async and fire-and-forget, deliberately: the panel must render immediately whether or not the
   * collection has answered yet, so the list starts empty and fills in. `init` is read fresh each
   * time because changing a dial changes the world's identity, and a checkpoint from before the
   * change does not belong to it.
   */
  const findCheckpoints = async (): Promise<void> => {
    const base = checkpointInit ?? init
    const found = await collection.checkpoints(initId(base))
    const ticks = found.map((c) => c.tick)
    if (ticks.join(',') === available.join(',')) return
    available = ticks
    if (ticks.length > 0) checkpointInit = base
    if (startTick > 0 && !ticks.includes(startTick)) startTick = 0
    refresh()
  }

  /** Size and terrain: the two choices that describe the arena rather than what is in it. */
  const arena = (): HTMLElement[] => [
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
        if (chosen < 0 && !custom) {
          setRecipe({ ...recipe, terrain: v })
          return
        }
        init.walls = v
        refresh()
      },
    }).el,
  ]

  function refresh(): void {
    void findCheckpoints()
    if (document.activeElement !== seedEl) seedEl.value = String(init.seed)
    const dialled = chosen < 0 && !custom
    for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-preset]'))) {
      b.classList.toggle('on', b.dataset.preset === String(chosen))
    }
    q('#s-preset-hint').textContent = chosen >= 0 ? PRESETS[chosen].blurb : 'nine worlds that are known to do something'

    q('#s-name').textContent = title()
    q('#s-chem').textContent = dialled ? chemistryOf(recipe.chemistry).describe() : `${init.foodMode} food, ${init.foodLevel}, ${init.foodRegime}`
    q('#s-world').textContent = dialled
      ? worldKindOf(recipe.world).describe()
      : `${init.n_start} organisms to start, ${init.n_intrinsic} loose particles, ${init.size} units across`
    const lrn = init.learn
    const lrnName = LEARNERS.find((l) => l.key === lrn.algo)?.name ?? lrn.algo
    q('#s-learn-line').textContent =
      lrn.algo === 'none'
        ? 'nothing is being optimised: every new organism gets random weights, and whatever happens is the world doing it'
        : `learning: ${lrnName}, scored on ${describeSpec(lrn.fitness)} — a chosen measure, and part of the result`
    q<HTMLElement>('#s-learn-line').style.color = lrn.algo === 'none' ? '' : 'var(--accent)'
    q('#s-changed').textContent = changeSummary()

    // `world()` first, because `compute()` appends into the same panel rather than owning one
    world()
    compute()
    particles()
    food()
    organisms()
    learning()
    paintTabs()
    sync() // records the world and rebuilds the preview
  }

  /** Move a dial: the recipe changes, and everything downstream of it is rebuilt. */
  function setRecipe(next: Recipe): void {
    recipe = next
    chosen = -1
    custom = false
    init = buildRecipe(recipe)
    ioEl.textContent = ''
    refresh()
  }

  function reseed(seed: number, scale = init.scale): void {
    const s = Math.floor(seed)
    if (chosen < 0 && !custom) {
      setRecipe({ ...recipe, seed: s, scale })
      return
    }
    // a preset re-rolled keeps its character and changes only its world; a custom world rerolls whole
    init = chosen >= 0 ? { ...PRESETS[chosen].build(), seed: s } : initFromSeed(s, scale)
    init.scale = scale
    init.size = 300 * scale
    ioEl.textContent = ''
    refresh()
  }

  /** The default path: a different world entirely, with nothing to choose. */
  function rollAnother(): void {
    chosen = -1
    custom = false
    setRecipe({ ...randomRecipe(), scale: init.scale })
  }

  /**
   * The furthest anything has got, in one press: every setting measured rather than chosen, plus
   * the only learner that beat its controls. It lands as a *custom* world rather than a recipe,
   * because it is more than two dials — and the builder then shows exactly what it did.
   */
  function useBest(): void {
    chosen = -1
    custom = true
    recipe = bestRecipe(init.seed)
    init = bestWorld(init.seed, init.scale)
    ioEl.textContent = 'the measured-best world: 40 brain slots, metabolism 0.5, food in patches, energy along bonds, cross-entropy on offspring + togetherness'
    refresh()
  }

  q('#s-roll').addEventListener('click', rollAnother)
  q('#s-best').addEventListener('click', useBest)
  q('#s-roll2').addEventListener('click', () => reseed(Math.floor(Math.random() * 1e9)))
  seedEl.addEventListener('input', () => {
    const v = Number(seedEl.value)
    if (Number.isFinite(v) && seedEl.value.trim() !== '') reseed(Math.floor(v))
  })
  q('#s-back').addEventListener('click', () => hooks.back())
  q('#s-how').addEventListener('click', () => hooks.explain())
  q('#s-lib').addEventListener('click', () => hooks.library())
  q('#s-disco').addEventListener('click', () => hooks.discoveries())

  const go = async (build: boolean): Promise<void> => {
    preview.stop()
    /*
     * With a checkpoint the world is built from the **saved** configuration and the dials are
     * handed over separately as tweaks, because that is what makes the changeover semantics work:
     * the state restores into the world it was saved from, and only then does the change take
     * effect. Building from the edited config instead would restore the arrays into a world they
     * do not describe — which `decodeResume` refuses outright for a shape change and, worse, would
     * silently accept for everything else.
     */
    let packed = resume
    if (!packed && startTick > 0) {
      const saved = (await collection.checkpoints(initId(checkpointInit ?? init))).find((c) => c.tick === startTick)
      if (saved) packed = { meta: saved.meta as PackedResume['meta'], buffer: saved.buffer }
    }
    if (packed) hooks.start(packed.meta.init, { ...perf }, { build, resume: packed, tweaks: init })
    else hooks.start(init, { ...perf }, { build })
  }
  q('#s-start').addEventListener('click', () => void go(false))
  q('#s-start-paused').addEventListener('click', () => void go(true))

  addEventListener('keydown', (e) => {
    if (root.hidden) return
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      ;(document.activeElement as HTMLElement | null)?.blur()
      void go(false)
    } else if (typing) return
    else if (e.key >= '1' && e.key <= '5') {
      tab = TABS[Number(e.key) - 1][0]
      paintTabs()
    } else if (e.key === 'r' || e.key === 'R') rollAnother()
    else if (e.key === 'b' || e.key === 'B') useBest()
  })

  refresh()
  return {
    refresh,
    stop: () => preview.stop(),
    /** Open a world that came from somewhere else — the collection, a file — with its dials live. */
    load: (loaded: Init) => {
      init = loaded
      resume = null
      startTick = 0
      custom = true
      chosen = -1
      refresh()
    },
  }
}
