# Structural misses

A review of what the world *could not express*, rather than what it happened to do badly. The
distinction matters: a world that does badly at something is a result, and a world where
something is not representable is a bug in the question. Ten were found; this is the record of
all ten and of the four that were acted on.

The prompt for it was one observation — **an organism inside a cloud of food does not know it is
there** — and the exercise was to look for more of the same kind.

## The ten

| # | Miss | Verified in code | Status |
|---|---|---|---|
| 1 | **Blind inside food.** `ffx/ffy` is a vector *sum* of food forces, so an organism in a symmetric cloud reads exactly zero — identical to a desert. The fix already existed and was unused: `foodNear` was computed every tick for every particle, stored, snapshotted, and **read by nothing**. | `forcekernel.ts`: `if (tj === FOOD) { near++; … } foodNear[i] = near` | **done** |
| 2 | **Food is exactly as mobile as life.** One global `μ`, so with `foodMoves: true` a crumb drifted as fast as a limb swam and took the same thermal kick, σ ≈ 0.8–1.4 a sub-step. You cannot catch what diffuses as fast as you move. | `world.ts` `integrateOnce` used the same `mu` and `sn` for every particle | **done** |
| 3 | **The brain cannot perceive its own body or bonds.** Of 29 inputs, none carried limb angle (`theta`), own velocity, or any bond state. So "moves together" and "transmits joining" asked for coordination the brain had no information to produce. | no brain input referenced `theta`, `mv*`, or `bonds` | **done** |
| 4 | **No anabolism.** Energy can never become matter, so a body is assembled only from pre-existing free particles. | `bud()` scans for `owner === -1` | not taken |
| 5 | **Reproduction stops silently when matter saturates.** Five separate early returns in `bud()`, no counter on any of them. | `bud()` | **counted** (see below) |
| 6 | **Nothing ages.** Death is starvation only; there is no senescence, so no selection pressure toward reproducing early. | `deaths()` kills on `energy <= 1e-12` alone | not taken |
| 7 | **Bonds have no angular rigidity.** A bond is a distance spring, so a bonded chain has no preferred shape and cannot hold a form. | `bondForce` is `k_bond · (r − r_bond)` | not taken |
| 8 | **Comet food does not move.** The pattern that implies motion places static food. | `foodMode: 'comet'` | not taken |
| 9 | **The sun looked like a thermostat.** Partly a misdiagnosis — see below. | `shine()` | **done, smaller than described** |
| 10 | **Signalling has no addressing.** The field is a scalar everyone reads, so a message cannot have a recipient. | `stepField` | not taken |

## #9 was partly my own error

I described the sun as throttling on standing stock. It does not: `foodRateNow()` is fixed by the
level, sustenance and regime dials, and nothing reads how much food is already out there. What
actually happens is that `injectFood()` fails when every food *slot* is occupied, and `max_food`
is the number of slots. So the rate was always fixed and the ceiling was always a capacity.

That is a smaller problem than I claimed, but it is not nothing, because **a capacity that binds
is a thermostat whether or not it was meant as one**, and at `120 × area` it bound: food spoilage
measurements had standing stock at 478/480 without expiry and ~250/480 with it, which is the same
order as the ceiling. Two changes, both small:

- capacity raised to `300 × area`, so the sun rather than the shelf sets the supply;
- `lightWasted` counts food the sun produced that there was no room for, so a saturated world
  says so instead of looking like a world with a dim sun. Those were previously the same
  observation — in both cases, food stops arriving.

## #5: "boundless" is not available, and why

The instruction was that reproduction should be boundless. It cannot be, literally: a child's
body is made of pre-existing free particles, so unlimited reproduction means creating matter from
energy, which is #4 — a different rule that was not asked for and is not in the model. Conserved
matter is a law here with tests against it.

What was done instead: `repBlocked` counts each cause separately, `{ limbless, slots, matter,
energy, room }`, surfaced in the world's left pane and in the catalog as rates per thousand
ticks. The point is that "nothing is breeding" had **four different diagnoses with one symptom**,
and only one of them is a result about the chemistry. A population out of free matter looks
exactly like a population whose chemistry cannot reproduce; the first is a budget to raise. With
`inflow` on the ceiling moves to `3 × n_brain` brain slots, which is the closest thing here to
unbounded.

## Second-order effects, considered before implementing

**The four changes are complementary, which is a problem for attribution.** Heavy food plus a
supply that is never throttled means food *accumulates where nothing eats it*, so patches become
genuinely rich and deserts genuinely empty — and that stronger spatial gradient is exactly what
makes a food count and self-motion worth having. Four changes that help each other are four
changes none of which can be credited. Hence `scripts/senses.ts` and the ablation seam.

**Ablation needed a seam, and blinding is better than removing.** `WorldOpts.blind` holds listed
brain inputs at zero. Removing an input would change the weight count and so the random prior,
making the comparison dirty at a seed; blinding leaves the draw identical.

**The brain shape changed, 29 → 41 inputs, which invalidates every saved organism.** This is the
fourth such change (27 → 33 → 29 → 41) and it is refused loudly rather than padded, which is
already the rule. The cost is low because the collection was wiped for the v1 search.

