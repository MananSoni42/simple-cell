# Learning — research and plan

How organisms might come to be good at living here. Nothing in this document is built yet.

Companion docs: [RULES.md](RULES.md) (the world), [PLAN.md](PLAN.md) (backlog), [BENCH.md](BENCH.md).

---

## 1. Where we actually are

**Something already learns.** The world has heritable variation (budding copies a parent's weights
with Gaussian noise), and it has differential reproduction (budding needs a reserve of `E_repro`
= 60, which an organism only reaches by actually eating). That is natural selection, running now.
Measured: lineages reach generation 4–5, and lineages compete and die out.

What is missing is three different things, and they are worth keeping apart:

1. **Lifetime learning.** Nothing an organism experiences changes it. A brain is fixed from birth.
2. **Selection pressure strong enough to matter.** Spawns arrive on a timer with *fresh random*
   weights, so every generation is diluted by newcomers who inherited nothing.
3. **Instruments.** We cannot currently answer "are they getting better?" — there is no
   per-organism record of energy harvested, distance travelled, or food found.

**The honest first experiment is therefore not an algorithm at all**: turn off random spawning,
let only budding introduce organisms, and see whether anything improves. If plain selection moves
nothing, a cleverer learner is unlikely to rescue it, and we would want to know that first.

### What a genome is today

| | |
|---|---|
| Brain | 29 inputs → 10 outputs, **linear**, `tanh` on the output. 290 weights |
| Limb neuron | 8 inputs → 1 output, linear, `tanh`. 8 weights |
| Total | **298 numbers**, and nothing else is inherited |
| Mutation | Gaussian noise, σ = `repro_mut` (0.05), applied to every weight |

Two consequences worth naming. There is **no hidden layer and no recurrence**, so the policy is a
linear map of the current instant: it cannot represent "I was heading somewhere", "I have been
hungry for a while", or any XOR-shaped decision. And 298 dimensions is *small* — small enough that
plain evolution strategies work well, and far too small to need deep-learning machinery.

**A concrete target to beat.** Measured earlier: compounds of two or more organisms form readily
but almost never last, the best being an order-2 pair holding **430 ticks**, because organisms with
random brains wander off and tear their own bonds apart. Staying together is a behaviour nothing
is selecting for. "Does any learner hold a compound longer than 430 ticks?" is a sharp,
pre-registered first question.

---

## 2. The three constraints that filter every candidate

**There are no episodes.** Organisms are born and die continuously; there is no reset, no trial
boundary, no terminal state. This is the big one. Most textbook RL and most generational EA loops
assume episodes. Two ways round it, and the choice shapes everything:

- *Accept it*: use algorithms that are natively continual — steady-state selection, evolution
  strategies keyed on death, TD(λ), Hebbian plasticity. **An organism's death is the natural
  "episode end"**, and its lifetime is the episode.
- *Impose it*: add a batch mode that runs N short worlds from a fixed seed, scores them, and
  iterates. This makes every algorithm available and makes results far cleaner, at the cost of
  no longer being one continuous world. Worth building as a separate **experiment runner**, not
  as a mode of the live world.

**Determinism is a project value.** A world is a pure function of its seed, and the test suite
pins that. Any learner must draw from the world's seeded stream. Anything that cannot — an LLM
most obviously — must record its outputs into the run file so a run stays replayable.

**Speed.** ~600 ticks/s at scale 8. A per-tick learning rule over 298 weights is free. An LLM call
is ~1 s, which is **about a million times slower than a tick**. That single ratio decides what the
LLM options can and cannot be.

---

## 3. The catalogue

Fit is judged on: does it work without episodes, does it suit 298 parameters, and does it need an
objective we would have to invent?

### A. Evolution of weights

