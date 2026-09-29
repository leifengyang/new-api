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
import { describe, expect, it } from 'vitest'

import { buildWallRows, flattenRounds } from '../lib/rounds'
import type {
  DegradationWatchLane,
  DegradationWatchRecord,
  DegradationWatchRound,
  DegradationWatchWall,
} from '../types'

function lane(model: string): DegradationWatchLane {
  return {
    model,
    reasoning_effort: '',
    enabled: true,
    configured: true,
    total: 0,
    succeeded: 0,
    visible: 0,
    avg_elapsed_ms: 0,
    last_record_at: 0,
  }
}

function record(id: number, model: string): DegradationWatchRecord {
  return { id, model_name: model, channel_title: `c${id}` } as DegradationWatchRecord
}

function round(key: string, records: DegradationWatchRecord[]): DegradationWatchRound {
  return { key, started_at: 0, records }
}

describe('buildWallRows', () => {
  it('places records under their model lane and leaves missing lanes empty', () => {
    const rows = buildWallRows(
      [lane('sol'), lane('luna'), lane('opus5')],
      [round('r1', [record(1, 'luna'), record(2, 'sol'), record(3, 'luna')])]
    )

    expect(rows[0].cells.map((cell) => cell.map((item) => item.id))).toEqual([
      [2],
      [1, 3],
      [],
    ])
  })

  it('drops records whose model has no lane', () => {
    const rows = buildWallRows([lane('sol')], [round('r1', [record(1, 'gone')])])

    expect(rows[0].cells).toEqual([[]])
  })
})

describe('flattenRounds', () => {
  it('keeps the first copy when a refetch repeats a round across pages', () => {
    const page = (rounds: DegradationWatchRound[]) =>
      ({ rounds }) as DegradationWatchWall
    const rounds = flattenRounds([
      page([round('b', []), round('a', [record(1, 'sol')])]),
      page([round('a', []), round('z', [])]),
    ])

    expect(rounds.map((item) => item.key)).toEqual(['b', 'a', 'z'])
    expect(rounds[1].records).toHaveLength(1)
  })
})
