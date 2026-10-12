import type { OrganismFile } from '../core/organism'
import { portrait, weightMap } from './portrait'
import { fmt } from './theme'

/** The right rail: one organism, drawn, with the buttons to save or re-seed it. */
export class InspectPanel {
  private current: OrganismFile | null = null

  constructor(
    private root: HTMLElement,
    private onPlace: (o: OrganismFile) => void,
  ) {
    this.hide()
  }

  get open(): boolean {
    return this.current !== null
  }

  /** The rail is always present, so "nothing selected" is a hint rather than an empty box. */
  hide(): void {
    this.current = null
    this.root.innerHTML = `
      <div class="hd"><span>Organism</span></div>
      <div class="empty-hint">click an organism in the world to look inside it<br><br>
        you will see its body as it stands, what each part is holding, and the weights it inherited</div>`
  }

  show(o: OrganismFile | null): void {
    if (!o) {
      this.hide()
      return
    }
    this.current = o
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
