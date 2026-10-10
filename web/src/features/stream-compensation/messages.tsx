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
import { Link } from '@tanstack/react-router'
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePagination } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import {
  useCompensationMessages,
  useCompensationMutation,
  type CompensationMessage,
} from './api'
import { CompensationRecords } from './records'

function MessageContent(props: { message: CompensationMessage }) {
  const { t } = useTranslation()
  return (
    <div className='space-y-2'>
      <p className='text-2xl font-semibold text-emerald-600 dark:text-emerald-400'>
        +
        {formatQuotaWithCurrency(props.message.quota, {
          digitsSmall: 6,
          digitsLarge: 6,
        })}
      </p>
      <p className='text-sm'>
        {t(
          'Compensation for {{count}} interrupted requests has been credited to your personal balance.',
          { count: formatNumber(props.message.count) }
        )}
      </p>
      <p className='text-muted-foreground text-xs'>
        {dayjs.unix(props.message.start_at).format('YYYY-MM-DD')} –{' '}
        {dayjs.unix(props.message.end_at - 1).format('YYYY-MM-DD')}
      </p>
    </div>
  )
}

export function CompensationNotice() {
  const { t } = useTranslation()
  const query = useCompensationMessages(true)
  const mutation = useCompensationMutation()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const message = query.data?.items[0]
  const key = message ? `${message.id}:${message.revision}` : null
  // Closing the current window is not marking it read. It will be shown on
  // the next console visit until explicitly acknowledged on the server.
  return (
    <Dialog
      open={!!message && key !== dismissed}
      onOpenChange={(open) => {
        if (!open) setDismissed(key)
      }}
      title={t('Stream compensation received')}
      footer={
        <>
          <Button
            variant='outline'
            render={<Link to='/wallet' />}
            onClick={() => setDismissed(key)}
          >
            {t('View compensation ledger')}
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() => {
              if (message) {
                mutation.mutate({
                  path: `/messages/${message.id}/read`,
                  body: { revision: message.revision },
                })
              }
            }}
          >
            {t('Got it')}
          </Button>
        </>
      }
    >
      {message && <MessageContent message={message} />}
    </Dialog>
  )
}

export function CompensationInboxLink() {
  const { t } = useTranslation()
  const query = useCompensationMessages(true)
  return (
    <Button
      className='w-full justify-between'
      variant='outline'
      render={<Link to='/wallet' />}
    >
      {t('Compensation inbox')}
      {!!query.data?.total && (
        <Badge variant='destructive'>{formatNumber(query.data.total)}</Badge>
      )}
    </Button>
  )
}

export function CompensationInbox() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })
  const [selected, setSelected] = useState<CompensationMessage | null>(null)
  const query = useCompensationMessages(
    false,
    pagination.pageIndex,
    pagination.pageSize
  )
  const mutation = useCompensationMutation()
  const table = useReactTable({
    data: query.data?.items ?? [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: query.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />
  return (
    <div className='space-y-3'>
      {!query.data?.items.length && (
        <EmptyState title={t('No compensation messages')} />
      )}
      {query.data?.items.map((message) => (
        <div key={message.id} className='space-y-3 rounded-xl border p-4'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='font-medium'>{t('Stream compensation received')}</h3>
            {message.read_at === 0 && <Badge>{t('Unread')}</Badge>}
          </div>
          <MessageContent message={message} />
          <div className='flex gap-2'>
            <Button
              size='sm'
              variant='outline'
              onClick={() => setSelected(message)}
            >
              {t('View compensation ledger')}
            </Button>
            {message.read_at === 0 && (
              <Button
                size='sm'
                variant='ghost'
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    path: `/messages/${message.id}/read`,
                    body: { revision: message.revision },
                  })
                }
              >
                {t('Mark as read')}
              </Button>
            )}
          </div>
        </div>
      ))}
      <DataTablePagination table={table} compact />
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        title={t('Stream compensation')}
        contentClassName='sm:max-w-5xl'
      >
        {selected && (
          <CompensationRecords
            key={selected.batch_id}
            batchID={selected.batch_id}
          />
        )}
      </Dialog>
    </div>
  )
}
