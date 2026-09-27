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
import type { TFunction } from 'i18next'

/** 服务端 enterpriseLimitsMaxEntries：单个成员的白名单条目上限。 */
export const LIMITS_MAX_ENTRIES = 1000
/** 服务端 enterpriseModelNameMaxLength：与 token.model_limits 的列宽一致。 */
export const MODEL_NAME_MAX_LENGTH = 255

/**
 * 库里的白名单原文有三种状态，必须分开对待：
 *  - `unrestricted`：空列，什么都不限，最终范围就是平台允许的全部；
 *  - `restricted`：JSON 数组，最终范围是「平台允许 ∩ 这里列出的」；空数组是
 *    「什么都不放行」，是一个有意义的状态，不是「不限」；
 *  - `unreadable`：非空但解析不出来。服务端读侧对坏数据是 fail closed（当成
 *    空集拦下），所以这里也绝不能把它说成「不限」。
 */
export type StoredLimits =
  | { state: 'unrestricted' }
  | { state: 'restricted'; values: string[] }
  | { state: 'unreadable' }

export function parseStoredLimits(
  raw: string | null | undefined
): StoredLimits {
  if (raw === null || raw === undefined) {
    return { state: 'unrestricted' }
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { state: 'unrestricted' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { state: 'unreadable' }
  }
  if (!Array.isArray(parsed)) {
    return { state: 'unreadable' }
  }
  const values: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      return { state: 'unreadable' }
    }
    values.push(entry)
  }
  return { state: 'restricted', values }
}

/**
 * 把一份白名单压成表格里能看的一行。名字少就直接列出来，多了只报个数——模型
 * 白名单动辄几十上百条，全列出来会把行撑爆。
 */
export function formatLimitSummary(
  limits: StoredLimits,
  t: TFunction,
  maxNamed = 3
): string {
  if (limits.state === 'unrestricted') {
    return t('Unrestricted')
  }
  if (limits.state === 'unreadable') {
    return t('Invalid')
  }
  if (limits.values.length === 0) {
    return t('None')
  }
  if (limits.values.length <= maxNamed) {
    return limits.values.join(', ')
  }
  return t('{{count}} selected', { count: limits.values.length })
}

/**
 * 弹窗里的选择状态：要么「不受限」，要么「限为所选项」。后者允许空集，因为
 * 服务端把「限制到空集」当成一个合法状态（模型白名单可以一条都不放行）。
 */
export interface LimitSelection {
  unrestricted: boolean
  values: string[]
}

export function limitsToSelection(limits: StoredLimits): LimitSelection {
  if (limits.state === 'unrestricted') {
    return { unrestricted: true, values: [] }
  }
  if (limits.state === 'unreadable') {
    // 读不出来的列按服务端读侧的 fail closed 处理：什么都不放行，而不是放开。
    return { unrestricted: false, values: [] }
  }
  return { unrestricted: false, values: limits.values }
}

/** 提交给接口的形态：null 表示撤销限制，数组表示收窄到这些。 */
export function selectionToLimit(selection: LimitSelection): string[] | null {
  return selection.unrestricted ? null : selection.values
}
