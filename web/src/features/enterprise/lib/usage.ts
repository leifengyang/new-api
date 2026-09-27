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
import dayjs from '@/lib/dayjs'

import type { EnterpriseUsageRange, EnterpriseUsageRow } from '../types'

/** 用量页默认看最近 7 天（含今天）。 */
export const USAGE_DEFAULT_DAYS = 7

/** 服务端 enterpriseUsageMaxSpanSeconds：一年的跨度上限。 */
export const USAGE_MAX_SPAN_SECONDS = 366 * 24 * 3600

/** 一条占比：份额是 0~1 的比值，展示时再交给 Intl 转成百分比。 */
export interface UsageShare {
  key: string
  quota: number
  share: number
}

export interface DailyUsagePoint {
  /** 本地时区的那一天，`YYYY-MM-DD`，直接当横轴标签用。 */
  date: string
  /** 该天 0 点的时间戳（秒）。 */
  timestamp: number
  quota: number
  count: number
}

/**
 * 汇总一组合计。额度是整数，直接相加不会有浮点误差。
 * 只读 `quota`，所以按成员的原始行和已算好的占比片都能直接传进来。
 */
export function sumUsageQuota(rows: readonly { quota: number }[]): number {
  let total = 0
  for (const row of rows) {
    total += row.quota
  }
  return total
}

/**
 * 按给定的键做占比。同键合并（成员改过名字时服务端会拆成两行）。
 * 总额为 0 时所有份额都是 0 —— 不能拿 0 当分母。
 */
export function buildUsageShares(
  rows: EnterpriseUsageRow[],
  keyOf: (row: EnterpriseUsageRow) => string
): UsageShare[] {
  const quotaByKey = new Map<string, number>()
  for (const row of rows) {
    const key = keyOf(row)
    quotaByKey.set(key, (quotaByKey.get(key) ?? 0) + row.quota)
  }

  const total = sumUsageQuota(rows)
  const shares: UsageShare[] = []
  for (const [key, quota] of quotaByKey) {
    shares.push({ key, quota, share: total > 0 ? quota / total : 0 })
  }
  // 占比相同（比如都是 0）时按键名排，保证每次渲染顺序一致。
  shares.sort((a, b) => b.quota - a.quota || a.key.localeCompare(b.key))
  return shares
}

/**
 * 饼图最多只画这么多片。模型数量没有上限，全画出来图例会把图挤没，也认不出
 * 谁是谁；多出来的合并成一片「其它」，合计仍然等于总额。
 */
export const MAX_SHARE_SLICES = 8

/**
 * 合并出来的那一片用的哨兵键。它不是真实模型名，展示前必须换成 t('Other')，
 * 所以刻意起得不像一个模型名，避免和真模型撞上。
 */
export const OTHER_SHARE_KEY = '__other__'

export function limitUsageShares(
  shares: UsageShare[],
  maxSlices = MAX_SHARE_SLICES,
  otherKey = OTHER_SHARE_KEY
): UsageShare[] {
  if (shares.length <= maxSlices) {
    return shares
  }
  // 片数上限里要留一个位置给「其它」。
  const kept = shares.slice(0, maxSlices - 1)
  const rest = shares.slice(maxSlices - 1)
  let quota = 0
  for (const entry of rest) {
    quota += entry.quota
  }
  return [
    ...kept,
    { key: otherKey, quota, share: rest.reduce((sum, e) => sum + e.share, 0) },
  ]
}

/**
 * 把服务端的小时桶折成本地时区的天。quota_data 的桶按 UTC 小时切，直接按
 * created_at 分组会和用户在界面上看到的日期错位，所以统一走 dayjs 的本地时区。
 *
 * 没有用量的天要补 0：趋势线断点会让人以为那天没数据，而实际是那天没人用。
 */
export function foldTrendToLocalDays(
  trend: EnterpriseUsageRow[],
  range: EnterpriseUsageRange,
  maxDays = 400
): DailyUsagePoint[] {
  const quotaByDay = new Map<string, { quota: number; count: number }>()
  for (const row of trend) {
    const day = dayjs.unix(row.created_at).startOf('day')
    const key = day.format('YYYY-MM-DD')
    const current = quotaByDay.get(key) ?? { quota: 0, count: 0 }
    current.quota += row.quota
    current.count += row.count
    quotaByDay.set(key, current)
  }

  const points: DailyUsagePoint[] = []
  const first = dayjs.unix(range.start).startOf('day')
  const last = dayjs.unix(range.end).startOf('day')
  let cursor = first
  // 时间窗上限一年，但脏数据或时区边界都可能让循环跑飞，这里加一道硬闸。
  while (!cursor.isAfter(last) && points.length < maxDays) {
    const key = cursor.format('YYYY-MM-DD')
    const bucket = quotaByDay.get(key)
    points.push({
      date: key,
      timestamp: cursor.unix(),
      quota: bucket?.quota ?? 0,
      count: bucket?.count ?? 0,
    })
    cursor = cursor.add(1, 'day')
  }
  return points
}

/** 至少有一条真实用量的天。空区间（比如今天还没人用）不能画成一条平的零线。 */
export function hasUsage(points: DailyUsagePoint[]): boolean {
  return points.some((point) => point.quota !== 0)
}

/** 默认区间：从今天 0 点往前数 6 天，到今天的最后一毫秒。 */
export function defaultUsageRange(now: Date = new Date()): {
  start: Date
  end: Date
} {
  const start = new Date(now)
  start.setDate(start.getDate() - (USAGE_DEFAULT_DAYS - 1))
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

export type UsageRangeResult =
  | { ok: true; range: EnterpriseUsageRange }
  | { ok: false; reason: 'incomplete' | 'invalid' }

/**
 * 时间选择器给的是 `Date`，接口要的是秒。两种情况分开报：
 *  - `incomplete`：只填了一头，属于「还没选完」，不该弹错误提示；
 *  - `invalid`：两头都有但起点不晚于终点（或超出服务端一年上限）。
 *    服务端会直接拒，所以这里就先拦下来说清楚，别让它白跑一趟。
 */
export function toUsageSeconds(range: {
  start?: Date
  end?: Date
}): UsageRangeResult {
  if (!range.start || !range.end) {
    return { ok: false, reason: 'incomplete' }
  }
  const start = Math.floor(range.start.getTime() / 1000)
  const end = Math.floor(range.end.getTime() / 1000)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return { ok: false, reason: 'invalid' }
  }
  if (end - start > USAGE_MAX_SPAN_SECONDS) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, range: { start, end } }
}
