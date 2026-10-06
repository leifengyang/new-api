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
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Plus, Timer, Square, Pencil, Trash2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
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
  temporaryPromptSchema,
  type TemporaryMonitor,
  type TemporaryProbeSettings,
} from '../lib/temporary-monitor'
import { ComparisonGroupEditor } from './comparison-group-editor'
import { TemporaryMonitorHistory } from './temporary-monitor-history'
import { TemporaryProbeFields } from './temporary-probe-controls'
import { TemporaryRewriterEditor } from './temporary-rewriter-editor'

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
  const [editing, setEditing] = useState<{
    id: number
    restart: boolean
  } | null>(null)
  const [deleting, setDeleting] = useState<TemporaryMonitor | null>(null)
  const [editingRewriter, setEditingRewriter] = useState(false)
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
  const remove = useMutation({
    mutationFn: (monitorID: number) =>
      monitorRequest(`/${monitorID}`, 'delete'),
    onSuccess: async (_, monitorID) => {
      await client.cancelQueries({ queryKey: [...key, monitorID] })
      client.setQueryData<typeof history.data>([...key, 'list'], (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                monitors: page.monitors.filter(
                  (monitor) => monitor.id !== monitorID
                ),
              })),
            }
          : data
      )
      if (id === monitorID) setSelected(null)
      setDeleting(null)
      await client.invalidateQueries({ queryKey: [...key, 'list'] })
    },
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
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' onClick={() => setEditingRewriter(true)}>
            {t('Configure rewrite model')}
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus />
            {t('Start temporary monitoring')}
          </Button>
        </div>
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
                <div className='mt-2 flex flex-wrap gap-1 border-t pt-2'>
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() =>
                      setEditing({ id: monitor.id, restart: false })
                    }
                  >
                    <Pencil className='size-3' />
                    {t('Edit configuration')}
                  </Button>
                  {(monitor.status !== 'running' ||
                    monitor.ends_at <= Date.now() / 1000) && (
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() =>
                        setEditing({ id: monitor.id, restart: true })
                      }
                    >
                      <RotateCcw className='size-3' />
                      {t('Restart monitoring')}
                    </Button>
                  )}
                  <Button
                    variant='ghost'
                    size='sm'
                    className='text-muted-foreground hover:text-destructive'
                    onClick={() => setDeleting(monitor)}
                  >
                    <Trash2 className='size-3' />
                    {t('Delete')}
                  </Button>
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
      {editingRewriter && (
        <TemporaryRewriterEditor onClose={() => setEditingRewriter(false)} />
      )}
      {editing && (
        <EditTemporaryMonitor
          key={editing.id}
          monitorID={editing.id}
          restart={editing.restart}
          onClose={() => setEditing(null)}
          onCreated={(monitor) => {
            setSelected(monitor.id)
            setEditing(null)
            void client.invalidateQueries({ queryKey: key })
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null)
        }}
        title={t('Delete temporary monitor?')}
        desc={
          <div className='space-y-2'>
            <p className='font-medium break-all'>{deleting?.name}</p>
            <p>
              {t(
                'This stops monitoring and permanently deletes all its text and drawing results. This cannot be undone.'
              )}
            </p>
          </div>
        }
        destructive
        confirmText={t('Delete')}
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (deleting) remove.mutate(deleting.id)
        }}
      />
    </div>
  )
}

function EditTemporaryMonitor(props: {
  monitorID: number
  restart: boolean
  onClose: () => void
  onCreated: (monitor: TemporaryMonitor) => void
}) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const configuration = useQuery({
    queryKey: ['temporary-monitor', userID, props.monitorID, 'configuration'],
    queryFn: () =>
      monitorRequest<TemporaryMonitor>(`/${props.monitorID}/configuration`),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  if (configuration.isPending || configuration.isError) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose()
        }}
        title={t('Edit configuration')}
      >
        {configuration.isError ? (
          <ErrorState onRetry={() => void configuration.refetch()} />
        ) : (
          <LoadingState />
        )}
      </Dialog>
    )
  }
  return <CreateTemporaryMonitor {...props} monitor={configuration.data} />
}

