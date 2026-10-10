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

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import {
  beijingTime,
  fundingLabels,
  initialReportFilter,
  type ReportFilter,
} from './report-api'

export function ReportFilters(props: {
  value: ReportFilter
  onChange: (filter: ReportFilter) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(props.value)
  const date = (value: string | number | boolean | undefined, end = false) =>
    value ? beijingTime(Number(value) - (end ? 86400 : 0)).slice(0, 10) : ''
  return (
    <form
      className='bg-muted/20 space-y-4 rounded-xl border p-4'
      onSubmit={(e) => {
        e.preventDefault()
        props.onChange(draft)
      }}
    >
      <div className='flex flex-wrap items-center gap-2'>
        {[
          [t('Today'), 1],
          [t('Yesterday'), -1],
          [t('Last 7 days'), 7],
          [t('Last 30 days'), 30],
          [t('All'), 0],
        ].map(([label, days]) => (
          <Button
            type='button'
            size='sm'
            variant='outline'
            key={label}
            onClick={() => {
              const end = Number(initialReportFilter().end_at)
              const count = Number(days)
              props.onChange({
                ...props.value,
                start_at:
                  count === 0 ? 0 : end - (count === -1 ? 2 : count) * 86400,
                end_at: count === 0 ? 0 : end - (count === -1 ? 86400 : 0),
              })
            }}
          >
            {label}
          </Button>
        ))}
        <span className='text-muted-foreground text-xs'>
          {t('Beijing time')}
        </span>
      </div>
      <div className='grid gap-3 sm:grid-cols-3 xl:grid-cols-5'>
        <div className='space-y-1'>
          <Label htmlFor='report-time'>{t('Time basis')}</Label>
          <NativeSelect
            id='report-time'
            className='w-full'
            value={String(draft.time_basis)}
            onChange={(e) => setDraft({ ...draft, time_basis: e.target.value })}
          >
            <NativeSelectOption value='credited'>
              {t('Credited at')}
            </NativeSelectOption>
            <NativeSelectOption value='consumed'>
              {t('Consumed at')}
            </NativeSelectOption>
          </NativeSelect>
        </div>
        {(['start_at', 'end_at'] as const).map((key) => (
          <div className='space-y-1' key={key}>
            <Label htmlFor={`report-${key}`}>
              {key === 'start_at' ? t('Start date') : t('End date')}
            </Label>
            <Input
              id={`report-${key}`}
              type='date'
              value={date(draft[key], key === 'end_at')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  [key]: e.target.value
                    ? Date.parse(`${e.target.value}T00:00:00+08:00`) / 1000 +
                      (key === 'end_at' ? 86400 : 0)
                    : 0,
                })
              }
            />
          </div>
        ))}
        {[
          ['user', t('User ID')],
          ['channel', t('Channel ID')],
          ['group', t('Group')],
          ['model', t('Model')],
        ].map(([key, label]) => (
          <div className='space-y-1' key={key}>
            <Label htmlFor={`report-${key}`}>{label}</Label>
            <Input
              id={`report-${key}`}
              value={String(draft[key] ?? '')}
              onChange={(e) => {
                const next = { ...draft }
                delete next[key]
                if (e.target.value) next[key] = e.target.value
                setDraft(next)
              }}
            />
          </div>
        ))}
        <div className='space-y-1'>
          <Label htmlFor='report-funding'>{t('Original funding source')}</Label>
          <NativeSelect
            id='report-funding'
            className='w-full'
            value={String(draft.funding ?? 'all')}
            onChange={(e) => {
              const next = { ...draft }
              delete next.funding
              if (e.target.value !== 'all') next.funding = e.target.value
              setDraft(next)
            }}
          >
            <NativeSelectOption value='all'>{t('All')}</NativeSelectOption>
            {Object.entries(fundingLabels).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {t(label)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className='space-y-1'>
          <Label htmlFor='report-reason'>{t('Reason')}</Label>
          <NativeSelect
            id='report-reason'
            className='w-full'
            value={String(draft.reason ?? '')}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
          >
            <NativeSelectOption value=''>{t('All')}</NativeSelectOption>
            <NativeSelectOption value='client_gone'>
              client_gone
            </NativeSelectOption>
            <NativeSelectOption value='abnormal_eof'>
              {t('Abnormal EOF')}
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className='flex items-end gap-2'>
          <Button type='submit'>{t('Apply filters')}</Button>
          <Button
            type='button'
            variant='ghost'
            onClick={() => props.onChange(initialReportFilter())}
          >
            {t('Reset')}
          </Button>
        </div>
      </div>
    </form>
  )
}
