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
import { Link } from '@tanstack/react-router'
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTablePagination, StaticDataTable } from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { Main } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import {
  getChampionData,
  useChampionMutation,
  type ChampionAdminData,
  type ChampionEvent,
} from './api'
import { ChampionBadge } from './badge'
import { championTitle } from './badge-titles'
import { ChampionSettings } from './settings'

const reasonKeys: Record<string, string> = {
  deleted: 'Deleted user',
  administrator: 'Administrator',
  disabled: 'Disabled',
  excluded: 'Excluded test account',
  ineligible: 'Not eligible',
}
const statusKeys: Record<string, string> = {
  preview: 'Preview',
  pending: 'Pending',
  credited: 'Credited',
  skipped: 'Skipped',
  draft: 'Draft',
  awarding: 'Awarding',
  completed: 'Completed',
}

export function ChampionAdmin() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const [excluded, setExcluded] = useState(false)
  const [confirm, setConfirm] = useState<ChampionEvent | null>(null)
  const mutation = useChampionMutation()
  const query = useQuery({
    queryKey: ['champion-event', 'admin', pagination, excluded],
    queryFn: () =>
      getChampionData<ChampionAdminData>('/api/user/champion-event/admin', {
        p: pagination.pageIndex + 1,
        page_size: pagination.pageSize,
        excluded,
      }),
    refetchInterval: 30_000,
  })
  const table = useReactTable({
    data: query.data?.items ?? [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: query.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  const data = query.data
  const event = data?.event
  const canConfirm =
    !!data &&
    data.server_time >= data.end_at &&
    event?.snapshot_end === data.end_at &&
    event.snapshot_at > 0 &&
    event.status === 'draft'
  return (
    <Main>
      <div className='mx-auto w-full max-w-7xl space-y-5 overflow-auto p-4 sm:p-6'>
        <header className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-semibold'>
              {t('Championship activity management')}
            </h1>
            <p className='text-muted-foreground mt-1 text-sm'>
              {t('Activity period: November 14–15, 2026 (Beijing time)')}
            </p>
          </div>
          <Button variant='outline' render={<Link to='/championship' />}>
            {t('View championship activity')}
          </Button>
        </header>
        {query.isPending && <LoadingState />}
        {query.isError && <ErrorState onRetry={() => void query.refetch()} />}
        {data && event && (
          <>
            <ChampionSettings key={`${event.revision}`} event={event} />
            <div className='grid gap-3 sm:grid-cols-4'>
              {[
                [t('Eligible participants'), formatNumber(event.participants)],
                [
                  t('Total reward budget'),
                  formatQuotaWithCurrency(event.total_quota),
                ],
                [t('Credited'), formatNumber(data.credited)],
                [t('Pending'), formatNumber(data.pending)],
              ].map(([label, value]) => (
                <div key={label} className='rounded-xl border p-4'>
                  <p className='text-muted-foreground text-sm'>{label}</p>
                  <p className='mt-2 text-2xl font-semibold'>{value}</p>
                </div>
              ))}
            </div>
            <div className='space-y-3 rounded-xl border p-4'>
              <div className='flex flex-wrap items-center gap-3'>
                <Badge variant='outline'>
                  {t(statusKeys[event.status] ?? 'Unknown')}
                </Badge>
                <Button
                  disabled={mutation.isPending || event.status !== 'draft'}
                  onClick={() =>
                    mutation.mutate({
                      path: '/admin/preview',
                      method: 'post',
                      body: { revision: event.revision },
                    })
                  }
                >
                  {t('Generate award preview')}
                </Button>
                <Button
                  disabled={mutation.isPending || !canConfirm}
                  onClick={() => setConfirm(event)}
                >
                  {t('Confirm and award')}
                </Button>
                {event.status === 'awarding' && (
                  <Button
                    variant='outline'
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        path: '/admin/confirm',
                        method: 'post',
                        body: { revision: event.revision },
                      })
                    }
                  >
                    {t('Retry pending rewards')}
                  </Button>
                )}
              </div>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Review the list and budget before awarding. Confirmation freezes the ranking. Retrying never credits a user twice.'
                )}
              </p>
              {!!event.snapshot_at && (
                <p className='text-muted-foreground text-xs'>
                  {t('Ranking snapshot')}:{' '}
                  {dayjs.unix(event.snapshot_at).format('YYYY-MM-DD HH:mm:ss')}
                </p>
              )}
              {event.unknown_logs > 0 && (
                <p
                  role='status'
                  className='text-sm text-amber-800 dark:text-amber-300'
                >
                  {t(
                    '{{count}} records have an unconfirmed funding source and are excluded from ranking.',
                    { count: event.unknown_logs }
                  )}
                </p>
              )}
              {data.skipped > 0 && (
                <p
                  role='status'
                  className='text-sm text-amber-800 dark:text-amber-300'
                >
                  {t(
                    '{{count}} rewards were skipped because the account became ineligible.',
                    { count: data.skipped }
                  )}
                </p>
              )}
            </div>
            <div className='flex gap-2'>
              {[false, true].map((value) => (
                <Button
                  key={String(value)}
                  variant={excluded === value ? 'secondary' : 'ghost'}
                  onClick={() => {
                    setExcluded(value)
                    setPagination({ ...pagination, pageIndex: 0 })
                  }}
                >
                  {value ? t('Excluded accounts') : t('Award list')}
                </Button>
              ))}
            </div>
            <StaticDataTable
              data={data.items}
              getRowKey={(row) => row.id}
              emptyContent={t('Generate an award preview to see the list.')}
              columns={[
                {
                  id: 'rank',
                  header: t('Rank'),
                  cell: (row) =>
                    row.position > 0 ? formatNumber(row.position) : '—',
                },
                {
                  id: 'user',
                  header: t('User'),
                  cell: (row) => (
                    <span>
                      {row.username}{' '}
                      <span className='text-muted-foreground'>
                        #{row.user_id}
                      </span>
                    </span>
                  ),
                },
                {
                  id: 'spend',
                  header: t('Activity consumption'),
                  cell: (row) => formatQuotaWithCurrency(row.spend),
                },
                {
                  id: 'reward',
                  header: t('Reward'),
                  cell: (row) =>
                    row.quota ? formatQuotaWithCurrency(row.quota) : '—',
                },
                {
                  id: 'badge',
                  header: t('Badge'),
                  cell: (row) =>
                    row.position > 0 ? (
                      <span className='flex items-center gap-2'>
                        <ChampionBadge
                          badge={Math.min(row.position, 8)}
                          small
                        />
                        {t(championTitle(Math.min(row.position, 8)))}
                      </span>
                    ) : (
                      '—'
                    ),
                },
                {
                  id: 'status',
                  header: t('Status'),
                  cell: (row) => (
                    <Badge variant='outline'>
                      {t(
                        reasonKeys[row.reason] ||
                          statusKeys[row.status] ||
                          'Unknown'
                      )}
                    </Badge>
                  ),
                },
              ]}
            />
            <DataTablePagination table={table} />
            <ConfirmDialog
              open={!!confirm}
              onOpenChange={(open) => {
                if (!open) setConfirm(null)
              }}
              title={t('Confirm championship rewards')}
              desc={
                confirm?.revision !== event.revision
                  ? t('The activity changed. Refresh and try again.')
                  : t(
                      'Award {{amount}} to {{count}} users and issue permanent badges? This cannot be undone.',
                      {
                        amount: formatQuotaWithCurrency(
                          confirm?.total_quota ?? 0
                        ),
                        count: confirm?.participants ?? 0,
                      }
                    )
              }
              confirmText={t('Confirm and award')}
              isLoading={mutation.isPending}
              disabled={!canConfirm || confirm?.revision !== event.revision}
              handleConfirm={() => {
                if (
                  !canConfirm ||
                  !confirm ||
                  confirm.revision !== event.revision
                ) {
                  return
                }
                mutation.mutate(
                  {
                    path: '/admin/confirm',
                    method: 'post',
                    body: { revision: confirm.revision },
                  },
                  { onSuccess: () => setConfirm(null) }
                )
              }}
            />
          </>
        )}
      </div>
    </Main>
  )
}
