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
import { VChart } from '@visactor/react-vchart'
import { ChartPie, TrendingUp } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getDashboardChartColors } from '@/features/dashboard/lib/charts'
import { formatQuota } from '@/lib/format'
import { useChartTheme } from '@/lib/use-chart-theme'
import { VCHART_OPTION } from '@/lib/vchart'

import {
  OTHER_SHARE_KEY,
  hasUsage,
  type DailyUsagePoint,
  type UsageShare,
} from '../lib/usage'

/** 趋势点数超过这个数就不再画点，否则横轴会被点糊成一条线。 */
const MAX_TREND_POINTS_WITH_DOTS = 31

interface EnterpriseUsageChartsProps {
  modelShares: UsageShare[]
  trend: DailyUsagePoint[]
  loading: boolean
}

function ChartPlaceholder(props: { message: string }) {
  return (
    <div className='text-muted-foreground/80 flex h-full items-center justify-center text-xs'>
      {props.message}
    </div>
  )
}

function EnterpriseModelShareChart(props: { shares: UsageShare[] }) {
  const { t } = useTranslation()
  const { resolvedTheme, themeReady } = useChartTheme()

  const spec = useMemo(() => {
    // 全是 0 的时候画出来是个空环，不如直接说这一段时间没有用量。
    if (!props.shares.some((entry) => entry.quota > 0)) return null
    const domain = props.shares.map((entry) =>
      entry.key === OTHER_SHARE_KEY ? t('Other') : entry.key
    )
    return {
      type: 'pie' as const,
      data: [
        {
          id: 'enterprise-model-share',
          values: props.shares.map((entry, index) => ({
            type: domain[index],
            // 用额度而不是请求数：这是「钱花在哪个模型上」的占比。
            value: entry.quota,
          })),
        },
      ],
      outerRadius: 0.8,
      innerRadius: 0.5,
      padAngle: 0.6,
      valueField: 'value',
      categoryField: 'type',
      color: {
        type: 'ordinal' as const,
        domain,
        range: getDashboardChartColors(domain.length),
      },
      legends: { visible: true, orient: 'left' as const },
      label: { visible: false },
      tooltip: {
        mark: {
          content: [
            {
              key: (datum: Record<string, unknown>) =>
                String(datum?.type ?? ''),
              value: (datum: Record<string, unknown>) =>
                formatQuota(Number(datum?.value) || 0),
            },
          ],
        },
      },
      animationAppear: { duration: 500 },
    }
  }, [props.shares, t])

  return (
    <Card className='overflow-hidden'>
      <CardHeader>
        <CardTitle className='inline-flex items-center gap-2 text-base'>
          <ChartPie className='text-primary size-4' />
          {t('Model Share')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className='h-64 sm:h-72'>
          {!themeReady || !spec ? (
            <ChartPlaceholder message={t('No usage in this period')} />
          ) : (
            <VChart
              key={`enterprise-model-share-${resolvedTheme}`}
              spec={{
                ...spec,
                theme: resolvedTheme === 'dark' ? 'dark' : 'light',
                background: 'transparent',
              }}
              option={VCHART_OPTION}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function EnterpriseUsageTrendChart(props: { trend: DailyUsagePoint[] }) {
  const { t } = useTranslation()
  const { resolvedTheme, themeReady } = useChartTheme()
  const chartTextColor =
    resolvedTheme === 'dark'
      ? 'rgba(255, 255, 255, 0.68)'
      : 'rgba(15, 23, 42, 0.58)'
  const chartGridColor =
    resolvedTheme === 'dark'
      ? 'rgba(255, 255, 255, 0.12)'
      : 'rgba(15, 23, 42, 0.12)'

  const spec = useMemo(() => {
    // 折线是把区间里的每一天都补了 0 的，所以「一条压在地上的平线」既可能是真没
    // 人用，也可能是数据没落库；后者由页面顶部的提示负责，前者在这里说清楚。
    if (!hasUsage(props.trend)) return null
    return {
      type: 'area' as const,
      data: [{ id: 'enterprise-usage-trend', values: props.trend }],
      xField: 'date',
      yField: 'quota',
      point: { visible: props.trend.length <= MAX_TREND_POINTS_WITH_DOTS },
      line: { style: { lineWidth: 2, curveType: 'monotone' as const } },
      area: { style: { fillOpacity: 0.08, curveType: 'monotone' as const } },
      axes: [
        {
          orient: 'bottom' as const,
          label: {
            style: { fill: chartTextColor, fontSize: 10 },
            autoHide: true,
            autoLimit: true,
          },
          tick: { visible: false },
        },
        {
          orient: 'left' as const,
          label: {
            formatMethod: (val: number | string) =>
              formatQuota(Number(val) || 0),
            style: { fill: chartTextColor, fontSize: 10 },
          },
          grid: {
            visible: true,
            style: { lineDash: [3, 3], stroke: chartGridColor },
          },
        },
      ],
      tooltip: {
        mark: {
          content: [
            {
              key: (datum: Record<string, unknown>) =>
                String(datum?.date ?? ''),
              value: (datum: Record<string, unknown>) =>
                `${formatQuota(Number(datum?.quota) || 0)} · ${t('{{count}} requests', { count: Number(datum?.count) || 0 })}`,
            },
          ],
        },
      },
      animationAppear: { duration: 500 },
    }
  }, [props.trend, chartGridColor, chartTextColor, t])

  return (
    <Card className='overflow-hidden'>
      <CardHeader>
        <CardTitle className='inline-flex items-center gap-2 text-base'>
          <TrendingUp className='text-primary size-4' />
          {t('Usage Trend')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className='h-64 sm:h-72'>
          {!themeReady || !spec ? (
            <ChartPlaceholder message={t('No usage in this period')} />
          ) : (
            <VChart
              key={`enterprise-usage-trend-${resolvedTheme}-${props.trend.length}-${props.trend[0]?.timestamp ?? 0}`}
              spec={{
                ...spec,
                theme: resolvedTheme === 'dark' ? 'dark' : 'light',
                background: 'transparent',
              }}
              option={VCHART_OPTION}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function EnterpriseUsageCharts(props: EnterpriseUsageChartsProps) {
  if (props.loading) {
    return (
      <div className='grid gap-4 lg:grid-cols-2'>
        <Skeleton className='h-[380px] w-full' />
        <Skeleton className='h-[380px] w-full' />
      </div>
    )
  }

  return (
    <div className='grid gap-4 lg:grid-cols-2'>
      <EnterpriseModelShareChart shares={props.modelShares} />
      <EnterpriseUsageTrendChart trend={props.trend} />
    </div>
  )
}
