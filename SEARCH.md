# The search — running log

A phased search over the quantized chemistry matrix and the world dials, looking for worlds that
climb the ladder (RULES.md §23–24, LEARNING.md §0). This document is written as it runs.

Companion docs: [RULES.md](RULES.md) (the world), [LEARNING.md](LEARNING.md) (learning and
measurements), [PLAN.md](PLAN.md) (backlog).

---

## What is being searched

| | space |
|---|---|
| chemistry: the 5×5 symmetric quantized matrix | 7¹⁴ = 6.8×10¹¹ total; **11.8 million distinct** matter blocks after factoring out the 24 relabellings of the four particle types |
| dials | metabolism, energy-along-bonds, temperature, food pattern / level / regime / patches / radius / lifetime, fission on-off |
| world size | fixed per phase, since cost is superlinear in density |

Candidates are drawn in three parts, and the proportions are an experiment rather than a
preference: **50% constrained** (the region predicted to be productive — few nonzero couplings,
moderate strengths, self-repulsion on the diagonal), **30% uniform** as a control, **20% mutations**
of elites. If the constrained half does not beat the uniform half, the prior was wrong, and the
analysis will say so with a standard error attached.

## The measured facts the plan is built on

| world | live particles | ms/tick |
|---|---|---|
| tiny — 24 slots / 120 matter | 245 | 0.28 |
| small — 60 / 300 | 470 | 1.24 |
| default — 150 / 700 | 916 | 4.24 |

Cost is **superlinear in density**: 3.7× the particles costs 15× the time. And parallel throughput
peaks at **12 workers (3.62 worlds/s), with 14 slower than 12** — the four efficiency cores cost
more in memory contention than they add. Effective speedup is **8.0×**, not 12×.

One generation ≈ 1,300 ticks, which is what turns a tick budget into an evolutionary one.

## The phases

| phase | world | ticks | generations | seeds | candidates | keeps | wall clock |
|---|---|---|---|---|---|---|---|
| 0 sanity | tiny | 500 | 0.4 | 1 | 200,000 | ~30% | ~62 min |
| 1 screen | small | 2,000 | 1.5 | 1 | 60,000 | 600 | ~5 h |
| 2 rank | default | 20,000 | 16 | 2 | 600 | 40 | ~3.5 h |
| 3 confirm | default | 100,000 | 79 | 5 | 40 | **10** | ~2.9 h |
| 4 deep | default | 1,000,000 | 790 | 3 | 5 | — | ~2.2 h |

**What each phase may conclude.** Phase 0 runs four tenths of a generation. That is enough to judge
that a world is *impossible* — it cannot bond, cannot stay alive, or is numerically broken — and
nothing more, so it may not rank. Ranking on half a generation would discard slow starters, which
are exactly what we are looking for. Real ladder scoring starts at phase 2; phase 4 exists because
790 generations is where heritable traits and lineage turnover could actually show, and everything
below it measures ecology rather than evolution.

**Early stopping.** Extinct stops at once. Plateau stops when the ladder score has not improved for
a quarter of the horizon. And extension is the one that matters: a world still climbing when it
reaches its horizon earns up to 1.5× more ticks, because a fixed horizon throws away precisely the
worlds that are slowly getting somewhere.

**Noise.** Seeds escalate 1 → 1 → 2 → 5 → 3, reported as medians. Promotion takes the ranked cut
plus a **2% random rescue** from below it, which both insures against a short run being a noisy
ranker and measures how leaky the screen was.

---

## Log

### Phase 0 — running

200,000 candidates, 500 ticks each, 12 workers, at **63 worlds/s** — about 53 minutes, against a
62-minute estimate.

**Interim at 26,775 worlds.** Score here is the continuous ladder score, which at 0.4 generations
is dominated by levels 0–2; nothing reaches level 1, exactly as the phase's design says it cannot.

