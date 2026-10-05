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
import { Activity, Brush, Expand, RefreshCw } from 'lucide-react'
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

import { useInViewport, useRecordHtml } from '../hooks/use-degradation-watch'
import {
  useProbeCatalog,
  useProbeHistory,
  type ProbeHistory,
  type ProbeLane,
} from '../hooks/use-probes'
import { formatElapsed } from '../lib/artwork'
import { probeVerdict } from '../lib/probes'
import type { DegradationWatchRecord } from '../types'
import { ArtworkFrame } from './artwork-frame'
import { ProbeRecordDialog } from './probe-record-dialog'

const verdictClasses = {
  passed: 'bg-emerald-500 hover:bg-emerald-400',
  mismatch: 'bg-rose-500 hover:bg-rose-400',
  error: 'bg-amber-400 hover:bg-amber-300',
  running: 'bg-sky-500 motion-safe:animate-pulse',
  queued: 'bg-muted-foreground/30',
}

function StatusBlocks(props: {
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
  }
  return (
    <>
      {[...props.records].reverse().map((record) => (
        <Button
          key={record.id}
          variant='ghost'
          size='icon'
          className={cn(
            'h-12 min-w-2 flex-1 rounded-md border-0 p-0 transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            verdictClasses[probeVerdict(record)]
          )}
          aria-label={`${formatTimestampToDate(record.created_at)} · ${labels[probeVerdict(record)]}`}
          title={`${formatTimestampToDate(record.created_at)} · ${labels[probeVerdict(record)]}`}
          onClick={() => props.onOpen(record)}
        />
      ))}
    </>
  )
}

