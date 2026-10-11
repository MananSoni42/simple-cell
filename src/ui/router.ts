import { reducedMotion } from './theme'

export type Page = 'landing' | 'explain' | 'setup' | 'world' | 'summary'

/**
 * Four screens, one at a time, with a short crossfade. The transition is the only animation that
 * blocks anything, so it is kept to 140ms and skipped entirely under prefers-reduced-motion.
 */
export class Router {
  private els = new Map<Page, HTMLElement>()
  private current: Page | null = null
  onEnter?: (p: Page) => void

  constructor(pages: Page[]) {
    for (const p of pages) this.els.set(p, document.getElementById(`page-${p}`)!)
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
