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
import type { UsageLog } from '@/features/usage-logs/data/schema'

// ============================================================================
// API envelopes
// ============================================================================

/** 与后端 common.ApiSuccess / common.ApiErrorMsg 对应的响应外壳。 */
export interface EnterpriseApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

// ============================================================================
// Enterprise account
// ============================================================================

export interface EnterpriseProfile {
  id: number
  username: string
  display_name: string
  quota: number
  used_quota: number
  member_count: number
  /** 后台可调（系统设置 → 企业账号），不是常量。 */
  member_limit: number
  /** 企业账号的推广码，同时就是成员邀请码。 */
  invite_code: string
}

// ============================================================================
// Members
// ============================================================================

export interface EnterpriseMember {
  id: number
  username: string
  display_name: string
  status: number
  enterprise_quota?: number
  enterprise_frozen_quota?: number
  quota: number
  used_quota: number
  request_count: number
  group: string
  /**
   * 库里存的白名单原文（JSON 数组文本）。空串表示「不限」。列表接口按原样返回，
   * 前端用 lib/limits.ts 的 parseStoredLimits 解析，保证列表和弹窗读的是同一份
   * 数据、同一套语义。
   */
  enterprise_group_limits: string
  enterprise_model_limits: string
  created_at: number
  last_login_at: number
}

export interface GetEnterpriseMembersParams {
  p?: number
  page_size?: number
  keyword?: string
  /** 空串表示不过滤。 */
  status?: string
}

export type GetEnterpriseMembersResponse = EnterpriseApiResponse<{
  page: number
  page_size: number
  total: number
  items: EnterpriseMember[]
}>

export interface CreateEnterpriseMemberPayload {
  username: string
  password: string
  display_name?: string
  remark?: string
}

export interface CreateEnterpriseMemberResult {
  id: number
  username: string
}

/**
 * 设置成员可见范围时的候选项。候选项本身就是「平台允许」的集合，企业只能在
 * 其中做减法，所以服务端直接把该成员当前可用的全集给出来。
 */
export interface EnterpriseMemberOptions {
  groups: Array<{ name: string; desc: string }>
  models: string[]
  models_by_group?: Record<string, string[]>
  member_group: string
  member_enabled: boolean
}

// ============================================================================
// Usage（用量板块）
// ============================================================================

/** 秒级时间戳区间，与服务端的 start_timestamp / end_timestamp 对齐。 */
export interface EnterpriseUsageRange {
  start: number
  end: number
}

/**
 * 一条聚合结果。三个聚合（按模型 / 按成员 / 按小时）共用这个形状，只有被分组的
 * 那几个字段有值：按模型时是 `model_name`，按成员时是 `user_id`+`username`，
 * 趋势里是 `created_at`。
 */
export interface EnterpriseUsageRow {
  user_id: number
  username: string
  model_name: string
  /** 趋势里是 quota_data 自带的小时桶起点。 */
  created_at: number
  count: number
  quota: number
  token_used: number
}

export type EnterpriseUsageResponse = EnterpriseApiResponse<{
  /**
   * 平台的用量看板关掉时 quota_data 根本不落库。false 时界面必须明说统计已关闭，
   * 不能把「没数据」显示成一排 0。
   */
  data_export_enabled: boolean
  by_model: EnterpriseUsageRow[]
  by_member: EnterpriseUsageRow[]
  trend: EnterpriseUsageRow[]
}>

// ============================================================================
// Member logs（成员日志）
// ============================================================================

export interface GetEnterpriseLogsParams {
  p?: number
  page_size?: number
  /** 字符串形式的日志类型，空串表示全部。 */
  type?: string
  model_name?: string
  group?: string
  start_timestamp: number
  end_timestamp: number
}

export type GetEnterpriseLogsResponse = EnterpriseApiResponse<{
  page: number
  page_size: number
  total: number
  items: UsageLog[]
  /** 本次筛选下所有成员的消费合计，不只是当前这一页。 */
  quota_total: number
}>
