# World Rules — v0

The complete and authoritative specification of the v0 world. If a behaviour is not
derivable from the rules below, it does not exist. If the code does something not
written here, the code is wrong.

Companion documents: [DESIGN.md](DESIGN.md) for rationale, stack, and test strategy.

---

## 0. Shape of the world

| | |
|---|---|
| Space | 2D continuous, `SIZE × SIZE`, **toroidal** (wraps on both axes) |
| Time | discrete ticks, `dt = 1` |
| Motion | **overdamped** — velocity ∝ force, no inertia, no momentum |
| Randomness | one seeded PRNG; the entire world is a pure function of `(params, seed)` |

Everything in the world is a particle in one flat array. There are six types:

- **`P1 P2 P3 P4`** — intrinsic matter. Conserved; never created or destroyed after init.
- **`B`** — brain. Conserved.
- **`F`** — food. Created by the sun, destroyed by eating. The world's open boundary.

A particle is free or bound. Bound means: attached to a brain's socket by a rigid rod.

---

## 1. Chemistry

**R1.1** A single **5 × 5 symmetric matrix `A`** over `{P1, P2, P3, P4, Food}` holds
all chemistry. 15 free values in `[-1, 1]`. Positive = attraction.

**R1.2** `A` is symmetric: `A[i][j] = A[j][i]`. Always. This makes the force field
conservative, which is what lets structures (membranes, clusters) assemble as energy
minima — and what makes rule R1.3 necessary.

**R1.3** Because `A` is symmetric, the force field alone can only relax the world
into static structure. **Temperature `T`** (Brownian jitter, R2.2) is what keeps it
alive: it lets structures anneal, melt, and reform. `T` is the single most
consequential dial in the world.

**R1.4a — Quantized bonds.** The non-food 4×4 block is snapped to
`{−1, −0.5, −0.25, 0, 0.25, 0.5, 1}` by default (`quantized`). This is not a stability measure —
the magnitudes are unchanged — it makes chemistries repeatable and comparable, and the matrix
editable by eye. The Food row stays continuous.

**R1.4b — Food couples at half strength.** Every Food entry is multiplied by
`food_coupling = 0.5` at force time, biasing the world toward particle-to-particle structure
rather than food-chasing. The matrix itself stays uniform in `[-1, 1]`.

**R1.4** `Food` has a row in `A`. A type with `A[t][Food] > 0` is a mouth; a type
with `A[t][Food] < 0` is a wall food cannot cross. Eating and selective permeability
are consequences of chemistry, not special-cased code.

**R1.5** `B` (brain) has **no** row in `A`. Brains interact only via the hard core
(R2.1), so bodies do not chemically clump into each other.

---

## 2. Physics

**R2.1 — Force law.** For a pair at wrapped distance `r`, with `u = r / r_c` and
core fraction `β`:

```
r < r_core  →   F = K · (1 − r_core/r)                            [repulsive, diverges at contact]
r_core ≤ r ≤ r_c → F = A[i][j] · (1 − |2u − 1 − β| / (1 − β))     [tent, u = r/r_c, β = r_core/r_c]
r > r_c     →   F = 0
```

`r_core` depends on the pair, because a brain carries a body:

| pair | exclusion radius | strength |
|---|---|---|
| two ordinary particles | `r_0 = β·r_c = 10` | `K_core` |
| one of them a brain | `r_brain_core = 8` | `K_brain` |
| **both brains** | `r_brain = 16` | `K_brain` |

**R2.1b — A brain pushes everything away.** A brain has no row in the matrix, so it has nothing to
attract with; beyond its core it simply repels, with strength `A_brain` fading to nothing by
`r_brain_push = 26`. Its surroundings stay its own, and a body sits in a space it cleared. The
reach is deliberately short of `r_c`, so limbs can still reach food just outside it — measured,
raising `A_brain` from 0 to 0.5 left organism counts and limbs-per-organism unchanged or slightly
better, while 0.8 began to cost births.

One limitation worth stating: a limb held by *another* organism's rod cannot yield radially, so it
can be pressed closer to a brain than a free particle ever would be. Measured, that happens on
under 0.2% of brain-particle pairs.

Positive `F` attracts. Force acts along the minimum-image separation vector. Two
terms with two distinct jobs:

- The **hard core** is universal and not in the matrix, and it **diverges as `r → 0`**. That
  matters: a *bounded* core can be out-pulled by enough attracting neighbours, and particles then
  end up squeezed into the same point. Measured — with a linear core, free particles reached 0.01
  units apart; with this one they hold about 2 units on a 10-unit core.
- The **tent** is where the matrix acts. Note that for `A > 0` the potential minimum
  is at contact (`r_0`), not at the tent's peak: the peak is only where the pull is
  strongest. Spacing and membrane-like structure come from *mixed signs* — types
  that attract each other but repel their own kind.

**R2.2 — Integration.** Free particles, every tick. Food is included only when `foodMoves` is on; otherwise it sits where it landed (it still pulls and pushes others). `T` is a true
temperature in potential-energy units (Einstein relation, `D = μT`):

```
x ← x + μ·F·dt + sqrt(2·μ·T·dt)·N(0,1)    then wrap into [0, SIZE)
```

Bound limbs are not integrated independently; see R3.3–R3.4.

**R2.1c — Particles are elements, not just chemistries.** Each particle *type* carries its own
size, mobility, valence, bond strength, bond cost and decay rate — the properties a chemical
element has. Before this the chemistry matrix was the only thing distinguishing P1 from P2, and
four types differing in one dimension are barely four types.

```
radius        hard core; a pair parts at the SUM of their two radii, so size means size
mobility      mass, as a fraction of mu. Food's entry is what mu_food used to be
valence       how many bonds one particle may hold
bondStrength  multiplies F_form and F_break; a bond takes the WEAKER of its two partners
bondCost      what forming a bond costs this particle
decay         per-tick loss while loose, added to the world's decay_free
```

**Every global dial is now the default for its per-type field**, so `max_bonds`, `E_bond`,
`mu_food` and `beta` all still set every type at once and the element table is the finer
instrument. A world that says nothing about elements behaves exactly as it did.

Three things worth knowing from measuring them. A bond takes the **minimum** of its partners'
strengths, not a mean, because otherwise a fragile type could be made structural by whatever it
attached to. The pair exclusion is the **sum of radii** rather than a per-pair constant, so a big
particle holds a small one off at the distance their surfaces meet. And a **heavy type ends up
*more* bonded, not less** — 2.35 bonds per particle at mobility 0.1 against 0.72 at default,
because a slow particle is not dragged out of its bonds by the jostling that breaks everything
else's. Slow matter is structural matter, which is a mechanism this world did not previously have.

**R2.2b — Food is heavier than life.** Food moves with mobility `μ · mu_food` (0.15) and takes a
thermal kick scaled by `sqrt(mu_food)`, because a Brownian step goes as `sqrt(μT)`. So its drift
is damped about seven-fold and its jitter about two and a half.

This was one mobility for everything, and that made pursuit impossible rather than hard: a crumb
of food drifted exactly as fast as a limb swam and took exactly the same kick, 0.8 to 1.4 units a
sub-step at ordinary temperatures. **You cannot catch what diffuses as fast as you move.** A
chase that gains nothing on its target is indistinguishable from thrift, and thrift is the only
strategy any search here has ever found.

Food still *responds*: an attractive chemistry gathers it, a repulsive one scatters it. It is
heavy, not nailed down — `foodMoves: false` is the separate option that nails it down.

One limit, measured and worth stating so it is not rediscovered: above the temperature where
R2.4's guardrail binds, this buys nothing. At `T = 20` with 16 sub-steps the Brownian increment
wants about 1.1 per sub-step and the budget allows 0.31, so every particle is clamped to the same
displacement and food is exactly as fast as life whatever its mobility says. Measured ratio of
food to matter displacement: **0.44 at `T = 3`, 0.96 at `T = 20`.** A world in that regime is one
where the integrator rather than the chemistry sets the dynamics, which is why the search
discards worlds that clamp more than 60% of the time.

**R2.6 — Sub-stepping.** A tick may be split into `substeps` smaller moves that reuse the same
forces. Brownian increments are independent, so each is `sqrt(n)` smaller while the total
diffusion is unchanged, and the force is applied in `n` pieces. Seeded worlds pick the smallest
count that satisfies R2.4's budget, and editing the temperature raises it to suit. This is how a
hot world keeps working: exclusion needs each *move* to be small compared with a particle, not
merely bounded.

**R2.4 — Motion budget (discrete-time guardrail).** Time is discrete, so a step long enough to
cross a particle would defeat exclusion entirely. Three hard bounds, every tick:

- forces and noise move any particle at most `d_max = 5` per tick, half a core radius (and
  `d_max / substeps` per sub-step) — direction is kept, only the length is cut;
