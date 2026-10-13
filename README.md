# SimpleCell

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
| **[docs/](docs/README.md)** | Every document, indexed |
| **[docs/RULES.md](docs/RULES.md)** | The authoritative v0 world rules. If the code disagrees with this, the code is wrong |
| **[docs/DESIGN.md](docs/DESIGN.md)** | Rationale, build order, test strategy, stack, open questions |

## Status

**v0 implemented**, plus budding reproduction, static/drifting food, world scaling, optional
multi-thread / GPU force computation, discrete-time guardrails, organism-aggregate and lifetime
metrics, rewind, and config export/import. Learning is paused.

Food is three independent dials — a **pattern** (where it lands: uniform, patches, a sunlit band,
converging or breathing colonies, a fixed spring, a moving comet, a ring), a **level** (scarce,
average or abundant, as a multiple of what the world actually spends) and a **regime** (steady,
cycle, bloom, decline, rising, noisy). Nine presets combine them.

The app has five screens: a **title** page, **setup** (grouped into physics / chemistry / food /
life / compute, with sliders that say what each value *means*), the **world** (stats rail, canvas,
organism inspector, controls), a **run summary** when you stop — hero numbers, observations
written from the recorded run, charts, and exports — and a **collection** of past runs and the
organisms kept from them, which can be placed back into new worlds.

Setup asks three questions (which world, how big, which seed) and keeps everything else in an
Advanced drawer that tells you what you have changed. A new world opens **paused**, with tools to
place organisms, food and terrain wherever you want them before it runs.

Start with **"how it works"** — one page explaining the whole model, generated from the live
constants. [docs/PLAN.md](docs/PLAN.md) carries the staged backlog and the measurements behind it.

## Quick start

```sh
npm install
npm run dev        # world at http://localhost:5173
npm test           # headless core test suite
npm run typecheck
# benchmark the force backends (serial / threads / GPU) in your browser:
#   http://localhost:5173/bench.html?scale=16&ticks=20
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
src/ui/       the four screens, shared controls, charts, design tokens
tests/        unit, invariant, phenomenology, and performance suites
```

No runtime dependencies. TypeScript + Vite + Vitest + Canvas 2D.
