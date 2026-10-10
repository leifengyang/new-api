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
import { CopyButton } from '@/components/copy-button'
import { DataTablePagination, StaticDataTable } from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { useAuthStore } from '@/stores/auth-store'

import {
  getCompensationData,
  useCompensationMutation,
  type Compensation,
  type CompensationPage,
} from './api'
import { fundingLabels, beijingTime } from './report-api'

export function CompensationRecords(props: {
  admin?: boolean
  batchID?: number
  reportFilters?: Record<string, string | number | boolean>
  pendingOnly?: boolean
}) {
  const { t } = useTranslation()
  const userID = useAuthStore((s) => s.auth.user?.id)
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })
  const [status, setStatus] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [dates, setDates] = useState({ start: '', end: '' })
  const [review, setReview] = useState<{
    record: Compensation
    approve: boolean
  } | null>(null)
  const mutation = useCompensationMutation()
  let endpoint = props.admin ? '/admin' : ''
  if (props.reportFilters) endpoint = '/admin/report/records'
  const query = useQuery({
    queryKey: [
      'stream-compensation',
      userID,
      'records',
      !!props.admin,
      props.batchID,
      pagination,
      status,
      filterUser,
      dates,
      props.reportFilters,
      props.pendingOnly,
    ],
    queryFn: () =>
      getCompensationData<
        Omit<CompensationPage, 'totals'> &
          Partial<Pick<CompensationPage, 'totals'>>
      >(endpoint, {
        p: pagination.pageIndex + 1,
        page_size: pagination.pageSize,
        status: status || (props.pendingOnly ? 'unsettled' : ''),
        user_id: props.admin ? filterUser : '',
        batch_id: props.batchID || 0,
        start_at: dates.start
          ? dayjs(`${dates.start}T00:00:00+08:00`).unix()
          : 0,
        end_at: dates.end
          ? dayjs(`${dates.end}T00:00:00+08:00`).add(1, 'day').unix()
          : 0,
        ...props.reportFilters,
      }),
    enabled: !!userID,
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
  const statusText: Record<string, string> = {
    credited: t('Credited'),
    review: t('Pending review'),
    pending: t('Pending'),
    skipped: t('Skipped'),
    rejected: t('Rejected'),
    failed: t('Failed'),
  }
  const noteText: Record<string, string> = {
    cache_unknown: t('Cache data unavailable'),
    account_deleted: t('Account deleted'),
    already_refunded: t('Already refunded'),
    wallet_limit: t('Wallet balance limit reached; credit will be retried.'),
  }
  const resetPage = () => setPagination((p) => ({ ...p, pageIndex: 0 }))
  return (
    <div className='space-y-4'>
      {!props.reportFilters && (
        <div className='flex flex-wrap items-end gap-3'>
          <div className='space-y-1'>
            <Label htmlFor='compensation-start'>{t('Start date')}</Label>
            <Input
              id='compensation-start'
              type='date'
              value={dates.start}
              onChange={(e) => {
                setDates({ ...dates, start: e.target.value })
                resetPage()
              }}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='compensation-end'>{t('End date')}</Label>
            <Input
              id='compensation-end'
              type='date'
              value={dates.end}
              onChange={(e) => {
                setDates({ ...dates, end: e.target.value })
                resetPage()
              }}
            />
          </div>
          {props.admin && (
            <div className='space-y-1'>
              <Label htmlFor='compensation-user'>{t('User ID')}</Label>
              <Input
                id='compensation-user'
                type='number'
                min={1}
                className='w-32'
                value={filterUser}
                onChange={(e) => {
                  setFilterUser(e.target.value)
                  resetPage()
                }}
              />
            </div>
          )}
          <div className='flex flex-wrap gap-1'>
            {[
              ['', t('All')],
              ...(!props.pendingOnly ? [['credited', t('Credited')]] : []),
              ['review', t('Pending review')],
              ['failed', t('Failed')],
              ['skipped', t('Skipped')],
            ].map(([value, label]) => (
              <Button
                key={value}
                size='sm'
                variant={status === value ? 'secondary' : 'ghost'}
                onClick={() => {
                  setStatus(value)
                  resetPage()
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <p className='text-muted-foreground text-xs'>
        {t(
          'Dates use Beijing time. Totals cover the filtered compensation records.'
        )}
      </p>
      {query.isPending && <LoadingState />}
      {query.isError && <ErrorState onRetry={() => void query.refetch()} />}
      {query.isSuccess && (
        <>
          {!props.reportFilters && !props.pendingOnly && query.data.totals && (
            <div className='grid gap-3 sm:grid-cols-3'>
              {[
                [t('Original charges'), query.data.totals.original_quota],
                [t('Stream credits'), query.data.totals.credited_quota],
                [t('Net charges'), query.data.totals.net_quota],
              ].map(([label, value]) => (
                <div key={label} className='bg-muted/40 rounded-xl border p-4'>
                  <p className='text-muted-foreground text-xs'>{label}</p>
                  <p className='mt-2 text-xl font-semibold tabular-nums'>
                    {formatQuotaWithCurrency(Number(value), {
                      digitsSmall: 6,
                      digitsLarge: 6,
                    })}
                  </p>
                </div>
              ))}
            </div>
          )}
          <StaticDataTable
            data={query.data.items}
            getRowKey={(r) => r.id}
            emptyContent={t('No compensation records')}
            columns={[
              {
                id: 'request',
                header: t('Original request'),
                cell: (r) => (
                  <div className='max-w-64 space-y-1'>
                    <div className='truncate font-medium'>
                      {r.model_name || '—'}
                    </div>
                    <div className='text-muted-foreground text-xs'>
                      {beijingTime(r.consumed_at)}
                    </div>
                    <div className='flex items-center gap-1'>
                      <span className='max-w-44 truncate text-xs'>
                        {r.request_id || `#${r.id}`}
                      </span>
                      {r.request_id && <CopyButton value={r.request_id} />}
                    </div>
                    {r.request_id && (
                      <Link
                        className='text-xs underline underline-offset-4'
                        to='/usage-logs/$section'
                        params={{ section: 'common' }}
                        search={{
                          requestId: r.request_id,
                          startTime: r.consumed_at * 1000,
                          endTime: (r.consumed_at + 1) * 1000,
                        }}
                      >
                        {t('Original request')}
                      </Link>
                    )}
                    {props.admin && (
                      <Badge variant='outline'>#{r.user_id}</Badge>
                    )}
                  </div>
                ),
              },
              ...(props.reportFilters
                ? [
                    {
                      id: 'snapshot',
                      header: t('Source details'),
                      cell: (r: Compensation) => (
                        <div className='max-w-64 space-y-1 text-xs break-words whitespace-normal'>
                          <p>
                            {r.snapshot?.username || t('Unknown')} · #
                            {r.user_id}
                          </p>
                          <p>
                            {r.snapshot?.channel_name || t('Unknown')} · #
                            {r.snapshot?.channel_id || '—'}
                          </p>
                          <p>{r.snapshot?.use_group || t('Unknown')}</p>
                          <Badge variant='outline'>
                            {t(
                              fundingLabels[r.snapshot?.funding || ''] ||
                                'Unknown'
                            )}
                          </Badge>
                          {r.snapshot?.funding === 'mixed' && (
                            <p>
                              {t('Enterprise')}:{' '}
                              {formatQuotaWithCurrency(
                                r.snapshot.enterprise_quota,
                                { digitsSmall: 6, digitsLarge: 6 }
                              )}{' '}
                              / {t('Personal')}:{' '}
                              {formatQuotaWithCurrency(
                                r.snapshot.personal_quota,
                                { digitsSmall: 6, digitsLarge: 6 }
                              )}
                            </p>
                          )}
                        </div>
                      ),
                    },
                  ]
                : []),
              {
                id: 'reason',
                header: t('Reason'),
                cell: (r) => (
                  <div className='space-y-1'>
                    <Badge variant='outline'>
                      {r.reason === 'client_gone'
                        ? 'client_gone'
                        : t('Abnormal EOF')}
                    </Badge>
                    {r.note && (
                      <p className='text-muted-foreground max-w-48 text-xs'>
                        {noteText[r.note] || r.note}
                      </p>
                    )}
                  </div>
                ),
              },
              {
                id: 'amount',
                header: t('Original charges'),
                cell: (r) =>
                  formatQuotaWithCurrency(r.original_quota, {
                    digitsSmall: 6,
                    digitsLarge: 6,
                  }),
              },
              {
                id: 'credited',
                header: t('Stream credits'),
                cell: (r) => (
                  <div className='space-y-1'>
                    <p className='font-medium text-emerald-600 dark:text-emerald-400'>
                      {formatQuotaWithCurrency(
                        r.status === 'credited' ? r.quota : 0,
                        { digitsSmall: 6, digitsLarge: 6 }
                      )}
                    </p>
                    <Badge variant='outline'>
                      {statusText[r.status] || r.status}
                    </Badge>
                    {r.credited_at > 0 && (
                      <p className='text-muted-foreground text-xs'>
                        {beijingTime(r.credited_at)}
                      </p>
                    )}
                  </div>
                ),
              },
              ...(props.admin && !props.reportFilters
                ? [
                    {
                      id: 'actions',
                      header: t('Actions'),
                      cell: (r: Compensation) =>
                        r.status === 'review' && (
                          <div className='flex gap-1'>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() =>
                                setReview({ record: r, approve: true })
                              }
                            >
                              {t('Approve')}
                            </Button>
                            <Button
                              size='sm'
                              variant='ghost'
                              onClick={() =>
                                setReview({ record: r, approve: false })
                              }
                            >
                              {t('Reject')}
                            </Button>
                          </div>
                        ),
                    },
                  ]
                : []),
            ]}
          />
          <DataTablePagination table={table} compact />
        </>
      )}
      <ConfirmDialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open) setReview(null)
        }}
        title={t('Review compensation')}
        desc={
          review?.approve
            ? t('Credit {{amount}} to this user’s personal balance?', {
                amount: formatQuotaWithCurrency(review.record.quota, {
                  digitsSmall: 6,
                  digitsLarge: 6,
                }),
              })
            : t('Reject this compensation request?')
        }
        isLoading={mutation.isPending}
        handleConfirm={() => {
          if (review) {
            mutation.mutate(
              {
                path: `/admin/${review.record.id}/review`,
                body: { approve: review.approve },
              },
              { onSuccess: () => setReview(null) }
            )
          }
        }}
      />
    </div>
  )
}
