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
import { Brain, Clock, EyeOff, ImageOff, Timer } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTimestampToDate } from '@/lib/format'
import { cn } from '@/lib/utils'

import { useInViewport, useRecordHtml } from '../hooks/use-degradation-watch'
import { failureReasonLabel, formatElapsed } from '../lib/artwork'
import type { DegradationWatchRecord } from '../types'
import { ArtworkFrame } from './artwork-frame'

interface ArtworkPreviewProps {
  record: DegradationWatchRecord
  /** Artwork already in hand (self-test history); skips the server fetch. */
  localHtml?: string
}

/** Loads and mounts the artwork only while the card is near the viewport. */
function ArtworkPreview(props: ArtworkPreviewProps) {
  const { t } = useTranslation()
  const { ref, inView } = useInViewport<HTMLDivElement>()
  const html = useRecordHtml(
    props.record.id,
    inView && props.localHtml === undefined
  )
  const artwork = props.localHtml ?? html.data

  let content = <Skeleton className='size-full rounded-none' />
  if (inView && artwork) {
    content = (
      <ArtworkFrame
        html={artwork}
        title={props.record.model_name}
        className='pointer-events-none'
      />
    )
  } else if (html.isError) {
    content = (
      <div className='text-muted-foreground flex size-full items-center justify-center text-xs'>
        {t('Failed to load the artwork')}
      </div>
    )
  }

  return (
    <div ref={ref} className='size-full'>
      {content}
    </div>
  )
}

interface FailurePreviewProps {
  reason: string
}

export function FailurePreview(props: FailurePreviewProps) {
  const { t } = useTranslation()
  const label = failureReasonLabel(props.reason)
  return (
    <div className='bg-muted text-muted-foreground flex size-full flex-col items-center justify-center gap-2 p-4 text-center'>
      <ImageOff className='size-6' />
      <span className='text-sm font-medium'>{t('Failed')}</span>
      <span className='line-clamp-3 text-xs break-all'>
        {label ? t(label) : props.reason}
      </span>
    </div>
  )
}

interface RecordMetaProps {
  modelName: string
  reasoningEffort: string
  createdAt: number
  elapsedMs: number
  reasoningTokens: number
}

export function RecordMeta(props: RecordMetaProps) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col gap-1.5 text-xs'>
      <div className='flex items-center justify-between gap-2'>
        <span className='truncate font-medium'>{props.modelName}</span>
        <span className='text-muted-foreground flex shrink-0 items-center gap-1'>
          <Clock className='size-3' />
          {formatTimestampToDate(props.createdAt)}
        </span>
      </div>
      <div className='text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1'>
        <span>
          {t('Reasoning effort')}: {props.reasoningEffort || '-'}
        </span>
        <span className='flex items-center gap-1'>
          <Timer className='size-3' />
          {formatElapsed(props.elapsedMs)}
        </span>
        <span className='flex items-center gap-1'>
          <Brain className='size-3' />
          {t('{{count}} reasoning tokens', { count: props.reasoningTokens })}
        </span>
      </div>
    </div>
  )
}

interface RecordCardProps {
  record: DegradationWatchRecord
  localHtml?: string
  /** Channel label shown above the meta; the wall passes the alias. */
  title?: string
  /** Thumbnail mode for cells holding several channels: title only, no meta. */
  compact?: boolean
  onOpen: (record: DegradationWatchRecord) => void
}

export function RecordCard(props: RecordCardProps) {
  const { t } = useTranslation()
  const record = props.record
  return (
    <button
      type='button'
      onClick={() => props.onOpen(record)}
      className={cn(
        'bg-card hover:ring-primary/40 group flex flex-col overflow-hidden rounded-lg border text-left transition-shadow hover:ring-2',
        !record.success && 'opacity-80'
      )}
    >
      <div className='relative aspect-[16/10] w-full overflow-hidden border-b'>
        {record.success ? (
          <ArtworkPreview record={record} localHtml={props.localHtml} />
        ) : (
          <FailurePreview reason={record.failure_reason} />
        )}
        {record.hidden && (
          <Badge variant='secondary' className='absolute top-2 left-2 gap-1'>
            <EyeOff className='size-3' />
            {t('Hidden')}
          </Badge>
        )}
      </div>
      {props.compact ? (
        <div className='truncate px-2 py-1.5 text-xs font-medium'>
          {props.title}
        </div>
      ) : (
        <div className='flex flex-col gap-1.5 p-3'>
          {props.title && (
            <span className='truncate text-sm font-semibold'>
              {props.title}
            </span>
          )}
          <RecordMeta
            modelName={record.model_name}
            reasoningEffort={record.reasoning_effort}
            createdAt={record.created_at}
            elapsedMs={record.elapsed_ms}
            reasoningTokens={record.reasoning_tokens}
          />
        </div>
      )}
    </button>
  )
}