| | Approach | Fit | Notes |
|---|---|---|---|
| A0 | **Baseline — random spawns, mutation on budding** *(current)* | — | The control. Keep it available for ever; every claim below is comparative |
| A1 | **Steady-state GA** — completed lives enter a breeding pool; new organisms are drawn from it by tournament, crossed over and mutated | **best** | No generations, no episodes, reuses budding wholesale. The smallest change that creates real selection: replace "spawn with random weights" with "spawn from the pool" |
| A2 | **Evolution strategies (OpenAI-ES)** — keep a mean weight vector and σ; each spawn is a mirrored sample; each death reports fitness; update the mean by rank-normalised reward | **best** | Spawn = sample, death = evaluation. Gradient-free, famously robust at this dimensionality, ~20 lines. Mirrored sampling halves the variance |
| A3 | **CMA-ES / sep-CMA** | good | Adapts a covariance, so it finds correlations between weights. 290² covariance is affordable; the diagonal variant is cheaper and usually enough |
| A4 | **Cross-entropy method** | good | ES's simpler cousin: keep the top k%, refit a Gaussian. Almost too easy to skip as a second baseline |
| A5 | **MAP-Elites / novelty search** — archive by *behaviour*, not fitness; select to fill the archive | **best fit to the project's point** | The quality-diversity family is the one built for open-ended worlds. It also dodges the objective problem: you reward being *different*, not being good. Needs a behaviour descriptor (see §5) |
| A6 | **Lexicase selection** — select on randomly ordered individual trials ("survived a famine", "fed in a patch world") | good | Maintains diversity without an archive; cheap |
| A7 | **Crossover operators** — uniform, one-point, or **per-socket block swap** | — | Per-socket is suggestive here: swap whole limb-weight blocks between parents, so a "limb design" is a unit of inheritance |
| A8 | **Self-adaptive mutation** — σ becomes a gene and evolves | good | Removes a hyper-parameter by letting the world tune it. Classic ES trick |

### B. Evolution of structure

| | Approach | Fit | Notes |
|---|---|---|---|
| B1 | **NEAT** proper — node and connection genes, innovation numbers, speciation | medium | The real thing, and the biggest change on this page: the brain stops being a matrix and becomes a graph. Speciation is not optional — without it structural mutations are out-competed before they can pay off |
| B2 | **NEAT-lite** — fixed inputs and outputs, evolve a sparse mask plus hidden nodes by split-mutation | good | Most of NEAT's benefit for a fraction of the work, and it fixes the "no hidden layer" ceiling |
| B3 | **HyperNEAT / CPPN** — generate weights from a function of input and output *coordinates* | interesting | Unusually apt here, because the inputs have real geometry: four sockets at four quadrant angles. A CPPN over angle would give genuinely spatial brains, and would generalise across body plans |
| B4 | **Weight-agnostic networks** — evolve topology with one shared weight | interesting | Tests whether structure alone can carry behaviour. Cheap, and a good diagnostic |

### C. Learning within a lifetime

| | Approach | Fit | Notes |
|---|---|---|---|
| C1 | **Evolved Hebbian plasticity (ABCD rule)** — each synapse carries evolved coefficients; weights change during life; the *rule* is inherited, not the weights | **best** | Local, cheap, needs no reward and no episodes. The canonical ALife answer, and it fits the project's "laws vs phenotype" split exactly: the rule is a law, its coefficients are genome |
| C2 | **Reward-modulated Hebbian** — same, gated by a reward signal | **best, and the most aligned** | The reward can be the organism's own **energy delta**, which is *physics we already simulate*, not an objective we invented. This is the one option that adds learning without re-encoding a goal |
| C3 | **TD(λ) actor–critic** — add a linear value head (29 → 1), learn online with eligibility traces | good | TD(λ) was designed for exactly this: continuing tasks with no episode boundary. Reward = energy gained per tick. The most "real RL" option that does not need episodes |
| C4 | **REINFORCE with a baseline** — Gaussian policy on the move force, log-prob gradients over a life | medium | Works, but the variance over a 1000-tick life is brutal and it wants episodes |
| C5 | **PPO / A2C with a shared policy** | medium | Standard and strong, but note the design fork: a *shared* policy means organisms stop being individuals, which changes what the world is. Worth doing once as a yardstick, flagged clearly |
| C6 | **DQN** — discretise actions (8 directions × feed choice), replay buffer | poor–medium | Very vanilla, but discretising a continuous force is a loss, and replay fits awkwardly with per-organism lifetimes |
| C7 | **Within-life bandit** — each organism holds a few candidate weight vectors and bandit-selects among them | interesting | Dirt cheap, needs no gradients, and gives genuine within-life adaptation |
| C8 | **Baldwin-effect experiment** — run C1/C2 *with* evolution and watch whether learned behaviour becomes innate | — | Not an algorithm but an experiment, and one of the most interesting results this world could produce. §6 lists the metric that would detect it |

### D. LLMs

