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
import { ArrowDown, Info, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import {
  comparisonProtocolLabels,
  type ComparisonAttempt,
} from '../lib/comparison'
import { TextOutputPreview } from './record-card'

export function InputDetailsDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  attempt: ComparisonAttempt
  prompt: string
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const attempt = props.attempt
  let source = t('Upstream reported')
  if (attempt.status === 'queued') {
    source = t('Queued')
  } else if (attempt.tokens_estimated) {
    source = t('Includes estimates')
  } else if (attempt.input_tokens === 0 && attempt.output_tokens === 0) {
    source = t('Not available')
  }
  // Only the immutable round and attempt snapshots belong in this view.
  // Do not serialize profiles or form state: they can contain API keys.
  const outputSettings: Record<string, unknown> = {}
  if (attempt.protocol === 'anthropic') {
    outputSettings.max_tokens = attempt.max_output_tokens ?? 8192
    if (attempt.effort) {
      outputSettings.output_config = { effort: attempt.effort }
    }
  } else if (attempt.max_output_tokens) {
    const field =
      attempt.protocol === 'responses'
        ? 'max_output_tokens'
        : 'max_completion_tokens'
    outputSettings[field] = attempt.max_output_tokens
  }
  if (attempt.effort && attempt.protocol === 'responses') {
    outputSettings.reasoning = { effort: attempt.effort }
  } else if (attempt.effort && attempt.protocol === 'chat') {
    outputSettings.reasoning_effort = attempt.effort
  }
  const settings = {
    base_url: attempt.base_url,
    model: attempt.model,
    protocol: attempt.protocol,
    prompt: props.prompt,
    ...outputSettings,
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Input details')}
      description={`${attempt.name} · ${attempt.model} · ${t('Attempt {{number}}', { number: attempt.attempt })}`}
      contentClassName='sm:max-w-3xl'
    >
      <div className='space-y-4'>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='rounded-xl border border-emerald-500/15 bg-emerald-500/10 p-4 text-emerald-700 dark:text-emerald-300'>
            <div className='flex items-center gap-2 text-xs font-medium'>
              <ArrowDown className='size-4' />
              {t('Input tokens')}
            </div>
            <div className='my-2 text-3xl font-semibold tabular-nums'>
              {formatNumber(attempt.input_tokens, locale)}
            </div>
            <Badge
              variant='outline'
              className='border-emerald-500/20 text-inherit'
            >
              {source}
            </Badge>
          </div>
          <div className='bg-muted/30 rounded-xl border p-4'>
            <div className='text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium'>
              <MessageSquare className='size-4' />
              {t('Prompt snapshot')}
            </div>
            <div className='flex flex-wrap gap-2'>
              <Badge variant='secondary'>user</Badge>
              <Badge variant='outline'>
                {comparisonProtocolLabels[attempt.protocol]}
              </Badge>
              <Badge variant='outline'>
                {t('Reasoning effort')}: {attempt.effort || '-'}
              </Badge>
            </div>
            <p className='text-muted-foreground mt-3 text-xs leading-relaxed'>
              {t(
                'Saved inputs for this attempt, independent of current form edits.'
              )}
            </p>
          </div>
        </div>
        <div className='flex gap-2 rounded-lg border border-sky-500/15 bg-sky-500/5 p-3 text-xs leading-relaxed text-sky-800 dark:text-sky-200'>
          <Info className='mt-0.5 size-4 shrink-0' />
          <p>
            {t(
              'Provider-added context is not available here. Token counts cannot reveal its contents or be mapped exactly to the prompt below.'
            )}
          </p>
        </div>
        <Tabs defaultValue='prompt'>
          <TabsList aria-label={t('Input details')}>
            <TabsTrigger value='prompt'>{t('Prompt snapshot')}</TabsTrigger>
            <TabsTrigger value='settings'>
              {t('Request parameters')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value='prompt'>
            <div className='h-80 max-h-[45dvh] overflow-hidden rounded-lg border'>
              <TextOutputPreview
                output={props.prompt}
                title={t('Prompt snapshot')}
                copyLabel={t('Copy prompt')}
              />
            </div>
          </TabsContent>
          <TabsContent value='settings'>
            <p className='text-muted-foreground mb-2 text-xs'>
              {t(
                'Saved settings, not a raw request capture. Authentication headers and API keys are excluded.'
              )}
            </p>
            <div className='h-80 max-h-[45dvh] overflow-hidden rounded-lg border'>
              <TextOutputPreview
                output={JSON.stringify(settings, null, 2)}
                title={t('Request parameters')}
                copyLabel={t('Copy request parameters')}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </Dialog>
  )
}
