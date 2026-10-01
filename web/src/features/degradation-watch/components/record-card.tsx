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
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Clock,
  EyeOff,
  ImageOff,
  Timer,
  LoaderCircle,
  CheckCircle2,
  CircleX,
  Activity,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toIntlLocale } from '@/i18n/languages'
import { formatTimestampToDate, formatNumber } from '@/lib/format'
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
      <span className='max-h-full overflow-auto text-xs break-all whitespace-pre-wrap'>
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

export function RecordUsage(props: { record: DegradationWatchRecord }) {
  const { t, i18n } = useTranslation()
  const record = props.record
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const speed =
    record.elapsed_ms > 0
      ? record.completion_tokens / (record.elapsed_ms / 1000)
      : 0
  return (
    <div className='flex flex-col gap-2 tabular-nums'>
      <div className='grid grid-cols-2 gap-2'>
        <div className='rounded-lg bg-emerald-500/10 px-3 py-2 text-emerald-700 dark:text-emerald-300'>
          <div className='flex items-center gap-1 text-[11px]'>
            <ArrowDown className='size-3' />
            {t('Input tokens')}
          </div>
          <div className='mt-0.5 text-lg font-semibold'>
            {formatNumber(record.prompt_tokens, locale)}
          </div>
        </div>
        <div className='rounded-lg bg-violet-500/10 px-3 py-2 text-violet-700 dark:text-violet-300'>
          <div className='flex items-center gap-1 text-[11px]'>
            <ArrowUp className='size-3' />
            {t('Output tokens')}
          </div>
          <div className='mt-0.5 text-lg font-semibold'>
            {formatNumber(record.completion_tokens, locale)}
          </div>
        </div>
      </div>
      <div className='text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs'>
        <span className='flex items-center gap-1'>
          <Timer className='size-3' />
          {formatElapsed(record.elapsed_ms)}
        </span>
        <span>
          {t('{{speed}} tokens/s', {
            speed: formatNumber(Math.round(speed * 10) / 10, locale),
          })}
        </span>
        {record.reasoning_tokens > 0 && (
          <span>
            {t('{{count}} reasoning tokens', {
              count: record.reasoning_tokens,
            })}
          </span>
        )}
        {record.tokens_estimated && (
          <Badge variant='outline' className='text-[10px]'>
            {t('Estimated')}
          </Badge>
        )}
      </div>
    </div>
  )
}

export function RecordCard(props: RecordCardProps) {
  const { t } = useTranslation()
  const record = props.record
  const active = record.status === 'queued' || record.status === 'running'
  let status = t('Failed')
  let icon = <CircleX className='size-3' />
  let tone =
    'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300'
  if (record.success) {
    status = t('Completed')
    icon = <CheckCircle2 className='size-3' />
    tone =
      'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  } else if (active) {
    status = record.status === 'queued' ? t('Queued') : t('Running')
    icon = <LoaderCircle className='size-3 motion-safe:animate-spin' />
    tone = 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300'
  }
  const error = record.error_details || record.failure_reason
  const label = failureReasonLabel(error)
  return (
    <article
      className={cn(
        'bg-card flex min-w-0 flex-col overflow-hidden rounded-xl border shadow-sm',
        active && 'border-sky-500/30'
      )}
    >
      <div className='flex items-center justify-between gap-2 px-3 pt-3'>
        <span className='truncate text-sm font-semibold'>
          {props.title || record.channel_title || record.model_name}
        </span>
        <Badge variant='outline' className={cn('shrink-0 gap-1', tone)}>
          {icon}
          {status}
        </Badge>
      </div>
      {record.success && (
        <Button
          variant='ghost'
          className='relative m-3 mb-0 aspect-[16/10] h-auto overflow-hidden rounded-lg border p-0'
          onClick={() => props.onOpen(record)}
          aria-label={t('View artwork')}
        >
          <ArtworkPreview record={record} localHtml={props.localHtml} />
        </Button>
      )}
      {active && (
        <div className='mx-3 mt-3 flex items-center gap-2 rounded-lg bg-sky-500/5 px-3 py-4 text-xs text-sky-700 dark:text-sky-300'>
          <Activity className='size-4 motion-safe:animate-pulse' />
          {record.status === 'queued'
            ? t('Waiting for an available worker')
            : t('Receiving model output...')}
        </div>
      )}
      {!active && !record.success && (
        <div className='mx-3 mt-3 rounded-lg border border-rose-500/15 bg-rose-500/5'>
          <div className='flex items-center justify-between px-3 py-1 text-xs text-rose-700 dark:text-rose-300'>
            <span>{t('Error details')}</span>
            <CopyButton
              value={label ? t(label) : error}
              size='icon'
              className='size-6'
            />
          </div>
          <pre className='max-h-64 overflow-auto px-3 pb-3 text-xs leading-relaxed break-all whitespace-pre-wrap text-rose-700 dark:text-rose-300'>
            {label ? t(label) : error}
          </pre>
        </div>
      )}
      <div className='flex flex-col gap-3 p-3'>
        <RecordUsage record={record} />
        <div className='text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-[11px]'>
          <span>{formatTimestampToDate(record.created_at)}</span>
          <span>{record.reasoning_effort || '-'}</span>
          {record.hidden && (
            <span className='flex items-center gap-1'>
              <EyeOff className='size-3' />
              {t('Hidden')}
            </span>
          )}
          <Button
            variant='ghost'
            size='xs'
            onClick={() => props.onOpen(record)}
          >
            {t('Details')}
          </Button>
        </div>
      </div>
    </article>
  )
}
