import { FITNESS, type FitnessSpec, describeSpec, keysOf } from '../core/fitness'
import { LEARNERS, ONLINE_ALGOS, type LearnAlgo, type LearnerStatus } from '../core/learning'
import { measurePicker } from './measure'
import type { OrganismFile } from '../core/organism'
import { bodyDiagram, portrait, weightMap } from './portrait'
import { CHART, INK, fmt } from './theme'

/** One saved organism, as the palette needs it. */
export interface PaletteItem {
  id: string
  name: string
  organism: OrganismFile
}

export interface LearningHooks {
  setFitness(spec: FitnessSpec): void
  setLearner(algo: LearnAlgo): void
}

/** The right rail: one organism when one is selected, and otherwise what the world is learning. */
export class InspectPanel {
  private current: OrganismFile | null = null
  /** Kept so the panel can redraw itself on every stats tick without being handed its hooks again. */
  private hooks: LearningHooks | null = null
  private last: { st: LearnerStatus; algo: LearnAlgo; changes: { tick: number; measure: string }[] } | null = null
  private canvas: HTMLCanvasElement | null = null
  /** True while the rail is showing learning, so a stats tick can refresh it in place. */
  private showing = false

  constructor(
    private root: HTMLElement,
    private onPlace: (o: OrganismFile) => void,
  ) {
    this.hide()
  }

  get open(): boolean {
    return this.current !== null
  }

  learningHooks(h: LearningHooks): void {
    this.hooks = h
  }

  /**
   * The idle rail. An empty "click something" panel wasted the one piece of screen that is always
   * visible while a world runs, so idle now answers the question you cannot otherwise ask of a
   * running world: is anything being optimised, on what, and is it working?
   */
  hide(): void {
    this.current = null
    this.showing = false
    if (this.last) {
      this.learning(this.last.st, this.last.algo, this.last.changes)
      return
    }
    this.root.innerHTML = `
      <div class="hd"><span>Learning</span></div>
      <div class="empty-hint">waiting for the world to report</div>`
  }

