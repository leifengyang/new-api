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
import { Play, Settings2, Activity, FileText, Layers } from 'lucide-react'
import { useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ProbeWall } from '@/features/degradation-watch/components/probe-wall'
import {
  useDegradationWatchChannels,
  useDegradationWatchActivity,
} from '@/features/degradation-watch/hooks/use-degradation-watch'
import {
  useProbePlan,
  useSaveProbePlan,
  useRunProbes,
} from '@/features/degradation-watch/hooks/use-probes'
import {
  probePlanSchema,
  type ProbePlan,
} from '@/features/degradation-watch/lib/probes'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { ProbeRuntimeDialog } from './probe-runtime-dialog'
import { ProbeTargetsEditor } from './probe-targets-editor'
import { ProbeTemplatesEditor } from './probe-templates-editor'

export function ProbeSettingsSection() {
  const { t } = useTranslation()
  const plan = useProbePlan()
  const channels = useDegradationWatchChannels()
  if (plan.isPending || channels.isPending) return <LoadingState />
  if (!plan.data || !channels.data) {
    return (
      <ErrorState
        title={t('Failed to load channels')}
        onRetry={() => {
          void plan.refetch()
          void channels.refetch()
        }}
      />
    )
  }
  return (
    <ProbeSettingsForm
      initial={plan.data}
      channels={channels.data.available_channels}
      onRefresh={() => void channels.refetch()}
    />
  )
}

function ProbeSettingsForm(props: {
  initial: ProbePlan & { configured?: boolean }
  channels: NonNullable<
    ReturnType<typeof useDegradationWatchChannels>['data']
  >['available_channels']
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const form = useForm<ProbePlan>({
    defaultValues: props.initial,
    resolver: zodResolver(probePlanSchema) as Resolver<ProbePlan>,
  })
  const plan = form.watch()
  const save = useSaveProbePlan()
  const run = useRunProbes()
  const [configured, setConfigured] = useState(
    props.initial.configured !== false
  )
  const [tab, setTab] = useState('targets')
  const [runtime, setRuntime] = useState(false)
  const [revision, setRevision] = useState(0)
  const dirty = form.formState.isDirty || !configured
  const busy = save.isPending || form.formState.isSubmitting
  const submit = form.handleSubmit(
    async (values) => {
      try {
        await save.mutateAsync(values)
        form.reset(values)
        setConfigured(true)
        toast.success(t('Setting updated successfully'))
      } catch (error) {
        handleServerError(error)
      }
    },
    () => toast.error(t('Check the probe fields before saving'))
  )
  const reset = () => {
    form.reset()
    setRevision((value) => value + 1)
  }
  return (
    <SettingsSection title={t('Degradation Watch')}>
      <SettingsPageFormActions
        onSave={submit}
        onReset={reset}
        isSaving={busy}
        isSaveDisabled={!dirty}
        isResetDisabled={!form.formState.isDirty}
        saveLabel='Save degradation watch settings'
      />
      <div className='bg-muted/20 flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4'>
        <div className='space-y-2'>
          <Label className='flex items-center gap-3'>
            <Switch
              disabled={busy}
              checked={plan.enabled}
              onCheckedChange={(value) =>
                form.setValue('enabled', value, { shouldDirty: true })
              }
            />
            {t('Enable degradation watch')}
          </Label>
          <p className='text-muted-foreground text-xs'>
            {t('Concurrency {{concurrency}} / timeout {{seconds}} s', {
              concurrency: formatNumber(plan.concurrency),
              seconds: formatNumber(plan.timeout_seconds),
            })}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {dirty && (
            <Badge
              variant='secondary'
              className='bg-amber-500/10 text-amber-700 dark:text-amber-300'
            >
              {t('Unsaved changes')}
            </Badge>
          )}
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={() => setRuntime(true)}
          >
            <Settings2 />
            {t('Runtime settings')}
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={dirty || busy || run.isPending}
            onClick={() =>
              run.mutate(
                {},
                {
                  onSuccess: () => {
                    toast.success(
                      t(
                        'Check queued. Follow live progress here or on the wall.'
                      )
                    )
                    setTab('records')
                  },
                  onError: (error) => handleServerError(error),
                }
              )
            }
          >
            <Play />
            {t('Run all checks')}
          </Button>
        </div>
      </div>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Text probes match configured answers. Drawing checks validate HTML and SVG, not artistic quality. Upstream requests may incur charges.'
        )}
      </p>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className='min-w-0 gap-5'
      >
        <TabsList variant='line' className='h-10 w-full justify-start border-b'>
          <TabsTrigger value='targets' className='flex-none px-3'>
            <Layers />
            {t('Detection targets')}
          </TabsTrigger>
          <TabsTrigger value='templates' className='flex-none px-3'>
            <FileText />
            {t('Probe templates')}
          </TabsTrigger>
          <TabsTrigger value='records' className='flex-none px-3'>
            <Activity />
            {t('Run history')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value='targets'>
          <fieldset disabled={busy} className='min-w-0'>
            <ProbeTargetsEditor
              key={revision}
              form={form}
              channels={props.channels}
              dirty={dirty}
              onRefresh={props.onRefresh}
            />
          </fieldset>
        </TabsContent>
        <TabsContent value='templates'>
          <fieldset disabled={busy} className='min-w-0'>
            <ProbeTemplatesEditor key={revision} form={form} />
          </fieldset>
        </TabsContent>
        <TabsContent value='records'>
          {tab === 'records' && <ProbeRunHistory />}
        </TabsContent>
      </Tabs>
      <p className='text-muted-foreground border-t pt-4 text-xs'>
        {t(
          'Detection records and their content are automatically deleted after 7 days. Errors and timeouts are excluded from the pass rate.'
        )}
      </p>
      {runtime && (
        <ProbeRuntimeDialog
          plan={plan}
          onClose={() => setRuntime(false)}
          onApply={(values) => {
            form.setValue('concurrency', values.concurrency, {
              shouldDirty: true,
            })
            form.setValue('timeout_seconds', values.timeout_seconds, {
              shouldDirty: true,
            })
            setRuntime(false)
          }}
        />
      )}
    </SettingsSection>
  )
}

function ProbeRunHistory() {
  const { t } = useTranslation()
  const activity = useDegradationWatchActivity()
  let status = t('Completed')
  if (activity.data?.task?.status === 'pending') status = t('Queued')
  if (activity.data?.task?.status === 'running') status = t('Running')
  if (activity.data?.task?.error) status = t('Failed')
  return (
    <div className='space-y-4'>
      {activity.isError && (
        <ErrorState onRetry={() => void activity.refetch()} />
      )}
      {activity.data?.task && (
        <div
          className='bg-muted/30 rounded-xl border p-3 text-sm'
          aria-live='polite'
        >
          <span>{t('Latest detection tasks')}: </span>
          {status}
          {activity.data.task.error && (
            <pre className='mt-2 max-h-40 overflow-auto text-xs whitespace-pre-wrap'>
              {activity.data.task.error}
            </pre>
          )}
        </div>
      )}
      <ProbeWall />
    </div>
  )
}
