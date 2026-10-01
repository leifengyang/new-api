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
import { ArrowDown, ArrowUp, Database, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from '@/components/ui/popover'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatCompactNumber } from '@/lib/format'

import type { UsageLog } from '../data/schema'
import { parseLogOther } from '../lib/format'
import { getLogTokenUsage } from '../lib/token-usage'

export function TokenUsageCell(props: { log: UsageLog }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const usage = getLogTokenUsage(
    props.log.prompt_tokens,
    props.log.completion_tokens,
    parseLogOther(props.log.other)
  )
  if (usage.total === 0 && !usage.cacheWrite && !usage.cacheRead) {
    return <span className='text-muted-foreground'>—</span>
  }
  const rows = [
    [t('Uncached input'), usage.input],
    [t('Output Tokens'), usage.output],
    [t('Cache Read'), usage.cacheRead],
    [t('Cache Write'), usage.cacheWrite],
    ...(usage.write5m > 0 ? [[t('Cache Write (5m)'), usage.write5m]] : []),
    ...(usage.write1h > 0 ? [[t('Cache Write (1h)'), usage.write1h]] : []),
    [t('Full input length'), usage.totalInput],
  ] as [string, number | null][]
  return (
    <div
      className='flex w-fit items-center gap-1.5 tabular-nums'
      data-log-tokens
    >
      <div className='flex flex-col gap-0 leading-tight'>
        <div className='flex items-center gap-2'>
          <span
            className='inline-flex items-center gap-1'
            title={t('Uncached input')}
          >
            <ArrowDown className='size-3 text-emerald-600' aria-hidden />
            {formatNumber(usage.input, locale)}
          </span>
          <span
            className='inline-flex items-center gap-1'
            title={t('Output Tokens')}
          >
            <ArrowUp className='size-3 text-violet-500' aria-hidden />
            {formatNumber(usage.output, locale)}
          </span>
        </div>
        <div className='flex items-center gap-1.5' data-table-text='secondary'>
          <span className='inline-flex items-center gap-1 text-sky-600 dark:text-sky-400'>
            <Database className='size-3' aria-hidden />
            {usage.cacheRead === null
              ? '—'
              : formatCompactNumber(usage.cacheRead, locale)}
          </span>
          <StatusBadge
            label={t('Cache hit: {{rate}}', {
              rate:
                usage.hitRate === null ? '—' : `${usage.hitRate.toFixed(1)}%`,
            })}
            variant={usage.hitRate && usage.hitRate > 0 ? 'success' : 'neutral'}
            size='sm'
            copyable={false}
            className={`!h-[18px] !rounded-md !px-1.5 !py-0 !text-[11px] leading-4 [&_span]:!text-[11px] ${usage.hitRate && usage.hitRate > 0 ? 'bg-emerald-500/15 !text-emerald-700 dark:!text-emerald-300' : 'bg-muted'}`}
            type='badge'
          />
        </div>
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant='ghost'
              size='icon'
              className='size-6 shrink-0 text-sky-600 dark:text-sky-400'
              aria-label={t('Token Breakdown')}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <Info className='size-3.5' />
        </PopoverTrigger>
        <PopoverContent
          side='right'
          align='start'
          className='w-72 max-w-[calc(100vw-2rem)] p-3'
          onClick={(event) => event.stopPropagation()}
        >
          <PopoverTitle>{t('Token Breakdown')}</PopoverTitle>
          <dl className='space-y-1 text-sm tabular-nums'>
            {rows.map(([label, value]) => (
              <div key={label} className='flex justify-between gap-4'>
                <dt className='text-muted-foreground'>{label}</dt>
                <dd>{value === null ? '—' : formatNumber(value, locale)}</dd>
              </div>
            ))}
            <div className='flex justify-between gap-4 border-t pt-2 font-semibold'>
              <dt>{t('Total Tokens')}</dt>
              <dd className='text-primary'>
                {formatNumber(usage.total, locale)}
              </dd>
            </div>
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  )
}
