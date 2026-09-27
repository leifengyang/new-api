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

import { ActivityTimeCell } from '@/components/activity-time-cell'
import { BadgeCell } from '@/components/data-table'
import { GroupBadge } from '@/components/group-badge'
import { LongText } from '@/components/long-text'
import { StatusBadge } from '@/components/status-badge'
import { TableId } from '@/components/table-id'
import { getCurrencyDisplay } from '@/lib/currency'
import { formatQuota } from '@/lib/format'
import { useSystemConfigStore } from '@/stores/system-config-store'

import { ENTERPRISE_MEMBER_STATUSES } from '../constants'
import { formatLimitSummary, parseStoredLimits } from '../lib/limits'
import type { EnterpriseMember } from '../types'
import { EnterpriseMemberActions } from './enterprise-member-actions'

export function useEnterpriseMembersColumns(): ColumnDef<EnterpriseMember>[] {
  const { t } = useTranslation()
  const currencyConfig = useSystemConfigStore((state) => state.config.currency)
  const { meta: currency } = getCurrencyDisplay()
  const quotaUnit = currency.kind === 'tokens' ? t('Tokens') : currency.symbol

  return useMemo<ColumnDef<EnterpriseMember>[]>(
    () => [
      {
        accessorKey: 'id',
        header: t('ID'),
        cell: ({ row }) => (
          <TableId
            value={row.getValue('id') as number}
            className='w-[60px] [font-family:inherit] text-sm'
          />
        ),
        size: 80,
        meta: { mobileOrder: 10 },
      },
      {
        accessorKey: 'username',
        header: t('Username'),
        cell: ({ row }) => {
          const username = row.getValue('username') as string
          const displayName = row.original.display_name
          return (
            <div className='flex min-w-[160px] flex-col gap-1'>
              <LongText className='max-w-[140px] text-sm font-normal'>
                {username}
              </LongText>
              {displayName && displayName !== username && (
                <div
                  data-table-text='secondary'
                  className='text-muted-foreground max-w-[180px] text-xs font-normal'
                >
                  <LongText>{displayName}</LongText>
                </div>
              )}
            </div>
          )
        },
        enableSorting: false,
        size: 200,
        meta: { mobileTitle: true },
      },
      {
        accessorKey: 'status',
        header: t('Status'),
        cell: ({ row }) => {
          const config =
            ENTERPRISE_MEMBER_STATUSES[
              row.original.status as keyof typeof ENTERPRISE_MEMBER_STATUSES
            ]
          if (!config) return null
          return (
            <StatusBadge
              label={t(config.labelKey)}
              variant={config.variant}
              copyable={false}
              className='font-normal'
            />
          )
        },
        filterFn: (row, id, value) => value.includes(String(row.getValue(id))),
        enableSorting: false,
        size: 110,
        meta: { mobileBadge: true },
      },
      {
        id: 'quota',
        accessorKey: 'quota',
        header: `${t('Available Balance')} (${quotaUnit})`,
        cell: ({ row }) => (
          <span className='font-mono text-sm tabular-nums'>
            {formatQuota(row.original.quota)}
          </span>
        ),
        enableSorting: false,
        size: 150,
        meta: { mobileOrder: 30 },
      },
      {
        accessorKey: 'used_quota',
        header: t('Total Usage'),
        cell: ({ row }) => (
          <span className='font-mono text-sm tabular-nums'>
            {formatQuota(row.original.used_quota)}
          </span>
        ),
        enableSorting: false,
        size: 150,
        meta: { mobileHidden: true },
      },
      {
        accessorKey: 'group',
        header: t('User Group'),
        cell: ({ row }) => (
          <BadgeCell>
            <GroupBadge
              group={row.getValue('group') as string}
              className='font-normal'
            />
          </BadgeCell>
        ),
        enableSorting: false,
        size: 130,
        meta: { mobileHidden: true },
      },
      {
        id: 'limits',
        header: t('Visible Range'),
        cell: ({ row }) => {
          const groups = formatLimitSummary(
            parseStoredLimits(row.original.enterprise_group_limits),
            t,
            2
          )
          const models = formatLimitSummary(
            parseStoredLimits(row.original.enterprise_model_limits),
            t,
            2
          )
          return (
            <div
              data-table-text='secondary'
              className='min-w-0 space-y-1 text-xs font-normal'
            >
              <LongText>
                {t('Groups')}: <span className='tabular-nums'>{groups}</span>
              </LongText>
              <LongText className='text-muted-foreground'>
                {t('Models')}: <span className='tabular-nums'>{models}</span>
              </LongText>
            </div>
          )
        },
        enableSorting: false,
        size: 220,
        meta: { mobileHidden: true },
      },
      {
        accessorKey: 'created_at',
        header: t('Time'),
        cell: ({ row }) => (
          <ActivityTimeCell
            createdAt={row.original.created_at ?? 0}
            lastAt={row.original.last_login_at ?? 0}
            lastLabel={t('Last Login')}
            format='absolute'
          />
        ),
        enableSorting: false,
        size: 240,
        minSize: 220,
        meta: { mobileHidden: true },
      },
      {
        id: 'actions',
        header: () => t('Actions'),
        cell: ({ row }) => <EnterpriseMemberActions row={row.original} />,
        meta: { pinned: 'right' as const },
      },
    ],
    // formatQuota 读的是货币配置 store，切货币要重算这一列。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, quotaUnit, currencyConfig]
  )
}
