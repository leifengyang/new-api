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
  GetInviteRebatesParams,
  GetInviteRebatesResponse,
  GetSelfInviteRebatesResponse,
} from './types'

// ============================================================================
// Invite Rebate Ledger (admin)
// ============================================================================

export async function getInviteRebates(
  params: GetInviteRebatesParams = {}
): Promise<GetInviteRebatesResponse> {
  const {
    p = 1,
    page_size = 20,
    keyword = '',
    source = '',
    status = '',
  } = params
  const queryParams = new URLSearchParams()
  queryParams.set('p', String(p))
  queryParams.set('page_size', String(page_size))
  if (keyword) queryParams.set('keyword', keyword)
  if (source) queryParams.set('source', source)
  if (status) queryParams.set('status', status)
  const res = await api.get(`/api/invite_rebate/?${queryParams.toString()}`)
  return res.data
}

// ============================================================================
// Invite Rebate Ledger (member's own view)
// ============================================================================

/**
 * The member's own rebates: the row list with masked downline names, the
 * cumulative totals shown on the wallet card, and the flags that decide
 * whether the rebate programme applies to this account at all.
 */
export async function getSelfInviteRebates(
  params: Pick<GetInviteRebatesParams, 'p' | 'page_size'> = {}
): Promise<GetSelfInviteRebatesResponse> {
  const { p = 1, page_size = 20 } = params
  const queryParams = new URLSearchParams()
  queryParams.set('p', String(p))
  queryParams.set('page_size', String(page_size))
  const res = await api.get(`/api/invite_rebate/self?${queryParams.toString()}`)
  return res.data
}

/**
 * Reverses a credited rebate. The reason is required: it lands in the ledger
 * row and in the management audit log, which is how a clawed-back payout stays
 * explainable later.
 */
export async function reverseInviteRebate(
  id: number,
  reason: string
): Promise<ApiResponse> {
  const res = await api.post('/api/invite_rebate/reverse', { id, reason })
  return res.data
}
