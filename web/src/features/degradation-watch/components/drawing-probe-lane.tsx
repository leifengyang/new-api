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
import { ArrowRight, RefreshCw } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import {
  useProbeHistory,
  type ProbeHistory,
  type ProbeLane,
} from '../hooks/use-probes'
import type { DegradationWatchRecord } from '../types'
import { RecordCard } from './record-card'

interface DrawingPageProps {
  row: ProbeHistory
  lane: ProbeLane
  days: number
  since: number
  onOpen: (record: DegradationWatchRecord, input?: boolean) => void
}

function OlderDrawings(props: DrawingPageProps & { before: number }) {
  const { t } = useTranslation()
  const history = useProbeHistory(
    props.lane,
    props.days,
    true,
    props.row.id,
    props.before
  )
  if (history.isPending) {
    return <LoadingState className='min-h-40 w-52 shrink-0' />
  }
  const row = history.data?.probes[0]
  if (!row) {
    return (
      <ErrorState
        className='w-52 shrink-0'
        title={t('Failed to load the artwork')}
        onRetry={() => void history.refetch()}
      />
    )
  }
  return <DrawingPage {...props} row={row} />
}

function DrawingPage(props: DrawingPageProps & { onBrowse?: () => void }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(5)
  const [older, setOlder] = useState(false)
  const marker = useRef<HTMLDivElement>(null)
  const browseRequested = useRef(false)
  const records = props.row.records.filter(
    (record) =>
      record.created_at >= props.since ||
      ['running', 'queued'].includes(record.status ?? '')
  )
  useLayoutEffect(() => {
    if (browseRequested.current) {
      marker.current?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      })
      browseRequested.current = false
    }
  }, [visible])
  const hasBuffered = visible < records.length
  const hasMore = hasBuffered || props.row.next_before > 0
  return (
    <>
      {records.slice(0, visible).map((record, index) => (
        <div
          key={record.id}
          ref={index === visible - 5 ? marker : undefined}
          className='w-[min(80vw,18rem)] min-w-52 shrink-0 xl:w-[calc((100%_-_12rem)/5)]'
        >
          <RecordCard
            record={record}
            title={record.model_name}
            previewClassName='aspect-[16/10] h-auto min-h-28'
            onOpen={props.onOpen}
            onInputClick={() => props.onOpen(record, true)}
          />
        </div>
      ))}
      {older ? (
        <OlderDrawings {...props} before={props.row.next_before} />
      ) : (
        hasMore && (
          <Button
            variant='outline'
            className='h-auto min-h-48 w-32 shrink-0 flex-col gap-2 border-dashed'
            onClick={() => {
              props.onBrowse?.()
              if (hasBuffered) {
                browseRequested.current = true
                setVisible((count) => count + 5)
              } else setOlder(true)
            }}
          >
            <ArrowRight className='size-5' />
            {t('Load more')}
          </Button>
        )
      )}
    </>
  )
}

export function DrawingProbeLane(
  props: DrawingPageProps & { heading: ReactNode }
) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ProbeHistory | null>(null)
  const [revision, setRevision] = useState(0)
  const liveRecords = new Map(
    props.row.records.map((record) => [record.id, record])
  )
  const row = snapshot
    ? {
        ...snapshot,
        // Preserve the browsing cursor, but keep loaded running attempts up to date.
        records: snapshot.records.map(
          (record) => liveRecords.get(record.id) ?? record
        ),
      }
    : props.row
  return (
    <section className='min-w-0 space-y-3' aria-label={props.row.name}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          {props.heading}
          <Badge variant='outline'>{props.row.name}</Badge>
          {!props.row.enabled && <Badge variant='outline'>{t('Paused')}</Badge>}
          <span className='text-muted-foreground text-xs'>
            {t('Every {{count}} minutes', {
              count: props.row.interval_minutes,
            })}
          </span>
        </div>
        {snapshot && (
          <Button
            size='sm'
            variant='ghost'
            onClick={() => {
              setSnapshot(null)
              setRevision((value) => value + 1)
            }}
          >
            <RefreshCw />
            {t('Return to live')}
          </Button>
        )}
      </div>
      {row.records.length === 0 ? (
        <p className='text-muted-foreground bg-muted/30 rounded-lg p-4 text-sm'>
          {t('No checks in this period')}
        </p>
      ) : (
        <div
          className='flex min-w-0 items-stretch gap-3 overflow-x-auto overscroll-x-contain pb-3'
          tabIndex={0}
          role='region'
          aria-label={t('Drawing history')}
        >
          <DrawingPage
            key={revision}
            {...props}
            row={row}
            onBrowse={() => {
              if (!snapshot) setSnapshot(props.row)
            }}
          />
        </div>
      )}
    </section>
  )
}
