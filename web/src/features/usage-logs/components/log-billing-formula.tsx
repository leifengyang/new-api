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
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import type { BillingUsageSchema } from '@/features/pricing/types'
import { toIntlLocale } from '@/i18n/languages'
import { formatCurrencyFromUSD } from '@/lib/currency'
import { formatLogQuota, formatNumber } from '@/lib/format'
import { useSystemConfigStore } from '@/stores/system-config-store'

import type { UsageLog } from '../data/schema'
import { buildLogBilling, type BillingLine } from '../lib/billing-breakdown'
import type { LogOtherData } from '../types'

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
  const term = (line: BillingLine) =>
    `${t(line.label)} ${quantity(line.quantity)} × ${money(line.price)}${line.divisor > 1 ? ` / ${formatNumber(line.divisor, locale)}` : ''}`
  const baseTerms =
    result.lines
      .filter((line) => !line.tool)
      .map(term)
      .join(' + ') || '0'
  const tools = result.lines
    .filter((line) => line.tool)
    .map(term)
    .join(' + ')
  const requestFactor =
    result.requestRatio !== 1 ? ` × ${result.requestRatio}` : ''
  const formula = `(${requestFactor || tools ? `(${baseTerms})` : baseTerms}${requestFactor}${tools ? ` + ${tools}` : ''}) × ${result.ratio ?? '—'}`
  return (
    <section className='space-y-4' aria-label={t('Billing calculation')}>
      <div className='bg-muted/40 rounded-lg border p-3 sm:p-4'>
        <h3 className='text-muted-foreground mb-2 text-xs font-medium'>
          {t('Billing calculation')}
        </h3>
        {result.complete ? (
          <p className='text-sm leading-7 break-words whitespace-normal tabular-nums'>
            {formula}
            {Math.abs(result.rounding) > 1e-12 && (
              <>
                {' '}
                {result.rounding < 0 ? '−' : '+'}{' '}
                {money(Math.abs(result.rounding))} ({t('Rounding')})
              </>
            )}
            {' = '}
            <strong className='text-primary text-base'>
              {formatLogQuota(props.log.quota)}
            </strong>
          </p>
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
            { id: 'item', header: t('Item'), cell: (line) => t(line.label) },
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
