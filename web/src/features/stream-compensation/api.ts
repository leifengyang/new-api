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

export const compensationPath = '/api/user/stream-compensation'
export type Compensation = {
  id: number
  batch_id: number
  user_id: number
  request_id: string
  model_name: string
  consumed_at: number
  original_quota: number
  quota: number
  reason: string
  status: string
  note: string
  credited_at: number
}
export type CompensationMessage = {
  id: number
  batch_id: number
  quota: number
  count: number
  start_at: number
  end_at: number
  created_at: number
  read_at: number
  revision: number
}
export type CompensationBatch = {
  id: number
  start_at: number
  end_at: number
  status: string
  scanned: number
  error: string
  created_at: number
  completed_at: number
}
export type Page<T> = { items: T[]; total: number }
export type CompensationPage = Page<Compensation> & {
  totals: { original_quota: number; credited_quota: number; net_quota: number }
}
export async function getCompensationData<T>(
  path: string,
  params: Record<string, string | number | boolean> = {}
): Promise<T> {
  const response = await api.get<{
    success: boolean
    message?: string
    data: T
  }>(compensationPath + path, { params })
  return requireServerSuccess(response.data).data
}
export async function changeCompensation(
  path: string,
  body: unknown = {},
  method: 'post' | 'put' = 'post'
) {
  const response = await api[method](compensationPath + path, body)
  return requireServerSuccess(response.data)
}
export function useCompensationMessages(
  unread = false,
  page = 0,
  pageSize = 10
) {
  const userID = useAuthStore((s) => s.auth.user?.id)
  return useQuery({
    queryKey: [
      'stream-compensation',
      userID,
      'messages',
      unread,
      page,
      pageSize,
    ],
    queryFn: () =>
      getCompensationData<Page<CompensationMessage>>('/messages', {
        unread,
        p: page + 1,
        page_size: pageSize,
      }),
    enabled: !!userID,
    refetchInterval: 60_000,
  })
}
export function useCompensationMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (action: {
      path: string
      body?: unknown
      method?: 'post' | 'put'
    }) => changeCompensation(action.path, action.body, action.method),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['stream-compensation'] })
    },
  })
}
