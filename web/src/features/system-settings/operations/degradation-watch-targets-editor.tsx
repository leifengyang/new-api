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
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useFieldArray, useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { FieldSet } from '@/components/ui/field'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { REASONING_EFFORTS } from '@/features/degradation-watch/lib/self-test'
import type { DegradationWatchAvailableChannel } from '@/features/degradation-watch/types'
import { getGroups } from '@/features/users/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import type { DegradationWatchValues } from './degradation-watch-settings-section'
import {
  getTargetModels,
  MAX_DEGRADATION_WATCH_TARGETS,
} from './degradation-watch-targets'

interface DegradationWatchTargetsEditorProps {
  form: UseFormReturn<DegradationWatchValues>
  channels: DegradationWatchAvailableChannel[]
  disabled: boolean
}

/** Options and channel previews both follow the current draft, before saving. */
export function DegradationWatchTargetsEditor(
  props: DegradationWatchTargetsEditorProps
) {
  const { t } = useTranslation()
  const form = props.form
  const targets = useFieldArray({ control: form.control, name: 'targets' })
  const values = useWatch({ control: form.control, name: 'targets' })
  const groups = useQuery({
    queryKey: ['degradation-watch', 'groups'],
    queryFn: async () => requireServerSuccess(await getGroups()).data ?? [],
    staleTime: 0,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  })
  const groupOptions = [
    ...new Set([
      ...(groups.data ?? []),
      ...props.channels.flatMap((channel) => channel.groups),
    ]),
  ].sort()
  const full = targets.fields.length >= MAX_DEGRADATION_WATCH_TARGETS

  return (
    <section
      className='flex min-w-0 flex-col gap-3'
      aria-label={t('Models to test')}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 flex-col gap-1'>
          <h4 className='text-sm font-semibold'>{t('Models to test')}</h4>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Each enabled model is tested on every channel of its group that offers it. The order here is the column order on the wall.'
            )}
          </p>
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={props.disabled || full}
          onClick={() =>
            targets.append({
              model: '',
              group: groupOptions[0] ?? '',
              reasoningEffort: 'medium',
              enabled: true,
            })
          }
        >
          <Plus />
          {t('Add model')}
        </Button>
      </div>
      {targets.fields.length === 0 && (
        <EmptyState
          className='min-h-32'
          bordered
          title={t('No models configured yet')}
        />
      )}
      {(form.formState.errors.targets?.message ||
        form.formState.errors.targets?.root?.message) && (
        <p role='alert' className='text-destructive text-sm'>
          {t('Add at least one model to test')}
        </p>
      )}
      {targets.fields.map((item, index) => {
        const target = values[index] ?? item
        const modelOptions = getTargetModels(props.channels, target.group)
        const unavailable =
          target.model !== '' && !modelOptions.includes(target.model)
        return (
          <FieldSet
            key={item.id}
            className='min-w-0 gap-4 rounded-xl border p-4'
          >
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <FormField
                control={form.control}
                name={`targets.${index}.enabled`}
                render={({ field }) => (
                  <FormItem className='flex items-center gap-3'>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={props.disabled}
                      />
                    </FormControl>
                    <FormLabel>{t('Enabled')}</FormLabel>
                  </FormItem>
                )}
              />
              <div className='flex items-center gap-1'>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={t('Move up')}
                  disabled={props.disabled || index === 0}
                  onClick={() => targets.move(index, index - 1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={t('Move down')}
                  disabled={
                    props.disabled || index === targets.fields.length - 1
                  }
                  onClick={() => targets.move(index, index + 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={t('Remove')}
                  disabled={props.disabled}
                  onClick={() => targets.remove(index)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <div className='grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]'>
              <FormField
                control={form.control}
                name={`targets.${index}.group`}
                render={({ field }) => (
                  <FormItem className='min-w-0'>
                    <FormLabel>{t('Group')}</FormLabel>
                    <FormControl>
                      <NativeSelect
                        {...field}
                        className='w-full'
                        disabled={props.disabled}
                        onChange={(event) => {
                          const group = event.target.value
                          field.onChange(group)
                          if (
                            !getTargetModels(props.channels, group).includes(
                              target.model
                            )
                          ) {
                            form.setValue(`targets.${index}.model`, '', {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }
                        }}
                      >
                        {!groupOptions.includes(field.value) && (
                          <NativeSelectOption value={field.value}>
                            {field.value || t('Select a group')}
                          </NativeSelectOption>
                        )}
                        {groupOptions.map((group) => (
                          <NativeSelectOption key={group} value={group}>
                            {group}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`targets.${index}.model`}
                render={({ field }) => (
                  <FormItem className='min-w-0'>
                    <FormLabel>{t('Model')}</FormLabel>
                    <FormControl>
                      <NativeSelect
                        {...field}
                        className='w-full'
                        disabled={props.disabled || modelOptions.length === 0}
                      >
                        <NativeSelectOption value=''>
                          {modelOptions.length === 0
                            ? t('No available models in this group')
                            : t('Select a model')}
                        </NativeSelectOption>
                        {unavailable && (
                          <NativeSelectOption value={field.value} disabled>
                            {field.value}
                          </NativeSelectOption>
                        )}
                        {modelOptions.map((model) => (
                          <NativeSelectOption key={model} value={model}>
                            {model}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </FormControl>
                    {unavailable && (
                      <p className='text-destructive text-xs' role='status'>
                        {t('This model is unavailable in the selected group')}
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`targets.${index}.reasoningEffort`}
                render={({ field }) => (
                  <FormItem className='min-w-0'>
                    <FormLabel>{t('Reasoning effort')}</FormLabel>
                    <FormControl>
                      <NativeSelect
                        {...field}
                        className='w-full'
                        disabled={props.disabled}
                      >
                        {REASONING_EFFORTS.map((value) => (
                          <NativeSelectOption key={value} value={value}>
                            {value === '' ? t('Not sent') : value}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          </FieldSet>
        )
      })}
    </section>
  )
}
