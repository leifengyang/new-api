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
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { StatusBadge } from '@/components/status-badge'
import type { BillingUsageSchema } from '@/features/pricing/types'
import { toIntlLocale } from '@/i18n/languages'
import { formatCurrencyFromUSD } from '@/lib/currency'
import { formatLogQuota, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useSystemConfigStore } from '@/stores/system-config-store'

import type { UsageLog } from '../data/schema'
import { buildLogBilling, type BillingLine } from '../lib/billing-breakdown'
import type { LogOtherData } from '../types'

function billingLineTone(line: BillingLine): string {
  if (line.tool) {
    return 'border-orange-500/25 bg-orange-500/10 !text-orange-800 dark:!text-orange-200'
  }
  if (line.label.startsWith('Cache Write')) {
    return 'border-amber-500/25 bg-amber-500/10 !text-amber-800 dark:!text-amber-200'
  }
  if (line.label === 'Cache Read' || line.label === 'Image Cache') {
    return 'border-emerald-500/25 bg-emerald-500/10 !text-emerald-800 dark:!text-emerald-200'
  }
  if (['Output', 'Audio Out', 'Image Out'].includes(line.label)) {
    return 'border-violet-500/25 bg-violet-500/10 !text-violet-800 dark:!text-violet-200'
  }
  if (['Input', 'Audio In', 'Image In'].includes(line.label)) {
    return 'border-sky-500/25 bg-sky-500/10 !text-sky-800 dark:!text-sky-200'
  }
  return 'border-indigo-500/25 bg-indigo-500/10 !text-indigo-800 dark:!text-indigo-200'
}

function BillingChargeTerm(props: {
  line: BillingLine
  quantity: string
  price: string
  subtotal: string
}) {
  const { t } = useTranslation()
  return (
    <div
      role='group'
      aria-label={t(props.line.label)}
      className={cn(
        'grid min-w-0 max-w-full gap-2 rounded-lg border p-2.5',
        billingLineTone(props.line)
      )}
    >
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1'>
        <StatusBadge
          label={t(props.line.label)}
          type='badge'
          copyable={false}
          className='bg-background/70 h-auto rounded-md px-2 py-0.5 !text-inherit'
        />
        <span className='text-base font-semibold' title={t('Quantity')}>
          {props.quantity}
        </span>
      </div>
      <div className='flex flex-wrap items-center gap-1.5 text-xs'>
        <span aria-hidden>×</span>
        <span className='sr-only'>{t('Unit Price')}</span>
        <StatusBadge
          label={props.price}
          type='badge'
          copyable={false}
          className='bg-background/70 h-auto rounded-md px-2 py-1 !text-inherit [&_span]:break-all [&_span]:whitespace-normal'
        />
      </div>
      <div className='flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-current/15 pt-1.5 text-xs'>
        <span>{t('Subtotal')}</span>
        <strong className='break-all'>= {props.subtotal}</strong>
      </div>
    </div>
  )
}

