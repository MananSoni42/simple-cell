# The ladder

Nine rungs in seven tiers, measuring **intelligence**. This document exists because the ladder is
the project's definition of progress, and because the previous one was measuring the wrong thing
in a way that took a deliberate experiment to notice.

## What was wrong

The old ladder had six levels — Matter, Metabolism, Agency, Heredity, Association, Collective —
and five of the six are levels of biological *organisation*, not intelligence. **A bacterial mat
has heredity, association and collective structure, and knows nothing.**

Measured: a **blind** world, whose organisms had random weights and no learner, met **nine of the
thirteen** rungs at two thousand ticks.

| | Persists | Feeds | Lasts | Seeks | KeepsBody | BreedsTrue | LineageOut | Joins | Holds | Renews | MovesTog | Transmits | GrowsIn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| blind, no learner | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | 0.5 | 0.5 | **✓** | 0.5 | 0.5 |

What hid this for so long is that **levels are conjunctions**: `Feeds` and `Lasts` fail at level 1,
so the reported level stays 0 while nine rungs above it pass unremarked. The v1 search could
truthfully report "nothing reached level 2" while most of the ladder was being cleared for free.

## The principle

> A rung is passed when behaviour exploits a specific kind of information, in a way that **a null
> destroying exactly that information does not reproduce** — and the null has to be computable
> inside the run.

Every tier needs strictly more than the one below: current input, then context-dependence, then
adaptation within a life, then accumulation across lives, then other organisms' information, then
acting as a collective.

## The rungs

| Tier | Rung | What it takes | Null |
|---|---|---|---|
| **0 Viable** | Persists | anything alive, and staying that way | — |
| | Feeds | the typical life ate more than it was given | its own endowment |
| | Lasts | 2,000 ticks *and* twice what coasting on the endowment allows | both, so neither direction of the metabolism dial buys it |
| **1 Reactive** | **Taxis** | commanded heading aligned with the food gradient | the same organism's gradients, shuffled in time |
| **2 Discriminative** | **Lingers** | commanded *turning rate* rises where the food count is high | the same counts, shuffled in time |
| **3 Adaptive** | **Improves** | converts encounters into meals ≥25% better late in life than early | log ratio zero under no trend |
| **4 Cumulative** | **Lineage improves** | among organisms alive *at the same moment*, later generations forage better | shuffled generation labels |
| **5 Social** | **Follows signal** | aligned with the part of the signal gradient orthogonal to the food gradient | the same gradients, shuffled in time |
| **6 Collective** | **Moves together** | a held structure of order ≥3 covering ground 1.5× faster than a solitary organism | solitary organisms in the same world |

## The three rules, and the organism behind each

Each of these is not a design preference. Each is a specific trivial organism that defeated a
version of a rung, and the rule is what stopped it.

**1. Commanded motion, never realised motion.** A crowded food patch physically jostles whatever is
inside it, and a well-fed organism can afford to move more — both show up as "behaviour correlated
with food" in realised movement. A brain's *command* cannot be jostled and does not depend on what
it can afford. This is why `Lingers` measures commanded turning and not speed: speed conditioned on
food is confounded twice over, and both confounds are contemporaneous, so no lagged null catches
them.

**2. Time-shuffled conditioners, never rotation.** Rotating the food direction by 90° looks like a
perfect null — same magnitudes, no information. It is beaten by **"always swim north" in a world
whose food is to the north**, which scores a near-perfect aligned-minus-rotated difference while
using no information whatever. Pairing this tick's command with a gradient the same organism saw at
a random *earlier* time gives that organism nothing, because its performance never depended on the
pairing.

**3. Efficiency, never throughput.** An organism that merely **grows** gains limbs, so it harvests
more with nothing learned; one that **drifts into a patch** and stays harvests more because of
where it is. Both buy more *encounters*. Only skill improves the *conversion* of encounters into
meals, so every learning rung is meals per unit of food exposure.

## Two failures in the opposite direction

A null can also be too **weak**, and that is just as fatal — it makes a rung unreachable rather
than lenient.

**The shuffle has to reach far enough back.** The first version drew its "random earlier tick" from
a ring of the last sixteen. Every conditioner here is autocorrelated over much longer — a food
gradient turns on a scale of tens of ticks, a patch is hundreds across — so the shuffled gradient
was nearly the *same* gradient, the null scored almost as well as the real pairing, and a synthetic
organism following the gradient **perfectly** scored 0.155 where it should have scored near 1. It is
now a **reservoir sample of the whole life** (Vitter's R), which gives a uniform draw from a history
whose length is not known in advance — and a life's length never is.

**A sign test on "ratio > 1" is degenerate.** `Improves` began as the fraction of organisms whose
late-life conversion beat their early-life conversion. An organism whose conversion is exactly flat
— which is precisely what growth produces, since more limbs raise meals and exposure together —
has a ratio of exactly 1, and whether `> 1` fires is then decided by floating-point noise. It
counted all four synthetic growers as improving. It is now a paired statistic over **log** ratios,
which is zero under no change.

## Significance and effect size, always both

The first seeking rung reported **z = 133** for an alignment of about 0.3. Pooled over hundreds of
lives, any consistent bias clears a z-test: that establishes an effect is not exactly zero and says
nothing about whether it is worth having. Every rung takes the minimum of the two — real (z ≥ 3)
*and* worth having (a stated effect size).

## Where it stands

At six thousand ticks, thirty seeds, four conditions:

| condition | Persists | Feeds | Lasts | Taxis | Lingers | Improves | LineageImp | Signal | MovesTog |
|---|---|---|---|---|---|---|---|---|---|
| blind, no learner | 1.00 | 0.33 | 0.50 | 0 | 0 | 0 | 0 | 0 | 0 |
| sighted, no learner | 1.00 | 0.67 | 0.50 | 0 | 0 | 0 | 0 | 0 | 0 |
| sighted, offline learner | 1.00 | 0.50 | 0.50 | 0 | 0 | 0 | 0 | 0 | 0 |
| sighted, online learner | 1.00 | 0.17 | 0.50 | 0 | 0 | 0 | 0 | 0 | 0.17 |

**Nothing climbs past tier 0.** That is the intended state: the rungs are claims about capabilities
nothing in this world has yet demonstrated. The continuous score still provides a gradient for a
search — ratios run 0.0 to 0.43 — and it already carries signal in the right direction, with
`Lineage improves` at 0.04 for a blind world against 0.32 with an offline learner, and `Moves
together` 0.14 against 0.43.

Two honest readings of that table. `Taxis` is marginally *higher* in the blind condition, which is
not a flaw: "blind" blinds only the **new** senses, and the food-pull vector input remains, so
taxis was never expected to differ. And `Follows signal` sits at 0.01 everywhere, which may mean
the rung is unreachable rather than hard — signalling may need to be made useful before anything
can be measured following it.

## Known gaps

**There is no memory rung, and there cannot be one yet.** A "remembering" tier was designed and
dropped: the brain is a pure feedforward linear map with no internal state, so identical inputs
give identical outputs by construction. Its only memory is the velocity *input*, which makes memory
indistinguishable from reactivity to one more input — measurable only by ablation, which cannot run
inside a live world. **A recurrent brain is the prerequisite**, and that is a world change, not a
metric change.

**Thrift was dropped as mechanically free.** `pay()` caps at available energy, so a starving
organism physically cannot move much. Low reserve → low effort needs no brain at all.

**Division of labour was dropped pending a better design.** Random brains already behave
differently from one another, so differentiation within a structure is not evidence of roles. A real
test needs a before/after-joining comparison with anti-correlated changes among members.
