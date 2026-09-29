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
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toIntlLocale } from '@/i18n/languages'
import { formatTimestampToDate } from '@/lib/format'

import { useDegradationWatchWall } from '../hooks/use-degradation-watch'
import { formatElapsed, successRate } from '../lib/artwork'
import { buildWallRows, flattenRounds } from '../lib/rounds'
import type { DegradationWatchLane, DegradationWatchRecord } from '../types'
import { RecordPlayerDialog } from './artwork-player-dialog'
import { RecordCard } from './record-card'

/** Lanes stay readable on narrow screens by scrolling sideways instead of shrinking. */
const LANE_MIN_WIDTH = 260
const TIME_COLUMN_WIDTH = 96

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

interface LaneCellProps {
  records: DegradationWatchRecord[]
  onOpen: (record: DegradationWatchRecord) => void
}

/** One channel fills the cell; several sit side by side as labelled thumbnails. */
function LaneCell(props: LaneCellProps) {
  if (props.records.length === 0) {
    return (
      <div
        className='text-muted-foreground/60 flex min-h-24 items-center justify-center text-sm'
        aria-hidden='true'
      >
        —
      </div>
    )
  }
  const compact = props.records.length > 1
  return (
    <div className={compact ? 'grid grid-cols-2 gap-2' : 'flex flex-col'}>
      {props.records.map((record) => (
        <RecordCard
          key={record.id}
          record={record}
          title={record.channel_title}
          compact={compact}
          onOpen={props.onOpen}
        />
      ))}
    </div>
  )
}

export function WatchWall() {
  const { t } = useTranslation()
  const wall = useDegradationWatchWall()
  const [openRecord, setOpenRecord] = useState<DegradationWatchRecord | null>(
    null
  )

  const pages = wall.data?.pages
  const lanes = useMemo(() => pages?.[0]?.lanes ?? [], [pages])
  const rows = useMemo(
    () => buildWallRows(lanes, flattenRounds(pages ?? [])),
    [lanes, pages]
  )

  if (wall.isLoading) return <LoadingState />
  if (wall.isError || !pages?.[0]) {
    return (
      <ErrorState
        title={t('Failed to load the degradation watch')}
        onRetry={() => void wall.refetch()}
      />
    )
  }

  const first = pages[0]
  let emptyDescription = t('The degradation watch is currently turned off.')
  if (first.enabled) {
    emptyDescription = t('The first round has not finished yet.')
  }
  const gridTemplateColumns = `${TIME_COLUMN_WIDTH}px repeat(${lanes.length}, minmax(${LANE_MIN_WIDTH}px, 1fr))`

  return (
    <div className='flex flex-col gap-6'>
      <Alert>
        <AlertDescription>
          {t(
            'Every {{minutes}} minutes each channel gets the same prompt for every model below: draw a pelican riding a bicycle as an HTML + SVG animation. Each column is one model and each row one round, so a visibly worse drawing on one channel stands out against its neighbours.',
            { minutes: first.interval_minutes }
          )}
        </AlertDescription>
      </Alert>

      {lanes.length === 0 || rows.length === 0 ? (
        <EmptyState
          icon={Bird}
          title={t('No artwork yet')}
          description={emptyDescription}
        />
      ) : (
        <div
          className='max-h-[calc(100dvh-14rem)] overflow-auto rounded-lg border'
          data-testid='degradation-watch-grid'
        >
          <div className='grid' style={{ gridTemplateColumns }}>
            <div className='bg-background sticky top-0 left-0 z-20 border-r border-b' />
            {lanes.map((lane) => (
              <LaneHeader key={lane.model} lane={lane} />
            ))}
            {rows.map((row) => (
              <div key={row.key} className='contents'>
                <div className='bg-background text-muted-foreground sticky left-0 z-[5] border-r border-b px-2 py-3 text-xs tabular-nums'>
                  {formatTimestampToDate(row.startedAt)}
                </div>
                {row.cells.map((records, index) => (
                  <div
                    key={lanes[index].model}
                    className='border-b p-2 not-last:border-r'
                  >
                    <LaneCell records={records} onOpen={setOpenRecord} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {wall.hasNextPage && (
        <div className='flex justify-center'>
          <Button
            variant='outline'
            disabled={wall.isFetchingNextPage}
            onClick={() => void wall.fetchNextPage()}
          >
            {wall.isFetchingNextPage ? t('Loading...') : t('Load more')}
          </Button>
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
