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
import { AlertTriangle, Check, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { Label } from '@/components/ui/label'
import { formatBillingCurrencyFromUSD } from '@/lib/currency'
import { formatLogQuota } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { UsageLog } from '../../data/schema'
import {
  buildBillingEquation,
  reconciles,
  type BillingEquationLine,
} from '../../lib/billing-equation'
import { isPerCallBilling } from '../../lib/utils'
import type { ChargeAdjustment, LogOtherData } from '../../types'

const PRICE_OPTS = { digitsLarge: 4, digitsSmall: 6, abbreviate: false }

/** The suffix a line's unit price is quoted with. */
function priceBasisSuffix(line: BillingEquationLine): string {
  if (line.priceBasis === 'per_million_tokens') return '/M'
  if (line.priceBasis === 'per_thousand_calls') return '/1K'
  return ''
}

function formatQuantity(line: BillingEquationLine): string {
  return line.quantity.toLocaleString()
}

function formatRatio(ratio: number): string {
  return `${ratio.toFixed(4).replace(/\.?0+$/, '')}x`
}

function billingModeLabel(
  t: (key: string) => string,
  other: LogOtherData
): string {
  if (other.billing_mode === 'tiered_expr') return t('Dynamic Pricing')
  if (isPerCallBilling(other.model_price)) return t('Per-call')
  return t('Per-token')
}

/**
 * Why the recorded charge is not the plain quantity x price product. Kinds
 * come from the backend's public `charge_adjustment` marker; a log written
 * before that marker existed carries none, and the note falls back to naming
 * the discrepancy instead of its cause.
 */
function ChargeAdjustmentNote(props: { adjustment: ChargeAdjustment }) {
  const { t } = useTranslation()
  const { adjustment } = props

  const body = (() => {
    switch (adjustment.kind) {
      case 'no_billable_usage':
        return t(
          'This request carried no billable usage, so nothing was charged.'
        )
      case 'minimum_charge':
        return t(
          'The formula came to less than one quota unit, so the minimum charge of one unit was applied.'
        )
      case 'clamped':
        return t(
          'The computed amount exceeded the supported per-request bound, so it was capped.'
        )
      default:
        return t('The charge was adjusted by the server after the formula ran.')
    }
  })()

  const showClampDetail =
    adjustment.kind === 'clamped' && adjustment.original != null

  return (
    <div className='flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-400'>
      <Info className='mt-0.5 size-3 shrink-0' aria-hidden='true' />
      <div className='min-w-0 space-y-0.5'>
        <span className='wrap-break-word'>{body}</span>
        {showClampDetail && (
          <div className='font-mono wrap-break-word'>
            {adjustment.op}: {adjustment.original} → {adjustment.clamped}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The mismatch between the reconstructed terms and the recorded charge, stated
 * as a difference the reader can act on rather than a failure.
 */
function UnreconciledNote(props: { adjustment: ChargeAdjustment | null }) {
  const { t } = useTranslation()

  if (props.adjustment != null) {
    return <ChargeAdjustmentNote adjustment={props.adjustment} />
  }

  return (
    <div className='text-muted-foreground flex items-start gap-1.5 rounded border p-2 text-[11px]'>
      <AlertTriangle className='mt-0.5 size-3 shrink-0' aria-hidden='true' />
      <span className='wrap-break-word'>
        {t(
          'The difference comes from a server-side multiplier or rounding that this record does not itemize. The charged amount above is the authoritative one.'
        )}
      </span>
    </div>
  )
}

/**
 * Two terms of one request differ in at least one of these, and terms that
 * match on all of them are interchangeable to a reader.
 */
function lineKey(line: BillingEquationLine): string {
  return [
    line.label,
    line.quantity,
    line.quantityUnit,
    line.priceUSD,
    line.priceBasis,
  ].join('|')
}

function EquationLine(props: { line: BillingEquationLine }) {
  const { t } = useTranslation()
  const { line } = props
  const unit = line.quantityUnit === 'tokens' ? t('tokens') : t('calls')

  return (
    <div className='flex flex-col gap-0.5 border-b border-dashed py-1.5 last:border-b-0'>
      <div className='flex items-baseline justify-between gap-2 text-xs'>
        <span className='min-w-0 truncate'>{t(line.label)}</span>
        <span className='shrink-0 font-mono tabular-nums'>
          {formatLogQuota(line.quota)}
        </span>
      </div>
      <span className='text-muted-foreground font-mono text-[11px] wrap-break-word'>
        {formatQuantity(line)}
        {` ${unit} × `}
        {formatBillingCurrencyFromUSD(line.priceUSD, PRICE_OPTS)}
        {priceBasisSuffix(line)}
        {line.ratio !== 1 && ` × ${formatRatio(line.ratio)}`}
      </span>
    </div>
  )
}

function ConclusionBar(props: {
  log: UsageLog
  other: LogOtherData
  isAdmin: boolean
  /** Omitted when the record has no pricing metadata to name a mode from. */
  modeLabel: string | null
}) {
  const { t } = useTranslation()
  const { log, other } = props

  // The billing path is an admin-only field (admin_info is stripped for other
  // viewers), so it is shown here only to an admin.
  const path =
    props.isAdmin && other.admin_info?.usage_billing_path
      ? String(other.admin_info.usage_billing_path)
      : null

  return (
    <div className='bg-muted/40 min-w-0 space-y-1.5 rounded-md border p-3'>
      <div className='flex items-baseline justify-between gap-3'>
        <span className='text-muted-foreground text-xs'>
          {other.billing_source === 'subscription'
            ? t('Subscription Billing')
            : t('Charged')}
        </span>
        <span className='text-lg leading-none font-semibold tabular-nums'>
          {formatLogQuota(log.quota)}
        </span>
      </div>
      <div className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]'>
        {props.modeLabel && (
          <StatusBadge
            label={props.modeLabel}
            variant='neutral'
            size='sm'
            copyable={false}
          />
        )}
        {log.model_name && (
          <span className='max-w-full truncate font-mono'>
            {log.model_name}
          </span>
        )}
        {path && <span className='max-w-full truncate font-mono'>{path}</span>}
      </div>
    </div>
  )
}

/**
 * The billing explanation a log owner reads first: what was charged, then the
 * terms that produced it, then whether the two agree.
 *
 * The caller gates this to consume logs, so the charged amount and its mode are
 * always stated, even for a record too old to carry the fields the terms are
 * reconstructed from.
 */
export function BillingExplanation(props: {
  log: UsageLog
  other: LogOtherData
  isAdmin: boolean
  quotaPerUnit: number
}) {
  const { t } = useTranslation()
  const { log, other } = props
  const equation = buildBillingEquation(log, other, props.quotaPerUnit)
  const matched = reconciles(equation)

  return (
    <div className='min-w-0 space-y-2'>
      <ConclusionBar
        log={log}
        other={other}
        isAdmin={props.isAdmin}
        modeLabel={
          equation.kind === 'unavailable' ? null : billingModeLabel(t, other)
        }
      />

      {equation.kind === 'unavailable' && (
        <div className='text-muted-foreground flex items-start gap-1.5 rounded border p-2 text-[11px]'>
          <Info className='mt-0.5 size-3 shrink-0' aria-hidden='true' />
          <span className='wrap-break-word'>
            {t(
              'This record does not carry the pricing fields needed to break the charge down. The amount above is the authoritative one.'
            )}
          </span>
        </div>
      )}

      {equation.kind === 'image' && (
        <div className='text-muted-foreground flex items-start gap-1.5 rounded border p-2 text-[11px]'>
          <Info className='mt-0.5 size-3 shrink-0' aria-hidden='true' />
          <span className='wrap-break-word'>
            {t(
              'This request was billed per image, with multipliers the record does not itemize, so the charge cannot be broken down term by term. The amount above is the authoritative one.'
            )}
          </span>
        </div>
      )}

      {equation.kind === 'tiered' && (
        <div className='text-muted-foreground flex items-start gap-1.5 rounded border p-2 text-[11px]'>
          <Info className='mt-0.5 size-3 shrink-0' aria-hidden='true' />
          <span className='wrap-break-word'>
            {t(
              'This request was priced by a billing expression, and the expression total is the charge. See the tier breakdown below.'
            )}
          </span>
        </div>
      )}

      {equation.kind === 'ready' && (
        <div className='min-w-0 space-y-1.5'>
          <Label className='text-xs font-semibold'>{t('Usage details')}</Label>
          <div className='bg-muted/30 rounded-md border p-2.5 max-sm:p-2'>
            {equation.lines.length > 0 ? (
              equation.lines.map((line) => (
                <EquationLine key={lineKey(line)} line={line} />
              ))
            ) : (
              <p className='text-muted-foreground py-1 text-[11px]'>
                {t('No billable usage was recorded for this request.')}
              </p>
            )}

            <div className='mt-2 space-y-1 border-t pt-2'>
              <div className='flex items-baseline justify-between gap-2 text-xs'>
                <span className='text-muted-foreground'>
                  {t('Computed total')}
                </span>
                <span className='font-mono tabular-nums'>
                  {formatLogQuota(equation.computedQuota)}
                </span>
              </div>
              <div className='flex items-baseline justify-between gap-2 text-xs'>
                <span className='text-muted-foreground'>{t('Charged')}</span>
                <span
                  className={cn(
                    'flex items-center gap-1 font-mono font-medium tabular-nums',
                    matched
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  )}
                >
                  {!matched && (
                    <AlertTriangle
                      className='size-3 shrink-0'
                      aria-hidden='true'
                    />
                  )}
                  {matched && (
                    <Check className='size-3 shrink-0' aria-hidden='true' />
                  )}
                  {formatLogQuota(equation.chargedQuota)}
                </span>
              </div>
              {!matched && (
                <div className='flex items-baseline justify-between gap-2 text-xs'>
                  <span className='text-muted-foreground'>
                    {t('Difference')}
                  </span>
                  <span className='font-mono tabular-nums'>
                    {formatLogQuota(equation.deltaQuota)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {!matched && <UnreconciledNote adjustment={equation.adjustment} />}

          {matched && equation.adjustment != null && (
            <ChargeAdjustmentNote adjustment={equation.adjustment} />
          )}

          <div className='text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]'>
            <span>
              {equation.userSpecificGroupRatio
                ? t('User Exclusive Ratio')
                : t('Group Ratio')}
              {` ${formatRatio(equation.groupRatio)}`}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
