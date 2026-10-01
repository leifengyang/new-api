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
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { BadgeCell } from '@/components/data-table'
import { GroupBadge } from '@/components/group-badge'
import { StatusBadge, type StatusBadgeProps } from '@/components/status-badge'
import { LogCostDisplay } from '@/features/usage-logs/components/log-cost-display'
import {
  logTypeBadgeClassName,
  logBadgeClassName,
  logBadgeTone,
} from '@/features/usage-logs/components/log-table-style'
import { ModelBadge } from '@/features/usage-logs/components/model-badge'
import { TimingMetricsCell } from '@/features/usage-logs/components/timing-metrics-cell'
import { TokenUsageCell } from '@/features/usage-logs/components/token-usage-cell'
import { LOG_TYPE_ALL_VALUE } from '@/features/usage-logs/constants'
import type { UsageLog } from '@/features/usage-logs/data/schema'
import {
  getLogTypeConfig,
  isDisplayableLogType,
  isTimingLogType,
  parseLogOther,
} from '@/features/usage-logs/lib'
import { formatTimestampToDate } from '@/lib/format'
import { cn } from '@/lib/utils'

import { EnterpriseLogDetailsCell } from './enterprise-log-details-cell'

/**
 * 企业成员日志的列。刻意不用 `useCommonLogsColumns`：那一份把渠道列和用户列
 * 都锁在 isAdmin 后面，而这里恰恰相反 —— 成员列必须给，渠道列一个字段都不该
 * 出现（服务端也不下发）。其余单元格直接复用平台上那几个无上下文的展示组件。
 */
export function useEnterpriseLogsColumns(): ColumnDef<UsageLog>[] {
  const { t } = useTranslation()

  return useMemo<ColumnDef<UsageLog>[]>(
    () => [
      {
        accessorKey: 'created_at',
        header: t('Time'),
        cell: ({ row }) => {
          const config = getLogTypeConfig(row.original.type)
          return (
            <div className='flex min-w-0 flex-col gap-0.5'>
              <span className='truncate font-mono text-xs tabular-nums'>
                {formatTimestampToDate(row.getValue('created_at') as number)}
              </span>
              <StatusBadge
                label={t(config.label)}
                variant={config.color as StatusBadgeProps['variant']}
                size='sm'
                copyable={false}
                type='badge'
                className={logTypeBadgeClassName}
              />
            </div>
          )
        },
        filterFn: (row, _id, value) => {
          if (!Array.isArray(value) || value.length === 0) return true
          if (value.includes(LOG_TYPE_ALL_VALUE)) return true
          return value.includes(String(row.original.type))
        },
        enableSorting: false,
        enableHiding: false,
        size: 180,
        meta: { mobileTitle: true },
      },
      {
        id: 'member',
        accessorFn: (row) => row.username || `#${row.user_id}`,
        header: t('Username'),
        cell: ({ row }) => (
          <span className='text-sm font-normal'>{row.getValue('member')}</span>
        ),
        enableSorting: false,
        size: 140,
        meta: { mobileOrder: 20 },
      },
      {
        accessorKey: 'model_name',
        header: t('Model'),
        cell: ({ row }) => <ModelBadge modelName={row.original.model_name} />,
        enableSorting: false,
        size: 180,
      },
      {
        accessorKey: 'group',
        header: t('User Group'),
        cell: ({ row }) => {
          const group = row.getValue('group') as string
          if (!group) {
            return <span className='text-muted-foreground text-xs'>-</span>
          }
          return (
            <BadgeCell>
              <GroupBadge
                group={group}
                type='badge'
                className={cn(logBadgeClassName, logBadgeTone.neutral)}
              />
            </BadgeCell>
          )
        },
        enableSorting: false,
        size: 120,
        meta: { mobileHidden: true },
      },
      {
        id: 'tokens',
        header: t('Tokens'),
        cell: ({ row }) => {
          const log = row.original
          if (!isDisplayableLogType(log.type)) return null
          return <TokenUsageCell log={log} />
        },
        enableSorting: false,
        size: 200,
        meta: { mobileOrder: 35 },
      },
      {
        accessorKey: 'quota',
        header: t('Cost'),
        cell: ({ row }) => (
          <LogCostDisplay
            quota={row.original.quota}
            other={parseLogOther(row.original.other)}
          />
        ),
        enableSorting: false,
        size: 120,
        meta: { mobileBadge: true },
      },
      {
        accessorKey: 'use_time',
        header: t('Timing'),
        cell: ({ row }) => {
          const log = row.original
          if (!isTimingLogType(log.type)) return null
          return (
            <TimingMetricsCell
              useTimeSec={log.use_time}
              completionTokens={log.completion_tokens}
              frtMs={parseLogOther(log.other)?.frt}
              isStream={log.is_stream}
            />
          )
        },
        enableSorting: false,
        size: 150,
        meta: { mobileHidden: true },
      },
      {
        id: 'details',
        header: t('Details'),
        cell: ({ row }) => <EnterpriseLogDetailsCell log={row.original} />,
        size: 120,
        maxSize: 140,
      },
    ],
    [t]
  )
}
