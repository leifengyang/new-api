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
import { expect, test } from 'vitest'

import {
  formatLimitSummary,
  limitsToSelection,
  parseStoredLimits,
  selectionToLimit,
} from '../limits'

// 只实现被测代码真正用到的两条：原样透传的键，和带 {{count}} 的那条。
const t = ((key: string, options?: Record<string, unknown>) =>
  key === '{{count}} selected'
    ? `${options?.count} selected`
    : key) as unknown as TFunction

test('an absent, null or blank column means the member is unrestricted', () => {
  expect(parseStoredLimits(undefined)).toEqual({ state: 'unrestricted' })
  expect(parseStoredLimits(null)).toEqual({ state: 'unrestricted' })
  expect(parseStoredLimits('')).toEqual({ state: 'unrestricted' })
  expect(parseStoredLimits('   ')).toEqual({ state: 'unrestricted' })
})

test('a stored JSON array is read back as a restriction', () => {
  expect(parseStoredLimits('["vip","default"]')).toEqual({
    state: 'restricted',
    values: ['vip', 'default'],
  })
})

// 空数组是「什么都不放行」，与空列「什么都不限」是两件事，绝不能合并成一种。
test('an empty stored array stays distinct from an unrestricted column', () => {
  expect(parseStoredLimits('[]')).toEqual({ state: 'restricted', values: [] })
})

test.each([
  ['not json at all'],
  ['{"vip":true}'],
  ['"vip"'],
  ['[1,2]'],
  ['["vip",null]'],
])('unparseable column %s is reported as unreadable', (raw) => {
  expect(parseStoredLimits(raw)).toEqual({ state: 'unreadable' })
})

test('summaries name the values when there are only a few', () => {
  expect(formatLimitSummary({ state: 'unrestricted' }, t)).toBe('Unrestricted')
  expect(formatLimitSummary({ state: 'restricted', values: [] }, t)).toBe(
    'None'
  )
  expect(
    formatLimitSummary({ state: 'restricted', values: ['vip', 'default'] }, t)
  ).toBe('vip, default')
})

// 模型白名单可能有上百条，列出来会把表格行撑爆，超过阈值只报个数。
test('summaries collapse long lists to a count', () => {
  expect(
    formatLimitSummary({ state: 'restricted', values: ['a', 'b', 'c', 'd'] }, t)
  ).toBe('4 selected')
  expect(
    formatLimitSummary(
      { state: 'restricted', values: ['a', 'b', 'c', 'd', 'e'] },
      t,
      5
    )
  ).toBe('a, b, c, d, e')
})

test('an unreadable column is never reported as unrestricted', () => {
  expect(formatLimitSummary({ state: 'unreadable' }, t)).toBe('Invalid')
  expect(limitsToSelection({ state: 'unreadable' })).toEqual({
    unrestricted: false,
    values: [],
  })
})

test('a selection round-trips back into the stored shape', () => {
  const restricted = parseStoredLimits('["vip"]')
  expect(limitsToSelection(restricted)).toEqual({
    unrestricted: false,
    values: ['vip'],
  })
  expect(selectionToLimit(limitsToSelection(restricted))).toEqual(['vip'])

  const open = parseStoredLimits('')
  expect(limitsToSelection(open)).toEqual({ unrestricted: true, values: [] })
  expect(selectionToLimit(limitsToSelection(open))).toBeNull()

  // 空集保存回去仍然是空集，不会被悄悄放大成「不限」。
  expect(selectionToLimit({ unrestricted: false, values: [] })).toEqual([])
})
