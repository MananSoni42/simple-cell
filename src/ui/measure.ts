import { COMBINERS, FITNESS, type FitnessSpec, isImplicitOnly, keysOf, normalised, specFromKeys } from '../core/fitness'

/**
 * Choosing what counts as doing well. One implementation, two places: the picker before a world
 * exists, and the world screen while one is running — because they are the same decision, and the
 * second is only interesting if it is exactly as expressive as the first.
 *
 * Weights are kept **equal across whatever is selected** rather than exposed as nine numbers.
 * Asking someone to balance "offspring" against "foraging" numerically is asking a question nobody
 * can answer honestly; ticking two boxes and being told they count the same is a claim that can be
 * understood. Unequal weights remain representable in a config for anyone who wants them.
 */
export interface MeasureOptions {
  spec: FitnessSpec
  onChange(spec: FitnessSpec): void
  /** Compact form for the world rail: no explanatory prose, smaller chips. */
  compact?: boolean
  /** Off when the surrounding card already carries the title. */
  heading?: boolean
}

export function measurePicker(opts: MeasureOptions): HTMLElement {
  const el = document.createElement('div')
  el.className = `measure${opts.compact ? ' compact' : ''}`
  render()
  return el

  function render(): void {
    const spec = opts.spec
    const keys = keysOf(spec)
    const many = keys.length > 1
    const chosen = FITNESS.filter((f) => keys.includes(f.key))
    const weights = normalised(spec)

    const count = `${keys.length} of ${FITNESS.length}${many ? ` · counted ${COMBINERS.find((c) => c.key === spec.combine)!.name}` : ''}`
    el.innerHTML = `
      ${
        opts.heading === false
          ? `<div class="field-head"><span class="note">${count}</span></div>`
          : `<div class="field-head"><label>what counts as doing well</label><span class="note">${count}</span></div>`
      }
      <div class="presets" id="m-keys">${FITNESS.map(
        (f) =>
          `<button type="button" data-key="${f.key}" class="${keys.includes(f.key) ? 'on' : ''}" title="${f.blurb}">${f.name}${
            many && keys.includes(f.key) ? `<i class="w">${Math.round(100 * weights[FITNESS.indexOf(f)])}%</i>` : ''
          }</button>`,
      ).join('')}</div>
      <div class="field-hint">${
        keys.length === 0
          ? 'nothing selected — pick at least one'
          : many
            ? 'each one is turned into a percentile among recent deaths before they are combined, so measures on wildly different scales can be added at all'
            : chosen[0].blurb
      }</div>
      ${
        many
          ? `<div class="presets" id="m-comb">${COMBINERS.map(
              (c) => `<button type="button" data-comb="${c.key}" class="${c.key === spec.combine ? 'on' : ''}" title="${c.blurb}">${c.name}</button>`,
            ).join('')}</div>
             <div class="field-hint">${COMBINERS.find((c) => c.key === spec.combine)!.blurb}</div>`
          : ''
      }
      ${
        opts.compact
          ? ''
          : `<div class="stab">${
              isImplicitOnly(spec)
                ? `<b class="ok">the world's own measure</b> — offspring is the one number the world was already
                   counting for its own reasons, so nothing has been written down that was not there already.`
                : `<b class="warn">a stated choice</b> — optimising ${
                    many ? 'these' : 'this'
                  } produces organisms good at <i>${many ? 'exactly this combination' : chosen[0].name}</i>, which is not the
                   same as finding out what the world can support. Every scalar is reported either way, which is how
                   a learner gaming its own measure gets noticed.`
            }</div>`
      }`

    for (const b of Array.from(el.querySelectorAll<HTMLElement>('[data-key]'))) {
      b.addEventListener('click', () => {
        const key = b.dataset.key as (typeof FITNESS)[number]['key']
        const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
        // never leave nothing selected: a spec with no measures scores every life the same
        if (next.length === 0) return
        opts.spec = specFromKeys(next, spec.combine, spec.window)
        render()
        opts.onChange(opts.spec)
      })
    }
    for (const b of Array.from(el.querySelectorAll<HTMLElement>('[data-comb]'))) {
      b.addEventListener('click', () => {
        opts.spec = { ...spec, combine: b.dataset.comb as FitnessSpec['combine'] }
        render()
        opts.onChange(opts.spec)
      })
    }
  }
}
