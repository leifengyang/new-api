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
import { useQueryClient } from '@tanstack/react-query'
import { useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FieldSet, FieldLegend } from '@/components/ui/field'
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
import { Textarea } from '@/components/ui/textarea'
import { useDegradationWatchChannels } from '@/features/degradation-watch/hooks/use-degradation-watch'
import {
  DEGRADATION_WATCH_ALIAS_KEY,
  parseAliases,
  serializeAliases,
} from '@/features/degradation-watch/lib/aliases'

import {
  SettingsForm,
  SettingsFormGrid,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import { SafeNumberInput } from '../utils/numeric-field'
import { DegradationWatchChannelList } from './degradation-watch-channel-list'
import {
  findDuplicateTarget,
  MAX_DEGRADATION_WATCH_TARGETS,
  serializeTargets,
  targetSchema,
} from './degradation-watch-targets'
import { DegradationWatchTargetsEditor } from './degradation-watch-targets-editor'

/** Bounds mirror setting/operation_setting/degradation_watch_setting.go. */
const schema = z
  .object({
    enabled: z.boolean(),
    targets: z
      .array(targetSchema)
      .min(1, 'Add at least one model to test')
      .max(MAX_DEGRADATION_WATCH_TARGETS),
    aliases: z.record(z.string(), z.string().default('')),
    intervalMinutes: z.coerce.number().int().min(1).max(1440),
    timeoutSeconds: z.coerce.number().int().min(30).max(3600),
    retentionPerChannel: z.coerce.number().int().min(1).max(2000),
    concurrency: z.coerce.number().int().min(1).max(32),
    prompt: z.string().max(20000),
  })
  .superRefine((values, ctx) => {
    const duplicate = findDuplicateTarget(values.targets)
    if (duplicate >= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets', duplicate, 'model'],
        message: 'Each model can only be listed once',
      })
    }
  })

export type DegradationWatchValues = z.infer<typeof schema>
type Values = DegradationWatchValues
type ScalarField = Exclude<keyof Values, 'targets' | 'aliases'>

const OPTION_KEYS = {
  enabled: 'degradation_watch_setting.enabled',
  intervalMinutes: 'degradation_watch_setting.interval_minutes',
  timeoutSeconds: 'degradation_watch_setting.timeout_seconds',
  retentionPerChannel: 'degradation_watch_setting.retention_per_channel',
  concurrency: 'degradation_watch_setting.concurrency',
  prompt: 'degradation_watch_setting.prompt',
} as const satisfies Record<ScalarField, string>

const TARGETS_KEY = 'degradation_watch_setting.targets'

type DegradationWatchSettingsSectionProps = {
  defaultValues: Omit<Values, 'aliases'>
  /** The stored `channel_aliases` JSON object, channel id → alias. */
  aliasesJson: string
}

export function DegradationWatchSettingsSection(
  props: DegradationWatchSettingsSectionProps
) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const queryClient = useQueryClient()
  const channels = useDegradationWatchChannels()

  const form = useForm<Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Values>,
    defaultValues: {
      ...props.defaultValues,
      aliases: parseAliases(props.aliasesJson),
    },
  })
  const { isDirty, isSubmitting } = form.formState
  const busy = updateOption.isPending || isSubmitting

  async function onSubmit(values: Values) {
    const saved = form.formState.defaultValues
    const updates: Array<{ key: string; value: string }> = []
    // Targets go first so a run triggered right after saving already sees them.
    const targets = serializeTargets(values.targets)
    if (
      targets !== serializeTargets((saved?.targets ?? []) as Values['targets'])
    ) {
      updates.push({ key: TARGETS_KEY, value: targets })
    }
    for (const field of Object.keys(OPTION_KEYS) as ScalarField[]) {
      if (values[field] !== saved?.[field]) {
        updates.push({ key: OPTION_KEYS[field], value: String(values[field]) })
      }
    }
    if (
      serializeAliases(values.aliases) !==
      serializeAliases((saved?.aliases as Values['aliases']) ?? {})
    ) {
      updates.push({
        key: DEGRADATION_WATCH_ALIAS_KEY,
        value: serializeAliases(values.aliases),
      })
    }
    if (updates.length === 0) {
      toast.info(t('No changes to save'))
      return
    }
    try {
      for (const update of updates) {
        await updateOption.mutateAsync(update)
      }
    } catch {
      // useUpdateOption reports the failure; retain the draft for retry.
      return
    }
    form.reset(values)
    await queryClient.invalidateQueries({ queryKey: ['degradation-watch'] })
  }

  return (
    <SettingsSection title={t('Degradation Watch')}>
      <Alert>
        <AlertDescription>
          {t(
            'On every run each enabled channel in the group that offers the model is asked the same prompt; the resulting HTML animations appear on the Degradation Watch page. Requests go to the upstream directly: no quota is deducted and no usage log is written, but the upstream still bills them.'
          )}
        </AlertDescription>
      </Alert>

      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)} autoComplete='off'>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={busy}
            isSaveDisabled={!isDirty}
            saveLabel='Save degradation watch settings'
          />
          <FormField
            control={form.control}
            name='enabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Enable degradation watch')}</FormLabel>
                  <FormDescription>
                    {t('Run the check on a schedule')}
                  </FormDescription>
                </SettingsSwitchContent>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={busy}
                  />
                </FormControl>
              </SettingsSwitchItem>
            )}
          />

          {channels.isError ? (
            <ErrorState
              className='min-h-32'
              title={t('Failed to load channels')}
              onRetry={() => void channels.refetch()}
            />
          ) : null}
          {channels.isPending && <LoadingState className='min-h-32' />}
          <DegradationWatchTargetsEditor
            form={form}
            channels={channels.data?.available_channels ?? []}
            disabled={busy || channels.isPending || channels.isError}
          />
          <DegradationWatchChannelList
            form={form}
            data={channels.data}
            busy={busy}
            unavailable={channels.isPending || channels.isError}
            refreshing={channels.isFetching}
            onRefresh={() => void channels.refetch()}
          />

          <FieldSet className='min-w-0 rounded-xl border p-4'>
            <FieldLegend>{t('Run parameters')}</FieldLegend>

            <SettingsFormGrid>
              <FormField
                control={form.control}
                name='intervalMinutes'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Interval (minutes)')}</FormLabel>
                    <FormControl>
                      <SafeNumberInput
                        field={field}
                        min={1}
                        max={1440}
                        disabled={busy}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='timeoutSeconds'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Request timeout (seconds)')}</FormLabel>
                    <FormControl>
                      <SafeNumberInput
                        field={field}
                        min={30}
                        max={3600}
                        disabled={busy}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('Applies to each drawing request on its own')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='concurrency'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Concurrent requests')}</FormLabel>
                    <FormControl>
                      <SafeNumberInput
                        field={field}
                        min={1}
                        max={32}
                        disabled={busy}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('Shared by all models and channels in a round')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='retentionPerChannel'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t('Attempts kept per channel and model')}
                    </FormLabel>
                    <FormControl>
                      <SafeNumberInput
                        field={field}
                        min={1}
                        max={2000}
                        disabled={busy}
                      />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'Attempts beyond this limit or older than 7 days are deleted, including hidden attempts and their content. Running checks are kept until they finish.'
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </SettingsFormGrid>
          </FieldSet>

          <FormField
            control={form.control}
            name='prompt'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Prompt')}</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    className='min-h-48 font-mono text-xs'
                    disabled={busy}
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'Leave empty to use the built-in prompt. Changing it makes new artwork incomparable with older artwork.'
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
