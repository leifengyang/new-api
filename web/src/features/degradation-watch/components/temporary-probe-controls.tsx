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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Save, Pencil } from 'lucide-react'
import { useId, useState } from 'react'
import { Controller, useForm, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAuthStore } from '@/stores/auth-store'

import {
  monitorRequest,
  temporaryProbeSchema,
  type TemporaryMonitor,
  type TemporaryProbeSettings,
} from '../lib/temporary-monitor'
import { TemporaryPromptEditor } from './temporary-prompt-editor'

export function TemporaryProbeFields(props: {
  form: UseFormReturn<TemporaryProbeSettings>
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const error = props.form.formState.errors.interval_minutes
  return (
    <fieldset
      disabled={props.disabled}
      className='flex flex-wrap items-end gap-4'
    >
      <div className='flex h-9 items-center gap-2'>
        <Controller
          control={props.form.control}
          name='enabled'
          render={({ field }) => (
            <Switch
              id={`${id}-enabled`}
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={props.disabled}
            />
          )}
        />
        <Label htmlFor={`${id}-enabled`}>{t('Automatic checks')}</Label>
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor={`${id}-interval`}>{t('Interval (minutes)')}</Label>
        <Input
          id={`${id}-interval`}
          type='number'
          min={1}
          max={1440}
          step={1}
          className='h-9 w-32'
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          {...props.form.register('interval_minutes', { valueAsNumber: true })}
        />
        {error && (
          <p
            id={`${id}-error`}
            role='alert'
            className='text-destructive text-xs'
          >
            {t('Enter an interval from 1 to 1440 minutes.')}
          </p>
        )}
      </div>
    </fieldset>
  )
}

export function TemporaryProbeControls(props: {
  monitor: TemporaryMonitor
  kind: 'text' | 'drawing'
  busy: boolean
}) {
  const { t } = useTranslation()
  const [editingPrompt, setEditingPrompt] = useState(false)
  const client = useQueryClient()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const active =
    props.monitor.status === 'running' &&
    props.monitor.ends_at * 1000 > Date.now()
  const key = ['temporary-monitor', userID]
  const settings = {
    enabled: !props.monitor[`${props.kind}_disabled`],
    interval_minutes:
      props.monitor[`${props.kind}_interval_minutes`] ||
      (props.kind === 'text' ? 3 : 10),
  }
  const form = useForm<TemporaryProbeSettings>({
    resolver: zodResolver(temporaryProbeSchema),
    values: settings,
    resetOptions: { keepDirtyValues: true },
  })
  const save = useMutation({
    mutationFn: (value: TemporaryProbeSettings) =>
      monitorRequest(
        `/${props.monitor.id}/probes/${props.kind}`,
        'post',
        value
      ),
    onSuccess: (_data, value) => {
      form.reset(value)
      return client.invalidateQueries({ queryKey: key })
    },
  })
  const run = useMutation({
    mutationFn: () =>
      monitorRequest(`/${props.monitor.id}/probes/${props.kind}/run`, 'post'),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  })
  return (
    <div className='bg-muted/30 space-y-3 rounded-lg border p-3'>
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <TemporaryProbeFields
          form={form}
          disabled={!active || save.isPending}
        />
        <div className='flex flex-wrap gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={!active}
            onClick={() => setEditingPrompt(true)}
          >
            <Pencil className='size-3.5' />
            {t('Edit probe prompt')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={!active || save.isPending || !form.formState.isDirty}
            onClick={() =>
              void form.handleSubmit((value) => save.mutate(value))()
            }
          >
            <Save className='size-3.5' />
            {t('Save')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={
              !active ||
              props.busy ||
              run.isPending ||
              form.formState.isDirty ||
              save.isPending
            }
            onClick={() => run.mutate()}
          >
            <Play className='size-3.5' />
            {t('Run once')}
          </Button>
        </div>
      </div>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Disabling automatic checks lets the current run finish. You can still run a probe once.'
        )}
      </p>
      {editingPrompt && (
        <TemporaryPromptEditor
          monitor={props.monitor}
          kind={props.kind}
          onClose={() => setEditingPrompt(false)}
        />
      )}
    </div>
  )
}
