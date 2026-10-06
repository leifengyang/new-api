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
import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import { comparisonRecord } from '../lib/comparison'
import {
  monitorRequest,
  monitorResultSource,
  type MonitorAttempt,
  type MonitorHistory,
} from '../lib/temporary-monitor'
import { ComparisonResult } from './comparison-results'
import { StatusBlocks } from './probe-wall'
import { TemporaryProbeControls } from './temporary-probe-controls'

export function TemporaryMonitorHistory(props: { monitorID: number }) {
  const { t } = useTranslation()
  return (
    <div className='min-w-0 space-y-5'>
      <TemporaryProbeHistory
        monitorID={props.monitorID}
        kind='text'
        title={t('Text probes')}
      />
      <TemporaryProbeHistory
        monitorID={props.monitorID}
        kind='drawing'
        title={t('Drawing checks')}
      />
    </div>
  )
}

function TemporaryProbeHistory(props: {
  monitorID: number
  kind: 'text' | 'drawing'
  title: string
}) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const [selected, setSelected] = useState<MonitorAttempt | null>(null)
  const history = useInfiniteQuery({
    queryKey: ['temporary-monitor', userID, props.monitorID, props.kind],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      monitorRequest<MonitorHistory>(
        `/${props.monitorID}?kind=${props.kind}&before=${pageParam}`
      ),
    getNextPageParam: (page) => page.next_before || undefined,
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.monitor.status === 'running' ? 3000 : false,
  })
  const head = history.data?.pages[0]
  const attempts = history.data?.pages.flatMap((page) => page.attempts) ?? []
  const stats = head?.stats ?? []
  const passed = stats
    .filter((s) => s.verdict === 'passed')
    .reduce((sum, s) => sum + s.count, 0)
  const mismatch = stats
    .filter((s) => s.verdict === 'mismatch')
    .reduce((sum, s) => sum + s.count, 0)
  const errors = stats
    .filter((s) => s.verdict === 'error')
    .reduce((sum, s) => sum + s.count, 0)
  const prompt =
    props.kind === 'text' ? head?.text_prompt : head?.monitor.drawing_prompt
  const focused = attempts.find((a) => a.id === selected?.id) ?? selected
  return (
    <section
      aria-label={props.title}
      className='bg-card min-w-0 space-y-4 rounded-xl border p-4'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h3 className='font-semibold'>{props.title}</h3>
        <div className='flex flex-wrap gap-2 text-xs'>
          <Badge
            className='bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            variant='secondary'
          >
            {t('Passed')}: {formatNumber(passed)}/
            {formatNumber(passed + mismatch)}
          </Badge>
          <Badge variant='outline'>
            {t('Exceptions')}: {formatNumber(errors)}
          </Badge>
        </div>
      </div>
      {head && (
        <TemporaryProbeControls
          monitor={head.monitor}
          kind={props.kind}
          busy={stats.some(
            (stat) =>
              stat.count > 0 &&
              (stat.status === 'queued' || stat.status === 'running')
          )}
        />
      )}
      {head && (
        <p className='text-muted-foreground text-xs'>
          {t('Monitoring ends at {{time}}', {
            time: formatTimestampToDate(head.monitor.ends_at),
          })}
        </p>
      )}
      {history.isPending && <LoadingState />}
      {history.isError && <ErrorState onRetry={() => void history.refetch()} />}
      {head && attempts.length === 0 && (
        <EmptyState title={t('No checks in this period')} />
      )}
      {props.kind === 'text' ? (
        <div
          className='flex flex-nowrap gap-1 overflow-x-auto py-1'
          aria-label={t('Detection history')}
          tabIndex={0}
        >
          <StatusBlocks
            records={attempts.map((attempt) => ({
              ...comparisonRecord(attempt),
              id: attempt.id,
              verdict: attempt.verdict,
            }))}
            onOpen={(record) => {
              const attempt = attempts.find((item) => item.id === record.id)
              if (attempt) setSelected(attempt)
            }}
          />
        </div>
      ) : (
        <div className='flex gap-4 overflow-x-auto pb-2'>
          {attempts.map((attempt) => (
            <div key={attempt.id} className='w-72 shrink-0'>
              <ComparisonResult
                prompt={prompt ?? ''}
                latest={attempt}
                attempts={[attempt]}
                busy={false}
                onStop={() => {}}
                onRetry={() => {}}
                source={monitorResultSource}
                readOnly
              />
            </div>
          ))}
        </div>
      )}
      {history.hasNextPage && (
        <Button
          variant='outline'
          disabled={history.isFetching}
          onClick={() => void history.fetchNextPage()}
        >
          {t('Load more')}
        </Button>
      )}
      {focused && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null)
          }}
          title={t('Probe details')}
          description={head?.expected}
          contentClassName='sm:max-w-3xl'
        >
          <ComparisonResult
            prompt={prompt ?? ''}
            latest={focused}
            attempts={[focused]}
            busy={false}
            onStop={() => {}}
            onRetry={() => {}}
            source={monitorResultSource}
            readOnly
          />
        </Dialog>
      )}
    </section>
  )
}
