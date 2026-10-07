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
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIsAdmin } from '@/hooks/use-admin'
import { formatTimestampToDate } from '@/lib/format'
import { cn } from '@/lib/utils'

import {
  useDegradationWatchRecord,
  useRecordHtml,
  useSetRecordHidden,
} from '../hooks/use-degradation-watch'
import { probeVerdict } from '../lib/probes'
import type { DegradationWatchRecord } from '../types'
import { ArtworkFrame } from './artwork-frame'
import { ProbeAnswerRules } from './probe-answer-rules'
import { RecordUsage, TextOutputPreview } from './record-card'

export function ProbeRecordDialog(props: {
  record: DegradationWatchRecord
  initialInputOpen?: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const admin = useIsAdmin()
  const visibility = useSetRecordHidden()
  const detail = useDegradationWatchRecord(props.record.id)
  const record = detail.data?.record ?? props.record
  const drawing = (record.probe_kind || props.record.probe_kind) === 'drawing'
  const html = useRecordHtml(record.id, drawing && record.success)
  const [inputOpen, setInputOpen] = useState(props.initialInputOpen ?? false)
  const inputId = useId()
  const labels = {
    passed: drawing ? t('Drawing generated') : t('Passed'),
    intermediate: t('Intermediate result'),
    mismatch: t('Answer or drawing mismatch'),
    error: t('Request error'),
    running: t('Running'),
    queued: t('Queued'),
  }
  const prompt =
    detail.data?.prompt || t('Prompt not recorded for legacy checks')
  const output = detail.data?.output || html.data || ''
  let preview = <LoadingState className='size-full min-h-0' />
  if (html.isError) {
    preview = (
      <ErrorState
        title={t('Failed to load the artwork')}
        onRetry={() => void html.refetch()}
      />
    )
  } else if (html.data) {
    preview = <ArtworkFrame html={html.data} title={record.model_name} />
  }
  const input = (
    <section className='min-w-0 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3'>
      <div className='mb-2 flex items-center justify-between text-sm font-medium'>
        {t('Prompt snapshot')}
        <CopyButton
          value={detail.data?.prompt ?? ''}
          aria-label={t('Copy prompt')}
        />
      </div>
      {detail.isPending ? (
        <LoadingState className='min-h-16' />
      ) : (
        <pre className='max-h-64 overflow-auto text-xs leading-relaxed break-all whitespace-pre-wrap'>
          {prompt}
        </pre>
      )}
    </section>
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={drawing ? t('Drawing check details') : t('Probe details')}
      description={`${record.group_name || props.record.group_name || ''} · ${record.model_name} · ${formatTimestampToDate(record.created_at)}`}
      contentClassName={
        drawing ? 'sm:max-w-[min(1440px,95vw)]' : 'sm:max-w-3xl'
      }
      footer={
        admin ? (
          <Button
            variant='outline'
            disabled={visibility.isPending}
            onClick={() =>
              visibility.mutate(
                { id: record.id, hidden: !record.hidden },
                { onSuccess: props.onClose }
              )
            }
          >
            {record.hidden ? t('Unhide') : t('Hide')}
          </Button>
        ) : undefined
      }
    >
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge variant='secondary'>
            {record.probe_name || props.record.probe_name}
          </Badge>
          <Badge
            variant='outline'
            className={cn(
              probeVerdict(record) === 'passed' &&
                'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              probeVerdict(record) === 'intermediate' &&
                'border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300'
            )}
          >
            {labels[probeVerdict(record)]}
          </Badge>
          <Badge variant='outline'>
            {t('Reasoning effort')}: {record.reasoning_effort || '—'}
          </Badge>
        </div>
        {detail.isError && (
          <ErrorState
            title={t('Failed to load the artwork')}
            onRetry={() => void detail.refetch()}
          />
        )}
        <div
          className={cn(
            'grid min-w-0 gap-5',
            drawing && 'lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]'
          )}
        >
          <div
            className={cn(
              'min-w-0 space-y-4',
              drawing && 'lg:col-start-2 lg:row-start-1'
            )}
          >
            <RecordUsage
              record={record}
              onInputClick={
                drawing ? () => setInputOpen((open) => !open) : undefined
              }
              inputExpanded={drawing ? inputOpen : undefined}
              inputControls={drawing ? inputId : undefined}
            />
            {drawing ? (
              <Collapsible open={inputOpen} onOpenChange={setInputOpen}>
                <CollapsibleContent id={inputId}>{input}</CollapsibleContent>
              </Collapsible>
            ) : (
              input
            )}
            {!drawing && (
              <ProbeAnswerRules
                expected={detail.data?.expected ?? ''}
                intermediate={detail.data?.intermediate_expected ?? ''}
                match={detail.data?.match}
              />
            )}
            {record.error_details && (
              <section className='rounded-xl border border-amber-400/30 bg-amber-500/5 p-3'>
                <div className='flex items-center justify-between text-sm font-medium'>
                  {t('Error details')}
                  <CopyButton value={record.error_details} />
                </div>
                <pre className='max-h-64 overflow-auto text-xs leading-relaxed break-all whitespace-pre-wrap'>
                  {record.error_details}
                </pre>
              </section>
            )}
          </div>
          <div
            className={cn(
              'min-w-0',
              drawing && 'lg:col-start-1 lg:row-start-1'
            )}
          >
            {drawing ? (
              <Tabs defaultValue={record.success ? 'preview' : 'output'}>
                <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
                  <TabsList aria-label={t('Model response')}>
                    <TabsTrigger value='preview' disabled={!record.success}>
                      {t('Preview')}
                    </TabsTrigger>
                    <TabsTrigger value='output'>{t('Full output')}</TabsTrigger>
                  </TabsList>
                  <CopyButton
                    value={output}
                    variant='outline'
                    size='sm'
                    aria-label={t('Copy full output')}
                  >
                    {t('Copy full output')}
                  </CopyButton>
                </div>
                <TabsContent value='preview'>
                  <div className='aspect-[16/10] max-h-[65dvh] overflow-hidden rounded-xl border'>
                    {preview}
                  </div>
                </TabsContent>
                <TabsContent value='output'>
                  <div className='h-[min(60dvh,36rem)] overflow-hidden rounded-xl border'>
                    <TextOutputPreview
                      output={output}
                      title={t('Model response')}
                    />
                  </div>
                </TabsContent>
              </Tabs>
            ) : (
              <div className='max-h-[40dvh] overflow-auto rounded-xl border'>
                <TextOutputPreview
                  output={output}
                  title={t('Model response')}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
