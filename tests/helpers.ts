import type { Init } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * Shared setup for tests that need **an organism**, not a viable world.
 *
 * These two are different requirements and conflating them made a dozen tests fragile. A test about
 * how a body is drawn, or exported, or counted, needs one body to exist; it does not care whether
 * the world could sustain a population. Several such tests obtained their organism by running a
 * small world for a few hundred ticks and picking the first live brain — which worked only as long
 * as a world handed out pre-assembled bodies at tick 0 and endowed them with free energy.
 *
 * Now a body has to earn its way into existence: a loose brain particle eats until it clears an
 * activation barrier, then recruits limbs out of whatever drifts into range. That is the right model
 * and it means a small, briefly-run world often contains nothing at all, so those tests failed on
 * worlds that were behaving correctly.
 *
 * Placing one directly is both deterministic and closer to what the tests mean.
 */

/**
 * Puts one organism with `limbs` limbs into `w` and returns its brain index.
 *
 * Steps a few ticks afterwards so the body is settled — rod angles are physics, so a body placed
 * and read in the same tick has limbs at their requested angles rather than at the ones the forces
 * put them at, and a test that pins drawn geometry should see the settled version.
 */
export function placeOne(w: World, limbs = 2, at: [number, number] = [50, 50], reserve = 50): number {
  const b = w.nIntr
  const quads = [0, 1, 2, 3].slice(0, Math.max(1, Math.min(4, limbs)))
  w.placeOrganism({
    brain: b,
    x: at[0],
    y: at[1],
    limbs: quads.map((q, i) => ({ idx: i, quad: q, angle: w.quadLo(q) + 0.3 })),
    // matter starts with zero energy now, so a placed body has to be endowed or it cannot pay for
    // its first move. Booked as injected, so the ledger still closes.
    reserve,
  })
  for (let t = 0; t < 20; t++) w.step()
  return b
}

/**
 * A world with the spontaneous bootstrap switched off.
 *
 * For tests that place their own organisms and need the brain slots to stay free. A loose brain that
 * can eat activates on its own, so in a world with food the slots fill with activated brains and
 * whatever the test wanted to place — a child, a germinating spore, a saved organism — has nowhere
 * to go. Measured: 40 of 40 slots taken, and with headroom 120 of 120.
 */
export function noBootstrap(init: Init): Init {
  return { ...init, laws: { ...init.laws, E_activate: 1e9 } }
}
