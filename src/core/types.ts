/** Particle type tags. Order matters: the matrix is indexed via MATRIX_INDEX. */
export const P1 = 0
export const P2 = 1
export const P3 = 2
export const P4 = 3
export const BRAIN = 4
export const FOOD = 5
/** Immovable terrain. Excludes everything by its core and is never integrated. */
export const WALL = 6
export const N_TYPES = 7

/**
 * Rows and columns in the chemistry matrix: P1..P4, Food, **and Brain**.
 *
 * Brain is appended at the *end* rather than slotted in at its type index, and that ordering is
 * load-bearing. The lower triangle is walked row-major, so putting Brain last leaves the first 14
 * entries — the P1..P4 and Food block — in exactly the positions they have always occupied. Every
 * spec in the existing catalog, every preset and every saved config therefore keeps its meaning,
 * and a 14-entry matrix simply leaves the six new Brain couplings at zero, which is the behaviour
 * those worlds were measured under.
 *
 * The cost of putting Brain in the matrix at all: it used to map to -1, so a brain had no
 * chemistry, could not bond, and was held apart by a hardcoded universal push instead. That made
 * the organism a template rather than an assembly. Now a brain can attract, repel and bond like
 * anything else.
 */
export const N_MATRIX = 6

/** The matter rows, P1..P4. The only block that is quantized; Food and Brain are scaled instead. */
export const N_MATTER = 4

/** Where Food and Brain sit. Named, because `N_MATRIX - 1` used to mean "Food" and now does not. */
export const FOOD_ROW = 4
export const BRAIN_ROW = 5

/**
 * Maps a particle type to its row in the chemistry matrix. Wall is -1: terrain has no chemistry,
 * excludes everything by its core, and is never integrated.
 */
export const MATRIX_INDEX: readonly number[] = [0, 1, 2, 3, BRAIN_ROW, FOOD_ROW, -1]

export const TYPE_NAMES: readonly string[] = ['P1', 'P2', 'P3', 'P4', 'Brain', 'Food', 'Wall']

/** Labels for the 6x6 matrix axes, in matrix order rather than type order. */
export const MATRIX_NAMES: readonly string[] = ['P1', 'P2', 'P3', 'P4', 'Food', 'Brain']
