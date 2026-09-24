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

const schema = z.object({
  enabled: z.boolean(),
  ratePercent: z.coerce
    .number()
    .min(0)
    .max(MAX_INVITE_REBATE_RATE_BASIS_POINTS / 100),
})

type Values = z.infer<typeof schema>

type InviteRebateSettingsSectionProps = {
  defaultValues: {
    enabled: boolean
    rateBasisPoints: number
  }
}

export function InviteRebateSettingsSection(
  props: InviteRebateSettingsSectionProps
) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const form = useForm<Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Values>,
    defaultValues: {
      enabled: props.defaultValues.enabled,
      ratePercent: basisPointsToPercent(props.defaultValues.rateBasisPoints),
    },
  })

  const { isDirty, isSubmitting } = form.formState
  const enabled = form.watch('enabled')
  const ratePercent = form.watch('ratePercent')

  async function onSubmit(values: Values) {
    const rateBasisPoints = percentToBasisPoints(values.ratePercent)
    const updates: Array<{ key: string; value: string }> = []

    if (values.enabled !== props.defaultValues.enabled) {
      updates.push({
        key: 'invite_rebate_setting.enabled',
        value: String(values.enabled),
      })
    }

    if (rateBasisPoints !== props.defaultValues.rateBasisPoints) {
      updates.push({
        key: 'invite_rebate_setting.rate_basis_points',
        value: String(rateBasisPoints),
      })
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
            'The registration-time inviter and invitee rewards were replaced by this rebate. Only internal members earn it, and only from the top-ups of the users they invited directly.'
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

          {enabled && (
            <FormField
              control={form.control}
              name='ratePercent'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Rebate rate (%)')}</FormLabel>
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
                    {t(
                      'Share of each top-up credited to the inviter. Currently {{rate}} ({{basisPoints}} basis points). Set to 0 to stop paying without changing who is an internal member.',
                      {
                        rate: formatInviteRebatePercent(
                          percentToBasisPoints(ratePercent)
                        ),
                        basisPoints: String(percentToBasisPoints(ratePercent)),
                      }
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
