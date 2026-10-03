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
import { useMutation } from '@tanstack/react-query'
import { Download, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Controller, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { PasswordInput } from '@/components/password-input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import { comparisonRequest, type ComparisonInput } from '../lib/comparison'

export function ComparisonGroupEditor(props: {
  form: UseFormReturn<ComparisonInput>
  index: number
  removable: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const prefix = `groups.${props.index}` as const
  const [models, setModels] = useState<string[]>([])
  const group = props.form.watch(prefix)
  const fetchModels = useMutation({
    mutationFn: () =>
      comparisonRequest<string[]>(
        '/models',
        'post',
        props.form.getValues(prefix)
      ),
    onSuccess: setModels,
  })
  return (
    <section className='bg-card min-w-0 rounded-xl border p-4 shadow-xs'>
      <div className='mb-4 flex items-center gap-2'>
        <Badge variant='outline' className='bg-primary/5 text-primary'>
          {props.index + 1}
        </Badge>
        <Label className='sr-only' htmlFor={`${id}-name`}>
          {t('Group name')}
        </Label>
        <Input
          id={`${id}-name`}
          placeholder={t('Group name')}
          {...props.form.register(`${prefix}.name`)}
          className='focus-visible:border-input h-8 border-transparent font-medium shadow-none'
        />
        <Button
          type='button'
          variant='ghost'
          size='icon'
          disabled={!props.removable}
          aria-label={t('Remove group')}
          onClick={props.onRemove}
        >
          <Trash2 className='size-4' />
        </Button>
      </div>
      <div className='grid gap-3'>
        <div className='space-y-1.5'>
          <Label htmlFor={`${id}-url`}>{t('Base URL')}</Label>
          <Input
            id={`${id}-url`}
            placeholder='https://api.example.com/v1'
            {...props.form.register(`${prefix}.base_url`, {
              onChange: () => {
                props.form.setValue(`${prefix}.has_saved_key`, false)
                setModels([])
              },
            })}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor={`${id}-key`}>{t('API key')}</Label>
          <PasswordInput
            id={`${id}-key`}
            autoComplete='off'
            placeholder={
              group.has_saved_key ? t('Saved key available') : 'sk-...'
            }
            {...props.form.register(`${prefix}.api_key`)}
          />
        </div>
        <Controller
          control={props.form.control}
          name={`${prefix}.remember_key`}
          render={({ field }) => (
            <Label className='text-muted-foreground flex items-center gap-2 text-xs'>
              <Checkbox
                checked={field.value}
                onCheckedChange={field.onChange}
              />
              {t('Save key encrypted for reuse')}
            </Label>
          )}
        />
        <div className='grid grid-cols-2 gap-3'>
          <div className='space-y-1.5'>
            <Label htmlFor={`${id}-protocol`}>{t('Protocol')}</Label>
            <NativeSelect
              id={`${id}-protocol`}
              {...props.form.register(`${prefix}.protocol`, {
                onChange: (event) => {
                  props.form.setValue(`${prefix}.has_saved_key`, false)
                  setModels([])
                  if (event.target.value === 'anthropic') {
                    props.form.setValue(`${prefix}.effort`, '')
                  }
                },
              })}
            >
              <NativeSelectOption value='chat'>
                Chat Completions
              </NativeSelectOption>
              <NativeSelectOption value='responses'>
                Responses
              </NativeSelectOption>
              <NativeSelectOption value='anthropic'>
                Anthropic Messages
              </NativeSelectOption>
            </NativeSelect>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor={`${id}-effort`}>{t('Reasoning effort')}</Label>
            <NativeSelect
              id={`${id}-effort`}
              disabled={group.protocol === 'anthropic'}
              {...props.form.register(`${prefix}.effort`)}
            >
              <NativeSelectOption value=''>{t('Default')}</NativeSelectOption>
              {['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(
                (value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}
                  </NativeSelectOption>
                )
              )}
            </NativeSelect>
          </div>
        </div>
        {group.protocol === 'anthropic' && (
          <p className='text-muted-foreground text-xs leading-relaxed'>
            {t('Anthropic uses model-default thinking.')}
          </p>
        )}
        <div className='space-y-1.5'>
          <Label htmlFor={`${id}-output-limit`}>
            {t('Maximum output tokens')}
          </Label>
          <Input
            id={`${id}-output-limit`}
            type='number'
            min={1}
            max={1073741823}
            step={1}
            {...props.form.register(`${prefix}.max_output_tokens`, {
              valueAsNumber: true,
            })}
          />
          <p className='text-muted-foreground text-xs leading-relaxed'>
            {t(
              'Default: 32,768. Increase for long output; the model and channel may impose a lower limit.'
            )}
          </p>
          {props.form.formState.errors.groups?.[props.index]
            ?.max_output_tokens && (
            <p role='alert' className='text-destructive text-xs'>
              {t('Enter a whole number between 1 and 1,073,741,823.')}
            </p>
          )}
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor={`${id}-model`}>{t('Model')}</Label>
          <div className='flex gap-2'>
            <Input
              id={`${id}-model`}
              placeholder={t('Enter model name')}
              {...props.form.register(`${prefix}.model`)}
            />
            <Button
              type='button'
              variant='outline'
              size='icon'
              disabled={
                fetchModels.isPending ||
                !group.base_url ||
                (!group.api_key && !group.has_saved_key)
              }
              aria-label={t('Fetch models')}
              title={t('Fetch models')}
              onClick={() => fetchModels.mutate()}
            >
              <Download className='size-4' />
            </Button>
          </div>
        </div>
        {models.length > 0 && (
          <NativeSelect
            aria-label={t('Fetched models')}
            value=''
            onChange={(event) =>
              props.form.setValue(`${prefix}.model`, event.target.value, {
                shouldValidate: true,
              })
            }
          >
            <NativeSelectOption value=''>
              {t('Select a model')}
            </NativeSelectOption>
            {models.map((model) => (
              <NativeSelectOption key={model} value={model}>
                {model}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {props.form.formState.errors.groups?.[props.index] && (
          <p role='alert' className='text-destructive text-xs'>
            {t('Complete the group name, HTTPS URL and model.')}
          </p>
        )}
      </div>
    </section>
  )
}
