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
import type { UsageLog } from '../data/schema'
import type { ChargeAdjustment, LogOtherData } from '../types'

/**
 * Rebuilds a charge as the sum of `quantity x unit price x ratio` terms the
 * backend applied, so a log owner can read where each unit of quota came from,
 * and reconciles that sum against the quota the log records.
 *
 * This mirrors three backend sites. Keep them in step: a term added or
 * reordered there changes what a user reads here.
 *   - calculateTextQuotaSummary / PostTextConsumeQuota in service/text_quota.go
 *   - calculateAudioQuota, GenerateWssOtherInfo and GenerateAudioOtherInfo in
 *     service/quota.go and service/log_info_generate.go — the realtime and
 *     audio-transcription paths, which do not use the text formula
 *   - relay/helper/price.go, for which multipliers ever reach the log
 *
 * Terms are reconstructed in quota units, the unit the log records, so a total
 * is comparable to `log.quota` without knowing the `quotaPerUnit` in force when
 * the request ran. Terms the backend itself prices in USD are the exception and
 * take `quotaPerUnit` as an argument.
 */

/**
 * The basis a line's unit price is quoted in, so the UI can pick the right
 * suffix (`/M`, `/1K`, or a bare price).
 */
export type PriceBasis =
  | 'per_million_tokens'
  | 'per_thousand_calls'
  | 'per_call'

export interface BillingEquationLine {
  /** Source-text label, used as an i18n key. */
  label: string
  quantity: number
  quantityUnit: 'tokens' | 'calls'
  /** Price in USD for one `priceBasis` unit. */
  priceUSD: number
  priceBasis: PriceBasis
  /** The multiplier applied on top of quantity x unit price. */
  ratio: number
  /** This term's contribution to the charge, in quota. */
  quota: number
}

export type BillingEquation =
  /** The log carries no pricing metadata: audit, task and refund rows, or a row
   *  older than the fields this reconstruction reads. */
  | { kind: 'unavailable' }
  /** A per-image charge. Its quantity and size/quality multipliers are not
   *  persisted, so the terms cannot be itemized. */
  | { kind: 'image' }
  /** An expression-priced request: the expression, not a product, is the
   *  charge, and its settled total is not re-derivable here. */
  | { kind: 'tiered' }
  | {
      kind: 'ready'
      lines: BillingEquationLine[]
      /** The effective group multiplier, which may be user-specific. */
      groupRatio: number
      userSpecificGroupRatio: boolean
      /** Sum of the line terms, in quota. */
      computedQuota: number
      /** The quota recorded on the log — the authoritative figure. */
      chargedQuota: number
      /** chargedQuota - computedQuota. */
      deltaQuota: number
      /** The recorded cause of a charge that differs from the plain product. */
      adjustment: ChargeAdjustment | null
    }

/**
 * Rounding at the quota boundary can move a total by one unit — under
 * 0.000002 USD — so a delta this small is not a reconciliation failure.
 */
export const QUOTA_ROUNDING_TOLERANCE = 1

