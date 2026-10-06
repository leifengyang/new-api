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
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import {
  monitorResultSource,
  type MonitorAttempt,
} from '../lib/temporary-monitor'
import { ComparisonResult } from './comparison-results'
import { InputDetailsDialog } from './input-details-dialog'
import { TextOutputPreview } from './record-card'

export function TemporaryMonitorResult(props: { attempt: MonitorAttempt }) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const [open, setOpen] = useState(false)
  const [inputOpen, setInputOpen] = useState(false)
  const active =
    props.attempt.status === 'queued' || props.attempt.status === 'running'
  const detail = useQuery({
    queryKey: [
      'temporary-monitor',
      userID,
      'attempt',
      props.attempt.id,
      props.attempt.status,
    ],
    queryFn: () => monitorResultSource.loadAttempt(props.attempt.id),
    enabled: open,
    staleTime: active ? 0 : Infinity,
    gcTime: 2 * 60_000,
    refetchInterval: open && active ? 1000 : false,
  })
  const preparation = detail.data?.preparation
  return (
    <div className='space-y-3'>
      {props.attempt.subject && (
        <div className='flex flex-wrap items-center gap-2'>
          <Badge variant='secondary'>{props.attempt.subject}</Badge>
          <Button variant='outline' size='sm' onClick={() => setOpen(true)}>
            {active && props.attempt.phase === 'rewriting'
              ? t('Rewriting prompt')
              : t('Prompt rewrite')}
          </Button>
        </div>
      )}
      <ComparisonResult
        prompt=''
        latest={props.attempt}
        attempts={[props.attempt]}
        busy={false}
        onStop={() => {}}
        onRetry={() => {}}
        source={monitorResultSource}
        readOnly
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('Prompt rewrite')}
        description={t(
          'Rewrite usage is separate from the drawing check usage.'
        )}
        contentClassName='sm:max-w-3xl'
      >
        {detail.isPending && <LoadingState />}
        {detail.isError && <ErrorState onRetry={() => void detail.refetch()} />}
        {detail.data && (
          <div className='space-y-4'>
            <details className='rounded-lg border p-3 text-sm'>
              <summary className='cursor-pointer'>
                {t('Original prompt')}
              </summary>
              <div className='flex justify-end'>
                <CopyButton value={detail.data.original_prompt ?? ''} />
              </div>
              <pre className='max-h-48 overflow-auto whitespace-pre-wrap'>
                {detail.data.original_prompt}
              </pre>
            </details>
            {preparation && (
              <>
                <div className='flex flex-wrap gap-2'>
                  <Badge variant='outline'>{preparation.model}</Badge>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => setInputOpen(true)}
                  >
                    {t('Input tokens')}:{' '}
                    {formatNumber(preparation.input_tokens)}
                  </Button>
                  <Badge variant='secondary'>
                    {t('Output tokens')}:{' '}
                    {formatNumber(preparation.output_tokens)}
                  </Badge>
                  <Badge variant='outline'>
                    {t('Reasoning tokens')}:{' '}
                    {formatNumber(preparation.reasoning_tokens)}
                  </Badge>
                  <Badge variant='outline'>
                    {t('Duration')}:{' '}
                    {formatNumber(preparation.elapsed_ms / 1000)} s
                  </Badge>
                </div>
                {preparation.error && (
                  <div className='border-destructive/30 text-destructive rounded-lg border p-3 text-sm'>
                    <CopyButton value={preparation.error} />
                    <pre className='max-h-48 overflow-auto whitespace-pre-wrap'>
                      {preparation.error}
                    </pre>
                  </div>
                )}
                <div className='h-80 overflow-hidden rounded-lg border'>
                  <TextOutputPreview
                    output={preparation.output}
                    title={t('Rewritten prompt')}
                  />
                </div>
                <InputDetailsDialog
                  open={inputOpen}
                  onOpenChange={setInputOpen}
                  attempt={preparation}
                  prompt={detail.data.rewrite_prompt ?? ''}
                />
              </>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
