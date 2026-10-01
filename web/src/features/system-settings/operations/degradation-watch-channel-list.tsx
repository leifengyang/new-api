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
import { Play, RefreshCw } from 'lucide-react'
import { useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { DegradationWatchActivity } from '@/features/degradation-watch/components/watch-activity'
import {
  useDegradationWatchActivity,
  useRunDegradationWatch,
} from '@/features/degradation-watch/hooks/use-degradation-watch'
import type { DegradationWatchChannels } from '@/features/degradation-watch/types'
import { formatTimestampToDate } from '@/lib/format'

import type { DegradationWatchValues } from './degradation-watch-settings-section'

interface DegradationWatchChannelListProps {
  form: UseFormReturn<DegradationWatchValues>
  data: DegradationWatchChannels | undefined
  busy: boolean
  unavailable: boolean
  refreshing: boolean
  onRefresh: () => void
}

export function DegradationWatchChannelList(
  props: DegradationWatchChannelListProps
) {
  const { t } = useTranslation()
  const run = useRunDegradationWatch()
  const activity = useDegradationWatchActivity()
  const taskActive =
    activity.data?.task?.status === 'pending' ||
    activity.data?.task?.status === 'running'
  const targets = useWatch({ control: props.form.control, name: 'targets' })
  const channels = (props.data?.available_channels ?? [])
    .filter((channel) =>
      targets.some((target) => channel.groups.includes(target.group))
    )
    .map((channel) => ({
      ...channel,
      targets: targets.filter(
        (target) =>
          channel.status === 1 &&
          channel.groups.includes(target.group) &&
          channel.models.some((model) => model.trim() === target.model.trim())
      ),
    }))
  const dirty = props.form.formState.isDirty
  const runDisabled =
    props.busy || props.unavailable || dirty || run.isPending || taskActive
  const hasEnabledTarget = channels.some((channel) =>
    channel.targets.some((target) => target.enabled)
  )

  return (
    <section
      className='flex min-w-0 flex-col gap-3'
      aria-label={t('Channels and aliases')}
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex min-w-0 flex-col gap-1'>
          <h4 className='text-sm font-semibold'>{t('Channels and aliases')}</h4>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Channels follow the selected groups and refresh every 15 seconds.'
            )}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Only channels with an alias appear on the wall, under that alias. Unaliased channels are still tested and visible to admins.'
            )}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={props.refreshing}
            onClick={props.onRefresh}
          >
            <RefreshCw />
            {t('Refresh')}
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={runDisabled || !hasEnabledTarget}
            onClick={() => run.mutate({})}
          >
            <Play />
            {t('Run all now')}
          </Button>
        </div>
      </div>
      <DegradationWatchActivity
        data={activity.data}
        loading={run.isPending}
        error={activity.isError}
        onRetry={() => void activity.refetch()}
      />
      {dirty && (
        <Alert>
          <AlertDescription>
            {t(
              'Save your changes before running a check. Channel aliases are saved with these settings.'
            )}
          </AlertDescription>
        </Alert>
      )}
      {!props.unavailable && channels.length === 0 && (
        <EmptyState
          className='min-h-32'
          bordered
          title={t('No channels in the groups of the configured models')}
        />
      )}
      {!props.unavailable && channels.length > 0 && (
        <div className='min-w-0 divide-y rounded-xl border'>
          {channels.map((channel) => {
            const saved = props.data?.channels.find(
              (item) => item.id === channel.id
            )
            return (
              <div
                key={channel.id}
                className='grid min-w-0 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
              >
                <div className='flex min-w-0 flex-col gap-1'>
                  <span className='text-sm font-medium break-words'>
                    #{channel.id} {channel.name}
                  </span>
                  <div className='flex flex-wrap items-center gap-2'>
                    <Badge
                      variant={channel.status === 1 ? 'secondary' : 'outline'}
                    >
                      {channel.status === 1 ? t('Enabled') : t('Disabled')}
                    </Badge>
                    {channel.targets.length === 0 && (
                      <Badge variant='outline'>
                        {t('No configured model can run')}
                      </Badge>
                    )}
                  </div>
                  {saved && (
                    <span className='text-muted-foreground text-xs'>
                      {t('Last run')}:{' '}
                      {formatTimestampToDate(saved.last_record_at)}
                    </span>
                  )}
                </div>
                <FormField
                  control={props.form.control}
                  name={`aliases.${channel.id}`}
                  render={({ field }) => (
                    <FormItem className='min-w-0'>
                      <FormLabel>
                        {t('Alias')} #{channel.id}
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ''}
                          placeholder={t('Alias (blank = hidden)')}
                          disabled={props.busy}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <div className='flex min-w-0 flex-wrap gap-2 lg:col-span-2'>
                  {[
                    ...new Set(channel.targets.map((target) => target.model)),
                  ].map((model) => (
                    <Button
                      key={model}
                      type='button'
                      variant='outline'
                      size='sm'
                      className='max-w-full'
                      disabled={runDisabled}
                      aria-label={t('Run {{model}} on this channel now', {
                        model,
                      })}
                      onClick={() =>
                        run.mutate({
                          model,
                          channelId: channel.id,
                        })
                      }
                    >
                      <Play />
                      <span className='truncate'>{model}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
