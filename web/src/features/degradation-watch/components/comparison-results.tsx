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
import { Activity, Clock3, RotateCcw, Square } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import { useInViewport } from '../hooks/use-degradation-watch'
import {
  comparisonRecord,
  comparisonProtocolLabels,
  comparisonRequest,
  type ComparisonAttempt,
} from '../lib/comparison'
import { ArtworkPlayerDialog } from './artwork-player-dialog'
import { InputDetailsDialog } from './input-details-dialog'
import { RecordCard, TextOutputPreview } from './record-card'

export function ComparisonResult(props: {
  prompt: string
  latest: ComparisonAttempt
  attempts: ComparisonAttempt[]
  busy: boolean
  onStop: (id: number) => void
  onRetry: (attempt: ComparisonAttempt) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const userID = useAuthStore((state) => state.auth.user?.id)
  const [selected, setSelected] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [player, setPlayer] = useState(false)
  const [inputOpen, setInputOpen] = useState(false)
  const latest = props.latest
  const attempt = props.attempts.find((item) => item.id === selected) ?? latest
  const active = attempt.status === 'queued' || attempt.status === 'running'
  const { ref, inView } = useInViewport<HTMLDivElement>()
  const detail = useQuery({
    queryKey: ['self-test', userID, 'attempt', attempt.id, attempt.status],
    queryFn: () =>
      comparisonRequest<ComparisonAttempt>(`/attempts/${attempt.id}`),
    enabled: player || (inView && (expanded || !active)),
    refetchInterval: active && (expanded || player) ? 1000 : false,
  })
  const record = comparisonRecord(attempt)
  return (
    <div ref={ref} className='min-w-0 space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <Badge variant='outline' className='bg-primary/5 text-primary'>
            {attempt.group_index + 1}
          </Badge>
          <h3 className='truncate font-semibold'>{attempt.name}</h3>
        </div>
        <Badge variant='secondary'>
          {comparisonProtocolLabels[attempt.protocol]}
        </Badge>
      </div>
      <p
        className='text-muted-foreground truncate text-xs'
        title={attempt.base_url}
      >
        {attempt.base_url}
      </p>
      <RecordCard
        record={record}
        previewClassName='h-64 min-h-64 overflow-auto'
        title={attempt.model}
        localHtml={detail.data?.html ?? ''}
        localOutput={detail.data?.output}
        onOpen={() => setPlayer(true)}
        onInputClick={() => setInputOpen(true)}
      />
      {detail.isError && (
        <ErrorState
          title={t('Failed to load the artwork')}
          onRetry={() => void detail.refetch()}
        />
      )}
      <div className='grid grid-cols-2 gap-2 text-xs tabular-nums'>
        <div className='rounded-lg bg-sky-500/10 p-2.5 text-sky-700 dark:text-sky-300'>
          <div className='mb-1 flex items-center gap-1'>
            <Clock3 className='size-3' />
            {t('Time to first token')}
          </div>
          <strong>
            {attempt.first_token_ms
              ? `${formatNumber(attempt.first_token_ms / 1000, locale)} s`
              : '—'}
          </strong>
        </div>
        <div className='rounded-lg bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300'>
          <div className='mb-1 flex items-center gap-1'>
            <Activity className='size-3' />
            {t('Reasoning tokens')}
          </div>
          <strong>{formatNumber(attempt.reasoning_tokens, locale)}</strong>
        </div>
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          variant='outline'
          size='sm'
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {t('Live output')}
        </Button>
        {active && (
          <Button
            variant='outline'
            size='sm'
            disabled={props.busy}
            onClick={() => props.onStop(attempt.id)}
          >
            <Square className='size-3' />
            {t('Stop')}
          </Button>
        )}
        {attempt.id === latest.id &&
          (attempt.status === 'failed' || attempt.status === 'cancelled') &&
          attempt.attempt < 10 && (
            <Button
              variant='outline'
              size='sm'
              disabled={props.busy}
              onClick={() => props.onRetry(attempt)}
            >
              <RotateCcw className='size-3' />
              {t('Retry')}
            </Button>
          )}
        {attempt.status === 'cancelled' && (
          <Badge variant='secondary'>{t('Cancelled')}</Badge>
        )}
      </div>
      {props.attempts.length > 1 && (
        <NativeSelect
          aria-label={t('Attempt history')}
          value={attempt.id}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {props.attempts.map((item) => (
            <NativeSelectOption value={item.id} key={item.id}>
              {t('Attempt {{number}}', { number: item.attempt })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      {expanded && (
        <div className='h-80 overflow-hidden rounded-lg border'>
          <TextOutputPreview
            output={detail.data?.output ?? ''}
            title={t('Live output')}
          />
        </div>
      )}
      <InputDetailsDialog
        key={attempt.id}
        open={inputOpen}
        onOpenChange={setInputOpen}
        attempt={attempt}
        prompt={props.prompt}
      />
      <ArtworkPlayerDialog
        open={player}
        onOpenChange={setPlayer}
        title={`${attempt.name} · ${attempt.model}`}
        html={detail.data?.html}
        output={detail.data?.output}
        loading={detail.isLoading}
        loadError={detail.isError}
        failureReason={
          attempt.status === 'failed' || attempt.status === 'cancelled'
            ? attempt.error
            : undefined
        }
        meta={<span className='text-xs'>{attempt.effort}</span>}
      />
    </div>
  )
}
