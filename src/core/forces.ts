import type { Laws } from './params'

/**
 * Radial pair force at distance r. Positive = attraction.
 * `r0` is the pair's exclusion radius (see `coreRadius`), `k` its strength.
 */
export function pairForce(r: number, a: number, L: Laws, r0 = L.beta * L.r_c, k = L.K_core): number {
  if (r >= L.r_c) return 0
  // Diverges as r -> 0. A linear core is bounded, so enough attracting neighbours can out-pull
  // it and squeeze particles into the same point; this cannot be out-summed.
  if (r < r0) return k * (1 - r0 / Math.max(r, r0 * 1e-3))
  const beta = r0 / L.r_c
  const u = r / L.r_c
  return a * (1 - Math.abs(2 * u - 1 - beta) / (1 - beta))
}

/**
 * Pair potential with U(r_c) = 0 and F = -dU/dr. The tent is piecewise linear (trapezoids are
 * exact); the core is integrated analytically.
 */
export function pairPotential(r: number, a: number, L: Laws, r0 = L.beta * L.r_c, k = L.K_core): number {
  const rc = L.r_c
  let U = 0
  const bp = [r0, (r0 + rc) / 2, rc]
  for (let i = 0; i < 2; i++) {
    const lo = Math.max(bp[i], r)
    const hi = bp[i + 1]
    if (hi <= lo) continue
    U -= 0.5 * (pairForce(lo, a, L, r0, k) + pairForce(hi, a, L, r0, k)) * (hi - lo)
  }
  if (r < r0) {
    const rr = Math.max(r, r0 * 1e-3)
    U += k * (r0 * Math.log(r0 / rr) - (r0 - rr))
  }
  return U
}
