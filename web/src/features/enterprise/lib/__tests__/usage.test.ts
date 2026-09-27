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
import { expect, test } from 'vitest'

import dayjs from '@/lib/dayjs'

import type { EnterpriseUsageRow } from '../../types'
import {
  OTHER_SHARE_KEY,
  buildUsageShares,
  defaultUsageRange,
  foldTrendToLocalDays,
  hasUsage,
  limitUsageShares,
  sumUsageQuota,
  toUsageSeconds,
} from '../usage'

function usageRow(
  fields: Partial<EnterpriseUsageRow> & { quota: number }
): EnterpriseUsageRow {
  return {
    user_id: 0,
    username: '',
    model_name: '',
    created_at: 0,
    count: 0,
    token_used: 0,
    ...fields,
  }
}

// 桶的时间点用 dayjs 从「本地某天 0 点」推出来，这样断言在任何时区下都成立，
// 不用把测试绑死在运行机器的时区上。
const localMidnight = dayjs.unix(1700000000).startOf('day')
const hourAt = (offsetHours: number) =>
  localMidnight.add(offsetHours, 'hour').unix()
const dayLabel = (offsetDays: number) =>
  localMidnight.add(offsetDays, 'day').format('YYYY-MM-DD')

test('usage totals add up the raw quota and treat an empty list as zero', () => {
  expect(sumUsageQuota([])).toBe(0)
  expect(
    sumUsageQuota([
      usageRow({ quota: 100 }),
      usageRow({ quota: 250 }),
      usageRow({ quota: 0 }),
    ])
  ).toBe(350)
})

// 成员改过名字时服务端会把同一个人拆成两行，占比必须按 key 合并后再算。
test('shares merge rows that carry the same key', () => {
  const shares = buildUsageShares(
    [
      usageRow({ model_name: 'gpt-4o', quota: 100 }),
      usageRow({ model_name: 'gpt-4o', quota: 100 }),
      usageRow({ model_name: 'claude', quota: 200 }),
    ],
    (row) => row.model_name
  )

  // 两边的合计一样，按 key 排序所以 claude 在前。
  expect(shares).toEqual([
    { key: 'claude', quota: 200, share: 0.5 },
    { key: 'gpt-4o', quota: 200, share: 0.5 },
  ])
})

// 一点用量都没有时不能拿 0 当分母：份额一律是 0，不是 NaN。
test('shares are zero rather than NaN when the total is zero', () => {
  const shares = buildUsageShares(
    [usageRow({ model_name: 'gpt-4o', quota: 0 })],
    (row) => row.model_name
  )

  expect(shares).toEqual([{ key: 'gpt-4o', quota: 0, share: 0 }])
})

// 额度相同的两项排序必须稳定，否则每次渲染图例都会跳。
test('equal quotas are ordered by key so the order never jumps', () => {
  const shares = buildUsageShares(
    [
      usageRow({ model_name: 'zeta', quota: 50 }),
      usageRow({ model_name: 'alpha', quota: 50 }),
    ],
    (row) => row.model_name
  )

  expect(shares.map((entry) => entry.key)).toEqual(['alpha', 'zeta'])
})

test('hourly buckets that fall on the same local day are folded together', () => {
  const points = foldTrendToLocalDays(
    [
      usageRow({ created_at: hourAt(1), quota: 100, count: 1 }),
      usageRow({ created_at: hourAt(23), quota: 200, count: 2 }),
      usageRow({ created_at: hourAt(25), quota: 400, count: 4 }),
    ],
    { start: hourAt(1), end: hourAt(25) }
  )

  expect(points).toEqual([
    {
      date: dayLabel(0),
      timestamp: localMidnight.unix(),
      quota: 300,
      count: 3,
    },
    {
      date: dayLabel(1),
      timestamp: localMidnight.add(1, 'day').unix(),
      quota: 400,
      count: 4,
    },
  ])
})

// 没有人用的那天要补一个 0，否则趋势线会断在那里，看起来像数据丢了。
test('days without usage are filled with zero instead of being skipped', () => {
  const points = foldTrendToLocalDays(
    [usageRow({ created_at: hourAt(0), quota: 100 })],
    { start: hourAt(0), end: hourAt(48) }
  )

  expect(points.map((point) => point.quota)).toEqual([100, 0, 0])
  expect(points.map((point) => point.date)).toEqual([
    dayLabel(0),
    dayLabel(1),
    dayLabel(2),
  ])
})