- a Brownian draw is clamped to `z_max = 3` sigma, so no rare tail can teleport anything;
- a rod swings at most `dth_max = 0.25` rad.

A brain may then be pushed up to `d_max` further by R2.5. So a free particle moves ≤ 5 (well
inside `r_0 = 10`: **nothing can tunnel**), a brain ≤ 10, and a limb ≤ 14 as it both rides its
brain and swings. The clamp is meant to be a backstop: the stats panel reports how often it
bites, and if that is more than a few percent the world is too hot (R1.3).

**R2.5 — Organisms keep their distance.** After integrating, any two brains closer than
`r_brain` are pushed apart along their separation (at most `d_max` per tick each). This is a
*constraint*, not a force, because repulsion alone cannot hold: a limb attracted to a neighbour
drags its own brain inward and the step clamp carries it there. New organisms are also placed
`r_brain` clear of every existing body — an overlapping spawn would stay tangled for hundreds of
ticks. Organisms can still touch and bond: through their limbs, which is the point.

**R2.3 — Who feels whom.** All pairs within `r_c` interact, with two exceptions:

- A bound limb and **its own brain** do not (the rod already holds them).
- A limb and **its sibling limbs on the same organism** *do* interact. This is
  load-bearing: it is what gives a body a shape (R3.3).

---

## 3. Organisms

**R3.1 — Body.** One brain particle plus **4 sockets**, one per quadrant. A filled
socket holds a rigid rod of fixed length `L_rod`, rooted at the brain, with one
intrinsic particle at its tip. The tip is always exactly `L_rod` from the brain.

**R3.2 — Quadrants.** Socket `i` owns quadrant `i`, and the four quadrants are
separated by a small angular `gap` so that rods can never coincide. The body is a
disc cut by a thin cross:

```
          │ ╲   gap   ╱ │             θ_i ∈ [ i·π/2 + gap/2 ,
       ───┼────╳────────┼───                  (i+1)·π/2 − gap/2 ]
          │ ╱         ╲ │
        q1 │ q0                      i = 0..3
       ────┼────                      gap = 0.12 rad (≈7°)
        q2 │ q3
```

Within its quadrant a rod is entirely free; at the boundary it stops. `θ_i` is
clamped, not wrapped — a rod pressed against a limit rests there under load.

**R3.3 — Rod angles are physics, not decisions.** Split the net force on a tip into
a radial part (along the rod) and a tangential part (across it). The tangential part
swings the rod, overdamped like everything else, and the angle clamps at its quadrant
limits. The radial part is carried by the rigid rod to the brain:

```
θ      ← clamp( θ + (μ·F_tangent + sqrt(2·μ·T)·N(0,1)) / L_rod , quadrant limits )
F_brain += F_radial · r̂           // summed over limbs; the body is pushed as one
```

The brain has no control over `θ`. **Consequence: body shape is an equilibrium of
the matrix.** Limbs whose tip types attract swing together and come to rest against
their shared gap boundary; limbs whose types repel splay to opposite limits. Each of
the shapes below is a stable resting configuration, and not one of them is
enumerated in code — they are all the same four clamped rods under different
chemistry:

```
    =O=              ||                │
                      O              ──O──
                     II                │

  two filled      q0+q1 attract      four limbs,
  sockets,        up, q2+q3          mutually
  splayed         attract down       repelling
```

Two attracting rods do not touch: the hard core holds their tips `≈ r_0` apart, so
they rest `≈ r_0 / L_rod` radians from each other. The `gap` only guarantees that
rods in neighbouring quadrants can never coincide, whatever the forces.

**R3.4 — Movement.** The brain particle moves by `μ·(F_hardcore + F_move + Σ F_radial)
+ Brownian`. Every tip is then placed at `L_rod` from the brain at its angle, so the
body translates as a rigid unit. Only the brain pays the motion cost.

---

## 4. Energy

One Food particle carries `E_food`. Every particle has a reserve, capped at `E_cap`.
The ledger must close exactly: `Σ reserves + Σ food in world + total burned` equals
`initial + total injected`, every tick.

**R4.1 — Sun.** Food arrives on an **accumulator**, not a fixed interval: the sun owes
`rate(tick)` particles each tick and pays whole ones as they add up. So any rate works — a tenth
of a particle a tick through a famine, nine a tick through a bloom — and the rate can change
continuously without the arrival pattern stuttering. The fractional remainder is part of the
world's state and travels in snapshots.

**The rate is fixed; it is never throttled by how much food is already out there.** The only
ceiling is storage: `max_food` is the number of food slots the world has, and when every slot is
occupied the arriving light has nowhere to land and is lost. That used to happen in silence,
which made a saturated world and a dim one the same observation — in both cases food stopped
arriving. `lightWasted` now counts the overflow, and `max_food` was raised from 120 to 300 per
unit area because at 120 it sat close enough to the standing stock of a well-fed world that the
ceiling, not the sun, was setting the supply. **A capacity that binds is a thermostat whether or
not it was meant as one.**

The rate is three independent dials, which compose:

```
rate(tick) = level × sustenance × regime(tick)        and the pattern decides *where* it lands
```

**R4.1a — Pattern: where food lands.**

| | |
|---|---|
| `random` | uniform over the torus. Standing still is as good as moving |
| `patchy` | a few slowly drifting hot-spots, so following the food pays |
| `gradient` | one sunlit band; the rest is desert |
| `converging` | 2–4 colonies spread evenly round the world that migrate together over `converge_ticks` and **merge into one** — isolation first, contact later |
| `breathing` | the same colonies, but they merge and part again **for ever**, one full breath every `converge_ticks`. Populations meet and mix, then are pulled apart to drift on their own |
| `spring` | a single small fixed source everything must come to: the most contested world there is |
| `comet` | one fast source crossing the world, so food is a target to be chased rather than a place |
| `ring` | a closed band around the middle — a circuit rather than a field |

**R4.1b — Level: how much.** `scarce` / `average` / `abundant`, as multiples of
`sustenanceRate` — what the world spends per tick on upkeep and on loose matter bleeding away.
Expressing it this way means a level means the same thing at any world size.

The multipliers (0.12 / 0.4 / 2) were **calibrated by what they produce, not by the budget on
paper**, because most food is never reached: break-even on paper is already a glut in practice.
Measured over 5000 ticks across three seeds, mean standing food out of a 120 cap: scarce ≈ 20 with
barely one organism alive, average ≈ 45 with five, abundant pinned at the cap with the population
at its own cap.

Worth knowing from the same measurement: of what a default world spends, **loose matter decaying
outweighs the upkeep of every organism by about seven to one**. Most of the energy budget goes on
matter that never joined a body.

**R4.1c — Regime: how it changes.** A multiplier on the rate, a pure function of the tick, so a
world stays reproducible and the regime never disturbs the random stream.

| | |
|---|---|
| `steady` | the same rate for ever |
| `cycle` | famine to feast and back: 0.15× at the trough, 2.5× at the peak |
| `bloom` | a long famine at 0.12× broken by brief, enormous blooms at 9× |
| `decline` | a world running down: 1.8× at the start, nothing by the end of the period |
| `rising` | a world filling up, 0.1× to 1.8× |
| `noisy` | wanders with no pattern to learn — summed sines, so still deterministic |

**R4.1b — Food spoils.** An uneaten food particle expires after `food_life` ticks and its energy
is burned. Without this the sun simply fills the world to `max_food` and leaves it there:
measured, food sat at 478/480 for thousands of ticks with no expiry, and at ~250/480 with a
200-tick life. Scarcity is what makes foraging worth paying for, so this is part of the economy,
not a tidying measure.

**R4.2 — Uptake.** A particle within `r_eat` of a Food particle consumes it: the Food
particle is destroyed and `E_food` is added to the consumer's reserve. If several are
in range, the nearest consumes it. A particle whose reserve would exceed `E_cap`
cannot eat (a limb also needs room in its brain). Free particles eat too. Nothing compels a particle to seek food — whether it
ever meets one is decided by `A` (R1.4).

**R4.3 — The inward toll.** A bound limb keeps `k_keep = 10%` of what it takes in
and passes the remainder **inward** to its brain, one hop per tick. Energy never
teleports.

**R4.4 — Costs.** Every tick, every particle pays; spent energy leaves the world as
heat and is recorded as burned:

| Cost | Amount |
|---|---|
| Upkeep | `c_up` per tick, for brains of live organisms and bound limbs. Free particles are inert and pay nothing |
| Motion | `c_mv · μ · \|F_move\|²`, brains only |
| Signal | `c_sig · \|sig\|` per emitting particle |
| Free decay | a free particle loses `decay_free` of its reserve each tick (default 0.2%, half-life ≈ 350 ticks); the tail below 0.01 snaps to zero. Bound particles and food are exempt. Burned, so the ledger stays exact |

