# Cell Life

A toy cellular world. Continuous space, discrete time, symmetric chemistry, and an
energy flux — built to find out whether membranes, metabolism, and self-repair can
fall out of a handful of universal laws rather than being written down.

The bet: give the world a 5 × 5 symmetric interaction matrix, Brownian motion, a
metabolic cost, and food raining in, and the interesting things — membranes with a
preferred spacing, structures that hold a chemical gradient, bodies that heal, body
*shapes* nobody enumerated — arrive on their own.

## Documents

| | |
|---|---|
| **[RULES.md](RULES.md)** | The authoritative v0 world rules. If the code disagrees with this, the code is wrong |
| **[DESIGN.md](DESIGN.md)** | Rationale, build order, test strategy, stack, open questions |

## Status

**v0 rules finalized, implementation pending.** Repo scaffolding and the headless
core's module layout are in place.

## Quick start

```sh
npm install
npm run dev        # world at http://localhost:5173
npm test           # headless core test suite
npm run typecheck
```

## Design constraints worth knowing before reading code

**Three tiers, and nothing crosses them.** *Laws* (force law, Brownian motion,
metabolic cost, conservation) are universal constants. *Initial conditions* (the
matrix, temperature, food rate) are what you tune. *Phenotype* (brain weights, body
state) emerges at runtime. If a behaviour we want has to be written into the laws,
it is encoded rather than emergent, and we have failed.

**`src/core/` is pure.** It never imports from `src/render/`, and never touches
`window`, `document`, or `Math.random`. The model is a deterministic function of
`(params, seed)`. That is what makes the invariant tests possible — matter
conservation, a closing energy ledger, monotone energy descent — and what will later
let evolution run headless, thousands of generations without a browser.

## Layout

```
src/core/     pure headless model: chemistry, physics, energy, organisms, neurons
src/render/   canvas drawing — glow sprites, rods, signal field wash
src/ui/       matrix heatmap editor, parameter panel, tick-rate control
tests/        unit, invariant, phenomenology, and performance suites
```

No runtime dependencies. TypeScript + Vite + Vitest + Canvas 2D.