The ratio that governs this whole family: **a tick is ~1 ms, an LLM call is ~1 s**. Anything the
LLM does must happen at generational cadence, not per decision.

| | Approach | Fit | Notes |
|---|---|---|---|
| D1 | **LLM writes each organism's policy as code**, reviews outcomes periodically, rewrites | good, with real engineering cost | This is FunSearch / Eureka applied to organisms. Feasible *because* it runs per cohort, not per tick. Costs: generated code must be sandboxed (a tiny expression DSL is far safer than arbitrary JS, and probably expressive enough); every generation must be recorded in the run file or runs stop being replayable; and caching by prompt hash is essential |
| D2 | **LLM as the network, called per decision** | **infeasible as stated** | Six orders of magnitude too slow: one organism at 600 ticks/s would need 600 calls a second. The honest version is D3 |
| D3 | **LLM as a slow meta-controller** — every N hundred ticks it reads an organism's recent history and sets its weights, or picks among a few strategies the fast linear net then executes | good | Keeps the LLM in the loop at a cadence it can actually meet. "LLM as the network" in the only form the clock allows |
| D4 | **LLM as the mutation operator** — instead of Gaussian noise, it proposes edits given a summary of the parent's behaviour | interesting | A real and current technique (LLM-guided evolution). Cheap to try once A1 exists, since it only replaces one function |
| D5 | **LLM as the behaviour describer** — it reads traces and writes the behaviour descriptor for MAP-Elites | interesting | Solves the genuinely hard part of quality-diversity: choosing what "different" means |
| D6 | **LLM as the experimenter** — it reads run summaries and proposes the next world to try | **highest value per unit work** | A different loop entirely: it designs *worlds*, not organisms. We already generate written observations from every run, so most of the input exists. This is the one that could run overnight and come back with something we would not have thought to try |

### E. Controls and odds and ends

| | Approach | Why |
|---|---|---|
| E1 | **Random search** — sample fresh genomes, keep the best found | The control that most published results quietly fail to beat |
| E2 | **Hill climbing** on one genome | Second control |
| E3 | **Frozen champion** — take the best genome found and stop learning | Separates "learning works" from "this genome is good" |
| E4 | **Cultural transmission** — copy a successful neighbour's weights on contact, with noise | Horizontal rather than vertical inheritance; interesting in a world with bonds |

---

## 4. When learning happens, and the hyper-parameters

The useful axis is **when the signal is collected and when it is applied**. In a world without
episodes, four natural triggers exist:

| Trigger | Available to | Can it be continuous? |
|---|---|---|
| **Every tick** | Hebbian (C1), reward-modulated (C2), TD(λ) (C3), bandit (C7) | Yes — these are the natively continual ones |
| **On birth** | ES sampling (A2), GA parent selection (A1), LLM meta-control (D3) | Yes, event-driven |
| **On death** — fitness is known exactly, and nothing else needs to pause | GA pool insert (A1), ES evaluation (A2), CEM (A4), MAP-Elites (A5) | Yes. **This is the right default "review" point for this world** |
| **Periodic batch** — every N deaths or N ticks | ES distribution update, NEAT generation, LLM review (D1, D4, D6) | Semi: the world runs continuously, the learner updates in steps |

### Hyper-parameters worth exposing

**Shared**
- `learner`: which algorithm (including `none`, the control)
- `warmup_ticks`: learn nothing before this, so startup transients do not poison the first updates
- `spawn_source`: random / pool / sampled — *this is the most important single knob*, because random spawns dilute selection
- `fitness`: which scalar (§5), and whether it is rank-normalised
- `review_every`: deaths or ticks between batch updates
- `seeded`: learner draws from the world RNG (default on; off only for LLM paths)

**Selection (A1, A4, A5, A6)**
- pool size and maximum age of a pool entry (stale fitness from an older regime is misleading)
- tournament size, elitism count, truncation %
- crossover rate and operator (uniform / one-point / per-socket)
- mutation σ, per-gene rate, self-adaptive σ on/off

**Evolution strategies (A2, A3)**
- λ (samples per update), α (step size), σ (exploration), mirrored sampling on/off
- rank normalisation on/off, weight decay
- σ schedule: fixed, annealed, or self-adapted

**Plasticity and RL (C1–C3, C7)**
- η learning rate, weight clip, decay toward the inherited value
- eligibility trace λ, discount γ
- reward definition and baseline window (what counts as "better than usual")
- whether plasticity is reset at birth or inherited in its learned state (**the Baldwin fork**)

