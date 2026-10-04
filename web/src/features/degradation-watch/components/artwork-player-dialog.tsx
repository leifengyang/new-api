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
import { Code, Eye, EyeOff, Play } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { useIsAdmin } from '@/hooks/use-admin'

import {
  useRecordHtml,
  useDegradationWatchRecord,
  useSetRecordHidden,
} from '../hooks/use-degradation-watch'
import type { DegradationWatchRecord } from '../types'
import { ArtworkFrame } from './artwork-frame'
import {
  FailurePreview,
  RecordMeta,
  RecordUsage,
  TextOutputPreview,
} from './record-card'

interface ArtworkPlayerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  meta: ReactNode
  html?: string
  output?: string
  loading?: boolean
  loadError?: boolean
  /** Set for a failed attempt; the stage then shows the reason instead. */
  failureReason?: string
  actions?: ReactNode
}

/** Full-screen player shared by the wall and the self-test history. */
export function ArtworkPlayerDialog(props: ArtworkPlayerDialogProps) {
  const { t } = useTranslation()
  const [showSource, setShowSource] = useState(false)
  if (!props.open) return null

  let stage: ReactNode = null
  if (props.output && (!props.html || props.failureReason !== undefined)) {
    stage = (
      <TextOutputPreview output={props.output} error={props.failureReason} />
    )
  } else if (props.failureReason !== undefined) {
    stage = <FailurePreview reason={props.failureReason} />
  } else if (props.loading) {
    stage = <LoadingState className='size-full min-h-0' />
  } else if (props.loadError || props.html === undefined) {
    stage = (
      <div className='text-muted-foreground flex size-full items-center justify-center text-sm'>
        {t('Failed to load the artwork')}
      </div>
    )
  } else if (showSource) {
    stage = (
      <pre className='bg-muted size-full overflow-auto p-4 text-xs leading-relaxed break-all whitespace-pre-wrap'>
        {props.html}
      </pre>
    )
  } else {
    stage = <ArtworkFrame html={props.html} title={props.title} />
  }

  const canToggleSource =
    props.failureReason === undefined && Boolean(props.html)

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setShowSource(false)
        props.onOpenChange(open)
      }}
      title={props.title}
      contentClassName='sm:max-w-[min(1280px,95vw)]'
      footer={
        <div className='flex w-full flex-wrap items-center justify-between gap-2'>
          <div className='min-w-0 flex-1'>{props.meta}</div>
          <div className='flex items-center gap-2'>
            {props.actions}
            {canToggleSource && showSource && (
              <CopyButton
                value={props.html ?? ''}
                variant='outline'
                size='default'
                tooltip={t('Copy source')}
              />
            )}
            {canToggleSource && (
              <Button
                variant='outline'
                onClick={() => setShowSource((value) => !value)}
              >
                {showSource ? <Play /> : <Code />}
                {showSource ? t('Play') : t('View source')}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className='aspect-[16/10] max-h-[70dvh] w-full overflow-hidden rounded-lg border'>
        {stage}
      </div>
    </Dialog>
  )
}

interface RecordPlayerDialogProps {
  title: string
  record: DegradationWatchRecord | null
  onClose: () => void
}

export function RecordPlayerDialog(props: RecordPlayerDialogProps) {
  const { t } = useTranslation()
  const isAdmin = useIsAdmin()
  const detail = useDegradationWatchRecord(props.record?.id)
  const record = detail.data?.record ?? props.record
  const html = useRecordHtml(record?.id ?? 0, Boolean(record?.success))
  const setHidden = useSetRecordHidden()

  if (!record) return null

  const active = record.status === 'queued' || record.status === 'running'
  if (active || !record.success) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose()
        }}
        title={`${record.model_name} · ${props.title}`}
        contentClassName='sm:max-w-3xl'
      >
        <div className='flex flex-col gap-4'>
          <RecordUsage record={record} />
          {active && (
            <p className='text-sm text-sky-700 dark:text-sky-300'>
              {record.status === 'queued'
                ? t('Queued')
                : t('Receiving model output...')}
            </p>
          )}
          {!active && (
            <FailurePreview
              reason={record.error_details || record.failure_reason}
            />
          )}
          <div className='flex items-center justify-between text-sm font-medium'>
            <span>{t('Live output')}</span>
            <CopyButton value={detail.data?.output ?? ''} />
          </div>
          {detail.isError && (
            <p className='text-destructive text-sm'>
              {t('Failed to load the artwork')}
            </p>
          )}
          <pre className='bg-muted max-h-[50dvh] min-h-32 overflow-auto rounded-lg border p-4 text-xs leading-relaxed break-all whitespace-pre-wrap'>
            {detail.data?.output || t('Waiting for model output...')}
          </pre>
        </div>
      </Dialog>
    )
  }

  return (
    <ArtworkPlayerDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={props.title}
      html={html.data}
      loading={html.isLoading}
      loadError={html.isError}
      failureReason={record.success ? undefined : record.failure_reason}
      meta={
        <RecordMeta
          modelName={record.model_name}
          reasoningEffort={record.reasoning_effort}
          createdAt={record.created_at}
          elapsedMs={record.elapsed_ms}
          reasoningTokens={record.reasoning_tokens}
        />
      }
      actions={
        isAdmin && (
          <Button
            variant='outline'
            disabled={setHidden.isPending}
            onClick={() =>
              setHidden.mutate(
                { id: record.id, hidden: !record.hidden },
                { onSuccess: props.onClose }
              )
            }
          >
            {record.hidden ? <Eye /> : <EyeOff />}
            {record.hidden ? t('Unhide') : t('Hide')}
          </Button>
        )
      }
    />
  )
}