**`foodNear` is a raw count and had to be normalised.** It ranges from 0 to 50-odd; feeding that
into a linear layer saturates it at the first crumb. It goes through `tanh(near / 8)` — a lone
crumb reads 0.12, four read 0.46, a dense patch of twenty reads 0.99. This is the same mistake as
the oversized weight init, one layer earlier.

**Own velocity is a recurrence through the world, and it is lagged.** Force is chosen in
`think()`, which runs *after* `integrate()`, so a decision moves the body next tick and is felt
the tick after. Two ticks of lag is what makes it a report from the world rather than a copy of
the command — and it is the first thing in this project that lets a brain represent "keep going
the way I was going".

**#1 alone was not expected to move `Seeks`.** Knowing food is near makes chemotaxis
representable, but moving still costs five times upkeep, so the thrift gradient should dominate
until eating pays — which needs #2.

## A limit found while measuring, not while designing

Making food heavy buys **nothing at all** above the temperature where the motion guardrail binds,
and I only found this because the first version of the test asserted the effect at `T = 20` and
failed.

The guardrail allows `d_max / substeps` of motion per sub-step. At `T = 20` with 16 sub-steps the
Brownian increment alone wants about 1.1 and the budget allows 0.31 — so every particle is
clamped to the same displacement and food is exactly as fast as life whatever its mobility says.

Measured RMS displacement of food relative to matter over 40 ticks:

| T | food / matter | clamped |
|---|---|---|
| 3 | **0.44** | rarely |
| 20 | **0.96** | > 50% of steps |

`sqrt(mu_food) = 0.39` is the thermal prediction and 0.44 is a little above it because core
repulsion is shared. The second row is the finding: a world in that regime is one where **the
integrator rather than the chemistry sets the dynamics**. The search already discards worlds that
clamp more than 60% of the time, and this is a concrete reason that filter earns its place. Both
rows are pinned as tests in `tests/senses.test.ts`.

## What is in the code now

| Change | Where | Rule |
|---|---|---|
| Brain reads a normalised food count, summed over brain and limbs | `world.ts` `think()` | R5.4 |
| Brain reads its own net displacement, two ticks lagged | `world.ts` `integrate()`, `lvx/lvy` | R5.5 |
| Brain reads each limb's within-quadrant angle | `world.ts` `think()` | R5.5 |
| Brain reads bond load, per limb and per body | `world.ts` `think()` | R5.5 |
| Food mobility `μ · 0.15`, thermal kick `sqrt(0.15)` | `world.ts` `integrateOnce` | R2.2b |
| Food capacity `120 → 300 × area`; wasted light counted | `params.ts`, `shine()` | R4.1 |
| Reproduction failures counted by cause | `bud()` | R7.7a |
| Ablation seam for brain inputs | `WorldOpts.blind` | — |

The random stream is unchanged by the mobility law: both thermal components are still drawn for
food whether or not it is heavy, so a seed is comparable across the change.

## Results

**Partial, and the partial result does not support the change.** Five of eight conditions at
20,000 ticks × 5 seeds:

| condition | fed | lasts (coasts) | seeks | order |
|---|---|---|---|---|
| everything on | 2.08±0.39 | 6.39±0.61 | 0.046±0.046 | 75.8±9.6 |
| − food count | 1.31±0.22 | 4.55±0.50 | 0.039±0.018 | 51.6±11.0 |
| − own motion | 1.16±0.23 | 4.76±0.40 | 0.085±0.026 | 61.8±16.0 |
| − own body | 1.57±0.29 | 5.05±0.77 | 0.037±0.030 | 60.6±10.1 |
| **− all new senses** | **2.47±0.52** | **7.24±0.60** | 0.076±0.039 | 67.8±18.7 |

Read it carefully, because the obvious reading is the wrong one. Removing *each* sense on its own
looks harmful, and removing *all* of them looks beneficial. Those two cannot both be effects of the
senses: ablations that are individually harmful and jointly helpful are not additive in any
direction, which is the signature of **seed-level noise dominating the comparison**. The largest
gap here is about one standard error.

So the honest statement is: **at five seeds the new senses have not demonstrated a benefit, and
the point estimate for having all of them is worse than for having none.** Not "the senses are
useless" — a world where nothing is selecting on an input has no reason to use it, and the whole
reason `Seeks` sits near zero is that movement costs five times upkeep. But the claim that these
inputs help is unsupported by the only measurement taken of it.

What that implies for the order of work: a learner has to be in the loop before perception can pay,
and `seeks` is the one column where anything moves at all. It is also a reminder that this world's
outcomes are heavy-tailed enough that five seeds buys very little — the v1 search used thirty as
its minimum for a reason.

One figure worth noting against v1: lifetime harvest `fed` is around 2.1 here against a v1 search
median of 0.067. That compares one hand-picked chemistry to the median of a quarter-million random
ones, so it says nothing about the change — the same error made once before in this project, noted
here so it is not made a third time.
