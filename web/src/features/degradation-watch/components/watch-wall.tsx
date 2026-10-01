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
import { Bird } from 'lucide-react'
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
} from '../hooks/use-degradation-watch'
import { formatElapsed, successRate } from '../lib/artwork'
import type { DegradationWatchLane, DegradationWatchRecord } from '../types'
import { RecordPlayerDialog } from './artwork-player-dialog'
import { RecordCard } from './record-card'

/** Lanes stay readable on narrow screens by scrolling sideways instead of shrinking. */
const LANE_MIN_WIDTH = 300

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
    <div className='bg-background sticky top-0 z-10 flex flex-col gap-1 border-b px-3 py-2'>
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

function ModelLane(props: {
  lane: DegradationWatchLane
  onOpen: (record: DegradationWatchRecord) => void
}) {
  const { t } = useTranslation()
  const history = useDegradationWatchHistory(props.lane.model)
  const records = [
    ...new Map(
      (history.data?.pages.flatMap((page) => page.records) ?? []).map(
        (record) => [record.id, record]
      )
    ).values(),
  ]
  return (
    <section
      className='bg-muted/20 min-w-0 not-last:border-r'
      aria-label={props.lane.model}
    >
      <LaneHeader lane={props.lane} />
      <div className='flex flex-col gap-3 p-3'>
        {history.isLoading && <LoadingState />}
        {history.isError && (
          <ErrorState
            title={t('Failed to load the degradation watch')}
            onRetry={() => void history.refetch()}
          />
        )}
        {!history.isLoading && !history.isError && records.length === 0 && (
          <EmptyState title={t('No artwork yet')} className='min-h-40' />
        )}
        {records.map((record) => (
          <RecordCard
            key={record.id}
            record={record}
            title={record.channel_title}
            onOpen={props.onOpen}
          />
        ))}
        {history.hasNextPage && (
          <Button
            variant='outline'
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? t('Loading...') : t('Load more')}
          </Button>
        )}
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
            'Each model has its own latest checks, newest first. Running checks update automatically.'
          )}
        </AlertDescription>
      </Alert>
      {lanes.length === 0 ? (
        <EmptyState icon={Bird} title={t('No artwork yet')} />
      ) : (
        <div
          className='max-h-[calc(100dvh-14rem)] overflow-auto rounded-xl border'
          data-testid='degradation-watch-grid'
        >
          <div
            className='grid items-start'
            style={{
              gridTemplateColumns: `repeat(${lanes.length}, minmax(${LANE_MIN_WIDTH}px, 1fr))`,
            }}
          >
            {lanes.map((lane) => (
              <ModelLane key={lane.model} lane={lane} onOpen={setOpenRecord} />
            ))}
          </div>
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
