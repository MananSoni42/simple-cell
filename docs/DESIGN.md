# Cell Life — Design Doc

A toy cellular world with continuous space and discrete time, built to see whether
membranes, metabolism, and self-repair can fall out of a handful of symmetric
physical laws plus an energy flux.

---

## 1. Goal and non-goals

**Goal.** A simple, elegant model that generates complexity it was not told about.
Target phenomena, in order of ambition:

1. **Membranes.** Closed or extended chains of particles with a preferred spacing,
   self-assembling from a disordered soup.
2. **Self-sustaining structures.** A membrane or cluster that keeps itself intact
   while paying a continuous energy cost, by capturing food from its environment.
3. **Healing.** An organism whose brain routes surplus energy to the limbs nearest
   starvation, keeping a body alive longer than an even-split policy would; and
   re-growth, where an emptied socket recaptures a free particle from the soup.
4. **Phases.** The same matrix producing crystal / membrane / gas regimes as a
   single temperature knob moves.

**Non-goals for now.** Learning, evolution, mutation, reproduction, genomes. The
brain is hand-wired. We are building the world, not its inhabitants' minds.

**Guiding principle.** Three tiers, and nothing may cross them:

| Tier | What lives here | Who sets it |
|---|---|---|
| **Laws** | Force law, Brownian motion, metabolic cost, food influx, conservation | Universal constants, same for every particle, hand-set |
| **Initial conditions** | The interaction matrix, temperature, food rate, particle counts | Tweakable in the UI — this is the "chemistry" you play with |
| **Phenotype** | Brain weights, which sockets are filled, body state | Emerges at runtime; hand-wired for now, evolvable later |

If a behaviour we want has to be written into tier 1, it is encoded, not emergent,
and we have failed. Example of the rule working: "eating" is not a law. It is what
happens when the matrix gives a particle type a positive entry against Food.

---

## 2. World

- **Space.** 2D continuous, `1000 × 1000` units, **toroidal** (wraps on both axes).
  A torus has no walls, so no wall artifacts, no boundary conditions, no corners
  where things pile up. Everything is translation-invariant.