export function LogBillingFormula(props: {
  log: UsageLog
  other: LogOtherData
  schema?: BillingUsageSchema
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const currency = useSystemConfigStore((state) => state.config?.currency)
  const result = buildLogBilling(
    props.log,
    props.other,
    currency?.quotaPerUnit || 500000,
    props.schema
  )
  const money = (usd: number) =>
    formatCurrencyFromUSD(usd, {
      digitsLarge: 8,
      digitsSmall: 10,
      abbreviate: false,
      locale,
    })
  // Fractional task quantities must retain the precision used by settlement.
  const preciseQuantity = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 20,
  })
  const quantity = (value: number) =>
    Number.isInteger(value)
      ? formatNumber(value, locale)
      : preciseQuantity.format(value)
  const baseLines = result.lines.filter((line) => !line.tool)
  const toolLines = result.lines.filter((line) => line.tool)
  const unitPrice = (line: BillingLine) => {
    if (line.divisor === 1_000_000) return `${money(line.price)} / 1M`
    if (line.divisor === 1000) return `${money(line.price)} / 1K`
    return money(line.price)
  }
  const renderTerm = (line: BillingLine, index: number) => (
    <Fragment key={`${line.label}-${index}`}>
      {index > 0 && <span className='text-muted-foreground text-lg'>+</span>}
      <BillingChargeTerm
        line={line}
        quantity={quantity(line.quantity)}
        price={unitPrice(line)}
        subtotal={money((line.quantity * line.price) / line.divisor)}
      />
    </Fragment>
  )
  return (
    <section className='space-y-4' aria-label={t('Billing calculation')}>
      <div className='bg-muted/20 rounded-lg border p-3 sm:p-4'>
        <h3 className='text-muted-foreground mb-3 text-xs font-medium'>
          {t('Billing calculation')}
        </h3>
        {result.complete ? (
          <div className='space-y-3 tabular-nums'>
            <div className='flex min-w-0 flex-wrap items-center gap-2'>
              {toolLines.length > 0 && (
                <span className='text-muted-foreground text-xl'>(</span>
              )}
              <span className='text-muted-foreground text-xl'>(</span>
              <div className='flex max-w-full min-w-0 flex-wrap items-center gap-2'>
                {baseLines.length > 0 ? baseLines.map(renderTerm) : '0'}
              </div>
              <span className='text-muted-foreground text-xl'>)</span>
              {result.requestRatio !== 1 && (
                <StatusBadge
                  type='badge'
                  copyable={false}
                  label={`× ${t('Request multiplier')} ${quantity(result.requestRatio)}`}
                  className='h-auto rounded-md border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-1 !text-fuchsia-800 dark:!text-fuchsia-200'
                />
              )}
              {toolLines.length > 0 && (
                <>
                  <span className='text-muted-foreground text-lg'>+</span>
                  {toolLines.map(renderTerm)}
                  <span className='text-muted-foreground text-xl'>)</span>
                </>
              )}
            </div>
            <div className='flex flex-wrap items-center gap-2 border-t pt-3'>
              <StatusBadge
                type='badge'
                copyable={false}
                label={`× ${t('Group Ratio')} ${quantity(result.ratio ?? 1)}`}
                className='h-auto rounded-md border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-1 !text-fuchsia-800 dark:!text-fuchsia-200'
              />
              {Math.abs(result.rounding) > 1e-12 && (
                <StatusBadge
                  type='badge'
                  copyable={false}
                  label={`${result.rounding < 0 ? '−' : '+'} ${t('Rounding')} ${money(Math.abs(result.rounding))}`}
                  className='bg-muted h-auto rounded-md border px-2 py-1 !text-xs'
                />
              )}
              <div className='ml-auto flex flex-wrap items-center gap-2 rounded-lg bg-emerald-500/15 px-3 py-2 text-emerald-900 dark:text-emerald-200'>
                <span className='text-xs'>{t('Total Cost')}</span>
                <strong className='text-xl'>
                  = {formatLogQuota(props.log.quota)}
                </strong>
              </div>
            </div>
          </div>
        ) : (
          <div className='space-y-2'>
            <p className='text-primary text-base font-semibold'>
              {t('Total Cost')}: {formatLogQuota(props.log.quota)}
            </p>
            <p className='text-muted-foreground text-xs'>
              {t(
                'The recorded data cannot fully reconstruct this charge. The settled total is authoritative.'
              )}
            </p>
          </div>
        )}
      </div>
      {result.lines.length > 0 && (
        <StaticDataTable<BillingLine>
          data={result.lines}
          columns={[
            {
              id: 'item',
              header: t('Item'),
              cell: (line) => (
                <StatusBadge
                  label={t(line.label)}
                  type='badge'
                  copyable={false}
                  className={cn(
                    'h-auto rounded-md border px-2 py-0.5',
                    billingLineTone(line)
                  )}
                />
              ),
            },
            {
              id: 'quantity',
              header: t('Quantity'),
              cell: (line) => quantity(line.quantity),
            },
            {
              id: 'price',
              header: t('Unit Price'),
              cell: (line) =>
                `${money(line.price)}${line.divisor > 1 ? ` / ${formatNumber(line.divisor, locale)}` : ''}`,
            },
            {
              id: 'subtotal',
              header: t('Subtotal'),
              cell: (line) =>
                money((line.quantity * line.price) / line.divisor),
            },
          ]}
        />
      )}
      <dl className='flex flex-wrap gap-x-6 gap-y-2 text-xs'>
        <div>
          <dt className='text-muted-foreground'>{t('Group Ratio')}</dt>
          <dd>{result.ratio ?? '—'}×</dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>{t('Request multiplier')}</dt>
          <dd>{result.requestRatio}×</dd>
        </div>
        {props.other.matched_tier && (
          <div>
            <dt className='text-muted-foreground'>{t('Matched Tier')}</dt>
            <dd>{props.other.matched_tier}</dd>
          </div>
        )}
      </dl>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Subtotals are before multipliers. The formula applies the recorded request and group ratios.'
        )}
      </p>
    </section>
  )
}
