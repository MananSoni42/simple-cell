import type { Laws } from './params'

/**
 * Radial pair force at distance r. Positive = attraction.
 * `r0` is the pair's exclusion radius (see `coreRadius`), `k` its strength.
 */
export function pairForce(r: number, a: number, L: Laws, r0 = L.beta * L.r_c, k = L.K_core): number {
  if (r >= L.r_c) return 0
  if (r < r0) return k * (r / r0 - 1)
  const beta = r0 / L.r_c
  const u = r / L.r_c
  return a * (1 - Math.abs(2 * u - 1 - beta) / (1 - beta))
}

/** Pair potential with U(r_c) = 0 and F = -dU/dr. Exact: F is piecewise linear. */
export function pairPotential(r: number, a: number, L: Laws, r0 = L.beta * L.r_c, k = L.K_core): number {
  const rc = L.r_c
  const bp = [0, r0, (r0 + rc) / 2, rc]
  let U = 0
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(bp[i], r)
    const hi = bp[i + 1]
    if (hi <= lo) continue
    U -= 0.5 * (pairForce(lo, a, L, r0, k) + pairForce(hi, a, L, r0, k)) * (hi - lo)
  }
  return U
}
