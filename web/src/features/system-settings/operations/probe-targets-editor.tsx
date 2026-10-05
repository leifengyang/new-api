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
import { Plus, Trash2, Play } from 'lucide-react'
import { useFieldArray, useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { useRunProbes } from '@/features/degradation-watch/hooks/use-probes'
import type { ProbePlan } from '@/features/degradation-watch/lib/probes'
import { REASONING_EFFORTS } from '@/features/degradation-watch/lib/self-test'
import type { DegradationWatchAvailableChannel } from '@/features/degradation-watch/types'
import { handleServerError } from '@/lib/handle-server-error'

export function ProbeTargetsEditor(props: {
  form: UseFormReturn<ProbePlan>
  channels: DegradationWatchAvailableChannel[]
  dirty: boolean
}) {
  const { t } = useTranslation()
  const form = props.form
  const targets = useFieldArray({ control: form.control, name: 'targets' })
  const values = useWatch({ control: form.control }) as ProbePlan
  const run = useRunProbes()
  const groups = [...new Set(props.channels.flatMap((c) => c.groups))].sort()
  return (
    <div className='flex min-w-0 flex-col gap-4'>
      {targets.fields.map((field, index) => {
        const target = values.targets[index]
        const channels = props.channels.filter((c) =>
          c.groups.includes(target.group)
        )
        const models =
          channels.find((c) => c.id === Number(target.channel_id))?.models ?? []
        return (
          <section
            key={field.id}
            className='min-w-0 rounded-xl border p-4'
            aria-label={`${target.group} / ${target.model || t('New target')}`}
          >
            <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
              <Label className='flex items-center gap-2'>
                <Switch
                  checked={target.enabled}
                  onCheckedChange={(value) =>
                    form.setValue(`targets.${index}.enabled`, value, {
                      shouldDirty: true,
                    })
                  }
                />
                {t('Enable detection')}
              </Label>
              <Label className='flex items-center gap-2'>
                <Switch
                  checked={target.public}
                  onCheckedChange={(value) => {
                    values.targets.forEach((item, i) => {
                      if (
                        i === index ||
                        (value &&
                          item.group === target.group &&
                          item.model === target.model)
                      ) {
                        form.setValue(
                          `targets.${i}.public`,
                          i === index && value,
                          { shouldDirty: true }
                        )
                      }
                    })
                  }}
                />
                {t('Show on public wall')}
              </Label>
              <div className='flex gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={props.dirty || !target.enabled || run.isPending}
                  onClick={() =>
                    run.mutate(
                      {
                        group: target.group,
                        model: target.model,
                        channel_id: Number(target.channel_id),
                      },
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
                  {t('Run now')}
                </Button>
                <Button
                  type='button'
                  size='icon-sm'
                  variant='ghost'
                  aria-label={t('Remove target')}
                  onClick={() => targets.remove(index)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
              <Label className='grid gap-2'>
                {t('Group')}
                <NativeSelect
                  className='w-full'
                  value={target.group}
                  onChange={(event) => {
                    form.setValue(
                      `targets.${index}`,
                      {
                        ...target,
                        group: event.target.value,
                        channel_id: 0,
                        model: '',
                        public: false,
                      },
                      { shouldDirty: true }
                    )
                  }}
                >
                  <NativeSelectOption value=''>
                    {t('Select a group')}
                  </NativeSelectOption>
                  {[...new Set([...groups, target.group])]
                    .filter(Boolean)
                    .map((group) => (
                      <NativeSelectOption key={group} value={group}>
                        {group}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Label>
              <Label className='grid gap-2'>
                {t('Channel')}
                <NativeSelect
                  className='w-full'
                  value={target.channel_id}
                  onChange={(event) => {
                    form.setValue(
                      `targets.${index}`,
                      {
                        ...target,
                        channel_id: Number(event.target.value),
                        model: '',
                        public: false,
                      },
                      { shouldDirty: true }
                    )
                  }}
                >
                  <NativeSelectOption value={0}>
                    {t('Select a channel')}
                  </NativeSelectOption>
                  {channels.map((channel) => (
                    <NativeSelectOption key={channel.id} value={channel.id}>
                      {channel.name}
                      {channel.status !== 1 ? ` (${t('Disabled')})` : ''}
                    </NativeSelectOption>
                  ))}
                  {target.channel_id > 0 &&
                    !channels.some(
                      (c) => c.id === Number(target.channel_id)
                    ) && (
                      <NativeSelectOption value={target.channel_id}>
                        {t('Unavailable')} #{target.channel_id}
                      </NativeSelectOption>
                    )}
                </NativeSelect>
              </Label>
              <Label className='grid gap-2'>
                {t('Model')}
                <NativeSelect
                  className='w-full'
                  value={target.model}
                  onChange={(event) =>
                    form.setValue(
                      `targets.${index}`,
                      { ...target, model: event.target.value, public: false },
                      { shouldDirty: true }
                    )
                  }
                >
                  <NativeSelectOption value=''>
                    {t('Select a model')}
                  </NativeSelectOption>
                  {[...new Set([...models, target.model])]
                    .filter(Boolean)
                    .map((name) => (
                      <NativeSelectOption key={name} value={name}>
                        {name}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Label>
              <Label className='grid gap-2'>
                {t('Reasoning effort')}
                <NativeSelect
                  className='w-full'
                  {...form.register(`targets.${index}.reasoning_effort`)}
                >
                  <NativeSelectOption value=''>
                    {t('Default')}
                  </NativeSelectOption>
                  {REASONING_EFFORTS.map((effort) => (
                    <NativeSelectOption key={effort} value={effort}>
                      {effort}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
            </div>
            <div className='mt-4 grid gap-2 md:grid-cols-2'>
              {values.probes.map((probe) => {
                const bindingIndex = target.probes.findIndex(
                  (p) => p.probe_id === probe.id
                )
                const binding = target.probes[bindingIndex]
                return (
                  <div
                    key={probe.id}
                    className='bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-lg p-3'
                  >
                    <Label className='flex items-center gap-2'>
                      <Switch
                        checked={binding?.enabled ?? false}
                        onCheckedChange={(value) => {
                          if (bindingIndex < 0) {
                            form.setValue(
                              `targets.${index}.probes`,
                              [
                                ...target.probes,
                                {
                                  probe_id: probe.id,
                                  enabled: value,
                                  interval_minutes: 0,
                                },
                              ],
                              { shouldDirty: true }
                            )
                          } else {
                            form.setValue(
                              `targets.${index}.probes.${bindingIndex}.enabled`,
                              value,
                              { shouldDirty: true }
                            )
                          }
                        }}
                      />
                      {probe.name || t('New probe')}
                    </Label>
                    {binding && (
                      <Label className='text-muted-foreground flex items-center gap-2 text-xs'>
                        {t('Override interval (0 = default)')}
                        <Input
                          className='w-20'
                          type='number'
                          min={0}
                          max={1440}
                          {...form.register(
                            `targets.${index}.probes.${bindingIndex}.interval_minutes`
                          )}
                        />
                      </Label>
                    )}
                  </div>
                )
              })}
            </div>
            {form.formState.errors.targets?.[index] && (
              <p role='alert' className='text-destructive mt-2 text-sm'>
                {t('Check the target selection and public channel')}
              </p>
            )}
          </section>
        )
      })}
      <Button
        type='button'
        variant='outline'
        className='self-start'
        disabled={targets.fields.length >= 200}
        onClick={() =>
          targets.append({
            group: groups[0] ?? '',
            channel_id: 0,
            model: '',
            reasoning_effort: '',
            enabled: true,
            public: false,
            probes: values.probes.map((p) => ({
              probe_id: p.id,
              enabled: false,
              interval_minutes: 0,
            })),
          })
        }
      >
        <Plus />
        {t('Add target')}
      </Button>
    </div>
  )
}
