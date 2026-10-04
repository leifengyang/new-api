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
import { Bird, ArrowRight, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toIntlLocale } from '@/i18n/languages'

import {
  useDegradationWatchWall,
  useDegradationWatchHistory,
  useInViewport,
} from '../hooks/use-degradation-watch'
import { formatElapsed, successRate } from '../lib/artwork'
import type { DegradationWatchLane, DegradationWatchRecord } from '../types'
import { RecordPlayerDialog } from './artwork-player-dialog'
import { RecordCard } from './record-card'

interface LaneHeaderProps {
  lane: DegradationWatchLane
}

function LaneHeader(props: LaneHeaderProps) {
  const { t, i18n } = useTranslation()
  const lane = props.lane
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const rate = successRate(lane.succeeded, lane.total)
  const rateText =
    rate === null
      ? '-'
      : new Intl.NumberFormat(locale, {
          style: 'percent',
          maximumFractionDigits: 1,
        }).format(rate)

  return (
    <div className='flex min-w-0 flex-1 flex-col gap-1 px-4 py-3'>
      <div className='flex items-center gap-2'>
        <span className='truncate font-semibold'>{lane.model}</span>
        {!lane.configured && (
          <Badge variant='outline'>{t('Removed from config')}</Badge>
        )}
        {lane.configured && !lane.enabled && (
          <Badge variant='outline'>{t('Paused')}</Badge>
        )}
      </div>
      <div className='text-muted-foreground flex flex-wrap gap-x-3 text-xs tabular-nums'>
        <span>
          {t('Reasoning effort')}: {lane.reasoning_effort || '-'}
        </span>
        <span>
          {t('Runs')} {lane.succeeded}/{lane.total}
        </span>
        <span>
          {t('Success rate')} {rateText}
        </span>
        <span>
          {t('Avg time')}{' '}
          {lane.succeeded > 0 ? formatElapsed(lane.avg_elapsed_ms) : '-'}
        </span>
      </div>
    </div>
  )
}

function HistoryPage(props: {
  model: string
  since: number
  before: number
  enabled: boolean
  last: boolean
  onMore: (next: number, newest: number) => void
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const history = useDegradationWatchHistory(
    props.model,
    props.before,
    props.enabled
  )
  const records = (history.data?.records ?? []).filter(
    (record) =>
      record.created_at >= props.since ||
      record.status === 'queued' ||
      record.status === 'running'
  )
  return (
    <div
      className='flex shrink-0 items-start gap-3'
      aria-busy={history.isFetching}
    >
      {history.isLoading && (
        <div className='w-64'>
          <LoadingState />
        </div>
      )}
      {history.isError && (
        <div className='w-64'>
          <ErrorState
            title={t('Failed to load the degradation watch')}
            onRetry={() => void history.refetch()}
          />
        </div>
      )}
      {!history.isLoading && !history.isError && records.length === 0 && (
        <EmptyState title={t('No artwork yet')} className='min-h-40' />
      )}
      {records.map((record) => (
        <div
          key={record.id}
          className='w-[max(16rem,calc((100cqw-10.5rem)/4))] shrink-0'
        >
          <RecordCard
            record={record}
            title={record.channel_title}
            onOpen={props.onOpen}
          />
        </div>
      ))}
      {props.last &&
        records.length > 0 &&
        Boolean(history.data?.next_before) && (
          <Button
            variant='outline'
            className='my-auto h-auto min-h-32 w-24 flex-col gap-3 border-dashed whitespace-normal'
            disabled={history.isFetching}
            onClick={() => {
              const next = history.data?.next_before
              if (next && records.length) props.onMore(next, records[0].id)
            }}
          >
            <ArrowRight className='size-5' aria-hidden='true' />
            {t('Load more')}
          </Button>
        )}
    </div>
  )
}

function ModelLane(props: {
  lane: DegradationWatchLane
  since: number
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const [cursors, setCursors] = useState<number[]>([0])
  const { ref, inView } = useInViewport<HTMLElement>('0px')
  return (
    <section
      ref={ref}
      className='bg-muted/20 @container min-w-0 overflow-hidden rounded-xl border'
      aria-label={props.lane.model}
    >
      <div className='flex items-center gap-3 border-b pr-4'>
        <LaneHeader lane={props.lane} />
        {cursors[0] !== 0 && (
          <Button variant='ghost' size='sm' onClick={() => setCursors([0])}>
            <RefreshCw aria-hidden='true' />
            {t('Refresh')}
          </Button>
        )}
      </div>
      <div className='flex items-start gap-3 overflow-x-auto p-3' tabIndex={0}>
        {cursors.map((before, index) => (
          <HistoryPage
            key={before === cursors[0] ? 'latest' : before}
            model={props.lane.model}
            since={props.since}
            before={before}
            enabled={inView}
            last={index === cursors.length - 1}
            onOpen={props.onOpen}
            onMore={(next, newest) =>
              setCursors((current) => {
                // Anchor the first page when browsing history so live inserts cannot create gaps.
                const anchored = current[0] === 0 ? [newest + 1] : current
                return [...anchored, next]
              })
            }
          />
        ))}
      </div>
    </section>
  )
}

export function WatchWall() {
  const { t } = useTranslation()
  const wall = useDegradationWatchWall()
  const [openRecord, setOpenRecord] = useState<DegradationWatchRecord | null>(
    null
  )
  const first = wall.data
  const lanes = first?.lanes ?? []
  if (wall.isLoading) return <LoadingState />
  if (!first) {
    return (
      <ErrorState
        title={t('Failed to load the degradation watch')}
        onRetry={() => void wall.refetch()}
      />
    )
  }
  return (
    <div className='flex flex-col gap-4'>
      <Alert>
        <AlertDescription>
          {t(
            'Each model shows its latest 4 checks. Load more on the right. Completed checks and their content are deleted after 7 days.'
          )}
        </AlertDescription>
      </Alert>
      {lanes.length === 0 ? (
        <EmptyState icon={Bird} title={t('No artwork yet')} />
      ) : (
        <div
          className='flex min-w-0 flex-col gap-4'
          data-testid='degradation-watch-grid'
        >
          {lanes.map((lane) => (
            <ModelLane
              key={lane.model}
              lane={lane}
              since={first.retention_since ?? 0}
              onOpen={setOpenRecord}
            />
          ))}
        </div>
      )}
      <RecordPlayerDialog
        title={openRecord?.channel_title ?? ''}
        record={openRecord}
        onClose={() => setOpenRecord(null)}
      />
    </div>
  )
}
