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
import { Activity, Brush, RefreshCw } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { cn } from '@/lib/utils'

import { useInViewport } from '../hooks/use-degradation-watch'
import {
  useProbeCatalog,
  useProbeHistory,
  useOlderProbeHistory,
  type ProbeHistory,
  type ProbeLane,
} from '../hooks/use-probes'
import { formatElapsed } from '../lib/artwork'
import { probeVerdict } from '../lib/probes'
import type { DegradationWatchRecord } from '../types'
import { DrawingProbeLane } from './drawing-probe-lane'
import { ProbeRecordDialog } from './probe-record-dialog'

const verdictClasses = {
  passed: 'bg-emerald-500 hover:bg-emerald-400',
  mismatch: 'bg-rose-500 hover:bg-rose-400',
  error: 'bg-amber-400 hover:bg-amber-300',
  running: 'bg-sky-500 motion-safe:animate-pulse',
  queued: 'bg-muted-foreground/30',
  cancelled: 'bg-muted-foreground/30',
}

export function StatusBlocks(props: {
  records: DegradationWatchRecord[]
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const labels = {
    passed: t('Passed'),
    mismatch: t('Answer or drawing mismatch'),
    error: t('Request error'),
    running: t('Running'),
    queued: t('Queued'),
    cancelled: t('Cancelled'),
  }
  return (
    <>
      {[...props.records]
        .sort((a, b) => a.created_at - b.created_at || a.id - b.id)
        .map((record) => {
          const verdict =
            record.status === 'cancelled' ? 'cancelled' : probeVerdict(record)
          return (
            <Button
              key={record.id}
              variant='ghost'
              size='icon'
              className={cn(
                'h-7 min-w-3 max-w-5 flex-1 shrink-0 rounded-sm border-0 p-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                verdictClasses[verdict],
                (record.public_visible === false || record.hidden) &&
                  'opacity-50'
              )}
              aria-label={`${formatTimestampToDate(record.created_at)} · ${labels[verdict]}`}
              title={`${formatTimestampToDate(record.created_at)} · ${labels[verdict]}`}
              onClick={() => props.onOpen(record)}
            />
          )
        })}
    </>
  )
}

function OlderProbeHistory(props: {
  lane: ProbeLane
  days: number
  since: number
  probe: string
  before: number
  initial: ProbeHistory
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const history = useOlderProbeHistory(
    props.lane,
    props.days,
    props.probe,
    props.before
  )
  const records = [
    ...props.initial.records,
    ...(history.data?.pages.flatMap((page) => page.probes[0]?.records ?? []) ??
      []),
  ].filter(
    (record) =>
      record.created_at >= props.since ||
      ['running', 'queued'].includes(record.status ?? '')
  )
  return (
    <>
      <StatusBlocks records={records} onOpen={props.onOpen} />
      {history.isFetching && (
        <LoadingState className='min-h-12 w-12 shrink-0' />
      )}
      {(history.hasNextPage || history.isError) && (
        <Button
          variant='outline'
          className='h-7 shrink-0'
          disabled={history.isFetching}
          onClick={() =>
            void (history.data ? history.fetchNextPage() : history.refetch())
          }
        >
          {history.isError ? t('Retry') : t('Load more')}
        </Button>
      )}
    </>
  )
}

function ProbeStrip(props: {
  row: ProbeHistory
  lane: ProbeLane
  days: number
  since: number
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t, i18n } = useTranslation()
  const [frozen, setFrozen] = useState<ProbeHistory | null>(null)
  const stored = frozen ?? props.row
  const row = {
    ...stored,
    records: stored.records.filter(
      (record) =>
        record.created_at >= props.since ||
        ['running', 'queued'].includes(record.status ?? '')
    ),
  }
  const stats = row.stats
  const denominator = stats.passed + stats.mismatched
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const rate =
    denominator > 0
      ? new Intl.NumberFormat(locale, {
          style: 'percent',
          maximumFractionDigits: 1,
        }).format(stats.passed / denominator)
      : '—'
  const latest = row.records[0]
  const live = latest && ['running', 'queued'].includes(latest.status ?? '')
  const strip = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  useLayoutEffect(() => {
    if (strip.current && !frozen && followLatest.current) {
      strip.current.scrollLeft = strip.current.scrollWidth
    }
  }, [latest?.id, frozen])
  const latestLabels = {
    passed: row.kind === 'drawing' ? t('Drawing generated') : t('Passed'),
    mismatch: t('Answer or drawing mismatch'),
    error: t('Request error'),
    running: t('Running'),
    queued: t('Queued'),
  }
  return (
    <section
      className='grid min-w-0 gap-3 lg:grid-cols-[16rem_minmax(0,1fr)]'
      aria-label={row.name}
    >
      <div className='space-y-1.5'>
        <LaneIdentity lane={props.lane} />
        <div className='flex flex-wrap items-center gap-2 text-xs'>
          <h4 className='text-muted-foreground'>{row.name}</h4>
          <strong className='font-semibold text-emerald-600 dark:text-emerald-400'>
            {rate}
          </strong>
          {!row.enabled && <Badge variant='outline'>{t('Paused')}</Badge>}
          {row.public === false && (
            <Badge variant='outline'>{t('Hidden')}</Badge>
          )}
          {latest && (
            <Badge variant='outline' className='text-[10px]'>
              {latestLabels[probeVerdict(latest)]}
            </Badge>
          )}
        </div>
        <div className='text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums'>
          <span>
            {t('Every {{count}} minutes', { count: row.interval_minutes })}
          </span>
          <span>
            {formatNumber(stats.passed, locale)}/
            {formatNumber(denominator, locale)} {t('Passed')}
          </span>
          {stats.errors > 0 && (
            <span className='text-amber-700 dark:text-amber-400'>
              {t('Exceptions')}: {formatNumber(stats.errors, locale)}
            </span>
          )}
        </div>
      </div>
      <div className='min-w-0 self-center'>
        {live && (
          <div
            className='flex flex-wrap gap-3 text-xs text-sky-700 dark:text-sky-300'
            aria-live='polite'
          >
            <span>
              {latest.status === 'running' ? t('Running') : t('Queued')}
            </span>
            <span>
              {t('Input tokens')}: {formatNumber(latest.prompt_tokens, locale)}
            </span>
            <span>
              {t('Output tokens')}:{' '}
              {formatNumber(latest.completion_tokens, locale)}
            </span>
            <span>
              {t('Elapsed')}: {formatElapsed(latest.elapsed_ms)}
            </span>
            {latest.tokens_estimated && <span>{t('Estimated')}</span>}
          </div>
        )}
        {row.records.length === 0 ? (
          <p className='bg-muted/40 text-muted-foreground rounded-lg p-4 text-sm'>
            {t('No checks in this period')}
          </p>
        ) : (
          <div
            ref={strip}
            className='flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto py-1'
            onScroll={(event) => {
              const el = event.currentTarget
              followLatest.current =
                el.scrollWidth - el.scrollLeft - el.clientWidth < 24
            }}
            tabIndex={0}
            aria-label={t('Detection history')}
          >
            {frozen && frozen.next_before > 0 ? (
              <OlderProbeHistory
                lane={props.lane}
                days={props.days}
                since={props.since}
                probe={row.id}
                before={frozen.next_before}
                initial={row}
                onOpen={props.onOpen}
              />
            ) : (
              <StatusBlocks records={row.records} onOpen={props.onOpen} />
            )}
            {!frozen && row.next_before > 0 && (
              <Button
                className='h-7 shrink-0'
                variant='outline'
                onClick={() => setFrozen(row)}
              >
                {t('Load more')}
              </Button>
            )}
          </div>
        )}
        <div className='text-muted-foreground flex items-center justify-between gap-2 text-xs'>
          <span>
            {row.records.length > 0
              ? formatTimestampToDate(row.records.at(-1)?.created_at ?? 0)
              : '—'}
          </span>
          {frozen ? (
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                followLatest.current = true
                setFrozen(null)
              }}
            >
              <RefreshCw />
              {t('Return to live')}
            </Button>
          ) : (
            <span>
              {latest ? formatTimestampToDate(latest.created_at) : t('Now')}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

function LaneIdentity(props: { lane: ProbeLane }) {
  const { t } = useTranslation()
  return (
    <header className='flex flex-wrap items-center gap-2 text-sm'>
      <Badge variant='secondary'>{props.lane.group}</Badge>
      <span className='min-w-0 font-semibold break-all'>
        {props.lane.model}
      </span>
      {props.lane.channel_id && (
        <Badge variant='outline'>
          {props.lane.channel_name || `#${props.lane.channel_id}`}
        </Badge>
      )}
      {!props.lane.enabled && <Badge variant='outline'>{t('Paused')}</Badge>}
    </header>
  )
}

function MonitorLane(props: {
  lane: ProbeLane
  days: number
  kind: 'text' | 'drawing'
  onOpen: (record: DegradationWatchRecord, input?: boolean) => void
}) {
  const { t } = useTranslation()
  const { ref, inView } = useInViewport<HTMLElement>()
  // Both sections share the same query key and lightweight history response.
  const history = useProbeHistory(props.lane, props.days, inView)
  const rows =
    history.data?.probes.filter((row) => row.kind === props.kind) ?? []
  return (
    <article
      ref={ref}
      className='min-w-0 [contain-intrinsic-size:auto_100px] [content-visibility:auto]'
      aria-label={`${props.lane.group} / ${props.lane.model}`}
    >
      {history.isPending && <LoadingState className='min-h-20' />}
      {history.isError && (
        <ErrorState
          title={t('Failed to load the degradation watch')}
          onRetry={() => void history.refetch()}
        />
      )}
      <div className='space-y-4'>
        {rows.map((row) =>
          props.kind === 'text' ? (
            <ProbeStrip
              key={`${row.id}-${props.days}`}
              row={row}
              lane={props.lane}
              days={props.days}
              since={history.data?.since ?? 0}
              onOpen={props.onOpen}
            />
          ) : (
            <DrawingProbeLane
              key={`${row.id}-${props.days}`}
              row={row}
              lane={props.lane}
              days={props.days}
              since={history.data?.since ?? 0}
              onOpen={props.onOpen}
              heading={<LaneIdentity lane={props.lane} />}
            />
          )
        )}
      </div>
    </article>
  )
}

export function ProbeWall() {
  const { t } = useTranslation()
  const catalog = useProbeCatalog()
  const [days, setDays] = useState(1)
  const [record, setRecord] = useState<{
    record: DegradationWatchRecord
    input: boolean
  } | null>(null)
  if (catalog.isPending) return <LoadingState />
  if (!catalog.data) {
    return (
      <ErrorState
        title={t('Failed to load the degradation watch')}
        onRetry={() => void catalog.refetch()}
      />
    )
  }
  return (
    <div className='flex min-w-0 flex-col gap-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Errors and timeouts are excluded from the pass rate. History is retained for 7 days.'
          )}
        </p>
        <div
          className='flex gap-1 rounded-lg border p-1'
          role='group'
          aria-label={t('Time range')}
        >
          <Button
            size='sm'
            variant={days === 1 ? 'secondary' : 'ghost'}
            aria-pressed={days === 1}
            onClick={() => setDays(1)}
          >
            {t('Last 24 hours')}
          </Button>
          <Button
            size='sm'
            variant={days === 7 ? 'secondary' : 'ghost'}
            aria-pressed={days === 7}
            onClick={() => setDays(7)}
          >
            {t('Last 7 days')}
          </Button>
        </div>
      </div>
      {catalog.data.lanes.length === 0 ? (
        <EmptyState title={t('No checks to display')} />
      ) : (
        <>
          <section
            className='bg-card min-w-0 space-y-4 rounded-2xl border p-4 sm:p-5'
            aria-label={t('Text probes')}
          >
            <div className='flex flex-wrap items-center gap-4'>
              <h2 className='flex items-center gap-2 font-semibold'>
                <Activity className='size-4 text-emerald-500' />
                {t('Text probes')}
              </h2>
              <div className='text-muted-foreground flex flex-wrap gap-3 text-xs'>
                {[
                  [verdictClasses.passed, t('Passed')],
                  [verdictClasses.mismatch, t('Answer or drawing mismatch')],
                  [verdictClasses.error, t('Request error')],
                  [verdictClasses.running, t('Running')],
                  [verdictClasses.queued, t('Queued')],
                ].map(([className, label]) => (
                  <span key={label} className='flex items-center gap-1.5'>
                    <span className={cn('size-2 rounded-full', className)} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
            {catalog.data.lanes.map((lane) => (
              <MonitorLane
                key={JSON.stringify([lane.group, lane.model, lane.channel_id])}
                lane={lane}
                days={days}
                kind='text'
                onOpen={(record, input = false) => setRecord({ record, input })}
              />
            ))}
            <p className='text-muted-foreground text-xs'>
              {t(
                'Select a block to view the prompt, expected answer, response and diagnostics.'
              )}
            </p>
          </section>
          <section
            className='bg-card min-w-0 space-y-5 rounded-2xl border p-4 sm:p-5'
            aria-label={t('Drawing checks')}
          >
            <div className='flex flex-wrap items-baseline gap-3'>
              <h2 className='flex items-center gap-2 font-semibold'>
                <Brush className='size-4 text-violet-500' />
                {t('Drawing checks')}
              </h2>
              <p className='text-muted-foreground text-xs'>
                {t(
                  'The latest 5 drawings per lane. Load more to view earlier attempts.'
                )}
              </p>
            </div>
            {catalog.data.lanes.map((lane) => (
              <MonitorLane
                key={JSON.stringify([lane.group, lane.model, lane.channel_id])}
                lane={lane}
                days={days}
                kind='drawing'
                onOpen={(record, input = false) => setRecord({ record, input })}
              />
            ))}
          </section>
        </>
      )}
      {record && (
        <ProbeRecordDialog
          key={record.record.id}
          record={record.record}
          initialInputOpen={record.input}
          onClose={() => setRecord(null)}
        />
      )}
    </div>
  )
}