- **Time.** Discrete ticks, `dt = 1`. One tick is the unit of everything.
- **Dynamics regime.** **Overdamped** — velocity is proportional to force, there is
  no inertia and no stored momentum:

  ```
  x(t+1) = x(t) + μ·F(t)·dt  +  sqrt(2·μ·T·dt)·N(0,1)
  ```

  This is the correct regime for cell-scale life (low Reynolds number: viscosity
  dominates, a bacterium that stops swimming stops within an atom's width). It is
  also far more numerically stable than inertial physics, and it has exactly two
  parameters: mobility `μ` and temperature `T`.

### Why temperature is mandatory

The matrix is **symmetric** (`A[i][j] = A[j][i]`), by choice. That makes the force
field conservative: `F = -∇U` for a scalar potential `U`. An overdamped
conservative system is a *gradient descent* on `U` — it can only ever relax. Left
alone it will build structure (membranes, micelles, crystals: these are local
minima of `U`) and then **freeze**. That is a feature, not a bug — symmetric forces
are what make real lipid bilayers assemble — but it means structure alone is
static. Two things restore time's arrow:

- **Temperature `T`** — Brownian jitter. Lets structures anneal, melt, reform, and
  escape jammed configurations. `T` is the single most interesting slider in the
  world: at `T→0` you get crystals, mid `T` gives fluid membranes, high `T` gives gas.
- **Energy flux** — food rains in, metabolism burns it off to nothing. This is the
  open-system drive. It is the *only* source of persistent directed motion, and it
  is why organisms must act rather than settle.

**Consequence for the roadmap:** the food economy is not a feature bolted onto the
physics, it is the engine of all dynamics. It lands in Layer 1, immediately.

---

## 3. Particles

Everything in the world is a particle. One flat array, one struct.

**Intrinsic types** `P1 P2 P3 P4` — matter. Conserved: a fixed pool is created at
world init and never created or destroyed again. Can be free in the soup, or bound
into an organism socket.

**Brain type** `B` — also conserved, also a fixed pool. A free brain is an unbound
organism-of-one waiting to condense limbs.

**Food** `F` — carries `E_food` energy. Created by the sun (influx), destroyed on
consumption. Not conserved: this is the open boundary.

**Signal** — *not* a particle. A diffusing scalar field (§6). A signal particle
would need the same physics as matter while being massless, chemically inert, and
needing to decay — three exceptions to the laws. A field is cheaper, gives smooth
gradients for free, and renders beautifully.

```ts
type Particle = {
  x, y: number          // position (wrapped)
  type: 0..5            // P1 P2 P3 P4 | B | F
  energy: number        // food reserve; Food particles carry E_food
  owner: number         // -1 if free, else organism id
  socket: number        // 0..3 if bound, else -1
  theta, omega: number  // rod angle & angular velocity (bound limbs only)
  sig: number           // last outward signal output
}
```

---

## 4. Force law

Two terms, deliberately separated by role.

**Term 1 — universal hard core.** Volume exclusion. Same for every pair, not in
the matrix, not tweakable per type. Without this, any mutually attracting pair
collapses to a single point and the matrix can only ever produce dust.

**Term 2 — matrix band.** The matrix governs *only* the mid-range, and nothing
reaches past the cutoff `r_c`.

With `β = r_0/r_c` (core fraction, default `0.1`) and normalized distance
`u = r / r_c`:

```
u < β        →  F(u) = K_core · (u/β − 1)             // always repulsive, ∈ [−K_core, 0)
β ≤ u ≤ 1    →  F(u) = A[i][j] · (1 − |2u − 1 − β| / (1 − β))   // tent, peak at u=(1+β)/2
u > 1        →  F(u) = 0
```

Positive `F` = attraction, negative = repulsion. Force is along the separation
vector, uses the **wrapped** (minimum-image) displacement.

This is the Particle-Life / Clusters force law, and it earns its place:

- Piecewise linear → cheap, and its potential `U(r)` is piecewise quadratic and
  analytic, which gives us the strongest test in the suite (§11, monotone descent).
- Compact support → spatial hashing is exact, not an approximation.
- The tent peak is where the pull is strongest, but for `A > 0` the potential
  minimum is at contact (`r_0`). Spacing and membrane-like structure therefore come
  from *mixed signs* (types that attract each other and repel their own kind), not
  from a built-in lattice constant. Measured: `A = +1` condenses into dense droplets
  below `T ≈ 50` and melts above it.

### The matrix

**5 × 5, symmetric, over `{P1, P2, P3, P4, Food}`** → 15 free values in `[-1, 1]`.
This is the world's chemistry and the main thing you tune.

- Symmetric by decision (Newton's third law; also makes `U` exist).
- `Food` gets a row, and this is the quiet payoff: a type with `A[i][Food] > 0` is
  a **mouth**; a type with `A[i][Food] < 0` is a **wall** that food cannot cross.
  Digestion, membranes that hold a food gradient, and selective permeability all
  become consequences of chemistry rather than special-cased code.
- Brain `B` does not get a matrix row in v1 — it interacts via hard core only, so
  bodies do not chemically clump. One line to relax later.
- Signal is a field, so it has no row.

---

## 5. Energy economy

Energy is a scalar, and the ledger must close exactly (§11). Units: one Food
particle = `E_food = 10`.

**In — the sun.** Food particles appear at rate `R_food` per tick, inside a small
number `N_patch` of slowly drifting circular patches.

> **This is the one assumption to get right.** With *uniform* food rain, standing
> still is an optimal strategy and nothing will ever move. Patchiness is what makes
> locomotion, gradient-following, and energy routing worth paying for. Patch radius
> and drift speed set the difficulty of the world.

**Uptake.** A particle within `r_0` of a Food particle absorbs it: food particle is
destroyed, its `E_food` is added to the absorber's reserve. Nothing says a particle
must seek food — whether it ever touches one is decided by the matrix.

**Out — the tolls.** Every tick, every particle pays, and spent energy leaves the
world as heat:

| Cost | Formula | Why |
|---|---|---|
| Upkeep | `c_up` per particle per tick | Existence is not free; sets a metabolic floor and a hard carrying capacity |
| Motion | `c_mv · μ · \|F_self\|²` on brain-driven force only | Work against drag. Passive drift is free (it's the fluid's doing), self-propulsion is not |
| Signal | `c_sig · \|out\|` | Talking costs. Keeps the signal field from saturating |

A particle whose reserve hits 0 is **starved** (see §8).

**The 10% toll and inward flow.** A bound limb absorbs food, keeps a fraction
`k_keep = 0.1` for its own reserve, and passes the rest **inward** to the brain in
the same tick. The brain accumulates, then redistributes (§7). Energy never
teleports: it moves one hop per tick along a rod.

---

## 6. Signal field

A scalar field on a coarse grid (`64 × 64`, toroidal, bilinear sample/deposit).
One channel in v1.

```
deposit:  field[cell(p)] += p.sig
step:     field ← (1−λ)·diffuse(field)       // 5-point stencil, then uniform decay
```

Every particle samples the field at its own position as a neuron input. That is the
whole of inter-particle communication: deposit, diffuse, decay, sample. Stigmergy —
organisms influence each other by writing to a shared medium, with no messaging code
and no notion of "nearby organism".

Renders as a color wash under the particles.

---

## 7. Organisms

**Body.** One brain particle `B` plus 4 sockets, one per quadrant, each holding a
rigid rod of length `L` with an intrinsic particle at its tip. Organisms are born
with 1–4 sockets filled and grow the rest from the soup. Quadrants are separated by
a small angular `gap`, so rods can never coincide; within its quadrant a rod is
free, and at the boundary it clamps.

**Rod angles are passive, not commanded.** Forces on the tip particle produce a
torque about the brain; the rod swings, with angular damping, clamped to its
quadrant:

```
τ = L · (F_tip ⟂ rod)
ω ← (1 − d_rot)·ω + μ_rot·τ
θ ← clamp(θ + ω·dt, quadrant limits)
```

This is the best decision in the design. Limbs **passively orient toward whatever
attracts them**, so an organism whose tip type likes Food reaches toward food without
a line of seeking logic. And because sibling tips feel each other (§4), **body shape
is an equilibrium of the matrix**: limbs with attracting tip types swing together and
rest against their shared gap boundary, limbs with repelling types splay to opposite
limits. Every such shape is a stable resting configuration, and none of them is
enumerated anywhere in the code. The brain only translates the body; the morphology
is chemistry.

The `gap` earns its keep twice: it stops rods from degenerating onto each other, and
it turns "two limbs attract" into a visibly distinct morphology rather than a
singularity.

**Movement.** The brain outputs a force vector applied to the brain particle. The
body translates as a unit (rods follow rigidly); the brain pays `c_mv`.

### Neuron model

Shared shape everywhere: `out = tanh(W · x + b)`.

**Limb neuron** (one per bound intrinsic particle), per tick:

```
x    = [ reserve/E_ref , signal_here , foodDensity_here , 1 ]
h    = tanh(W_limb · x)                  // W_limb: 2×4
sig  = h[0]        → deposited outward into the field
msg  = h[1]        → passed inward to the brain
```

**Brain**, per tick:

```
x = concat over 4 sockets of [ msg_i , onehot4(type_i) , alive_i ]   // 24 values
  ⧺ [ reserve/E_ref , signal_here , 1 ]                              // + 3
y = W_brain · x                                                       // 27 → 6
food fractions = softmax(y[0..3]) · releaseFraction
move force     = F_max · tanh(y[4..5])
```

The brain's accumulated reserve is split by the softmax and sent back out along the
rods. A limb already at capacity rejects surplus, which returns to the brain next
tick ("particles throw back excess food", as specified).

**Hand-wired v1 policy — "feed the hungriest".** Set `W_brain` so the food softmax
logits are `−β·msg_i` where the limb neuron is wired to make `msg` increase with
reserve. A limb close to starvation shouts, and gets the energy. This is the healing
behaviour, and because it is hand-wired we can measure it against a fixed
even-split control (§11). When evolution arrives later, this policy is the baseline
it has to beat.

---

## 8. Creation and destruction

**One mechanism, run in both directions.** No delete code, no special cases —
organisms *dissolve back into the soup* they were drawn from, and the same binding
rule that builds a body also repairs one.

**Spawn (v0 birth).** Every `T_spawn` ticks an organism appears whole at a random
position, its sockets filled from the free-particle pool. Simple and controllable,
which is what v0 wants.

**Condensation (the elegant version, deferred).** A free brain has 4 empty sockets;
each tick, any free intrinsic particle within `r_bind` of an empty socket's tip
position binds to it. Organisms assemble themselves from whatever drifted past, in
whatever order. The mechanism already exists in v0 as regeneration (below) — making
it the sole route to birth is a small change, once the world is stable.

**Dissolution (death).**

- **Limb starves** (`reserve ≤ 0`) → it unbinds, becomes a free particle again with
  a short `r_bind` refractory period. The organism limps on with 3 limbs.
- **Empty socket recaptures** → the same condensation rule refills it, from the
  soup, possibly with a different type. **This is regeneration, and it costs zero
  extra code** — it is birth running again on a body that already exists.
- **Brain starves** → the whole organism dissolves. All limbs unbind. The brain's
  residual reserve is emitted as `floor(reserve / E_food)` Food particles scattered
  nearby — a corpse is food, which is the hook for trophic levels later.

**What this gets us.** Matter is conserved by construction (nothing is ever
allocated or freed — `owner`/`socket` fields just change). Energy is open: sun in,
heat out. Scarcity of intrinsic particles creates competition for limbs with no
competition logic. And "healing" is not a behaviour we implemented; it is the
binding rule and the brain's routing policy, interacting.

---

## 9. Parameters

Everything in one object, one file, fully serializable. The UI edits this live.

```ts
// Laws — hand-set constants, not expected to be tuned during play
dt        = 1
mu        = 0.5     // mobility
r_c       = 40      // interaction cutoff
beta      = 0.1     // core fraction → r_0 = 4
K_core    = 3.0     // hard-core strength (must dominate max |A| = 1)
mu_rot    = 0.02    // rod angular mobility
d_rot     = 0.2     // rod angular damping
L_rod     = 12      // rod length
r_bind    = 6       // socket capture radius
E_food    = 10
E_ref     = 50      // reserve scale for neuron normalization
E_cap     = 100     // per-particle reserve capacity
c_up      = 0.02    // upkeep / particle / tick
c_mv      = 0.5
c_sig     = 0.01
k_keep    = 0.1     // limb keeps 10%, passes 90% inward
lambda    = 0.05    // signal decay
D_sig     = 0.2     // signal diffusion

// Initial conditions — the god panel
T         = 0.05    // temperature
A[5][5]   = ...     // symmetric chemistry matrix, the main dial
R_food    = 2.0     // food particles per tick
N_patch   = 5
r_patch   = 80
v_patch   = 0.2     // patch drift speed
n_intrinsic = 2000  // conserved matter pool
n_brain     = 30
seed        = 1     // deterministic
```

### Stability constraint

Overdamped Euler is stable while `μ·|F|_max·dt ≪ r_0`. With the numbers above,
`μ·K_core·dt = 1.5` against `r_0 = 4`. Comfortable. Raising `μ` or `K_core` without
lowering `dt` makes particles tunnel through each other — there is an assertion for
this in the test suite, not a comment.

---

## 10. Build order

Each layer ships with a falsifiable exit test. **No layer starts before the previous
one's test passes.** The point is that if a layer's test fails we know the
*mechanism* is wrong, not that some emergent soup is disappointing.

| L | Adds | Exit test |
|---|---|---|
| **0** | Particles, matrix, hard core, overdamped + Brownian motion, torus, spatial hash, renderer, matrix editor | A hand-tuned matrix produces a **membrane**: a mixed-sign matrix gives mean cluster size ≫ 1 with an RDF peak at a non-contact spacing. Raising `T` melts it; lowering `T` freezes it |
| **1** | Food particles, patches, uptake, upkeep, reserves, starvation of free particles | **Energy ledger closes to 1e-9.** Free-particle population reaches a steady state set by `R_food`, and scales linearly with it |
| **2** | Brain particles, sockets, scheduled spawn, rod physics, dissolution, socket capture | **Matter count by type is invariant** across 100k ticks of births and deaths; a 4-limb body loses limbs under starvation and **regains them** when free particles are available; a body with attracting tip types settles into parallel rods and one with repelling types into a cross — **from the matrix alone** |
| **3** | Limb neurons, signal field, brain, hand-wired feed-the-hungriest | **Healing beats the control**: median body-integrity over 10 seeds is strictly higher for feed-the-hungriest than for even-split, under patchy food |
| **4** | *(later)* Mutation, reproduction, selection | — |

---

## 11. Test strategy

Four kinds, strongest first. The deterministic seeded RNG is what makes all of this
possible: every test is reproducible, and "it looked right once" is never evidence.

### A. Invariants — the backbone

Run the full world for N ticks with random parameters and assert properties that
must hold *always*. These catch real bugs; eyeballing the canvas does not.

1. **Determinism.** Same seed, same params → bit-identical state hash after 10k
   ticks. Guards every other test.
2. **Matter conservation.** Count of each intrinsic type and of brains is exactly
   constant across births, deaths, bindings, dissolutions. Must survive 100k ticks.
3. **Energy ledger.** `Σ reserves + Σ food_in_world + total_burned == initial + total_injected`,
   to 1e-9, every tick. Any leak means an energy bug, which in a world like this
   silently invents perpetual motion.
4. **Force symmetry.** For every pair, `F(i→j) == −F(j→i)` exactly. Non-negotiable
   given a symmetric matrix.
5. **No net drift.** With `T = 0` and no brains, total displacement of the centre of
   mass is 0 (within float error). Internal forces cannot move the system.
6. **Monotone descent** — *the sharpest test we have.* With `T = 0`, no food, no
   brains, the potential energy `U = Σ_pairs U(r_ij)` must be **non-increasing**
   every single tick. This simultaneously verifies that the matrix is symmetric,
   that `F = −∇U`, that the integrator is correct, and that `dt` is small enough.
   If this test passes, the physics is right.
7. **No overlap.** `min pairwise distance > 0.5·r_0` after 10k ticks from any start.
   Catches hard-core being too weak and `dt` being too large (tunneling).
8. **Signal field non-negativity and boundedness.** Field stays in `[0, bound]`;
   with zero deposition it decays to `< ε` within a known number of ticks.
9. **Torus correctness.** Every position stays in `[0, size)`; wrapped displacement
   is never longer than `size/2`.

### B. Unit tests — the pieces

1. **Force law** matches hand-computed values at `u = 0, β/2, β, (1+β)/2, 1, 1.5`;
   is exactly 0 beyond cutoff; is strictly repulsive below `r_0` for *every* matrix
   entry including `A = +1`.
2. **Potential/force consistency.** Numerically differentiate `U(r)` and compare to
   `F(r)`; agree to 1e-6 across the whole range.
3. **Spatial hash** returns exactly the same neighbour set as O(n²) brute force,
   including across the wrap seam. This one has caught every spatial-hash bug ever
   written.
4. **Wrapped distance** against a reference implementation over random pairs.
5. **Softmax** sums to 1, is shift-invariant, no NaN on extreme logits.
6. **Rod kinematics.** `θ` never leaves its quadrant, under any torque, however
   absurd; tip position is always exactly `L` from the brain. And angular damping
   drives `ω → 0` under constant torque rather than oscillating — a body must be
   able to *settle* into a shape (§7), so an underdamped rod is a correctness bug,
   not an aesthetic one.
7. **Binding.** A free particle inside `r_bind` of an empty socket binds within one
   tick; one outside does not; two candidates never bind to the same socket; a
   particle never binds to two sockets.
8. **Starvation cascade.** Limb at `reserve = 0` unbinds this tick. Brain at
   `reserve = 0` dissolves the whole organism and emits the right number of food
   particles.
9. **Uptake.** Food inside `r_0` is consumed exactly once, by exactly one absorber,
   and the full `E_food` lands in that absorber's reserve.

### C. Phenomenology — the behaviours we actually want

Statistical, tolerance-based, seeded, and run over several seeds with a median.
These are the tests that say the *world* works, not just the code.

1. **Membranes form.** With the `membrane` preset, after 5k ticks: radial
   distribution function has a peak `> 2.0` at `r ≈ r_c(1+β)/2`, and mean cluster
   size `> 20`. Fails on a uniform gas and on a collapsed blob alike.
2. **Phase transition.** Sweep `T` over 8 values; mean cluster size must be
   **monotonically decreasing**. Confirms temperature does what we claim.
3. **Chemistry matters.** A zero matrix (`A = 0`) gives ideal-gas statistics:
   cluster size `≈ 1`, flat RDF. Structure must come from `A`, not from a bug in
   the hard core.
4. **Carrying capacity.** Steady-state live-particle count is monotone increasing in
   `R_food`, and 0 when `R_food = 0`. Confirms the economy binds.
5. **Self-sustaining structure.** With the `cell` preset (a wall type with
   `A[wall][Food] < 0` and a mouth type with `A[mouth][Food] > 0`), the mean food
   concentration inside clusters exceeds outside by a factor `> 1.5`. This is the
   first real biology in the world: a membrane that maintains a chemical gradient.
6. **Healing beats control.** Two runs, identical seeds and food, differing only in
   `W_brain`: feed-the-hungriest vs even-split. Median limb-ticks-alive over 10
   seeds must be strictly greater. **If this fails, the signal/food pathway is
   decorative** — the brain's inputs aren't actually informative — and that is
   exactly the kind of failure a pretty canvas hides.
7. **Regeneration.** Force-starve one limb with free particles nearby; the socket
   is refilled within `k` ticks. With no free particles, it is not.
8. **Morphology follows chemistry.** One organism, no food, no noise, two filled
   sockets in adjacent quadrants. With `A[a][b] = +1` both rods come to rest against
   their shared boundary (separation → `gap`); with `A[a][b] = −1` they rest against
   their outer limits (separation → `π − gap`). Same code, same body plan, opposite
   shape. This is the test that proves body shape is not encoded.

### D. Performance

- 5k particles, one tick, median over 100: **< 16 ms** (60fps budget) in Node.
- Spatial hash scaling is `~O(n)` from 1k → 16k, not `O(n²)`.
- Zero allocation in the hot loop — flat typed arrays, reused neighbour buffers.
  Asserted by watching heap growth across 1k ticks, because GC pauses in a
  real-time sim are a correctness problem, not a performance one.

### Observables we need anyway (`core/metrics.ts`)

Tests and the UI want the same numbers, so these are library code, not test code:
`massByType`, `totalEnergy`, `potentialEnergy`, `rdf`, `clusterSizes` (union-find
on an `r < r_c` graph), `bodyIntegrity` (bound limbs / total sockets),
`insideOutsideFoodRatio`, `stateHash`.

---

## 12. Stack

Chosen for "prototype fast, add small things later," which mostly means: no build
step to fight, no dependency that can break the model, and a clean seam between
physics and pixels.

| Concern | Choice | Reason |
|---|---|---|
| Language | **TypeScript** | The hot loop is numeric and easy to get wrong; types catch unit and index mistakes that produce plausible-looking garbage |
| Bundler / dev server | **Vite** | Instant HMR, zero config, one dev dependency |
| Tests | **Vitest** | Same config as Vite, runs the core headless in Node, fast watch mode |
| Rendering | **Canvas 2D** + pre-rendered glow sprites, `globalCompositeOperation='lighter'` | Zero runtime dependencies, genuinely beautiful additive glow, comfortable to ~8k particles. Upgrade path is PixiJS/WebGL and it is a renderer-only change |
| UI | Hand-rolled DOM + CSS | The panel is a 5×5 heatmap and ~8 sliders. A framework would be more code than the thing it builds |
| Runtime deps | **none** | Nothing between us and the model |

**The one architectural rule: `src/core/` never imports from `src/render/`, and never
touches `window`, `document`, or `Math.random`.** The core is a pure function of
`(state, params, seed) → state`. That is what makes every test in §11 possible, and
it is what will later let us run thousands of headless generations without a
browser.

```
src/
  core/            # pure, headless, deterministic — the whole model
    params.ts      #   parameters + presets (membrane, cell, gas, crystal)
    rng.ts         #   seeded PRNG (mulberry32) + Gaussian
    torus.ts       #   wrap + minimum-image displacement
    grid.ts        #   spatial hash
    forces.ts      #   force law + potential
    field.ts       #   signal field: deposit, diffuse, decay, sample
    organism.ts    #   sockets, rods, binding, dissolution
    brain.ts       #   neuron model + hand-wired policies
    world.ts       #   state + step(): the tick pipeline
    metrics.ts     #   observables
  render/          # canvas drawing, glow sprites, field wash
  ui/              # matrix heatmap editor, sliders, presets, pause/step
  main.ts          # wiring + requestAnimationFrame loop
tests/             # mirrors core/, plus invariants.test.ts and phenomenology.test.ts
```

### The tick pipeline

Order matters; this is the canonical sequence.

```
1  build spatial hash
2  pair forces        (hard core + matrix) over neighbours within r_c
3  rod torques        → ω, θ for bound limbs
4  integrate          overdamped drift + Brownian, then wrap
5  food uptake        consume Food within r_0
6  limb metabolism    keep k_keep, pass rest inward
7  neurons            limb neurons → sig, msg
8  brains             redistribute food, emit move force
9  tolls              upkeep, motion, signal → burned
10 births & deaths    starvation unbind/dissolve, socket capture
11 field              deposit, diffuse, decay
12 sun                inject food into drifting patches
13 ledger assert      (dev builds only)
```

---

## 13. Open questions

1. **Does one signal channel suffice?** Multiple channels cost one dimension and
   would let different "species" of structure talk past each other. Deferred until
   something actually needs it.
2. **Should `B` have a matrix row?** Currently no, so bodies don't chemically clump.
   Turning it on is the cheapest possible path to multicellularity — bodies binding
   to bodies through existing physics — which argues for trying it early.
3. **Is a fixed 4-socket body plan a real ceiling?** It caps the *number* of limbs,
   but not shape — free rod angles mean a 4-socket body already has a continuous
   morphology space, chosen by the matrix. And it is no ceiling at all on dynamics:
   membranes, gradients, and healing are all reachable without touching it.
4. **Should rods be springs rather than rigid?** Springs would be softer and more
   lifelike, but add a stiffness parameter and a stability constraint. Rigid first.
5. **Patch drift vs. static patches.** Drift forces organisms to keep foraging
   rather than parking. Probably essential, but it is a knob, so measure it.
