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
import { api } from '@/lib/api'

import type {
  ApiResponse,
  DegradationWatchChannels,
  DegradationWatchPrompt,
  DegradationWatchRunResult,
  DegradationWatchRunScope,
  DegradationWatchWall,
  DegradationWatchRecord,
} from './types'

/** One page of rounds, newest first; `before` is the previous page's `next_before`. */
export async function getDegradationWatchWall(params: {
  before?: number
  rounds?: number
  catalog?: boolean
}): Promise<ApiResponse<DegradationWatchWall>> {
  const res = await api.get('/api/degradation_watch/wall', {
    params: {
      before: params.before ?? 0,
      rounds: params.rounds,
      catalog: params.catalog,
    },
  })
  return res.data
}

export async function getDegradationWatchHistory(
  model: string,
  before: number
): Promise<
  ApiResponse<{ records: DegradationWatchRecord[]; next_before: number }>
> {
  const res = await api.get('/api/degradation_watch/wall', {
    params: { model, before, rounds: 4 },
  })
  return res.data
}

export async function getDegradationWatchRecord(id: number): Promise<
  ApiResponse<{
    record: DegradationWatchRecord
    output: string
    prompt?: string
    expected?: string
    match?: string
  }>
> {
  const res = await api.get(`/api/degradation_watch/records/${id}`)
  return res.data
}

export async function getDegradationWatchActivity(): Promise<
  ApiResponse<{
    task: { task_id: string; status: string; error: string } | null
    records: DegradationWatchRecord[]
  }>
> {
  const res = await api.get('/api/degradation_watch/activity')
  return res.data
}

export async function getDegradationWatchRecordHtml(
  id: number
): Promise<ApiResponse<{ html: string }>> {
  const res = await api.get(`/api/degradation_watch/records/${id}/html`)
  return res.data
}

export async function getDegradationWatchPrompt(): Promise<
  ApiResponse<DegradationWatchPrompt>
> {
  const res = await api.get('/api/degradation_watch/prompt')
  return res.data
}

export async function setDegradationWatchRecordHidden(
  id: number,
  hidden: boolean
): Promise<ApiResponse> {
  const res = await api.put(`/api/degradation_watch/records/${id}/hidden`, {
    hidden,
  })
  return res.data
}

export async function getDegradationWatchChannels(): Promise<
  ApiResponse<DegradationWatchChannels>
> {
  const res = await api.get('/api/degradation_watch/channels')
  return res.data
}

/** Queues one run, optionally limited to one target and one channel. */
export async function runDegradationWatch(
  scope: DegradationWatchRunScope
): Promise<ApiResponse<DegradationWatchRunResult>> {
  const res = await api.post(
    '/api/degradation_watch/run',
    { channel_id: scope.channelId ?? 0, model: scope.model ?? '' },
    { validateStatus: (status) => status < 300 || status === 409 }
  )
  return res.data
}
