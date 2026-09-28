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
import { Play } from 'lucide-react'
import { useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  useDegradationWatchChannels,
  useRunDegradationWatch,
} from '@/features/degradation-watch/hooks/use-degradation-watch'
import {
  DEGRADATION_WATCH_ALIAS_KEY,
  parseAliases,
  serializeAliases,
} from '@/features/degradation-watch/lib/aliases'
import { REASONING_EFFORTS } from '@/features/degradation-watch/lib/self-test'
import { formatTimestampToDate } from '@/lib/format'

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

/** Bounds mirror setting/operation_setting/degradation_watch_setting.go. */
const schema = z.object({
  enabled: z.boolean(),
  group: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string(),
  intervalMinutes: z.coerce.number().int().min(1).max(1440),
  timeoutSeconds: z.coerce.number().int().min(30).max(3600),
  retentionPerChannel: z.coerce.number().int().min(1).max(2000),
  prompt: z.string().max(20000),
})

type Values = z.infer<typeof schema>

const OPTION_KEYS = {
  enabled: 'degradation_watch_setting.enabled',
  group: 'degradation_watch_setting.group',
  model: 'degradation_watch_setting.model',
  reasoningEffort: 'degradation_watch_setting.reasoning_effort',
  intervalMinutes: 'degradation_watch_setting.interval_minutes',
  timeoutSeconds: 'degradation_watch_setting.timeout_seconds',
  retentionPerChannel: 'degradation_watch_setting.retention_per_channel',
  prompt: 'degradation_watch_setting.prompt',
} as const satisfies Record<keyof Values, string>

type DegradationWatchSettingsSectionProps = {
  defaultValues: Values
  /** The stored `channel_aliases` JSON object, channel id → alias. */
  aliasesJson: string
}

export function DegradationWatchSettingsSection(
  props: DegradationWatchSettingsSectionProps
) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const form = useForm<Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Values>,
    defaultValues: props.defaultValues,
  })
  const { isDirty, isSubmitting } = form.formState
  const busy = updateOption.isPending || isSubmitting

  async function onSubmit(values: Values) {
    const updates: Array<{ key: string; value: string }> = []
    for (const field of Object.keys(OPTION_KEYS) as Array<keyof Values>) {
      if (values[field] !== props.defaultValues[field]) {
        updates.push({ key: OPTION_KEYS[field], value: String(values[field]) })
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

          <SettingsFormGrid>
            <FormField
              control={form.control}
              name='group'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Group')}</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={busy} />
                  </FormControl>
                  <FormDescription>
                    {t('Only channels in this group are tested')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='model'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Model')}</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={busy} />
                  </FormControl>
                  <FormDescription>
                    {t('Channels without this model are skipped')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='reasoningEffort'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Reasoning effort')}</FormLabel>
                  <FormControl>
                    <NativeSelect
                      className='w-full'
                      value={field.value}
                      onChange={(event) => field.onChange(event.target.value)}
                      disabled={busy}
                    >
                      {REASONING_EFFORTS.map((value) => (
                        <NativeSelectOption key={value} value={value}>
                          {value === '' ? t('Not sent') : value}
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
                  <FormLabel>{t('Run timeout (seconds)')}</FormLabel>
                  <FormControl>
                    <SafeNumberInput
                      field={field}
                      min={30}
                      max={3600}
                      disabled={busy}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('Covers a whole run across all channels')}
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
                  <FormLabel>{t('Attempts kept per channel')}</FormLabel>
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
                      'Older attempts, hidden ones included, are removed; the success rate covers what is kept'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsFormGrid>

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

      <ChannelAliasList aliasesJson={props.aliasesJson} />
    </SettingsSection>
  )
}

interface ChannelAliasListProps {
  aliasesJson: string
}

function ChannelAliasList(props: ChannelAliasListProps) {
  const { t } = useTranslation()
  const channels = useDegradationWatchChannels()
  const updateOption = useUpdateOption()
  const run = useRunDegradationWatch()
  const [saved] = useState(() => parseAliases(props.aliasesJson))
  const [aliases, setAliases] = useState(saved)
  const dirty = serializeAliases(aliases) !== serializeAliases(saved)

  async function saveAliases() {
    await updateOption.mutateAsync({
      key: DEGRADATION_WATCH_ALIAS_KEY,
      value: serializeAliases(aliases),
    })
  }

  let body = <p className='text-muted-foreground text-sm'>{t('Loading...')}</p>
  if (channels.isError) {
    body = (
      <p className='text-destructive text-sm'>{t('Failed to load channels')}</p>
    )
  } else if (channels.data && channels.data.channels.length === 0) {
    body = (
      <p className='text-muted-foreground text-sm'>
        {t('No channels in group {{group}}', { group: channels.data.group })}
      </p>
    )
  } else if (channels.data) {
    body = (
      <div className='divide-y rounded-lg border'>
        {channels.data.channels.map((channel) => (
          <div
            key={channel.id}
            className='flex flex-wrap items-center gap-3 px-3 py-2'
          >
            <div className='flex min-w-40 flex-1 flex-col'>
              <span className='text-sm font-medium'>
                #{channel.id} {channel.name}
              </span>
              <span className='text-muted-foreground text-xs'>
                {t('Last run')}: {formatTimestampToDate(channel.last_record_at)}
              </span>
            </div>
            {!channel.eligible && (
              <Badge variant='outline'>
                {channel.has_model ? t('Disabled') : t('Model not offered')}
              </Badge>
            )}
            <Input
              className='w-48'
              placeholder={t('Alias (blank = hidden)')}
              value={aliases[String(channel.id)] ?? ''}
              onChange={(event) =>
                setAliases((current) => ({
                  ...current,
                  [String(channel.id)]: event.target.value,
                }))
              }
            />
            <Button
              variant='outline'
              size='sm'
              disabled={!channel.eligible || run.isPending}
              onClick={() => run.mutate(channel.id)}
            >
              <Play />
              {t('Run once now')}
            </Button>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-col gap-1'>
          <h4 className='text-sm font-semibold'>{t('Channels and aliases')}</h4>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Only channels with an alias appear on the wall, under that alias. Unaliased channels are still tested and visible to admins.'
            )}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            disabled={run.isPending}
            onClick={() => run.mutate(undefined)}
          >
            <Play />
            {t('Run all now')}
          </Button>
          <Button
            disabled={!dirty || updateOption.isPending}
            onClick={() => void saveAliases()}
          >
            {t('Save aliases')}
          </Button>
        </div>
      </div>
      {body}
    </div>
  )
}
