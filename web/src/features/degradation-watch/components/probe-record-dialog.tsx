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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useIsAdmin } from '@/hooks/use-admin'

import {
  useDegradationWatchRecord,
  useRecordHtml,
  useSetRecordHidden,
} from '../hooks/use-degradation-watch'
import { probeVerdict } from '../lib/probes'
import type { DegradationWatchRecord } from '../types'
import { ArtworkFrame } from './artwork-frame'
import { RecordUsage } from './record-card'

export function ProbeRecordDialog(props: {
  record: DegradationWatchRecord
  onClose: () => void
}) {
  const { t } = useTranslation()
  const admin = useIsAdmin()
  const visibility = useSetRecordHidden()
  const detail = useDegradationWatchRecord(props.record.id)
  const record = detail.data?.record ?? props.record
  const drawing = (record.probe_kind || props.record.probe_kind) === 'drawing'
  const html = useRecordHtml(record.id, drawing && record.success)
  const [source, setSource] = useState(false)
  const labels = {
    passed: drawing ? t('Drawing generated') : t('Passed'),
    mismatch: t('Answer or drawing mismatch'),
    error: t('Request error'),
    running: t('Running'),
    queued: t('Queued'),
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={`${record.group_name || props.record.group_name || ''} · ${record.model_name}`}
      contentClassName='sm:max-w-5xl'
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
      <div className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge variant='secondary'>
            {record.probe_name || props.record.probe_name}
          </Badge>
          <Badge variant='outline'>{labels[probeVerdict(record)]}</Badge>
        </div>
        <RecordUsage record={record} />
        {detail.isError && (
          <ErrorState
            title={t('Failed to load the artwork')}
            onRetry={() => void detail.refetch()}
          />
        )}
        <div className='grid gap-3 md:grid-cols-2'>
          <section className='rounded-xl border p-3'>
            <div className='flex items-center justify-between text-sm font-medium'>
              {t('Prompt')}
              <CopyButton value={detail.data?.prompt ?? ''} />
            </div>
            <pre className='max-h-40 overflow-auto text-xs leading-relaxed whitespace-pre-wrap'>
              {detail.data?.prompt ||
                t('Prompt not recorded for legacy checks')}
            </pre>
          </section>
          {!drawing && (
            <section className='rounded-xl border p-3'>
              <div className='mb-3 text-sm font-medium'>
                {t('Expected answer')}
              </div>
              <pre className='text-sm break-all whitespace-pre-wrap'>
                {detail.data?.expected ?? ''}
              </pre>
              <p className='text-muted-foreground mt-2 text-xs'>
                {detail.data?.match === 'contains'
                  ? t('Contains answer')
                  : t('Exact match (trim whitespace)')}
              </p>
            </section>
          )}
        </div>
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
        <div className='flex items-center justify-between gap-2'>
          <span className='text-sm font-medium'>{t('Model response')}</span>
          <div className='flex items-center gap-2'>
            {drawing && record.success && (
              <Button
                variant='outline'
                size='sm'
                onClick={() => setSource(!source)}
              >
                {source ? t('Play') : t('View source')}
              </Button>
            )}
            <CopyButton value={detail.data?.output || html.data || ''} />
          </div>
        </div>
        {drawing && record.success && !source && html.data ? (
          <div className='aspect-[16/10] overflow-hidden rounded-xl border'>
            <ArtworkFrame html={html.data} title={record.model_name} />
          </div>
        ) : (
          <pre className='bg-muted/50 max-h-[50dvh] min-h-24 overflow-auto rounded-xl p-4 text-xs leading-relaxed break-all whitespace-pre-wrap'>
            {detail.data?.output || t('Waiting for model output...')}
          </pre>
        )}
      </div>
    </Dialog>
  )
}
