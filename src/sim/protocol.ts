import type { Perf } from '../compute/select'
import type { Init } from '../core/params'
import type { AggregateStats } from '../core/aggregates'
import type { Census, LifeStats } from '../core/metrics'
import type { LearnerStatus } from '../core/learning'
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
  /** Present only when a learner is running, so the rail can stay quiet otherwise. */
  learner?: LearnerStatus
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
