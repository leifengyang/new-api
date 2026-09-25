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
import { describe, expect, it } from 'vitest'

import type { UsageLog } from '../../data/schema'
import type { LogOtherData } from '../../types'
import { buildBillingEquation, reconciles } from '../billing-equation'

const QUOTA_PER_UNIT = 500_000

/**
 * Every `quota` below was produced by running the real settle path
 * (`PostTextConsumeQuota` / `PostWssConsumeQuota`) against sqlite and reading
 * the recorded log back, with the `other` map copied into the fixture. If the
 * reconstruction drifts from the backend, these figures stop reconciling.
 */
function makeLog(
  quota: number,
  promptTokens = 0,
  completionTokens = 0
): UsageLog {
  return {
    id: 1,
    user_id: 1,
    created_at: 0,
    type: 2,
    content: '',
    username: 'fixture',
    token_name: 'fixture',
    model_name: 'fixture-model',
    quota,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    use_time: 0,
    is_stream: false,
    channel: 1,
    channel_name: '',
    token_id: 1,
    group: 'default',
    ip: '',
    other: '',
    request_id: '',
    upstream_request_id: '',
  }
}

describe('buildBillingEquation', () => {
  it('reconciles a Claude-semantic charge with split cache creation', () => {
    const log = makeLog(5279, 1000, 500)
    const other: LogOtherData = {
      usage_semantic: 'anthropic',
      model_ratio: 1.5,
      completion_ratio: 3,
      cache_ratio: 0.1,
      cache_tokens: 200,
      cache_creation_ratio: 1.25,
      cache_creation_tokens: 300,
      cache_creation_ratio_5m: 1.25,
      cache_creation_tokens_5m: 100,
      cache_creation_ratio_1h: 2,
      cache_creation_tokens_1h: 50,
      group_ratio: 1.2,
    }

    const equation = buildBillingEquation(log, other, QUOTA_PER_UNIT)

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    // Claude reports cache classes outside prompt_tokens, so the base term keeps
    // all 1000 tokens and the cache lines are additive.
    expect(equation.lines.map((line) => [line.label, line.quantity])).toEqual([
      ['Input', 1000],
      ['Cache Read', 200],
      // 300 total less the 100 + 50 billed at their own windows.
      ['Cache Write', 150],
      ['Cache Write (5m)', 100],
      ['Cache Write (1h)', 50],
      ['Output', 500],
    ])
    expect(equation.computedQuota).toBeCloseTo(5278.5, 6)
    expect(equation.deltaQuota).toBeCloseTo(0.5, 6)
    expect(reconciles(equation)).toBe(true)
  })

  it('reconciles an OpenAI charge by subtracting the cache overlap', () => {
    const log = makeLog(4311, 1000, 500)
    const other: LogOtherData = {
      model_ratio: 1.5,
      completion_ratio: 3,
      cache_ratio: 0.1,
      cache_tokens: 200,
      cache_creation_ratio: 1.25,
      cache_creation_tokens: 300,
      group_ratio: 1.2,
    }

    const equation = buildBillingEquation(log, other, QUOTA_PER_UNIT)

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    // OpenAI reports the cache classes inside prompt_tokens, so both leave the
    // base term: 1000 - 200 - 300.
    expect(equation.lines.map((line) => [line.label, line.quantity])).toEqual([
      ['Input', 500],
      ['Cache Read', 200],
      ['Cache Write', 300],
      ['Output', 500],
    ])
    expect(equation.computedQuota).toBe(4311)
    expect(equation.deltaQuota).toBe(0)
    expect(reconciles(equation)).toBe(true)
  })

  it('reconciles a plain charge with no cache classes', () => {
    const log = makeLog(4500, 1000, 500)
    const other: LogOtherData = {
      model_ratio: 1.5,
      completion_ratio: 3,
      cache_ratio: 0,
      cache_tokens: 0,
      group_ratio: 1.2,
    }

    const equation = buildBillingEquation(log, other, QUOTA_PER_UNIT)

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.lines.map((line) => line.label)).toEqual([
      'Input',
      'Output',
    ])
    expect(equation.computedQuota).toBe(4500)
    expect(reconciles(equation)).toBe(true)
  })

  it('reconciles a per-call charge', () => {
    const log = makeLog(30000, 1000, 500)
    const other: LogOtherData = {
      model_price: 0.05,
      model_ratio: 1.5,
      completion_ratio: 3,
      group_ratio: 1.2,
    }

    const equation = buildBillingEquation(log, other, QUOTA_PER_UNIT)

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.lines).toHaveLength(1)
    expect(equation.lines[0]).toMatchObject({
      label: 'Per-call',
      quantity: 1,
      priceUSD: 0.05,
      priceBasis: 'per_call',
    })
    expect(equation.computedQuota).toBe(30000)
    expect(reconciles(equation)).toBe(true)
  })

  it('reconciles image input tokens at their own ratio', () => {
    const log = makeLog(5580, 1000, 500)
    const other: LogOtherData = {
      image: true,
      image_output: 400,
      image_ratio: 2.5,
      model_ratio: 1.5,
      completion_ratio: 3,
      group_ratio: 1.2,
    }

    const equation = buildBillingEquation(log, other, QUOTA_PER_UNIT)

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.lines.map((line) => [line.label, line.quantity])).toEqual([
      // 1000 prompt tokens less the 400 billed as image input.
      ['Input', 600],
      ['Image input', 400],
      ['Output', 500],
    ])
    expect(equation.computedQuota).toBe(5580)
    expect(reconciles(equation)).toBe(true)
  })

  it('reconciles the realtime path, which does not use the text formula', () => {
    const log = makeLog(2700, 1000, 500)
    const other: LogOtherData = {
      ws: true,
      model_ratio: 1.5,
      completion_ratio: 1,
      audio_ratio: 1,
      audio_completion_ratio: 1,
      text_input: 700,
      text_output: 400,
      audio_input: 300,
      audio_output: 100,
      group_ratio: 1.2,
    }

    const equation = buildBillingEquation(log, other, QUOTA_PER_UNIT)

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.lines.map((line) => [line.label, line.quantity])).toEqual([
      ['Text Input', 700],
      ['Text Output', 400],
      ['Audio Input', 300],
      ['Audio Output', 100],
    ])
    expect(equation.computedQuota).toBe(2700)
    expect(reconciles(equation)).toBe(true)
  })

  it('quotes a line price in USD per million tokens', () => {
    const equation = buildBillingEquation(
      makeLog(4500, 1000, 500),
      { model_ratio: 1.5, completion_ratio: 3, group_ratio: 1.2 },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    // 1.5 quota per token at 500,000 quota per USD is 3 USD per 1M tokens.
    expect(equation.lines[0].priceUSD).toBeCloseTo(3, 10)
    expect(equation.lines[1].priceUSD).toBeCloseTo(9, 10)
  })

  it('does not flag a plain group ratio as user-specific', () => {
    // The backend writes the special ratio field as 0 when the user's group
    // has none, which is the common case.
    const equation = buildBillingEquation(
      makeLog(4500, 1000, 500),
      {
        model_ratio: 1.5,
        completion_ratio: 3,
        group_ratio: 1.2,
        user_group_ratio: 0,
      },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.userSpecificGroupRatio).toBe(false)
    expect(equation.groupRatio).toBe(1.2)
  })

  it('flags a user-specific group ratio', () => {
    const equation = buildBillingEquation(
      makeLog(4500, 1000, 500),
      {
        model_ratio: 1.5,
        completion_ratio: 3,
        group_ratio: 0.9,
        user_group_ratio: 0.9,
      },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.userSpecificGroupRatio).toBe(true)
  })

  it('reports a per-image charge as not itemizable', () => {
    const equation = buildBillingEquation(
      makeLog(60000),
      {
        image: true,
        image_count: 4,
        model_price: 0.03,
        model_ratio: 1.5,
        group_ratio: 1.2,
      },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('image')
  })

  it('reports an expression-priced charge as tiered', () => {
    const equation = buildBillingEquation(
      makeLog(1234),
      { billing_mode: 'tiered_expr', expr_b64: 'cChjKik=', model_ratio: 1.5 },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('tiered')
  })

  it('reports a log with no pricing metadata as unavailable', () => {
    const equation = buildBillingEquation(makeLog(0), {}, QUOTA_PER_UNIT)

    expect(equation.kind).toBe('unavailable')
  })

  it('keeps a zero charge readable through its adjustment marker', () => {
    // No billable usage: the formula has nothing to price, but the log records
    // why the charge is zero, and that must survive an empty line list.
    const equation = buildBillingEquation(
      makeLog(0),
      {
        model_ratio: 1.5,
        completion_ratio: 3,
        group_ratio: 1.2,
        charge_adjustment: { kind: 'no_billable_usage' },
      },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.lines).toEqual([])
    expect(equation.chargedQuota).toBe(0)
    expect(equation.adjustment).toEqual({ kind: 'no_billable_usage' })
    expect(reconciles(equation)).toBe(true)
  })

  it('surfaces a charge the terms cannot explain', () => {
    // 1 quota higher than the terms produce: the minimum-charge floor.
    const equation = buildBillingEquation(
      makeLog(1, 1, 0),
      {
        model_ratio: 0.0001,
        completion_ratio: 1,
        group_ratio: 1,
        charge_adjustment: { kind: 'minimum_charge' },
      },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.computedQuota).toBeCloseTo(0.0001, 10)
    expect(equation.deltaQuota).toBeCloseTo(0.9999, 10)
    // Within the rounding tolerance, so this reports as reconciled rather than
    // as an unexplained charge.
    expect(reconciles(equation)).toBe(true)
  })

  it('flags a delta beyond the rounding tolerance as unreconciled', () => {
    const equation = buildBillingEquation(
      makeLog(999_999, 1000, 500),
      { model_ratio: 1.5, completion_ratio: 3, group_ratio: 1.2 },
      QUOTA_PER_UNIT
    )

    expect(equation.kind).toBe('ready')
    if (equation.kind !== 'ready') return
    expect(equation.deltaQuota).toBe(995_499)
    expect(reconciles(equation)).toBe(false)
  })
})
