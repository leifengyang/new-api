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
import { useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import type { ProbePlan } from '@/features/degradation-watch/lib/probes'
import { REASONING_EFFORTS } from '@/features/degradation-watch/lib/self-test'
import type { DegradationWatchAvailableChannel } from '@/features/degradation-watch/types'
import { formatNumber } from '@/lib/format'

export function ProbeTargetFields(props: {
  form: UseFormReturn<ProbePlan>
  channels: DegradationWatchAvailableChannel[]
  groups: string[]
}) {
  const { t } = useTranslation()
  const form = props.form
  const values = useWatch({ control: form.control }) as ProbePlan
  const index = 0
  const target = values.targets[0]
  const channels = props.channels.filter((c) => c.groups.includes(target.group))
  const models =
    channels.find((c) => c.id === Number(target.channel_id))?.models ?? []
  return (
    <div className='grid gap-5'>
      <div className='flex flex-wrap items-center justify-between gap-4 rounded-lg border p-3'>
        <Label>
          <Switch
            checked={target.enabled}
            onCheckedChange={(value) =>
              form.setValue('targets.0.enabled', value, { shouldDirty: true })
            }
          />
          {t('Enable detection')}
        </Label>
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Label className='grid gap-2'>
          {t('Group')}
          <NativeSelect
            className='w-full'
            value={props.groups.includes(target.group) ? target.group : ''}
            onChange={(event) => {
              form.setValue(
                `targets.${index}`,
                {
                  ...target,
                  group: event.target.value,
                  channel_id: 0,
                  model: '',
                  public: false,
                  probes: target.probes.map((binding) => ({
                    ...binding,
                    public: false,
                  })),
                },
                { shouldDirty: true }
              )
            }}
          >
            <NativeSelectOption value=''>
              {t('Select a group')}
            </NativeSelectOption>
            {props.groups.map((group) => (
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
                  probes: target.probes.map((binding) => ({
                    ...binding,
                    public: false,
                  })),
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
              !channels.some((c) => c.id === Number(target.channel_id)) && (
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
                {
                  ...target,
                  model: event.target.value,
                  public: false,
                  probes: target.probes.map((binding) => ({
                    ...binding,
                    public: false,
                  })),
                },
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
            <NativeSelectOption value=''>{t('Default')}</NativeSelectOption>
            {REASONING_EFFORTS.map((effort) => (
              <NativeSelectOption key={effort} value={effort}>
                {effort}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
      </div>
      <div className='mt-4 grid grid-cols-1 gap-2'>
        {values.probes.map((probe) => {
          const bindingIndex = target.probes.findIndex(
            (p) => p.probe_id === probe.id
          )
          const binding = target.probes[bindingIndex]
          return (
            <div
              key={probe.id}
              data-public={binding?.public ?? target.public}
              className='bg-muted/30 flex flex-col gap-3 rounded-lg border p-3 transition-opacity data-[public=false]:opacity-50'
            >
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <Badge
                  variant='secondary'
                  className={
                    probe.kind === 'text'
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                  }
                >
                  {probe.kind === 'text' ? t('Text probe') : t('Drawing check')}
                </Badge>
                <span className='text-muted-foreground text-xs'>
                  {t('Default')}:{' '}
                  {t('Every {{minutes}} min', {
                    minutes: formatNumber(probe.interval_minutes),
                  })}
                </span>
              </div>
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
                            public: false,
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
                <Label className='flex items-center gap-2 text-xs'>
                  <Switch
                    size='sm'
                    aria-label={t('Show {{probe}} on public wall', {
                      probe: probe.name,
                    })}
                    checked={binding.public ?? target.public}
                    onCheckedChange={(value) =>
                      form.setValue(
                        `targets.${index}.probes.${bindingIndex}.public`,
                        value,
                        { shouldDirty: true }
                      )
                    }
                  />
                  <span aria-hidden='true'>{t('Show on public wall')}</span>
                </Label>
              )}
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
              {binding && probe.kind === 'text' && (
                <Label className='grid gap-2 text-xs'>
                  {t('Probe reasoning effort')}
                  <NativeSelect
                    value={binding.reasoning_effort ?? 'inherit'}
                    onChange={(event) =>
                      form.setValue(
                        `targets.${index}.probes.${bindingIndex}.reasoning_effort`,
                        event.target.value === 'inherit'
                          ? undefined
                          : (event.target.value as NonNullable<
                              typeof binding.reasoning_effort
                            >),
                        { shouldDirty: true }
                      )
                    }
                  >
                    <NativeSelectOption value='inherit'>
                      {t('Use target setting')}
                    </NativeSelectOption>
                    <NativeSelectOption value=''>
                      {t('Default')}
                    </NativeSelectOption>
                    {REASONING_EFFORTS.filter(Boolean).map((effort) => (
                      <NativeSelectOption key={effort} value={effort}>
                        {effort}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Label>
              )}
            </div>
          )
        })}
      </div>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Choose public visibility for each probe independently. Multiple channels can be shown together; users see only the group and model. Save changes before running checks.'
        )}
      </p>
    </div>
  )
}
