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

export const groupSchema = z.object({
  id: z.number(),
  name: z.string().trim().min(1).max(128),
  base_url: z.string().url().max(1024),
  model: z.string().trim().min(1).max(128),
  protocol: z.enum(['chat', 'responses']),
  effort: z.string(),
  api_key: z.string().max(8192),
  remember_key: z.boolean(),
  has_saved_key: z.boolean(),
})
export const comparisonSchema = z.object({
  groups: z.array(groupSchema).min(1).max(10),
  prompt: z.string().trim().min(1).max(32000),
  concurrency: z.number().int().min(1).max(10),
  timeout_seconds: z.number().int().min(60).max(3600),
})
export type TestGroup = z.infer<typeof groupSchema>
export type ComparisonInput = z.infer<typeof comparisonSchema>
export interface ComparisonRound {
  id: number
  prompt: string
  concurrency: number
  timeout_seconds: number
  status: 'running' | 'completed'
  created_at: number
}
export interface ComparisonAttempt {
  id: number
  round_id: number
  group_index: number
  attempt: number
  profile_id: number
  name: string
  base_url: string
  model: string
  protocol: 'chat' | 'responses'
  effort: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  output: string
  html: string
  error: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  tokens_estimated: boolean
  elapsed_ms: number
  first_token_ms: number
  created_at: number
  started_at: number
}
export interface ComparisonDetail {
  round: ComparisonRound
  attempts: ComparisonAttempt[]
}

export function newTestGroup(): TestGroup {
  return {
    id: 0,
    name: '',
    base_url: '',
    model: '',
    protocol: 'chat',
    effort: 'medium',
    api_key: '',
    remember_key: false,
    has_saved_key: false,
  }
}

export async function comparisonRequest<T>(
  path: string,
  method: 'get' | 'post' | 'put' = 'get',
  data?: unknown
): Promise<T> {
  const res = await api.request<{
    success: boolean
    message?: string
    data: T
  }>({ url: `/api/degradation_watch/self-test${path}`, method, data })
  if (!res.data.success) throw createServerError(res.data)
  return res.data.data
}

export function latestComparisonAttempts(attempts: ComparisonAttempt[]) {
  const groups = new Map<number, ComparisonAttempt>()
  for (const attempt of attempts) {
    const previous = groups.get(attempt.group_index)
    if (!previous || attempt.attempt > previous.attempt) {
      groups.set(attempt.group_index, attempt)
    }
  }
  return [...groups.values()].sort((a, b) => a.group_index - b.group_index)
}

export function comparisonRecord(attempt: ComparisonAttempt) {
  return {
    id: 0,
    model_name: attempt.model,
    reasoning_effort: attempt.effort,
    channel_title: attempt.name,
    aliased: false,
    success: attempt.status === 'succeeded',
    failure_reason: attempt.error,
    error_details: attempt.error,
    status: attempt.status,
    elapsed_ms: attempt.elapsed_ms,
    prompt_tokens: attempt.input_tokens,
    completion_tokens: attempt.output_tokens,
    reasoning_tokens: attempt.reasoning_tokens,
    tokens_estimated: attempt.tokens_estimated,
    hidden: false,
    created_at: attempt.created_at,
  }
}
