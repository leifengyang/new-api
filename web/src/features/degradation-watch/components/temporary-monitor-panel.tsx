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
import { zodResolver } from '@hookform/resolvers/zod'
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { Plus, Timer, Square } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { formatTimestampToDate } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import {
  comparisonEfforts,
  comparisonSchema,
  newTestGroup,
  type ComparisonInput,
} from '../lib/comparison'
import {
  monitorRequest,
  temporaryProbeSchema,
  type TemporaryMonitor,
  type TemporaryProbeSettings,
} from '../lib/temporary-monitor'
import { ComparisonGroupEditor } from './comparison-group-editor'
import { TemporaryMonitorHistory } from './temporary-monitor-history'
import { TemporaryProbeFields } from './temporary-probe-controls'

export function TemporaryMonitorPanel() {
  const { t } = useTranslation()
  const statusLabels = {
    running: t('Running'),
    completed: t('Completed'),
    stopped: t('Stopped'),
  }
  const userID = useAuthStore((state) => state.auth.user?.id)
  const client = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const key = ['temporary-monitor', userID]
  const history = useInfiniteQuery({
    queryKey: [...key, 'list'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      monitorRequest<{ monitors: TemporaryMonitor[]; next_before: number }>(
        `?before=${pageParam}`
      ),
    getNextPageParam: (page) => page.next_before || undefined,
    refetchInterval: 5000,
  })
  const monitors = history.data?.pages.flatMap((page) => page.monitors) ?? []
  const id = selected ?? monitors[0]?.id
  const stop = useMutation({
    mutationFn: (monitorID: number) =>
      monitorRequest(`/${monitorID}/stop`, 'post'),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  })
  return (
    <div className='min-w-0 space-y-5'>
      <div className='flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-sky-500/5 p-4'>
        <div className='space-y-2'>
          <h3 className='flex items-center gap-2 font-semibold'>
            <Timer className='size-4 text-sky-600' />
            {t('Temporary monitoring')}
          </h3>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Monitor for 24 hours with separate schedules for text and drawing. Stops automatically.'
            )}
          </p>
          <Badge variant='secondary'>{t('Administrators only')}</Badge>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          {t('Start temporary monitoring')}
        </Button>
      </div>
      {history.isPending && <LoadingState />}
      {history.isError && <ErrorState onRetry={() => void history.refetch()} />}
      {!history.isPending && !history.isError && monitors.length === 0 && (
        <EmptyState title={t('No checks to display')} />
      )}
      {monitors.length > 0 && (
        <div className='grid min-w-0 gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]'>
          <aside className='min-w-0 space-y-2'>
            {monitors.map((monitor) => (
              <div key={monitor.id} className='min-w-0 rounded-xl border p-2'>
                <Button
                  variant={monitor.id === id ? 'secondary' : 'ghost'}
                  className='h-auto w-full justify-start p-2 text-start whitespace-normal'
                  aria-pressed={monitor.id === id}
                  onClick={() => setSelected(monitor.id)}
                >
                  <span className='min-w-0 space-y-1'>
                    <span className='block font-semibold break-all'>
                      {monitor.name}
                    </span>
                    <span className='text-muted-foreground block text-xs break-all'>
                      {monitor.model}
                    </span>
                    <span className='text-muted-foreground block text-xs'>
                      {formatTimestampToDate(monitor.created_at)}
                    </span>
                  </span>
                </Button>
                <div className='flex items-center justify-between px-2 pt-2'>
                  <Badge variant='outline'>
                    {statusLabels[monitor.status]}
                  </Badge>
                  {monitor.status === 'running' && (
                    <Button
                      variant='ghost'
                      size='sm'
                      disabled={stop.isPending}
                      onClick={() => stop.mutate(monitor.id)}
                    >
                      <Square className='size-3' />
                      {t('Stop')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {history.hasNextPage && (
              <Button
                variant='outline'
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {t('Load more')}
              </Button>
            )}
          </aside>
          {id && <TemporaryMonitorHistory key={id} monitorID={id} />}
        </div>
      )}
      {creating && (
        <CreateTemporaryMonitor
          onClose={() => setCreating(false)}
          onCreated={(monitor) => {
            setSelected(monitor.id)
            setCreating(false)
            void client.invalidateQueries({ queryKey: key })
          }}
        />
      )}
    </div>
  )
}

function CreateTemporaryMonitor(props: {
  onClose: () => void
  onCreated: (monitor: TemporaryMonitor) => void
}) {
  const { t } = useTranslation()
  const [textEffort, setTextEffort] = useState('')
  const textProbe = useForm<TemporaryProbeSettings>({
    resolver: zodResolver(temporaryProbeSchema),
    defaultValues: { enabled: true, interval_minutes: 3 },
  })
  const drawingProbe = useForm<TemporaryProbeSettings>({
    resolver: zodResolver(temporaryProbeSchema),
    defaultValues: { enabled: true, interval_minutes: 10 },
  })
  const form = useForm<ComparisonInput>({
    resolver: zodResolver(comparisonSchema),
    defaultValues: {
      groups: [{ ...newTestGroup(), effort: '' }],
      prompt: 'temporary-monitor',
      concurrency: 2,
      timeout_seconds: 1200,
    },
  })
  const group = form.watch('groups.0')
  const efforts = comparisonEfforts(group.protocol, group.model)
  const create = useMutation({
    mutationFn: (values: ComparisonInput) =>
      monitorRequest<TemporaryMonitor>('', 'post', {
        ...values.groups[0],
        text_effort: textEffort,
        drawing_effort: values.groups[0].effort,
        text_probe: textProbe.getValues(),
        drawing_probe: drawingProbe.getValues(),
      }),
    onSuccess: props.onCreated,
  })
  const submit = form.handleSubmit(async (values) => {
    const valid = await Promise.all([
      textProbe.trigger(),
      drawingProbe.trigger(),
    ])
    if (valid.some((value) => !value)) return
    if (!values.groups[0].api_key.trim() || !efforts.includes(textEffort)) {
      toast.error(t('Check the probe fields before saving'))
      return
    }
    create.mutate(values)
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) props.onClose()
      }}
      title={t('Start temporary monitoring')}
      description={t(
        'No formal channel is created. Credentials are encrypted and removed when monitoring ends; results are retained for 7 days.'
      )}
      footer={
        <Button disabled={create.isPending} onClick={() => void submit()}>
          {t('Start temporary monitoring')}
        </Button>
      }
    >
      <fieldset disabled={create.isPending} className='space-y-4'>
        <ComparisonGroupEditor
          form={form}
          index={0}
          removable={false}
          onRemove={() => {}}
          temporaryMonitor
        />
        <div className='space-y-2'>
          <Label htmlFor='temporary-text-effort'>
            {t('Probe reasoning effort')}
          </Label>
          <NativeSelect
            id='temporary-text-effort'
            value={textEffort}
            aria-invalid={!efforts.includes(textEffort)}
            onChange={(e) => setTextEffort(e.target.value)}
          >
            <NativeSelectOption value=''>{t('Default')}</NativeSelectOption>
            {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(
              (effort) => (
                <NativeSelectOption
                  key={effort}
                  value={effort}
                  disabled={!efforts.includes(effort)}
                >
                  {effort}
                </NativeSelectOption>
              )
            )}
          </NativeSelect>
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <section
            aria-label={t('Text probes')}
            className='space-y-3 rounded-lg border bg-emerald-500/5 p-3'
          >
            <h4 className='text-sm font-medium'>{t('Text probes')}</h4>
            <TemporaryProbeFields
              form={textProbe}
              disabled={create.isPending}
            />
          </section>
          <section
            aria-label={t('Drawing checks')}
            className='space-y-3 rounded-lg border bg-violet-500/5 p-3'
          >
            <h4 className='text-sm font-medium'>{t('Drawing checks')}</h4>
            <TemporaryProbeFields
              form={drawingProbe}
              disabled={create.isPending}
            />
          </section>
        </div>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Monitor for 24 hours with separate schedules for text and drawing. Stops automatically.'
          )}
        </p>
      </fieldset>
    </Dialog>
  )
}
