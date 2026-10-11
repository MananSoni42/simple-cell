import { type ClusterStats, census, clusterStats } from '../core/metrics'
import type { World } from '../core/world'

const HISTORY = 240

interface Series {
  key: string
  color: string
  data: number[]
  canvas: HTMLCanvasElement
}

/** Running stats panel: live numbers plus sparklines sampled as the world ticks. */
export class StatsPanel {
  private el: Record<string, HTMLElement> = {}
  private series: Series[] = []
  private lastTick = -1
  private cluster: ClusterStats = { mean: 0, max: 0, count: 0 }
  private clusterAt = 0

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hd"><span id="s-tick"></span><span id="s-rate"></span></div>
      <div class="dim" id="s-world"></div>
      ${this.block('Organisms', 'orgs', '#f4f6fb')}
      <div class="sub" id="s-orgs-sub"></div>
      ${this.block('Food', 'food', '#a3e635')}
      ${this.block('Energy', 'energy', '#ffc145')}
      <div class="sub" id="s-energy-sub"></div>
      <div class="blk"><div class="row"><b>Largest connected</b><i id="s-max"></i></div>
      <div class="sub" id="s-cluster-sub"></div></div>`
    for (const id of ['s-tick', 's-rate', 's-world', 's-orgs-sub', 's-energy-sub', 's-max', 's-cluster-sub', 's-orgs', 's-food', 's-energy']) {
      this.el[id] = root.querySelector<HTMLElement>('#' + id)!
    }
    for (const [key, color] of [['orgs', '#f4f6fb'], ['food', '#a3e635'], ['energy', '#ffc145']] as const) {
      this.series.push({ key, color, data: [], canvas: root.querySelector<HTMLCanvasElement>('#c-' + key)! })
    }
  }

  private block(title: string, key: string, _color?: string): string {
    return `<div class="blk"><div class="row"><b>${title}</b><i id="s-${key}"></i></div><canvas id="c-${key}" width="220" height="26"></canvas></div>`
  }

  reset(): void {
    for (const s of this.series) s.data = []
    this.lastTick = -1
    this.clusterAt = 0
  }

  update(w: World, rateLabel: string): void {
    const c = census(w)
    const now = performance.now()
    if (now - this.clusterAt > 700) {
      this.cluster = clusterStats(w)
      this.clusterAt = now
    }
    if (w.tick !== this.lastTick) {
      this.lastTick = w.tick
      const total = c.eOrganisms + c.eFree + c.eFood
      const vals: Record<string, number> = { orgs: c.organisms, food: c.food, energy: total }
      for (const s of this.series) {
        s.data.push(vals[s.key])
        if (s.data.length > HISTORY) s.data.shift()
      }
    }
    const i = w.init
    const set = (id: string, text: string) => (this.el[id].textContent = text)
    set('s-tick', `tick ${w.tick}`)
    set('s-rate', rateLabel)
    set('s-world', `seed ${i.seed} · food ${i.foodMode} · T ${i.T}`)
    set('s-orgs', `${c.organisms} alive`)
    set('s-orgs-sub', `born ${w.nBirths} · died ${w.nDeaths} · oldest ${c.oldest} · record ${Math.max(w.recordAge, c.oldest)} · limbs/org ${c.organisms ? (c.limbs / c.organisms).toFixed(1) : '–'}`)
    set('s-food', `${c.food}`)
    set('s-energy', `${(c.eOrganisms + c.eFree + c.eFood).toFixed(0)}`)
    set('s-energy-sub', `organisms ${c.eOrganisms.toFixed(0)} · free ${c.eFree.toFixed(0)} · food ${c.eFood.toFixed(0)} · burned ${w.burned.toFixed(0)}`)
    set('s-max', `${this.cluster.max}`)
    set('s-cluster-sub', `mean ${this.cluster.mean.toFixed(1)} · clusters ${this.cluster.count} · free matter ${c.freeMatter}`)
    for (const s of this.series) this.spark(s)
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