// 时间窗上限一年，但循环仍要有硬闸：脏数据不该让渲染卡死。
test('the day walk stops at the safety cap', () => {
  const points = foldTrendToLocalDays(
    [],
    { start: hourAt(0), end: hourAt(240) },
    2
  )

  expect(points).toHaveLength(2)
})

test('a series is reported as having usage only when some day is non-zero', () => {
  expect(hasUsage([])).toBe(false)
  expect(
    hasUsage(foldTrendToLocalDays([], { start: hourAt(0), end: hourAt(24) }))
  ).toBe(false)
  expect(
    hasUsage(
      foldTrendToLocalDays([usageRow({ created_at: hourAt(0), quota: 1 })], {
        start: hourAt(0),
        end: hourAt(24),
      })
    )
  ).toBe(true)
})

test('few enough slices are passed through untouched', () => {
  const shares = buildUsageShares(
    [
      usageRow({ model_name: 'a', quota: 3 }),
      usageRow({ model_name: 'b', quota: 2 }),
    ],
    (row) => row.model_name
  )

  expect(limitUsageShares(shares)).toEqual(shares)
})

// 合并成「其它」之后总额不能变，否则饼图会少一块。
test('overflowing slices collapse into a single remainder slice', () => {
  const shares = buildUsageShares(
    ['a', 'b', 'c', 'd'].map((key, index) =>
      usageRow({ model_name: key, quota: 10 - index })
    ),
    (row) => row.model_name
  )

  const limited = limitUsageShares(shares, 3)

  expect(limited.map((entry) => entry.key)).toEqual(['a', 'b', OTHER_SHARE_KEY])
  expect(sumUsageQuota(limited)).toBe(sumUsageQuota(shares))
  // 10 + 9 + 8 + 7 = 34，留下 a、b，剩下 15 归到合并片。
  expect(limited[2].quota).toBe(15)
  expect(limited[2].share).toBeCloseTo(15 / 34, 10)
})

test('the default range covers the last seven days including today', () => {
  const range = defaultUsageRange(new Date(2026, 4, 20, 15, 30))

  expect(range.start.getFullYear()).toBe(2026)
  expect(range.start.getMonth()).toBe(4)
  expect(range.start.getDate()).toBe(14)
  expect(range.start.getHours()).toBe(0)
  expect(range.end.getDate()).toBe(20)
  expect(range.end.getHours()).toBe(23)
})

// 只填了一头是「还没选完」，不该当成错误弹提示。
test('a half-filled range is reported as incomplete', () => {
  expect(toUsageSeconds({ start: new Date() })).toEqual({
    ok: false,
    reason: 'incomplete',
  })
  expect(toUsageSeconds({ end: new Date() })).toEqual({
    ok: false,
    reason: 'incomplete',
  })
  expect(toUsageSeconds({})).toEqual({ ok: false, reason: 'incomplete' })
})

// 起点不晚于终点会被服务端直接拒掉，这里先拦下来，省一次白跑的请求。
test('a reversed or empty range is rejected before it reaches the server', () => {
  expect(
    toUsageSeconds({ start: new Date(2000, 0, 2), end: new Date(2000, 0, 1) })
  ).toEqual({ ok: false, reason: 'invalid' })
  expect(
    toUsageSeconds({ start: new Date(2000, 0, 1), end: new Date(2000, 0, 1) })
  ).toEqual({ ok: false, reason: 'invalid' })
})

test('a range longer than the server cap of one year is rejected', () => {
  const start = new Date(2000, 0, 1)
  const end = new Date(2002, 0, 1)

  expect(toUsageSeconds({ start, end })).toEqual({
    ok: false,
    reason: 'invalid',
  })
})

test('a valid range is converted to whole seconds', () => {
  const start = new Date(1700000000000)
  const end = new Date(1700000600000)

  expect(toUsageSeconds({ start, end })).toEqual({
    ok: true,
    range: { start: 1700000000, end: 1700000600 },
  })
})
