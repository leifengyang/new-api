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
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import {
  intermediateAnswer,
  type ProbePlan,
} from '@/features/degradation-watch/lib/probes'

export function ProbeTemplateFields({
  form,
}: {
  form: UseFormReturn<ProbePlan>
}) {
  const { t } = useTranslation()
  const plan = useWatch({ control: form.control }) as ProbePlan
  const index = 0
  return (
    <div className='grid gap-5'>
      <div className='grid gap-3 sm:grid-cols-2'>
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
      </div>
      <Label className='grid gap-2'>
        {t('Prompt')}
        <Textarea
          className='min-h-24'
          {...form.register(`probes.${index}.prompt`)}
        />
      </Label>
      {plan.probes[index].kind === 'text' && (
        <div className='grid gap-3 sm:grid-cols-2'>
          <Label className='grid gap-2'>
            {t('Expected answer')}
            <Input {...form.register(`probes.${index}.expected`)} />
          </Label>
          <Label className='grid gap-2 text-blue-700 dark:text-blue-300'>
            {t('Blue answer (intermediate)')}
            <Controller
              control={form.control}
              name={`probes.${index}.intermediate_expected`}
              render={({ field }) => (
                <Input
                  {...field}
                  value={
                    field.value ??
                    intermediateAnswer(plan.probes[index].expected)
                  }
                  maxLength={2000}
                />
              )}
            />
          </Label>
          <p className='text-muted-foreground text-xs sm:col-span-2'>
            {t(
              'Green matches the expected answer; blue is counted separately; other answers are red. Leave blue blank to disable it.'
            )}
          </p>
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
    </div>
  )
}