function finite(value: number | undefined | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Reads a multiplier, defaulting to the neutral value. */
function ratioOf(value: number | undefined): number {
  return finite(value) ?? 1
}

/**
 * The base input price in USD per 1M tokens for a given model ratio. The
 * backend charges `modelRatio` quota per token, so one token costs
 * `modelRatio / quotaPerUnit` USD and a million of them cost
 * `modelRatio * 1e6 / quotaPerUnit` — which is `modelRatio * 2` at the default
 * 500,000, the figure the backend documents as `model_ratio * 2.0`.
 */
function baseInputPriceUSD(modelRatio: number, quotaPerUnit: number): number {
  return (modelRatio * 1_000_000) / quotaPerUnit
}

/**
 * A per-image charge multiplies the request quantity by multipliers that never
 * reach the log: `n` (the requested image count) and `meta.ImagePriceRatio` go
 * into the price data's other-ratios, which are not persisted. Its terms are
 * therefore not recoverable.
 *
 * Image *input tokens* on the token path are a different matter — a plain term
 * at `image_ratio` — and are reconstructed as one.
 */
function hasUnrecoverableImagePricing(other: LogOtherData): boolean {
  return other.image === true || (finite(other.image_ratio) ?? 1) !== 1
}

/**
 * Anthropic usage reports input tokens with cache reads excluded while OpenAI
 * reports them included, so the backend subtracts the overlap only for the
 * latter. It records `usage_semantic: "anthropic"` exactly when it took the
 * Anthropic path.
 */
function isClaudeUsageSemantic(other: LogOtherData): boolean {
  return other.usage_semantic === 'anthropic'
}

/**
 * A legacy OpenAI-format response that carried Claude cache-creation fields
 * before usage tagging existed also skips the overlap subtraction. The backend
 * keys that off usage-level fields it does not log, and the split 5m/1h token
 * counts are the only surviving trace.
 */
function isLegacyClaudeDerived(other: LogOtherData): boolean {
  if (isClaudeUsageSemantic(other)) return false
  return (
    (finite(other.cache_creation_tokens_5m) ?? 0) > 0 ||
    (finite(other.cache_creation_tokens_1h) ?? 0) > 0
  )
}

interface LineContext {
  modelRatio: number
  groupRatio: number
  quotaPerUnit: number
}

/** Appends a `quantity x (base model price x factor) x group ratio` term. */
function pushTokenLine(
  lines: BillingEquationLine[],
  ctx: LineContext,
  label: string,
  quantity: number,
  factor: number
): void {
  if (!(quantity > 0)) return
  lines.push({
    label,
    quantity,
    quantityUnit: 'tokens',
    priceUSD: baseInputPriceUSD(ctx.modelRatio, ctx.quotaPerUnit) * factor,
    priceBasis: 'per_million_tokens',
    ratio: ctx.groupRatio,
    quota: quantity * ctx.modelRatio * factor * ctx.groupRatio,
  })
}

/** Whether the log's token classes are reported inside prompt_tokens. */
function overlapsBaseTokens(other: LogOtherData): boolean {
  return !isClaudeUsageSemantic(other) && !isLegacyClaudeDerived(other)
}

/**
 * The chat/completions path. The backend sums the token classes and multiplies
 * the total once by `modelRatio x groupRatio`; that distributes over the terms,
 * so billing each class separately reaches the same charge.
 */
function buildTextLines(
  log: UsageLog,
  other: LogOtherData,
  ctx: LineContext
): BillingEquationLine[] {
  const completionTokens = log.completion_tokens || 0
  const cacheTokens = other.cache_tokens || 0
  const cacheCreationTokens = other.cache_creation_tokens || 0
  const cacheCreation5m = other.cache_creation_tokens_5m || 0
  const cacheCreation1h = other.cache_creation_tokens_1h || 0
  const imageTokens = other.image_output || 0
  const hasSplitCacheCreation = cacheCreation5m > 0 || cacheCreation1h > 0
  const subtractOverlap = overlapsBaseTokens(other)
  // Separately priced audio is billed at its own per-million rate, outside the
  // token product, so it leaves the base term too.
  const audioInputTokens =
    other.audio_input_seperate_price === true
      ? other.audio_input_token_count || 0
      : 0

  let baseTokens = log.prompt_tokens || 0
  if (cacheTokens !== 0 && subtractOverlap) baseTokens -= cacheTokens
  if ((cacheCreationTokens !== 0 || hasSplitCacheCreation) && subtractOverlap) {
    baseTokens -= cacheCreationTokens
  }
  if (imageTokens !== 0) baseTokens -= imageTokens
  baseTokens -= audioInputTokens

  const lines: BillingEquationLine[] = []
  // OpenAI cache-write usage reports unadjusted prefix counts, so the classes
  // can exceed prompt_tokens and the remainder can go negative. The backend
  // clamps the base term at zero; so does this.
  pushTokenLine(lines, ctx, 'Input', Math.max(baseTokens, 0), 1)

  if (cacheTokens !== 0) {
    pushTokenLine(
      lines,
      ctx,
      'Cache Read',
      cacheTokens,
      ratioOf(other.cache_ratio)
    )
  }

  if (cacheCreationTokens !== 0 || hasSplitCacheCreation) {
    if (subtractOverlap) {
      pushTokenLine(
        lines,
        ctx,
        'Cache Write',
        cacheCreationTokens,
        ratioOf(other.cache_creation_ratio)
      )
    } else {
      // Split windows are priced separately; bill what the split does not cover
      // at the undifferentiated rate.
      const remaining = Math.max(
        cacheCreationTokens - cacheCreation5m - cacheCreation1h,
        0
      )
      const fallbackRatio = ratioOf(other.cache_creation_ratio)
      pushTokenLine(
        lines,
        ctx,
        'Cache Write',
        remaining,
        ratioOf(other.cache_creation_ratio)
      )
      pushTokenLine(
        lines,
        ctx,
        'Cache Write (5m)',
        cacheCreation5m,
        ratioOf(other.cache_creation_ratio_5m) || fallbackRatio
      )
      pushTokenLine(
        lines,
        ctx,
        'Cache Write (1h)',
        cacheCreation1h,
        ratioOf(other.cache_creation_ratio_1h) || fallbackRatio
      )
    }
  }

  if (imageTokens !== 0) {
    pushTokenLine(
      lines,
      ctx,
      'Image input',
      imageTokens,
      ratioOf(other.image_ratio)
    )
  }

  pushTokenLine(
    lines,
    ctx,
    'Output',
    completionTokens,
    ratioOf(other.completion_ratio)
  )

  return lines
}

/**
 * The realtime and audio-transcription paths, whose text and audio tokens each
 * carry their own multiplier instead of the text formula's classes.
 */
function buildAudioLines(
  other: LogOtherData,
  ctx: LineContext
): BillingEquationLine[] {
  const lines: BillingEquationLine[] = []
  const audioRatio = ratioOf(other.audio_ratio)

  pushTokenLine(lines, ctx, 'Text Input', other.text_input || 0, 1)
  pushTokenLine(
    lines,
    ctx,
    'Text Output',
    other.text_output || 0,
    ratioOf(other.completion_ratio)
  )
  pushTokenLine(lines, ctx, 'Audio Input', other.audio_input || 0, audioRatio)
  pushTokenLine(
    lines,
    ctx,
    'Audio Output',
    other.audio_output || 0,
    audioRatio * ratioOf(other.audio_completion_ratio)
  )

  return lines
}

function buildPerCallLines(
  other: LogOtherData,
  groupRatio: number,
  quotaPerUnit: number
): BillingEquationLine[] {
  const modelPrice = finite(other.model_price)
  if (modelPrice == null || modelPrice <= 0) return []
  return [
    {
      label: 'Per-call',
      quantity: 1,
      quantityUnit: 'calls',
      priceUSD: modelPrice,
      priceBasis: 'per_call',
      ratio: groupRatio,
      quota: modelPrice * quotaPerUnit * groupRatio,
    },
  ]
}

/**
 * Terms added after the token product, each priced in USD and so scaled by
 * `quotaPerUnit`. The audio path applies neither.
 */
function buildExtraLines(
  other: LogOtherData,
  ctx: LineContext
): BillingEquationLine[] {
  const lines: BillingEquationLine[] = []

  const audioInputPrice = finite(other.audio_input_price)
  const audioInputTokens = other.audio_input_token_count || 0
  if (
    other.audio_input_seperate_price === true &&
    audioInputPrice != null &&
    audioInputPrice > 0 &&
    audioInputTokens > 0
  ) {
    lines.push({
      label: 'Audio Input Price',
      quantity: audioInputTokens,
      quantityUnit: 'tokens',
      priceUSD: audioInputPrice,
      priceBasis: 'per_million_tokens',
      ratio: ctx.groupRatio,
      quota:
        (audioInputPrice / 1_000_000) *
        audioInputTokens *
        ctx.groupRatio *
        ctx.quotaPerUnit,
    })
  }

  for (const item of other.tool_surcharges ?? []) {
    const count = finite(item?.count) ?? 0
    const price = finite(item?.price)
    if (count <= 0 || price == null || price <= 0) continue
    lines.push({
      label: item.name,
      quantity: count,
      quantityUnit: 'calls',
      priceUSD: price,
      priceBasis: 'per_thousand_calls',
      ratio: ctx.groupRatio,
      quota: (price / 1000) * count * ctx.groupRatio * ctx.quotaPerUnit,
    })
  }

  return lines
}

/**
 * @param quotaPerUnit Quota units per USD, from the live display config. It
 * sets the unit price each line is quoted in, and is the divisor for terms the
 * backend prices in USD (per-call, tool surcharges, separately priced audio).
 * The quota totals are reconstructed directly and so do not shift if that
 * setting changes later.
 */
export function buildBillingEquation(
  log: UsageLog,
  other: LogOtherData,
  quotaPerUnit: number
): BillingEquation {
  if (other.billing_mode === 'tiered_expr' && other.expr_b64) {
    return { kind: 'tiered' }
  }

  const groupRatio = finite(other.group_ratio) ?? 1
  const userGroupRatio = finite(other.user_group_ratio)
  const modelRatio = finite(other.model_ratio)
  const isPerCall = (finite(other.model_price) ?? 0) > 0
  const isAudioPath = other.ws === true || other.audio === true

  if (isPerCall && hasUnrecoverableImagePricing(other)) {
    return { kind: 'image' }
  }
  // A token-priced log always carries model_ratio, so its absence means the row
  // has no pricing metadata to reconstruct from at all.
  if (!isPerCall && modelRatio == null) {
    return { kind: 'unavailable' }
  }

  const ctx: LineContext = {
    modelRatio: modelRatio ?? 0,
    groupRatio,
    quotaPerUnit,
  }

  let lines: BillingEquationLine[]
  if (isPerCall) {
    lines = [
      ...buildPerCallLines(other, groupRatio, quotaPerUnit),
      ...buildExtraLines(other, ctx),
    ]
  } else if (isAudioPath) {
    lines = buildAudioLines(other, ctx)
  } else {
    lines = [...buildTextLines(log, other, ctx), ...buildExtraLines(other, ctx)]
  }

  const computedQuota = lines.reduce((sum, line) => sum + line.quota, 0)
  const chargedQuota = log.quota || 0

  return {
    kind: 'ready',
    lines,
    groupRatio,
    // The backend writes the special ratio here only when the user's group has
    // one, and a group ratio of 0 is not a valid multiplier, so 0 means "none".
    userSpecificGroupRatio: (userGroupRatio ?? 0) > 0,
    computedQuota,
    chargedQuota,
    deltaQuota: chargedQuota - computedQuota,
    adjustment: other.charge_adjustment ?? null,
  }
}

/**
 * Whether the reconstructed total explains the recorded charge, within the
 * rounding the backend applies at the quota boundary.
 */
export function reconciles(equation: BillingEquation): boolean {
  if (equation.kind !== 'ready') return false
  return Math.abs(equation.deltaQuota) <= QUOTA_ROUNDING_TOLERANCE
}
