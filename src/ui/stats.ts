import type { Summary } from '../core/lifestats'
import type { StatsSnapshot } from '../sim/protocol'

const HISTORY = 240

interface Series {
  key: string
  color: string
  data: number[]
  canvas: HTMLCanvasElement
}

/** Running stats panel: live numbers, sparklines sampled per tick, and lifetime trends. */
export class StatsPanel {
  private el: Record<string, HTMLElement> = {}
  private series: Series[] = []
  private lastTick = -1
  private lifeCanvas: HTMLCanvasElement

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hd"><span id="s-tick"></span><span id="s-rate"></span></div>
      <div class="dim" id="s-world"></div>
      <div class="dim" id="s-perf"></div>
      ${this.block('Organisms', 'orgs')}
      <div class="sub" id="s-orgs-sub"></div>
      ${this.block('Food', 'food')}
      ${this.block('Energy', 'energy')}
      <div class="sub" id="s-energy-sub"></div>
      <div class="blk"><div class="row"><b>Compound organisms</b><i id="s-order"></i></div>
      <div class="sub" id="s-order-sub"></div>
      <div class="sub" id="s-agg-sub"></div></div>
      <div class="blk"><div class="row"><b>Lineages</b><i id="s-lineage"></i></div>
      <div class="sub" id="s-lineage-sub"></div></div>
      <div class="blk"><div class="row"><b>Mean lifespan</b><i id="s-life-head"></i></div>
      <canvas id="c-life" width="220" height="40"></canvas>
      <div class="sub" id="s-life"></div></div>`
    for (const id of ['s-tick', 's-rate', 's-world', 's-perf', 's-orgs', 's-orgs-sub', 's-food', 's-energy', 's-energy-sub', 's-order', 's-order-sub', 's-agg-sub', 's-lineage', 's-lineage-sub', 's-life', 's-life-head']) {
      this.el[id] = root.querySelector<HTMLElement>('#' + id)!
    }
    for (const [key, color] of [['orgs', '#f4f6fb'], ['food', '#a3e635'], ['energy', '#ffc145']] as const) {
      this.series.push({ key, color, data: [], canvas: root.querySelector<HTMLCanvasElement>('#c-' + key)! })
    }
    this.lifeCanvas = root.querySelector<HTMLCanvasElement>('#c-life')!
  }

  private block(title: string, key: string): string {
    return `<div class="blk"><div class="row"><b>${title}</b><i id="s-${key}"></i></div><canvas id="c-${key}" width="220" height="26"></canvas></div>`
  }

  reset(): void {
    for (const s of this.series) s.data = []
    this.lastTick = -1
  }

  update(st: StatsSnapshot, rateLabel: string, perf = ''): void {
    const c = st.census
    if (st.tick !== this.lastTick) {
      this.lastTick = st.tick
      const vals: Record<string, number> = { orgs: c.organisms, food: c.food, energy: c.eOrganisms + c.eFree + c.eFood }
      for (const s of this.series) {
        s.data.push(vals[s.key])
        if (s.data.length > HISTORY) s.data.shift()
      }
    }
    const set = (id: string, text: string) => (this.el[id].textContent = text)
    set('s-tick', `tick ${st.tick}`)
    set('s-rate', rateLabel)
    set('s-world', `seed ${st.seed} · ${st.size}² · food ${st.foodMode}${st.foodMoves ? ' (drifting)' : ' (static)'} · T ${st.T}`)
    set('s-perf', `${perf}${st.clampedPct > 0.05 ? ` · step clamped ${st.clampedPct.toFixed(1)}%` : ''}`)
    set('s-orgs', `${c.organisms} alive`)
    set('s-orgs-sub', `born ${st.births} (${st.budded} budded) · died ${st.deaths} · free matter ${c.freeMatter} · limbs/org ${c.organisms ? (c.limbs / c.organisms).toFixed(1) : '–'}`)
    set('s-food', `${c.food}`)
    set('s-energy', `${(c.eOrganisms + c.eFree + c.eFood).toFixed(0)}`)
    set('s-energy-sub', `organisms ${c.eOrganisms.toFixed(0)} · free ${c.eFree.toFixed(0)} · food ${c.eFood.toFixed(0)} · burned ${st.burned.toFixed(0)}`)
    const o = st.orders
    const orders: string[] = []
    for (let n = 1; n <= o.live.length; n++) {
      if (o.live[n - 1] === 0 && o.surviving[n - 1] === 0) continue
      orders.push(`<b>${n}°</b> ${o.live[n - 1]}${o.surviving[n - 1] ? ` <span style="color:#3ddc97">(${o.surviving[n - 1]} held)</span>` : ''}`)
    }
    set('s-order', o.bestOrder > 1 ? `best ${o.bestOrder}° for ${o.bestAge}t` : '—')
    this.el['s-order-sub'].innerHTML =
      (orders.length ? orders.join(' &nbsp; ') : 'none') +
      `<br><span class="dim">held = bonded together for ${Math.round(o.holdFrac * 100)}% of the last ${(o.windowTicks / 1000).toFixed(0)}k ticks</span>`
    const g = st.aggregates
    set('s-agg-sub', `bonds ${st.bondCount} · touching groups ${g.groups} (biggest ${g.largest}) · oldest contact ${g.oldestBond}t`)
    set('s-lineage', `${c.lineages} alive`)
    set('s-lineage-sub', `biggest ${c.biggestLineage} organisms · max gen ${c.maxGen} · children ${c.children} (most ${c.maxChildren}) · oldest ${c.oldest} · record ${Math.max(st.recordAge, c.oldest)}`)

    const l = st.life
    const mp = l.windowMeanParticles
    const mo = l.windowMeanOrganisms
    const fmt = (v: number) => (Number.isFinite(v) ? Math.round(v).toString() : '–')
    set('s-life-head', `${(l.windowTicks / 1000).toFixed(0)}k ticks`)
    const f = (label: string, s: Summary) =>
      s.n === 0 ? `${label}: –` : `${label} (${s.n}): ${[s.min, s.median, s.mean, s.p90, s.max].map((v) => Math.round(v)).join(' / ')}`
    this.el['s-life'].innerHTML =
      `<span style="color:#5b8def">■</span> particles ${fmt(mp)} &nbsp; <span style="color:#f4f6fb">■</span> organisms ${fmt(mo)} ticks<br>` +
      `all-time min/med/mean/p90/max<br>${f('particles', l.particlesDied)}<br>${f('organisms', l.organismsDied)}`
    this.lifeTrend(l.particlesTrend, l.organismsTrend)
    for (const s of this.series) this.spark(s)
  }

  /** Two lines on a shared scale: mean completed lifespan per bucket across the window. */
  private lifeTrend(particles: Float64Array, organisms: Float64Array): void {
    const g = this.lifeCanvas.getContext('2d')!
    const { width: W, height: H } = this.lifeCanvas
    g.clearRect(0, 0, W, H)
    let max = 0
    for (const arr of [particles, organisms]) for (const v of arr) if (Number.isFinite(v) && v > max) max = v
    if (max <= 0) return
    for (const [arr, color] of [[particles, '#5b8def'], [organisms, '#f4f6fb']] as const) {
      g.strokeStyle = color
      g.lineWidth = 1.5
      g.lineJoin = 'round'
      g.beginPath()
      let drawing = false
      arr.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          drawing = false // a gap means nothing died in that bucket; do not bridge it
          return
        }
        const x = (i / (arr.length - 1)) * W
        const y = H - 2 - (v / max) * (H - 4)
        if (drawing) g.lineTo(x, y)
        else g.moveTo(x, y)
        drawing = true
      })
      g.stroke()
    }
    g.fillStyle = '#6b7589'
    g.font = '9px ui-monospace, monospace'
    g.fillText(String(Math.round(max)), 2, 9)
  }

  private spark(s: Series): void {
    const g = s.canvas.getContext('2d')!
    const { width: W, height: H } = s.canvas
    g.clearRect(0, 0, W, H)
    if (s.data.length < 2) return
    const max = Math.max(...s.data, 1)
    const min = Math.min(...s.data, 0)
    g.strokeStyle = s.color
    g.globalAlpha = 0.85
    g.lineWidth = 1.5
    g.lineJoin = 'round'
    g.beginPath()
    s.data.forEach((v, n) => {
      const x = (n / (HISTORY - 1)) * W
      const y = H - 2 - ((v - min) / (max - min || 1)) * (H - 4)
      if (n === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    })
    g.stroke()
    g.globalAlpha = 1
  }
}
