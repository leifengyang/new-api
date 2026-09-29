/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type {
  DegradationWatchLane,
  DegradationWatchRecord,
  DegradationWatchRound,
  DegradationWatchWall,
} from '../types'

export const WALL_ROUNDS_PER_PAGE = 10

export interface WallRow {
  key: string
  startedAt: number
  /** One entry per lane, in lane order; an empty array means no attempt. */
  cells: DegradationWatchRecord[][]
}

/**
 * Flattens the loaded pages into rows. A refetch can shift round boundaries
 * between pages, so rows are de-duplicated by key, keeping the first seen.
 */
export function flattenRounds(
  pages: DegradationWatchWall[]
): DegradationWatchRound[] {
  const seen = new Set<string>()
  const rounds: DegradationWatchRound[] = []
  for (const page of pages) {
    for (const round of page.rounds) {
      if (seen.has(round.key)) continue
      seen.add(round.key)
      rounds.push(round)
    }
  }
  return rounds
}

/** Lays each round's records out under the lane of their model. */
export function buildWallRows(
  lanes: DegradationWatchLane[],
  rounds: DegradationWatchRound[]
): WallRow[] {
  const laneIndex = new Map(lanes.map((lane, index) => [lane.model, index]))
  return rounds.map((round) => {
    const cells: DegradationWatchRecord[][] = lanes.map(() => [])
    for (const record of round.records) {
      const index = laneIndex.get(record.model_name)
      if (index !== undefined) cells[index].push(record)
    }
    return { key: round.key, startedAt: round.started_at, cells }
  })
}
