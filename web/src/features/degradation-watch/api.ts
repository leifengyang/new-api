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
  DegradationWatchRecord,
  DegradationWatchRunResult,
  DegradationWatchWall,
} from './types'

export async function getDegradationWatchWall(): Promise<
  ApiResponse<DegradationWatchWall>
> {
  const res = await api.get('/api/degradation_watch/wall')
  return res.data
}

/** Older attempts of the same channel as `beforeId`, newest first. */
export async function getDegradationWatchRecords(
  beforeId: number,
  limit: number
): Promise<ApiResponse<DegradationWatchRecord[]>> {
  const res = await api.get('/api/degradation_watch/records', {
    params: { before: beforeId, limit },
  })
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

/** Queues one run; `channelId` limits it to a single channel. */
export async function runDegradationWatch(
  channelId?: number
): Promise<ApiResponse<DegradationWatchRunResult>> {
  const res = await api.post(
    '/api/degradation_watch/run',
    { channel_id: channelId ?? 0 },
    { validateStatus: (status) => status < 300 || status === 409 }
  )
  return res.data
}