function OlderProbeHistory(props: {
  lane: ProbeLane
  days: number
  since: number
  probe: string
  before: number
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const history = useProbeHistory(
    props.lane,
    props.days,
    true,
    props.probe,
    props.before
  )
  const [more, setMore] = useState(false)
  const row = history.data?.probes[0]
  if (history.isPending) return <LoadingState className='min-h-12 w-32' />
  if (!row) {
    return (
      <Button variant='outline' onClick={() => void history.refetch()}>
        {t('Retry')}
      </Button>
    )
  }
  return (
    <>
      {more && row.next_before > 0 && (
        <OlderProbeHistory {...props} before={row.next_before} />
      )}
      <StatusBlocks
        records={row.records.filter(
          (record) =>
            record.created_at >= props.since ||
            ['running', 'queued'].includes(record.status ?? '')
        )}
        onOpen={props.onOpen}
      />
      {!more && row.next_before > 0 && (
        <Button
          variant='outline'
          className='h-12 shrink-0'
          onClick={() => setMore(true)}
        >
          {t('Load more')}
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
    <section className='min-w-0 space-y-3' aria-label={row.name}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          {row.kind === 'drawing' ? (
            <Brush className='size-4 text-violet-500' />
          ) : (
            <Activity className='size-4 text-sky-500' />
          )}
          <h4 className='truncate font-semibold'>{row.name}</h4>
          {!row.enabled && <Badge variant='outline'>{t('Paused')}</Badge>}
          {latest && (
            <Badge variant='outline' className='gap-1.5'>
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  verdictClasses[probeVerdict(latest)]
                )}
              />
              {latestLabels[probeVerdict(latest)]}
            </Badge>
          )}
        </div>
        <span className='text-muted-foreground text-xs'>
          {t('Every {{count}} minutes', { count: row.interval_minutes })}
        </span>
      </div>
      <div className='flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums'>
        <strong className='text-3xl font-semibold tracking-tight text-emerald-600 dark:text-emerald-400'>
          {rate}
        </strong>
        <span className='text-muted-foreground text-sm'>
          {formatNumber(stats.passed, locale)}/
          {formatNumber(denominator, locale)}{' '}
          {row.kind === 'drawing' ? t('Drawing generated') : t('Passed')}
        </span>
        <span className='text-sm text-amber-700 dark:text-amber-400'>
          {t('Exceptions')}: {formatNumber(stats.errors, locale)}
        </span>
        <span className='text-muted-foreground text-xs'>
          {t('Avg time')}{' '}
          {stats.passed > 0 ? formatElapsed(stats.avg_elapsed_ms) : '—'}
        </span>
      </div>
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
          className='flex min-w-0 items-center gap-1 overflow-x-auto py-1'
          onScroll={(event) => {
            const el = event.currentTarget
            followLatest.current =
              el.scrollWidth - el.scrollLeft - el.clientWidth < 24
          }}
          tabIndex={0}
          aria-label={t('Detection history')}
        >
          {frozen && frozen.next_before > 0 && (
            <OlderProbeHistory
              lane={props.lane}
              days={props.days}
              since={props.since}
              probe={row.id}
              before={frozen.next_before}
              onOpen={props.onOpen}
            />
          )}
          <StatusBlocks records={row.records} onOpen={props.onOpen} />
          {!frozen && row.next_before > 0 && (
            <Button
              className='h-12 shrink-0'
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
    </section>
  )
}

function LatestArtwork(props: {
  record?: DegradationWatchRecord
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const { ref, inView } = useInViewport<HTMLDivElement>('0px')
  const html = useRecordHtml(
    props.record?.id ?? 0,
    Boolean(props.record) && inView
  )
  return (
    <div ref={ref} className='flex min-w-0 flex-col gap-3'>
      <div className='text-muted-foreground flex items-center justify-between gap-2 text-xs'>
        <span>{t('Latest successful drawing')}</span>
        {props.record && <span>{formatElapsed(props.record.elapsed_ms)}</span>}
      </div>
      <div className='bg-muted/40 relative aspect-[16/10] overflow-hidden rounded-xl border'>
        {props.record && inView && html.data ? (
          <ArtworkFrame
            html={html.data}
            title={props.record.model_name}
            className='pointer-events-none'
          />
        ) : (
          <div className='text-muted-foreground flex h-full items-center justify-center text-sm'>
            {props.record ? t('Loading...') : t('No artwork yet')}
          </div>
        )}
        {html.isError && (
          <Button
            className='absolute inset-x-4 top-4'
            variant='outline'
            onClick={() => void html.refetch()}
          >
            {t('Retry')}
          </Button>
        )}
        {props.record && (
          <Button
            variant='secondary'
            className='absolute right-3 bottom-3 shadow-sm'
            onClick={() => {
              if (props.record) props.onOpen(props.record)
            }}
          >
            <Expand />
            {t('Enlarge')}
          </Button>
        )}
      </div>
      <p className='text-muted-foreground text-xs leading-relaxed'>
        {t(
          'Select a block to view the prompt, expected answer, response and diagnostics.'
        )}
      </p>
    </div>
  )
}

function MonitorLane(props: {
  lane: ProbeLane
  days: number
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const { ref, inView } = useInViewport<HTMLElement>()
  const history = useProbeHistory(props.lane, props.days, inView)
  const rows = history.data?.probes ?? []
  const art = rows
    .flatMap((row) => (row.artwork ? [row.artwork] : []))
    .sort((a, b) => b.id - a.id)[0]
  return (
    <article
      ref={ref}
      className='bg-card min-w-0 overflow-hidden rounded-2xl border [contain-intrinsic-size:auto_360px] [content-visibility:auto]'
      aria-label={`${props.lane.group} / ${props.lane.model}`}
    >
      <header className='bg-muted/20 flex flex-wrap items-center gap-2 border-b px-5 py-4'>
        <Badge variant='secondary'>{props.lane.group}</Badge>
        <h3 className='min-w-0 font-semibold break-all'>{props.lane.model}</h3>
        {props.lane.channel_id && (
          <Badge variant='outline'>
            {props.lane.channel_name || `#${props.lane.channel_id}`}
          </Badge>
        )}
        {!props.lane.enabled && <Badge variant='outline'>{t('Paused')}</Badge>}
      </header>
      <div className='grid min-w-0 gap-6 p-5 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]'>
        <div className='flex min-w-0 flex-col gap-7'>
          {history.isPending && <LoadingState />}
          {history.isError && (
            <ErrorState
              title={t('Failed to load the degradation watch')}
              onRetry={() => void history.refetch()}
            />
          )}
          {rows.map((row) => (
            <ProbeStrip
              key={`${row.id}-${props.days}`}
              row={row}
              lane={props.lane}
              days={props.days}
              since={history.data?.since ?? 0}
              onOpen={props.onOpen}
            />
          ))}
          {history.isSuccess && rows.length === 0 && (
            <EmptyState title={t('No enabled probes')} />
          )}
        </div>
        <LatestArtwork record={art} onOpen={props.onOpen} />
      </div>
    </article>
  )
}

export function ProbeWall() {
  const { t } = useTranslation()
  const catalog = useProbeCatalog()
  const [days, setDays] = useState(1)
  const [record, setRecord] = useState<DegradationWatchRecord | null>(null)
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
      <div className='text-muted-foreground flex flex-wrap gap-4 text-xs'>
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
      {catalog.data.lanes.length === 0 && (
        <EmptyState title={t('No checks to display')} />
      )}
      {catalog.data.lanes.map((lane) => (
        <MonitorLane
          key={JSON.stringify([lane.group, lane.model, lane.channel_id])}
          lane={lane}
          days={days}
          onOpen={setRecord}
        />
      ))}
      {record && (
        <ProbeRecordDialog record={record} onClose={() => setRecord(null)} />
      )}
    </div>
  )
}
