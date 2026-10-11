import type { OrganismFile } from '../core/organism'
import { TYPE_NAMES } from '../core/types'

/** Side panel for one organism: what it is, and buttons to save or re-seed it. */
export class InspectPanel {
  private current: OrganismFile | null = null

  constructor(
    private root: HTMLElement,
    private onPlace: (o: OrganismFile) => void,
  ) {}

  get open(): boolean {
    return this.current !== null
  }

  /** The rail is always present, so "nothing selected" is a hint rather than an empty box. */
  hide(): void {
    this.current = null
    this.root.innerHTML = `<div class="hd"><span>Organism</span></div>
      <div class="empty-hint">click an organism in the world to look inside it<br><br>
      you will see its age, lineage and limbs, and can save it or drop a copy back in</div>`
  }

  show(o: OrganismFile | null): void {
    if (!o) {
      this.hide()
      return
    }
    this.current = o
    const limbs = o.limbs.map((l) => `q${l.quad} ${TYPE_NAMES[l.type]} ${l.reserve.toFixed(0)}`).join(' · ') || 'none'
    const rows: [string, string][] = [
      ['age', `${Math.round(o.age)} ticks`],
      ['generation', String(o.generation)],
      ['children', String(o.children)],
      ['reserve', o.reserve.toFixed(1)],
      ['limbs', `${o.limbs.length} — ${limbs}`],
      ['weights', `${o.wLimb.length} limb, ${o.wBrain.length} brain`],
    ]
    this.root.innerHTML = `
      <div class="hd"><span>Organism</span><span class="dim">gen ${o.generation}</span></div>
      <div class="kv">${rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('')}</div>
      <div class="row">
        <button id="o-save">save</button>
        <button id="o-copy">copy</button>
        <button id="o-clone">re-seed</button>
        <button id="o-load">load…</button>
      </div>
      <input type="file" id="o-file" accept="application/json" hidden />
      <div class="dim" id="o-note" style="margin-top:6px"></div>`
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!
    const note = q('#o-note')
    const text = () => JSON.stringify(this.current, null, 2)
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
        const { parseOrganism } = await import('../core/organism')
        const parsed = parseOrganism(await f.text())
        this.current = parsed
        this.onPlace(parsed)
        note.textContent = 'loaded and placed'
      } catch (err) {
        note.textContent = `could not read that: ${(err as Error).message}`
      }
    })
    this.root.hidden = false
  }
}