**Structure (B1, B2)**
- add-node and add-connection rates, enable/disable rate
- speciation threshold, compatibility coefficients, stagnation cutoff

**LLM (D1, D3, D4, D6)**
- review interval (deaths, ticks, or "when a metric stalls")
- context budget: how much history to show, and summarised how
- candidates per review and the acceptance rule — **a new policy should have to beat the incumbent
  in a paired trial before replacing it**, otherwise the LLM will cheerfully regress
- temperature, cache key, cost ceiling per run
- the sandbox: DSL or locked-down evaluator, with a time and operation budget

---

## 5. Fitness functions, and the problem with having one

**The tension to be honest about.** This project's whole principle is that nothing we want is
written down anywhere. The moment we pick a fitness function, we have written it down. A learner
optimising "energy harvested" produces organisms good at harvesting energy, which is not the same
as discovering what this world can support.

So the default should be **implicit fitness — offspring count** — because that is not a scalar we
invented; it is what the world already does. Explicit scalars are a concession we make only where
an algorithm demands one (ES needs a number), and they should be reported as a choice, not a
measurement. Quality-diversity (A5) is attractive precisely because it needs no objective.

### Candidate scalars (all known exactly at death)

*Survival and reproduction*
1. Lifespan in ticks
2. Offspring count — the implicit default
3. Descendants alive k ticks later (inclusive fitness)
4. Lineage survival time
5. Did it reproduce at all (a binary, for lexicase)

*Energy*
6. Lifetime energy harvested **(needs a new counter)**
7. Net energy: harvested − spent
8. Energy harvested per tick alive — the cleanest "is it good at living"
9. Peak reserve reached
10. Mean reserve over life (robustness rather than one lucky meal)
11. Fraction of life spent above a starvation threshold
12. Energy harvested per unit distance moved (foraging efficiency)
13. Energy spent on movement as a fraction of energy gained (waste)

*Body*
14. Limb-ticks: limbs held × ticks, so losing limbs costs
15. Limbs regrown after loss (healing competence)
16. Energy delivered to limbs by the brain (regulatory competence)
17. Time spent with a full complement of four limbs

*Togetherness* — the behaviours we most want and least understand
18. Ticks spent in a compound of 2+
19. Maximum compound order participated in
20. Bonds formed, and bond-ticks held
21. Longest single bond duration

*Movement and search*
22. Distinct area visited (coverage)
23. Mean speed, and variance of speed
24. Food encounters per tick versus a random-walk control on the same world
25. Time from birth to first meal

*Information*
26. Signal energy spent per unit energy gained
27. Mutual information between what a limb says and what its brain does next

*Composites*
28. Rank-normalised sum of several of the above (avoids scale mismatch)
29. Lexicase over 5–20 of them as individual trials (A6)
30. Pareto front over 2–3 (never collapse to weights without saying so)

### Behaviour descriptors (for MAP-Elites / novelty, A5 and D5)

Two or three axes, binned into a grid; the archive keeps the best in each cell:
mean speed × foraging efficiency; ticks-in-compound × area covered; energy spent on signalling ×
limbs retained; time near walls × time in the open. The point is that cells are *different*, not
better.

---

## 6. Metrics to track

**Population progress** (the honest answers to "is anything improving?")
- Mean and max lifespan, as a trailing window *(exists)*
- Offspring per organism, and the fraction that ever reproduce
- **Energy harvested per organism per tick** — the single best progress signal *(needs a counter)*
- Food encounters per tick against a random-walk control on the identical world
- Share of deaths by starvation versus other causes
- Time from birth to first meal
- Generation depth over time *(exists)*
- n-order compound counts and survival *(exists)*

**Diversity** — without this, "improvement" is often just collapse onto one strategy
- Mean pairwise genome distance
- Lineage count and Shannon diversity of lineage shares *(count exists)*
- Behaviour-space coverage (archive fill %)
- Species count, if NEAT

**Learning diagnostics**
- Weight change per tick — is plasticity doing anything at all?
- **Within-life improvement**: energy rate in the last third of life versus the first third. This
  is the cleanest test that *lifetime* learning works, as distinct from selection
- **Baldwin test**: innate performance at birth rising over generations while the plastic gain
  shrinks — learned behaviour becoming innate
