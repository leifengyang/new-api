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
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'

import { SettingsForm } from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

/** 与服务端 maxEnterpriseMemberLimit 对齐：超过这个数的提交会被服务端夹回去。 */
const ENTERPRISE_MEMBER_LIMIT_MAX = 10000

const enterpriseSchema = z.object({
  // 0 或负数会让所有企业立刻建不了号，服务端对非法值一律退回默认值；这里先拦。
  EnterpriseMemberLimit: z
    .number()
    .int()
    .min(1)
    .max(ENTERPRISE_MEMBER_LIMIT_MAX),
})

type EnterpriseFormValues = z.output<typeof enterpriseSchema>
type EnterpriseFormInput = z.input<typeof enterpriseSchema>

type NormalizedEnterpriseValues = {
  EnterpriseMemberLimit: number
}

type EnterpriseSectionProps = {
  defaultValues: NormalizedEnterpriseValues
}

const buildFormDefaults = (
  defaults: EnterpriseSectionProps['defaultValues']
): EnterpriseFormInput => ({
  EnterpriseMemberLimit: defaults.EnterpriseMemberLimit,
})

export function EnterpriseSection({ defaultValues }: EnterpriseSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const form = useForm<EnterpriseFormInput, unknown, EnterpriseFormValues>({
    resolver: zodResolver(enterpriseSchema),
    mode: 'onChange',
    defaultValues: buildFormDefaults(defaultValues),
  })

  useEffect(() => {
    form.reset(buildFormDefaults(defaultValues))
  }, [defaultValues, form])

  const onSubmit = async (values: EnterpriseFormValues) => {
    const key = 'EnterpriseMemberLimit' as const
    if (values[key] !== defaultValues[key]) {
      await updateOption.mutateAsync({ key, value: values[key] })
    }
  }

  return (
    <SettingsSection title={t('Enterprise')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
            saveLabel='Save enterprise limits'
          />
          <FormField
            control={form.control}
            name='EnterpriseMemberLimit'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Members per enterprise')}</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    min={1}
                    max={ENTERPRISE_MEMBER_LIMIT_MAX}
                    step={1}
                    {...field}
                    onChange={(e) =>
                      field.onChange(Number.parseInt(e.target.value) || 1)
                    }
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'Maximum number of members one enterprise account can hold. Default 100, maximum 10000. Lowering it never removes anyone, but an enterprise at or over the limit cannot add members until it drops back under it.'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
