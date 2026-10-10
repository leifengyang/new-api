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
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePagination, StaticDataTable } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

import {
  getCompensationData,
  useCompensationMutation,
  type CompensationBatch,
  type Page,
} from './api'
import { CompensationRecords } from './records'
import { beijingTime } from './report-api'

export function CompensationAdmin(props: { batchesOnly?: boolean } = {}) {
  const { t } = useTranslation()
  const mutation = useCompensationMutation()
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })
  const [selected, setSelected] = useState<number | null>(null)
  const settings = useQuery({
    queryKey: ['stream-compensation', 'admin-settings'],
    queryFn: () =>
      getCompensationData<{ enabled: boolean; settled_until: number }>(
        '/admin/settings'
      ),
  })
  const batches = useQuery({
    queryKey: ['stream-compensation', 'batches', pagination],
    queryFn: () =>
      getCompensationData<Page<CompensationBatch>>('/admin/batches', {
        p: pagination.pageIndex + 1,
        page_size: pagination.pageSize,
      }),
    refetchInterval: 15_000,
  })
  const table = useReactTable({
    data: batches.data?.items ?? [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: batches.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  const statuses: Record<string, string> = {
    completed: t('Completed'),
    running: t('Running'),
    failed: t('Failed'),
  }
  if (settings.isPending) return <LoadingState />
  if (settings.isError) {
    return <ErrorState onRetry={() => void settings.refetch()} />
  }
  return (
    <div className='space-y-5'>
      <div className='bg-muted/30 flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5'>
        <div className='space-y-3'>
          <div className='flex items-center gap-2'>
            <Switch
              id='compensation-enabled'
              checked={settings.data.enabled}
              disabled={mutation.isPending}
              onCheckedChange={(enabled) =>
                mutation.mutate({
                  path: '/admin/settings',
                  method: 'put',
                  body: { enabled },
                })
              }
            />
            <Label htmlFor='compensation-enabled'>
              {t('Automatic stream compensation')}
            </Label>
          </div>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Settles at 02:00 Beijing time. Initial catch-up starts on October 1, 2026.'
            )}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Only client_gone and confirmed abnormal EOF with zero cache qualify. All credits go to personal balances.'
            )}
          </p>
        </div>
        <Button
          variant='outline'
          disabled={mutation.isPending || !settings.data.enabled}
          onClick={() => mutation.mutate({ path: '/admin/run' })}
        >
          {t('Settle / retry now')}
        </Button>
      </div>
      <Tabs defaultValue='batches'>
        {!props.batchesOnly && (
          <TabsList>
            <TabsTrigger value='batches'>{t('Settlement batches')}</TabsTrigger>
            <TabsTrigger value='records'>
              {t('Compensation ledger')}
            </TabsTrigger>
          </TabsList>
        )}
        <TabsContent value='batches' className='space-y-3 pt-4'>
          {batches.isPending && <LoadingState />}
          {batches.isError && (
            <ErrorState onRetry={() => void batches.refetch()} />
          )}
          {batches.isSuccess && (
            <>
              <StaticDataTable
                data={batches.data.items}
                getRowKey={(r) => r.id}
                emptyContent={t('No settlement batches')}
                columns={[
                  {
                    id: 'period',
                    header: t('Period'),
                    cell: (r) =>
                      `${beijingTime(r.start_at).slice(0, 10)} – ${beijingTime(r.end_at - 1).slice(0, 10)}`,
                  },
                  {
                    id: 'status',
                    header: t('Status'),
                    cell: (r) => (
                      <div>
                        {statuses[r.status] || r.status}
                        {r.error && (
                          <p className='text-destructive max-w-sm text-xs break-words whitespace-normal'>
                            {r.error}
                          </p>
                        )}
                      </div>
                    ),
                  },
                  {
                    id: 'time',
                    header: t('Completed at'),
                    cell: (r) =>
                      r.completed_at ? beijingTime(r.completed_at) : '—',
                  },
                  {
                    id: 'actions',
                    header: t('Actions'),
                    cell: (r) => (
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => setSelected(r.id)}
                      >
                        {t('Details')}
                      </Button>
                    ),
                  },
                ]}
              />
              <DataTablePagination table={table} compact />
            </>
          )}
        </TabsContent>
        <TabsContent value='records' className='pt-4'>
          <CompensationRecords admin />
        </TabsContent>
      </Tabs>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        title={t('Compensation ledger')}
        contentClassName='sm:max-w-5xl'
      >
        {selected !== null && (
          <CompensationRecords key={selected} admin batchID={selected} />
        )}
      </Dialog>
    </div>
  )
}
