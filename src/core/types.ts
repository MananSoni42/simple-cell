/** Particle type tags. Order matters: the matrix is indexed via MATRIX_INDEX. */
export const P1 = 0
export const P2 = 1
export const P3 = 2
export const P4 = 3
export const BRAIN = 4
export const FOOD = 5
export const N_TYPES = 6

/** Number of rows/cols in the chemistry matrix: P1..P4 plus Food. */
export const N_MATRIX = 5

/**
 * Maps a particle type to its row in the chemistry matrix.
 * BRAIN is -1: it has no chemistry, so bodies interact only via the hard core.
 */
export const MATRIX_INDEX: readonly number[] = [0, 1, 2, 3, -1, 4]

export const TYPE_NAMES: readonly string[] = ['P1', 'P2', 'P3', 'P4', 'Brain', 'Food']

/** Labels for the 5x5 matrix axes. */
export const MATRIX_NAMES: readonly string[] = ['P1', 'P2', 'P3', 'P4', 'Food']