| factor | best | worst | z |
|---|---|---|---|
| food level | abundant 6.09 | scarce 3.54 | 89 |
| food over time | **bloom** 5.72 | cycle 3.61 | 64 |
| food pattern | patchy 5.19 | spring 4.72 | 28 |
| metabolism | 0.25 → 5.12 | 2.0 → 4.23 | 24 |
| food coupling spread | 2.0 → 4.96 | 1.25 → 4.79 | 13 |
| nonzero matter couplings | **10 (densest)** 4.82 | 6 → 4.69 | 3.9 |
| self-repelling types | **0** → 4.89 | 3 → 4.64 | 3.5 |
| mean coupling strength | — | — | 1.5 (noise) |

**Two of the three chemistry predictions are contradicted.** The prior said sparse, moderate, and
self-repelling on the diagonal. Differentiated food appetites do help — the strongest chemistry
effect in the table — but the *densest* matrices score best, and *zero* self-repelling types beats
three. Coupling strength does nothing measurable.

The honest caveat, which matters more than the result: phase 0 runs four tenths of a generation, so
this score measures early clumping and survival, not membranes. Self-repulsion plausibly slows
initial aggregation while still being the thing sheets require. Phase 2, at sixteen generations, is
the first phase entitled to an opinion about structure.

Also found a gap in the instrumentation while reading this: the catalog did not record **where a
candidate was drawn from**, so the pre-registered constrained-versus-uniform comparison could only
be inferred through derived shapes rather than measured. Fixed for phase 1 onward.

**At 96,949 worlds — the couplings.** Every cross-coupling tells the same story, with small but
consistent effects: `P2×P1` z=6.3, `P3×P2` z=6.1, `P3×P1` z=5.1, and in each case **1.00 scores
highest and 0.00 lowest** (4.79 against 4.65).

So the refined picture is not that density helps but that **cross-attraction** helps and
**self-repulsion hurts** — which together say "everything attracts everything", and at four tenths
of a generation that is exactly what maximises the two things this horizon can see: matter clumping
and organisms keeping their limbs.

### A prediction, written down before phase 2 can test it

**The sign of the self-repulsion effect will flip by phase 2.** The reasoning: universal attraction
makes droplets, and a droplet is the best possible thing to be in the first five hundred ticks —
it clumps immediately and holds limbs. A membrane needs self-repulsion with cross-attraction, and a
membrane is worth nothing until there is time for structure to persist and matter to differentiate.
Phase 2 runs sixteen generations and is the first phase entitled to an opinion about structure.

Concretely, at phase 2: `self-repelling types` should favour **2–3** over 0, reversing the z=3.5
seen here, and `Holds` should separate worlds that this phase cannot distinguish at all. If it does
not flip, the prior was simply wrong and universal attraction is genuinely the better chemistry —
which would be a more interesting finding than the one I expected.

### Phase 0 — complete

**200,000 worlds · 100M ticks · 11.2 core-hours in 56 minutes of wall clock.** 149,672 (75%) were
*possible* — something alive, something bonded, numerically sound — and nothing reached level 1,
which is what a 0.4-generation horizon can and cannot do, as designed.

Score mean 4.70, best 11.10.

**Two bugs it exposed.** The run finished every world and then crashed in its own summary line:
`Math.max(...)` spreads each element as a function argument, and two hundred thousand of them
overflows the call stack. Every aggregate that can see the whole catalog now reduces instead. And
the new stratifier used `Array.includes`, which at a 60,000 promotion budget is three billion
comparisons — a hang rather than a slow step.

**A screening bias worth more than either.** Every one of the top twenty worlds ran at
**metabolism 2**, the most expensive setting, while the marginal means put 0.25 ahead by a wide
margin (5.12 against 4.23). Both are right. Several rungs cannot report anything until lives have
*completed*, and a cheap-living world has barely any at five hundred ticks — so a fast-dying world
is not better, it is merely **measurable sooner**. Metabolism joined the promotion strata so that
the artifact does not decide what survives the screen.

### Phase 1 — running

60,000 worlds promoted stratified across **160 cells** (self-repulsion × food pattern × metabolism)
plus a 1,200-world random rescue, at 2,000 ticks each. Estimated **5.2 hours**.

_Updates appended below as they land._