  /**
   * What the world is learning, with its progress drawn.
   *
   * Called on every stats tick, so it rebuilds only when the shape of what it says changes —
   * otherwise it just repaints the graph and the numbers, or a click on a measure chip would be
   * lost half a second later.
   */
  learning(st: LearnerStatus, algo: LearnAlgo, changes: { tick: number; measure: string }[]): void {
    this.last = { st, algo, changes }
    if (this.current !== null) return // an organism is open: it wins
    const on = algo !== 'none'
    const key = `${algo}|${describeSpec(st.spec)}|${changes.length}`
    if (!this.showing || this.root.dataset.lkey !== key) {
      this.root.dataset.lkey = key
      this.showing = true
      this.root.innerHTML = `
        <div class="hd"><span>Learning</span><span class="dim">${on ? st.name : 'off'}</span></div>
        <div class="${on ? 'learn-on' : 'learn-off'}" id="l-state"></div>
        ${
          on
            ? `<canvas id="c-learn" width="248" height="52"></canvas>
               <div class="sub" id="l-prog"></div>
               <div class="blk"><div class="row-k"><b>What every life came to</b></div>
                 <div class="scalars" id="l-scalars"></div></div>`
            : ''
        }
        <div class="blk" id="l-measure"></div>
        <div class="blk"><div class="row-k"><b>Algorithm</b></div>
          <div class="presets" id="l-algos"></div>
          <div class="note" id="l-algo-note"></div></div>
        ${changes.length ? `<div class="blk"><div class="row-k"><b>The measure changed</b></div><div class="sub">${changes
            .map((c) => `tick ${fmt.n(c.tick)} → ${c.measure}`)
            .join('<br>')}</div></div>`
          : ''}`
      this.canvas = this.root.querySelector<HTMLCanvasElement>('#c-learn')

      const algos = this.root.querySelector<HTMLElement>('#l-algos')!
      algos.innerHTML = LEARNERS.map(
        (l) => `<button type="button" data-lalgo="${l.key}" class="${l.key === algo ? 'on' : ''}" title="${l.blurb}">${l.name}</button>`,
      ).join('')
      for (const b of Array.from(algos.querySelectorAll<HTMLElement>('[data-lalgo]'))) {
        b.addEventListener('click', () => this.hooks?.setLearner(b.dataset.lalgo as LearnAlgo))
      }
      this.root.querySelector('#l-algo-note')!.textContent = on
        ? 'switching algorithm starts it over — a pool of genomes and a distribution are not interchangeable'
        : 'turn one on and it begins with the next organism born'

      const host = this.root.querySelector<HTMLElement>('#l-measure')!
      host.innerHTML = ''
      if (on) {
        host.append(
          measurePicker({
            spec: st.spec,
            compact: true,
            onChange: (spec) => this.hooks?.setFitness(spec),
          }),
        )
      }
    }

    /*
     * An online learner's figures mean different things, so they are labelled differently rather
     * than reusing a line written for batch algorithms. "Holding 40" means forty *living brains
     * being shaped* here, where for CEM it means one distribution — and "updates" counts ticks of
     * plasticity, which runs to six figures in a few thousand ticks rather than tens.
     */
    const online = ONLINE_ALGOS.includes(st.algo)
    this.root.querySelector('#l-state')!.innerHTML = !on
      ? `<b>Nothing is learning.</b><br>every new organism gets random weights, and whatever happens is
         the world doing it unaided`
      : online
        ? `<b>${describeSpec(st.spec)}</b> · <i>rewiring living brains</i><br>
           shaping ${fmt.n(st.held)} organisms · ${fmt.n(st.updates)} weight updates ·
           ${fmt.n(st.seen)} lives since scored`
        : `<b>${describeSpec(st.spec)}</b><br>${fmt.n(st.seen)} lives scored · ${fmt.n(st.updates)} updates ·
           holding ${fmt.n(st.held)} · cohort ${fmt.n(st.cohort)}`
    // with nothing learning there are no scored lives, and nine zeros say less than nothing
    if (on) {
      this.root.querySelector('#l-prog')!.textContent =
        `score now ${st.recent.toFixed(3)} · best ${st.best.toFixed(3)} (a percentile among recent deaths, so 0.5 is average)` +
        (online && st.updates > 0 && st.seen === 0
          ? ' — no lives have ended yet, so the graph is empty while the rewiring is not'
          : '')
    }
    this.paintScalars(st, on)
    this.paintProgress(st, on)
  }

  /**
   * Every scalar's raw mean, with the optimised ones marked. This is the reward-hack detector: a
   * learner lifting its own measure while everything else sinks is visible here and nowhere else.
   */
  private paintScalars(st: LearnerStatus, on: boolean): void {
    const host = this.root.querySelector<HTMLElement>('#l-scalars')
    if (!host) return
    const chosen = new Set(keysOf(st.spec))
    host.innerHTML = FITNESS.map(
      (f, i) =>
        `<div class="scalar${on && chosen.has(f.key) ? ' counted' : ''}"><i>${f.name}</i><b>${fmt.sig(st.means[i] ?? 0)}</b></div>`,
    ).join('')
  }

