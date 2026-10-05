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
import { Plus, Trash2, Play, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useFieldArray, useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
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
import { handleServerError } from '@/lib/handle-server-error'

import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { ProbeTargetsEditor } from './probe-targets-editor'

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
  const probes = useFieldArray({
    control: form.control,
    name: 'probes',
    keyName: 'fieldKey',
  })
  const plan = form.watch()
  const save = useSaveProbePlan()
  const run = useRunProbes()
  const activity = useDegradationWatchActivity()
  const [configured, setConfigured] = useState(
    props.initial.configured !== false
  )
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
  return (
    <SettingsSection title={t('Degradation Watch')}>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Text probes match configured answers. Drawing checks validate HTML and SVG, not artistic quality. Upstream requests may incur charges.'
        )}
      </p>
      <form onSubmit={submit} className='flex min-w-0 flex-col gap-5'>
        <SettingsPageFormActions
          onSave={submit}
          isSaving={busy}
          isSaveDisabled={!dirty}
          saveLabel='Save degradation watch settings'
        />
        <fieldset disabled={busy} className='flex min-w-0 flex-col gap-5'>
          <div className='flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4'>
            <Label className='flex items-center gap-3'>
              {t('Enable degradation watch')}
              <Switch
                checked={plan.enabled}
                onCheckedChange={(value) =>
                  form.setValue('enabled', value, { shouldDirty: true })
                }
              />
            </Label>
            <Button
              type='button'
              variant='outline'
              disabled={dirty || run.isPending}
              onClick={() =>
                run.mutate(
                  {},
                  {
                    onSuccess: () =>
                      toast.success(
                        t(
                          'Check queued. Follow live progress here or on the wall.'
                        )
                      ),
                    onError: (error) => handleServerError(error),
                  }
                )
              }
            >
              <Play />
              {t('Run all checks')}
            </Button>
          </div>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Label className='grid gap-2'>
              {t('Concurrent requests per test type')}
              <Input
                type='number'
                min={1}
                max={32}
                {...form.register('concurrency')}
              />
            </Label>
            <Label className='grid gap-2'>
              {t('Request timeout (seconds)')}
              <Input
                type='number'
                min={30}
                max={3600}
                {...form.register('timeout_seconds')}
              />
            </Label>
          </div>
          <div className='flex items-center justify-between gap-2'>
            <h3 className='font-semibold'>{t('Probe templates')}</h3>
            <Button
              type='button'
              variant='outline'
              disabled={probes.fields.length >= 20}
              onClick={() =>
                probes.append({
                  id: crypto.randomUUID(),
                  name: '',
                  kind: 'text',
                  prompt: '',
                  expected: '',
                  match: 'exact',
                  interval_minutes: 5,
                })
              }
            >
              <Plus />
              {t('Add probe')}
            </Button>
          </div>
          {probes.fields.map((probe, index) => (
            <section
              key={probe.fieldKey}
              className='bg-muted/20 grid min-w-0 gap-4 rounded-xl border p-4'
              aria-label={probe.name || t('New probe')}
            >
              <div className='grid gap-3 sm:grid-cols-[1fr_10rem_10rem_auto]'>
                <Label className='grid gap-2'>
                  {t('Name')}
                  <Input {...form.register(`probes.${index}.name`)} />
                </Label>
                <Label className='grid gap-2'>
                  {t('Test type')}
                  <NativeSelect {...form.register(`probes.${index}.kind`)}>
                    <NativeSelectOption value='text'>
                      {t('Text probe')}
                    </NativeSelectOption>
                    <NativeSelectOption value='drawing'>
                      {t('Drawing check')}
                    </NativeSelectOption>
                  </NativeSelect>
                </Label>
                <Label className='grid gap-2'>
                  {t('Interval (minutes)')}
                  <Input
                    type='number'
                    min={1}
                    max={1440}
                    {...form.register(`probes.${index}.interval_minutes`)}
                  />
                </Label>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label={t('Remove')}
                  onClick={() => {
                    const id = plan.probes[index].id
                    probes.remove(index)
                    form.setValue(
                      'targets',
                      plan.targets.map((target) => ({
                        ...target,
                        probes: target.probes.filter((p) => p.probe_id !== id),
                      })),
                      { shouldDirty: true }
                    )
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              <Label className='grid gap-2'>
                {t('Prompt')}
                <Textarea
                  className='min-h-24'
                  {...form.register(`probes.${index}.prompt`)}
                />
              </Label>
              {plan.probes[index].kind === 'text' && (
                <div className='grid gap-3 sm:grid-cols-[1fr_12rem]'>
                  <Label className='grid gap-2'>
                    {t('Expected answer')}
                    <Input {...form.register(`probes.${index}.expected`)} />
                  </Label>
                  <Label className='grid gap-2'>
                    {t('Answer matching')}
                    <NativeSelect {...form.register(`probes.${index}.match`)}>
                      <NativeSelectOption value='exact'>
                        {t('Exact match (trim whitespace)')}
                      </NativeSelectOption>
                      <NativeSelectOption value='contains'>
                        {t('Contains answer')}
                      </NativeSelectOption>
                    </NativeSelect>
                  </Label>
                </div>
              )}
              {form.formState.errors.probes?.[index] && (
                <p role='alert' className='text-destructive text-sm'>
                  {t('Check the probe fields before saving')}
                </p>
              )}
            </section>
          ))}
          <div className='flex items-center justify-between gap-2'>
            <h3 className='font-semibold'>
              {t('Groups, channels and models')}
            </h3>
            <Button type='button' variant='ghost' onClick={props.onRefresh}>
              <RefreshCw />
              {t('Refresh')}
            </Button>
          </div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Only one channel per group and model is public. Users see the group and model only. Save changes before running checks.'
            )}
          </p>
          <ProbeTargetsEditor
            form={form}
            channels={props.channels}
            dirty={dirty}
          />
          <p className='text-muted-foreground text-xs'>
            {t(
              'Detection records and their content are automatically deleted after 7 days. Errors and timeouts are excluded from the pass rate.'
            )}
          </p>
        </fieldset>
      </form>
      {activity.data?.task && (
        <div
          className='bg-muted/30 rounded-xl border p-3 text-sm'
          aria-live='polite'
        >
          <span>{t('Latest detection tasks')}: </span>
          {activity.data.task.status === 'pending'
            ? t('Queued')
            : t(
                activity.data.task.status === 'running'
                  ? 'Running'
                  : 'Completed'
              )}
          {activity.data.task.error && (
            <pre className='mt-2 max-h-40 overflow-auto text-xs whitespace-pre-wrap'>
              {activity.data.task.error}
            </pre>
          )}
        </div>
      )}
      <ProbeWall />
    </SettingsSection>
  )
}
