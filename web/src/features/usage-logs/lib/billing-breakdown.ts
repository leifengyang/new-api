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
import {
  BILLING_PRICING_VARS,
  parseTaskTiersFromExpr,
  splitBillingExprAndRequestRules,
} from '@/features/pricing/lib/billing-expr'
import { compileBillingExpression } from '@/features/pricing/lib/billing-expression/parser'
import type { BillingVariable } from '@/features/pricing/lib/billing-expression/types'
import type { BillingUsageSchema } from '@/features/pricing/types'

import type { UsageLog } from '../data/schema'
import type { LogOtherData } from '../types'
import { decodeBillingExprB64, getTieredBillingSummary } from './format'
import { getLogTokenUsage } from './token-usage'

export interface BillingLine {
  label: string
  quantity: number
  price: number
  divisor: number
  tool?: boolean
}
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Display reconstruction only: recorded settlement remains authoritative. */
export function buildLogBilling(
  log: Pick<UsageLog, 'prompt_tokens' | 'completion_tokens' | 'quota'>,
  other: LogOtherData,
  quotaPerUnit: number,
  schema?: BillingUsageSchema
) {
  const lines: BillingLine[] = []
  const usage = getLogTokenUsage(
    log.prompt_tokens,
    log.completion_tokens,
    other
  )
  const ratio = valid(other.user_group_ratio)
    ? other.user_group_ratio
    : other.group_ratio
  let complete = valid(ratio)
  let requestRatio = 1
  const add = (
    label: string,
    quantity: number,
    price: unknown,
    divisor = 1_000_000,
    tool = false
  ) => {
    if (quantity === 0) return
    if (!valid(quantity) || !valid(price)) {
      complete = false
      return
    }
    if (quantity > 0 || divisor === 1) {
      lines.push({ label, quantity, price, divisor, tool })
    }
  }
  if (other.billing_mode === 'tiered_expr') {
    const expression = decodeBillingExprB64(other.expr_b64)
    const compiled = compileBillingExpression(expression || '')
    const summary = getTieredBillingSummary(other)
    const taskTiers = parseTaskTiersFromExpr(
      splitBillingExprAndRequestRules(expression || '').billingExpr,
      schema
    )
    const taskTier = taskTiers.find((tier) => tier.label === other.matched_tier)
    if (compiled.status !== 'ready') complete = false
    if (compiled.status === 'ready' && compiled.requestRules.length > 0) {
      if (
        !other.request_rules ||
        other.request_rules.length !== compiled.requestRules.length
      ) {
        complete = false
      }
      for (const rule of other.request_rules ?? []) {
        if (!valid(rule.multiplier)) complete = false
        else if (rule.matched) requestRatio *= rule.multiplier
      }
    }
    if (taskTier && other.usage_facts) {
      if (taskTier.constant > 0) add('Per-call', 1, taskTier.constant, 1)
      for (const [key, price] of Object.entries(taskTier.unitPrices)) {
        const quantity = other.usage_facts[key]
        if (!valid(quantity)) {
          complete = false
          continue
        }
        add(
          key,
          quantity,
          price,
          schema?.[key]?.unit === 'token' ? 1_000_000 : 1
        )
      }
    } else if (summary?.tier.billingUnit === 'request') {
      add(
        other.image_count !== undefined ? 'Per image' : 'Per-call',
        other.image_count ?? 1,
        summary.tier.fixedPrice,
        1
      )
    } else if (summary && compiled.status === 'ready') {
      const counts: Record<string, number> = {
        p: usage.totalInput,
        c: usage.output,
        cr: usage.cacheRead ?? 0,
        cc: Math.max(0, usage.cacheWrite - usage.write1h),
        cc1h: usage.write1h,
        ai: other.audio_input ?? other.audio_input_token_count ?? 0,
        ao: other.audio_output ?? 0,
        img: other.image_output ?? 0,
        img_cr: other.image_cache_tokens ?? 0,
        img_o: 0,
      }
      // The server records exact normalized billing counts for image/cache overlap.
      if (other.billing_tokens) Object.assign(counts, other.billing_tokens)
      else {
        if (
          compiled.variables.has('img_cr') ||
          compiled.variables.has('img_o')
        ) {
          complete = false
        }
        for (const variable of BILLING_PRICING_VARS) {
          if (
            variable.key === 'p' ||
            variable.key === 'c' ||
            !compiled.variables.has(variable.key as BillingVariable)
          ) {
            continue
          }
          const base = variable.side === 'output' ? 'c' : 'p'
          counts[base] = Math.max(0, counts[base] - (counts[variable.key] ?? 0))
        }
      }
      for (const variable of BILLING_PRICING_VARS) {
        if (
          !variable.field ||
          !compiled.variables.has(variable.key as BillingVariable)
        ) {
          continue
        }
        add(
          variable.shortLabel,
          counts[variable.key] ?? 0,
          summary.tier[variable.field]
        )
      }
    } else complete = false
  } else if (valid(other.model_price)) {
    add('Per-call', 1, other.model_price, 1)
  } else if (valid(other.model_ratio)) {
    const price = (other.model_ratio * 1_000_000) / quotaPerUnit
    const audio = other.audio_input ?? other.audio_input_token_count ?? 0
    const image = other.image_output ?? 0
    const input = Math.max(0, usage.input - audio - image)
    add('Input', input, price)
    add(
      'Output',
      Math.max(0, usage.output - (other.audio_output ?? 0)),
      valid(other.completion_ratio) ? price * other.completion_ratio : undefined
    )
    if (usage.cacheRead) {
      add(
        'Cache Read',
        usage.cacheRead,
        valid(other.cache_ratio) ? price * other.cache_ratio : undefined
      )
    }
    if (usage.cacheWrite) {
      const split = other.usage_semantic === 'anthropic' || other.claude
      if (split) {
        add(
          'Cache Write',
          Math.max(0, usage.cacheWrite - usage.write5m - usage.write1h),
          valid(other.cache_creation_ratio)
            ? price * other.cache_creation_ratio
            : undefined
        )
        if (usage.write5m) {
          add(
            'Cache Write (5m)',
            usage.write5m,
            valid(other.cache_creation_ratio_5m)
              ? price * other.cache_creation_ratio_5m
              : undefined
          )
        }
        if (usage.write1h) {
          add(
            'Cache Write (1h)',
            usage.write1h,
            valid(other.cache_creation_ratio_1h)
              ? price * other.cache_creation_ratio_1h
              : undefined
          )
        }
      } else {
        add(
          'Cache Write',
          usage.cacheWrite,
          valid(other.cache_creation_ratio)
            ? price * other.cache_creation_ratio
            : undefined
        )
      }
    }
    if (image) {
      add(
        'Image In',
        image,
        valid(other.image_ratio) ? price * other.image_ratio : undefined
      )
    }
    if (audio) {
      add(
        'Audio In',
        audio,
        other.audio_input_seperate_price
          ? other.audio_input_price
          : price * (other.audio_ratio ?? 1)
      )
    }
    if (other.audio_output) {
      add(
        'Audio Out',
        other.audio_output,
        price * (other.audio_ratio ?? 1) * (other.audio_completion_ratio ?? 1)
      )
    }
  } else complete = false
  if (other.tool_surcharges) {
    for (const item of other.tool_surcharges) {
      add(item.name, item.count, item.price, 1000, true)
    }
  } else {
    if (other.web_search) {
      add(
        'Web Search',
        other.web_search_call_count ?? 0,
        other.web_search_price,
        1000,
        true
      )
    }
    if (other.file_search) {
      add(
        'File Search',
        other.file_search_call_count ?? 0,
        other.file_search_price,
        1000,
        true
      )
    }
    if (other.image_generation_call) {
      add(
        'Image Generation',
        other.image_generation_call_count ?? 1,
        other.image_generation_call_price,
        1,
        true
      )
    }
  }
  const base = lines
    .filter((line) => !line.tool)
    .reduce((sum, line) => sum + (line.quantity * line.price) / line.divisor, 0)
  const tools = lines
    .filter((line) => line.tool)
    .reduce((sum, line) => sum + (line.quantity * line.price) / line.divisor, 0)
  const calculated = (base * requestRatio + tools) * (ratio ?? 1)
  const rounding = log.quota / quotaPerUnit - calculated
  // Never disguise missing historical multipliers, unknown expressions or adjustments.
  complete =
    complete &&
    lines.length > 0 &&
    Number.isFinite(calculated) &&
    Math.abs(rounding * quotaPerUnit) <= 1 + 1e-7 &&
    !other.charge_adjustment
  return { lines, ratio, requestRatio, calculated, rounding, complete }
}