**R4.5 — Redistribution.** The brain holds its accumulated reserve and sends a
fraction `releaseFrac` of it back out along the rods each tick, split by the brain's
output (R5.2). A limb accepts only up to `E_ref`; the rest of its share stays in the
brain.

---

## 5. Neurons

Every neuron has the same shape: `out = tanh(W·x)`. **Each newly spawned organism gets
fresh random weights** (Gaussian, from the world's seeded stream). Nothing about its
brain is designed: some organisms will forage, some will wander, some will starve.

**R5.1 — Limb neuron** (one per bound intrinsic particle):

```
x = [ S_brain , S_field , pF_x , pF_y , FF_x , FF_y , reserve/E_ref , 1 ]   // 8
S = tanh(W_limb · x)                                                        // one output
```

That single `S` goes **both ways**: inward to the brain and outward into the signal field. One
signal with two destinations is simpler than two separate outputs, and halves the weights.

The two force inputs are what a limb can actually act on: `pF` is the force it feels and `FF` the
part of that which came from food. Both are already computed by the force pass, so they are free,
and unlike a scalar count they carry a **direction**.

**R5.2 — Brain** (one per organism):

```
x = for each of 4 sockets:
      [ alive_i , onehot4(type_i) , S_i , bond load_i , angle_i ]    // 32
  ⧺ [ reserve/E_ref , S_field , 1 ]                                  //  3
  ⧺ [ tanh(food pull x) , tanh(food pull y) ]                        //  2
  ⧺ [ tanh(food around / 8) ]                                        //  1
  ⧺ [ tanh(v_x / d_max) , tanh(v_y / d_max) ]                        //  2
  ⧺ [ body bond load ]                                               //  1
y = W_brain · x                                                      // 41 → 10

F_move     = F_max · tanh(y[0..1])   // where to go
food split = softmax(y[2..5])        // how to divide releaseFrac among sockets
S_to_limb  = tanh(y[6..9])           // what to tell each limb, read by it next tick
```

**The loop is closed.** The brain can now *answer* its limbs rather than only receiving from
them, and because a limb's `S` is also what it deposits into the field, the brain's state can
reach the outside world through its limbs. Talking costs `c_sig · |S|`, charged to the brain,
exactly as a limb pays for its own signal.

**R5.5 — The brain can perceive its own body.** Three more senses, each closing a gap that made
a rung of the ladder unreachable rather than merely difficult:

- **Its own motion.** `v` is last tick's *net displacement* — after sub-stepping, after the step
  clamp, after brain separation — not the force the brain asked for. It is the only input that
  returns through the world, and so the brain's only memory: without it, "keep going the way I
  was going" is not expressible, because nothing in the inputs says which way that was. Note the
  delay: force is chosen in `think()`, which runs after `integrate()`, so a decision moves the
  body next tick and is felt the tick after. Two ticks of lag is what makes it a report rather
  than a copy of the command.
- **Its own limbs' angles.** Each limb's direction within its own quadrant, mapped to [-1, 1].
  Which quadrant is implicit in which weights read the input, so the pair is a complete heading.
  A brain that cannot read `theta` does not know which way its body points, which is why
  coordinated motion was being asked for from an organism that could not have produced it.
- **Its bonds.** The fraction of bond slots filled, per limb and for the body as a whole. Nothing
  in the inputs had ever mentioned a bond, so "move together" and "pass a join along" were asking
  for behaviour conditioned on a fact the brain had no access to.

None of these tells an organism what to do. They make a strategy *representable*, which is the
precondition for selection finding one.

Why type stays a one-hot rather than a single number: the four types are not ordered, so one
value would make the layer encode a ranking that does not exist. And why both neurons keep
`reserve`: a brain that cannot read its own reserve allocates energy blind, and a limb that
cannot read its own cannot signal that it is starving — which is the whole healing story.

**R5.4 — The brain can see food, and can tell a feast from a desert.** The **net pull toward
food on the whole body** is a vector: the force pass already computes it, so it costs nothing,
and it carries a *direction*, which makes chemotaxis one weight rather than an inference from
scalars.

A vector sum is not enough on its own, and for a long time it was all there was. An organism in
the middle of a symmetric cloud of food feels pulls that **cancel exactly** — it reads the same
zero as an organism in an empty desert, and a sense that returns the same answer in the best and
worst place in the world is not a sense. So the brain also reads **how much food is around**: the
count of food particles within `r_c`, which the force pass had been computing all along and which
nothing had ever read. A count cannot cancel. It is squashed through `tanh(near / 8)` because a
raw count would saturate the layer at the first crumb, and it is summed over the brain and all
four limbs, since a limb reaching into a patch is news about the body.

An earlier version of this section claimed each socket carried its own food count. It did not;
the socket inputs were presence, type and signal only. The body-wide count is what now exists.

**R5.3** There is no policy. A "feed the hungriest" brain is one point in weight space;
when learning arrives, it is the baseline to beat, not a rule of the world.

---

## 6. Signals

**R6.1** Signal is a decaying scalar **field** on a coarse toroidal grid, not a
particle. A signal particle would need to be massless, chemically inert, and
self-destroying — three exceptions to the laws. A field is one rule.

**R6.2** Each tick: limbs deposit `max(0, sig)` into the cell under them, the
field diffuses once (5-point stencil), then decays by `λ`. Every neuron reads the
cell under it.

This is the only channel between organisms. Influence is stigmergic — written into a
shared medium — so there is no messaging code and no concept of "nearby organism".

---

## 7. Creation and destruction

**R7.1 — Organism spawn.** Every `T_spawn` ticks, one organism appears at a uniformly
random position: a random free brain plus **1 to 4 filled sockets** (count chosen
uniformly), each taking a random free intrinsic particle (not in cooldown), in a
random distinct quadrant, at a random angle within it. Each chosen particle's reserve
is topped up to `E_init`; that energy is created by the spawn and counted as injected
(a second source of energy alongside the sun, so extinction is never permanent). If
the free pool is short, fewer sockets are filled. Organisms are therefore born asymmetric and incomplete, and
R7.3 lets them finish growing from the soup.

**R7.2 — Limb death.** A limb whose reserve reaches 0 **unbinds** and becomes a free
particle again, in cooldown for `cooldown` ticks. The organism carries on with an empty socket.

**R7.3 — Regeneration.** An empty socket captures any free intrinsic particle with
energy `≥ E_viable` (1), not in cooldown, lying
within its own quadrant and within `r_bind` of the rod circle (`|r − L_rod| <
r_bind`, measured from the brain). The particle snaps to `L_rod` and the new rod
takes the angle the particle already had. A socket's capture zone is therefore an
arc, not a point — a body reaches for whatever drifts past the right part of it.

This is the *only* other way a socket gets filled, and it is why healing costs no
extra code: regeneration is binding, running again on a body that already exists.

**R7.4 — Organism death.** A brain whose reserve reaches 0 dissolves: all limbs unbind
(each keeping its own reserve) and the brain becomes a free particle. Corpse-as-food
is deferred.

**R7.6 — Continuous inflow (option).** With `inflow` on, matter is no longer conserved
and the pool no longer limits organisms. Each spawn (R7.1) activates *fresh* particles —
a new brain and 1–4 new limbs, each endowed with `E_init` (counted as injected) — in
slots reserved for them: brain capacity is `3 × n_brain`, with room for four limbs per
brain. In exchange all matter becomes mortal: free particles pay `c_up` too, and any
particle whose reserve reaches 0 vanishes (its slot returns to the pool, residue
burned). Organisms therefore keep arriving and keep dying, instead of the world
filling up and freezing once every brain is in use.

**R7.7 — Budding (option, on by default).** A brain with reserve `≥ E_repro` and no
cooldown may reproduce, if it can pay and there is room. The child gets one limb per
limb the parent currently has, of the same type and angle, taken from free particles of
that type (pool mode) or from fresh slots (continuous inflow). Every particle of the
child is topped up to `E_birth` (15), and **that energy is taken from the parent**, who must
keep at least `E_hold`. Nothing is injected. The child appears `repro_dist` away,
inherits the parent's brain weights plus Gaussian noise of std `repro_mut`, and
records `parent` and `generation = parent + 1`. Parent and child wait `repro_cooldown`
ticks. In pool mode the supply of free brains and free limbs of the right type limits
the population; reproduction is decoupled from everything else and costs nothing when off.

**R7.7a — Reproduction says why it did not happen.** Budding had five silent early returns, so
"nothing is breeding" could mean a shortage of energy, of free matter of the right type, of brain
slots, or of space to put a child — four diagnoses with one symptom, and only one of them is a
result about the chemistry. A world that has run out of *matter* looks exactly like a world whose
chemistry cannot support reproduction; the first is a budget to raise, the second is a finding.
`repBlocked` counts each cause separately: `{ limbless, slots, matter, energy, room }`.

**Reproduction is not literally boundless, and cannot be.** A child's body comes from pre-existing
free particles (R7.5), so making reproduction unlimited would mean creating matter from energy —
anabolism, a different rule, not yet in the model. What is available instead is a generous matter
budget plus the counters above, so a population pressed against its matter supply reports that
fact rather than looking infertile. With `inflow` on (R7.6) the ceiling moves to `3 × n_brain`
brain slots, which is the closest thing here to unbounded.

**R7.9 — Conjugation (option, off by default).** Two organisms that are **bonded to each other**,
both at their own reproduction threshold and both off cooldown, may produce one child together.
The parents split the cost equally and each must still keep `E_hold`; the child appears at their
midpoint; the body plan is drawn socket by socket from one parent or the other, and the brain and
limb weights are a **uniform per-weight crossover** of theirs, then mutated as usual. `parent`
stays single so lineage and generation keep meaning what they meant, and `coparent` records the
other side: descent through one line, inheritance from two.

Why bonded rather than merely near: a bond is already the world's only notion of association, it
already costs energy to make and has an activation energy to break, and `Joins` is met by every
world that has ever been confirmed — so the precondition is something that reliably happens. The
brain can now also *perceive* its bonds (R5.5), so seeking a mate is at least representable.

Why this matters more than it looks: budding and fission are **both clonal**. Before conjugation
there was no recombination anywhere in the world — every in-world lineage was a mutation chain,
and crossover existed only inside the GA learner, between dead organisms, at population level.

Conjugation is tried *before* budding, because a partner is only sometimes available while
budding almost always succeeds; the other order would make it effectively never happen.

**R7.10 — Spores (option, off by default).** When reproduction fails for any reason, a parent may
instead convert `E_spore` into a **spore**: one free particle carrying a copy of its genome. A
spore is not a new kind of thing — it is ordinary free matter with a flag, drifting under the same
chemistry and decaying at the same rate — so dispersal costs one array and no new physics. It is
never captured as a limb and never used as spare matter for a body, since that would silently
discard a reproduction already paid for.

A spore germinates where `foodNear ≥ spore_food` — **the same count the brain reads** (R5.4), so
perception and germination agree on what "there is food here" means. It needs a free brain slot
and room; the spore particle then becomes the new organism's first limb, which is both tidy and
right: the matter that carried the genome is the matter the body starts from. Its own reserve
endows the whole body, so nothing is injected. A spore whose reserve falls below what a body costs
stops being a spore and reverts to ordinary matter — the investment is simply lost, which is what
dispersal risks.

Germination is **not** gated on `repro`: the parent has already paid, and refusing to let a spore
wake would destroy energy that was spent on a reproduction.

*The measurement that corrected the design.* This was first gated on "nowhere to put a child",
since crowding is what dispersal intuitively answers. In a world that actually lives, over 6,000
ticks, `room` blocked reproduction **0** times and a free brain slot blocked it **41,244** times —
the population cap is the binding constraint, as it has been every time it has been measured. A
spore needs a slot only at germination, so it *banks* a reproduction the cap would have discarded.
With spores on, blocked-slot events fell from 41,244 to 853, a 48-fold drop, and 106 of 152 spores
germinated.

**R7.8 — A corpse is food.** When an organism dissolves, `corpse_frac` (50%) of everything its
body still held — brain plus limbs — is left behind as food particles scattered within
`r_brain`, and the remainder is burned. Energy is *converted*, never created, so the ledger still
closes. This is what closes the loop from death back to life, and it is the opening for trophic
levels: eating the dead is now possible without any new rule.

**R7.5 — Matter is conserved** *(default, `inflow` off).* Intrinsic and brain particles are allocated once at
init and never created or destroyed. Birth and death only change `owner` and
`socket`. Scarcity of free particles therefore creates competition for limbs with no
competition logic anywhere.

---

## 8. Tick pipeline

Canonical order. Everything above happens here, once per tick, in this sequence.

```
 1  build spatial hash
 2  pair forces            hard core + matrix, over neighbours within r_c  (R2.1, R2.3)
 3  rod torques            → ω, θ for bound limbs                          (R3.3)
 4  integrate              overdamped drift + Brownian, then wrap          (R2.2)
 5  food uptake            consume Food within r_0                         (R4.2)
 6  inward flow            limbs keep k_keep, pass rest to brain           (R4.3)
 7  limb neurons           → sig, msg                                      (R5.1)
 8  brains                 → food split, F_move                            (R5.2)
 9  costs                  upkeep, motion, signal → burned                 (R4.4)
10  deaths                 limb unbind, brain dissolve                     (R7.2, R7.4)
11  captures               empty sockets take free particles               (R7.3)
12  field                  deposit, diffuse, decay                         (R6.2)
13  sun                    inject food, spawn organisms on schedule        (R4.1, R7.1)
14  ledger check           dev builds only
```

---

## 9. Parameters

Two tiers, and the distinction is the whole discipline of the project. **Laws** are
universal constants — the same for every particle, hand-set once, not play material.
**Initial conditions** are everything the start screen shows, and **every one of them
is a pure function of the seed**: same seed, same world, down to the last tick.

### Laws

| | | |
|---|---|---|
| `SIZE` | 300 × scale | world edge length. Counts and rates below scale with area, so density is constant |
| `dt` | 1 | tick |
| `mu` | 0.5 | mobility |
| `r_c` | 40 | interaction cutoff |
| `beta` | 0.25 | core fraction → `r_0 = 10` |
| `K_core` | 3.0 | hard-core strength; must exceed `max|A| = 1` |
| `r_brain_core` · `r_brain` · `K_brain` | 8 · 16 · 12 | a brain's body radius against anything, against another brain, and its strength |
| `A_brain` · `r_brain_push` | 0.5 · 26 | how hard a brain pushes everything away, and how far (R2.1b) |
| `r_wall` · `K_wall` | 10 · 12 | terrain's exclusion radius and strength (R18) |
| `food_coupling` | 0.5 | scales every Food row/column entry |
| `d_max` · `dth_max` · `z_max` | 5 · 0.25 · 3 | motion budget (R2.4) |
| `substeps_max` | 16 | cap on automatic sub-stepping (R2.6) |
| `life_window` · `life_buckets` | 10000 · 100 | trailing window for mean-lifespan reporting |
| `order_alpha` | 1.5 | compound time is credited as `(n−1)^α`, so a large group counts superlinearly |
| aggregate sampling · stable age | every 10 ticks · 300 ticks | organism-contact sampling, and how old a bond must be to count as lasting (R8) |
| `L_rod` | 16 | rod length |
| `gap` | 0.12 rad | angular gap between quadrants (≈7°) |
| `r_bind` | 6 | socket capture tolerance around the rod circle |
| `r_eat` | 6 | uptake radius |
| `cooldown` | 20 | ticks before an unbound limb can be recaptured |
| `E_food` | 10 | energy per food particle |
| `E_cap` | 100 | reserve capacity |
| `E_ref` | 50 | neuron normalization scale; limbs accept brain energy up to this |
| `E_init` | 30 | reserve a particle is topped up to when spawned into an organism |
| `c_up` | 0.02 | upkeep / organism particle / tick |
| `c_mv` | 0.1 | motion cost coefficient |
| `c_sig` | 0.01 | signal cost coefficient |
| `k_keep` | 0.1 | fraction a limb keeps |
| `releaseFrac` | 0.05 | fraction of brain reserve sent outward per tick |
| `F_max` | 1.0 | max brain move force |
| `lambda` | 0.05 | signal decay |
| `D_sig` | 0.2 | signal diffusion |
| `fieldN` | 64 × scale (max 256) | signal grid resolution |
| `E_repro` · `E_hold` · `E_birth` | 60 · 20 · 15 | budding threshold; reserve a parent must keep; reserve each child particle starts with |
| `E_viable` | 1 | minimum reserve for a free particle to be captured as a limb |
| `corpse_frac` | 0.5 | share of a dead body's energy left behind as food (R7.8) |
| `max_bonds` · `A_form` | 2 · 0.25 | bonds per particle, and the chemistry needed to form one (R16) |
| `k_bond` · `r_bond` | 0.6 · 10 | bond spring and its rest length |
| `F_form` · `F_break` | 1.2 · 4 | the hysteresis: form within 12 units, break beyond 16.7 |
| `E_bond` · `bond_cooldown` | 0.1 · 30 | cost to form a bond, and the wait after one breaks |
| `repro_cooldown` · `repro_dist` | 80 · 42 | ticks between buds; child placement distance |

### Initial conditions — derived from the seed

| | | |
|---|---|---|
| `A` | uniform in `[-1, 1]`, symmetric, `Food×Food = 0` | the chemistry; the main dial |
| `T` | log-uniform `1 … 4` | temperature. Capped by the R2.4 budget: `sqrt(2·μ·T)` must stay under a fifth of `r_0`. Hotter worlds can be typed in and are flagged on the start screen; a true gas phase needs sub-stepping, which we have not built |
| `foodMode` | `random` · `patchy` · `gradient` | see below |
| `foodLevel` · `foodRegime` | from the seed | how much food, and how it changes (R4.1b, R4.1c). **Editable** |
| `regime_period` | 1500 … 5000 × scale | one cycle, bloom interval or ramp |
| `converge_ticks` | 2000 … 8000 × scale | how long colonies take to meet, or one full breath |
| `T_food` · `food_batch` | set by the level | the base arrival rate |
| `T_spawn` | 60 … 140 | ticks between organism spawns |
| `n_intrinsic` | 30 … 50 | conserved matter pool (types assigned uniformly at random). **Editable** |
| `n_brain` | 4 | conserved brain pool, hence the cap on live organisms. **Editable** |
| `n_start` | 1 … 2 | organisms present at tick 0. **Editable** |
| `n_food0` | 30 | food present at tick 0. **Editable** |
| `max_food` | 120 | the sun pauses while this much food is in the world |
| `scale` | 1 | world edge multiplier (1, 2, 4 … 32). Counts × scale², and each injection / spawn event repeats scale² times. **Editable** |
| `food_life` | 200 ticks | how long uneaten food lasts (R4.1b). **Editable** (0 = never) |
| `decay_free` | 0.2% / tick | free-particle decay. **Editable** (0 = off) |
| `foodMoves` | off | food drifts and responds to forces. **Editable** |
| `repro` · `repro_mut` | on · 0.05 | budding (R7.7) and mutation std. **Editable** (on/off) |
| `bonds` | on | particle bonding (R16). **Editable** |
| `walls` · `n_wall` | none · 40 | terrain layout and how many pieces (R18). **Editable** |
| `inflow` | off | continuous organism inflow (R7.6). **Editable** |
| `quantized` | on | snap the 4×4 to the bond set (R1.4a). **Editable** |
| `substeps` | from `T` | integration sub-steps (R2.6). **Editable**, with an auto button |
| `n_patch, r_patch, v_patch` | 1…3, 35…65, 0.05…0.2 | only for `patchy` |

**Food modes.** All three place one Food particle per injection; they differ only in
*where*:

- **random** — uniform over the torus. Standing still is optimal.
- **patchy** — `n_patch` discs of radius `r_patch` wander slowly (heading drifts, speed
  `v_patch`); each injection picks a patch uniformly, then a point inside it. Rewards
  following the food.
- **gradient** — density `∝ ((1 + cos(2πx/SIZE))/2)²`: one sunlit band along x.

**Stability budget.** Three quantities have to hold at once, and the start screen shows all
three, amber when one is breached:

```
noise step    sqrt(2·μ·T/n) ≤ 0.1 · r_0     (n = substeps)
force step    μ·K_core/n     ≤ 0.35 · r_0
structure     T              ≤ bond depth ≈ r_c·(1−β)/2 = 15
```

The first two are about *numerical safety* — steps short enough that exclusion holds — and
sub-stepping fixes them. The third is the melting point, which sub-stepping does **not** move: a
world hotter than one bond is legitimately melted, not broken, so the start screen reports it as
information rather than a fault.

**Known limit.** The melting transition is weak in practice: measured mean cluster size falls
only from 12 (T=3) to 6.7 (T=120) against an unbonded baseline of 2.4. A genuine gas phase is
still missing.

Before this was enforced, mid-range temperatures moved particles further than their own
diameter on about half of all ticks: exclusion failed, brains sat 0.3 units apart, and nothing
stayed assembled. R2.4 and R2.5 are the enforcement; this table is the budget.

---

## 10. Interface

Four screens.

**Title.** What the world is, and two ways in: *Init world*, or *How it works* (§15).

**Pick.** **Choosing nothing is the default path.** The screen opens with one complete world
already running in a preview and two buttons: *Begin*, and *roll another*. No setting has to be
touched to see life, and the world that arrives is drawn from the combinations that reliably build
something — never the two characters (Skittish chemistry, Plenty food) that make a dull first
world, though both stay one click away.

**The builder is prominent but optional**, behind a single press, and it is **three dials** rather
than a list:

| Dial | Choices | What it decides |
|---|---|---|
| What the matter wants | Sticky, Clumpy, Chains, Hungry, Skittish | the chemistry matrix |
| What the world is like | Plenty, Patches, Harsh, Pulsing, Drifting | food pattern, level, regime, lifetime, decay |
| How they learn | None, Random search, GA, ES, CEM | where a new organism's weights come from (§23) |

**Learning is a dial, not a setting.** It sits level with the other two rather than inside the
drawer, and the picker states it next to the Begin button whether it is on or off, because whether
anything in a world is being optimised changes what the run *means* — it is not a detail of the
world. `None` is the default and says so: "off — the control".

A dial names a **character, not a world**: it generates its matrix from the seed, so re-rolling
gives a different world that still has the same nature. Five by five by a seed covers far more
ground than a list of named worlds could, and each choice states in a sentence what it will do
before anything is pressed. The named worlds remain, below the dials, as known-good starting
points. Size and terrain are chips; the seed is the one free-text field.

**Everything else is behind "Every setting"**, grouped by what it governs rather than by which code
reads it: **physics**, **chemistry** (the matrix), **food**, **life** and **compute**. `1`–`5`
switch tabs while the builder is open. The learner's own hyper-parameters appear under its dial
when one is chosen, not in the drawer, so no setting appears in two places. Numeric settings are **sliders**, each printing its value
and a line of plain English about what that value *means* — "cold: structures hold together",
"each tick split into 4, so no single move is long enough to pass through anything". The chemistry
matrix shows only its lower triangle, because it is symmetric by law. Changing any of it is named
back to you in a change summary, because hiding settings is only safe if you can see that you have
changed them.

**No setting appears twice.** Size and terrain live in the builder, not also in the physics tab;
the stability budget (§9) is shown **only when it is violated**, since a permanent "stable" badge
spends the most prominent space in the panel on a non-event.

**The preview is the model, not a picture of it.** It constructs the same `World` from the same
`Init` and steps it a few hundred ticks in slices on the frame clock, reporting organisms, matter,
the share of particles holding a bond, and standing food. It therefore cannot misrepresent what
pressing the button gives you, and it stops the moment the screen is left.

**World.** Three columns: a stats rail, the canvas, and a right rail that inspects an organism
when one is clicked and offers the collection to place from while the Organism tool is armed. Controls along the bottom: start, pause, stop, rewind and a history
scrubber, and 0.5× / 2× between 1/8 and 32,768 ticks/s — a *request*, since what you get is
1000 / (ms per tick) and no control can raise that. Measured with `npm run ceiling`: 13,700
ticks/s for a default scale-1 world, 32,000 for a 48-particle one with bonds and reproduction off.
The rail reports the rate achieved next to the one asked for. `Space` pauses, `←`/`→` change speed,
`.` single-steps, `Backspace`/`J` rewinds, `Esc` closes the inspector or ends the run.
**Shift-drag** scatters food; a **plain click** inspects an organism and rings it.

**Run summary.** Stopping ends the run and hands back a record: hero numbers, observations written
from the data (each with a threshold, so an uneventful run says so), charts of population, the
energy split, lifespans, togetherness and lineages, and exports for the whole run, the survivors,
and the notable individuals. The run is sampled into a fixed number of buckets that merge as it
grows, so a 200-tick run and a 20-million-tick run cost the same to record.

**Colour.** Two palettes, because they do two jobs. The canvas keeps bright hues for glowing marks
on near-black. Charts use the same four hues stepped into the dark-mode lightness band, validated
with a palette checker rather than by eye: all checks pass on the adjacent pairlist (worst adjacent
CVD ΔE 8.4, normal-vision 15.7, every slot ≥3:1 on the surface). Two consequences are designed
around — mint↔amber sits at the CVD floor, so stacks and lines carry direct labels and a 2px gap as
secondary encoding; and the set fails an all-pairs check, so there is no scatter with four
colour-coded series, and no chart anywhere has two y-axes.

## 11. Deliberately not in v0

Each of these is a deferred decision with a reason, not an oversight.

| Not in v0 | Why, and the trigger to add it |
|---|---|
| **Learning and selection design** | Paused. Budding with mutation exists so lineages can be watched, but nothing steers it: no learning rules, no recombination, no evolved reproduction timing |
| **Organism condensation** | Organisms spawn whole (R7.1) rather than assembling from the soup. R7.3 already contains the mechanism — promoting it to full birth is a small change once the world is stable |
| **Corpse food** | Dissolved organisms leave their limbs' energy in free particles instead of dropping Food. Add it when trophic levels are wanted |
| **Evolvable morphology** | Socket count is fixed at 4 and quadrants are fixed in size. Fill count (1–4), tip types, and rod angles already vary |
| **Multiple signal channels** | One channel until something needs two |
| **Brain chemistry (`B` in `A`)** | Would let bodies bind to bodies through existing physics — the cheapest route to multicellularity, and therefore worth trying early |

---

## 12. Compute backends

Pair forces are the only part of a tick that grows with the number of particles times
their neighbours, so they alone are pluggable (`ForceBackend`). Everything else — grid
build, integration, energy, organisms — runs on the main thread.

| Backend | How | Notes |
|---|---|---|
| serial | one loop over all particles | default; bit-exact; used by the test suite |
| threads | Web Workers share the world's memory (`SharedArrayBuffer`); the main thread computes one slice | identical results to serial; needs the page to be cross-origin isolated (the dev server sets the headers) |
| GPU | WebGPU compute kernel; the CPU uploads positions and cell grid, reads back one force per particle | single precision: matches serial to ~1e-4 relative, not bit-exact |

All three run the same per-particle kernel (`forcekernel.ts` and its WGSL port), where
each particle sums over *all* its neighbours. That is what makes the work splittable
with no write conflicts. Measured on an Apple M4 Pro (14 cores), see `bench.html`:

| World | Particles + food | serial | 14 threads | GPU |
|---|---|---|---|---|
| 8× (2400²) | ~11k slots | 597 tick/s | 920 tick/s | 625 tick/s |
| 16× (4800²) | ~44k slots | 145 tick/s | 292 tick/s | 186 tick/s |
| 32× (9600²) | ~176k slots | 35 tick/s | 71 tick/s | 68 tick/s |

Speedup is about 2×, not 14×: the non-force part of a tick (about half the time) is
still serial. Small worlds are faster on the serial backend.

---

## 13. Organism aggregates

Two organisms are **in contact** when any of their limbs are within `2.5·r_0`. Contacts are
sampled every 10 ticks and the tick each pair first appeared is remembered, so a contact has an
**age**. An **aggregate** is a connected group of two or more organisms; a **lasting** aggregate
uses only bonds older than 300 ticks. That is what turns "always connected" into a tunable
number instead of a word.

Reported in the stats panel: groups now, the biggest group's sub-organism count, the mean,
how many organisms are joined, total and lasting bonds, the biggest lasting group, and the oldest
bond's age. Measured in a crowded world: 3 groups, biggest 5 sub-organisms, 2 lasting groups,
oldest bond 870 ticks.

Because brains are held `r_brain` apart (R2.5), every one of these is mediated by limbs — a
genuine particle-to-particle join, not two bodies occupying the same place.

---

## 14. Rewind

One primitive does the work: a **snapshot** is the complete world — every per-particle array, the
scalars, the brain weights, the patches, the signal field, the food free-list, the RNG position
and the lineage counter. Restoring one reproduces not just the same state but the **same
future**, which is the test: a restored world and the original run 400 more ticks and still hash
identically.

The simulation worker keeps a ring of snapshots. Two things keep it affordable: the buffers are
**allocated once and overwritten in place**, and the sampling interval is derived from the *tick
rate* so the world takes ~20 snapshots per second of wall clock however fast it is running.
Both matter — allocating one per tick produced 0.5–3.5 GB/s of garbage at high rates and could
bring the tab down. Sampling is derived from the rate, so the cost is flat however fast the world
runs — at the 32,768 ticks/s cap: 20 snapshots/s, under 2% of a core,
and no garbage at all.

The world screen has a rewind button, a scrub slider over the held history, and
`Backspace`/`J`; the panel shows how many ticks are held.

**Hand feeding.** **Shift-drag** (or the right/middle button) scatters food wherever you point,
so a running world can be prodded — fed, starved on one side, or baited. A plain drag still pans.
Hand-fed energy is counted as injected, like the sun's.

The same primitive is what state save/load and long-run checkpointing will be built on.

---

## 15. The explainer page

"How it works" on the start screen (`H`) draws the whole model on one page: the body plan and its
quadrants, the chemistry matrix and the hard core, both neurons with every input and output
labelled, the energy path, the life cycle, and why time is clamped. Everything on it is generated
from the live constants, so it cannot drift away from the rules.

---

## 16. Bonds between particles

Organisms could previously only *touch*. Now two particles can **latch**, and the rule that makes
a latch worth having is **hysteresis**: forming is easy, breaking is not.

- **Form** when two particles (not two limbs of the same organism — rods already hold those) are
  within `r_bond + F_form/k_bond` = **12** units, their chemistry is at least `A_form` = 0.25
  attractive, and both can pay `E_bond`.
- **Hold** by a spring `k_bond·(r − r_bond)` toward a rest length of `r_bond` = 10, which is also
  the core radius, so a bonded pair sits just touching.
- **Break** only when the spring needs more than `F_break` = 4, i.e. beyond **16.7** units,
  after which both particles wait `bond_cooldown` ticks. Bonds are checked **twice** a tick, before
  forces and again after integrating, because a limb rides its brain: without the second pass a
  bond could be stretched by a body's motion and stay visible, over-long, until the next tick.
- **Cut outright** when a body is *placed* — spawned, budded or imported. Placement teleports every
  particle in the body, and a bond is a contact: these particles are no longer touching what they
  were touching. Without this, a spawn could drag a bond across the whole world; measured at 183
  units against a 16.7 breaking point, which is what long bond lines on screen turned out to be.

The gap between those two numbers is the point. **A bond can be stretched 40% further than it
could ever have been made at**, so a joined pair stays joined through ordinary jostling instead
of reshuffling every time the soup moves. That gap is the activation energy, expressed as the two
forces: `F_form` to make one, `F_break` to undo it.

Measured across the presets: switching bonding on takes standing bonds from 0 to 20–60 in the
dense worlds and leaves the sparse ones (Grazers, Desert) largely unbonded, which is what the
chemistry should decide. Bonds are drawn as **white dashed lines**, which distinguishes them from a rod (solid, in its
limb's colour) at a glance. They tile across the seam like everything else, and the stats panel
counts them.

This is the mechanism multicellularity needs, and it is what the aggregate metrics in §13
ultimately want to be built on: a group joined by bonds is a real object, not a coincidence of
proximity.

---

## 17. Compound organisms: the n-order metric

How many objects of each **order** are holding together, and for how long.

```
order 1 = one organism
order 2 = two organisms bonded into one object
order n = n of them
```

Groups are found through **bonds** (R16), not proximity, so an order-n object is a real thing
rather than n organisms that happen to be near each other. An object **counts as surviving** at
order n only once it has held for `holdFrac` (25%) of the trailing `windowTicks` (2000) — anything
can touch for a moment, and the question is what stays. Breaking apart and re-forming restarts
the clock, because the re-formed group is a different object.

The panel shows the live count at each order, how many have survived, and the best order ever
reached with how long it lasted.

**Measured, and worth knowing:** compounds do form — order 2 and 3 are routinely alive in the
Membrane preset, which briefly reached order 5 — but almost nothing survives long. The best
measured is an order-2 pair holding for **430 ticks**. The reason is not the bond: it is that
organisms with *random* brains wander off and tear their own bonds apart within a couple of
hundred ticks. Staying together is a behaviour, and nothing is selecting for it yet. That makes
this metric exactly the instrument to watch when learning resumes — and the window was set to
2000 ticks rather than 10000 because a threshold nothing can ever clear tells you nothing.

---

## 18. Terrain

One more particle type, `WALL`: immovable, with no chemistry, excluding everything by its core
(`r_wall` = 10) alone. It is never integrated, so it is the only thing in the world that stays
exactly where it was put — and therefore the only thing an organism can have a shape *against*.

Terrain lives in **`wallPositions`, a list of places**, and the four layouts — `none`, `pillars`,
`maze`, `ring` — are **stamps** that fill it. A layout is therefore a starting point you can paint
over rather than a fixed world. Every world also carries `wall_cap` spare slots so terrain can be
added while it runs; those slots are not free (each is one more entry in the grid build), which is
why the headroom is a modest 300 rather than thousands.

A config that names a layout but carries no positions is taken to mean "stamp it", so a
hand-written config behaves the way someone writing one would expect.

Note what this is **not**: a "universal repeller" type would have added nothing, because the
matrix can already make a type that repels everything — set its row negative. What was missing
was something that does not *move*, and that is what this is.

---

## 19. Inspecting one organism

Click an organism and the right-hand rail **draws** it rather than describing it:

- its **body** as it actually stands — real rod angles, limb types in their world colours, the
  quadrant guides and gap, a brain that fills from the bottom and a limb whose bright core grows
  with its reserve, exactly as on the canvas;
- its **reserves** as bars against a common scale, so a starving part is obvious. The bar is
  neutral and turns red only when genuinely low, with a coloured dot carrying the particle's type —
  the type colour must not be the bar's colour, or a P1 limb (coral) reads as starving when it is
  not;
- its **inherited weights** as a heatmap, one row per brain output. Nobody can read 290 numbers,
  and they are not meant to be read: the *pattern* gives an organism a face, so a parent and child
  visibly resemble each other and an unrelated organism does not. It is also the only part of an
  organism that is actually inherited.

Age, limb count and children sit alongside as chips. From there it can be **saved** or
**copied** as JSON, **re-seeded** (a copy placed into the running world), or a saved one
**loaded** back in.

**An organism is its weights, and weights only mean anything against the brain they were made
for.** Every file is therefore stamped with that brain's shape, and a file whose stamp does not
match this build is **refused with a reason**, not loaded. Padding an old vector to fit produces a
different organism wearing the same name — it fails quietly instead of loudly, which is worse.
This matters in practice: the brain's shape has already changed three times here, 27 → 33 → 29 → 41 inputs.

Everything merely cosmetic is still repaired: quadrants and types are clamped, duplicate
quadrants dropped, over-long names truncated. Imported organisms take free matter of the right
types and a clear spot, and their energy is counted as injected, like a spawn's.

This is the beginning of a library of organisms — which is what we will want the moment anything
starts selecting between them.

---

## 20. What an organism records about its own life

Until now only two things were known about an organism: how long it had lived and how many
children it had. That made no fitness computable, which blocked both a library worth keeping and
any learner. Each organism now carries, from birth and reset when a body is placed:

| | |
|---|---|
| `harvested` · `meals` | energy taken in from food, and how many particles that was |
| `spent` | energy burned on upkeep, movement and signalling, charged to whichever organism the particle belonged to |
| `moved` | distance the body travelled |
| `peakReserve` | the most its brain ever held |
| `orderTicks` | time spent in a compound, credited as `(n−1)^α` per tick for every member |

`orderTicks` is the one that needed a decision. Order is a property of a *group*, so to mean
anything for an individual it has to be credited to each member — which is also how
group-beneficial traits actually get selected, free riders included. `α > 1` makes it "maximise
the order **and** the time at it" rather than trading one for the other: an order-5 held for a
while is worth more than four times an order-2 held equally long.

All of it is state, so snapshots carry it and a rewind restores it.

### The top three of a run

A run offers up three organisms, picked by **three unrelated measures** — oldest, most children,
most time joined — rather than by one score. Ranking by a single number would save three
near-copies of the same winner; this way a collection accumulates different kinds of success, and
nothing had to be collapsed into a single objective. Each arrives with a readable name built from
where it came from, because unnamed things never get used again.

---

## 21. Building a world by hand

**The world screen is the builder.** The same tools stay available while it runs. There is no
separate editor, so nothing has to be compiled and no preview can disagree with the real thing.

**A world opens paused only if it was built.** Taking the quick path through the picker means
nobody asked to place anything, so it arrives **running**, at a speed that is visibly alive rather
than at 1 tick/s. A world opened from the builder arrives **paused at tick 0**, waiting.

| Tool | Key | What it does |
|---|---|---|
| Look | `V` | Pan, zoom, and click an organism to inspect it |
| Organism | `1` | Place one where you click — whichever is armed in the rail, or a random brain |
| Food | `2` | Drop food, by click or drag |
| Wall | `3` | Paint terrain, which never moves |
| Erase | `4` | Remove food, terrain and organisms within the brush |

**The brush is drawn where it will act** — a dashed ring that follows the cursor, red for erase —
because the radius otherwise lived in a slider with no visible relationship to the world and every
stroke was a surprise.

**Undo takes back one stroke** (`cmd`/`ctrl-Z`, or the toolbar button, which is disabled when
there is nothing to take back). It cannot use the rewind ring: rewind is indexed by tick, and
everything placed in a paused world happens at the *same* tick. So the world is snapshotted
immediately before each stroke begins, onto a stack bounded **by bytes rather than by count** —
a snapshot of a large world is megabytes, and a dozen of them would be worse than no undo at all.
Restoring returns the energy ledger too, not just the positions, since placing injects and burns.

**Arming an organism happens in the world**, in the right rail, from the same portrait cards the
collection uses. It previously meant leaving for the collection screen and coming back, which is
three screens to place one creature and impossible to do twice without losing your place.

Shift-drag always feeds, whatever tool is selected. Erasing an organism **dissolves** it rather
than deleting it — the same path starvation takes, so its limbs are released and half its energy
is left behind as food. Matter is conserved, so deleting a body outright would quietly destroy it.

**One distinction the toolbar has to carry:** painting sets *initial conditions*, while the food
*pattern* governs *ongoing* supply. Paint a pile in a corner and it is there at tick 0, but the sun
keeps dropping food wherever the pattern says.

**Save world** writes the arrangement back out as a config — every placement recorded, with the
random starting counts set to zero, so reopening it gives back the world you built rather than a
fresh roll of the dice.

---

## 22. The collection

A fifth screen, reachable from the title page, from setup and from a run summary. It persists in
**IndexedDB** — not localStorage, whose few megabytes would run out exactly when a collection
became worth having — and falls back to memory when a browser blocks storage, saying so plainly
rather than pretending things were saved.

**Whole-collection export and import is a requirement, not a nicety.** Browser storage is
per-browser, can be cleared by its owner and evicted under pressure; without a file there is
nothing standing between someone and losing months of organisms to a cleared cache. An import
merges, and skips unreadable records rather than abandoning the file.

**Two record types, kept apart.** A *run* holds the world complete enough to run again, the hero
numbers, the written observations and references to what it produced. An *organism* holds the file
plus a name, where it came from (seed, tick, the world's pattern, level and regime) and what it
achieved.

Every finished run is filed **automatically**, along with its best three, because a collection
nobody remembers to fill stays empty. Runs under 300 ticks are skipped so that fiddling does not
clog it.

Organisms are shown as **cards built from the portrait** — the body as it stood and the weight
fingerprint — because a wall of faces can be browsed where a table of numbers cannot. Names are
editable in place, and an organism whose brain shape no longer matches says so on its own card and
offers no way to be used.

**Use in world** arms an organism; switch to the Organism tool and every click places a copy. That
is the composition step: organisms from different worlds, placed where you want them, meeting for
the first time.

---

## 23. Learning

**A learner is an initial condition, not a law.** It belongs in the same tier as temperature and
the food pattern: something you choose for a world. `none` is the default, and with it the world
is bit-identical to one built before learning existed — the golden pins are the proof.

**What a learner may touch, exhaustively:** the weights a *new* organism is born with. Nothing
else. It cannot change physics, chemistry, energy, death, bonding or reproduction, and it has no
way to reach them. It sees two events and answers one question:

| | |
|---|---|
| `genomeForSpawn(tick)` | weights for an organism about to be born, or null to let chance decide |
| `observe(record, tick)` | a life that just ended, with every counter it accumulated |

Every algorithm in LEARNING.md fits that seam, and so does the control, so the experiment and the
baseline run the same code path.

**Budding is left alone.** It is already heritable variation plus differential reproduction — it
belongs to the world rather than to an algorithm, and a learner that also governed reproduction
could not be switched off cleanly.

### The two invariants

1. **A learner draws from its own random stream**, and a spawn's random weights are drawn whether
   or not they are used. So switching a learner on moves no food particle and changes no body
   assembly: at `share: 0` a whole run is bit-identical to one with no learner, and every run is
   until `warmup` passes. This is what makes a paired run on one seed a comparison rather than two
   unrelated worlds, and in a world whose organism counts swing from 1 to 12 on the same seed, it
   is the only honest way to measure anything.
2. **A learner is state**, so a rewind unlearns. Its pool or distribution rides in the snapshot;
   the handful of samples in flight are dropped, costing one partial update rather than
   correctness. A distribution learner therefore tags each sample it hands out and the tag travels
   on the organism, because recovering a sample from the weights would be wrong the moment the
   mean moved.

### Energy moves along bonds

A bond carries force and, if the world says so, **energy**: each tick a fraction `bond_flow` of the
difference moves between two bonded particles. This is the one new law of this round and it is
deliberately the dullest possible version — passive diffusion down a gradient, no decision, no
brain output, no statement anywhere that cooperating is good. What follows from one symmetric rule
is that a bonded group has a **shared metabolism**: a member sitting in food feeds its neighbours,
a member that runs dry can be rescued, and a neighbour can drain you.

Three properties are load-bearing:

- **Nothing is created or destroyed.** Every transfer is one subtraction and one addition of the
  same number, scaled at both ends so no particle gives more than it holds or exceeds `E_cap`.
  Measured: the ledger closes to 2×10⁻⁷ over 20,000 ticks at every flow rate tried.
- **It is computed from a snapshot** of the energies and applied afterwards, so the result cannot
  depend on the order particles are visited in — which is what keeps a threaded backend and a
  replayed snapshot bit-identical.
- **Only particles that belong to bodies share.** Including loose matter was measured to be a
  straight energy *sink*: a drifting particle has no use for a reserve and decays, so everything
  shared outward was burned and organisms died sooner than with no sharing at all. A body sharing
  with a body is the rule; a body feeding dust is a leak.

### Fitness is a stated choice, and it can be several things at once

Nine scalars are offered, all exactly known at death, and **any combination of them may be
selected**. **Offspring is the default, and the only one that is not an invention** — it is the
number the world was already keeping for its own reasons. Every other scalar is written down by
us, so the UI says so, and the run record and the summary screen both name the measure used.
Optimising "energy harvested" produces organisms good at harvesting energy, which is not the same
as discovering what this world can support.

**Several measures become one number by percentile, never by raw addition.** The nine scalars are
not comparable: offspring is a zero-inflated integer under 15, lifespan runs to thousands, net
energy goes negative, and foraging is `harvested / moved`, so an organism that barely moved
produces an enormous outlier. Each selected scalar is therefore converted to its **percentile
among recent deaths** (midranks for ties, plotting position `(r + ½)/(n + 1)` so the result is
strictly inside `(0,1)`) before anything is combined. That transform is the only one immune to all
of those at once, and it costs magnitude: ten times better and one percent better both just mean
"ranked above".

Three combiners, because they mean genuinely different things:

| | |
|---|---|
| **add them up** | a weighted average: being strong at one measure pays for being weak at another |
| **all of them** | a weighted geometric mean: being useless at any one drags the score down |
| **no weak spot** | scored on the worst measure, with a small nudge from the rest (augmented Chebyshev) |

All three agree exactly when one measure is selected — the augmenting term is divided back out for
that reason. Weights are **equal across whatever is selected**: asking someone to balance
"offspring" against "foraging" numerically is asking a question nobody can answer honestly, while
ticking two boxes and being told they count the same is a claim that can be understood. Unequal
weights stay representable in a config.

### The measure can change while the world runs

The right-hand rail is the learning panel whenever no organism is selected, and the measure is
editable there. Nothing is discarded when it changes, because the cohort, the GA's pool and any
in-flight batch all hold **raw scalar vectors** rather than scores: a change re-scores what is
already there. A distribution learner's mean still encodes the old preference, which is real
rather than a bug.

Two consequences are load-bearing. **Scores are re-derived at every decision**, not at death:
a percentile taken when an organism died was measured against a different population from one
taken a thousand ticks later, and putting a whole batch on one footing is what makes a single
measure behave exactly as it did before percentiles existed — every algorithm here is ordinal (a
tournament, a rank-weighted sum, a top fraction), and a percentile is a monotone transform.
And **the change is recorded**: the run keeps a timeline of every measure it optimised and when,
because a run whose objective moved mid-flight cannot be compared with anything, and the summary
says so.

### How a learner gets believed

`npm run experiment` implements the protocol rather than leaving it to discipline: one world per
seed handed to every variant, the controls always included, a measure fixed before the runs (the
runner refuses a variant that brings its own), medians with an inter-quartile range, and the
paired per-seed difference. A single run proves nothing here.

**Raw units are the statistic to believe, and the percentile column is not.** Random search cannot
affect the world at all — its runs are bit-identical to the baseline — yet it scored +0.0025 with
7 of 12 "wins" on a percentile statistic. That is the noise floor, and it is the same size as the
effects being looked for, because percentiles compress a heavily-tied distribution. So the runner
prints raw units first, per selected scalar, and keeps random search in every comparison as the
calibration of how little the percentile column can detect. A run where the world died out before
the measured window reports **no score** rather than zero, which would otherwise make a collapse
look like a bad result instead of an absent one.


---

## 24. What makes a world support life

Measured over 18 variants × 5 seeds × 20,000 ticks, and then paired old-against-new over 11
configurations. The results overturned two of this project's assumptions.

**Brain slots are the binding constraint, not food.** `n_brain` is a hard ceiling on the
population, and at eight or ten the population pins against it — so every birth needs a death, and
living longer and breeding at all are in direct conflict. Raising slots from 10 to 40 raised best
compound order from 7 to 18, lineage depth from 6 to 18 generations, and the 90th-percentile
lifespan from 941 to 1,259. It is the single largest effect of anything tried, and it was invisible
for as long as food was assumed to be the limit.

**Metabolism is the strongest lever on longevity.** `metabolism` scales upkeep, movement and
signalling together, and sits in the same tier as temperature: a property of the world, not a law.
At 0.5 the longest mean life of any setting; at 0.25 an organism lived 16,000 ticks of a
20,000-tick run, at which point the measurement is censored by the run rather than the world. At 2,
everything halves. Food is calibrated against what a world costs to run, so the dial reaches
`sustenanceRate` too — otherwise "average food" would quietly mean something different.

**What does not work:** `E_cap` (banking) has *no* measurable effect at 300 or 1000, because
organisms never approach 100. A richer newborn endowment (15 → 40) buys 42% more mean life and
nearly stops reproduction, dropping lineage depth from gen 9 to gen 2 — longer lives, no lineages.

**A metric that was lying.** Mean completed lifespan *falls* when slots, slow metabolism and
abundant food are combined, while the oldest individual soars past 14,000 ticks. The mean of the
dead measures turnover, not longevity: a world full of long-lived adults and a flood of newborns
reads as short-lived. Use quantiles of the living, or the 90th percentile of completed lives.

**And a second one.** Keyed by exact membership, a compound in a crowded world lasts about **ten
ticks** — somebody is always joining or dying. The same aggregate followed *through* its membership
persisted **1,000 ticks across 105 member replacements**, peaking at order 21. The old conclusion
that "compounds form but never last" was substantially a fact about the measure. `OrderStats.oldest`
now reports the structure with membership turnover, which is the first measurement here that could
distinguish a clump from something worth calling alive.

---

## 25. Archipelagos: several worlds, then one

Four worlds run to completion on their own, and their survivors are then placed in a single world
twice as wide, one population per quadrant, with food colonies that migrate inward. `npm run
archipelago` does it; the output is an ordinary world file you can open, watch and rewind.

**The islands must share a chemistry, and that is not a simplification.** The matrix is a law of a
world and a merged world can only have one. An organism evolved under a different matrix arrives
under different physics: its limb types no longer mean what they meant, and everything it learned
about holding together is wrong. So islands share chemistry, terrain and temperature, and differ in
**food, in what their learner optimises, and in seed** — exactly the set of differences that shape
behaviour rather than invalidate it. A mixed-chemistry merge is a legitimate but *different*
experiment, and should never be the default.

**Each organism carries the island its line came from**, inherited by every descendant. Without it
a merged world is unreadable: four populations look identical on the canvas, and which of them is
taking the place over is the only question a merge asks. The world rail shows the shares, their
Shannon entropy in bits (2 bits is four equal populations, 0 is one left), and the number of bonds
between organisms from *different* islands.

**Populations are drawn together, not placed in contact.** Organisms only move because of food, so
the merged world uses `converging` colonies that **start on top of the transplanted populations**
and migrate to the centre. That origin is explicit (`patchOrigins`) and had to be: colonies placed
by the usual rule start elsewhere, and four transplanted populations starve within a few hundred
ticks beside food they never reach. The run then passes through isolation, frontier contact, and
one contested pool.

**Bonds are not transplanted.** A compound that re-forms after the merge is evidence that the
chemistry and the brains support it; one that arrives pre-assembled is an assumption dressed as a
result. The merged world also runs with **no learner**, so what happens there is the world
adjudicating between four stated preferences rather than an optimiser continuing to push one.

**What can and cannot converge.** Population *share* can converge, and organisms from different
islands can *bond*. Their **lines cannot**: reproduction here is asexual budding, so there is no
gene flow however long they mix. Convergence in this world means displacement and association, not
interbreeding — that would need sexual reproduction, which is a different and larger change.

**Parallelism is per run, not per tick.** Splitting one world's forces across threads was measured
at about 2× (half a tick is serial); one whole world per core is linear in cores and **identical to
running them serially**, because each world is seeded and self-contained. Islands run as separate
`vite-node` processes rather than worker threads, since nothing transforms TypeScript inside a
thread spawned from a script, and half a second of process startup against runs of half a minute
is not worth a dependency.
