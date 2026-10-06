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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'

import {
  comparisonSchema,
  newTestGroup,
  type ComparisonInput,
  type TestGroup,
} from '../lib/comparison'
import { monitorRequest } from '../lib/temporary-monitor'
import { ComparisonGroupEditor } from './comparison-group-editor'

export function TemporaryRewriterEditor(props: { onClose: () => void }) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const config = useQuery({
    queryKey: ['temporary-monitor', userID, 'rewriter'],
    queryFn: () => monitorRequest<TestGroup>('/rewriter'),
    staleTime: 0,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Configure rewrite model')}
      description={t(
        'Shared by all temporary monitors. Saved keys are encrypted and never displayed. Changes apply to subsequent drawing checks.'
      )}
      contentClassName='sm:max-w-3xl'
    >
      {config.isPending && <LoadingState />}
      {config.isError && <ErrorState onRetry={() => void config.refetch()} />}
      {config.data && (
        <RewriterForm
          initial={
            config.data.has_saved_key
              ? { ...newTestGroup(), ...config.data, api_key: '' }
              : {
                  ...newTestGroup(),
                  name: t('Drawing prompt rewriter'),
                  max_output_tokens: 4096,
                }
          }
          onClose={props.onClose}
        />
      )}
    </Dialog>
  )
}

function RewriterForm(props: { initial: TestGroup; onClose: () => void }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const form = useForm<ComparisonInput>({
    resolver: zodResolver(comparisonSchema),
    defaultValues: {
      groups: [props.initial],
      prompt: 'rewriter',
      concurrency: 1,
      timeout_seconds: 1200,
    },
  })
  const save = useMutation({
    mutationFn: (value: ComparisonInput) =>
      monitorRequest('/rewriter', 'post', value.groups[0]),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['temporary-monitor', userID, 'rewriter'],
      })
      props.onClose()
    },
  })
  return (
    <form
      className='space-y-4'
      onSubmit={form.handleSubmit((value) => save.mutate(value))}
    >
      <fieldset disabled={save.isPending}>
        <ComparisonGroupEditor
          form={form}
          index={0}
          removable={false}
          onRemove={() => {}}
          rewriter
          loadModels={(group) =>
            monitorRequest<string[]>('/rewriter/models', 'post', group)
          }
        />
      </fieldset>
      {Object.keys(form.formState.errors).length > 0 && (
        <p role='alert' className='text-destructive text-xs'>
          {t('Check the probe fields before saving')}
        </p>
      )}
      <div className='flex justify-end'>
        <Button type='submit' disabled={save.isPending}>
          {t('Save')}
        </Button>
      </div>
    </form>
  )
}
