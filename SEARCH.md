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

### Where the walls are — across all 200,000 worlds

The most useful thing the catalog produced, and the one a top-ten list cannot: the share of worlds
meeting each rung.

| rung | met | mean progress |
|---|---|---|
| 0 Persists | 100% | 100% |
| **1 Feeds** | **0.2%** | 9% |
| **2 Lasts** | **0.1%** | 13% |
| **3 Seeks** | **0.3%** | 9% |
| 4 Keeps its body | 57.8% | 96% |
| 5 Breeds true | 65.4% | 74% |
| 6 Lineage outlives | 79.0% | 88% |
| 7 Joins | 81.5% | 88% |
| 8 Holds | 37.8% | 60% |
| 9 Renews | 36.3% | 55% |
| 10 Moves together | 57.1% | 69% |
| 11 Transmits joining | 26.6% | 67% |
| 12 Grows from within | 8.4% | 14% |

**Association is easy; self-sufficiency is hard.** Four worlds in five get organisms bonding, more
than a third hold a structure together — and one in five hundred has organisms that out-earn what
they were born with. Since a level stops at the lowest gap, *no* world can exceed level 0 while
rung 1 fails, which is why the continuous score rather than the level is doing all of the ranking.

Two caveats, both pointing the same way. Rungs 1–3 are computed from the ring of *completed* lives,
and a five-hundred-tick run has very few, so they are under-measured here rather than genuinely
impossible — phase 1 at 2,000 ticks and phase 2 at 20,000 will say how much of this is the horizon.
And the ladder now reports **rungs met in total** beside the gapped level, because "level 0" about
a world that clears nine of thirteen is true and useless.

### Phase 1 — complete, and the finding that reframes the project

**60,000 worlds · 105.6M ticks · 44 core-hours in 3.8 hours of wall clock.** Early stopping did
most of that: two thirds plateaued out early and 17% *earned extensions* past their horizon, so the
effective speedup came out at 11.6× rather than the 8× the pool was measured at.

**The walls did not move when the horizon quadrupled.**

| rung | 500 ticks | 2,000 ticks |
|---|---|---|
| Feeds | 0.2% | 0.1% |
| Lasts | 0.1% | 0.1% |
| Seeks | 0.3% | 0.3% |

Five worlds of sixty thousand reached level 1. So this is not a measurement artifact of a short run,
as I had assumed — it is a fact about the laws.

**Why: organisms eat less than once per lifetime.**

| fed ratio (lifetime harvest ÷ birth endowment) | |
|---|---|
| median | **0.067** |
| p90 | 0.25 |
| p99 | 0.59 |
| p99.9 | 0.90 |
| best of 60,000 | 1.28 |

Uptake is not the problem — a meal is the *whole* food particle, `E_food` = 10, taken when it comes
within `r_eat` = 6 of a limb. The arithmetic is the problem. A budded child's endowment is
`E_birth` × about 4.9 particles ≈ 73, so matching it takes **7.3 meals**, and a median fed of 0.067
means the typical organism eats **0.49 times in its whole life**.

That single number explains most of what this project has measured. No learner ever improved
foraging because there is almost nothing to forage. Thrift was the only winning strategy because
spending less is the only lever when intake is 7% of starting capital. `Lasts` fails because
organisms die at about the moment their inheritance runs out — p90 is 1.38 coasting times.
Association is easy because bonding costs nothing and requires no food. **These organisms live on
their inheritance, and the population is subsidised by the energy the world injects when it endows
a spawn.**

The binding constraint is **encounter rate**: `r_eat` = 6 in a world 300 across. The levers, in the
order I would pull them: raise `r_eat`, lower `E_birth` (less inheritance to coast on), then
`E_food` and standing food density. Two constants would make feeding *common*, which is the
precondition for foraging being learnable at all.

Best world of the 60,000: score 11.89, `converging`/abundant/noisy, metabolism 2, flow 0.05, T 1 —
fed **1.22**, order 20, generation 12. It does feed itself, which is why it tops the list.

### Phase 2 — running

600 worlds × 20,000 ticks × 2 seeds. Estimated **2.2 hours**. The first phase that can judge
structure, and the one that tests the pre-registered self-repulsion prediction.

_Updates appended below as they land._
