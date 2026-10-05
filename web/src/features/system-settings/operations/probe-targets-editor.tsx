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
import { Plus, Play, RefreshCw, Layers, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { StaticDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useRunProbes } from '@/features/degradation-watch/hooks/use-probes'
import type {
  ProbePlan,
  ProbeTarget,
} from '@/features/degradation-watch/lib/probes'
import type { DegradationWatchAvailableChannel } from '@/features/degradation-watch/types'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import { ProbeTargetDrawer } from './probe-target-drawer'

export function ProbeTargetsEditor(props: {
  form: UseFormReturn<ProbePlan>
  channels: DegradationWatchAvailableChannel[]
  groups: string[]
  dirty: boolean
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const { form } = props
  const plan = useWatch({ control: form.control }) as ProbePlan
  const run = useRunProbes()
  const [group, setGroup] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{
    index: number
    target: ProbeTarget
  } | null>(null)
  const groups = [...new Set(props.groups)].sort()
  const selected = group && groups.includes(group) ? group : groups[0]
  const rows = plan.targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => target.group === selected)
  const models = [...new Set(rows.map(({ target }) => target.model))].sort()
  return (
    <div className='grid min-w-0 gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]'>
      <aside className='bg-muted/20 min-w-0 self-start rounded-xl border p-3'>
        <p className='mb-3 flex items-center gap-2 px-1 text-sm font-semibold'>
          <Layers className='size-4' />
          {t('Group')}
        </p>
        <Input
          aria-label={t('Search groups')}
          placeholder={t('Search groups')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div
          className='mt-3 flex max-h-80 gap-1 overflow-auto lg:flex-col'
          aria-label={t('Group')}
        >
          {groups
            .filter((name) => name.toLowerCase().includes(search.toLowerCase()))
            .map((name) => (
              <Button
                key={name}
                type='button'
                variant={name === selected ? 'secondary' : 'ghost'}
                aria-pressed={name === selected}
                className='h-auto min-h-9 justify-between gap-3 lg:w-full'
                onClick={() => setGroup(name)}
              >
                <span className='truncate'>{name}</span>
                <span className='text-muted-foreground text-xs'>
                  {formatNumber(
                    plan.targets.filter((target) => target.group === name)
                      .length
                  )}
                </span>
              </Button>
            ))}
          {!groups.some((name) =>
            name.toLowerCase().includes(search.toLowerCase())
          ) && (
            <p className='text-muted-foreground p-2 text-sm'>
              {t('No results found')}
            </p>
          )}
        </div>
      </aside>
      <div className='min-w-0 space-y-4'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0'>
            <h3 className='font-semibold break-all'>
              {selected || t('Detection targets')}
            </h3>
            <p className='text-muted-foreground mt-1 text-xs'>
              {t(
                'Only one channel per group and model is public. Users see the group and model only. Save changes before running checks.'
              )}
            </p>
          </div>
          <div className='flex shrink-0 gap-2'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={props.onRefresh}
            >
              <RefreshCw />
              {t('Refresh')}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={plan.targets.length >= 200 || groups.length === 0}
              onClick={() =>
                setEditing({
                  index: -1,
                  target: {
                    group: selected ?? '',
                    channel_id: 0,
                    model: '',
                    reasoning_effort: '',
                    enabled: true,
                    public: false,
                    probes: [],
                  },
                })
              }
            >
              <Plus />
              {t('Add target')}
            </Button>
          </div>
        </div>
        {models.length === 0 && (
          <EmptyState
            icon={Layers}
            title={t('No detection targets')}
            description={t(
              'Add a channel and model, then choose the probes to run.'
            )}
          />
        )}
        {models.map((model) => (
          <Collapsible
            key={model}
            defaultOpen
            className='overflow-hidden rounded-xl border'
          >
            <CollapsibleTrigger className='bg-muted/25 flex w-full items-center gap-2 p-3 text-left text-sm font-semibold'>
              <ChevronDown className='size-4' />
              <span className='min-w-0 break-all'>{model}</span>
              <Badge variant='secondary' className='ml-auto'>
                {formatNumber(
                  rows.filter((row) => row.target.model === model).length
                )}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <StaticDataTable
                className='overflow-x-auto rounded-none border-0'
                tableProps={{ withContainer: false }}
                tableClassName='min-w-[860px] table-fixed [&_td]:px-3 [&_td]:py-3 [&_th]:px-3'
                containerProps={{
                  role: 'region',
                  'aria-label': model,
                  tabIndex: 0,
                }}
                data={rows.filter((row) => row.target.model === model)}
                getRowKey={({ target }) =>
                  `${target.channel_id}:${target.model}`
                }
                columns={[
                  {
                    id: 'channel',
                    header: t('Channel'),
                    className: 'w-[18%]',
                    cell: ({ target }) => {
                      const channel = props.channels.find(
                        (c) => c.id === target.channel_id
                      )
                      return (
                        <div className='max-w-48'>
                          <p className='truncate font-medium'>
                            {channel?.name || t('Unavailable')}
                          </p>
                          <p className='text-muted-foreground text-xs'>
                            #{target.channel_id}
                            {channel?.status !== 1 && ` · ${t('Disabled')}`}
                          </p>
                        </div>
                      )
                    },
                  },
                  {
                    id: 'enabled',
                    header: t('Enable detection'),
                    className: 'w-[12%]',
                    cell: ({ target, index }) => (
                      <Switch
                        aria-label={t('Enable detection')}
                        checked={target.enabled}
                        onCheckedChange={(value) =>
                          form.setValue(`targets.${index}.enabled`, value, {
                            shouldDirty: true,
                          })
                        }
                      />
                    ),
                  },
                  ...(['text', 'drawing'] as const).map((kind) => ({
                    id: kind,
                    className: 'w-[22%]',
                    header:
                      kind === 'text' ? t('Text probe') : t('Drawing check'),
                    cell: ({ target }: { target: ProbeTarget }) => (
                      <div className='flex max-w-60 flex-wrap gap-1.5'>
                        {plan.probes
                          .filter(
                            (probe) =>
                              probe.kind === kind &&
                              target.probes.some(
                                (binding) =>
                                  binding.probe_id === probe.id &&
                                  binding.enabled
                              )
                          )
                          .map((probe) => (
                            <span
                              key={probe.id}
                              className={
                                kind === 'text'
                                  ? 'rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300'
                                  : 'rounded-md bg-violet-500/10 px-2 py-1 text-xs text-violet-700 dark:text-violet-300'
                              }
                            >
                              {probe.name} ·{' '}
                              {t('Every {{minutes}} min', {
                                minutes: formatNumber(
                                  target.probes.find(
                                    (binding) => binding.probe_id === probe.id
                                  )?.interval_minutes || probe.interval_minutes
                                ),
                              })}
                            </span>
                          ))}
                        {!plan.probes.some(
                          (probe) =>
                            probe.kind === kind &&
                            target.probes.some(
                              (binding) =>
                                binding.probe_id === probe.id && binding.enabled
                            )
                        ) && (
                          <span className='text-muted-foreground text-xs'>
                            {t('Disabled')}
                          </span>
                        )}
                      </div>
                    ),
                  })),
                  {
                    id: 'public',
                    header: t('Show on public wall'),
                    className: 'w-[14%]',
                    cell: ({ target, index }) => (
                      <Switch
                        aria-label={t('Show on public wall')}
                        checked={target.public}
                        onCheckedChange={(value) =>
                          form.setValue(
                            'targets',
                            plan.targets.map((item, i) => {
                              if (i === index) return { ...item, public: value }
                              if (
                                value &&
                                item.group === target.group &&
                                item.model === target.model
                              ) {
                                return { ...item, public: false }
                              }
                              return item
                            }),
                            { shouldDirty: true }
                          )
                        }
                      />
                    ),
                  },
                  {
                    id: 'actions',
                    header: t('Actions'),
                    className: 'w-[12%]',
                    cell: ({ target, index }) => (
                      <div className='flex items-center gap-1'>
                        <Button
                          type='button'
                          size='sm'
                          variant='ghost'
                          onClick={() => setEditing({ index, target })}
                        >
                          {t('Configure')}
                        </Button>
                        <Button
                          type='button'
                          size='icon-sm'
                          variant='ghost'
                          aria-label={t('Run now')}
                          disabled={
                            props.dirty || !target.enabled || run.isPending
                          }
                          onClick={() =>
                            run.mutate(
                              {
                                group: target.group,
                                model: target.model,
                                channel_id: target.channel_id,
                              },
                              {
                                onSuccess: () =>
                                  toast.success(
                                    t(
                                      'Check queued. Follow live progress here or on the wall.'
                                    )
                                  ),
                                onError: (error) => handleServerError(error),
                              }
                            )
                          }
                        >
                          <Play />
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
      {editing && (
        <ProbeTargetDrawer
          plan={plan}
          index={editing.index}
          initial={editing.target}
          channels={props.channels}
          groups={groups}
          onClose={() => setEditing(null)}
          onApply={(targets) => {
            form.setValue('targets', targets, { shouldDirty: true })
            setGroup(
              targets[editing.index < 0 ? targets.length - 1 : editing.index]
                .group
            )
            setEditing(null)
          }}
          onRemove={() => {
            form.setValue(
              'targets',
              plan.targets.filter((_, index) => index !== editing.index),
              { shouldDirty: true }
            )
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
