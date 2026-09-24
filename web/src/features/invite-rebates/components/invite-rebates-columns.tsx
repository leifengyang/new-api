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
/* eslint-disable react-refresh/only-export-components */
import type { ColumnDef, Row } from '@tanstack/react-table'
import { RotateCcw } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { TimestampCell } from '@/components/activity-time-cell'
import { DataTableRowActionMenu } from '@/components/data-table/core/row-action-menu'
import { LongText } from '@/components/long-text'
import { StatusBadge } from '@/components/status-badge'
import { TableId } from '@/components/table-id'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatInviteRebatePercent } from '@/features/system-settings/general/invite-rebate-rate'
import { toIntlLocale } from '@/i18n/languages'
import { getCurrencyDisplay } from '@/lib/currency'
import { formatQuota } from '@/lib/format'
import { useSystemConfigStore } from '@/stores/system-config-store'

import {
  INVITE_REBATE_STATUS,
  INVITE_REBATE_STATUSES,
  getInviteRebateSourceLabel,
  getSkipReasonLabel,
} from '../constants'
import type { InviteRebate } from '../types'
import { useInviteRebates } from './invite-rebates-provider'

/**
 * A rebate is only reversible while it still holds an outstanding amount, so
 * everything already clawed back (or never credited) leaves the action out.
 */
const isReversible = (rebate: InviteRebate) =>
  rebate.status === INVITE_REBATE_STATUS.CREDITED &&
  rebate.outstanding_quota > 0

function PersonCell(props: { name: string; userId: number }) {
  return (
    <div className='flex min-w-0 flex-col gap-1'>
      <LongText className='max-w-[160px] text-sm font-normal'>
        {props.name}
      </LongText>
      <span
        data-table-text='secondary'
        className='text-muted-foreground text-xs tabular-nums'
      >
        ID: {props.userId}
      </span>
    </div>
  )
}

function ReverseRowAction({ row }: { row: Row<InviteRebate> }) {
  const { t } = useTranslation()
  const { setReversingRow } = useInviteRebates()

  if (!isReversible(row.original)) {
    return <span className='text-muted-foreground text-sm'>—</span>
  }

  return (
    <DataTableRowActionMenu ariaLabel={t('Open menu')}>
      <DropdownMenuItem
        variant='destructive'
        onSelect={(event) => {
          event.preventDefault()
          setReversingRow(row.original)
        }}
      >
        {t('Reverse Rebate')}
        <DropdownMenuShortcut>
          <RotateCcw size={16} />
        </DropdownMenuShortcut>
      </DropdownMenuItem>
    </DataTableRowActionMenu>
  )
}

export function useInviteRebatesColumns(): ColumnDef<InviteRebate>[] {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const currencyConfig = useSystemConfigStore((state) => state.config.currency)
  const { meta: currency } = getCurrencyDisplay()
  const quotaUnit = currency.kind === 'tokens' ? t('Tokens') : currency.symbol

  return useMemo<ColumnDef<InviteRebate>[]>(
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
      },
      {
        id: 'inviter',
        header: t('Inviter'),
        cell: ({ row }) => (
          <PersonCell
            name={row.original.inviter_name}
            userId={row.original.inviter_id}
          />
        ),
        size: 180,
      },
      {
        id: 'invitee',
        header: t('Invitee'),
        cell: ({ row }) => (
          <PersonCell
            name={row.original.invitee_name}
            userId={row.original.invitee_id}
          />
        ),
        size: 180,
      },
      {
        accessorKey: 'source',
        header: t('Source'),
        cell: ({ row }) => (
          <div className='flex min-w-0 flex-col gap-1'>
            <span className='text-sm'>
              {getInviteRebateSourceLabel(row.original.source, t)}
            </span>
            {row.original.source_ref && (
              <div
                data-table-text='secondary'
                className='text-muted-foreground text-xs'
              >
                <LongText className='max-w-[160px]'>
                  {row.original.source_ref}
                </LongText>
              </div>
            )}
          </div>
        ),
        filterFn: (row, id, value: string[]) =>
          value.includes(String(row.getValue(id))),
        enableSorting: false,
        size: 180,
      },
      {
        accessorKey: 'base_quota',
        header: `${t('Top-up Amount')} (${quotaUnit})`,
        cell: ({ row }) => (
          <span className='text-sm tabular-nums'>
            {formatQuota(row.original.base_quota)}
          </span>
        ),
        enableSorting: false,
        size: 160,
      },
      {
        accessorKey: 'rate_basis_points',
        header: t('Rate'),
        cell: ({ row }) => (
          <span className='text-sm tabular-nums'>
            {formatInviteRebatePercent(row.original.rate_basis_points)}
          </span>
        ),
        enableSorting: false,
        size: 100,
      },
      {
        id: 'rebate_quota',
        header: `${t('Rebate')} (${quotaUnit})`,
        cell: ({ row }) => {
          const rebate = row.original
          return (
            <div className='flex min-w-0 flex-col gap-1'>
              <span className='text-sm tabular-nums'>
                {formatQuota(rebate.rebate_quota)}
              </span>
              {rebate.reversed_quota > 0 && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        data-table-text='secondary'
                        className='text-muted-foreground w-fit cursor-help text-xs tabular-nums'
                      />
                    }
                  >
                    {t('Reversed: {{amount}}', {
                      amount: formatQuota(rebate.reversed_quota),
                    })}
                    {rebate.outstanding_quota > 0
                      ? ` · ${t('Outstanding: {{amount}}', {
                          amount: formatQuota(rebate.outstanding_quota),
                        })}`
                      : ''}
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className='text-xs'>
                      {rebate.reverse_reason ||
                        t('Reversed by an administrator')}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        },
        enableSorting: false,
        size: 200,
      },
      {
        accessorKey: 'status',
        header: t('Status'),
        cell: ({ row }) => {
          const rebate = row.original
          const statusConfig =
            INVITE_REBATE_STATUSES[
              rebate.status as keyof typeof INVITE_REBATE_STATUSES
            ]

          if (!statusConfig) {
            return null
          }

          const badge = (
            <StatusBadge
              label={t(statusConfig.labelKey)}
              variant={statusConfig.variant}
              copyable={false}
              className='font-normal'
            />
          )

          if (rebate.status !== INVITE_REBATE_STATUS.SKIPPED) {
            return <div className='-ml-1.5'>{badge}</div>
          }

          return (
            <Tooltip>
              <TooltipTrigger render={<div className='-ml-1.5 cursor-help' />}>
                {badge}
              </TooltipTrigger>
              <TooltipContent>
                <p className='text-xs'>
                  {getSkipReasonLabel(rebate.skip_reason, t)}
                </p>
              </TooltipContent>
            </Tooltip>
          )
        },
        filterFn: (row, id, value: string[]) =>
          value.includes(String(row.getValue(id))),
        enableSorting: false,
        size: 140,
      },
      {
        accessorKey: 'created_at',
        header: t('Time'),
        cell: ({ row }) => (
          <TimestampCell
            timestamp={row.original.created_at}
            format='absolute'
            locale={locale}
            justNowLabel={t('Just now')}
            className='text-muted-foreground text-sm'
          />
        ),
        enableSorting: false,
        size: 200,
      },
      {
        id: 'actions',
        header: () => t('Actions'),
        cell: ({ row }) => <ReverseRowAction row={row} />,
        meta: { pinned: 'right' as const },
      },
    ],
    // formatQuota reads the currency configuration from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, locale, quotaUnit, currencyConfig]
  )
}