function CreateTemporaryMonitor(props: {
  onClose: () => void
  onCreated: (monitor: TemporaryMonitor) => void
  monitor?: TemporaryMonitor
  restart?: boolean
}) {
  const { t } = useTranslation()
  const monitor = props.monitor
  const active =
    monitor?.status === 'running' && monitor.ends_at > Date.now() / 1000
  const [textEffort, setTextEffort] = useState(monitor?.text_effort ?? '')
  const [textPrompt, setTextPrompt] = useState(monitor?.text_prompt ?? '')
  const [expected, setExpected] = useState(monitor?.text_expected ?? '')
  const [drawingPrompt, setDrawingPrompt] = useState(
    monitor?.drawing_prompt ?? ''
  )
  const textProbe = useForm<TemporaryProbeSettings>({
    resolver: zodResolver(temporaryProbeSchema),
    defaultValues: {
      enabled: !monitor?.text_disabled,
      interval_minutes: monitor?.text_interval_minutes || 3,
    },
  })
  const drawingProbe = useForm<TemporaryProbeSettings>({
    resolver: zodResolver(temporaryProbeSchema),
    defaultValues: {
      enabled: !monitor?.drawing_disabled,
      interval_minutes: monitor?.drawing_interval_minutes || 10,
    },
  })
  const form = useForm<ComparisonInput>({
    resolver: zodResolver(comparisonSchema),
    defaultValues: {
      groups: [
        {
          ...newTestGroup(),
          effort: monitor?.drawing_effort ?? '',
          ...(monitor
            ? {
                name: monitor.name,
                base_url: monitor.base_url,
                model: monitor.model,
                protocol: monitor.protocol,
                max_output_tokens: monitor.max_output_tokens ?? 32768,
                has_saved_key: monitor.has_saved_key ?? false,
              }
            : {}),
        },
      ],
      prompt: 'temporary-monitor',
      concurrency: 2,
      timeout_seconds: 1200,
    },
  })
  const group = form.watch('groups.0')
  const efforts = comparisonEfforts(group.protocol, group.model)
  const create = useMutation({
    mutationFn: ({
      values,
      restart,
    }: {
      values: ComparisonInput
      restart: boolean
    }) =>
      monitorRequest<TemporaryMonitor>(
        monitor ? `/${monitor.id}` : '',
        monitor ? 'put' : 'post',
        {
          ...values.groups[0],
          text_effort: textEffort,
          drawing_effort: values.groups[0].effort,
          text_probe: textProbe.getValues(),
          drawing_probe: drawingProbe.getValues(),
          ...(monitor
            ? {
                text_prompt: textPrompt,
                text_expected: expected,
                drawing_prompt: drawingPrompt,
                restart,
              }
            : {}),
        }
      ),
    onSuccess: props.onCreated,
  })
  const submit = (restart = false) =>
    form.handleSubmit(async (values) => {
      const valid = await Promise.all([
        textProbe.trigger(),
        drawingProbe.trigger(),
      ])
      if (valid.some((value) => !value)) return
      if (
        ((!monitor || active || restart) &&
          !values.groups[0].api_key.trim() &&
          !values.groups[0].has_saved_key) ||
        !efforts.includes(textEffort) ||
        (monitor &&
          (!temporaryPromptSchema.safeParse({ prompt: textPrompt, expected })
            .success ||
            !expected.trim() ||
            !temporaryPromptSchema.safeParse({
              prompt: drawingPrompt,
              expected: '',
            }).success))
      ) {
        toast.error(t('Check the probe fields before saving'))
        return
      }
      create.mutate({ values, restart })
    })()
  let title = t('Start temporary monitoring')
  let submitLabel = title
  let description = t(
    'No formal channel is created. Credentials are encrypted and removed when monitoring ends; results are retained for 7 days.'
  )
  if (monitor) {
    title = props.restart ? t('Restart monitoring') : t('Edit configuration')
    submitLabel = props.restart ? t('Save and restart') : t('Save')
    description = active
      ? t(
          'Saved changes apply to subsequent checks. Running checks and historical inputs stay unchanged.'
        )
      : t(
          'Restart keeps historical results and starts a new 24-hour period. Enter the API key again to restart.'
        )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) props.onClose()
      }}
      title={title}
      description={description}
      footer={
        <>
          {monitor && !active && !props.restart && (
            <Button
              disabled={create.isPending}
              variant='outline'
              onClick={() => void submit(true)}
            >
              {t('Save and restart')}
            </Button>
          )}
          <Button
            disabled={create.isPending}
            onClick={() => void submit(!!props.restart)}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <fieldset disabled={create.isPending} className='space-y-4'>
        <ComparisonGroupEditor
          form={form}
          index={0}
          removable={false}
          onRemove={() => {}}
          temporaryMonitor
          loadModels={
            monitor
              ? (group) =>
                  monitorRequest<string[]>(
                    `/${monitor.id}/models`,
                    'post',
                    group
                  )
              : undefined
          }
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
        {monitor && (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='monitor-text-prompt'>
                {t('Text probe prompt')}
              </Label>
              <Textarea
                id='monitor-text-prompt'
                className='min-h-28'
                value={textPrompt}
                maxLength={20000}
                onChange={(event) => setTextPrompt(event.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='monitor-expected'>{t('Expected answer')}</Label>
              <Textarea
                id='monitor-expected'
                value={expected}
                maxLength={2000}
                onChange={(event) => setExpected(event.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='monitor-drawing-prompt'>
                {t('Drawing probe prompt')}
              </Label>
              <Textarea
                id='monitor-drawing-prompt'
                className='min-h-36'
                value={drawingPrompt}
                maxLength={20000}
                onChange={(event) => setDrawingPrompt(event.target.value)}
              />
            </div>
          </div>
        )}
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
