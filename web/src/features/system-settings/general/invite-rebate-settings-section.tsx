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
import { useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import { SafeNumberInput } from '../utils/numeric-field'
import {
  MAX_INVITE_REBATE_RATE_BASIS_POINTS,
  basisPointsToPercent,
  formatInviteRebatePercent,
  percentToBasisPoints,
} from './invite-rebate-rate'

const ratePercent = z.coerce
  .number()
  .min(0)
  .max(MAX_INVITE_REBATE_RATE_BASIS_POINTS / 100)

const schema = z.object({
  enabled: z.boolean(),
  /** 内部学员的直属下线充值，返给该内部学员。 */
  directPercent: ratePercent,
  /** 外部用户的直属下线充值，返给该外部用户。 */
  externalPercent: ratePercent,
  /** 外部用户的直属下线充值，再返给其上层第一个内部学员。 */
  uplinePercent: ratePercent,
})

type Values = z.infer<typeof schema>

type InviteRebateSettingsSectionProps = {
  defaultValues: {
    enabled: boolean
    rateBasisPoints: number
    externalRateBasisPoints: number
    internalReferrerRateBasisPoints: number
  }
}

/**
 * 三个比例各自对应一条腿，`key` 是落库的选项名，`field` 是表单字段。
 * 顺序就是产品口径里的①②③，改这里也请顺手看一眼后端
 * setting/operation_setting/invite_rebate_setting.go。
 */
const RATE_FIELDS = [
  {
    key: 'invite_rebate_setting.rate_basis_points',
    field: 'directPercent',
    defaultKey: 'rateBasisPoints',
    label: 'Internal member rate (%)',
    description:
      'Share of every top-up made by an internal member’s direct invitees that goes back to that member.',
  },
  {
    key: 'invite_rebate_setting.external_rate_basis_points',
    field: 'externalPercent',
    defaultKey: 'externalRateBasisPoints',
    label: 'External user rate (%)',
    description:
      'Share of every top-up made by an external user’s direct invitees that goes back to that user.',
  },
  {
    key: 'invite_rebate_setting.internal_referrer_rate_basis_points',
    field: 'uplinePercent',
    defaultKey: 'internalReferrerRateBasisPoints',
    label: 'Upline member rate (%)',
    description:
      'Extra share of every top-up made by an external user’s direct invitees that goes to the first internal member above that user.',
  },
] as const satisfies ReadonlyArray<{
  key: string
  field: keyof Values
  defaultKey: keyof InviteRebateSettingsSectionProps['defaultValues']
  label: string
  description: string
}>

export function InviteRebateSettingsSection(
  props: InviteRebateSettingsSectionProps
) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const form = useForm<Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Values>,
    defaultValues: {
      enabled: props.defaultValues.enabled,
      directPercent: basisPointsToPercent(props.defaultValues.rateBasisPoints),
      externalPercent: basisPointsToPercent(
        props.defaultValues.externalRateBasisPoints
      ),
      uplinePercent: basisPointsToPercent(
        props.defaultValues.internalReferrerRateBasisPoints
      ),
    },
  })

  const { isDirty, isSubmitting } = form.formState
  const enabled = form.watch('enabled')

  async function onSubmit(values: Values) {
    const updates: Array<{ key: string; value: string }> = []

    if (values.enabled !== props.defaultValues.enabled) {
      updates.push({
        key: 'invite_rebate_setting.enabled',
        value: String(values.enabled),
      })
    }

    for (const rate of RATE_FIELDS) {
      const basisPoints = percentToBasisPoints(values[rate.field])
      if (basisPoints !== props.defaultValues[rate.defaultKey]) {
        updates.push({ key: rate.key, value: String(basisPoints) })
      }
    }

    if (updates.length === 0) {
      toast.info(t('No changes to save'))
      return
    }

    for (const update of updates) {
      await updateOption.mutateAsync(update)
    }

    form.reset(values)
  }

  return (
    <SettingsSection title={t('Invite Rebate')}>
      <Alert>
        <AlertDescription>
          {t(
            'The registration-time inviter and invitee rewards were replaced by this rebate. Every top-up pays up to two people: the direct inviter of the paying user, and — when that inviter is an external user — the first internal member above them. Administrators never earn a rebate.'
          )}
        </AlertDescription>
      </Alert>

      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)} autoComplete='off'>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending || isSubmitting}
            isSaveDisabled={!isDirty}
            saveLabel='Save invite rebate settings'
          />
          <FormField
            control={form.control}
            name='enabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Enable invite rebate')}</FormLabel>
                  <FormDescription>
                    {t(
                      'Credit the inviter automatically whenever an invited user tops up'
                    )}
                  </FormDescription>
                </SettingsSwitchContent>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={updateOption.isPending || isSubmitting}
                  />
                </FormControl>
              </SettingsSwitchItem>
            )}
          />

          {enabled &&
            RATE_FIELDS.map((rate) => (
              <FormField
                key={rate.field}
                control={form.control}
                name={rate.field}
                render={({ field }) => {
                  const basisPoints = percentToBasisPoints(field.value)
                  return (
                    <FormItem>
                      <FormLabel>{t(rate.label)}</FormLabel>
                      <FormControl>
                        <SafeNumberInput
                          field={field}
                          min={0}
                          max={MAX_INVITE_REBATE_RATE_BASIS_POINTS / 100}
                          step={0.01}
                          disabled={updateOption.isPending || isSubmitting}
                        />
                      </FormControl>
                      <FormDescription>
                        {t(rate.description)}{' '}
                        {t(
                          'Currently {{rate}} ({{basisPoints}} basis points). Set to 0 to stop paying that leg without changing who is an internal member.',
                          {
                            rate: formatInviteRebatePercent(basisPoints),
                            basisPoints: String(basisPoints),
                          }
                        )}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )
                }}
              />
            ))}
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