- Correlation between the action taken and the reward that followed (credit-assignment sanity)
- Learning-rate sensitivity curve: does the result survive a 3× change in η?
- Fraction of ES samples that improve on the mean

**Reward hacking to watch for explicitly**
- Maximising lifespan by never moving (cheap immortality)
- Maximising offspring by budding many tiny, immediately-dying children
- Maximising "energy harvested" by sitting in a food patch and ignoring everything else
- Maximising bond-ticks by bonding to one inert particle for ever

---

## 7. How a result gets believed

Worth settling before any of it is built, because it is what separates a finding from a story.

- **Paired runs on identical seeds**, learner on versus off. Never compare across worlds.
- **Medians over ≥10 seeds with spread**, never a single run. This world is high-variance: the same
  seed with a different food regime already swings organism counts from 1 to 12.
- **Three controls**: random spawns (A0), random search (E1), frozen champion (E3).
- **Pre-register the metric.** With 30 candidate scalars, something will always have improved.
- **Ablate**: turn the learner off mid-run and see whether the gain persists (selection) or
  evaporates (plasticity).
- Report the **cost**: ticks/s with the learner on, and for LLM paths, calls and money per run.

---

## 8. Infrastructure needed whatever we choose

Roughly in the order it would be built, and all of it useful even for the baseline:

1. **Per-organism lifetime counters** — energy harvested and spent, distance moved, food eaten,
   ticks in a compound, peak and mean reserve, limb-ticks. Nothing beyond lifespan and offspring
   exists today, so no fitness is currently computable. **This is the real first task.**
2. **A completed-lives buffer** — genome, fitness, behaviour descriptor, lineage, death cause.
   Bounded, like the run recorder.
3. **A `Learner` interface** with four hooks: `genomeForSpawn()`, `onDeath(record)`,
   `onTick(organism)` (optional, for plasticity), `review()` (optional, periodic). Every algorithm
   above is one implementation of this, and `none` is the control.
4. **`spawn_source`** — random / pool / sampled. The smallest change with the largest effect.
5. **A Learning tab** on the setup screen: algorithm chips, the hyper-parameters for the chosen
   one, fitness selector, review cadence, and the control toggle. Carried in the config and the
   run file, so a run records how it learned.
6. **An experiment runner** — headless, N seeds × M variants, paired, writing a comparison table.
   Reuses the existing run recorder and observations engine.
7. Only for LLM paths: a sandboxed policy evaluator, a prompt/response cache, and a transcript in
   the run file.

---

## 9. Suggested order

1. **Instrument first** (§8.1–8.2). Without counters there is no fitness and no progress metric.
2. **Turn off random spawning** (§8.4) and measure. Does the selection already present do
   anything? This is a measurement, not an algorithm, and it decides how much the rest is needed.
3. **Steady-state GA (A1)** — smallest real learner, reuses budding.
4. **ES (A2)** alongside it, with CEM (A4) and random search (E1) as controls. Four algorithms, one
   interface, directly comparable.
5. **Reward-modulated Hebbian (C2)** — the first lifetime learning, and the only option that
   invents no objective. Run the Baldwin test.
6. **MAP-Elites (A5)** — the best fit to what this project is for.
7. **A hidden layer, or NEAT-lite (B2)** — once the linear brain is provably the ceiling.
8. **TD(λ) (C3)** as the proper-RL yardstick.
9. **LLM paths**, in this order: D6 (experimenter, cheapest and most valuable), D4 (mutation
   operator), D1/D3 (policies).

---

## 10. Questions I would want settled first

1. **Keep one continuous world, or add a batch experiment runner?** Continuous is truer to the
   project; batch makes every algorithm available and results far cleaner. I would build both, but
   which comes first changes the order above.
2. **Implicit fitness (offspring) or an explicit scalar?** Implicit is philosophically consistent;
   explicit is what ES and GA need. My suggestion: implicit by default, explicit per-algorithm and
   clearly labelled.
3. **Should random spawning stay on?** It dilutes selection badly, but it is also what keeps a
   dying world from emptying. Perhaps a slider rather than a switch.
4. **Is a shared policy acceptable as a yardstick?** It would let us run PPO and get a strong
   number, at the cost of organisms no longer being individuals.
5. **Fix the linear brain now or later?** Everything above is limited by a policy that cannot
   represent memory. Adding one hidden layer is a two-line change and would raise the ceiling for
   every algorithm here.
