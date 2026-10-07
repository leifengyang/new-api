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
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'

export function ProbeAnswerRules(props: {
  expected: string
  intermediate: string
  match?: string
}) {
  const { t } = useTranslation()
  return (
    <section
      className='space-y-3 rounded-xl border p-3'
      aria-label={t('Answer matching')}
    >
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='min-w-0 rounded-lg bg-emerald-500/5 p-3'>
          <Badge
            variant='secondary'
            className='bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          >
            {t('Expected answer')}
          </Badge>
          <pre className='mt-2 max-h-32 overflow-auto text-sm break-all whitespace-pre-wrap'>
            {props.expected}
          </pre>
        </div>
        {props.intermediate && (
          <div className='min-w-0 rounded-lg bg-blue-500/5 p-3'>
            <Badge
              variant='secondary'
              className='bg-blue-500/10 text-blue-700 dark:text-blue-300'
            >
              {t('Blue answer (intermediate)')}
            </Badge>
            <pre className='mt-2 max-h-32 overflow-auto text-sm break-all whitespace-pre-wrap'>
              {props.intermediate}
            </pre>
          </div>
        )}
      </div>
      <p className='text-muted-foreground text-xs'>
        {props.match === 'contains'
          ? t('Contains answer')
          : t('Exact match (trim whitespace)')}
      </p>
      {props.intermediate && (
        <p className='text-muted-foreground text-xs'>
          {t(
            'Blue results are counted separately. Unmatched answers are red; request errors are exceptions.'
          )}
        </p>
      )}
    </section>
  )
}
