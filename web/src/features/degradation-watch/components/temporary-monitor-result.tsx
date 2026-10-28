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
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/stores/auth-store'

import {
  monitorResultSource,
  type MonitorAttempt,
} from '../lib/temporary-monitor'
import { ComparisonResult } from './comparison-results'
import { ProbeAnswerRules } from './probe-answer-rules'

export function TemporaryMonitorResult(props: { attempt: MonitorAttempt }) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
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
    enabled: props.attempt.kind === 'text',
    staleTime: active ? 0 : Infinity,
    gcTime: 2 * 60_000,
    refetchInterval: (query) => {
      const drawingStatus = query.state.data?.linked_drawing?.status
      return props.attempt.kind === 'text' &&
        (active || drawingStatus === 'queued' || drawingStatus === 'running')
        ? 1000
        : false
    },
  })
  return (
    <div className='space-y-3'>
      {props.attempt.kind === 'text' && (
        <>
          {props.attempt.verdict === 'intermediate' && (
            <section className='space-y-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3'>
              <h3 className='text-sm font-medium text-emerald-700 dark:text-emerald-300'>
                {t('Drawing triggered by this probe')}
              </h3>
              {detail.data?.linked_drawing ? (
                <TemporaryMonitorResult attempt={detail.data.linked_drawing} />
              ) : (
                !detail.isPending &&
                !detail.isError && (
                  <p className='text-muted-foreground text-xs'>
                    {t('No linked drawing is available for this record.')}
                  </p>
                )
              )}
            </section>
          )}
          {props.attempt.verdict === 'intermediate' && (
            <Badge
              variant='secondary'
              className='bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            >
              {t('Passed')}
            </Badge>
          )}
          {detail.data && (
            <ProbeAnswerRules
              expected={detail.data.expected ?? ''}
              intermediate={detail.data.intermediate_expected ?? ''}
            />
          )}
        </>
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
    </div>
  )
}
