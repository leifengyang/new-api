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
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAuthStore } from '@/stores/auth-store'

import {
  monitorRequest,
  temporaryPromptSchema,
  type TemporaryMonitor,
  type TemporaryPromptInput,
} from '../lib/temporary-monitor'

export function TemporaryPromptEditor(props: {
  monitor: TemporaryMonitor
  kind: 'text' | 'drawing'
  onClose: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const form = useForm<TemporaryPromptInput>({
    resolver: zodResolver(temporaryPromptSchema),
    defaultValues: {
      prompt:
        props.kind === 'text'
          ? props.monitor.text_prompt
          : props.monitor.drawing_prompt,
      expected: props.kind === 'text' ? props.monitor.text_expected : '',
    },
  })
  const save = useMutation({
    mutationFn: (value: TemporaryPromptInput) =>
      monitorRequest(
        `/${props.monitor.id}/probes/${props.kind}/prompt`,
        'post',
        value
      ),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['temporary-monitor', userID],
      })
      props.onClose()
    },
  })
  const submit = form.handleSubmit((value) => {
    if (props.kind === 'text' && !value.expected) {
      form.setError('expected', { type: 'required' })
      return
    }
    save.mutate(value)
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) props.onClose()
      }}
      title={t('Edit probe prompt')}
      description={t(
        'Saved changes apply to subsequent checks. Running checks and historical inputs stay unchanged.'
      )}
      footer={
        <Button disabled={save.isPending} onClick={() => void submit()}>
          {t('Save')}
        </Button>
      }
      contentClassName='sm:max-w-3xl'
    >
      <fieldset disabled={save.isPending} className='space-y-4'>
        <div className='space-y-2'>
          <Label htmlFor='temporary-prompt'>{t('Prompt')}</Label>
          <Textarea
            id='temporary-prompt'
            className='min-h-64'
            maxLength={20000}
            aria-invalid={!!form.formState.errors.prompt}
            {...form.register('prompt')}
          />
          {form.formState.errors.prompt && (
            <p role='alert' className='text-destructive text-xs'>
              {t('Check the probe fields before saving')}
            </p>
          )}
        </div>
        {props.kind === 'text' ? (
          <div className='space-y-2'>
            <Label htmlFor='temporary-expected'>{t('Expected answer')}</Label>
            <Textarea
              id='temporary-expected'
              maxLength={2000}
              aria-invalid={!!form.formState.errors.expected}
              {...form.register('expected')}
            />
            {form.formState.errors.expected && (
              <p role='alert' className='text-destructive text-xs'>
                {t('Check the probe fields before saving')}
              </p>
            )}
            <p className='text-muted-foreground text-xs'>
              {t('Exact match (trim whitespace)')}
            </p>
          </div>
        ) : (
          <p className='rounded-lg bg-violet-500/10 p-3 text-sm'>
            {t(
              'Before each drawing check, the dedicated rewrite model changes the subject. The monitored model then draws with the revised prompt. Configure the rewrite model in the monitoring header.'
            )}
          </p>
        )}
      </fieldset>
    </Dialog>
  )
}
