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
import { Activity } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { Progress } from '@/components/ui/progress'

import type { DegradationWatchRecord } from '../types'
import { RecordPlayerDialog } from './artwork-player-dialog'
import { RecordCard } from './record-card'

export function DegradationWatchActivity(props: {
  data?: {
    task: { status: string; error: string } | null
    records: DegradationWatchRecord[]
  }
  loading: boolean
  error: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<DegradationWatchRecord | null>(null)
  if (props.error) {
    return (
      <ErrorState
        title={t('Failed to load the degradation watch')}
        onRetry={props.onRetry}
      />
    )
  }
  if (!props.loading && !props.data?.task) return null
  const records = props.data?.records ?? []
  const completed = records.filter(
    (record) => record.status !== 'queued' && record.status !== 'running'
  ).length
  return (
    <div className='bg-muted/20 space-y-3 rounded-xl border p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2 text-sm font-medium'>
        <span className='flex items-center gap-2'>
          <Activity className='size-4 text-sky-600 dark:text-sky-400' />
          {t('Latest detection tasks')}
        </span>
        <span className='text-muted-foreground text-xs'>
          {t('{{done}} / {{total}} completed', {
            done: completed,
            total: records.length,
          })}
        </span>
      </div>
      <Progress
        value={records.length ? (completed / records.length) * 100 : 0}
        aria-label={t('Detection progress')}
      />
      {records.length === 0 && props.data?.task?.status !== 'failed' && (
        <p className='text-muted-foreground text-sm'>
          {t('Waiting for an available worker')}
        </p>
      )}
      {props.data?.task?.error && (
        <pre className='text-destructive text-xs break-all whitespace-pre-wrap'>
          {props.data.task.error}
        </pre>
      )}
      <div className='grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3'>
        {records.map((record) => (
          <RecordCard
            key={record.id}
            record={record}
            title={`${record.model_name} · ${record.channel_title}`}
            onOpen={setSelected}
          />
        ))}
      </div>
      <RecordPlayerDialog
        record={selected}
        title={selected?.channel_title ?? ''}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}
