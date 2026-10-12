import type { Perf } from '../compute/select'
import type { Init } from '../core/params'
import type { AggregateStats } from '../core/aggregates'
import type { Census, LifeStats } from '../core/metrics'
import type { FitnessSpec } from '../core/fitness'
import type { Ladder } from '../core/ladder'
import type { LearnAlgo, LearnerStatus } from '../core/learning'
import type { OrganismFile } from '../core/organism'
import type { RunRecord } from '../core/recorder'
import type { OrderStats } from '../core/orders'
import type { FrameBuffers, FrameLayout } from './frames'

export type ToSim =
  | { kind: 'start'; init: Init; perf: Perf }
  | { kind: 'rewind'; ticks: number } // step back to the newest snapshot at least this far back
  | { kind: 'seek'; tick: number }
  | { kind: 'feed'; x: number; y: number; n: number; radius: number }
  | { kind: 'inspect'; x: number; y: number }
  | { kind: 'placeSaved'; organism: OrganismFile; at?: [number, number] }
  | { kind: 'placeRandom'; x: number; y: number }
  | { kind: 'wall'; x: number; y: number }
  | { kind: 'erase'; x: number; y: number; radius: number }
  | { kind: 'snapshotConfig' } // hand back the world as a config, with everything placed in it
  | { kind: 'finish' } // end the run and hand back everything needed for the summary
  | { kind: 'rate'; rate: number }
  | { kind: 'pause'; paused: boolean }
  | { kind: 'step' }
  | { kind: 'mark' } // remember the world, so the edit about to happen can be undone
  | { kind: 'undo' }
  /** Change what counts as doing well, mid-run. The learner re-scores rather than restarting. */
  | { kind: 'setFitness'; spec: FitnessSpec }
  /** Change the learner itself, mid-run. This one does start over, and says so. */
  | { kind: 'setLearner'; algo: LearnAlgo }
  /** Release held food colonies: the populations start closing from this tick. */
  | { kind: 'merge' }

export interface StatsSnapshot {
  tick: number
  seed: number
  size: number
  foodMode: string
  foodMoves: boolean
  T: number
  cap: number
  backend: string
  tps: number
  census: Census
  life: LifeStats
  aggregates: AggregateStats
  bondCount: number
  orders: OrderStats
  clampedPct: number
  /** Ticks of history held, and the oldest tick we can rewind to. */
  historyTicks: number
  oldestTick: number // how often the per-tick step guardrail bit
  burned: number
  births: number
  budded: number
  deaths: number
  recordAge: number
  /** Always present: a rail that cannot say "nothing is learning" is worse than one that can. */
  learner: LearnerStatus
  learnAlgo: LearnAlgo
  /** The last few changes of measure, so a run can show that its objective moved. */
  fitnessChanges: { tick: number; measure: string }[]
  /** How far up the ladder of milestones this world has got. */
  ladder: Ladder
  /** Set only for a merged world: what its islands were called. */
  islandNames?: string[]
  /** How far the colonies have closed, or null while they are held apart waiting to be released. */
  mergeProgress: number | null
  /** True when this world has colonies that can be brought together at all. */
  canMerge: boolean
}

export interface RunReport {
  record: RunRecord
  organisms: OrganismFile[]
  notable: { label: string; organism: OrganismFile }[]
}

export type FromSim =
  | { kind: 'organism'; organism: OrganismFile | null }
  | { kind: 'builtConfig'; init: Init }
  | { kind: 'finished'; report: RunReport }
  | { kind: 'ready'; layout: FrameLayout; frames: FrameBuffers[]; header: Int32Array; note: string }
  | { kind: 'stats'; stats: StatsSnapshot }
  | { kind: 'error'; message: string }
  /** How many edits can still be taken back, so the Undo control can tell the truth. */
  | { kind: 'undoDepth'; depth: number }
