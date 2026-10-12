import { reducedMotion } from './theme'

export type Page = 'landing' | 'explain' | 'setup' | 'world' | 'summary' | 'library' | 'discoveries'

/**
 * Four screens, one at a time, with a short crossfade. The transition is the only animation that
 * blocks anything, so it is kept to 140ms and skipped entirely under prefers-reduced-motion.
 */
export class Router {
  private els = new Map<Page, HTMLElement>()
  private current: Page | null = null
  onEnter?: (p: Page) => void

  constructor(pages: Page[]) {
    for (const p of pages) {
      const el = document.getElementById(`page-${p}`)
      // A page in the type but missing from the list, or from the markup, fails here rather than
      // at the first navigation — which is how adding Discoveries produced a blank screen and an
      // undefined `hidden`, several steps away from the omission that caused it.
      if (!el) throw new Error(`router: no element for page "${p}"`)
      this.els.set(p, el)
    }
  }

  get page(): Page | null {
    return this.current
  }

  go(to: Page): void {
    if (to === this.current) return
    const from = this.current ? this.els.get(this.current)! : null
    const next = this.els.get(to)!
    this.current = to

    const show = (): void => {
      if (from) {
        from.hidden = true
        from.classList.remove('leave')
      }
      next.hidden = false
      next.classList.add('enter')
      // one frame later, so the browser has a start state to animate from
      requestAnimationFrame(() => {
        next.classList.remove('enter')
        next.scrollTop = 0
        this.onEnter?.(to)
      })
    }

    if (!from || reducedMotion()) {
      show()
      return
    }
    from.classList.add('leave')
    setTimeout(show, 120)
  }
}
