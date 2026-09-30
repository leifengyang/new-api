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
import {
  useFieldArray,
  type FieldValues,
  type UseFormReturn,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { REASONING_EFFORTS } from '@/features/degradation-watch/lib/self-test'
import { getModels } from '@/features/models/api'
import { getGroups } from '@/features/users/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  MAX_DEGRADATION_WATCH_TARGETS,
  type TargetValues,
} from './degradation-watch-targets'

type TargetsForm = FieldValues & { targets: TargetValues[] }

interface DegradationWatchTargetsEditorProps<T extends TargetsForm> {
  form: UseFormReturn<T>
  disabled: boolean
}

/** One row per tested model; the order here is the lane order on the wall. */
export function DegradationWatchTargetsEditor<T extends TargetsForm>(
  props: DegradationWatchTargetsEditorProps<T>
) {
  const { t } = useTranslation()
  // The generic form type keeps the section's own Values; the editor only
  // touches `targets`, so it works against that slice.
  const form = props.form as unknown as UseFormReturn<TargetsForm>
  const targets = useFieldArray({ control: form.control, name: 'targets' })
  const groups = useQuery({
    queryKey: ['degradation-watch', 'groups'],
    queryFn: async () => requireServerSuccess(await getGroups()).data ?? [],
  })
  const models = useQuery({
    queryKey: ['degradation-watch', 'models'],
    queryFn: async () => requireServerSuccess(await getModels()).data ?? [],
  })

  const groupOptions = groups.data ?? []
  const modelOptions =
    (Array.isArray(models.data)
      ? []
      : models.data?.items.map((m) => m.model_name)) ?? []
  const full = targets.fields.length >= MAX_DEGRADATION_WATCH_TARGETS

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-col gap-1'>
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

      {targets.fields.length === 0 ? (
        <p className='text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm'>
          {t('No models configured yet')}
        </p>
      ) : (
        <div className='divide-y rounded-lg border'>
          {targets.fields.map((item, index) => (
            <div
              key={item.id}
              className='flex flex-wrap items-start gap-2 px-3 py-2'
            >
              <FormField
                control={form.control}
                name={`targets.${index}.model`}
                render={({ field }) => (
                  <FormItem className='min-w-40 flex-1'>
                    <FormControl>
                      <NativeSelect
                        className='w-full'
                        aria-label={t('Model')}
                        value={field.value}
                        onChange={(event) => field.onChange(event.target.value)}
                        disabled={props.disabled}
                      >
                        {!modelOptions.includes(field.value) && field.value && (
                          <NativeSelectOption value={field.value}>
                            {field.value}
                          </NativeSelectOption>
                        )}
                        {field.value === '' && (
                          <NativeSelectOption value=''>
                            {t('Select a model')}
                          </NativeSelectOption>
                        )}
                        {modelOptions.map((model: string) => (
                          <NativeSelectOption key={model} value={model}>
                            {model}
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
                name={`targets.${index}.group`}
                render={({ field }) => (
                  <FormItem className='w-40'>
                    <FormControl>
                      <NativeSelect
                        className='w-full'
                        aria-label={t('Group')}
                        value={field.value}
                        onChange={(event) => field.onChange(event.target.value)}
                        disabled={props.disabled}
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
                name={`targets.${index}.reasoningEffort`}
                render={({ field }) => (
                  <FormItem className='w-32'>
                    <FormControl>
                      <NativeSelect
                        className='w-full'
                        aria-label={t('Reasoning effort')}
                        value={field.value}
                        onChange={(event) => field.onChange(event.target.value)}
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
              <FormField
                control={form.control}
                name={`targets.${index}.enabled`}
                render={({ field }) => (
                  <FormItem className='flex h-9 items-center'>
                    <FormControl>
                      <Switch
                        aria-label={t('Enabled')}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={props.disabled}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <div className='flex h-9 items-center gap-1'>
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
          ))}
        </div>
      )}
    </div>
  )
}
