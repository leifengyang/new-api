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
import { useQuery } from '@tanstack/react-query'
import { Coins, ListChecks, Users, ChartNoAxesCombined } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { StatCard } from '@/features/dashboard/components/ui/stat-card'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import { getCompensationData } from './api'
import {
  dimensionLabels,
  type ReportOverview as Overview,
  type ReportFilter,
  type Aggregate,
  aggregateLabel,
} from './report-api'

export function ReportOverview(props: {
  filter: ReportFilter
  onDrill: (dimensions: string[], row: Aggregate) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [metric, setMetric] = useState<'quota' | 'count'>('quota')
  const query = useQuery({
    queryKey: ['stream-compensation', 'overview', props.filter],
    queryFn: () =>
      getCompensationData<Overview>('/admin/report/overview', props.filter),
    refetchInterval: 30_000,
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />
  const data = query.data
  const money = (amount: number) =>
    formatQuotaWithCurrency(amount, { digitsSmall: 6, digitsLarge: 6 })
  return (
    <div className='space-y-4'>
      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard
          title={t('Stream credits')}
          value={money(data.quota)}
          description={t('Successfully credited only')}
          icon={Coins}
          sparkline={data.trend.map((r) => r.quota)}
        />
        <StatCard
          title={t('Compensated requests')}
          value={formatNumber(data.count, locale)}
          description={t('Successfully credited only')}
          icon={ListChecks}
          tone='accent-2'
        />
        <StatCard
          title={t('Affected users')}
          value={formatNumber(data.users, locale)}
          description={t('Unique users')}
          icon={Users}
          tone='accent-3'
        />
        <StatCard
          title={t('Average credit')}
          value={money(data.count ? data.quota / data.count : 0)}
          description={t('Per compensated request')}
          icon={ChartNoAxesCombined}
        />
      </div>
      <section className='rounded-xl border p-4'>
        <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
          <h2 className='font-semibold'>{t('Compensation trend')}</h2>
          <div className='flex gap-1'>
            <Button
              size='sm'
              variant={metric === 'quota' ? 'secondary' : 'ghost'}
              onClick={() => setMetric('quota')}
            >
              {t('Stream credits')}
            </Button>
            <Button
              size='sm'
              variant={metric === 'count' ? 'secondary' : 'ghost'}
              onClick={() => setMetric('count')}
            >
              {t('Compensated requests')}
            </Button>
          </div>
        </div>
        {data.trend.length === 0 ? (
          <EmptyState title={t('No compensation records')} />
        ) : (
          <ChartContainer
            className='h-60 w-full'
            config={{
              [metric]: {
                label:
                  metric === 'quota'
                    ? t('Stream credits')
                    : t('Compensated requests'),
                color: 'var(--chart-2)',
              },
            }}
          >
            <AreaChart data={data.trend} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis dataKey='d0' tickFormatter={(v: string) => v.slice(5)} />
              <YAxis
                tickFormatter={(v: number) =>
                  metric === 'quota'
                    ? formatQuotaWithCurrency(v)
                    : formatNumber(v, locale)
                }
                width={85}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) =>
                      metric === 'quota'
                        ? money(Number(value))
                        : formatNumber(Number(value), locale)
                    }
                  />
                }
              />
              <Area
                type='monotone'
                dataKey={metric}
                stroke={`var(--color-${metric})`}
                fill={`var(--color-${metric})`}
                fillOpacity={0.15}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </section>
      <div className='grid gap-4 xl:grid-cols-3'>
        {Object.entries(data.rankings).map(([dimension, rows]) => (
          <section
            key={dimension}
            className='min-w-0 space-y-2 rounded-xl border p-4'
          >
            <h2 className='mb-3 font-semibold'>
              {t(dimensionLabels[dimension])} · {t('Top 10 by credit')}
            </h2>
            {rows.length === 0 && (
              <p className='text-muted-foreground text-sm'>
                {t('No compensation records')}
              </p>
            )}
            {rows.map((row, index) => (
              <Button
                key={row.d0}
                variant='ghost'
                className='h-auto w-full min-w-0 justify-between gap-3 py-2'
                onClick={() => props.onDrill([dimension], row)}
              >
                <span className='min-w-0 truncate text-left'>
                  <span className='text-muted-foreground mr-2 tabular-nums'>
                    {index + 1}
                  </span>
                  {aggregateLabel(dimension, row.d0, row.l0, t('Unknown'))}
                </span>
                <span className='shrink-0 text-emerald-600 dark:text-emerald-400'>
                  {money(row.quota)}
                </span>
              </Button>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
