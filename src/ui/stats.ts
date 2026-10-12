import type { Summary } from '../core/lifestats'
import { MAX_ORDER } from '../core/orders'
import type { StatsSnapshot } from '../sim/protocol'
import { sparkline } from './charts'
import { CHART, INK, fmt } from './theme'

const HISTORY = 200

interface Spark {
  key: 'orgs' | 'food' | 'energy'
  color: string
  data: number[]
  canvas: HTMLCanvasElement
}

/** The left rail: what the world is doing right now, updated every frame. */
export class StatsPanel {
  private el: Record<string, HTMLElement> = {}
  private sparks: Spark[] = []
  private lastTick = -1
  private lifeCanvas: HTMLCanvasElement

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hd"><span id="s-tick">tick 0</span><span id="s-rate" class="dim"></span></div>
      <div class="dim" id="s-world"></div>
      <div class="dim" id="s-perf"></div>
      ${this.block('Organisms', 'orgs')}
      <div class="sub" id="s-orgs-sub"></div>
      ${this.block('Food', 'food')}
      ${this.block('Energy', 'energy')}
      <div class="sub" id="s-energy-sub"></div>
      <div class="blk"><div class="row-k"><b>Compound organisms</b><i id="s-order"></i></div>
        <div class="sub" id="s-order-sub"></div></div>
      <div class="blk"><div class="row-k"><b>Lineages</b><i id="s-lineage"></i></div>
        <div class="sub" id="s-lineage-sub"></div></div>
      <div class="blk" id="s-learn-blk" hidden><div class="row-k"><b>Learning</b><i id="s-learn"></i></div>
        <div class="sub" id="s-learn-sub"></div></div>
      <div class="blk"><div class="row-k"><b>Mean lifespan</b><i id="s-life-head" class="dim"></i></div>
        <canvas id="c-life" width="248" height="38"></canvas>
        <div class="sub" id="s-life"></div></div>`
    for (const id of [
      's-tick', 's-rate', 's-world', 's-perf', 's-orgs', 's-orgs-sub', 's-food', 's-energy',
      's-energy-sub', 's-order', 's-order-sub', 's-lineage', 's-lineage-sub', 's-life', 's-life-head',
      's-learn', 's-learn-sub', 's-learn-blk',
    ]) {
      this.el[id] = root.querySelector<HTMLElement>('#' + id)!
    }
    for (const [key, color] of [['orgs', CHART.blue], ['food', CHART.mint], ['energy', CHART.amber]] as const) {
      this.sparks.push({ key, color, data: [], canvas: root.querySelector<HTMLCanvasElement>('#c-' + key)! })
    }
    this.lifeCanvas = root.querySelector<HTMLCanvasElement>('#c-life')!
  }

  private block(title: string, key: string): string {
    return `<div class="blk"><div class="row-k"><b>${title}</b><i id="s-${key}"></i></div>
      <canvas id="c-${key}" width="248" height="26"></canvas></div>`
  }

  reset(): void {
    for (const s of this.sparks) s.data = []
    this.lastTick = -1
  }

  update(st: StatsSnapshot, rateLabel: string, perf = ''): void {
    const c = st.census
    const total = c.eOrganisms + c.eFree + c.eFood
    if (st.tick !== this.lastTick) {
      this.lastTick = st.tick
      const vals = { orgs: c.organisms, food: c.food, energy: total }
      for (const s of this.sparks) {
        s.data.push(vals[s.key])
        if (s.data.length > HISTORY) s.data.shift()
      }
    }
    const set = (id: string, text: string): void => {
      this.el[id].textContent = text
    }
    set('s-tick', `tick ${fmt.n(st.tick)}`)
    set('s-rate', rateLabel)
    set('s-world', `seed ${st.seed} · ${st.size}² · food ${st.foodMode}${st.foodMoves ? ', drifting' : ', static'} · T ${st.T}`)
    set('s-perf', `${perf}${st.clampedPct > 0.05 ? ` · clamp ${st.clampedPct.toFixed(1)}%` : ''}`)

    set('s-orgs', `${fmt.n(c.organisms)} alive`)
    set('s-orgs-sub', `born ${fmt.n(st.births)} (${fmt.n(st.budded)} bred) · died ${fmt.n(st.deaths)} · ${c.organisms ? (c.limbs / c.organisms).toFixed(1) : '–'} limbs each · ${fmt.n(c.freeMatter)} loose`)
    set('s-food', fmt.n(c.food))
    set('s-energy', fmt.n(total))
    set('s-energy-sub', `in organisms ${fmt.n(c.eOrganisms)} · loose ${fmt.n(c.eFree)} · food ${fmt.n(c.eFood)} · burned ${fmt.n(st.burned)}`)

    const o = st.orders
    const parts: string[] = []
    for (let k = 2; k <= MAX_ORDER; k++) {
      if (o.live[k - 1] === 0 && o.surviving[k - 1] === 0) continue
      parts.push(`<b>${k}°</b> ${o.live[k - 1]}${o.surviving[k - 1] ? ` <span style="color:${INK.good}">(${o.surviving[k - 1]} held)</span>` : ''}`)
    }
    set('s-order', o.bestOrder > 1 ? `best ${o.bestOrder}° · ${fmt.n(o.bestAge)}t` : '—')
    this.el['s-order-sub'].innerHTML =
      (parts.length ? parts.join(' &nbsp; ') : 'none joined') +
      `<br>${fmt.n(st.bondCount)} bonds standing`

    // only when something is learning: an empty "Learning: none" block would be noise in a rail
    // that is already dense
    const lr = st.learner
    this.el['s-learn-blk'].hidden = !lr
    if (lr) {
      set('s-learn', `${lr.name}`)
      set(
        's-learn-sub',
        `${fmt.n(lr.seen)} lives scored on ${lr.fitness} · best ${fmt.sig(lr.best)} · ` +
          `recent ${fmt.sig(lr.recent)} · ${fmt.n(lr.updates)} updates · holding ${fmt.n(lr.held)}`,
      )
    }

    set('s-lineage', `${fmt.n(c.lineages)} alive`)
    set('s-lineage-sub', `biggest ${fmt.n(c.biggestLineage)} · gen ${fmt.n(c.maxGen)} · children ${fmt.n(c.children)} (most ${fmt.n(c.maxChildren)}) · oldest ${fmt.n(c.oldest)}t`)

    const l = st.life
    const show = (v: number): string => (Number.isFinite(v) ? fmt.n(v) : '–')
    set('s-life-head', `${(l.windowTicks / 1000).toFixed(0)}k window`)
    const sum = (label: string, s: Summary): string =>
      s.n === 0 ? `${label} —` : `${label} ${[s.min, s.median, s.mean, s.p90, s.max].map((v) => Math.round(v)).join(' / ')}`
    this.el['s-life'].innerHTML =
      `<span style="color:${CHART.blue}">■</span> particles ${show(l.windowMeanParticles)} &nbsp;` +
      `<span style="color:${CHART.coral}">■</span> organisms ${show(l.windowMeanOrganisms)}<br>` +
      `<span class="dim">all-time min/med/mean/p90/max</span><br>${sum('particles', l.particlesDied)}<br>${sum('organisms', l.organismsDied)}`

    this.lifeTrend(l.particlesTrend, l.organismsTrend)
    for (const s of this.sparks) sparkline(s.canvas, s.data, s.color)
  }

  /** Two lines on one scale: mean completed lifespan per bucket. Gaps are left, not bridged. */
  private lifeTrend(particles: Float64Array, organisms: Float64Array): void {
    const g = this.lifeCanvas.getContext('2d')!
    const { width: W, height: H } = this.lifeCanvas
    g.clearRect(0, 0, W, H)
    let max = 0
    for (const arr of [particles, organisms]) for (const v of arr) if (Number.isFinite(v) && v > max) max = v
    if (max <= 0) return
    for (const [arr, color] of [[particles, CHART.blue], [organisms, CHART.coral]] as const) {
      g.strokeStyle = color
      g.lineWidth = 1.5
      g.lineJoin = 'round'
      g.beginPath()
      let open = false
      arr.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          open = false
          return
        }
        const x = (i / (arr.length - 1)) * W
        const y = H - 2 - (v / max) * (H - 4)
        if (open) g.lineTo(x, y)
        else g.moveTo(x, y)
        open = true
      })
      g.stroke()
    }
    g.fillStyle = INK.muted
    g.font = '9px ui-monospace, monospace'
    g.fillText(fmt.n(max), 2, 9)
  }
}
