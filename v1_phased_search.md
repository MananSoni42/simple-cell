# v1 — the phased search

A search over the quantized chemistry matrix and the world dials, looking for worlds whose
organisms climb the ladder of milestones. This is the retrospective; [SEARCH.md](SEARCH.md) is the
log written as it ran.

Companion docs: [RULES.md](RULES.md) (the world), [LEARNING.md](LEARNING.md) (learning and the
measurements behind it), [PLAN.md](PLAN.md) (backlog).

---

## The scale

| phase | world | ticks each | generations | seeds | worlds | simulated | cost |
|---|---|---|---|---|---|---|---|
| 0 sanity | 24 slots / 120 matter | 500 | 0.4 | 1 | **200,000** | 100.0M ticks | 11.2 core-h |
| 1 screen | 60 / 300 | 2,000 | 1.5 | 1 | **60,000** | 105.6M ticks | 44.0 core-h |
| 2 rank | 150 / 700 | 20,000 | 16 | 2 | **600** | 11.7M ticks | 20.8 core-h |
| 3 confirm | 150 / 700 | 100,000 | 79 | 5 | **40** | 7.8M ticks | 14.0 core-h |
| **total** | | | | | **260,640** | **225.2M ticks** | **90 core-hours** |

**Ninety core-hours — 3.7 days of single-core time — in about seven hours of wall clock**, on twelve
parallel processes. Every one of those 260,640 worlds is catalogued by a hash of its spec, so any of
them can be rebuilt and run again exactly.

Coverage: 200,000 candidates against **11.8 million** distinct matter chemistries (7¹⁰ quantized
entries, divided by the 24 relabellings of four particle types) — about **1.7%** of the space, drawn
half from a predicted-productive region and half uniformly as a control.

Phase 4 (1,000,000 ticks, 790 generations) was **cancelled on evidence**: every world in phase 3
plateaued, none using more than 16,000 of its 100,000 ticks. Nothing was still climbing at 79
generations, so 790 would have bought nothing.

## What the search was for

Thirteen rungs in six levels of organisation — matter, metabolism, agency, heredity, association,
collective — where each level's units become the next level's parts. A level counts only when every
rung at and below it holds. The search ranked on the **continuous score** (each rung's progress,
capped at one, summed), because a rung number is a cliff and a search needs a gradient.

## What it found about worlds

**Heredity and association are solved; metabolism and agency are not.** Among the forty confirmed
worlds, *every single one* breeds true to the third generation, keeps a lineage alive for many
lifetimes, and has organisms bonded into compound objects — all three at 100%. Meanwhile:

| rung | confirmed worlds meeting it |
|---|---|
| Breeds true · Lineage outlives · Joins | **100%** |
| Moves together | 52.5% |
| Keeps its body | 47.5% |
| Feeds · Lasts | 20% |
| Holds · Renews · Transmits joining | 15% |
| Seeks · Grows from within | 2.5% |

That is the opposite of the order the ladder assumes. Organisms joining into structures is *easy*
here; organisms feeding themselves is *hard*. Nothing in 260,640 worlds reached level 2.

**Food is the strongest dial by a wide margin.** Abundant beats scarce by z = 89 at phase 0 (score
6.09 against 3.54), and **all ten** confirmed worlds use abundant food. Then food regime (bloom
best, cycle worst, z = 84), food pattern (patchy best, z = 40), metabolism (z = 33).

**The chemistry prior was mostly wrong.** It predicted sparse matrices, moderate strengths, and
self-repulsion on the diagonal. Measured: differentiated food appetites do help, as predicted and as
the strongest chemistry effect; but the *densest* matrices scored best, and cross-attraction helped
while self-repulsion hurt. By phase 2 the self-repulsion effect had vanished rather than reversed,
which is what the pre-registered prediction said it would not do.

**Organisms live on their inheritance.** Across 60,000 worlds the median lifetime harvest is
**0.067 of the birth endowment** — the typical organism eats about half a time in its whole life.
Good worlds do better (1.57 at the top), so this is a property of the median chemistry rather than
of the world, but it explains a great deal: no learner ever improved foraging because there was
almost nothing to forage, and thrift won because spending less is the only lever when intake is 7%
of starting capital.

