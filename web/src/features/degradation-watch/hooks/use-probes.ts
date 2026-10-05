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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import type { ProbePlan } from '../lib/probes'
import type { ApiResponse, DegradationWatchRecord } from '../types'

export interface ProbeLane {
  group: string
  model: string
  channel_id?: number
  channel_name?: string
  enabled: boolean
  public?: boolean
}
export interface ProbeHistory {
  id: string
  name: string
  kind: string
  enabled: boolean
  interval_minutes: number
  stats: {
    passed: number
    mismatched: number
    errors: number
    avg_elapsed_ms: number
    last_record_at: number
  }
  records: DegradationWatchRecord[]
  next_before: number
  artwork?: DegradationWatchRecord
}

async function getProbeData<T>(
  path: string,
  params?: Record<string, unknown>
): Promise<T> {
  const response = await api.get<ApiResponse<T>>(
    `/api/degradation_watch/${path}`,
    { params }
  )
  const result = requireServerSuccess(response.data)
  if (result.data === undefined) throw new Error('Missing probe data')
  return result.data
}

export function useProbePlan() {
  return useQuery({
    queryKey: ['degradation-watch', 'probe-plan'],
    queryFn: () =>
      getProbeData<ProbePlan & { configured?: boolean }>('probe-plan'),
  })
}

export function useSaveProbePlan() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (plan: ProbePlan) =>
      requireServerSuccess(
        (await api.put('/api/degradation_watch/probe-plan', plan)).data
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['degradation-watch'] })
    },
  })
}

export function useRunProbes() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (scope: {
      group?: string
      model?: string
      channel_id?: number
      probe_id?: string
    }) =>
      requireServerSuccess(
        (await api.post('/api/degradation_watch/probe-run', scope)).data
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['degradation-watch'] })
    },
  })
}

export function useProbeCatalog() {
  const user = useAuthStore((state) => state.auth.user)
  return useQuery({
    queryKey: ['degradation-watch', 'monitor', user?.id, user?.role],
    queryFn: () => getProbeData<{ lanes: ProbeLane[] }>('monitor'),
    refetchInterval: 15_000,
  })
}

export function useProbeHistory(
  lane: ProbeLane,
  days: number,
  enabled: boolean,
  probe = '',
  before = 0
) {
  const user = useAuthStore((state) => state.auth.user)
  return useQuery({
    queryKey: [
      'degradation-watch',
      'monitor',
      user?.id,
      user?.role,
      lane.group,
      lane.model,
      lane.channel_id,
      days,
      probe,
      before,
    ],
    enabled,
    gcTime: 120_000,
    queryFn: () =>
      getProbeData<{ probes: ProbeHistory[]; since: number }>('monitor', {
        group: lane.group,
        model: lane.model,
        channel_id: lane.channel_id,
        days,
        probe_id: probe,
        before,
      }),
    refetchInterval: (query) => {
      if (before > 0) return false
      return query.state.data?.probes.some((p) =>
        p.records.some((r) => ['running', 'queued'].includes(r.status ?? ''))
      )
        ? 1000
        : 5000
    },
  })
}
