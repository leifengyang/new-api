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
import { z } from 'zod'

import { api } from '@/lib/api'
import { createServerError } from '@/lib/server-error-message'

import type { ComparisonAttempt } from './comparison'

export interface TemporaryMonitor {
  id: number
  name: string
  base_url: string
  model: string
  protocol: 'chat' | 'responses' | 'anthropic'
  text_effort?: string
  drawing_effort?: string
  max_output_tokens?: number | null
  has_saved_key?: boolean
  status: 'running' | 'completed' | 'stopped'
  created_at: number
  ends_at: number
  drawing_prompt: string
  text_prompt: string
  text_expected: string
  text_intermediate_expected?: string | null
  text_disabled: boolean
  drawing_disabled: boolean
  text_interval_minutes: number
  drawing_interval_minutes: number
}
export const temporaryProbeSchema = z.object({
  enabled: z.boolean(),
  interval_minutes: z.number().int().min(1).max(1440),
})
export type TemporaryProbeSettings = z.infer<typeof temporaryProbeSchema>
export const temporaryPromptSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  expected: z.string().trim().max(2000),
  intermediate_expected: z.string().trim().max(2000).optional(),
})
export type TemporaryPromptInput = z.infer<typeof temporaryPromptSchema>
export interface MonitorAttempt extends ComparisonAttempt {
  kind: 'text' | 'drawing'
  verdict: string
  phase?: string
  subject?: string
  original_prompt?: string
  expected?: string
  intermediate_expected?: string
  rewrite_prompt?: string
  preparation?: ComparisonAttempt
}
export interface MonitorHistory {
  monitor: TemporaryMonitor
  attempts: MonitorAttempt[]
  stats: { verdict: string; status: string; count: number }[]
  next_before: number
  text_prompt: string
  expected: string
}
export async function monitorRequest<T>(
  path: string,
  method: 'get' | 'post' | 'put' | 'delete' = 'get',
  data?: unknown
): Promise<T> {
  const res = await api.request<{
    success: boolean
    message?: string
    data: T
  }>({ url: `/api/degradation_watch/temporary-monitors${path}`, method, data })
  if (!res.data.success) throw createServerError(res.data)
  return res.data.data
}
export const monitorResultSource = {
  key: 'temporary-monitor',
  loadAttempt: (id: number) =>
    monitorRequest<MonitorAttempt>(`/attempts/${id}`),
}
