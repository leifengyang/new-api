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

export type ChampionAward = {
  id: number
  user_id: number
  username: string
  spend: number
  position: number
  reason: string
  quota: number
  status: string
  credited_at: number
  read_at: number
  notice_seen_at: number
  equipped: number
}
export type ChampionPublicData = {
  status: string
  start_at: number
  end_at: number
  snapshot_at: number
  winners: { name: string; position: number; status: string }[]
}
export function hasChampionHonor(
  award: ChampionAward | null | undefined
): award is ChampionAward {
  return (
    !!award &&
    award.position > 0 &&
    ['claimable', 'credited', 'declined'].includes(award.status)
  )
}
export async function getChampionData<T>(
  path: string,
  params = {}
): Promise<T> {
  const response = await api.get<{ success: boolean; data: T }>(path, {
    params,
  })
  return requireServerSuccess(response.data).data
}
export function useChampionSelf() {
  const id = useAuthStore((s) => s.auth.user?.id)
  return useQuery({
    queryKey: ['champion-event', 'self', id],
    queryFn: () =>
      getChampionData<ChampionAward | null>('/api/user/champion-event'),
    enabled: !!id,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}
export function useChampionMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (action: {
      path?: string
      body: unknown
      method?: 'put' | 'post'
    }) => {
      const response = await api[action.method ?? 'put'](
        `/api/user/champion-event${action.path ?? ''}`,
        action.body
      )
      return requireServerSuccess(response.data)
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['champion-event'] })
    },
  })
}
