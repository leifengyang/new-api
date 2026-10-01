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

import { buildLogBilling } from '../billing-breakdown'

const log = { prompt_tokens: 1000, completion_tokens: 100, quota: 1400 }
test('expands recorded input, cache and output prices with group ratio', () => {
  const result = buildLogBilling(
    log,
    {
      model_ratio: 2.5,
      completion_ratio: 3,
      cache_tokens: 200,
      cache_ratio: 0.1,
      group_ratio: 0.5,
    },
    500000
  )
  expect(result.lines.map((x) => [x.label, x.quantity, x.price])).toEqual([
    ['Input', 800, 5],
    ['Output', 100, 15],
    ['Cache Read', 200, 0.5],
  ])
  expect(result.complete).toBe(true)
  expect(result.calculated).toBeCloseTo(0.0028)
})
test('expression variables only exclude separately priced categories', () => {
  const result = buildLogBilling(
    { ...log, quota: 3250 },
    {
      billing_mode: 'tiered_expr',
      expr_b64: btoa('tier("base", p * 5 + c * 15)'),
      matched_tier: 'base',
      cache_tokens: 200,
      group_ratio: 1,
    },
    500000
  )
  expect(result.lines[0].quantity).toBe(1000)
  expect(result.complete).toBe(true)
})
test('separate cache counts and request traces enter the formula once', () => {
  const result = buildLogBilling(
    { prompt_tokens: 800, completion_tokens: 100, quota: 5600 },
    {
      usage_semantic: 'anthropic',
      billing_mode: 'tiered_expr',
      expr_b64: btoa(
        'tier("base", p * 5 + c * 15 + cr * .5) * (header("fast") == "yes" ? 2 : 1)'
      ),
      matched_tier: 'base',
      cache_tokens: 200,
      group_ratio: 1,
      request_rules: [
        { cond: 'header("fast") == "yes"', matched: true, multiplier: 2 },
      ],
    },
    500000
  )
  expect(result.lines[0].quantity).toBe(800)
  expect(result.calculated).toBeCloseTo(0.0112)
  expect(result.complete).toBe(true)
})
test('tool fees are charged per thousand calls and not multiplied by request rules', () => {
  const result = buildLogBilling(
    { ...log, quota: 5000 },
    {
      model_price: 0,
      group_ratio: 1,
      tool_surcharges: [{ name: 'search', price: 5, count: 2 }],
    },
    500000
  )
  expect(result.calculated).toBe(0.01)
  expect(result.complete).toBe(true)
})
test('missing or inconsistent records never fabricate an equality', () => {
  expect(buildLogBilling(log, {}, 500000).complete).toBe(false)
  expect(
    buildLogBilling(log, { model_price: 100, group_ratio: 1 }, 500000).complete
  ).toBe(false)
})

test('task token prices retain their per-million divisor', () => {
  const result = buildLogBilling(
    { ...log, quota: 4900 },
    {
      billing_mode: 'tiered_expr',
      expr_b64: btoa('tier("base", u("tokens") * 9.8 / 1000000)'),
      matched_tier: 'base',
      usage_facts: { tokens: 1000 },
      group_ratio: 1,
    },
    500000,
    { tokens: { type: 'number', unit: 'token' } }
  )
  expect(result.lines[0]).toMatchObject({
    quantity: 1000,
    price: 9.8,
    divisor: 1000000,
  })
  expect(result.complete).toBe(true)
})
test('cache creation splits do not require an unused fallback price', () => {
  const result = buildLogBilling(
    { prompt_tokens: 0, completion_tokens: 0, quota: 625 },
    {
      usage_semantic: 'anthropic',
      model_ratio: 2.5,
      cache_creation_tokens: 200,
      cache_creation_tokens_5m: 200,
      cache_creation_ratio_5m: 1.25,
      group_ratio: 1,
    },
    500000
  )
  expect(result.complete).toBe(true)
  expect(result.calculated).toBeCloseTo(0.00125)
})