**The lever that works is the mouth.** `r_eat` 6 → 12 doubles meals and lifts a world a level;
combined with a smaller birth endowment it reaches **4.05 coasting times**, more than double the
baseline and the longest intrinsic lifespan measured anywhere in this project. It is a *window*
rather than a direction — 12 beats 20 in both pairings — and the interaction matters: a small
endowment alone is the worst setting tried, because newborns starve before eating, and the best in
combination, because once the mouth is wide enough, starting poor forces feeding.

## What it found about the measurements — which mattered more

A search large enough to matter finds the flaw in the objective before it finds the thing the
objective was for. This one found three, and all three came from asking what the search *selected
for* rather than what it found.

**1. `Lasts` rewarded short lives.** Nine of the ten confirmed top worlds ran at the most expensive
metabolism. That survived five seeds and medians, so it was not a sampling artifact:

| metabolism | p90 coasting times | mean life (ticks) |
|---|---|---|
| 0.25 | 1.53 | **1,280** |
| 2 | **2.35** | **479** |

Coasting time is `endowment ÷ upkeep`; upkeep scales with the metabolism dial; so the yardstick
halves while the lifespan falls by less. The rung built *specifically* so that making living cheaper
could not buy it ended up rewarding organisms that died soonest. **Fixed** by measuring coasting
time against the laws' upkeep rate rather than the world's, and by requiring an absolute 2,000-tick
floor as well — coasts alone reward expensive living, absolute ticks alone reward cheap living,
both together reward neither.

**2. `Seeks` reads geometry, not behaviour.** Alignment between movement and food direction runs
0.000 → 0.107 → 0.000 as `r_eat` goes 6 → 12 → 20, with no learner present and nothing to learn
from. Non-monotonic in a parameter that should only help means the metric is measuring the geometry
of eating range against food density: inside a cloud of food the pull directions cancel, leaving no
direction to align with. **Not yet fixed** — the repair is to measure alignment only when the food
signal is a genuine direction, or only for organisms not already touching food.

**3. A z-score with no effect size.** `Seeks` originally asked for z ≥ 3. Pooled over hundreds of
lives the decided-tick count reaches six figures, z grows with √N, and an alignment of 0.01 clears
it — the first run reported **z = 133**. Significance is the right guard against noise and the wrong
statement of a claim. **Fixed** by requiring the effect to be both real and worth having.

Two smaller ones, both caught by tests or by reading output: a factor analysis that pooled phases
and so reported the run *schedule* as a property of the dials, and a promotion step that took the
global top N — which would have discarded the self-repelling chemistries the pre-registered
prediction was about, letting the screen confirm the screen. Promotion is now stratified across 160
cells.

## What broke, and what it cost

| | |
|---|---|
| Phase 0 finished all 200,000 worlds and **crashed in its own summary line** | `Math.max(...)` spreads each element as an argument; 200,000 overflows the stack. Data intact. |
| The stratifier used `Array.includes` | Three billion comparisons at a 60,000 promotion budget — a hang, not a slow step. |
| The progress heartbeat printed "left 11.1h" for a 1.6-hour phase | A rate computed from zero completions is zero, and dividing by it looks like information. |
| A quadratic allocation in the structure centroid | Spread the member set into a fresh array once per member, on groups reaching forty. |

## Honest limits of v1

- **No learning ran.** Every phase used `learn: none`, deliberately — a learner cannot act in these
  worlds, because it only acts at a spawn and a spawn needs a free brain slot that a healthy
  population never has. So this searched *worlds*, not organisms.
- **Phase 2 changed two things at once** — horizon ×10 and world size ×2.5 — so the credit for
  lifting `Feeds` from 0.1% to 21.6% cannot be split between them from this data.
- **The catalog's rung-1 and rung-2 figures predate the `Lasts` fix** and are not comparable with
  anything measured after it. The top-ten ordering is driven mostly by the other eleven rungs.
- **1.7% of the chemistry space**, and only one world shape per phase.
- **Single-seed leads**: the eating experiment is one spec at one seed per condition. Directionally
  strong, not confirmed.
