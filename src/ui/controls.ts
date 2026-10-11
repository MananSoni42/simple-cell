import { INK } from './theme'

/**
 * The small set of controls the setup screen is built from. Sliders are the default for anything
 * numeric and each carries a one-line consequence in plain English, so a number means something
 * without having to be understood. Mutually exclusive choices are chips, not dropdowns.
 */

let uid = 0
const nextId = (): string => `c${++uid}`

export interface SliderSpec {
  label: string
  min: number
  max: number
  step: number
  value: number
  /** Shown beside the value: what this setting *means* at its current level. */
  hint?: (v: number) => string
  /** Printed value, when the raw number is not what a reader wants. */
  format?: (v: number) => string
  /** Non-linear feel: slider position 0..1 maps to a value. */
  curve?: 'linear' | 'log'
  onChange: (v: number) => void
}

export class Slider {
  readonly el: HTMLElement
  private range: HTMLInputElement
  private num: HTMLInputElement
  private hintEl: HTMLElement
  private spec: SliderSpec

  constructor(spec: SliderSpec) {
    this.spec = spec
    const id = nextId()
    this.el = document.createElement('div')
    this.el.className = 'field'
    this.el.innerHTML = `
      <div class="field-head">
        <label for="${id}">${spec.label}</label>
        <input class="field-num" id="${id}-n" inputmode="decimal" />
      </div>
      <input type="range" id="${id}" min="0" max="1000" step="1" />
      <div class="field-hint"></div>`
    this.range = this.el.querySelector('input[type=range]')!
    this.num = this.el.querySelector('.field-num')!
    this.hintEl = this.el.querySelector('.field-hint')!

    this.range.addEventListener('input', () => {
      const v = this.snap(this.fromPos(Number(this.range.value) / 1000))
      spec.value = v
      this.paint()
      spec.onChange(v)
    })
    this.num.addEventListener('input', () => {
      const v = Number(this.num.value)
      if (this.num.value.trim() === '' || !Number.isFinite(v)) return
      spec.value = Math.min(spec.max, Math.max(spec.min, v))
      this.range.value = String(Math.round(this.toPos(spec.value) * 1000))
      this.hintEl.textContent = spec.hint?.(spec.value) ?? ''
      spec.onChange(spec.value)
    })
    this.num.addEventListener('blur', () => this.paint())
    this.set(spec.value)
  }

  private snap(v: number): number {
    const s = this.spec.step
    return Math.min(this.spec.max, Math.max(this.spec.min, Math.round(v / s) * s))
  }

  private fromPos(p: number): number {
    const { min, max, curve } = this.spec
    if (curve === 'log') {
      const lo = Math.log(Math.max(1e-6, min))
      return Math.exp(lo + p * (Math.log(max) - lo))
    }
    return min + p * (max - min)
  }

  private toPos(v: number): number {
    const { min, max, curve } = this.spec
    if (curve === 'log') {
      const lo = Math.log(Math.max(1e-6, min))
      return (Math.log(Math.max(1e-6, v)) - lo) / (Math.log(max) - lo)
    }
    return (v - min) / (max - min || 1)
  }

  private paint(): void {
    const v = this.spec.value
    this.range.value = String(Math.round(this.toPos(v) * 1000))
    this.num.value = this.spec.format ? this.spec.format(v) : String(Math.round(v * 1000) / 1000)
    this.hintEl.textContent = this.spec.hint?.(v) ?? ''
  }

  /** Update from outside (a preset was loaded, say) without firing onChange. */
  set(v: number): void {
    this.spec.value = Math.min(this.spec.max, Math.max(this.spec.min, v))
    this.paint()
  }
}

export interface ChipsSpec<T extends string> {
  label: string
  options: { value: T; label: string; hint?: string }[]
  value: T
  onChange: (v: T) => void
}

export class Chips<T extends string> {
  readonly el: HTMLElement
  private spec: ChipsSpec<T>

  constructor(spec: ChipsSpec<T>) {
    this.spec = spec
    this.el = document.createElement('div')
    this.el.className = 'field'
    this.el.innerHTML = `
      <div class="field-head"><label>${spec.label}</label></div>
      <div class="chips">${spec.options
        .map((o) => `<button type="button" data-v="${o.value}" title="${o.hint ?? ''}">${o.label}</button>`)
        .join('')}</div>
      <div class="field-hint"></div>`
    for (const b of Array.from(this.el.querySelectorAll<HTMLButtonElement>('button'))) {
      b.addEventListener('click', () => {
        this.set(b.dataset.v as T)
        spec.onChange(this.spec.value)
      })
    }
    this.set(spec.value)
  }

  set(v: T): void {
    this.spec.value = v
    for (const b of Array.from(this.el.querySelectorAll<HTMLButtonElement>('button'))) {
      b.classList.toggle('on', b.dataset.v === v)
    }
    this.el.querySelector('.field-hint')!.textContent = this.spec.options.find((o) => o.value === v)?.hint ?? ''
  }
}

export interface ToggleSpec {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}

export class Toggle {
  readonly el: HTMLElement
  private input: HTMLInputElement

  constructor(private spec: ToggleSpec) {
    const id = nextId()
    this.el = document.createElement('div')
    this.el.className = 'field field-toggle'
    this.el.innerHTML = `
      <label class="switch" for="${id}">
        <input type="checkbox" id="${id}" />
        <span class="track"><span class="knob"></span></span>
        <span class="switch-label">${spec.label}</span>
      </label>
      <div class="field-hint">${spec.hint ?? ''}</div>`
    this.input = this.el.querySelector('input')!
    this.input.addEventListener('change', () => spec.onChange(this.input.checked))
    this.set(spec.value)
  }

  set(v: boolean): void {
    this.spec.value = v
    this.input.checked = v
  }
}

/** A titled group of fields. */
export function card(title: string, note?: string): HTMLElement {
  const el = document.createElement('section')
  el.className = 'card-group'
  el.innerHTML = `<h3>${title}</h3>${note ? `<p class="note">${note}</p>` : ''}<div class="fields"></div>`
  return el
}

export function fieldsOf(c: HTMLElement): HTMLElement {
  return c.querySelector('.fields')!
}

/** A big labelled number, for the summary's hero row. */
export function stat(label: string, value: string, sub?: string, color: string = INK.primary): string {
  return `<div class="stat"><div class="stat-v" style="color:${color}">${value}</div>
    <div class="stat-l">${label}</div>${sub ? `<div class="stat-s">${sub}</div>` : ''}</div>`
}