  private paintProgress(st: LearnerStatus, on: boolean): void {
    const c = this.canvas
    if (!c) return
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    if (!on || st.history.recent.length < 2) {
      ctx.fillStyle = INK.muted
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillText(on ? 'not enough lives yet' : '', 2, 30)
      return
    }
    const { recent, best } = st.history
    const hi = Math.max(1e-6, ...best, ...recent)
    const line = (vals: number[], color: string, width: number): void => {
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      vals.forEach((v, i) => {
        const x = (i / (vals.length - 1)) * (c.width - 2) + 1
        const y = c.height - 2 - (v / hi) * (c.height - 6)
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
    line(best, CHART.mint, 1)
    line(recent, CHART.blue, 1.6)
  }

  /**
   * The same rail, as somewhere to pick from while the Organism tool is armed.
   *
   * Arming used to mean leaving the world for the Collection screen, choosing, and coming back —
   * which is three screens to place one creature, and impossible to do twice without losing your
   * place. The faces are already drawn for the Collection, so showing them here costs nothing.
   */
  palette(items: PaletteItem[], armedId: string | null, onPick: (id: string | null) => void): void {
    this.current = null
    this.showing = false
    const card = (it: PaletteItem): string => `
      <article class="org-card${it.id === armedId ? ' armed' : ''}" data-pick="${it.id}">
        ${bodyDiagram(it.organism)}
        <div class="org-name">${it.name}</div>
      </article>`
    this.root.innerHTML = `
      <div class="hd"><span>Place</span><span class="dim">${items.length} kept</span></div>
      <button class="wide${armedId === null ? ' on' : ''}" data-pick="">a random brain</button>
      <div class="palette" style="margin-top:8px">${items.map(card).join('')}</div>
      ${items.length === 0 ? '<div class="empty-hint">nothing kept yet — organisms you save land here, ready to place</div>' : ''}
      <div class="note" style="margin-top:10px">click one, then click in the world</div>`
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('[data-pick]'))) {
      el.addEventListener('click', () => onPick(el.dataset.pick || null))
    }
  }

  show(o: OrganismFile | null): void {
    if (!o) {
      this.hide()
      return
    }
    this.current = o
    this.showing = false
    const chip = (k: string, v: string): string => `<span class="chip"><i>${k}</i>${v}</span>`
    this.root.innerHTML = `
      <div class="hd"><span>Organism</span><span class="dim">gen ${fmt.n(o.generation)}</span></div>
      ${portrait(o)}
      <div class="chips-row">
        ${chip('age', fmt.n(o.age) + 't')}
        ${chip('limbs', `${o.limbs.length}/4`)}
        ${chip('children', fmt.n(o.children))}
      </div>
      <div class="blk"><div class="row-k"><b>Inherited weights</b></div>${weightMap(o)}</div>
      <div class="row" style="gap:5px;margin-top:12px">
        <button id="o-save">save</button>
        <button id="o-copy">copy</button>
        <button id="o-clone">re-seed</button>
        <button id="o-load">load…</button>
      </div>
      <input type="file" id="o-file" accept="application/json" hidden />
      <div class="note" id="o-note" style="margin-top:6px"></div>`

    const q = <T extends HTMLElement>(sel: string): T => this.root.querySelector<T>(sel)!
    const note = q('#o-note')
    const text = (): string => JSON.stringify(this.current, null, 2)
    q('#o-save').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([text()], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `organism-gen${o.generation}-age${Math.round(o.age)}.json`
      a.click()
      URL.revokeObjectURL(url)
      note.textContent = 'saved'
    })
    q('#o-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text())
        note.textContent = 'copied'
      } catch {
        note.textContent = 'clipboard unavailable — use save'
      }
    })
    q('#o-clone').addEventListener('click', () => {
      if (this.current) this.onPlace(this.current)
      note.textContent = 'placed a copy in the world'
    })
    q('#o-load').addEventListener('click', () => q<HTMLInputElement>('#o-file').click())
    q<HTMLInputElement>('#o-file').addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (!f) return
      try {
        const { IncompatibleOrganism, parseOrganism } = await import('../core/organism')
        try {
          const parsed = parseOrganism(await f.text())
          this.show(parsed)
          this.onPlace(parsed)
          this.root.querySelector<HTMLElement>('#o-note')!.textContent = 'loaded and placed'
        } catch (err) {
          // A brain from another shape is refused rather than padded: padding gives you a
          // different organism wearing the same name.
          note.innerHTML =
            err instanceof IncompatibleOrganism
              ? `<b style="color:var(--bad)">cannot load this organism</b><br>${err.reason}`
              : `could not read that: ${(err as Error).message}`
        }
      } catch (err) {
        note.textContent = `could not read that: ${(err as Error).message}`
      }
    })
  }
}
