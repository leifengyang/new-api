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
  CreateEnterpriseMemberPayload,
  CreateEnterpriseMemberResult,
  EnterpriseApiResponse,
  EnterpriseMemberOptions,
  EnterpriseProfile,
  GetEnterpriseMembersParams,
  GetEnterpriseMembersResponse,
} from './types'

// 下面每个请求的服务端都把查询收窄到「操作者名下的成员」，路径上的 id 只是
// 选择器，不是授权依据：传别人的成员 id 会被服务端判为「不在你的企业名下」。

export async function getEnterpriseProfile(): Promise<
  EnterpriseApiResponse<EnterpriseProfile>
> {
  const res = await api.get('/api/enterprise/profile')
  return res.data
}

export async function getEnterpriseMembers(
  params: GetEnterpriseMembersParams = {}
): Promise<GetEnterpriseMembersResponse> {
  const { p = 1, page_size = 20, keyword = '', status = '' } = params
  const query = new URLSearchParams()
  query.set('p', String(p))
  query.set('page_size', String(page_size))
  if (keyword) query.set('keyword', keyword)
  if (status) query.set('status', status)
  const res = await api.get(`/api/enterprise/members?${query.toString()}`)
  return res.data
}

export async function createEnterpriseMember(
  payload: CreateEnterpriseMemberPayload
): Promise<EnterpriseApiResponse<CreateEnterpriseMemberResult>> {
  const res = await api.post('/api/enterprise/members', payload)
  return res.data
}

/** 候选项来自服务端：该成员当前能用的分组，以及这些分组下的现存模型。 */
export async function getEnterpriseMemberOptions(
  memberId: number
): Promise<EnterpriseApiResponse<EnterpriseMemberOptions>> {
  const res = await api.get(`/api/enterprise/members/${memberId}/options`)
  return res.data
}

export async function updateEnterpriseMemberStatus(
  memberId: number,
  enabled: boolean
): Promise<EnterpriseApiResponse<{ returned_quota: number }>> {
  const res = await api.put(`/api/enterprise/members/${memberId}/status`, {
    enabled,
  })
  return res.data
}

/**
 * 收窄成员的可用分组 / 可用模型。`null` 表示撤销限制（回到平台允许的全集），
 * 数组表示收窄到这些；两者语义不同，不能互相顶替。
 */
export async function updateEnterpriseMemberLimits(
  memberId: number,
  limits: { group_limits: string[] | null; model_limits: string[] | null }
): Promise<EnterpriseApiResponse> {
  const res = await api.put(
    `/api/enterprise/members/${memberId}/limits`,
    limits
  )
  return res.data
}

/** 从企业余额里划一笔额度给成员。额度是内部整数，换算由调用方负责。 */
export async function transferEnterpriseMemberQuota(
  memberId: number,
  quota: number
): Promise<EnterpriseApiResponse<{ transferred_quota: number }>> {
  const res = await api.post(`/api/enterprise/members/${memberId}/quota`, {
    quota,
  })
  return res.data
}

export async function resetEnterpriseMemberPassword(
  memberId: number,
  password: string
): Promise<EnterpriseApiResponse> {
  const res = await api.put(`/api/enterprise/members/${memberId}/password`, {
    password,
  })
  return res.data
}
